import { readFileSync } from 'node:fs';
import { todayInZone } from '../time';
import { parseIcalFeed } from './icalFeed';

// Family calendar: READ-ONLY view of one calendar, fetched by the server and
// shown to the household (signed-in parents and paired devices). It comes
// from whichever of two connections a parent set up:
// - Google OAuth: the Google Calendar API (events.list), with an access token
//   from an AccessTokenSource (below), or
// - a private iCalendar address (icalFeed.ts).
//
// The browser never contacts the provider and never sees a credential: it
// asks this server (GET /api/calendar). Only the fields the app shows are
// passed on (title, times, location); descriptions, attendees and e-mail
// addresses are never fetched from Google and are dropped from iCal feeds.
//
// The connection belongs to the household (this installation), not to a
// parent, session or device: see familyCalendar.ts.

/** One event as the app shows it. Dates and times are in the household time zone. */
export interface CalendarEvent {
  id: string;
  title: string;
  allDay: boolean;
  /** First day (YYYY-MM-DD). */
  startDate: string;
  /** Last day it covers (inclusive; for all-day events Google's exclusive end minus one day). */
  endDate: string;
  /** "HH:MM", timed events only. */
  startTime?: string;
  endTime?: string;
  location?: string;
}

export type CalendarErrorReason =
  | 'auth' // Google: the connection was revoked or expired. iCal: the address stopped working. Reconnect.
  | 'setup' // the server's own Google OAuth settings are wrong (client ID or secret)
  | 'access' // no permission to read this calendar, or the Calendar API is not enabled
  | 'not_found' // no calendar with that ID
  | 'feed_invalid' // the iCal address no longer returns a usable calendar
  | 'unavailable'; // the provider could not be reached or failed

/** Which kind of connection the events come from. */
export type CalendarSourceKind = 'google' | 'ical';

export type CalendarResponse =
  | {
      status: 'ok';
      calendarName: string;
      timeZone: string;
      /** First and last day shown (inclusive). */
      range: { start: string; end: string };
      events: CalendarEvent[];
      fetchedAt: string;
      /** True when the provider failed just now and this is the last good copy. */
      stale: boolean;
      source: CalendarSourceKind;
    }
  /** This installation can't offer a calendar connection yet (server setup). */
  | { status: 'not_configured' }
  /** Set up, but no parent has connected the family's calendar yet. */
  | { status: 'not_connected' }
  | { status: 'error'; reason: CalendarErrorReason; source: CalendarSourceKind };

export class CalendarSourceError extends Error {
  constructor(
    public readonly reason: CalendarErrorReason,
    message: string,
    /** Finer, never secret, detail for parents (e.g. "not_found", "too_large"). */
    public readonly detail?: string,
  ) {
    super(message);
  }
}

/** Where events come from: Google or an iCal feed in real use, a fixture file in development and tests. */
export interface CalendarSource {
  readonly kind: CalendarSourceKind;
  listEvents(range: { start: string; end: string }, timeZone: string): Promise<{ calendarName: string; events: CalendarEvent[] }>;
}

/**
 * Supplies a short-lived OAuth access token with the calendar.readonly scope.
 * `fresh` asks for a new one (after Google refused the current one). May
 * throw CalendarSourceError with the reason.
 */
export interface AccessTokenSource {
  getAccessToken(fresh?: boolean): Promise<string>;
}

/** The only Google permission this feature asks for: read calendars, never change them. */
export const CALENDAR_READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

/** How many days are shown, starting today. */
export const CALENDAR_DAYS = 7;
const CACHE_MS = 5 * 60 * 1000;
/** After a failure, every device gets the same answer for this long instead of asking the provider again. */
const FAILURE_CACHE_MS = 60 * 1000;
const GOOGLE_TIMEOUT_MS = 10_000;
const MAX_TEXT = 200;

// ---------- dates in the household time zone ----------

export function addDays(key: string, days: number): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * One formatter per time zone, kept: creating an Intl.DateTimeFormat costs
 * far more than using one (about 70 µs against 4 µs, measured), and feeds
 * format thousands of times. Formatters are immutable, so sharing is safe.
 * Bounded, because zone names can come from a feed.
 */
