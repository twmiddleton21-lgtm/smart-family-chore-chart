import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, DEVICE_COOKIE, PARENT_COOKIE } from './app';
import { hashPassword, verifyPassword } from './auth/crypto';
import { PAIRING_CODE_TTL_MS, SESSION_POLICY, AuthService } from './auth/service';
import { listBackups } from './db/backup';
import { openData } from './open';
import { FIXED_NOW, tempDir } from './testUtils';

// Stage C: parent accounts, sessions, device pairing and server-side access
// control. Everything here runs in NORMAL mode (authentication on).

const PASSWORD = 'correct horse battery';
const PASSWORD_2 = 'another good passphrase';
const MINUTE = 60_000;

let tmp: ReturnType<typeof tempDir>;
let app: FastifyInstance;
let opened: Awaited<ReturnType<typeof openData>>;
let auth: AuthService;
let clock: number;
let setupCode: string;
let logs: string[];

async function start() {
  opened = await openData(tmp.dir, 'Europe/London');
  clock = FIXED_NOW.getTime();
  auth = new AuthService(opened.db, { now: () => new Date(clock) });
  setupCode = auth.prepareSetup()!;
  logs = [];
  app = buildApp({
    config: { devUnauthenticatedApi: false, bodyLimit: 64 * 1024, timeZone: 'Europe/London', port: 80, dataDir: tmp.dir, cookieSecure: 'auto' },
    db: opened.db,
    store: opened.store,
    auth,
    logger: { level: 'trace', stream: { write: (line: string) => void logs.push(line) } },
  });
  await app.ready();
}

beforeEach(() => {
  tmp = tempDir();
});
afterEach(async () => {
  await app?.close();
  opened?.db.close();
  tmp.cleanup();
});

// ---------- helpers ----------

type Jar = Record<string, string>;

/** Keep cookies like a browser would (set, replace, clear). */
function absorb(jar: Jar, r: LightMyRequestResponse): void {
  for (const c of r.cookies as { name: string; value: string; maxAge?: number; expires?: Date }[]) {
    const cleared = c.value === '' || c.maxAge === 0 || (c.expires && c.expires.getTime() <= Date.now());
    if (cleared) delete jar[c.name];
    else jar[c.name] = c.value;
  }
}

async function req(jar: Jar | null, opts: InjectOptions): Promise<LightMyRequestResponse> {
  const r = await app.inject({ ...opts, cookies: { ...(jar ?? {}), ...(opts.cookies ?? {}) } });
  if (jar) absorb(jar, r);
  return r;
}

const post = (jar: Jar | null, url: string, payload: object = {}, headers: Record<string, string> = {}) =>
  req(jar, { method: 'POST', url, payload, headers });
const get = (jar: Jar | null, url: string) => req(jar, { method: 'GET', url });

async function setUp(username = 'sam'): Promise<Jar> {
  const jar: Jar = {};
  const r = await post(jar, '/api/auth/setup', { setupCode, username, displayName: 'Sam', password: PASSWORD });
  expect(r.statusCode).toBe(200);
  return jar;
}

async function signIn(username: string, password: string, remember = false): Promise<Jar> {
  const jar: Jar = {};
  const r = await post(jar, '/api/auth/login', { username, password, remember });
  expect(r.statusCode, r.body).toBe(200);
  return jar;
}

async function pairDevice(parent: Jar, name = 'Kitchen tablet'): Promise<Jar> {
  const code = (await post(parent, '/api/devices/pairing-codes', { name })).json().code as string;
  const device: Jar = {};
  const r = await post(device, '/api/devices/pair', { code });
  expect(r.statusCode).toBe(200);
  return device;
}

const sessionCount = () => Number(opened.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions')!.n);

// ---------- password hashing ----------

describe('password hashing', () => {
  it('stores scrypt hashes with a random salt, never the password', async () => {
    const a = await hashPassword(PASSWORD);
    const b = await hashPassword(PASSWORD);
    expect(a).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain(PASSWORD);
    expect(await verifyPassword(PASSWORD, a)).toBe(true);
    expect(await verifyPassword('wrong password!', a)).toBe(false);
  });

  it('never matches malformed or tampered hashes (including absurd work factors)', async () => {
    const good = await hashPassword(PASSWORD);
    for (const bad of ['', 'plain', PASSWORD, good.replace('scrypt$', 'md5$'), good.replace('$32768$', '$1099511627776$'), good.replace('$32768$', '$100$'), good.split('$').slice(0, 5).join('$')]) {
      expect(await verifyPassword(PASSWORD, bad)).toBe(false);
    }
  });

  it('the database holds only hashes of passwords and tokens', async () => {
    await start();
    const jar = await setUp();
    const row = opened.db.get<{ password_hash: string }>('SELECT password_hash FROM parents')!;
    expect(row.password_hash.startsWith('scrypt$')).toBe(true);
    const dump = JSON.stringify(opened.db.all('SELECT * FROM sessions')) + JSON.stringify(opened.db.all('SELECT * FROM parents'));
    expect(dump).not.toContain(PASSWORD);
    expect(dump).not.toContain(jar[PARENT_COOKIE]);
  });
});

// ---------- first-run setup ----------

describe('first-run setup', () => {
  it('reports setup required on a fresh server and exposes no family data', async () => {
    await start();
    expect((await get(null, '/api/auth/status')).json()).toEqual({ devMode: false, setupRequired: true, parent: null, device: null, sessionId: null });
    expect((await get(null, '/api/state')).statusCode).toBe(401);
  });

  it('needs the setup code; a wrong code creates nothing', async () => {
    await start();
    const r = await post({}, '/api/auth/setup', { setupCode: 'WRONG-CODE-HERE', username: 'sam', displayName: 'Sam', password: PASSWORD });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('invalid_setup_code');
    expect(r.cookies).toEqual([]);
    expect(auth.hasParents()).toBe(false);
  });

  it('accepts the code in any case and spacing, signs the first parent in, then closes for good', async () => {
    await start();
    const jar: Jar = {};
    const typed = setupCode.toLowerCase().replace(/-/g, ' ');
    const r = await post(jar, '/api/auth/setup', { setupCode: typed, username: 'sam', displayName: ' Sam ', password: PASSWORD });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ parent: { id: expect.any(String), username: 'sam', displayName: 'Sam' } });
    expect((await get(jar, '/api/auth/status')).json()).toMatchObject({ setupRequired: false, parent: { username: 'sam' } });

    // The same code (or any code) can never create another account.
    const again = await post({}, '/api/auth/setup', { setupCode, username: 'eve', displayName: 'Eve', password: PASSWORD });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('setup_complete');
    expect(auth.listParents().map((p) => p.username)).toEqual(['sam']);
  });

  it('validates the new account server-side', async () => {
    await start();
    for (const [username, password] of [
      ['ab', PASSWORD],
      ['sam', 'short'],
      ['sam', 'password123'],
      ['sam', 'aaaaaaaaaaaa'],
      ['samuel', 'my samuel password'],
      ['bad name', PASSWORD],
    ]) {
      const r = await post({}, '/api/auth/setup', { setupCode, username, displayName: 'Sam', password });
      expect(r.statusCode, `${username}/${password}`).toBe(422);
    }
    expect(auth.hasParents()).toBe(false);
  });

  it('rate-limits setup code guesses', async () => {
    await start();
    for (let i = 0; i < 10; i++) {
      expect((await post({}, '/api/auth/setup', { setupCode: `WRONG${i}`, username: 'sam', displayName: 'Sam', password: PASSWORD })).statusCode).toBe(403);
    }
    const blocked = await post({}, '/api/auth/setup', { setupCode, username: 'sam', displayName: 'Sam', password: PASSWORD });
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(auth.hasParents()).toBe(false);
  });

  it('is not possible at all when no setup code was prepared', async () => {
    opened = await openData(tmp.dir, 'UTC');
    auth = new AuthService(opened.db);
    app = buildApp({ config: { devUnauthenticatedApi: false, bodyLimit: 1024, timeZone: 'UTC', port: 80, dataDir: tmp.dir }, db: opened.db, store: opened.store, auth });
    const r = await post({}, '/api/auth/setup', { setupCode: 'ANYTHING', username: 'sam', displayName: 'Sam', password: PASSWORD });
    expect(r.statusCode).toBe(409);
    expect(auth.hasParents()).toBe(false);
  });
});

