import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app';
import { openData } from '../open';
import { tempDir } from '../testUtils';
import {
  CalendarService,
  CalendarSourceError,
  fixtureCalendarSource,
  googleCalendarSource,
  normaliseGoogleEvents,
  requestedRange,
  type CalendarSource,
  type CalendarState,
} from './calendar';

// Mocked Google answers only: these tests never contact Google.

const TZ = 'Europe/London';
const RANGE = { start: '2026-10-24', end: '2026-10-30' };
/** Saturday 24 Oct 2026, 08:00 in London (BST, UTC+1). */
const NOW = new Date('2026-10-24T07:00:00Z');

describe('normaliseGoogleEvents', () => {
  it('converts timed events to household dates and times', () => {
    const [e] = normaliseGoogleEvents(
      [{ id: 'a', summary: 'Swimming', location: 'Leisure centre', start: { dateTime: '2026-10-24T09:30:00+01:00' }, end: { dateTime: '2026-10-24T10:15:00+01:00' } }],
      TZ,
      RANGE,
    );
    expect(e).toEqual({ id: 'a', title: 'Swimming', allDay: false, startDate: '2026-10-24', endDate: '2026-10-24', startTime: '09:30', endTime: '10:15', location: 'Leisure centre' });
  });

  it('uses the household time zone, not UTC (a late UTC time is the next day in Sydney)', () => {
    const [e] = normaliseGoogleEvents([{ id: 'a', summary: 'x', start: { dateTime: '2026-10-24T22:00:00Z' }, end: { dateTime: '2026-10-24T23:00:00Z' } }], 'Australia/Sydney', { start: '2026-10-25', end: '2026-10-31' });
    expect(e).toMatchObject({ startDate: '2026-10-25', startTime: '09:00' });
  });

  it('makes all-day end dates inclusive (Google sends the day after)', () => {
    const [one, half] = normaliseGoogleEvents(
      [
        { id: 'a', summary: 'Birthday', start: { date: '2026-10-25' }, end: { date: '2026-10-26' } },
        { id: 'b', summary: 'Half term', start: { date: '2026-10-26' }, end: { date: '2026-10-31' } },
      ],
      TZ,
      RANGE,
    );
    expect(one).toMatchObject({ allDay: true, startDate: '2026-10-25', endDate: '2026-10-25' });
    expect(half).toMatchObject({ startDate: '2026-10-26', endDate: '2026-10-30' });
  });

  it('drops cancelled, malformed and out-of-range events; keeps untitled ones', () => {
    const events = normaliseGoogleEvents(
      [
        { id: 'c', status: 'cancelled', summary: 'Off', start: { date: '2026-10-25' } },
        { id: 'm', summary: 'No start' },
        { summary: 'No id', start: { date: '2026-10-25' } },
        { id: 'bad', start: { dateTime: 'not a date' } },
        { id: 'late', summary: 'Too late', start: { date: '2026-11-05' } },
        { id: 'u', start: { date: '2026-10-25' } },
        null,
      ],
      TZ,
      RANGE,
    );
    expect(events.map((e) => [e.id, e.title])).toEqual([['u', '(No title)']]);
    expect(normaliseGoogleEvents('nope', TZ, RANGE)).toEqual([]);
  });

  it('keeps an event that started before the range but is still running', () => {
    const [e] = normaliseGoogleEvents([{ id: 'a', summary: 'Trip', start: { date: '2026-10-20' }, end: { date: '2026-10-26' } }], TZ, RANGE);
    expect(e).toMatchObject({ startDate: '2026-10-20', endDate: '2026-10-25' });
  });

  it('trims long text and strips control characters', () => {
    const [e] = normaliseGoogleEvents([{ id: 'a', summary: `A\nB${'x'.repeat(500)}`, start: { date: '2026-10-25' } }], TZ, RANGE);
    expect(e!.title.startsWith('A B')).toBe(true);
    expect(e!.title).toHaveLength(200);
  });
});