export function cachedFormat(cache: Map<string, Intl.DateTimeFormat>, timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  let format = cache.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-CA', { ...options, timeZone });
    if (cache.size >= 64) cache.clear();
    cache.set(timeZone, format);
  }
  return format;
}

const zonedFormats = new Map<string, Intl.DateTimeFormat>();

export function zonedParts(instant: Date, timeZone: string): { date: string; time: string } {
  const parts = cachedFormat(zonedFormats, timeZone, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
/** Display text: control characters removed, at most MAX_TEXT characters. */
export const clean = (text: unknown): string | undefined => {
  if (typeof text !== 'string') return undefined;
  const t = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return t ? t.slice(0, MAX_TEXT) : undefined;
};

interface GoogleTime {
  date?: string;
  dateTime?: string;
}
interface GoogleEvent {
  id?: string;
  status?: string;
  summary?: string;
  location?: string;
  start?: GoogleTime;
  end?: GoogleTime;
}

/**
 * Turn Google's events.list items into the app's events: cancelled and
 * malformed items are dropped, and every date and time is converted to the
 * household time zone. Only events overlapping the range are kept.
 */
export function normaliseGoogleEvents(items: unknown, timeZone: string, range: { start: string; end: string }): CalendarEvent[] {
  if (!Array.isArray(items)) return [];
  const events: CalendarEvent[] = [];
  for (const raw of items as GoogleEvent[]) {
    if (!raw || typeof raw !== 'object' || raw.status === 'cancelled') continue;
    const id = clean(raw.id);
    if (!id) continue;
    const title = clean(raw.summary) ?? '(No title)';
    const location = clean(raw.location);
    let event: CalendarEvent;
    if (raw.start?.date && DATE_KEY.test(raw.start.date)) {
      const endExclusive = raw.end?.date && DATE_KEY.test(raw.end.date) ? raw.end.date : addDays(raw.start.date, 1);
      const endDate = endExclusive > raw.start.date ? addDays(endExclusive, -1) : raw.start.date;
      event = { id, title, allDay: true, startDate: raw.start.date, endDate };
    } else if (raw.start?.dateTime) {
      const start = new Date(raw.start.dateTime);
      const end = raw.end?.dateTime ? new Date(raw.end.dateTime) : start;
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
      const s = zonedParts(start, timeZone);
      const e = zonedParts(end < start ? start : end, timeZone);
      event = { id, title, allDay: false, startDate: s.date, endDate: e.date, startTime: s.time, endTime: e.time };
    } else {
      continue;
    }
    if (location) event.location = location;
    if (event.endDate < range.start || event.startDate > range.end) continue;
    events.push(event);
  }
  return events;
}

// ---------- Google Calendar API ----------

const GOOGLE_API = 'https://www.googleapis.com/calendar/v3';

/** GET a Calendar API URL with a bearer token, retrying once with a fresh token after a 401. */
async function googleGet(url: string, tokens: AccessTokenSource, fetchImpl: typeof fetch): Promise<unknown> {
  for (const fresh of [false, true]) {
    let token: string;
    try {
      token = await tokens.getAccessToken(fresh);
    } catch (error) {
      if (error instanceof CalendarSourceError) throw error;
      throw new CalendarSourceError('auth', 'Could not get a Google access token.');
    }
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
      });
    } catch {
      throw new CalendarSourceError('unavailable', 'Google Calendar could not be reached.');
    }
    if (response.status === 401) {
      if (!fresh) continue;
      throw new CalendarSourceError('auth', 'Google refused the credentials.');
    }
    if (response.status === 403) throw new CalendarSourceError('access', 'No permission to read this calendar.');
    if (response.status === 404) throw new CalendarSourceError('not_found', 'Calendar not found.');
    if (!response.ok) throw new CalendarSourceError('unavailable', `Google Calendar answered ${response.status}.`);
    const body = await response.json().catch(() => null);
    if (!body || typeof body !== 'object') throw new CalendarSourceError('unavailable', 'Unexpected answer from Google Calendar.');
    return body;
  }
  throw new CalendarSourceError('auth', 'Google refused the credentials.');
}