// ---------- sign in / out ----------

describe('parent sign-in', () => {
  it('sets an HttpOnly, SameSite=Strict session cookie and never returns the token', async () => {
    await start();
    await setUp();
    const r = await post(null, '/api/auth/login', { username: 'SAM', password: PASSWORD });
    expect(r.statusCode).toBe(200);
    const cookie = (r.cookies as { name: string; value: string; httpOnly?: boolean; sameSite?: string; path?: string; maxAge?: number; secure?: boolean }[]).find((c) => c.name === PARENT_COOKIE)!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Strict');
    expect(cookie.path).toBe('/');
    expect(cookie.maxAge).toBeUndefined(); // a browser-session cookie unless "remember"
    expect(cookie.secure).toBeFalsy(); // plain http in tests; 'auto' follows the protocol
    expect(cookie.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.body).not.toContain(cookie.value);
    expect(r.json()).toEqual({ parent: { id: expect.any(String), username: 'sam', displayName: 'Sam' } });
  });

  it('"keep me signed in" gives a 30-day persistent cookie', async () => {
    await start();
    await setUp();
    const r = await post(null, '/api/auth/login', { username: 'sam', password: PASSWORD, remember: true });
    const cookie = (r.cookies as { name: string; maxAge?: number }[]).find((c) => c.name === PARENT_COOKIE)!;
    expect(cookie.maxAge).toBe(30 * 24 * 60 * 60);
  });

  it('marks the cookie Secure when configured to', async () => {
    opened = await openData(tmp.dir, 'UTC');
    auth = new AuthService(opened.db);
    setupCode = auth.prepareSetup()!;
    app = buildApp({ config: { devUnauthenticatedApi: false, bodyLimit: 4096, timeZone: 'UTC', port: 80, dataDir: tmp.dir, cookieSecure: 'always' }, db: opened.db, store: opened.store, auth });
    const r = await post(null, '/api/auth/setup', { setupCode, username: 'sam', displayName: 'Sam', password: PASSWORD });
    expect((r.cookies as { name: string; secure?: boolean }[]).find((c) => c.name === PARENT_COOKIE)!.secure).toBe(true);
  });

  it('wrong password and unknown user get the same generic 401', async () => {
    await start();
    await setUp();
    const wrong = await post(null, '/api/auth/login', { username: 'sam', password: 'not the password' });
    const unknown = await post(null, '/api/auth/login', { username: 'nobody', password: PASSWORD });
    const empty = await post(null, '/api/auth/login', { username: 'sam', password: '' });
    for (const r of [wrong, unknown, empty]) {
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual({ error: 'invalid_credentials', message: 'That username and password don’t match.' });
      expect(r.cookies).toEqual([]);
    }
  });

  it('locks out after 5 failures (even with the right password), per account and per address', async () => {
    await start();
    await setUp();
    for (let i = 0; i < 5; i++) expect((await post(null, '/api/auth/login', { username: 'sam', password: `wrong ${i} password` })).statusCode).toBe(401);
    const blocked = await post(null, '/api/auth/login', { username: 'sam', password: PASSWORD });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect(blocked.cookies).toEqual([]);
    // After the window passes, the right password works again.
    clock += 16 * MINUTE;
    expect((await post(null, '/api/auth/login', { username: 'sam', password: PASSWORD })).statusCode).toBe(200);
  });

  it('logout ends the session on the server, not just in the browser', async () => {
    await start();
    const jar = await signInAfterSetup();
    const token = jar[PARENT_COOKIE]!;
    expect((await get(jar, '/api/parents')).statusCode).toBe(200);
    const out = await post(jar, '/api/auth/logout');
    expect(out.statusCode).toBe(200);
    expect(jar[PARENT_COOKIE]).toBeUndefined();
    // Replaying the old token is refused.
    const replay = await get(null, '/api/parents');
    expect(replay.statusCode).toBe(401);
    expect((await req(null, { method: 'GET', url: '/api/state', cookies: { [PARENT_COOKIE]: token } })).statusCode).toBe(401);
    // Logging out again is harmless.
    expect((await post(null, '/api/auth/logout')).statusCode).toBe(200);
  });

  it('status gives a public session id: one per session, not the token, and useless as a credential', async () => {
    await start();
    const jar = await signInAfterSetup();
    const token = jar[PARENT_COOKIE]!;
    const id = (await get(jar, '/api/auth/status')).json().sessionId as string;
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect((await get(jar, '/api/auth/status')).json().sessionId).toBe(id); // stable
    expect(id).not.toContain(token);
    expect(id).not.toBe(createHash('sha256').update(token).digest('hex')); // not the stored hash either
    expect((await req(null, { method: 'GET', url: '/api/state', cookies: { [PARENT_COOKIE]: id } })).statusCode).toBe(401);
    const other = await signIn('sam', PASSWORD);
    expect((await get(other, '/api/auth/status')).json().sessionId).not.toBe(id);
    expect((await get(null, '/api/auth/status')).json().sessionId).toBeNull();
    expect((await get(await pairDevice(jar), '/api/auth/status')).json().sessionId).toBeNull(); // a device has no parent session
  });

  it('a sign-out naming this browser’s session ends it on the server, without any Set-Cookie', async () => {
    await start();
    const jar = await signInAfterSetup();
    const token = jar[PARENT_COOKIE]!;
    const sessionId = (await get(jar, '/api/auth/status')).json().sessionId;
    const before = sessionCount();
    const r = await post(jar, '/api/auth/logout', { sessionId });
    expect(r.json()).toEqual({ ok: true, result: 'ended' });
    // No Set-Cookie: a late answer must not clear a newer cookie (see app.ts).
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(jar[PARENT_COOKIE]).toBe(token); // the browser keeps a dead token...
    expect(sessionCount()).toBe(before - 1);
    for (const url of ['/api/state', '/api/parents', '/api/export']) {
      expect((await get(jar, url)).statusCode, url).toBe(401); // ...that is refused everywhere
    }
    expect((await get(jar, '/api/auth/status')).json()).toMatchObject({ parent: null, sessionId: null });
    // and is replaced by the next sign-in.
    await post(jar, '/api/auth/login', { username: 'sam', password: PASSWORD });
    expect(jar[PARENT_COOKIE]).not.toBe(token);
    expect((await get(jar, '/api/parents')).statusCode).toBe(200);
  });

  it('a sign-out naming an OLDER session leaves the browser’s newer session and cookie alone', async () => {
    await start();
    const jar = await signInAfterSetup();
    const oldId = (await get(jar, '/api/auth/status')).json().sessionId;
    await post(jar, '/api/auth/login', { username: 'sam', password: PASSWORD }); // signed in again
    const newToken = jar[PARENT_COOKIE]!;
    const sessionsBefore = sessionCount();
    const r = await post(jar, '/api/auth/logout', { sessionId: oldId });
    expect(r.json()).toEqual({ ok: true, result: 'replaced' });
    expect(r.cookies).toEqual([]); // no Set-Cookie at all
    expect(jar[PARENT_COOKIE]).toBe(newToken);
    expect(sessionCount()).toBe(sessionsBefore);
    expect((await get(jar, '/api/parents')).statusCode).toBe(200);
  });

  it('a sign-out for a session this browser no longer holds (ended or expired) changes nothing', async () => {
    await start();
    const jar = await signInAfterSetup();
    const token = jar[PARENT_COOKIE]!;
    const sessionId = (await get(jar, '/api/auth/status')).json().sessionId;
    clock += SESSION_POLICY.parent.idleMs + MINUTE; // expired
    const r = await post(jar, '/api/auth/logout', { sessionId });
    expect(r.json()).toEqual({ ok: true, result: 'not_signed_in' });
    expect(r.cookies).toEqual([]); // a late answer must not clear whatever cookie the browser has by then
    expect(jar[PARENT_COOKIE]).toBe(token);
    const none = await post(null, '/api/auth/logout', { sessionId });
    expect(none.json()).toEqual({ ok: true, result: 'not_signed_in' });
    expect(none.cookies).toEqual([]);
  });

  it('a targeted sign-out is validated and still refused from other websites', async () => {
    await start();
    const jar = await signInAfterSetup();
    const sessionId = (await get(jar, '/api/auth/status')).json().sessionId;
    for (const bad of [{ sessionId: 'nope' }, { sessionId: sessionId.toUpperCase() }, { sessionId: 42 }, { sessionId, extra: 1 }]) {
      expect((await post(jar, '/api/auth/logout', bad)).statusCode).toBe(400);
    }
    const cross = await post(jar, '/api/auth/logout', { sessionId }, { origin: 'https://evil.example' });
    expect(cross.statusCode).toBe(403);
    expect((await get(jar, '/api/parents')).statusCode).toBe(200); // still signed in
  });

  it('a sign-out without a session id still ends whatever session the cookie names (plain API use)', async () => {
    await start();
    const jar = await signInAfterSetup();
    const r = await req(jar, { method: 'POST', url: '/api/auth/logout' }); // no body at all
    expect(r.statusCode).toBe(200);
    expect(jar[PARENT_COOKIE]).toBeUndefined();
    expect((await get(jar, '/api/parents')).statusCode).toBe(401);
  });

  it('signing in again replaces the browser’s older session', async () => {
    await start();
    const jar = await signInAfterSetup();
    const first = jar[PARENT_COOKIE]!;
    await post(jar, '/api/auth/login', { username: 'sam', password: PASSWORD });
    expect(jar[PARENT_COOKIE]).not.toBe(first);
    expect((await req(null, { method: 'GET', url: '/api/state', cookies: { [PARENT_COOKIE]: first } })).statusCode).toBe(401);
  });

  async function signInAfterSetup(): Promise<Jar> {
    await setUp();
    return signIn('sam', PASSWORD);
  }
});