describe('googleCalendarSource (mocked Google API)', () => {
  const tokens = { getAccessToken: async () => 'test-access-token' };
  const answer = (status: number, body: unknown = {}) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it('calls events.list read-only, for one calendar, asking only for the fields it shows', async () => {
    const fetchImpl = answer(200, { summary: 'The Family', items: [{ id: 'a', summary: 'Football', start: { date: '2026-10-24' }, end: { date: '2026-10-25' } }] });
    const source = googleCalendarSource({ calendarId: 'family#abc@group.calendar.google.com', tokens, fetchImpl });
    const result = await source.listEvents(RANGE, TZ);
    expect(result).toEqual({ calendarName: 'The Family', events: [expect.objectContaining({ id: 'a', title: 'Football' })] });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://www.googleapis.com/calendar/v3/calendars/family%23abc%40group.calendar.google.com/events');
    expect(u.searchParams.get('singleEvents')).toBe('true');
    expect(u.searchParams.get('timeZone')).toBe(TZ);
    expect(u.searchParams.get('fields')).toBe('summary,items(id,status,summary,location,start,end)');
    expect(init.method ?? 'GET').toBe('GET');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-access-token');
  });

  it.each([
    [401, 'auth'],
    [403, 'access'],
    [404, 'not_found'],
    [500, 'unavailable'],
    [503, 'unavailable'],
  ] as const)('maps Google HTTP %i to "%s"', async (status, reason) => {
    const source = googleCalendarSource({ calendarId: 'x', tokens, fetchImpl: answer(status) });
    await expect(source.listEvents(RANGE, TZ)).rejects.toMatchObject({ reason });
  });

  it('reports a network failure as unavailable and a token failure as auth', async () => {
    const offline = googleCalendarSource({ calendarId: 'x', tokens, fetchImpl: vi.fn(async () => Promise.reject(new TypeError('fetch failed'))) });
    await expect(offline.listEvents(RANGE, TZ)).rejects.toMatchObject({ reason: 'unavailable' });
    const noToken = googleCalendarSource({ calendarId: 'x', tokens: { getAccessToken: () => Promise.reject(new Error('expired')) }, fetchImpl: answer(200) });
    await expect(noToken.listEvents(RANGE, TZ)).rejects.toMatchObject({ reason: 'auth' });
  });
});