export interface CalendarChoice {
  id: string;
  name: string;
  primary: boolean;
}

/**
 * The calendars the connected account can read events from (calendarList),
 * primary first. Free/busy-only calendars are left out.
 */
export async function listGoogleCalendars(tokens: AccessTokenSource, fetchImpl: typeof fetch = (...args) => fetch(...args)): Promise<CalendarChoice[]> {
  const params = new URLSearchParams({ minAccessRole: 'reader', maxResults: '250', fields: 'items(id,summary,summaryOverride,primary,accessRole)' });
  const body = (await googleGet(`${GOOGLE_API}/users/me/calendarList?${params}`, tokens, fetchImpl)) as { items?: unknown };
  const items = Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : [];
  return items
    .filter((c) => c && typeof c.id === 'string' && c.accessRole !== 'freeBusyReader')
    .map((c) => ({ id: (c.id as string).slice(0, 256), name: clean(c.summaryOverride) ?? clean(c.summary) ?? (c.id as string), primary: c.primary === true }))
    .sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
}

export function googleCalendarSource(options: {
  calendarId: string;
  tokens: AccessTokenSource;
  fetchImpl?: typeof fetch;
}): CalendarSource {
  const fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
  return {
    kind: 'google',
    async listEvents(range, timeZone) {
      // A generous window (±14 hours covers every time zone); events are then
      // filtered by their date in the household time zone.
      const timeMin = new Date(`${range.start}T00:00:00Z`).getTime() - 14 * 3600_000;
      const timeMax = new Date(`${addDays(range.end, 1)}T00:00:00Z`).getTime() + 14 * 3600_000;
      const params = new URLSearchParams({
        timeMin: new Date(timeMin).toISOString(),
        timeMax: new Date(timeMax).toISOString(),
        singleEvents: 'true', // expand repeating events
        orderBy: 'startTime',
        maxResults: '2500', // Google's maximum: a busy month fits in one page
        timeZone,
        fields: 'summary,items(id,status,summary,location,start,end)',
      });
      const url = `${GOOGLE_API}/calendars/${encodeURIComponent(options.calendarId)}/events?${params}`;
      const body = (await googleGet(url, options.tokens, fetchImpl)) as { summary?: unknown; items?: unknown };
      return { calendarName: clean(body.summary) ?? 'Family calendar', events: normaliseGoogleEvents(body.items, timeZone, range) };
    },
  };
}

/**
 * DEVELOPMENT AND TESTS ONLY: events from a local file, re-read on every
 * fetch: an iCalendar file (*.ics), or JSON in the shape of Google's
 * events.list answer ({ summary, items }).
 */
export function fixtureCalendarSource(file: string): CalendarSource {
  if (/\.ics$/i.test(file)) {
    return {
      kind: 'ical',
      async listEvents(range, timeZone) {
        let text: string;
        try {
          text = readFileSync(file, 'utf8');
        } catch {
          throw new CalendarSourceError('unavailable', 'Calendar fixture file could not be read.');
        }
        try {
          const { calendarName, events } = parseIcalFeed(text, timeZone, range);
          return { calendarName: calendarName ?? 'Family calendar', events };
        } catch {
          throw new CalendarSourceError('feed_invalid', 'Calendar fixture file is not iCalendar.');
        }
      },
    };
  }
  return {
    kind: 'google',
    async listEvents(range, timeZone) {
      let body: { summary?: unknown; items?: unknown; error?: unknown };
      try {
        body = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        throw new CalendarSourceError('unavailable', 'Calendar fixture file could not be read.');
      }
      // Lets tests simulate Google failing: { "error": "auth" } etc.
      if (body.error !== undefined) {
        const reason = (['auth', 'setup', 'access', 'not_found'] as const).find((r) => r === body.error) ?? 'unavailable';
        throw new CalendarSourceError(reason, 'Simulated calendar failure.');
      }
      return { calendarName: clean(body.summary) ?? 'Family calendar', events: normaliseGoogleEvents(body.items, timeZone, range) };
    },
  };
}