// ---------- session expiry ----------

// ---------- password changes racing a sign-in (Finding 3) ----------

describe('a password change during a sign-in', () => {
  const parentSessions = (id: string) =>
    Number(opened.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE kind = 'parent' AND parent_id = ?", id)!.n);

  it('a reset (e.g. reset-password from the command line) while the old password is being checked: no session survives', async () => {
    await start();
    await setUp();
    const id = auth.listParents()[0]!.id;
    const newHash = await hashPassword('a brand new passphrase');
    // The sign-in has read the old hash and is checking it (slow, async)...
    const signingIn = auth.login('sam', PASSWORD, false, '10.0.0.9');
    // ...when the password is reset in one step (as resetPassword does).
    opened.db.transaction(() => {
      opened.db.run('UPDATE parents SET password_hash = ? WHERE id = ?', newHash, id);
      opened.db.run("DELETE FROM sessions WHERE kind = 'parent' AND parent_id = ?", id);
    });
    const r = await signingIn;
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.status).toBe(401);
    expect(parentSessions(id)).toBe(0);
    // The new password works; the old one doesn't.
    expect((await auth.login('sam', 'a brand new passphrase', false, '10.0.0.9')).ok).toBe(true);
    expect((await auth.login('sam', PASSWORD, false, '10.0.0.9')).ok).toBe(false);
  });

  it('an in-app password change racing a sign-in with the old password never leaves that sign-in valid', async () => {
    await start();
    const jar = await setUp();
    const keep = (await get(jar, '/api/auth/status')).json().sessionId;
    const [login] = await Promise.all([
      auth.login('sam', PASSWORD, false, '10.0.0.8'),
      post(jar, '/api/account/password', { currentPassword: PASSWORD, newPassword: 'a brand new passphrase' }),
    ]);
    if (login.ok) {
      const r = await req(null, { method: 'GET', url: '/api/parents', cookies: { [PARENT_COOKIE]: login.token } });
      expect(r.statusCode).toBe(401); // signed out by the change
    }
    expect((await get(jar, '/api/auth/status')).json().sessionId).toBe(keep); // the changer stays signed in
  });

  it('an account removed while its password is being checked: refused cleanly, no session', async () => {
    await start();
    await setUp();
    const id = auth.listParents()[0]!.id;
    const signingIn = auth.login('sam', PASSWORD, false, '10.0.0.7');
    opened.db.run('DELETE FROM parents WHERE id = ?', id);
    const r = await signingIn;
    expect(r.ok ? null : r.status).toBe(401);
    expect(sessionCount()).toBe(0);
  });
});

