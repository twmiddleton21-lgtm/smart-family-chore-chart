import { readFileSync } from 'node:fs';
import http, { type IncomingMessage, type RequestOptions } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { databasePath } from '../open';
import { FIXED_NOW } from '../testUtils';
import { FakeGoogle } from './fakeGoogle';
import { FEED_CHECK_LIMIT } from './familyCalendar';
import type { FeedSettings } from './icalFeed';
import { APP_ORIGIN, Installation, MINUTE } from './testInstallation';

// The family calendar from a private iCal address, end to end through the
// HTTP API, and switching between it and Google OAuth. A local HTTP server
// plays the calendar provider (stub DNS sends calendar.google.com to it);
// Google is the in-memory fake. No real account, address or network.

const KEY = 'private-0123456789abcdef0123456789abcdef';
const FEED_PATH = `/calendar/ical/family%40example.test/${KEY}/basic.ics`;
const FEED_URL = `https://calendar.google.com${FEED_PATH}`;
const OTHER_KEY = 'private-fedcba9876543210fedcba9876543210';
const OTHER_URL = `https://calendar.google.com/calendar/ical/family%40example.test/${OTHER_KEY}/basic.ics`;

const ics = (name: string, ...events: [uid: string, title: string, start: string][]) =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `X-WR-CALNAME:${name}`,
    ...events.flatMap(([uid, title, start]) => ['BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${title}`, `DTSTART:${start}`, 'DESCRIPTION:secret notes', 'END:VEVENT']),
    'END:VCALENDAR',
    '',
  ].join('\r\n');

let feedServer: http.Server;
let feedPort: number;
/** What the provider answers per path (status, body). */
let feeds: Map<string, { status: number; body: string }>;
let feedRequests: string[];

const feedSettings = (): FeedSettings => ({
  extraHosts: [],
  fetchOptions: {
    resolve: async () => [{ address: '127.0.0.1', family: 4 }],
    isAllowedAddress: (a) => a === '127.0.0.1', // the test server stands in for a public host
    requestImpl: (opts: RequestOptions, cb: (res: IncomingMessage) => void) => http.request({ ...opts, protocol: 'http:', port: feedPort }, cb),
  },
});

let google: FakeGoogle;
let clock: { now: number };
let home: Installation;
const others: Installation[] = [];

beforeEach(async () => {
  feeds = new Map([
    [FEED_PATH, { status: 200, body: ics('Family (iCal)', ['f1', 'Football training', '20261013T170000Z'], ['f2', 'Dentist', '20261014T090000Z']) }],
  ]);
  feedRequests = [];
  feedServer = http.createServer((req, res) => {
    feedRequests.push(req.url ?? '');
    const f = feeds.get((req.url ?? '').split('?')[0]!) ?? { status: 404, body: 'not found' };
    res.writeHead(f.status, { 'Content-Type': 'text/calendar' }).end(f.body);
  });
  await new Promise<void>((resolve) => feedServer.listen(0, '127.0.0.1', resolve));
  feedPort = (feedServer.address() as AddressInfo).port;

  google = new FakeGoogle();
  google.calendars[0]!.items = [{ id: 'g1', summary: 'Google event', start: { dateTime: '2026-10-13T15:00:00+01:00' }, end: { dateTime: '2026-10-13T16:00:00+01:00' } }];
  clock = { now: FIXED_NOW.getTime() };
  home = await new Installation(google, Buffer.alloc(32, 1), clock, true, feedSettings()).start();
});
afterEach(async () => {
  await home.stop();
  for (const o of others.splice(0)) await o.stop();
  feedServer.closeAllConnections();
  await new Promise((resolve) => feedServer.close(resolve));
});

const titles = (body: { events?: { title: string }[] }) => (body.events ?? []).map((e) => e.title);

describe('one iCal connection for the whole family', () => {
  it('a parent checks and uses an address; every parent and paired device sees the same calendar', async () => {
    const parentA = await home.firstParent();
    const parentB = await home.secondParent(parentA);
    const kiosk = await home.pairDevice(parentA);

    const check = await home.post(parentA, '/api/calendar/ical/check', { url: FEED_URL });
    expect(check.json()).toEqual({
      ok: true,
      checkId: expect.any(String),
      provider: 'google',
      providerName: 'Google Calendar',
      host: 'calendar.google.com',
      calendarName: 'Family (iCal)',
      upcomingEvents: 2,
      replaces: null,
    });
    // Checking changes nothing yet.
    expect((await home.get(kiosk, '/api/calendar')).json()).toEqual({ status: 'not_connected' });

    const use = await home.post(parentA, '/api/calendar/ical/use', { checkId: check.json().checkId });
    expect(use.json()).toEqual({ ok: true, replaced: null, revokedAtGoogle: false });

    for (const who of [parentA, parentB, kiosk]) {
      const r = (await home.get(who, '/api/calendar')).json();
      expect(r).toMatchObject({ status: 'ok', source: 'ical', calendarName: 'Family (iCal)' });
      expect(titles(r)).toEqual(['Football training', 'Dentist']);
      expect(JSON.stringify(r)).not.toContain('secret notes'); // descriptions are dropped
    }
    const status = (await home.get(parentB, '/api/calendar/connection')).json();
    expect(status.connection).toEqual({
      method: 'ical',
      status: 'connected',
      problem: null,
      provider: 'google',
      providerName: 'Google Calendar',
      host: 'calendar.google.com',
      calendarName: 'Family (iCal)',
      connectedAt: FIXED_NOW.toISOString(),
      connectedBy: 'Alex',
    });
    expect(status.refresh).toEqual({ lastSuccessAt: FIXED_NOW.toISOString(), lastError: null, lastErrorDetail: null });
  });

  it('is cached for five minutes for everyone, picks up changes after that, and survives a restart', async () => {
    const parent = await home.firstParent();
    const kiosk = await home.pairDevice(parent);
    await home.useFeed(parent, FEED_URL);
    const before = feedRequests.length;
    for (let i = 0; i < 5; i++) await home.get(kiosk, '/api/calendar');
    expect(feedRequests.length - before).toBe(1);

    feeds.set(FEED_PATH, { status: 200, body: ics('Family (iCal)', ['f1', 'Football training (pitch 2)', '20261013T170000Z']) });
    expect(titles((await home.get(kiosk, '/api/calendar')).json())).toEqual(['Football training', 'Dentist']);
    clock.now += 6 * MINUTE;
    expect(titles((await home.get(kiosk, '/api/calendar')).json())).toEqual(['Football training (pitch 2)']);

    await home.restart(); // the kiosk's pairing and the encrypted address are both in the database
    expect((await home.get(kiosk, '/api/calendar')).json()).toMatchObject({ status: 'ok', source: 'ical' });
  });

  it('looking through several months asks the provider once (the download is reused briefly), then again after that', async () => {
    const parent = await home.firstParent();
    const kiosk = await home.pairDevice(parent);
    await home.useFeed(parent, FEED_URL);
    const before = feedRequests.length;
    for (const [start, end] of [
      ['2026-09-27', '2026-11-07'],
      ['2026-10-25', '2026-12-05'],
      ['2026-11-29', '2027-01-02'],
    ]) {
      expect((await home.get(kiosk, `/api/calendar?start=${start}&end=${end}`)).json()).toMatchObject({ status: 'ok', range: { start, end } });
    }
    expect(feedRequests.length - before).toBe(1);
    clock.now += 3 * MINUTE; // past the download's reuse time (2 minutes)
    await home.get(kiosk, '/api/calendar?start=2027-01-31&end=2027-03-06');
    expect(feedRequests.length - before).toBe(2);
    // A device can't ask for an unbounded stretch.
    expect((await home.get(kiosk, '/api/calendar?start=2026-01-01&end=2026-12-31')).statusCode).toBe(400);
  });

  it('a revoked (reset) address shows "needs attention" everywhere, keeping the old copy only for network failures', async () => {
    const parent = await home.firstParent();
    const kiosk = await home.pairDevice(parent);
    await home.useFeed(parent, FEED_URL);
    await home.get(kiosk, '/api/calendar');

    feeds.set(FEED_PATH, { status: 500, body: 'oops' });
    clock.now += 6 * MINUTE;
    expect((await home.get(kiosk, '/api/calendar')).json()).toMatchObject({ status: 'ok', stale: true });

    feeds.delete(FEED_PATH); // the parent reset the secret address at Google: 404
    clock.now += 2 * MINUTE;
    expect((await home.get(kiosk, '/api/calendar')).json()).toEqual({ status: 'error', reason: 'auth', source: 'ical' });
    expect((await home.get(parent, '/api/calendar/connection')).json().refresh).toMatchObject({ lastError: 'auth', lastErrorDetail: 'not_found' });

    feeds.set(FEED_PATH, { status: 200, body: 'not a calendar' });
    clock.now += 2 * MINUTE;
    expect((await home.get(kiosk, '/api/calendar')).json()).toEqual({ status: 'error', reason: 'feed_invalid', source: 'ical' });
  });
});

describe('checking an address', () => {
  it.each([
    ['not an address', 'hello', 'feed_url_invalid'],
    ['plain http', FEED_URL.replace('https:', 'http:'), 'feed_url_invalid'],
    ['an unsupported provider', 'https://example.com/cal.ics', 'feed_unsupported'],
    ['the Google web page address', 'https://calendar.google.com/calendar/embed?src=family%40example.test', 'feed_unsupported'],
    ['a local address', 'https://127.0.0.1/calendar/ical/x/private-ab/basic.ics', 'feed_unsupported'],
    ['cloud metadata', 'https://169.254.169.254/latest/meta-data/', 'feed_unsupported'],
  ])('refuses %s before fetching anything', async (_name, url, error) => {
    const parent = await home.firstParent();
    const r = await home.post(parent, '/api/calendar/ical/check', { url });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe(error);
    expect(feedRequests).toEqual([]);
  });

  it.each([
    [404, 'feed_not_found'],
    [403, 'feed_refused'],
    [503, 'feed_unavailable'],
  ])('explains a provider answering %i', async (status, error) => {
    const parent = await home.firstParent();
    feeds.set(FEED_PATH, { status, body: 'x' });
    const r = await home.post(parent, '/api/calendar/ical/check', { url: FEED_URL });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe(error);
  });

  it('refuses an address that returns something other than a calendar', async () => {
    const parent = await home.firstParent();
    feeds.set(FEED_PATH, { status: 200, body: '<html><body>Please sign in</body></html>' });
    expect((await home.post(parent, '/api/calendar/ical/check', { url: FEED_URL })).json().error).toBe('feed_not_ical');
  });

  it('refuses an address whose host resolves to a private address (real check, no override)', async () => {
    const strict = await new Installation(google, Buffer.alloc(32, 4), clock, true, {
      extraHosts: [],
      fetchOptions: { resolve: async () => [{ address: '10.0.0.7', family: 4 }], requestImpl: feedSettings().fetchOptions!.requestImpl },
    }).start();
    others.push(strict);
    const parent = await strict.firstParent();
    expect((await strict.post(parent, '/api/calendar/ical/check', { url: FEED_URL })).json().error).toBe('feed_blocked');
    expect(feedRequests).toEqual([]);
  });

  it(`allows ${FEED_CHECK_LIMIT.max} checks per ${FEED_CHECK_LIMIT.windowMs / MINUTE} minutes for the household`, async () => {
    const parentA = await home.firstParent();
    const parentB = await home.secondParent(parentA);
    for (let i = 0; i < FEED_CHECK_LIMIT.max; i++) {
      expect((await home.post(i % 2 ? parentA : parentB, '/api/calendar/ical/check', { url: FEED_URL })).statusCode).toBe(200);
    }
    const limited = await home.post(parentA, '/api/calendar/ical/check', { url: FEED_URL });
    expect(limited.statusCode).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    clock.now += FEED_CHECK_LIMIT.windowMs + 1;
    expect((await home.post(parentA, '/api/calendar/ical/check', { url: FEED_URL })).statusCode).toBe(200);
  });

  it('a check is single use, expires after 10 minutes, and belongs to the parent who made it', async () => {
    const parentA = await home.firstParent();
    const parentB = await home.secondParent(parentA);
    const checkId = (await home.post(parentA, '/api/calendar/ical/check', { url: FEED_URL })).json().checkId;
    expect((await home.post(parentB, '/api/calendar/ical/use', { checkId })).json().error).toBe('feed_check_expired');
    expect((await home.post(parentA, '/api/calendar/ical/use', { checkId: 'guessed-id' })).json().error).toBe('feed_check_expired');
    expect((await home.post(parentA, '/api/calendar/ical/use', { checkId })).json().ok).toBe(true);
    expect((await home.post(parentA, '/api/calendar/ical/use', { checkId, replace: true })).json().error).toBe('feed_check_expired');

    const late = (await home.post(parentA, '/api/calendar/ical/check', { url: OTHER_URL.replace(OTHER_KEY, KEY) })).json().checkId;
    clock.now += 11 * MINUTE;
    expect((await home.post(parentA, '/api/calendar/ical/use', { checkId: late, replace: true })).json().error).toBe('feed_check_expired');
  });
});

describe('one active connection: switching methods', () => {
  it('Google → iCal: validated first, confirmed explicitly, then swapped at once (Google grant revoked)', async () => {
    const parent = await home.firstParent();
    const kiosk = await home.pairDevice(parent);
    expect(await home.connect(parent)).toBe('connected');
    expect(titles((await home.get(kiosk, '/api/calendar')).json())).toEqual(['Google event']);

    const check = (await home.post(parent, '/api/calendar/ical/check', { url: FEED_URL })).json();
    expect(check.replaces).toEqual({ method: 'google', label: 'family@example.test', calendarName: 'Family' });
    // Without confirmation nothing changes.
    const unconfirmed = await home.post(parent, '/api/calendar/ical/use', { checkId: check.checkId });
    expect(unconfirmed.statusCode).toBe(409);
    expect(unconfirmed.json()).toMatchObject({ error: 'confirm_replace', replaces: { method: 'google' } });
    expect(home.storedRow()).toBeDefined();
    expect(titles((await home.get(kiosk, '/api/calendar')).json())).toEqual(['Google event']);

    const confirmed = (await home.post(parent, '/api/calendar/ical/use', { checkId: check.checkId, replace: true })).json();
    expect(confirmed).toEqual({ ok: true, replaced: 'google', revokedAtGoogle: true });
    expect(home.storedRow()).toBeUndefined();
    expect(home.storedFeed()).toBeDefined();
    expect(google.revokedTokens).toHaveLength(1);
    // No duplicates, no merging: only the iCal events, at once (cache dropped).
    expect(titles((await home.get(kiosk, '/api/calendar')).json())).toEqual(['Football training', 'Dentist']);
  });

  it('a failed check keeps the working Google connection untouched', async () => {
    const parent = await home.firstParent();
    const kiosk = await home.pairDevice(parent);
    await home.connect(parent);
    const before = home.storedRow();
    feeds.delete(FEED_PATH);
    expect((await home.post(parent, '/api/calendar/ical/check', { url: FEED_URL })).statusCode).toBe(422);
    expect(home.storedRow()).toEqual(before);
    expect(home.storedFeed()).toBeUndefined();
    expect(titles((await home.get(kiosk, '/api/calendar')).json())).toEqual(['Google event']);
  });

  it('the swap is atomic: if storing the new connection fails, the old one is still there', async () => {
    const parent = await home.firstParent();
    await home.connect(parent);
    const before = home.storedRow();
    const checkId = (await home.post(parent, '/api/calendar/ical/check', { url: FEED_URL })).json().checkId;
    const db = home.opened.db;
    const run = db.run.bind(db);
    db.run = (sql, ...params) => {
      if (sql.includes('INSERT INTO ical_feed_connection')) throw new Error('disk full (simulated)');
      return run(sql, ...params);
    };
    const r = await home.post(parent, '/api/calendar/ical/use', { checkId, replace: true });
    db.run = run;
    expect(r.statusCode).toBe(500);
    expect(r.body).not.toContain(KEY);
    expect(home.storedRow()).toEqual(before);
    expect(home.storedFeed()).toBeUndefined();
    expect(google.revokedTokens).toEqual([]);
  });

  it('iCal → Google: Connect asks for confirmation first, and only replaces once Google says yes', async () => {
    const parent = await home.firstParent();
    await home.useFeed(parent, FEED_URL);

    const unconfirmed = await home.post(parent, '/api/calendar/google/connect', { appOrigin: APP_ORIGIN });
    expect(unconfirmed.statusCode).toBe(409);
    expect(unconfirmed.json()).toMatchObject({ error: 'confirm_replace', replaces: { method: 'ical', label: 'Google Calendar address (calendar.google.com)' } });

    // Cancelled on Google's page: the iCal address keeps working.
    expect(await home.connect(parent, (url) => ({ state: new URL(url).searchParams.get('state')!, error: 'access_denied' }), { replace: true })).toBe('denied');
    expect(home.storedFeed()).toBeDefined();
    expect((await home.get(parent, '/api/calendar')).json()).toMatchObject({ status: 'ok', source: 'ical' });

    expect(await home.connect(parent, undefined, { replace: true })).toBe('connected');
    expect(home.storedFeed()).toBeUndefined();
    expect((await home.get(parent, '/api/calendar')).json()).toMatchObject({ status: 'ok', source: 'google' });
    expect(titles((await home.get(parent, '/api/calendar')).json())).toEqual(['Google event']);
  });

  it('if another parent changes the iCal address during a Google connect, nothing is replaced and the new grant is returned', async () => {
    const parentA = await home.firstParent();
    const parentB = await home.secondParent(parentA);
    feeds.set(new URL(OTHER_URL).pathname, feeds.get(FEED_PATH)!);
    await home.useFeed(parentA, FEED_URL);
    const start = await home.post(parentA, '/api/calendar/google/connect', { appOrigin: APP_ORIGIN, replace: true });
    const query = google.approve(start.json().authorizationUrl);
    clock.now += 1000;
    expect((await home.useFeed(parentB, OTHER_URL, { replace: true })).json().ok).toBe(true);
    expect(await home.callback(parentA, query)).toBe('changed');
    expect(home.storedRow()).toBeUndefined();
    expect(home.storedFeed()).toBeDefined();
    expect(google.revokedTokens).toHaveLength(1);
  });

  it('replacing one iCal address with another needs confirmation too; a stale confirmation is asked again', async () => {
    const parentA = await home.firstParent();
    const parentB = await home.secondParent(parentA);
    feeds.set(new URL(OTHER_URL).pathname, { status: 200, body: ics('Other', ['o1', 'Other event', '20261013T100000Z']) });
    await home.useFeed(parentA, FEED_URL);
    const check = (await home.post(parentA, '/api/calendar/ical/check', { url: OTHER_URL })).json();
    expect(check.replaces).toMatchObject({ method: 'ical', calendarName: 'Family (iCal)' });
    // Meanwhile parent B connects Google instead: A's confirmation was about something else.
    expect(await home.connect(parentB, undefined, { replace: true })).toBe('connected');
    const stale = await home.post(parentA, '/api/calendar/ical/use', { checkId: check.checkId, replace: true });
    expect(stale.json()).toMatchObject({ error: 'confirm_replace', replaces: { method: 'google' } });
    expect(home.storedRow()).toBeDefined();
    expect((await home.post(parentA, '/api/calendar/ical/use', { checkId: check.checkId, replace: true })).json()).toMatchObject({ ok: true, replaced: 'google' });
    expect(titles((await home.get(parentA, '/api/calendar')).json())).toEqual(['Other event']);
  });
});

describe('disconnecting', () => {
  it('removes the stored address and cached events at once, on every device', async () => {
    const parent = await home.firstParent();
    const kiosk = await home.pairDevice(parent);
    await home.useFeed(parent, FEED_URL);
    expect((await home.get(kiosk, '/api/calendar')).json().status).toBe('ok');
    expect((await home.post(parent, '/api/calendar/ical/disconnect')).json()).toEqual({ ok: true, wasConnected: true });
    expect(home.storedFeed()).toBeUndefined();
    expect((await home.get(kiosk, '/api/calendar')).json()).toEqual({ status: 'not_connected' });
    expect((await home.get(parent, '/api/calendar/connection')).json()).toMatchObject({ connection: null, refresh: { lastSuccessAt: null } });
    expect((await home.post(parent, '/api/calendar/ical/disconnect')).json()).toEqual({ ok: true, wasConnected: false });
  });
});

describe('access control and family isolation', () => {
  it('only signed-in parents may check, use or disconnect; devices may only read events', async () => {
    const parent = await home.firstParent();
    const kiosk = await home.pairDevice(parent);
    const checkId = (await home.post(parent, '/api/calendar/ical/check', { url: FEED_URL })).json().checkId;
    for (const [url, body] of [
      ['/api/calendar/ical/check', { url: FEED_URL }],
      ['/api/calendar/ical/use', { checkId, replace: true }],
      ['/api/calendar/ical/disconnect', {}],
    ] as const) {
      expect((await home.post(null, url, body)).statusCode, url).toBe(401);
      expect((await home.post(kiosk, url, body)).statusCode, url).toBe(403);
    }
    expect((await home.get(kiosk, '/api/calendar/connection')).statusCode).toBe(403);
    expect(home.storedFeed()).toBeUndefined();
  });

  it('another family’s installation can’t use this family’s check, address or stored ciphertext', async () => {
    const parent = await home.firstParent();
    const checkId = (await home.post(parent, '/api/calendar/ical/check', { url: FEED_URL })).json().checkId;
    await home.post(parent, '/api/calendar/ical/use', { checkId });

    const other = await new Installation(google, Buffer.alloc(32, 2), clock, true, feedSettings()).start();
    others.push(other);
    const otherParent = await other.firstParent();
    expect((await other.post(otherParent, '/api/calendar/ical/use', { checkId, replace: true })).json().error).toBe('feed_check_expired');
    expect((await other.get(otherParent, '/api/calendar')).json()).toEqual({ status: 'not_connected' });

    // Even a copied row is useless without this family's secret key.
    const row = home.storedFeed()!;
    other.opened.db.run(
      'INSERT INTO ical_feed_connection (id, url_enc, key_id, provider, host, calendar_name, connected_at, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?, ?)',
      row.url_enc!,
      row.key_id!,
      row.provider!,
      row.host!,
      row.calendar_name!,
      row.connected_at!,
      row.updated_at!,
    );
    expect((await other.get(otherParent, '/api/calendar')).json()).toEqual({ status: 'error', reason: 'auth', source: 'ical' });
    expect((await other.get(otherParent, '/api/calendar/connection')).json().connection).toMatchObject({ status: 'needs_reconnect', problem: 'key_changed' });
  });
});

describe('the address never leaves the server', () => {
  it('is not in any API answer, header or log line, nor stored in plain text', async () => {
    const parentA = await home.firstParent();
    const parentB = await home.secondParent(parentA);
    const kiosk = await home.pairDevice(parentA);
    await home.post(parentA, '/api/calendar/ical/check', { url: 'https://calendar.google.com/calendar/ical/x/private-00/full.ics' });
    feeds.set(new URL(OTHER_URL).pathname, { status: 404, body: '' });
    await home.post(parentA, '/api/calendar/ical/check', { url: OTHER_URL });
    await home.useFeed(parentA, FEED_URL);
    for (const who of [parentA, parentB, kiosk]) {
      await home.get(who, '/api/calendar');
      await home.get(who, '/api/calendar/connection');
    }
    feeds.delete(FEED_PATH);
    clock.now += 6 * MINUTE;
    await home.get(kiosk, '/api/calendar');
    await home.get(parentA, '/api/calendar/connection');
    await home.post(parentA, '/api/calendar/ical/disconnect');

    // Every answer and log line, except the parent's own check requests (the body they sent).
    const everything = [...home.bodies, ...home.logs].join('\n');
    for (const secret of [KEY, OTHER_KEY, 'family%40example.test', FEED_PATH]) expect(everything).not.toContain(secret);
    expect(home.logs.some((l) => l.includes('calendar address checked'))).toBe(true);
    // The database holds the address only encrypted.
    home.opened.db.close();
    expect(readFileSync(databasePath(home.tmp.dir)).toString('latin1')).not.toContain(KEY);
    home.opened = await (await import('../open')).openData(home.tmp.dir, 'Europe/London');
  });
});

describe('an installation with only the secret key (no Google OAuth)', () => {
  it('offers iCal addresses and explains that Google needs more settings', async () => {
    const keyOnly = await new Installation(google, Buffer.alloc(32, 5), clock, false, feedSettings(), true).start();
    others.push(keyOnly);
    const parent = await keyOnly.firstParent();
    const status = (await keyOnly.get(parent, '/api/calendar/connection')).json();
    expect(status.google.available).toBe(false);
    expect(status.ical).toEqual({ available: true, missing: [], extraHosts: [] });
    expect((await keyOnly.get(parent, '/api/calendar')).json()).toEqual({ status: 'not_connected' });
    expect((await keyOnly.useFeed(parent, FEED_URL)).json()).toMatchObject({ ok: true });
    expect((await keyOnly.get(parent, '/api/calendar')).json()).toMatchObject({ status: 'ok', source: 'ical' });
  });
});
