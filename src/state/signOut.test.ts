import { describe, expect, it } from 'vitest';
import { createAuthClient, type AuthClient, type AuthStatus } from '../api/auth';
import { ApiError, createRequester } from '../api/client';
import { confirmSignOut, UNCONFIRMED_PREFIX } from './signOut';

const PARENT = { id: 'p1', username: 'sam', displayName: 'Sam' };
const DEVICE = { id: 'd1', name: 'Kitchen tablet' };
const SID = 'a'.repeat(64);
const NEWER = 'b'.repeat(64);
const SIGNED_IN: AuthStatus = { devMode: false, setupRequired: false, parent: PARENT, device: DEVICE, sessionId: SID };

/** A client whose logout and status behave as scripted; records calls. */
function fakeClient(opts: { logout: (sessionId: string) => Promise<string>; status: () => Promise<AuthStatus> }) {
  const calls: string[] = [];
  const client = {
    logout: async (sessionId: string) => {
      calls.push(`logout:${sessionId}`);
      return opts.logout(sessionId);
    },
    status: async () => {
      calls.push('status');
      return opts.status();
    },
  } as unknown as AuthClient;
  return { client, calls };
}

/** A real auth client over a scripted fetch (exercises the real requester). */
function clientOverFetch(respond: (url: string, init: RequestInit) => Promise<Response>) {
  const fetchImpl = ((url: string, init: RequestInit) => respond(url, init)) as unknown as typeof fetch;
  return createAuthClient(createRequester(fetchImpl));
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('confirmSignOut', () => {
  it('confirms when the server ends the session, and returns the fresh state', async () => {
    const after: AuthStatus = { ...SIGNED_IN, parent: null, sessionId: null };
    const { client, calls } = fakeClient({ logout: async () => 'ended', status: async () => after });
    expect(await confirmSignOut(client, SIGNED_IN)).toEqual({ confirmed: true, status: after });
    expect(calls).toEqual([`logout:${SID}`, 'status']); // logout (naming the session) first, then re-read
  });

  it('does not confirm, and does not re-read the old session, when the request fails on the network', async () => {
    const { client, calls } = fakeClient({
      logout: async () => {
        throw new ApiError('unreachable', 'Can’t reach the family server.');
      },
      status: async () => SIGNED_IN,
    });
    const out = await confirmSignOut(client, SIGNED_IN);
    expect(out).toEqual({ confirmed: false, message: `${UNCONFIRMED_PREFIX}. Can’t reach the family server.` });
    expect(calls).toEqual([`logout:${SID}`]);
  });

  it.each([
    [500, { error: 'internal_error' }],
    [502, {}],
    [503, { error: 'not_ready' }],
    [403, { error: 'cross_site_request', message: 'Requests from other websites are not allowed.' }],
  ])('does not confirm on an HTTP %i from the real client', async (status, body) => {
    const seen: string[] = [];
    const client = clientOverFetch(async (url) => {
      seen.push(url);
      return url.endsWith('/logout') ? json(status, body) : json(200, SIGNED_IN);
    });
    const out = await confirmSignOut(client, SIGNED_IN);
    expect(out.confirmed).toBe(false);
    if (!out.confirmed) expect(out.message.startsWith(UNCONFIRMED_PREFIX)).toBe(true);
    expect(seen).toEqual(['/api/auth/logout']);
  });

  it('does not confirm when the server answers OK but with no JSON body', async () => {
    const client = clientOverFetch(async (url) => (url.endsWith('/logout') ? new Response('', { status: 200 }) : json(200, SIGNED_IN)));
    expect((await confirmSignOut(client, SIGNED_IN)).confirmed).toBe(false);
  });

  it('does not confirm when the request times out', async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    const request = createRequester(fetchImpl);
    const client = {
      logout: () => request('POST', '/api/auth/logout', {}, { timeoutMs: 20 }).then(() => undefined),
      status: async () => SIGNED_IN,
    } as unknown as AuthClient;
    const out = await confirmSignOut(client, SIGNED_IN);
    expect(out).toEqual({ confirmed: false, message: `${UNCONFIRMED_PREFIX}. The family server didn’t answer in time.` });
  });

  it('does not confirm if the server still reports a parent afterwards', async () => {
    const { client } = fakeClient({ logout: async () => 'ended', status: async () => SIGNED_IN });
    const out = await confirmSignOut(client, SIGNED_IN);
    expect(out.confirmed).toBe(false);
  });

  it('confirms when logout succeeded but the follow-up read failed (the session is known to be gone)', async () => {
    const { client } = fakeClient({
      logout: async () => 'ended',
      status: async () => {
        throw new ApiError('unreachable', 'down');
      },
    });
    expect(await confirmSignOut(client, SIGNED_IN)).toEqual({ confirmed: true, status: { ...SIGNED_IN, parent: null, sessionId: null } });
  });

  it('a session this browser no longer holds is reported as superseded, and the newer one is left alone', async () => {
    const newer: AuthStatus = { ...SIGNED_IN, sessionId: NEWER };
    const { client, calls } = fakeClient({ logout: async () => 'replaced', status: async () => newer });
    expect(await confirmSignOut(client, SIGNED_IN)).toEqual({ confirmed: true, superseded: true, status: newer });
    expect(calls).toEqual([`logout:${SID}`, 'status']); // one targeted request, nothing else
  });

  it('a newer session that appears while ending the old one is reported as superseded', async () => {
    const newer: AuthStatus = { ...SIGNED_IN, sessionId: NEWER };
    const { client } = fakeClient({ logout: async () => 'ended', status: async () => newer });
    expect(await confirmSignOut(client, SIGNED_IN)).toEqual({ confirmed: true, superseded: true, status: newer });
  });

  it('never sends a sign-out without naming the session (it could end a newer one)', async () => {
    const unknown: AuthStatus = { ...SIGNED_IN, sessionId: null };
    const signedIn = fakeClient({ logout: async () => 'ended', status: async () => SIGNED_IN });
    expect(await confirmSignOut(signedIn.client, unknown)).toEqual({ confirmed: true, superseded: true, status: SIGNED_IN });
    expect(signedIn.calls).toEqual(['status']);
    const none: AuthStatus = { ...SIGNED_IN, parent: null, sessionId: null };
    const signedOut = fakeClient({ logout: async () => 'ended', status: async () => none });
    expect(await confirmSignOut(signedOut.client, unknown)).toEqual({ confirmed: true, status: none });
    const down = fakeClient({ logout: async () => 'ended', status: async () => Promise.reject(new ApiError('unreachable', 'down')) });
    expect((await confirmSignOut(down.client, unknown)).confirmed).toBe(false);
    expect(down.calls).toEqual(['status']);
  });

  it('never throws, even on unexpected errors', async () => {
    const { client } = fakeClient({
      logout: async () => {
        throw new TypeError('boom');
      },
      status: async () => SIGNED_IN,
    });
    expect((await confirmSignOut(client, SIGNED_IN)).confirmed).toBe(false);
  });
});

describe('the real auth client’s logout', () => {
  it('names the session, sends a timeout signal and resolves with the server’s answer', async () => {
    let signal: AbortSignal | undefined;
    let sent: unknown;
    const client = clientOverFetch(async (_url, init) => {
      signal = init.signal ?? undefined;
      sent = JSON.parse(String(init.body));
      return json(200, { ok: true, result: 'replaced' });
    });
    await expect(client.logout(SID)).resolves.toBe('replaced');
    expect(sent).toEqual({ sessionId: SID });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('rejects an OK answer that doesn’t say what happened to the session', async () => {
    for (const body of [{ ok: true }, { ok: true, result: 'gone' }]) {
      const client = clientOverFetch(async () => json(200, body));
      await expect(client.logout(SID)).rejects.toBeInstanceOf(ApiError);
    }
  });
});
