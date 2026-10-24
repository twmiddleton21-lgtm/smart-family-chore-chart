import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import ICAL from 'ical.js';
import { addDays, cachedFormat, CalendarSourceError, clean, zonedParts, type CalendarEvent, type CalendarSource } from './calendar';
import { FeedFetchError, safeFetchText, type SafeFetchOptions } from './safeFetch';

// The family calendar from a private iCalendar (.ics) address, as an
// alternative to Google OAuth: a parent pastes e.g. Google Calendar's
// "Secret address in iCal format". The address is a bearer secret (anyone
// holding it can read the calendar), so it is stored encrypted, never sent
// back to a browser, and never put in a log line or error message.
//
// Only addresses of known calendar providers are accepted (plus any extra
// host names the server operator lists in SFCC_CALENDAR_FEED_HOSTS), and
// they are fetched through safeFetch.ts (SSRF protections).

export type FeedProvider = 'google' | 'microsoft' | 'apple' | 'other';

interface ProviderRule {
  provider: FeedProvider;
  host: (hostname: string) => boolean;
  /** The address formats each provider publishes private feeds at. */
  path: RegExp;
}

const PROVIDERS: readonly ProviderRule[] = [
  // Google Calendar → Settings → Integrate calendar → "Secret address in iCal format"
  //   https://calendar.google.com/calendar/ical/<calendar id>/private-<key>/basic.ics
  { provider: 'google', host: (h) => h === 'calendar.google.com', path: /^\/calendar\/ical\/[^/]+\/(private-[0-9a-f]+|public)\/basic\.ics$/i },
  // Microsoft 365 → Shared calendars → Publish a calendar → ICS link
  //   https://outlook.office365.com/owa/calendar/<id>@<domain>/<key>/calendar.ics
  { provider: 'microsoft', host: (h) => h === 'outlook.office365.com', path: /^\/owa\/calendar\/[^/]+\/[^/]+\/[a-z]*calendar\.ics$/i },
  // Outlook.com: the same, and also as commonly reported with a "cid-<hex>" segment
  // (UNVERIFIED against a real account):
  //   https://outlook.live.com/owa/calendar/<id>/<key>/cid-<hex>/calendar.ics
  { provider: 'microsoft', host: (h) => h === 'outlook.live.com', path: /^\/owa\/calendar\/[^/]+\/[^/]+\/(cid-[0-9a-f]{1,32}\/)?[a-z]*calendar\.ics$/i },
  // iCloud Calendar → Share → Public calendar (webcal://pNN-caldav.icloud.com/published/2/<key>)
  { provider: 'apple', host: (h) => /^p\d{1,3}-caldav\.icloud\.com$/.test(h), path: /^\/published\/2\/[A-Za-z0-9_-]+$/ },
];

export const PROVIDER_NAMES: Record<FeedProvider, string> = {
  google: 'Google Calendar',
  microsoft: 'Outlook / Microsoft 365',
  apple: 'iCloud Calendar',
  other: 'Calendar feed',
};

export type FeedUrlProblem = 'invalid' | 'unsupported';

/** The address as given (secret), plus what may safely be shown about it. */
export interface CheckedFeedUrl {
  url: URL;
  provider: FeedProvider;
  host: string;
}

/**
 * Parse and check an address a parent typed. webcal:// (Apple's spelling)
 * is read as https://. Returns a problem code, never the address.
 */