// ---------- service: date range, cache, last good copy ----------

/** Where the household's calendar stands right now (see familyCalendar.ts). */
export type CalendarState =
  | { kind: 'not_configured' }
  | { kind: 'not_connected' }
  /** Connected, but unusable until a parent or the operator acts (e.g. reconnect). */
  | { kind: 'problem'; reason: CalendarErrorReason; source: CalendarSourceKind }
  /** `key` changes whenever the connection or chosen calendar does. */
  | { kind: 'ready'; source: CalendarSource; key: string };

/** How the latest reads of the current connection went, for Settings. */
export interface RefreshInfo {
  /** Last successful read since the server started (or the connection changed). */
  lastSuccessAt: string | null;
  /** Why the most recent read failed, or null if it worked. */
  lastError: CalendarErrorReason | null;
  /** Finer, never secret, detail of that failure (e.g. "not_found"). */
  lastErrorDetail: string | null;
}

const NO_REFRESH = { connection: null, lastSuccessAt: null, lastError: null, lastErrorDetail: null };

type DateRange = { start: string; end: string };

/** At most this many days per request: a month view's six weeks. */
export const MAX_RANGE_DAYS = 42;
/** How far from today a requested range may reach (a year's months either way, plus their grid weeks). */
export const MAX_RANGE_DISTANCE_DAYS = 400;
/** Ranges whose answers are kept at once (current month, a few either side, the default week). */
const MAX_CACHED_RANGES = 16;

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const isDateKey = (s: unknown): s is string => typeof s === 'string' && DATE_KEY.test(s) && addDays(s, 0) === s;

/**
 * The range a request asks for (`?start=YYYY-MM-DD&end=YYYY-MM-DD`, both
 * inclusive), `null` for the default (today and the next six days), or
 * 'invalid'. Bounded so a device can't make the server read arbitrarily long
 * or distant stretches of the calendar.
 */
export function requestedRange(query: unknown, today: string): DateRange | null | 'invalid' {
  const q = (query && typeof query === 'object' ? query : {}) as Record<string, unknown>;
  if (q.start === undefined && q.end === undefined) return null;
  if (!isDateKey(q.start) || !isDateKey(q.end)) return 'invalid';
  const days = daysBetween(q.start, q.end) + 1;
  if (days < 1 || days > MAX_RANGE_DAYS) return 'invalid';
  if (Math.abs(daysBetween(today, q.start)) > MAX_RANGE_DISTANCE_DAYS || Math.abs(daysBetween(today, q.end)) > MAX_RANGE_DISTANCE_DAYS) return 'invalid';
  return { start: q.start, end: q.end };
}

/** Insert into a small map, dropping the oldest entry when full. */
function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  if (map.size >= MAX_CACHED_RANGES) map.delete(map.keys().next().value!);
  map.set(key, value);
}

export class CalendarService {
  // Per connection and date range.
  private cache = new Map<string, { response: Extract<CalendarResponse, { status: 'ok' }>; at: number }>();
  private failure = new Map<string, { response: CalendarResponse; at: number }>();
  private inFlight = new Map<string, Promise<CalendarResponse>>();
  private refreshInfo: RefreshInfo & { connection: string | null } = NO_REFRESH;