describe('session expiry', () => {
  it('a parent session ends after 30 idle minutes', async () => {
    await start();
    const jar = await setUp();
    clock += SESSION_POLICY.parent.idleMs - MINUTE;
    expect((await get(jar, '/api/state')).statusCode).toBe(200); // activity slides the idle window
    clock += SESSION_POLICY.parent.idleMs - MINUTE;
    expect((await get(jar, '/api/state')).statusCode).toBe(200);
    clock += SESSION_POLICY.parent.idleMs + 1;
    expect((await get(jar, '/api/state')).statusCode).toBe(401);
    expect(sessionCount()).toBe(0); // the expired session was deleted
  });

  it('a parent session ends after 12 hours even if always active', async () => {
    await start();
    const jar = await setUp();
    const end = clock + SESSION_POLICY.parent.absoluteMs;
    while (clock + 20 * MINUTE < end) {
      clock += 20 * MINUTE;
      expect((await get(jar, '/api/state')).statusCode).toBe(200);
    }
    clock = end;
    expect((await get(jar, '/api/state')).statusCode).toBe(401);
  });

  // Why the app must not poll while idle: every authenticated request, a
  // status read included, extends the idle timeout. A status check once a
  // minute keeps an unattended session alive until the 12-hour maximum.
  it('status reads extend the idle timeout, but never past the 12-hour maximum', async () => {
    await start();
    const jar = await setUp();
    const end = clock + SESSION_POLICY.parent.absoluteMs;
    clock += 5 * MINUTE;
    expect((await get(jar, '/api/auth/status')).json().parent).not.toBeNull();
    for (clock += 26 * MINUTE; clock + MINUTE < end; clock += MINUTE) {
      expect((await get(jar, '/api/auth/status')).json().parent, new Date(clock).toISOString()).not.toBeNull();
    }
    clock = end;
    expect((await get(jar, '/api/auth/status')).json().parent).toBeNull();
    expect((await get(jar, '/api/state')).statusCode).toBe(401);
  });

  it('"keep me signed in" lasts 30 days, then ends', async () => {
    await start();
    await setUp();
    const jar = await signIn('sam', PASSWORD, true);
    clock += 29 * 24 * 60 * MINUTE;
    expect((await get(jar, '/api/state')).statusCode).toBe(200);
    clock += 2 * 24 * 60 * MINUTE;
    expect((await get(jar, '/api/state')).statusCode).toBe(401);
  });

  it('forged, malformed or wrong-kind tokens are ignored', async () => {
    await start();
    const parent = await setUp();
    const device = await pairDevice(parent);
    for (const cookies of <Record<string, string>[]>[
      { [PARENT_COOKIE]: 'A'.repeat(43) },
      { [PARENT_COOKIE]: '' },
      { [PARENT_COOKIE]: 'x'.repeat(5000) },
      { [DEVICE_COOKIE]: 'B'.repeat(43) },
      // A device token presented as a parent token gives no parent rights.
      { [PARENT_COOKIE]: device[DEVICE_COOKIE]! },
    ]) {
      const r = await req(null, { method: 'GET', url: '/api/parents', cookies });
      expect([401, 403]).toContain(r.statusCode);
    }
    // A parent token in the device cookie gives no household access on its own.
    expect((await req(null, { method: 'GET', url: '/api/state', cookies: { [DEVICE_COOKIE]: parent[PARENT_COOKIE]! } })).statusCode).toBe(401);
  });
});

// ---------- parent accounts ----------