export function checkFeedUrl(raw: string, extraHosts: readonly string[] = []): CheckedFeedUrl | { problem: FeedUrlProblem } {
  const text = raw.trim();
  if (!text || text.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(text)) return { problem: 'invalid' };
  let url: URL;
  try {
    url = new URL(text.replace(/^webcals?:\/\//i, 'https://'));
  } catch {
    return { problem: 'invalid' };
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.hash) return { problem: 'invalid' };
  url.hash = '';
  const host = url.hostname;
  const known = PROVIDERS.find((p) => p.host(host));
  if (known) return known.path.test(url.pathname) ? { url, provider: known.provider, host } : { problem: 'unsupported' };
  if (extraHosts.includes(host)) return { url, provider: 'other', host };
  return { problem: 'unsupported' };
}

/** Hosts a feed (and any redirect it makes) may be fetched from. */
export function feedHostAllowed(extraHosts: readonly string[]): (hostname: string) => boolean {
  return (hostname) => PROVIDERS.some((p) => p.host(hostname)) || extraHosts.includes(hostname);
}

// ---------- parsing ----------

// Limits. A 5 MB feed (safeFetch's limit) holds at most about 50,000
// ordinary events; parsing one that size took about 0.1 s and 55 MB.
const MAX_COMPONENTS = 50_000;
/** Occurrences stepped through per repeating event, and for the whole feed. */
const MAX_STEPS_PER_EVENT = 20_000;
const MAX_STEPS_TOTAL = 400_000;
const MAX_EVENTS_OUT = 500;
/**
 * Work allowed for one feed after ical.js has read it, checked every
 * CHECK_EVERY steps of every loop. Measured on the development PC: 20,000
 * one-off events (3.8 MB) 0.25 s; 50,000 (9.6 MB, over the size limit)
 * 0.65 s; 100 weekly series since 2015 plus 20 daily ones since 2010
 * 0.06 s. ical.js steps through about 80 occurrences per millisecond, so
 * the 400,000-step cap alone would allow about 5 s. 1.5 s is over twice the
 * largest feed that fits in 5 MB, for a slower server. The parser runs in a
 * worker thread (parseIcalFeedIsolated), so the server keeps answering
 * meanwhile; the worker's hard timeout covers a single ical.js call that
 * doesn't return.
 */
export const PARSE_BUDGET_MS = 1_500;
const CHECK_EVERY = 64;
/** More than any UTC offset (−12 to +14 hours): a cheap, never-too-strict window test on wall-clock times. */
const WALL_MARGIN_MS = 36 * 3600_000;

const pad = (n: number) => String(n).padStart(2, '0');

const zoneValid = new Map<string, boolean>();
function isTimeZone(name: string | undefined): name is string {
  if (!name) return false;
  let valid = zoneValid.get(name);
  if (valid === undefined) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: name });
      valid = true;
    } catch {
      valid = false;
    }
    if (zoneValid.size >= 256) zoneValid.clear();
    zoneValid.set(name, valid);
  }
  return valid;
}

const wallFormats = new Map<string, Intl.DateTimeFormat>();
const WALL_FORMAT: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
};

/** The wall-clock fields read as if they were UTC: within 14 hours of the real instant, whatever the zone. */
const wallMs = (t: ICAL.Time) => Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);

/** Wall-clock time in an IANA zone → instant (for a TZID without a VTIMEZONE definition). */
function wallClockInZone(t: ICAL.Time, timeZone: string): Date {
  const wall = wallMs(t);
  const format = cachedFormat(wallFormats, timeZone, WALL_FORMAT);
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const p = format.formatToParts(new Date(guess));
    const get = (type: string) => Number(p.find((x) => x.type === type)?.value);
    const shown = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    guess += wall - shown;
  }
  return new Date(guess);
}

/**
 * The instant of an iCalendar date-time: UTC and zones defined in the feed
 * (VTIMEZONE) via ical.js; a TZID the feed doesn't define, if it is an IANA
 * name, via Intl; floating times in the household time zone.
 */
function instantOf(t: ICAL.Time, tzid: string | undefined, householdZone: string): Date {
  const zone = t.zone;
  if (zone && zone !== ICAL.Timezone.localTimezone && zone.tzid !== 'floating') return t.toJSDate();
  return wallClockInZone(t, isTimeZone(tzid) ? tzid : householdZone);
}

const dateKeyOf = (t: ICAL.Time) => `${t.year}-${pad(t.month)}-${pad(t.day)}`;

function toCalendarEvent(
  idParts: string,
  item: ICAL.Event,
  start: ICAL.Time,
  end: ICAL.Time,
  tzid: string | undefined,
  timeZone: string,
): CalendarEvent | null {
  const id = createHash('sha256').update(idParts).digest('hex').slice(0, 20);
  const title = clean(item.summary) ?? '(No title)';
  const location = clean(item.location);
  let event: CalendarEvent;
  if (start.isDate) {
    const startDate = dateKeyOf(start);
    const endExclusive = end.isDate ? dateKeyOf(end) : addDays(startDate, 1);
    event = { id, title, allDay: true, startDate, endDate: endExclusive > startDate ? addDays(endExclusive, -1) : startDate };
  } else {
    const s = instantOf(start, tzid, timeZone);
    const e = instantOf(end, tzid, timeZone);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return null;
    const a = zonedParts(s, timeZone);
    const b = zonedParts(e < s ? s : e, timeZone);
    event = { id, title, allDay: false, startDate: a.date, endDate: b.date, startTime: a.time, endTime: b.time };
  }
  if (location) event.location = location;
  return event;
}