describe('CalendarService', () => {
  const okSource = (calls: { n: number }): CalendarSource => ({
    kind: 'google',
    async listEvents() {
      calls.n++;
      return { calendarName: 'Family', events: [] };
    },
  });

  it('says "not configured" without a source', async () => {
    expect(await CalendarService.fixed(null, TZ).upcoming()).toEqual({ status: 'not_configured' });
  });

  it('shows today and the next six days in the household time zone', async () => {
    const r = await CalendarService.fixed(okSource({ n: 0 }), TZ, () => NOW).upcoming();
    expect(r).toMatchObject({ status: 'ok', calendarName: 'Family', timeZone: TZ, range: RANGE, stale: false });
  });

  it('caches for five minutes, then asks again', async () => {
    const calls = { n: 0 };
    let now = NOW.getTime();
    const service = CalendarService.fixed(okSource(calls), TZ, () => new Date(now));
    await service.upcoming();
    now += 4 * 60_000;
    await service.upcoming();
    expect(calls.n).toBe(1);
    now += 2 * 60_000;
    await service.upcoming();
    expect(calls.n).toBe(2);
  });

  it('keeps the last good copy (marked stale) when Google is unreachable, but reports credential problems', async () => {
    let fail: CalendarSourceError | null = null;
    let now = NOW.getTime();
    const source: CalendarSource = {
      kind: 'google',
      async listEvents() {
        if (fail) throw fail;
        return { calendarName: 'Family', events: [] };
      },
    };
    const service = CalendarService.fixed(source, TZ, () => new Date(now));
    await service.upcoming();
    now += 10 * 60_000;
    fail = new CalendarSourceError('unavailable', 'down');
    expect(await service.upcoming()).toMatchObject({ status: 'ok', stale: true });
    fail = new CalendarSourceError('auth', 'revoked');
    now += 2 * 60_000; // past the one-minute failure back-off
    expect(await service.upcoming()).toEqual({ status: 'error', reason: 'auth', source: 'google' });
  });

  it('reports an error when Google fails and there is no copy yet', async () => {
    const source: CalendarSource = { kind: 'ical', listEvents: () => Promise.reject(new Error('boom')) };
    expect(await CalendarService.fixed(source, TZ, () => NOW).upcoming()).toEqual({ status: 'error', reason: 'unavailable', source: 'ical' });
  });

  it('after a failure, every device gets the same answer for a minute instead of asking the provider again', async () => {
    let calls = 0;
    let now = NOW.getTime();
    const source: CalendarSource = {
      kind: 'ical',
      listEvents: () => {
        calls++;
        return Promise.reject(new CalendarSourceError('unavailable', 'down', 'timeout'));
      },
    };
    const service = CalendarService.fixed(source, TZ, () => new Date(now));
    for (let i = 0; i < 20; i++) await service.upcoming();
    expect(calls).toBe(1);
    expect(service.lastRefresh()).toEqual({ lastSuccessAt: null, lastError: 'unavailable', lastErrorDetail: 'timeout' });
    now += 61_000;
    await service.upcoming();
    expect(calls).toBe(2);
  });

  it('remembers the last successful refresh, and forgets it when the connection changes', async () => {
    let fail = false;
    let now = NOW.getTime();
    const source: CalendarSource = {
      kind: 'google',
      listEvents: async () => {
        if (fail) throw new CalendarSourceError('unavailable', 'down');
        return { calendarName: 'Family', events: [] };
      },
    };
    const service = CalendarService.fixed(source, TZ, () => new Date(now));
    await service.upcoming();
    expect(service.lastRefresh()).toEqual({ lastSuccessAt: NOW.toISOString(), lastError: null, lastErrorDetail: null });
    fail = true;
    now += 6 * 60_000;
    await service.upcoming();
    expect(service.lastRefresh()).toEqual({ lastSuccessAt: NOW.toISOString(), lastError: 'unavailable', lastErrorDetail: null });
    service.invalidate();
    expect(service.lastRefresh().lastSuccessAt).toBeNull();
  });

  it('never answers with the old connection’s events when the connection changes while they are being fetched', async () => {
    // The old connection's fetch is slow; the connection is replaced (then
    // disconnected) before it finishes. Callers already waiting must get the
    // current connection's answer.
    let releaseOld!: () => void;
    const oldSource: CalendarSource = {
      kind: 'ical',
      listEvents: () => new Promise((resolve) => (releaseOld = () => resolve({ calendarName: 'Old', events: [{ id: 'o', title: 'Old event', allDay: true, startDate: RANGE.start, endDate: RANGE.start }] }))),
    };
    const newSource: CalendarSource = { kind: 'google', listEvents: async () => ({ calendarName: 'New', events: [] }) };
    let state: CalendarState = { kind: 'ready', source: oldSource, key: 'ical|1' };
    const service = new CalendarService(() => state, TZ, () => NOW);

    const waiting = service.upcoming();
    await new Promise((r) => setImmediate(r));
    state = { kind: 'ready', source: newSource, key: 'google|2' };
    service.invalidate();
    releaseOld();
    expect(await waiting).toMatchObject({ status: 'ok', calendarName: 'New', source: 'google', events: [] });

    state = { kind: 'ready', source: oldSource, key: 'ical|3' };
    service.invalidate();
    const waitingAgain = service.upcoming();
    await new Promise((r) => setImmediate(r));
    state = { kind: 'not_connected' };
    service.invalidate();
    releaseOld();
    expect(await waitingAgain).toEqual({ status: 'not_connected' });
  });

  it('gives "try again", not old events, if the connection keeps changing during every fetch', async () => {
    let n = 0;
    let state: CalendarState;
    const source = (): CalendarSource => ({
      kind: 'ical',
      listEvents: async () => {
        state = { kind: 'ready', source: source(), key: `ical|${++n}` }; // changes again during each fetch
        return { calendarName: `Connection ${n}`, events: [] };
      },
    });
    state = { kind: 'ready', source: source(), key: 'ical|0' };
    const service = new CalendarService(() => state, TZ, () => NOW);
    expect(await service.upcoming()).toEqual({ status: 'error', reason: 'unavailable', source: 'ical' });
    expect(n).toBe(3); // asked at most three times
  });
});