describe('parent accounts (equal parents)', () => {
  it('any parent can add another; usernames are unique regardless of case', async () => {
    await start();
    const sam = await setUp();
    clock += MINUTE;
    const add = await post(sam, '/api/parents', { username: 'alex', displayName: 'Alex', password: PASSWORD_2 });
    expect(add.statusCode).toBe(200);
    expect(add.body).not.toContain(PASSWORD_2);
    expect((await post(sam, '/api/parents', { username: 'ALEX', displayName: 'Other', password: PASSWORD_2 })).statusCode).toBe(409);
    const alex = await signIn('alex', PASSWORD_2);
    const list = (await get(alex, '/api/parents')).json().parents;
    expect(list.map((p: { username: string; isYou: boolean }) => [p.username, p.isYou])).toEqual([
      ['sam', false],
      ['alex', true],
    ]);
    expect(JSON.stringify(list)).not.toMatch(/scrypt|password/i);
    // And the new parent can add a third.
    expect((await post(alex, '/api/parents', { username: 'jodie', displayName: 'Jodie', password: PASSWORD })).statusCode).toBe(200);
  });

  it('removing a parent needs the remover’s password and signs the removed parent out', async () => {
    await start();
    const sam = await setUp();
    await post(sam, '/api/parents', { username: 'alex', displayName: 'Alex', password: PASSWORD_2 });
    const alex = await signIn('alex', PASSWORD_2);
    const alexId = auth.listParents().find((p) => p.username === 'alex')!.id;

    expect((await post(sam, `/api/parents/${alexId}/remove`, { password: 'not my password' })).statusCode).toBe(403);
    expect((await get(alex, '/api/state')).statusCode).toBe(200);

    expect((await post(sam, `/api/parents/${alexId}/remove`, { password: PASSWORD })).statusCode).toBe(200);
    expect((await get(alex, '/api/state')).statusCode).toBe(401);
    expect(auth.listParents().map((p) => p.username)).toEqual(['sam']);
  });

  it('the last parent can’t be removed', async () => {
    await start();
    const sam = await setUp();
    const samId = auth.listParents()[0]!.id;
    const r = await post(sam, `/api/parents/${samId}/remove`, { password: PASSWORD });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('last_parent');
    expect(auth.hasParents()).toBe(true);
  });

  it('a parent can remove themselves when another remains; their session ends (no Set-Cookie)', async () => {
    await start();
    const sam = await setUp();
    await post(sam, '/api/parents', { username: 'alex', displayName: 'Alex', password: PASSWORD_2 });
    const samId = auth.listParents().find((p) => p.username === 'sam')!.id;
    const token = sam[PARENT_COOKIE]!;
    const r = await post(sam, `/api/parents/${samId}/remove`, { password: PASSWORD });
    expect(r.json()).toEqual({ ok: true, removedSelf: true });
    // Like a targeted sign-out: the session is gone on the server and the
    // answer doesn't touch the cookie (it could arrive after another sign-in).
    expect(r.headers['set-cookie']).toBeUndefined();
    expect(sam[PARENT_COOKIE]).toBe(token); // a dead token...
    expect((await get(sam, '/api/parents')).statusCode).toBe(401); // ...refused everywhere
    expect((await get(sam, '/api/auth/status')).json()).toMatchObject({ parent: null, sessionId: null });
  });

  it('removing yourself, with the answer arriving after another parent signed in on this browser, leaves that sign-in alone', async () => {
    await start();
    const browser = await setUp(); // sam, in tab A
    await post(browser, '/api/parents', { username: 'alex', displayName: 'Alex', password: PASSWORD_2 });
    const samId = auth.listParents().find((p) => p.username === 'sam')!.id;
    // Tab A removes Sam; the server handles it now, the answer arrives later.
    const late = await app.inject({ method: 'POST', url: `/api/parents/${samId}/remove`, payload: { password: PASSWORD }, cookies: { ...browser } });
    expect(late.json()).toEqual({ ok: true, removedSelf: true });
    // Tab B signs in as Alex.
    await post(browser, '/api/auth/login', { username: 'alex', password: PASSWORD_2 });
    const alexToken = browser[PARENT_COOKIE]!;
    absorb(browser, late); // tab A's old answer arrives
    expect(browser[PARENT_COOKIE]).toBe(alexToken);
    expect((await get(browser, '/api/auth/status')).json().parent).toMatchObject({ username: 'alex' });
  });

  it('changing your own password needs the current one and signs out your other sessions only', async () => {
    await start();
    const phone = await setUp();
    const kiosk = await signIn('sam', PASSWORD);
    await post(phone, '/api/parents', { username: 'alex', displayName: 'Alex', password: PASSWORD_2 });
    const alex = await signIn('alex', PASSWORD_2);

    expect((await post(phone, '/api/account/password', { currentPassword: 'wrong password', newPassword: 'a brand new phrase' })).statusCode).toBe(403);
    expect((await post(phone, '/api/account/password', { currentPassword: PASSWORD, newPassword: 'short' })).statusCode).toBe(422);
    const ok = await post(phone, '/api/account/password', { currentPassword: PASSWORD, newPassword: 'a brand new phrase' });
    expect(ok.statusCode).toBe(200);

    expect((await get(phone, '/api/state')).statusCode).toBe(200); // this session kept
    expect((await get(kiosk, '/api/state')).statusCode).toBe(401); // other session ended
    expect((await get(alex, '/api/state')).statusCode).toBe(200); // other parents unaffected
    expect((await post(null, '/api/auth/login', { username: 'sam', password: PASSWORD })).statusCode).toBe(401);
    expect((await post(null, '/api/auth/login', { username: 'sam', password: 'a brand new phrase' })).statusCode).toBe(200);
  });

  it('many guesses sent at once can’t get past the limit (no race while hashing)', async () => {
    await start();
    const sam = await setUp();
    const logins = await Promise.all(Array.from({ length: 20 }, (_, i) => post(null, '/api/auth/login', { username: 'sam', password: `parallel ${i} guess` })));
    expect(logins.filter((r) => r.statusCode === 401)).toHaveLength(5);
    expect(logins.filter((r) => r.statusCode === 429)).toHaveLength(15);
    expect((await post(null, '/api/auth/login', { username: 'sam', password: PASSWORD })).statusCode).toBe(429);

    const changes = await Promise.all(
      Array.from({ length: 20 }, (_, i) => post(sam, '/api/account/password', { currentPassword: `parallel ${i} guess`, newPassword: 'a brand new phrase' })),
    );
    expect(changes.filter((r) => r.statusCode === 403)).toHaveLength(5);
    expect(changes.filter((r) => r.statusCode === 429)).toHaveLength(15);
  });

  it('re-entering your password (password change, removing a parent) is rate-limited too', async () => {
    await start();
    const sam = await setUp();
    await post(sam, '/api/parents', { username: 'alex', displayName: 'Alex', password: PASSWORD_2 });
    const alexId = auth.listParents().find((p) => p.username === 'alex')!.id;
    // A stolen session can't be used to guess the password: 5 wrong tries across both routes...
    for (let i = 0; i < 3; i++) expect((await post(sam, '/api/account/password', { currentPassword: `guess ${i} password`, newPassword: 'a brand new phrase' })).statusCode).toBe(403);
    for (let i = 0; i < 2; i++) expect((await post(sam, `/api/parents/${alexId}/remove`, { password: `guess ${i + 3} password` })).statusCode).toBe(403);
    // ...then even the right password is refused for a while.
    const blocked = await post(sam, '/api/account/password', { currentPassword: PASSWORD, newPassword: 'a brand new phrase' });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBeDefined();
    expect((await post(sam, `/api/parents/${alexId}/remove`, { password: PASSWORD })).statusCode).toBe(429);
    expect(auth.listParents()).toHaveLength(2);
    clock += 16 * MINUTE;
    expect((await post(sam, '/api/account/password', { currentPassword: PASSWORD, newPassword: 'a brand new phrase' })).statusCode).toBe(200);
  });

  it('there is no API to change another parent’s password', async () => {
    await start();
    const sam = await setUp();
    await post(sam, '/api/parents', { username: 'alex', displayName: 'Alex', password: PASSWORD_2 });
    const alexId = auth.listParents().find((p) => p.username === 'alex')!.id;
    // Extra fields are rejected rather than silently used.
    const r = await post(sam, '/api/account/password', { currentPassword: PASSWORD, newPassword: 'a brand new phrase', parentId: alexId });
    expect(r.statusCode).toBe(400);
    expect((await post(null, '/api/auth/login', { username: 'alex', password: PASSWORD_2 })).statusCode).toBe(200);
  });

  it('command-line reset sets a temporary password and signs that parent out everywhere', async () => {
    await start();
    const sam = await setUp();
    const r = await auth.resetPassword('sam');
    if (!r.ok) throw new Error(r.message);
    expect((await get(sam, '/api/state')).statusCode).toBe(401);
    expect((await post(null, '/api/auth/login', { username: 'sam', password: r.temporaryPassword })).statusCode).toBe(200);
    expect((await auth.resetPassword('nobody')).ok).toBe(false);
  });
});

// ---------- rate limiting: exact counts, concurrency, recovery ----------