const DAY_MS = 24 * 3600_000;

/**
 * Where to start stepping through a series. Normally its DTSTART; for a
 * DAILY or WEEKLY rule that started long ago, DTSTART moved forward by whole
 * repeat periods to a few days before the window, so a daily event from 2010
 * takes a handful of steps instead of thousands. Moving by whole periods
 * (INTERVAL days or weeks, same wall-clock time) leaves every later
 * occurrence exactly as it was: same weekday, time, week phase and BY…
 * filters. Not done when the result could differ: COUNT (counted from the
 * real start), RDATE (merged from the start), several RRULEs, an INTERVAL
 * below 1, or a changed occurrence that moves the rest of the series
 * (RANGE=THISANDFUTURE). The moved start is itself always produced by the
 * expansion, so it is placed before the window, where it is dropped.
 */
function expansionStart(c: ICAL.Component, event: ICAL.Event, rule: ICAL.Recur | null, related: ICAL.Component[], durationMs: number, wallLow: number): ICAL.Time | undefined {
  if (!rule || (rule.freq !== 'DAILY' && rule.freq !== 'WEEKLY') || rule.count) return undefined;
  if (c.getAllProperties('rrule').length !== 1 || c.hasProperty('rdate')) return undefined;
  if (!Number.isInteger(rule.interval) || rule.interval < 1) return undefined;
  if (related.some((ex) => ex.getFirstProperty('recurrence-id')?.getParameter('range'))) return undefined;
  const days = (rule.freq === 'WEEKLY' ? 7 : 1) * rule.interval;
  const start = event.startDate;
  const periods = Math.floor((wallLow - 2 * DAY_MS - durationMs - wallMs(start)) / (days * DAY_MS));
  if (periods <= 0) return undefined;
  const moved = start.clone();
  moved.adjust(periods * days, 0, 0, 0);
  return moved;
}

