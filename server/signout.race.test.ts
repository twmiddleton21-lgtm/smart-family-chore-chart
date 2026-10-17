import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAuthClient, type AuthClient, type AuthStatus } from '../src/api/auth';
import { createRequester } from '../src/api/client';
import { confirmSignOut } from '../src/state/signOut';
import { buildApp, PARENT_COOKIE } from './app';
import { AuthService, SESSION_POLICY } from './auth/service';
import { openData } from './open';
import { FIXED_NOW, tempDir } from './testUtils';

// Finding 2: a delayed sign-out retry must only ever end the session it was
// created for, never a newer one this browser got by signing in again (in
// the same tab or another tab: both share the browser's cookie).
//
// These run the real browser-side code (auth client + confirmSignOut)
// against the real server in memory. A "browser" is one cookie jar shared
// by all its tabs; each request carries the cookies the jar held when it
// was SENT, and the response's cookies are applied when it ARRIVES (so a
// request can be held back to arrive late, like a slow network).

const PASSWORD = 'correct horse battery';
const MINUTE = 60_000;

let tmp: ReturnType<typeof tempDir>;
let app: FastifyInstance;
let opened: Awaited<ReturnType<typeof openData>>;
let clock: number;
let setupCode: string;

beforeEach(async () => {
  tmp = tempDir();
  opened = await openData(tmp.dir, 'Europe/London');
  clock = FIXED_NOW.getTime();
  const auth = new AuthService(opened.db, { now: () => new Date(clock) });
  setupCode = auth.prepareSetup()!;
  app = buildApp({
    config: { devUnauthenticatedApi: false, bodyLimit: 64 * 1024, timeZone: 'Europe/London', port: 80, dataDir: tmp.dir, cookieSecure: 'auto' },
    db: opened.db,
    store: opened.store,
    auth,
  });
  await app.ready();
});
afterEach(async () => {
  await app?.close();
  opened?.db.close();
  tmp.cleanup();
});

type Jar = Record<string, string>;

function absorb(jar: Jar, r: LightMyRequestResponse): void {
  for (const c of r.cookies as { name: string; value: string; maxAge?: number; expires?: Date }[]) {
    const cleared = c.value === '' || c.maxAge === 0 || (c.expires && c.expires.getTime() <= Date.now());
    if (cleared) delete jar[c.name];
    else jar[c.name] = c.value;
  }
}

interface Browser {
  jar: Jar;
  /** A tab: the real auth client over this browser's cookie jar. */
  tab(): AuthClient;
  /** Make the next logout request fail on the network (it never reaches the server). */
  dropNextLogout(): void;
  /** Hold the next logout request after it is sent; `release()` delivers it to the server. */
  holdNextLogout(): { release: () => void };
  /** The server handles the next logout at once, but its answer (and Set-Cookie) arrives only on `release()`. */
  delayNextLogoutAnswer(): { release: () => void };
}

function browser(): Browser {
  const jar: Jar = {};
  let drop = false;
  let hold: Promise<void> | null = null;
  let delayAnswer: Promise<void> | null = null;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const cookies = { ...jar }; // as SENT
    const isLogout = url.endsWith('/api/auth/logout');
    if (isLogout && drop) {
      drop = false;
      throw new TypeError('Failed to fetch');
    }
    if (isLogout && hold) {
      const gate = hold;
      hold = null;
      await gate;
    }
    const r = await app.inject({
      method: init.method as 'GET' | 'POST',
      url,
      payload: typeof init.body === 'string' ? init.body : undefined,
      headers: { ...(init.headers as Record<string, string>) },
      cookies,
    });
    if (isLogout && delayAnswer) {
      const gate = delayAnswer;
      delayAnswer = null;
      await gate;
    }
    absorb(jar, r); // as it ARRIVES
    return new Response(r.body, { status: r.statusCode, headers: { 'content-type': String(r.headers['content-type'] ?? '') } });
  }) as unknown as typeof fetch;
  return {
    jar,
    tab: () => createAuthClient(createRequester(fetchImpl)),
    dropNextLogout: () => {
      drop = true;
    },
    holdNextLogout: () => {
      let release!: () => void;
      hold = new Promise<void>((r) => (release = r));
      return { release };
    },
    delayNextLogoutAnswer: () => {
      let release!: () => void;
      delayAnswer = new Promise<void>((r) => (release = r));
      return { release };
    },
  };
}

/** What the server says about a parent token, asked from a clean client (no other cookies). */
async function serverSees(token: string | undefined) {
  if (!token) return null;
  const r = await app.inject({ method: 'GET', url: '/api/auth/status', cookies: { [PARENT_COOKIE]: token } });
  return (r.json() as AuthStatus).parent;
}

async function firstParent(b: Browser): Promise<AuthStatus> {
  const tab = b.tab();
  await tab.setup({ setupCode, username: 'sam', displayName: 'Sam', password: PASSWORD });
  return tab.status();
}