  constructor(
    private readonly state: () => CalendarState,
    private readonly timeZone: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** A service with a fixed source (development fixture, tests), or none. */
  static fixed(source: CalendarSource | null, timeZone: string, now?: () => Date): CalendarService {
    return new CalendarService(() => (source ? { kind: 'ready', source, key: 'fixed' } : { kind: 'not_configured' }), timeZone, now);
  }

  /** Forget cached events (after connecting, disconnecting or choosing another calendar). */
  invalidate(): void {
    this.cache.clear();
    this.failure.clear();
    this.inFlight.clear();
    this.refreshInfo = NO_REFRESH;
  }

  /** Today in the household time zone. */
  today(): string {
    return todayInZone(this.timeZone, this.now());
  }

  /** How the latest reads of the current connection went. */
  lastRefresh(): RefreshInfo {
    const { lastSuccessAt, lastError, lastErrorDetail } = this.refreshInfo;
    return { lastSuccessAt, lastError, lastErrorDetail };
  }

  /**
   * Events for `range` (inclusive dates; default: today and the next six
   * days). Cached per range for five minutes (a failure for one minute) and
   * shared by every device; one provider call per range at a time.
   */
  async upcoming(range?: DateRange): Promise<CalendarResponse> {
    return this.answer(range, 0);
  }

  private async answer(requested: DateRange | undefined, attempt: number): Promise<CalendarResponse> {
    const state = this.state();
    if (state.kind === 'not_configured') return { status: 'not_configured' };
    if (state.kind === 'not_connected') return { status: 'not_connected' };
    if (state.kind === 'problem') return { status: 'error', reason: state.reason, source: state.source };
    const start = requested?.start ?? this.today();
    const range = { start, end: requested?.end ?? addDays(start, CALENDAR_DAYS - 1) };
    const key = `${state.key}|${range.start}|${range.end}`;
    const now = this.now().getTime();
    const cached = this.cache.get(key);
    if (cached && now - cached.at < CACHE_MS) return cached.response;
    const failed = this.failure.get(key);
    if (failed && now - failed.at < FAILURE_CACHE_MS) return failed.response;
    let promise = this.inFlight.get(key);
    if (!promise) {
      const started = this.fetch(state.source, state.key, range, key).finally(() => {
        if (this.inFlight.get(key) === started) this.inFlight.delete(key);
      });
      this.inFlight.set(key, started);
      promise = started;
    }
    const response = await promise;
    // The connection changed (disconnected, replaced, another calendar) while
    // this was on its way: answer for the current one instead, never with
    // events from the old one. Asked again at most twice; if it keeps
    // changing, "try again" rather than an old connection's events.
    const current = this.state();
    if (current.kind === 'ready' && current.key === state.key) return response;
    return attempt < 2 ? this.answer(requested, attempt + 1) : { status: 'error', reason: 'unavailable', source: state.source.kind };
  }

  private async fetch(source: CalendarSource, connection: string, range: DateRange, key: string): Promise<CalendarResponse> {
    // A disconnect or another calendar while this was on its way: don't keep it.
    const stillCurrent = () => {
      const s = this.state();
      return s.kind === 'ready' && s.key === connection;
    };
    try {
      const { calendarName, events } = await source.listEvents(range, this.timeZone);
      const fetchedAt = this.now().toISOString();
      const response = { status: 'ok' as const, calendarName, timeZone: this.timeZone, range, events, fetchedAt, stale: false, source: source.kind };
      if (stillCurrent()) {
        remember(this.cache, key, { response, at: this.now().getTime() });
        this.failure.delete(key);
        this.refreshInfo = { connection, lastSuccessAt: fetchedAt, lastError: null, lastErrorDetail: null };
      }
      return response;
    } catch (error) {
      const reason = error instanceof CalendarSourceError ? error.reason : 'unavailable';
      // The provider is unreachable or failing: keep showing this range's last
      // good copy. A credential or permission problem is reported instead, so it gets fixed.
      const lastGood = this.cache.get(key);
      const response: CalendarResponse = reason === 'unavailable' && lastGood ? { ...lastGood.response, stale: true } : { status: 'error', reason, source: source.kind };
      if (stillCurrent()) {
        remember(this.failure, key, { response, at: this.now().getTime() });
        this.refreshInfo = {
          connection,
          lastSuccessAt: this.refreshInfo.connection === connection ? this.refreshInfo.lastSuccessAt : null,
          lastError: reason,
          lastErrorDetail: error instanceof CalendarSourceError ? (error.detail ?? null) : null,
        };
      }
      return response;
    }
  }
}