const cancelled = (c: ICAL.Component) => String(c.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED';

/** Why a feed couldn't be read: not iCalendar, or too costly to read (limits). */
export type FeedParseProblem = 'not_ical' | 'too_complex';

export class FeedParseError extends Error {
  constructor(
    message: string,
    public readonly problem: FeedParseProblem = 'not_ical',
  ) {
    super(message);
  }
}

export interface ParsedFeed {
  calendarName: string | undefined;
  events: CalendarEvent[];
}

/**
 * Turn an iCalendar document into the app's events for `range` (inclusive
 * dates in the household time zone): repeating events are expanded
 * (RRULE, RDATE, EXDATE), moved or changed occurrences (RECURRENCE-ID)
 * replace the original, and cancelled events and occurrences are dropped.
 * Only title, times and location are kept. Throws FeedParseError if the
 * text isn't an iCalendar document or reading it exceeds the limits.
 *
 * Synchronous: for a feed from the network use parseIcalFeedIsolated, which
 * runs this in a worker thread that can be stopped.
 */
export function parseIcalFeed(
  text: string,
  timeZone: string,
  range: { start: string; end: string },
  /** TESTS ONLY: a smaller budget; `fastForward: false` always steps from DTSTART (to check that skipping ahead changes nothing). */
  { budgetMs = PARSE_BUDGET_MS, fastForward = true }: { budgetMs?: number; fastForward?: boolean } = {},
): ParsedFeed {
  const body = text.replace(/^﻿/, '');
  if (!/^\s*BEGIN:VCALENDAR\r?\n/i.test(body)) throw new FeedParseError('Not an iCalendar document.');
  let root: ICAL.Component;
  try {
    root = new ICAL.Component(ICAL.parse(body) as unknown[]);
  } catch {
    throw new FeedParseError('The iCalendar document could not be read.');
  }
  if (root.name !== 'vcalendar') throw new FeedParseError('Not an iCalendar document.');
  // ical.js caches the zones it finds, but looks for a TZID the feed doesn't
  // define (e.g. a bare IANA name) through every component again each time:
  // quadratic in the number of events. Remember misses too.
  const zoneById = root.getTimeZoneByID.bind(root);
  const zones = new Map<string, ICAL.Timezone | null>();
  root.getTimeZoneByID = (tzid: string) => {
    if (!zones.has(tzid)) zones.set(tzid, zoneById(tzid));
    return zones.get(tzid)!;
  };
  const components = root.getAllSubcomponents('vevent');
  if (components.length > MAX_COMPONENTS) throw new FeedParseError('The calendar has too many events.', 'too_complex');

  // A generous window (±14 hours covers every time zone); events are then
  // kept by their dates in the household time zone.
  const windowStart = Date.parse(`${range.start}T00:00:00Z`) - 14 * 3600_000;
  const windowEnd = Date.parse(`${addDays(range.end, 1)}T00:00:00Z`) + 14 * 3600_000;
  // The same window on wall-clock fields, widened by more than any UTC
  // offset: anything outside it is certainly outside the range, and is
  // skipped before the costly exact conversion.
  const wallLow = windowStart - WALL_MARGIN_MS;
  const wallHigh = windowEnd + WALL_MARGIN_MS;
  const mayOverlap = (start: ICAL.Time, end: ICAL.Time) => wallMs(start) <= wallHigh && Math.max(wallMs(start), wallMs(end)) >= wallLow;
  const inRange = (e: CalendarEvent) => !(e.endDate < range.start || e.startDate > range.end);
  const startedAt = performance.now();
  let checks = 0;
  /** The deadline, checked often enough inside every loop to bound the work done between checks. */
  const checkBudget = () => {
    if (++checks % CHECK_EVERY === 0 && performance.now() - startedAt > budgetMs) throw new FeedParseError('The calendar took too long to read.', 'too_complex');
  };
  let steps = 0;
  const events: CalendarEvent[] = [];

  // Changed occurrences (RECURRENCE-ID), grouped by the series they belong to.
  const exceptions = new Map<string, ICAL.Component[]>();
  for (const c of components) {
    checkBudget();
    if (!c.hasProperty('recurrence-id')) continue;
    const uid = String(c.getFirstPropertyValue('uid') ?? '');
    const list = exceptions.get(uid);
    if (list) list.push(c);
    else exceptions.set(uid, [c]);
  }
  const add = (event: CalendarEvent | null) => {
    if (event && inRange(event) && events.length < MAX_EVENTS_OUT) events.push(event);
  };

  for (const c of components) {
    checkBudget();
    const uid = String(c.getFirstPropertyValue('uid') ?? '');
    const tzid = (c.getFirstProperty('dtstart')?.getParameter('tzid') as string | undefined) ?? undefined;
    let event: ICAL.Event;
    try {
      // An explicit (empty) exception list stops ical.js scanning every event for each series.
      event = new ICAL.Event(c, { exceptions: [] });
      if (!event.startDate) continue;
    } catch {
      continue;
    }

    if (c.hasProperty('recurrence-id')) {
      // A changed occurrence: shown at its new time (its series skips it), unless cancelled.
      if (cancelled(c)) continue;
      try {
        if (mayOverlap(event.startDate, event.endDate)) add(toCalendarEvent(`${uid}|${event.recurrenceId}`, event, event.startDate, event.endDate, tzid, timeZone));
      } catch {
        /* malformed: skip it */
      }
      continue;
    }
    if (cancelled(c)) continue;

    if (!event.isRecurring()) {
      try {
        if (mayOverlap(event.startDate, event.endDate)) add(toCalendarEvent(`${uid}|${event.startDate}`, event, event.startDate, event.endDate, tzid, timeZone));
      } catch {
        /* malformed: skip it */
      }
      continue;
    }

    const rule = c.getFirstPropertyValue('rrule') as ICAL.Recur | null;
    if (rule && (rule.freq === 'SECONDLY' || rule.freq === 'MINUTELY')) continue; // never a family calendar entry; too costly to expand
    const related = exceptions.get(uid) ?? [];
    for (const ex of related) {
      try {
        event.relateException(ex);
      } catch {
        /* malformed exception: ignore it */
      }
    }
    try {
      const duration = event.duration;
      // Without changed occurrences every occurrence lasts `duration`, so one
      // that ended well before the window can be passed over cheaply.
      const durationMs = related.length === 0 ? Math.max(0, duration.toSeconds() * 1000) : null;
      const it = event.iterator(fastForward ? expansionStart(c, event, rule, related, Math.max(0, duration.toSeconds() * 1000), wallLow) : undefined);
      for (let n = 0; n < MAX_STEPS_PER_EVENT && steps < MAX_STEPS_TOTAL; n++, steps++) {
        checkBudget();
        const next = it.next();
        if (!next) break;
        const wall = wallMs(next);
        if (wall > wallHigh) break;
        if (durationMs !== null && wall + durationMs < wallLow) continue; // long over
        if (instantOf(next, tzid, timeZone).getTime() > windowEnd) break;
        const details = event.getOccurrenceDetails(next);
        // A changed occurrence is shown from its own component (above).
        if (details.item !== event && details.item.isRecurrenceException() && !details.item.modifiesFuture()) continue;
        if (cancelled(details.item.component)) continue;
        const end = details.endDate ?? next.clone();
        if (!details.endDate) end.addDuration(duration);
        if (instantOf(end, tzid, timeZone).getTime() < windowStart) continue; // long over
        add(toCalendarEvent(`${uid}|${next}`, details.item, details.startDate, end, tzid, timeZone));
      }
    } catch (error) {
      if (error instanceof FeedParseError) throw error; // over budget: the whole feed fails
      /* a broken rule: skip the series rather than the whole calendar */
    }
  }

  return { calendarName: clean(root.getFirstPropertyValue('x-wr-calname')), events };
}

// ---------- reading a feed in a worker thread ----------

/**
 * Hard limits for the worker that reads a feed from the network. The
 * deadline inside parseIcalFeed is checked between steps, so it can't stop a
 * single ical.js call that runs on: an impossible rule such as
 * FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30 made one call run for 112 s and then
 * fail allocating memory (measured). Only stopping the thread ends that, so
 * the parser runs in a worker that is terminated at PARSE_TIMEOUT_MS, with
 * a memory cap. The main thread keeps serving requests throughout.
 */
// Plus starting the worker (about 0.05 s built, 0.3 s through tsx) and
// ical.js reading 5 MB (0.1 s), with room for a slower server.
export const PARSE_TIMEOUT_MS = PARSE_BUDGET_MS + 1_500;
const WORKER_LIMITS = { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 };
/** Feeds read at once (each worker may use up to the memory cap); further ones wait. */
const MAX_WORKERS = 2;

export interface ParserWorkerOptions {
  /** The worker script. Default: icalWorker.ts beside this file (running from source, through tsx). */
  url?: URL;
  timeoutMs?: number;
}

/** Where the worker script is: the built server passes dist-server/icalWorker.js (main.ts). */
function workerScript(options: ParserWorkerOptions): { url: URL; execArgv: string[] } {
  if (options.url) return { url: options.url, execArgv: options.url.pathname.endsWith('.ts') ? ['--import', 'tsx'] : [] };
  if (!import.meta.url.endsWith('.ts')) throw new Error('The built server must pass the iCal worker script (dist-server/icalWorker.js).');
  return { url: new URL('./icalWorker.ts', import.meta.url), execArgv: ['--import', 'tsx'] };
}

let runningWorkers = 0;
const waitingForWorker: (() => void)[] = [];

async function workerSlot(): Promise<() => void> {
  if (runningWorkers >= MAX_WORKERS) await new Promise<void>((resolve) => waitingForWorker.push(resolve));
  else runningWorkers++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = waitingForWorker.shift();
    if (next) next(); // the slot passes straight to the next one waiting
    else runningWorkers--;
  };
}