describe('rate limiting of password checks', () => {
  const WINDOW = 15 * MINUTE;
  const login = (username: string, password: string) => post(null, '/api/auth/login', { username, password });
  const statuses = (rs: LightMyRequestResponse[]) => rs.map((r) => r.statusCode).sort();

  it('sequential: each wrong password counts once; exactly 5 are checked, the 6th is refused', async () => {
    await start();
    await setUp();
    const t0 = clock;
    for (let i = 1; i <= 5; i++) expect((await login('sam', `wrong ${i} password`)).statusCode, `attempt ${i}`).toBe(401);
    const sixth = await login('sam', 'wrong 6 password');
    expect(sixth.statusCode).toBe(429);
    expect(sixth.headers['retry-after']).toBe(String(WINDOW / 1000));
    expect((await login('sam', PASSWORD)).statusCode).toBe(429); // even the right password
    // Recovery: still refused 1 ms before the window ends, allowed once it has.
    clock = t0 + WINDOW - 1;
    expect((await login('sam', PASSWORD)).statusCode).toBe(429);
    clock = t0 + WINDOW;
    expect((await login('sam', PASSWORD)).statusCode).toBe(200);
  });

  it('a successful sign-in doesn’t erase other failures from the same address', async () => {
    await start();
    const sam = await setUp();
    await post(sam, '/api/parents', { username: 'alex', displayName: 'Alex', password: PASSWORD_2 });
    // Someone with their own account guesses at other usernames, signing in
    // to their own account in between to try to reset the per-address limit.
    for (let i = 1; i <= 4; i++) expect((await login(`ghost${i}`, 'some guess here')).statusCode).toBe(401);
    expect((await login('alex', PASSWORD_2)).statusCode).toBe(200);
    expect((await login('ghost5', 'some guess here')).statusCode).toBe(401); // 5th failure from this address
    expect((await login('ghost6', 'some guess here')).statusCode).toBe(429);
  });

  it('concurrent: of 20 simultaneous wrong passwords exactly 5 are checked', async () => {
    await start();
    await setUp();
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => login('sam', `parallel ${i} guess`)));
    expect(rs.filter((r) => r.statusCode === 401)).toHaveLength(5);
    expect(rs.filter((r) => r.statusCode === 429)).toHaveLength(15);
    expect((await login('sam', PASSWORD)).statusCode).toBe(429);
  });

  it('concurrent wrong passwords mixed with the right one: the success un-counts only itself', async () => {
    await start();
    await setUp();
    const rs = await Promise.all([
      login('sam', 'parallel 1 guess'),
      login('sam', 'parallel 2 guess'),
      login('sam', PASSWORD),
      login('sam', 'parallel 3 guess'),
      login('sam', 'parallel 4 guess'),
    ]);
    expect(statuses(rs)).toEqual([200, 401, 401, 401, 401]);
    // Those 4 failures still count: one more wrong try is checked, then the limit applies.
    expect((await login('sam', 'one more guess')).statusCode).toBe(401);
    expect((await login('sam', 'and another guess')).statusCode).toBe(429);
    expect((await login('sam', PASSWORD)).statusCode).toBe(429);
  });

  it('a successful sign-in is never counted as a failure', async () => {
    await start();
    await setUp();
    for (let i = 0; i < 12; i++) expect((await login('sam', PASSWORD)).statusCode).toBe(200);
    for (let i = 1; i <= 5; i++) expect((await login('sam', `wrong ${i} password`)).statusCode).toBe(401);
    expect((await login('sam', 'wrong 6 password')).statusCode).toBe(429);
  });

  it('password re-checks: concurrent wrong passwords mixed with the right one, then recovery', async () => {
    await start();
    const sam = await setUp();
    const t0 = clock;
    const change = (current: string) => post(sam, '/api/account/password', { currentPassword: current, newPassword: 'a brand new phrase' });
    const rs = await Promise.all([change('parallel 1 guess'), change('parallel 2 guess'), change(PASSWORD), change('parallel 3 guess'), change('parallel 4 guess')]);
    expect(statuses(rs)).toEqual([200, 403, 403, 403, 403]);
    // The password is now 'a brand new phrase'. 4 wrong tries still count.
    expect((await change('one more guess')).statusCode).toBe(403);
    const blocked = await change('a brand new phrase');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBe(String(WINDOW / 1000));
    clock = t0 + WINDOW - 1;
    expect((await change('a brand new phrase')).statusCode).toBe(429);
    clock = t0 + WINDOW;
    expect((await change('a brand new phrase')).statusCode).toBe(200);
  });

  it('password re-checks share one limit across password change and parent removal, concurrently too', async () => {
    await start();
    const sam = await setUp();
    await post(sam, '/api/parents', { username: 'alex', displayName: 'Alex', password: PASSWORD_2 });
    const alexId = auth.listParents().find((p) => p.username === 'alex')!.id;
    const rs = await Promise.all([
      ...Array.from({ length: 6 }, (_, i) => post(sam, '/api/account/password', { currentPassword: `guess ${i} password`, newPassword: 'a brand new phrase' })),
      ...Array.from({ length: 6 }, (_, i) => post(sam, `/api/parents/${alexId}/remove`, { password: `guess ${i} password` })),
    ]);
    expect(rs.filter((r) => r.statusCode === 403)).toHaveLength(5);
    expect(rs.filter((r) => r.statusCode === 429)).toHaveLength(7);
    expect((await post(sam, `/api/parents/${alexId}/remove`, { password: PASSWORD })).statusCode).toBe(429);
    expect(auth.listParents()).toHaveLength(2);
    // Sign-in limits are separate: the parent can still sign in elsewhere.
    expect((await login('sam', PASSWORD)).statusCode).toBe(200);
  });
});

// ---------- device pairing ----------