describe('a delayed sign-out retry only ends the session it was meant for', () => {
  it('an old retry after a new sign-in in the SAME tab leaves the new session alone', async () => {
    const b = browser();
    const tab = b.tab();
    const original = await firstParent(b); // the session the sign-out is for
    const oldToken = b.jar[PARENT_COOKIE];

    b.dropNextLogout();
    expect((await confirmSignOut(tab, original)).confirmed).toBe(false); // unconfirmed: will be retried

    await tab.login('sam', PASSWORD, false); // the parent signs in again in this tab
    const newToken = b.jar[PARENT_COOKIE];
    expect(newToken).not.toBe(oldToken);
    expect(await serverSees(oldToken)).toBeNull(); // sign-in replaced (ended) the old session

    const late = await confirmSignOut(tab, original); // the old retry fires
    expect(await serverSees(newToken)).not.toBeNull(); // the new session still works
    expect(b.jar[PARENT_COOKIE]).toBe(newToken); // and the browser keeps its cookie
    expect(late).toMatchObject({ confirmed: true, superseded: true });
  });

  it('an old retry after a new sign-in in ANOTHER tab (same cookie) leaves that session alone', async () => {
    const b = browser();
    const tabA = b.tab();
    const tabB = b.tab();
    const original = await firstParent(b);

    b.dropNextLogout();
    expect((await confirmSignOut(tabA, original)).confirmed).toBe(false);

    await tabB.login('sam', PASSWORD, false);
    const newToken = b.jar[PARENT_COOKIE];

    const late = await confirmSignOut(tabA, original);
    expect(await serverSees(newToken)).not.toBeNull();
    expect(b.jar[PARENT_COOKIE]).toBe(newToken);
    expect((await tabB.status()).parent).not.toBeNull();
    expect(late).toMatchObject({ confirmed: true, superseded: true });
  });

  it('an old retry SENT before another tab’s sign-in but arriving after it leaves the new session alone', async () => {
    const b = browser();
    const tabA = b.tab();
    const tabB = b.tab();
    const original = await firstParent(b);

    const held = b.holdNextLogout();
    const retry = confirmSignOut(tabA, original); // sent now, carrying the OLD cookie
    await tabB.login('sam', PASSWORD, false); // meanwhile tab B signs in
    const newToken = b.jar[PARENT_COOKIE];
    held.release(); // the old request reaches the server late

    const late = await retry;
    expect(late.confirmed).toBe(true); // the old session is gone
    expect(b.jar[PARENT_COOKIE]).toBe(newToken); // its late answer didn't clear the new cookie
    expect(await serverSees(newToken)).not.toBeNull();
  });

  it('a sign-out the server handled BEFORE another tab’s sign-in, but whose answer arrives AFTER it, leaves the new cookie alone', async () => {
    const b = browser();
    const tabA = b.tab();
    const tabB = b.tab();
    const original = await firstParent(b);
    const tokenA = b.jar[PARENT_COOKIE]!;

    const late = b.delayNextLogoutAnswer();
    const signOut = confirmSignOut(tabA, original); // the server ends session A now...
    await new Promise((r) => setTimeout(r, 0));
    await expect.poll(async () => serverSees(tokenA)).toBeNull();
    expect(b.jar[PARENT_COOKIE]).toBe(tokenA); // ...but the browser hasn't seen the answer yet

    await tabB.login('sam', PASSWORD, false); // tab B signs in (its request still carries A)
    const tokenB = b.jar[PARENT_COOKIE]!;
    expect(tokenB).not.toBe(tokenA);

    late.release(); // tab A's old answer arrives last
    const out = await signOut;

    expect(await serverSees(tokenA)).toBeNull(); // session A ended on the server
    expect(await serverSees(tokenB)).not.toBeNull(); // session B is valid on the server
    expect(b.jar[PARENT_COOKIE]).toBe(tokenB); // and the browser still holds it
    expect(out.confirmed).toBe(true);
  });

  it('a delayed retry after the original session already EXPIRED is confirmed, without touching anything', async () => {
    const b = browser();
    const tab = b.tab();
    const original = await firstParent(b);
    const oldToken = b.jar[PARENT_COOKIE];

    b.dropNextLogout();
    expect((await confirmSignOut(tab, original)).confirmed).toBe(false);
    clock += SESSION_POLICY.parent.idleMs + MINUTE; // the session times out meanwhile

    const late = await confirmSignOut(tab, original);
    expect(late).toEqual({ confirmed: true, status: expect.objectContaining({ parent: null }) });
    expect(await serverSees(oldToken)).toBeNull();
  });

  it('a delayed retry after the first attempt DID end the session (answer lost) is confirmed', async () => {
    const b = browser();
    const tab = b.tab();
    const original = await firstParent(b);
    const oldToken = b.jar[PARENT_COOKIE]!;

    // The server ended it, but the answer never reached the browser.
    const lost = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      payload: { sessionId: original.sessionId },
      cookies: { [PARENT_COOKIE]: oldToken },
    });
    expect(lost.statusCode).toBe(200);
    expect(b.jar[PARENT_COOKIE]).toBe(oldToken); // the browser still holds the dead cookie

    const late = await confirmSignOut(tab, original);
    expect(late).toEqual({ confirmed: true, status: expect.objectContaining({ parent: null }) });
    expect(await serverSees(oldToken)).toBeNull();
  });

  it('network failures stay unconfirmed (and honest) until a retry reaches the server and ends that session', async () => {
    const b = browser();
    const tab = b.tab();
    const original = await firstParent(b);
    const token = b.jar[PARENT_COOKIE];

    for (let i = 0; i < 3; i++) {
      b.dropNextLogout();
      const out = await confirmSignOut(tab, original);
      expect(out.confirmed).toBe(false);
      expect(await serverSees(token)).not.toBeNull(); // really still active: never claimed otherwise
    }
    const out = await confirmSignOut(tab, original);
    expect(out).toEqual({ confirmed: true, status: expect.objectContaining({ parent: null }) });
    expect(await serverSees(token)).toBeNull(); // ended on the server
    expect(b.jar[PARENT_COOKIE]).toBe(token); // the browser keeps only a dead token (no Set-Cookie)
    expect((await tab.status()).parent).toBeNull();
  });
});
