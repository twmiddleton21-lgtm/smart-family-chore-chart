import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GOOGLE_OAUTH_COOKIE } from '../app';
import { FIXED_NOW } from '../testUtils';
import { FakeGoogle, FAKE_CLIENT } from './fakeGoogle';
import { APP_ORIGIN, Installation, MINUTE, PASSWORD, type Jar } from './testInstallation';

// The family's Google Calendar connection, end to end through the HTTP API
// in normal mode (sign-in on), against a fake Google (fakeGoogle.ts). No
// real Google account, credential or network access is involved. The
// installation harness is in testInstallation.ts.

const event = (id: string, summary: string, date = '2026-10-13') => ({ id, summary, start: { dateTime: `${date}T15:00:00+01:00` }, end: { dateTime: `${date}T16:00:00+01:00` } });

let google: FakeGoogle;
let clock: { now: number };
let home: Installation;
const others: Installation[] = [];

beforeEach(async () => {
  google = new FakeGoogle();
  google.calendars[0]!.items = [event('e1', 'Swimming lesson')];
  google.calendars[1]!.items = [event('s1', 'INSET day')];
  clock = { now: FIXED_NOW.getTime() };
  home = await new Installation(google, Buffer.alloc(32, 1), clock).start();
});
afterEach(async () => {
  await home.stop();
  for (const o of others.splice(0)) await o.stop();
});

describe('one connection for the whole family', () => {
  it('Parent A connects; Parent B and the paired kiosk see the same calendar without connecting', async () => {
    const parentA = await home.firstParent();
    const parentB = await home.secondParent(parentA);
    const kiosk = await home.pairDevice(parentA);

    expect((await home.get(kiosk, '/api/calendar')).json()).toEqual({ status: 'not_connected' });
    expect(await home.connect(parentA)).toBe('connected');

    const status = (await home.get(parentB, '/api/calendar/connection')).json();
    expect(status).toMatchObject({
      google: { available: true, connectOrigin: APP_ORIGIN },
      ical: { available: true },
      connection: { method: 'google', status: 'connected', problem: null, accountEmail: 'family@example.test', calendarId: 'family@example.test', calendarName: 'Family', connectedBy: 'Alex' },
    });
    for (const who of [parentA, parentB, kiosk]) {
      const r = (await home.get(who, '/api/calendar')).json();
      expect(r).toMatchObject({ status: 'ok', calendarName: 'Family', events: [{ title: 'Swimming lesson', startTime: '15:00' }] });
    }
  });

  it('stays connected after a server restart, sign-out and sign-in (refresh token persisted, encrypted)', async () => {
    const parentA = await home.firstParent();
    await home.connect(parentA);
    expect(JSON.stringify(home.storedRow())).not.toMatch(/refresh-[0-9a-f]+/); // only ciphertext at rest
    await home.post(parentA, '/api/auth/logout');

    await home.restart();
    const callsBefore = google.calls.filter((c) => c === 'token:refresh_token').length;
    const parentAAgain: Jar = {};
    expect((await home.post(parentAAgain, '/api/auth/login', { username: 'alex', password: PASSWORD })).statusCode).toBe(200);
    expect((await home.get(parentAAgain, '/api/calendar')).json()).toMatchObject({ status: 'ok', events: [{ title: 'Swimming lesson' }] });
    // The new server process got a fresh access token from the stored refresh token.
    expect(google.calls.filter((c) => c === 'token:refresh_token').length).toBe(callsBefore + 1);
  });

  it('keeps working when the parent who connected it is removed', async () => {
    const parentA = await home.firstParent();
    const parentB = await home.secondParent(parentA);
    await home.connect(parentB);
    const blakeId = home.auth.listParents().find((p) => p.username === 'blake')!.id;
    expect((await home.post(parentA, `/api/parents/${blakeId}/remove`, { password: PASSWORD })).statusCode).toBe(200);
    expect((await home.get(parentA, '/api/calendar/connection')).json().connection).toMatchObject({ status: 'connected', connectedBy: null });
    expect((await home.get(parentA, '/api/calendar')).json().status).toBe('ok');
  });

  it('refreshes an expired access token by itself', async () => {
    const parentA = await home.firstParent();
    await home.connect(parentA);
    google.expireAccessTokens();
    clock.now += 6 * MINUTE; // past the 5-minute cache
    expect((await home.get(parentA, '/api/calendar')).json().status).toBe('ok');
  });
});

