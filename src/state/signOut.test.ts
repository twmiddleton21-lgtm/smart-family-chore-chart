import { describe, expect, it } from 'vitest';
import { createAuthClient, type AuthClient, type AuthStatus } from '../api/auth';
import { ApiError, createRequester } from '../api/client';
import { confirmSignOut, UNCONFIRMED_PREFIX, UNKNOWN_SESSION_REASON } from './signOut';

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
    expect(out).toEqual({ confirmed: false, message: `${UNCONFIRMED_PREFIX}. Can’t reach the family server.`, retry: true });
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
    expect(out).toEqual({ confirmed: false, message: `${UNCONFIRMED_PREFIX}. The family server didn’t answer in time.`, retry: true });
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

  it('never sends a sign-out without naming the session, and never reports an active session as ended', async () => {
    // The session to end is unknown (e.g. saved by an older build) while the server reports a parent.
    for (const sessionId of [null, undefined]) {
      const unknown = { ...SIGNED_IN, sessionId } as AuthStatus;
      const signedIn = fakeClient({ logout: async () => 'ended', status: async () => SIGNED_IN });
      const out = await confirmSignOut(signedIn.client, unknown);
      expect(out).toEqual({ confirmed: false, message: `${UNCONFIRMED_PREFIX}. ${UNKNOWN_SESSION_REASON}`, retry: false });
      expect(signedIn.calls).toEqual(['status']); // no logout of any kind
    }
    // Same, when the server itself doesn't report session ids.
    const noIds = { ...SIGNED_IN, sessionId: undefined } as unknown as AuthStatus;
    const oldServer = fakeClient({ logout: async () => 'ended', status: async () => noIds });
    expect(await confirmSignOut(oldServer.client, noIds)).toMatchObject({ confirmed: false, retry: false });
    expect(oldServer.calls).toEqual(['status']);
    // Unknown, and the server can't be reached: unconfirmed too.
    const down = fakeClient({ logout: async () => 'ended', status: async () => Promise.reject(new ApiError('unreachable', 'down')) });
    expect(await confirmSignOut(down.client, { ...SIGNED_IN, sessionId: null })).toMatchObject({ confirmed: false, retry: false });
    expect(down.calls).toEqual(['status']);
    // Unknown, but the server reports no parent at all: nothing is held, so it is settled.
    const none: AuthStatus = { ...SIGNED_IN, parent: null, sessionId: null };
    const signedOut = fakeClient({ logout: async () => 'ended', status: async () => none });
    expect(await confirmSignOut(signedOut.client, { ...SIGNED_IN, sessionId: null })).toEqual({ confirmed: true, status: none });
    expect(signedOut.calls).toEqual(['status']);
  });

  it('a known session is never reported as ended while the server still reports it, or a session it can’t identify', async () => {
    const noId = { ...SIGNED_IN, sessionId: undefined } as unknown as AuthStatus;
    for (const [result, after] of [
      ['ended', SIGNED_IN],
      ['not_signed_in', SIGNED_IN],
      ['ended', noId],
      ['not_signed_in', noId],
    ] as const) {
      const { client } = fakeClient({ logout: async () => result, status: async () => after });
      const out = await confirmSignOut(client, SIGNED_IN);
      expect(out, `${result} then ${String(after.sessionId)}`).toMatchObject({ confirmed: false, retry: true });
    }
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
