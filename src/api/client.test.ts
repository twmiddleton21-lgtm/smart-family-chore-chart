import { describe, expect, it } from 'vitest';
import { ApiError, AUTH_CHANGED_EVENT, createApiClient, toFamilyData } from './client';

type Call = { url: string; init: RequestInit };

/** A fake fetch that records calls and returns a scripted response. */
function fakeFetch(status: number, body: unknown, calls: Call[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
}

async function errorOf(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) return e;
    throw e;
  }
  throw new Error('expected an ApiError');
}

describe('API client', () => {
  it('GETs state and POSTs commands as JSON to the same origin', async () => {
    const calls: Call[] = [];
    const client = createApiClient(fakeFetch(200, { stateVersion: 2, changed: [], noChange: false }, calls));
    await client.sendCommand({ type: 'toggleChore', payload: { choreId: 'x' } });
    expect(calls[0]!.url).toBe('/api/commands');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(calls[0]!.init.credentials).toBe('same-origin');
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ type: 'toggleChore', payload: { choreId: 'x' } });
  });

  it('maps a network failure to "unreachable" with a friendly message', async () => {
    const failing = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const err = await errorOf(createApiClient(failing).getState());
    expect(err.kind).toBe('unreachable');
    expect(err.message).toMatch(/Can’t reach the family server/);
  });

  it.each([
    [502, {}, 'unreachable'],
    [504, {}, 'unreachable'],
    [503, { error: 'other' }, 'unreachable'],
    [503, { error: 'api_unavailable', message: 'disabled' }, 'disabled'],
    [409, { error: 'conflict', message: 'Changed elsewhere.' }, 'conflict'],
    [422, { error: 'rejected', message: 'Not enough points.' }, 'rejected'],
    [400, { error: 'invalid_request' }, 'invalid'],
    [413, { error: 'payload_too_large' }, 'invalid'],
    [404, { error: 'not_found', message: 'Gone.' }, 'not_found'],
    [403, { error: 'forbidden' }, 'forbidden'],
    [500, { error: 'internal_error' }, 'server'],
  ])('maps HTTP %i to "%s"', async (status, body, kind) => {
    const err = await errorOf(createApiClient(fakeFetch(status, body)).getState());
    expect(err.kind).toBe(kind);
    expect(err.status).toBe(status);
  });

  it('uses the server message for business-rule answers, its own wording otherwise', async () => {
    const rejected = await errorOf(createApiClient(fakeFetch(422, { error: 'rejected', message: 'Alex needs 5 more points.' })).getState());
    expect(rejected.message).toBe('Alex needs 5 more points.');
    const internal = await errorOf(createApiClient(fakeFetch(500, { message: 'stack trace here' })).getState());
    expect(internal.message).not.toContain('stack');
  });

  it('treats a non-JSON success response as a server error', async () => {
    const err = await errorOf(createApiClient(fakeFetch(200, '<html>proxy page</html>')).getState());
    expect(err.kind).toBe('server');
  });

  it('keeps the error body (e.g. conflict record) for the caller', async () => {
    const err = await errorOf(createApiClient(fakeFetch(409, { error: 'conflict', record: 'child:a', currentVersion: 3 })).getState());
    expect(err.body).toMatchObject({ record: 'child:a', currentVersion: 3 });
  });

  it('adds an empty PIN placeholder for the browser data type', () => {
    const fam = toFamilyData({
      version: 3,
      settings: { familyName: 'X', mealReminderDismissedOn: null },
      children: [],
      chores: [],
      rewards: [],
      completions: [],
      redemptions: [],
      meals: [],
      foodOptions: { mains: [], puddings: [] },
    });
    expect(fam.settings.parentPin).toBe('');
  });
});

describe('API client: sign-in answers', () => {
  it('maps 401, parent-required 403 and 429 to their own kinds, keeping the server wording', async () => {
    const client = createApiClient(fakeFetch(401, { error: 'unauthenticated', message: 'Please sign in or pair this device.' }));
    expect(await errorOf(client.getState())).toMatchObject({ kind: 'unauthenticated', status: 401, message: 'Please sign in or pair this device.' });
    const device = createApiClient(fakeFetch(403, { error: 'parent_required', message: 'A parent needs to sign in for this.' }));
    expect((await errorOf(device.exportData())).kind).toBe('parent_required');
    const csrf = createApiClient(fakeFetch(403, { error: 'cross_site_request', message: 'nope' }));
    expect((await errorOf(csrf.getState())).kind).toBe('forbidden');
    const limited = createApiClient(fakeFetch(429, { error: 'too_many_attempts', message: 'Too many attempts. Please wait and try again.' }));
    expect(await errorOf(limited.getState())).toMatchObject({ kind: 'rate_limited', message: 'Too many attempts. Please wait and try again.' });
  });

  it('announces a changed sign-in state on 401 unauthenticated and 403 parent_required only', async () => {
    const seen: string[] = [];
    const target = new EventTarget();
    const g = globalThis as { window?: unknown };
    const had = 'window' in g;
    const previous = g.window;
    g.window = target;
    target.addEventListener(AUTH_CHANGED_EVENT, () => seen.push('changed'));
    try {
      await errorOf(createApiClient(fakeFetch(401, { error: 'unauthenticated' })).getState());
      await errorOf(createApiClient(fakeFetch(403, { error: 'parent_required' })).getState());
      expect(seen).toEqual(['changed', 'changed']);
      // A wrong password is not a session change.
      await errorOf(createApiClient(fakeFetch(401, { error: 'invalid_credentials' })).getState());
      await errorOf(createApiClient(fakeFetch(409, { error: 'conflict' })).getState());
      expect(seen).toHaveLength(2);
    } finally {
      if (had) g.window = previous;
      else delete g.window;
    }
  });
});