describe('access control and family isolation', () => {
  it('rejects anonymous callers and keeps settings parent-only', async () => {
    const parent = await home.firstParent();
    const kiosk = await home.pairDevice(parent);
    await home.connect(parent);
    for (const [method, url] of [
      ['GET', '/api/calendar'],
      ['GET', '/api/calendar/connection'],
      ['GET', '/api/calendar/google/calendars'],
      ['POST', '/api/calendar/google/connect'],
      ['POST', '/api/calendar/google/calendar'],
      ['POST', '/api/calendar/google/disconnect'],
    ] as const) {
      const anon = await home.req(null, { method, url, ...(method === 'POST' ? { payload: {} } : {}) });
      expect(anon.statusCode, `${method} ${url}`).toBe(401);
      expect(anon.body).not.toContain('Swimming');
      if (url === '/api/calendar') continue;
      const device = await home.req(kiosk, { method, url, ...(method === 'POST' ? { payload: { appOrigin: APP_ORIGIN, calendarId: 'x' } } : {}) });
      expect(device.statusCode, `device ${method} ${url}`).toBe(403);
    }
    expect(home.storedRow()).toBeDefined(); // the device could not disconnect it
  });

  it('another family’s installation can’t use this family’s sessions, connection or stored token', async () => {
    const parent = await home.firstParent();
    const kiosk = await home.pairDevice(parent);
    await home.connect(parent);

    const other = await new Installation(new FakeGoogle(), Buffer.alloc(32, 2), clock).start();
    others.push(other);
    // This family's cookies mean nothing to the other server.
    expect((await other.get(parent, '/api/calendar')).statusCode).toBe(401);
    expect((await other.get(kiosk, '/api/calendar')).statusCode).toBe(401);
    // The other family sees only its own (unconnected) calendar.
    const otherParent = await other.firstParent('casey');
    expect((await other.get(otherParent, '/api/calendar')).json()).toEqual({ status: 'not_connected' });
    // Even a copied database row is useless without this family's secret key.
    const row = home.storedRow()!;
    other.opened.db.run(
      `INSERT INTO google_calendar_connection (id, account_email, refresh_token_enc, key_id, scope, calendar_id, calendar_name, status, connected_at, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, 'connected', ?, ?)`,
      row.account_email!, row.refresh_token_enc!, row.key_id!, row.scope!, row.calendar_id!, row.calendar_name!, row.connected_at!, row.updated_at!,
    );
    expect((await other.get(otherParent, '/api/calendar')).json()).toEqual({ status: 'error', reason: 'auth', source: 'google' });
    expect((await other.get(otherParent, '/api/calendar/connection')).json().connection).toMatchObject({ status: 'needs_reconnect', problem: 'key_changed' });
    expect(google.calls.filter((c) => c.startsWith('api:')).length).toBeGreaterThan(0);
  });

  it('a changed secret key asks for a reconnect instead of failing silently', async () => {
    const parent = await home.firstParent();
    await home.connect(parent);
    const moved = new Installation(google, Buffer.alloc(32, 9), clock);
    // Same database, different key: simulate by swapping the key and restarting.
    moved.tmp.cleanup();
    moved.tmp = home.tmp;
    await home.app.close();
    home.opened.db.close();
    await moved.start();
    home = moved;
    const again: Jar = {};
    expect((await home.post(again, '/api/auth/login', { username: 'alex', password: PASSWORD })).statusCode).toBe(200);
    expect((await home.get(again, '/api/calendar')).json()).toEqual({ status: 'error', reason: 'auth', source: 'google' });
  });
});