describe('GET /api/calendar', () => {
  let tmp: ReturnType<typeof tempDir>;
  let close: () => Promise<void>;
  beforeEach(() => {
    tmp = tempDir();
  });
  afterEach(async () => {
    await close?.();
    tmp.cleanup();
  });

  async function appWith(calendar?: CalendarService) {
    const opened = await openData(tmp.dir, TZ);
    const app = buildApp({ config: { devUnauthenticatedApi: true, bodyLimit: 64 * 1024, timeZone: TZ, port: 80, dataDir: tmp.dir }, db: opened.db, store: opened.store, calendar });
    await app.ready();
    close = async () => {
      await app.close();
      opened.db.close();
    };
    return app;
  }
  const get = (app: Awaited<ReturnType<typeof appWith>>) => app.inject({ method: 'GET', url: '/api/calendar', headers: { host: 'localhost:80' }, remoteAddress: '127.0.0.1' });

  it('reports "not configured" when no calendar is set up', async () => {
    const r = await get(await appWith());
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'not_configured' });
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('serves fixture events (development/test adapter), and simulated failures', async () => {
    const file = path.join(tmp.dir, 'calendar.json');
    writeFileSync(file, JSON.stringify({ summary: 'Test Family', items: [{ id: 'a', summary: 'Dentist', start: { dateTime: '2026-10-24T15:00:00+01:00' }, end: { dateTime: '2026-10-24T15:30:00+01:00' } }] }));
    const app = await appWith(CalendarService.fixed(fixtureCalendarSource(file), TZ, () => NOW));
    const body = (await get(app)).json();
    expect(body).toMatchObject({ status: 'ok', calendarName: 'Test Family', range: RANGE, events: [{ title: 'Dentist', startTime: '15:00', endTime: '15:30' }] });
  });

  it('serves an .ics fixture as an iCal source', async () => {
    const file = path.join(tmp.dir, 'calendar.ics');
    writeFileSync(file, 'BEGIN:VCALENDAR\r\nX-WR-CALNAME:Ics Family\r\nBEGIN:VEVENT\r\nUID:a\r\nSUMMARY:Library\r\nDTSTART:20261024T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n');
    const body = (await get(await appWith(CalendarService.fixed(fixtureCalendarSource(file), TZ, () => NOW)))).json();
    expect(body).toMatchObject({ status: 'ok', source: 'ical', calendarName: 'Ics Family', events: [{ title: 'Library', startTime: '10:00' }] });
  });

  it('turns a simulated Google failure into an error status, not a server error', async () => {
    const file = path.join(tmp.dir, 'calendar.json');
    writeFileSync(file, JSON.stringify({ error: 'auth' }));
    const r = await get(await appWith(CalendarService.fixed(fixtureCalendarSource(file), TZ, () => NOW)));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'error', reason: 'auth', source: 'google' });
  });

  it('serves a month view’s range (?start=&end=), including events in the neighbouring months’ days', async () => {
    const file = path.join(tmp.dir, 'calendar.json');
    writeFileSync(
      file,
      JSON.stringify({
        summary: 'Test Family',
        items: [
          { id: 'sep', summary: 'End of September', start: { date: '2026-09-27' }, end: { date: '2026-09-28' } },
          { id: 'oct', summary: 'Halloween', start: { dateTime: '2026-10-31T17:00:00Z' }, end: { dateTime: '2026-10-31T19:00:00Z' } },
          { id: 'nov', summary: 'Bonfire night', start: { date: '2026-11-05' }, end: { date: '2026-11-06' } },
        ],
      }),
    );
    const app = await appWith(CalendarService.fixed(fixtureCalendarSource(file), TZ, () => NOW));
    const at = (query: string) => app.inject({ method: 'GET', url: `/api/calendar${query}`, headers: { host: 'localhost:80' }, remoteAddress: '127.0.0.1' });
    // October 2026's grid: Sunday 27 September to Saturday 7 November.
    const month = (await at('?start=2026-09-27&end=2026-11-07')).json();
    expect(month).toMatchObject({ status: 'ok', range: { start: '2026-09-27', end: '2026-11-07' } });
    expect(month.events.map((e: { title: string }) => e.title)).toEqual(['End of September', 'Halloween', 'Bonfire night']);
    // Without a range: today and the next six days, as before.
    expect((await get(app)).json()).toMatchObject({ range: RANGE, events: [] });
  });

  it.each([
    ['only one end', '?start=2026-10-01'],
    ['not a date', '?start=2026-10-01&end=tomorrow'],
    ['an impossible date', '?start=2026-02-30&end=2026-03-07'],
    ['end before start', '?start=2026-10-10&end=2026-10-01'],
    ['more than 42 days', '?start=2026-10-01&end=2026-11-12'],
    ['too far ahead', '?start=2028-01-01&end=2028-01-31'],
    ['too far back', '?start=2024-01-01&end=2024-01-31'],
  ])('refuses a range with %s (400)', async (_name, query) => {
    const app = await appWith(CalendarService.fixed(null, TZ, () => NOW));
    const r = await app.inject({ method: 'GET', url: `/api/calendar${query}`, headers: { host: 'localhost:80' }, remoteAddress: '127.0.0.1' });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: 'invalid_range' });
  });
});