describe('device pairing', () => {
  it('only a signed-in parent can create a pairing code', async () => {
    await start();
    const parent = await setUp();
    const device = await pairDevice(parent);
    expect((await post(null, '/api/devices/pairing-codes', { name: 'Sneaky' })).statusCode).toBe(401);
    expect((await post(device, '/api/devices/pairing-codes', { name: 'Sneaky' })).statusCode).toBe(403);
    const r = await post(parent, '/api/devices/pairing-codes', { name: 'Hall tablet' });
    expect(r.statusCode).toBe(200);
    expect(r.json().code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    expect(Date.parse(r.json().expiresAt) - clock).toBe(PAIRING_CODE_TTL_MS);
    // Only its hash is stored.
    expect(JSON.stringify(opened.db.all('SELECT * FROM pairing_codes'))).not.toContain(r.json().code);
  });

  it('a code pairs exactly one device, once', async () => {
    await start();
    const parent = await setUp();
    const code = (await post(parent, '/api/devices/pairing-codes', { name: 'Kitchen tablet' })).json().code;
    const kitchen: Jar = {};
    const r = await post(kitchen, '/api/devices/pair', { code: code.toLowerCase() });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ device: { id: expect.any(String), name: 'Kitchen tablet' } });
    const cookie = (r.cookies as { name: string; value: string; httpOnly?: boolean; sameSite?: string; maxAge?: number }[]).find((c) => c.name === DEVICE_COOKIE)!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', maxAge: 365 * 24 * 60 * 60 });
    expect(r.body).not.toContain(cookie.value);
    expect((await get(kitchen, '/api/auth/status')).json()).toMatchObject({ parent: null, device: { name: 'Kitchen tablet' } });

    const reuse = await post({}, '/api/devices/pair', { code });
    expect(reuse.statusCode).toBe(401);
    expect(reuse.json().error).toBe('invalid_code');
    expect(auth.listDevices()).toHaveLength(1);
  });

  it('expired and wrong codes are refused', async () => {
    await start();
    const parent = await setUp();
    const code = (await post(parent, '/api/devices/pairing-codes', { name: 'Kitchen tablet' })).json().code;
    expect((await post({}, '/api/devices/pair', { code: 'AAAA-BBBB' })).statusCode).toBe(401);
    clock += PAIRING_CODE_TTL_MS + 1;
    expect((await post({}, '/api/devices/pair', { code })).statusCode).toBe(401);
    expect(auth.listDevices()).toEqual([]);
  });

  it('rate-limits code guessing', async () => {
    await start();
    const parent = await setUp();
    const code = (await post(parent, '/api/devices/pairing-codes', { name: 'Kitchen tablet' })).json().code;
    for (let i = 0; i < 10; i++) expect((await post({}, '/api/devices/pair', { code: `ZZZZ-ZZZ${i + 2}` })).statusCode).toBe(401);
    const blocked = await post({}, '/api/devices/pair', { code });
    expect(blocked.statusCode).toBe(429);
    expect(auth.listDevices()).toEqual([]);
  });

  it('a paired device can view, tick chores, redeem rewards and dismiss the meal reminder', async () => {
    await start();
    const parent = await setUp();
    expect((await post(parent, '/api/commands', { type: 'loadDemoFamily', payload: {} })).statusCode).toBe(200);
    const device = await pairDevice(parent);

    const state = (await get(device, '/api/state')).json();
    expect(state.family.children.length).toBe(3);
    const chore = state.family.chores[0];
    expect((await post(device, '/api/commands', { type: 'toggleChore', payload: { choreId: chore.id } })).statusCode).toBe(200);
    expect((await post(device, '/api/commands', { type: 'redeemReward', payload: { childId: 'child_maya', rewardId: 'reward_screen' } })).statusCode).toBe(200);
    expect((await post(device, '/api/commands', { type: 'dismissMealReminder', payload: {} })).statusCode).toBe(200);

    // The command log records which device did it.
    const actors = opened.db.all<{ actor: string }>('SELECT actor FROM command_log ORDER BY id').map((r) => r.actor);
    expect(actors.slice(-3).every((a) => a.startsWith('device:'))).toBe(true);
    expect(actors[0]).toMatch(/^parent:/);
  });

  it('a paired device cannot do parent-only things', async () => {
    await start();
    const parent = await setUp();
    await post(parent, '/api/commands', { type: 'loadDemoFamily', payload: {} });
    const device = await pairDevice(parent);
    const before = opened.store.read();
    for (const type of ['saveChild', 'deleteChild', 'saveChore', 'deleteChore', 'saveReward', 'deleteReward', 'updateSettings', 'loadDemoFamily', 'resetFamily', 'saveMealWeek']) {
      const r = await post(device, '/api/commands', { type, payload: {} });
      if (r.statusCode === 400 && r.json().error === 'invalid_request') continue; // not a command type in this build
      expect(r.statusCode, type).toBe(403);
      expect(r.json().error).toBe('parent_required');
    }
    for (const url of ['/api/export', '/api/parents', '/api/devices']) expect((await get(device, url)).statusCode).toBe(403);
    expect(opened.store.read()).toEqual(before);
  });

  it('a parent can sign in on a paired device and both identities apply; signing out keeps the pairing', async () => {
    await start();
    const parent = await setUp();
    const kiosk = await pairDevice(parent);
    const r = await post(kiosk, '/api/auth/login', { username: 'sam', password: PASSWORD });
    expect(r.statusCode).toBe(200);
    expect((await get(kiosk, '/api/auth/status')).json()).toMatchObject({ parent: { username: 'sam' }, device: { name: 'Kitchen tablet' } });
    expect((await get(kiosk, '/api/export')).statusCode).toBe(200);
    expect((await get(kiosk, '/api/devices')).json().devices[0].isThisDevice).toBe(true);
    await post(kiosk, '/api/auth/logout');
    expect((await get(kiosk, '/api/auth/status')).json()).toMatchObject({ parent: null, device: { name: 'Kitchen tablet' } });
    expect((await get(kiosk, '/api/export')).statusCode).toBe(403);
    expect((await get(kiosk, '/api/state')).statusCode).toBe(200);
  });

  it('revoking a device stops it immediately', async () => {
    await start();
    const parent = await setUp();
    const device = await pairDevice(parent);
    expect((await get(device, '/api/state')).statusCode).toBe(200);
    const id = (await get(parent, '/api/devices')).json().devices[0].id;
    expect((await post(parent, `/api/devices/${id}/revoke`)).statusCode).toBe(200);
    expect((await get(device, '/api/state')).statusCode).toBe(401);
    expect((await post(parent, `/api/devices/${id}/revoke`)).statusCode).toBe(404);
  });
});

// ---------- cross-site request protection ----------

describe('cross-site request protection (CSRF)', () => {
  it.each([
    ['a foreign Origin', { origin: 'https://evil.example' }],
    ['Origin: null', { origin: 'null' }],
    ['Sec-Fetch-Site: cross-site', { 'sec-fetch-site': 'cross-site' }],
    ['Sec-Fetch-Site: same-site', { 'sec-fetch-site': 'same-site' }],
  ])('rejects state changes with %s, even with a valid session', async (_label, headers) => {
    await start();
    const parent = await setUp();
    const before = opened.store.read();
    const r = await post(parent, '/api/commands', { type: 'loadDemoFamily', payload: {} }, headers as Record<string, string>);
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('cross_site_request');
    expect(opened.store.read()).toEqual(before);
    // Sign-in, setup and pairing are protected too (no login CSRF).
    expect((await post(null, '/api/auth/login', { username: 'sam', password: PASSWORD }, headers as Record<string, string>)).statusCode).toBe(403);
  });

  it('allows same-origin requests from the browser', async () => {
    await start();
    const parent = await setUp();
    const r = await post(parent, '/api/commands', { type: 'loadDemoFamily', payload: {} }, { origin: 'http://localhost:80', host: 'localhost:80', 'sec-fetch-site': 'same-origin' });
    expect(r.statusCode).toBe(200);
    const explicit = await post(parent, '/api/commands', { type: 'dismissMealReminder', payload: {} }, { origin: 'http://localhost:8080', host: 'LOCALHOST:8080' });
    expect(explicit.statusCode).toBe(200);
    // Same host, different port is a different origin.
    expect((await post(parent, '/api/commands', { type: 'dismissMealReminder', payload: {} }, { origin: 'http://localhost:8081', host: 'localhost:8080' })).statusCode).toBe(403);
  });
});

// ---------- every route is covered ----------