describe('OAuth state and callback handling', () => {
  it('refuses a callback without a pending state, with a reused state, or from another browser', async () => {
    const parent = await home.firstParent();
    expect(await home.callback(null, { code: 'x', state: 'never-issued' })).toBe('invalid_state');
    expect(await home.callback(null, {})).toBe('invalid_state');

    // Reused: the same state works once only.
    const start = await home.post(parent, '/api/calendar/google/connect', { appOrigin: APP_ORIGIN });
    const query = google.approve(start.json().authorizationUrl);
    const nonce = parent[GOOGLE_OAUTH_COOKIE]!;
    expect(await home.callback(parent, query)).toBe('connected');
    expect(await home.callback({ [GOOGLE_OAUTH_COOKIE]: nonce }, query)).toBe('invalid_state');

    // Started in one browser, finished in another (no or a different binding cookie).
    const start2 = await home.post(parent, '/api/calendar/google/connect', { appOrigin: APP_ORIGIN });
    const q2 = google.approve(start2.json().authorizationUrl);
    expect(await home.callback({ [GOOGLE_OAUTH_COOKIE]: 'someone-else' }, q2)).toBe('invalid_state');
  });

  it('sets the browser-binding cookie only for the callback path, HttpOnly, SameSite=Lax, Secure on HTTPS', async () => {
    const parent = await home.firstParent();
    const r = await home.post(parent, '/api/calendar/google/connect', { appOrigin: APP_ORIGIN });
    const cookie = (r.cookies as { name: string; path?: string; httpOnly?: boolean; sameSite?: string; secure?: boolean; maxAge?: number }[]).find((c) => c.name === GOOGLE_OAUTH_COOKIE)!;
    expect(cookie).toMatchObject({ path: '/api/calendar/google/callback', httpOnly: true, sameSite: 'Lax', secure: true, maxAge: 600 });
  });

  it('expires a pending connect after 10 minutes', async () => {
    const parent = await home.firstParent();
    const start = await home.post(parent, '/api/calendar/google/connect', { appOrigin: APP_ORIGIN });
    const query = google.approve(start.json().authorizationUrl);
    clock.now += 11 * MINUTE;
    expect(await home.callback(parent, query)).toBe('invalid_state');
    expect(home.storedRow()).toBeUndefined();
  });

  it('reports Cancel on Google’s page, unticked calendar access, a disabled Calendar API and a wrong client secret', async () => {
    const parent = await home.firstParent();
    expect(await home.connect(parent, (url) => ({ state: new URL(url).searchParams.get('state')!, error: 'access_denied' }))).toBe('denied');

    google.grantedScope = 'openid';
    expect(await home.connect(parent)).toBe('scope_missing');
    google.grantedScope = 'https://www.googleapis.com/auth/calendar.readonly';

    google.calendarApiEnabled = false;
    expect(await home.connect(parent)).toBe('calendar_api');
    expect(google.calls.at(-1)).toBe('revoke'); // the unusable grant was given back
    google.calendarApiEnabled = true;
    expect(home.storedRow()).toBeUndefined();
  });

  it('refuses to start from an address Google won’t send the parent back to', async () => {
    const parent = await home.firstParent();
    const r = await home.post(parent, '/api/calendar/google/connect', { appOrigin: 'http://192.168.1.20:3080' });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: 'wrong_address', connectOrigin: APP_ORIGIN });
  });

  it('a pending connect dies with the parent who started it', async () => {
    const parentA = await home.firstParent();
    const parentB = await home.secondParent(parentA);
    const start = await home.post(parentB, '/api/calendar/google/connect', { appOrigin: APP_ORIGIN });
    const query = google.approve(start.json().authorizationUrl);
    const blakeId = home.auth.listParents().find((p) => p.username === 'blake')!.id;
    await home.post(parentA, `/api/parents/${blakeId}/remove`, { password: PASSWORD });
    expect(await home.callback(parentB, query)).toBe('invalid_state');
  });
});

describe('revoked access, reconnecting and disconnecting', () => {
  it('revoked consent shows "needs reconnect" everywhere; reconnecting fixes it for everyone', async () => {
    const parent = await home.firstParent();
    const kiosk = await home.pairDevice(parent);
    await home.connect(parent);
    google.revokeEverything();
    clock.now += 6 * MINUTE;

    expect((await home.get(kiosk, '/api/calendar')).json()).toEqual({ status: 'error', reason: 'auth', source: 'google' });
    expect((await home.get(parent, '/api/calendar/connection')).json().connection).toMatchObject({ status: 'needs_reconnect', problem: 'revoked' });
    // No more token requests while it waits for a reconnect.
    const before = google.calls.length;
    expect((await home.get(kiosk, '/api/calendar')).json()).toEqual({ status: 'error', reason: 'auth', source: 'google' });
    expect(google.calls.length).toBe(before);

    expect(await home.connect(parent)).toBe('connected');
    expect((await home.get(kiosk, '/api/calendar')).json().status).toBe('ok');
  });

  it('disconnecting deletes the stored token, revokes it at Google, and stops calendar access at once', async () => {
    const parent = await home.firstParent();
    const kiosk = await home.pairDevice(parent);
    await home.connect(parent);
    expect((await home.get(kiosk, '/api/calendar')).json().status).toBe('ok'); // now cached

    const r = await home.post(parent, '/api/calendar/google/disconnect');
    expect(r.json()).toEqual({ ok: true, wasConnected: true, revokedAtGoogle: true });
    expect(home.storedRow()).toBeUndefined();
    expect(google.revokedTokens).toHaveLength(1);
    expect((await home.get(kiosk, '/api/calendar')).json()).toEqual({ status: 'not_connected' });
    await home.restart();
    expect(home.storedRow()).toBeUndefined();
  });
});