describe('requestedRange', () => {
  it('accepts up to 42 days within about a year of today, and means "the default" without a range', () => {
    expect(requestedRange({}, '2026-10-24')).toBeNull();
    expect(requestedRange({ start: '2026-09-27', end: '2026-11-07' }, '2026-10-24')).toEqual({ start: '2026-09-27', end: '2026-11-07' });
    expect(requestedRange({ start: '2026-10-24', end: '2026-10-24' }, '2026-10-24')).toEqual({ start: '2026-10-24', end: '2026-10-24' });
    expect(requestedRange({ start: '2027-10-31', end: '2027-11-27' }, '2026-10-24')).toEqual({ start: '2027-10-31', end: '2027-11-27' }); // a year on
    expect(requestedRange({ start: ['2026-10-01'], end: '2026-10-07' }, '2026-10-24')).toBe('invalid'); // repeated parameter
  });
});

describe('CalendarService with date ranges', () => {
  it('caches each range separately, and keeps a stale copy per range', async () => {
    const asked: string[] = [];
    let fail = false;
    let now = NOW.getTime();
    const source: CalendarSource = {
      kind: 'google',
      async listEvents(range) {
        asked.push(`${range.start}..${range.end}`);
        if (fail) throw new CalendarSourceError('unavailable', 'down');
        return { calendarName: 'Family', events: [] };
      },
    };
    const service = CalendarService.fixed(source, TZ, () => new Date(now));
    const oct = { start: '2026-09-27', end: '2026-11-07' };
    const nov = { start: '2026-11-01', end: '2026-12-05' };
    await service.upcoming(oct);
    await service.upcoming(nov);
    await service.upcoming(oct);
    await service.upcoming(nov);
    expect(asked).toEqual(['2026-09-27..2026-11-07', '2026-11-01..2026-12-05']);
    now += 6 * 60_000;
    fail = true;
    expect(await service.upcoming(oct)).toMatchObject({ status: 'ok', stale: true, range: oct });
    expect(await service.upcoming({ start: '2026-12-01', end: '2026-12-31' })).toEqual({ status: 'error', reason: 'unavailable', source: 'google' });
  });
});