const PUBLIC_ROUTES = new Set([
  'GET /healthz',
  'GET /readyz',
  'GET /api/auth/status',
  'POST /api/auth/setup',
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'POST /api/devices/pair',
]);
/** Routes a paired device (without a parent) may use. */
const HOUSEHOLD_ROUTES = new Set(['GET /api/state', 'POST /api/commands']);

const routeUrl = (route: string) => route.split(' ')[1]!.replace(':id', 'some-id');

describe('access control covers every route', () => {
  it('the route list is what this test expects (new routes must be classified here)', async () => {
    await start();
    const all = [...new Set(app.sfccRoutes)].sort();
    const parentOnly = all.filter((r) => !PUBLIC_ROUTES.has(r) && !HOUSEHOLD_ROUTES.has(r));
    expect(parentOnly).toEqual([
      'GET /api/devices',
      'GET /api/export',
      'GET /api/parents',
      'POST /api/account/password',
      'POST /api/devices/:id/revoke',
      'POST /api/devices/pairing-codes',
      'POST /api/import/apply',
      'POST /api/import/preview',
      'POST /api/parents',
      'POST /api/parents/:id/remove',
    ]);
    for (const r of [...PUBLIC_ROUTES, ...HOUSEHOLD_ROUTES]) expect(all).toContain(r);
  });

  it('every non-public route refuses anonymous callers with 401, whatever the body', async () => {
    await start();
    const parent = await setUp();
    await post(parent, '/api/commands', { type: 'loadDemoFamily', payload: {} });
    const before = opened.store.read();
    for (const route of new Set(app.sfccRoutes)) {
      if (PUBLIC_ROUTES.has(route)) continue;
      const method = route.split(' ')[0] as 'GET' | 'POST';
      for (const payload of method === 'POST' ? [{}, { type: 'resetFamily', payload: {} }, { garbage: true }] : [undefined]) {
        const r = await req(null, { method, url: routeUrl(route), payload });
        expect(r.statusCode, `${route} ${JSON.stringify(payload)}`).toBe(401);
        expect(r.json().error).toBe('unauthenticated');
        expect(r.body).not.toMatch(/Maya|child_|scrypt/);
      }
      if (method === 'GET') expect((await req(null, { method: 'HEAD', url: routeUrl(route) })).statusCode, `HEAD ${route}`).toBe(401);
    }
    expect(opened.store.read()).toEqual(before);
  });

  it('every parent-only route refuses a paired device with 403', async () => {
    await start();
    const parent = await setUp();
    const device = await pairDevice(parent);
    const devicesBefore = auth.listDevices();
    for (const route of new Set(app.sfccRoutes)) {
      if (PUBLIC_ROUTES.has(route) || HOUSEHOLD_ROUTES.has(route)) continue;
      const method = route.split(' ')[0] as 'GET' | 'POST';
      const r = await req(device, { method, url: routeUrl(route), payload: method === 'POST' ? {} : undefined });
      expect(r.statusCode, route).toBe(403);
      expect(r.json().error).toBe('parent_required');
    }
    expect(auth.listDevices()).toEqual(devicesBefore);
    expect(auth.listParents()).toHaveLength(1);
  });

  it.each([
    '/api/%73tate',
    '/API/state',
    '/api/state/',
    '//api/state',
    '/api/./state',
    '/api/x/../state',
    '/api/state%2F',
    '/api/state?x=1',
    '/api/state;x',
    '/api/export%00',
  ])('path tricks never reach family data anonymously: %s', async (url) => {
    await start();
    const parent = await setUp();
    await post(parent, '/api/commands', { type: 'loadDemoFamily', payload: {} });
    const r = await get(null, url);
    expect(r.statusCode).not.toBe(200);
    expect(r.body).not.toMatch(/Maya|child_/);
  });

  it('a large anonymous body is refused before it is parsed, and nothing runs', async () => {
    await start();
    const parent = await setUp();
    await post(parent, '/api/commands', { type: 'loadDemoFamily', payload: {} });
    const before = opened.store.read();
    const huge = { data: { children: Array.from({ length: 40000 }, (_, i) => ({ id: `c${i}`, name: 'x'.repeat(50) })) }, checksum: 'a'.repeat(64), expectedStateVersion: 1, replace: true };
    expect(JSON.stringify(huge).length).toBeGreaterThan(2 * 1024 * 1024);
    const r = await post(null, '/api/import/apply', huge);
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe('unauthenticated');
    expect(opened.store.read()).toEqual(before);
    expect(listBackups(tmp.dir)).toEqual([]);
  });

  it('malformed JSON from an anonymous caller gets 401, not a parser error', async () => {
    await start();
    const r = await req(null, { method: 'POST', url: '/api/commands', payload: '{not json', headers: { 'content-type': 'application/json' } });
    expect(r.statusCode).toBe(401);
  });
});

// ---------- logs ----------

describe('logs never contain secrets', () => {
  it('passwords, session tokens, setup and pairing codes stay out of the request log', async () => {
    await start();
    const parent = await setUp();
    await post(parent, '/api/auth/login', { username: 'sam', password: PASSWORD });
    await post(null, '/api/auth/login', { username: 'sam', password: 'a wrong password' });
    await post(parent, '/api/parents', { username: 'alex', displayName: 'Alex', password: PASSWORD_2 });
    await post(parent, '/api/account/password', { currentPassword: PASSWORD, newPassword: 'a brand new phrase' });
    const pairing = (await post(parent, '/api/devices/pairing-codes', { name: 'Kitchen tablet' })).json().code as string;
    const device: Jar = {};
    await post(device, '/api/devices/pair', { code: pairing });
    await get(device, '/api/state');

    const text = logs.join('\n');
    expect(logs.length).toBeGreaterThan(10); // the log really was captured
    for (const secret of [PASSWORD, PASSWORD_2, 'a wrong password', 'a brand new phrase', setupCode, pairing, parent[PARENT_COOKIE]!, device[DEVICE_COOKIE]!]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toMatch(/scrypt\$|sfcc_parent=|sfcc_device=/);
    // No API response body ever included a token or hash either (checked per test above).
  });
});

// ---------- development mode is unchanged ----------

describe('development mode', () => {
  it('has no account routes and reports devMode', async () => {
    opened = await openData(tmp.dir, 'UTC');
    app = buildApp({ config: { devUnauthenticatedApi: true, bodyLimit: 4096, timeZone: 'UTC', port: 80, dataDir: tmp.dir }, db: opened.db, store: opened.store });
    const h = { host: '127.0.0.1:80' };
    expect((await app.inject({ url: '/api/auth/status', headers: h, remoteAddress: '127.0.0.1' })).json()).toEqual({ devMode: true, setupRequired: false, parent: null, device: null, sessionId: null });
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', headers: h, remoteAddress: '127.0.0.1', payload: { username: 'a', password: 'b' } })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/state', headers: h, remoteAddress: '127.0.0.1' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/state', headers: h, remoteAddress: '192.168.1.20' })).statusCode).toBe(403);
  });
});