describe('choosing the calendar', () => {
  it('lists readable calendars (primary first), switches for the whole family, and refuses unknown ones', async () => {
    const parent = await home.firstParent();
    const kiosk = await home.pairDevice(parent);
    await home.connect(parent);
    const list = (await home.get(parent, '/api/calendar/google/calendars')).json().calendars;
    expect(list).toEqual([
      { id: 'family@example.test', name: 'Family', primary: true, selected: true },
      { id: 'school@group.calendar.example.test', name: 'School dates', primary: false, selected: false },
    ]);
    expect((await home.post(parent, '/api/calendar/google/calendar', { calendarId: 'school@group.calendar.example.test' })).statusCode).toBe(200);
    expect((await home.get(kiosk, '/api/calendar')).json()).toMatchObject({ calendarName: 'School dates', events: [{ title: 'INSET day' }] });
    expect((await home.post(parent, '/api/calendar/google/calendar', { calendarId: 'busy@group.calendar.example.test' })).statusCode).toBe(422);
  });
});

describe('installation without Google settings', () => {
  it('explains what is missing, and the calendar says "not set up"', async () => {
    const bare = await new Installation(google, Buffer.alloc(32, 3), clock, false).start();
    others.push(bare);
    const parent = await bare.firstParent();
    expect((await bare.get(parent, '/api/calendar/connection')).json()).toEqual({
      google: { available: false, missing: ['SFCC_GOOGLE_CLIENT_ID', 'SFCC_GOOGLE_CLIENT_SECRET_FILE', 'SFCC_GOOGLE_REDIRECT_URI', 'SFCC_SECRET_KEY_FILE'], connectOrigin: null },
      ical: { available: false, missing: ['SFCC_SECRET_KEY_FILE'], extraHosts: [] },
      connection: null,
      refresh: { lastSuccessAt: null, lastError: null, lastErrorDetail: null },
    });
    expect((await bare.post(parent, '/api/calendar/ical/check', { url: 'https://calendar.google.com/calendar/ical/x/private-abc/basic.ics' })).json().error).toBe('not_configured');
    expect((await bare.post(parent, '/api/calendar/google/connect', { appOrigin: APP_ORIGIN })).json().error).toBe('not_configured');
    expect((await bare.get(parent, '/api/calendar')).json()).toEqual({ status: 'not_configured' });
    expect(await bare.callback(null, { code: 'x', state: 'y' })).toBe('not_configured');
  });
});

describe('secrets never leave the server', () => {
  it('no token, code or client secret appears in any API response, header or log line', async () => {
    const parentA = await home.firstParent();
    const parentB = await home.secondParent(parentA);
    const kiosk = await home.pairDevice(parentA);
    await home.connect(parentA);
    for (const who of [parentA, parentB, kiosk]) {
      await home.get(who, '/api/calendar');
      await home.get(who, '/api/calendar/connection');
      await home.get(who, '/api/calendar/google/calendars');
    }
    google.revokeEverything();
    clock.now += 6 * MINUTE;
    await home.get(kiosk, '/api/calendar');
    await home.connect(parentA);
    await home.post(parentA, '/api/calendar/google/disconnect');

    const everything = [...home.bodies, ...home.logs].join('\n');
    expect(google.issued.length).toBeGreaterThan(4);
    for (const secret of [...google.issued, FAKE_CLIENT.clientSecret]) expect(everything).not.toContain(secret);
    expect(everything).not.toMatch(/refresh_token|access_token|client_secret/);
    // The callback was logged, but without its query string.
    expect(home.logs.some((l) => l.includes('/api/calendar/google/callback?[redacted]'))).toBe(true);
  });
});