/**
 * parseIcalFeed in a worker thread, stopped after `timeoutMs` (default
 * PARSE_TIMEOUT_MS) or if it exceeds its memory cap. Rejects with
 * FeedParseError ('not_ical' or 'too_complex'), or a plain Error if the
 * worker couldn't be started (a server problem, not the feed's).
 */
export async function parseIcalFeedIsolated(text: string, timeZone: string, range: { start: string; end: string }, options: ParserWorkerOptions = {}): Promise<ParsedFeed> {
  const script = workerScript(options);
  const release = await workerSlot();
  try {
    return await new Promise<ParsedFeed>((resolve, reject) => {
      const worker = new Worker(script.url, {
        workerData: { text, timeZone, range },
        execArgv: script.execArgv,
        resourceLimits: WORKER_LIMITS,
        stdout: true, // the parser writes nothing; anything it did write is dropped, not logged
        stderr: true,
      });
      worker.stdout.resume();
      worker.stderr.resume();
      let settled = false;
      const finish = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        outcome();
      };
      const timer = setTimeout(() => finish(() => reject(new FeedParseError('The calendar took too long to read.', 'too_complex'))), options.timeoutMs ?? PARSE_TIMEOUT_MS);
      worker.once('message', (message: { ok: true; feed: ParsedFeed } | { ok: false; problem: FeedParseProblem }) =>
        finish(() => (message.ok ? resolve(message.feed) : reject(new FeedParseError('The calendar could not be read.', message.problem)))),
      );
      // Out of memory is the feed's fault (the worker catches everything the
      // parser throws); any other failure means the worker itself didn't run.
      worker.once('error', (error: Error & { code?: string }) =>
        finish(() => reject(error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? new FeedParseError('The calendar is too large to read.', 'too_complex') : new Error('The iCal worker failed.'))),
      );
      worker.once('exit', () => finish(() => reject(new Error('The iCal worker stopped without an answer.'))));
    });
  } finally {
    release();
  }
}

// ---------- the calendar source ----------

export interface FeedSettings {
  /** Extra hosts allowed besides the known providers (SFCC_CALENDAR_FEED_HOSTS). */
  extraHosts: readonly string[];
  /** The parser's worker script (the built server passes its own; see main.ts). */
  parser?: ParserWorkerOptions;
  /** TESTS ONLY: network overrides (stub DNS, local server). */
  fetchOptions?: Omit<SafeFetchOptions, 'allowHost'>;
}

/** Download a feed; failures become CalendarSourceError with a reason the app can explain. */
async function fetchFeedText(url: URL, settings: FeedSettings): Promise<string> {
  try {
    return await safeFetchText(url, { ...settings.fetchOptions, allowHost: feedHostAllowed(settings.extraHosts) });
  } catch (error) {
    const failure = error instanceof FeedFetchError ? error.failure : 'unavailable';
    if (failure === 'refused' || failure === 'not_found') throw new CalendarSourceError('auth', 'The calendar address no longer works.', failure);
    if (failure === 'unavailable' || failure === 'timeout' || failure === 'rate_limited') throw new CalendarSourceError('unavailable', 'The calendar could not be fetched.', failure);
    throw new CalendarSourceError('feed_invalid', 'The calendar address can’t be used.', failure);
  }
}

/** How long a downloaded feed is reused for other date ranges (moving between months). */
export const FEED_TEXT_CACHE_MS = 2 * 60 * 1000;

/**
 * The family's last downloaded feed, so that looking at several months asks
 * the provider once rather than once per month. One entry (one connection per
 * family), kept briefly, and only for successful downloads. Forgotten when the
 * connection changes.
 */
export class FeedTextCache {
  private entry: { href: string; at: number; text: Promise<string> } | null = null;

  constructor(private readonly now: () => number) {}

  get(url: URL, settings: FeedSettings): Promise<string> {
    const e = this.entry;
    if (e && e.href === url.href && this.now() - e.at < FEED_TEXT_CACHE_MS) return e.text;
    const text = fetchFeedText(url, settings);
    const entry = { href: url.href, at: this.now(), text };
    this.entry = entry;
    // A failure isn't kept: the next request asks the provider again.
    text.catch(() => {
      if (this.entry === entry) this.entry = null;
    });
    return text;
  }

  clear(): void {
    this.entry = null;
  }
}

/** Fetch and parse a feed; failures become CalendarSourceError with a reason the app can explain. */
export async function readFeed(url: URL, timeZone: string, range: { start: string; end: string }, settings: FeedSettings, cache?: FeedTextCache) {
  const text = await (cache ? cache.get(url, settings) : fetchFeedText(url, settings));
  try {
    return await parseIcalFeedIsolated(text, timeZone, range, settings.parser);
  } catch (error) {
    if (!(error instanceof FeedParseError)) throw new CalendarSourceError('unavailable', 'The calendar could not be read.', 'parser_failed');
    if (error.problem === 'too_complex') throw new CalendarSourceError('feed_invalid', 'The calendar is too large or complex to read.', 'too_complex');
    throw new CalendarSourceError('feed_invalid', 'The address didn’t return a calendar.', 'not_ical');
  }
}

export function icalCalendarSource(options: { url: URL; fallbackName: string; settings: FeedSettings; cache?: FeedTextCache }): CalendarSource {
  return {
    kind: 'ical',
    async listEvents(range, timeZone) {
      const { calendarName, events } = await readFeed(options.url, timeZone, range, options.settings, options.cache);
      return { calendarName: calendarName ?? options.fallbackName, events };
    },
  };
}
