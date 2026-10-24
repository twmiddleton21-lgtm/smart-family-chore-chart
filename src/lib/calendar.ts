import type { DateKey } from '../types';
import { addDays, parseDateKey, weekdayOf } from './dates';

// Family calendar (read-only), as sent by the server's GET /api/calendar.
// The browser never contacts the calendar provider; the server does, with
// credentials (a Google token, or a private iCal address) only it holds.
// Dates and times are already in the household time zone. One connection
// serves the whole family (every parent and paired device).

export interface CalendarEvent {
  id: string;
  title: string;
  allDay: boolean;
  startDate: DateKey;
  /** Last day it covers (inclusive). */
  endDate: DateKey;
  startTime?: string;
  endTime?: string;
  location?: string;
}

export type CalendarErrorReason = 'auth' | 'setup' | 'access' | 'not_found' | 'feed_invalid' | 'unavailable';

/** Google OAuth, or a private iCal address. */
export type CalendarSourceKind = 'google' | 'ical';

export type CalendarResponse =
  | {
      status: 'ok';
      calendarName: string;
      timeZone: string;
      range: { start: DateKey; end: DateKey };
      events: CalendarEvent[];
      fetchedAt: string;
      stale: boolean;
      source: CalendarSourceKind;
    }
  | { status: 'not_configured' }
  | { status: 'not_connected' }
  | { status: 'error'; reason: CalendarErrorReason; source: CalendarSourceKind };

/** Where the events come from, as shown under the calendar's name. */
export const SOURCE_LABELS: Record<CalendarSourceKind, string> = {
  google: 'read-only from Google Calendar',
  ical: 'read-only from a calendar address',
};

/** An event as listed under one day. */
export interface DayEntry {
  event: CalendarEvent;
  /** "All day", "09:30 – 10:15", "From 18:00", "Until 11:00" or "Continues" (middle day). */
  when: string;
}

export interface CalendarDay {
  date: DateKey;
  entries: DayEntry[];
}

function whenOn(event: CalendarEvent, date: DateKey): string {
  if (event.allDay) return 'All day';
  const first = date === event.startDate;
  const last = date === event.endDate;
  if (first && last) return event.startTime === event.endTime ? `${event.startTime}` : `${event.startTime} – ${event.endTime}`;
  if (first) return `From ${event.startTime}`;
  if (last) return `Until ${event.endTime}`;
  return 'Continues';
}

/**
 * Every day of the range (at most six weeks), in order, each with the events
 * on it. An event that spans several days appears on each of them. All-day
 * events come first, then by start time, then by title.
 */
export function calendarDays(range: { start: DateKey; end: DateKey }, events: readonly CalendarEvent[]): CalendarDay[] {
  const days: CalendarDay[] = [];
  for (let date = range.start; date <= range.end && days.length < 42; date = addDays(date, 1)) {
    const entries = events
      .filter((e) => e.startDate <= date && e.endDate >= date)
      .map((event) => ({ event, when: whenOn(event, date) }))
      .sort((a, b) => {
        const ka = a.event.allDay || a.event.startDate < date ? '' : (a.event.startTime ?? '');
        const kb = b.event.allDay || b.event.startDate < date ? '' : (b.event.startTime ?? '');
        return ka.localeCompare(kb) || a.event.title.localeCompare(b.event.title);
      });
    days.push({ date, entries });
  }
  return days;
}

const longDay = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

/** "Today", "Tomorrow", or e.g. "Monday 26 October". */
export function dayHeading(date: DateKey, today: DateKey): { label: string; detail: string | null } {
  const d = parseDateKey(date);
  const full = d ? longDay.format(d) : date;
  if (date === today) return { label: 'Today', detail: full };
  if (date === addDays(today, 1)) return { label: 'Tomorrow', detail: full };
  return { label: full, detail: null };
}

// ---------- month view ----------

/** A calendar month, "YYYY-MM". */
export type MonthKey = string;

export const monthOf = (date: DateKey): MonthKey => date.slice(0, 7);

export function addMonths(month: MonthKey, months: number): MonthKey {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const total = y * 12 + (m - 1) + months;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

/** Months from `from` to `to` (negative if `to` is earlier). */
export function monthsBetween(from: MonthKey, to: MonthKey): number {
  const [fy, fm] = from.split('-').map(Number) as [number, number];
  const [ty, tm] = to.split('-').map(Number) as [number, number];
  return (ty - fy) * 12 + (tm - fm);
}

/** How far the month view goes from the current month (the server allows about a year either way). */
export const MONTH_VIEW_REACH = 12;

const monthName = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });

/** e.g. "October 2026". */
export function monthLabel(month: MonthKey): string {
  const d = parseDateKey(`${month}-01`);
  return d ? monthName.format(d) : month;
}

export interface MonthGrid {
  month: MonthKey;
  /** First and last day shown (inclusive): the Sunday on or before the 1st to the Saturday on or after the last day. */
  start: DateKey;
  end: DateKey;
  /** Sunday-to-Saturday rows: four to six. */
  weeks: DateKey[][];
}

/** The days a month view shows, as a conventional Sunday-to-Saturday grid including neighbouring months' days. */
export function monthGrid(month: MonthKey): MonthGrid {
  const first = `${month}-01`;
  const start = addDays(first, -weekdayOf(first));
  const last = addDays(`${addMonths(month, 1)}-01`, -1);
  const end = addDays(last, 6 - weekdayOf(last));
  const weeks: DateKey[][] = [];
  for (let day = start; day <= end; day = addDays(day, 7)) weeks.push(Array.from({ length: 7 }, (_, i) => addDays(day, i)));
  return { month, start, end, weeks };
}

const weekdayName = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const weekdayLong = new Intl.DateTimeFormat(undefined, { weekday: 'long' });

/** Sunday to Saturday, short and long names in the browser's language. */
export const WEEKDAYS: readonly { short: string; long: string }[] = Array.from({ length: 7 }, (_, i) => {
  const d = new Date(2026, 0, 4 + i); // 4 January 2026 was a Sunday
  return { short: weekdayName.format(d), long: weekdayLong.format(d) };
});

/**
 * Event colours: one per title, so a repeating event keeps its colour. Dark
 * enough for white text (contrast 4.5:1 or more), in the spirit of Google
 * Calendar's palette.
 */
const EVENT_COLOURS = ['#1a73e8', '#0b8043', '#8e24aa', '#d50000', '#3f51b5', '#c2185b', '#00796b', '#bf360c', '#5d4037', '#616161'] as const;

export function eventColour(event: Pick<CalendarEvent, 'title'>): string {
  // FNV-1a: spreads similar titles across the palette.
  let h = 0x811c9dc5;
  for (const ch of event.title) h = Math.imul(h ^ ch.codePointAt(0)!, 0x01000193) >>> 0;
  return EVENT_COLOURS[h % EVENT_COLOURS.length]!;
}

/** How an event is drawn in one day's cell of the month grid. */
export interface MonthCellEntry extends DayEntry {
  /** All-day or several days long: a filled block (otherwise a dot, the time and the title). */
  block: boolean;
  /** The event started on an earlier day / goes on to a later one (squared edge). */
  continuesBefore: boolean;
  continuesAfter: boolean;
  /** Show the title here: on its first day, and where a new week row starts. */
  showTitle: boolean;
}

/** The entries of each day in the month grid, in the order they're drawn. */
export function monthCellEntries(day: CalendarDay): MonthCellEntry[] {
  const weekStart = weekdayOf(day.date) === 0;
  return day.entries.map((entry) => {
    const { event } = entry;
    const block = event.allDay || event.startDate !== event.endDate;
    const continuesBefore = event.startDate < day.date;
    return { ...entry, block, continuesBefore, continuesAfter: event.endDate > day.date, showTitle: !continuesBefore || weekStart };
  });
}

export interface CalendarProblem {
  emoji: string;
  title: string;
  message: string;
}

/** What to tell the family when the calendar can't be shown (Google wording; see ICAL_PROBLEMS). */
export const CALENDAR_PROBLEMS: Record<CalendarErrorReason | 'not_configured' | 'not_connected' | 'unreachable', CalendarProblem> = {
  not_configured: {
    emoji: '📅',
    title: 'The family calendar isn’t set up yet',
    message: 'Whoever runs the family server needs to turn on the family calendar first. The chore chart works as normal.',
  },
  not_connected: {
    emoji: '📅',
    title: 'No calendar connected yet',
    message: 'A grown-up can connect the family’s calendar in Parent area → Settings → Integrations. It then shows here on every family device.',
  },
  auth: {
    emoji: '🔑',
    title: 'The calendar connection needs attention',
    message: 'Google no longer accepts the family’s calendar connection. It may have been removed or expired. A grown-up can reconnect it in Parent area → Settings → Integrations.',
  },
  setup: {
    emoji: '🛠️',
    title: 'The family server’s Google settings need checking',
    message: 'Google refused the server’s OAuth client. Whoever runs the family server should check its Google client ID and secret.',
  },
  access: {
    emoji: '🔒',
    title: 'Google won’t share this calendar',
    message: 'Check that the connected account can still see the chosen calendar, and that the Google Calendar API is turned on for the server’s Google Cloud project.',
  },
  not_found: {
    emoji: '🔎',
    title: 'Calendar not found',
    message: 'The chosen calendar no longer exists or was unshared. A grown-up can pick another one in Parent area → Settings → Integrations.',
  },
  feed_invalid: {
    emoji: '🧩',
    title: 'The calendar address isn’t working',
    message: 'The calendar address no longer returns a calendar. A grown-up can enter it again in Parent area → Settings → Integrations.',
  },
  unavailable: {
    emoji: '☁️',
    title: 'Can’t reach Google Calendar right now',
    message: 'This is usually a short internet problem. Try again in a few minutes.',
  },
  unreachable: {
    emoji: '📡',
    title: 'Can’t reach the family server',
    message: 'Check the network connection, then try again.',
  },
};

/** The same problems for a calendar read from a private iCal address. */
const ICAL_PROBLEMS: Partial<Record<CalendarErrorReason, CalendarProblem>> = {
  auth: {
    emoji: '🔑',
    title: 'The calendar connection needs attention',
    message: 'The family’s calendar address stopped working. It may have been reset. A grown-up can enter the current address in Parent area → Settings → Integrations.',
  },
  unavailable: {
    emoji: '☁️',
    title: 'Can’t reach the calendar right now',
    message: 'This is usually a short internet problem. Try again in a few minutes.',
  },
};

/** The message for a failed calendar answer, worded for where it comes from. */
export function calendarProblem(reason: CalendarErrorReason, source: CalendarSourceKind): CalendarProblem {
  return (source === 'ical' ? ICAL_PROBLEMS[reason] : undefined) ?? CALENDAR_PROBLEMS[reason];
}

// ---------- Settings → Integrations → Family calendar ----------

export type CalendarMethod = 'google' | 'ical';
export type ConnectionProblem = 'revoked' | 'key_changed' | 'not_configured';
export type FeedProvider = 'google' | 'microsoft' | 'apple' | 'other';

/** The active connection, described safely (for "this will replace …"). */
export interface ConnectionSummary {
  method: CalendarMethod;
  label: string;
  calendarName: string;
}

interface ConnectionViewBase {
  status: 'connected' | 'needs_reconnect';
  problem: ConnectionProblem | null;
  calendarName: string;
  connectedAt: string;
  connectedBy: string | null;
}

export type GoogleConnectionView = ConnectionViewBase & { method: 'google'; accountEmail: string; calendarId: string };
export type FeedConnectionView = ConnectionViewBase & { method: 'ical'; provider: FeedProvider; providerName: string; host: string };

/** GET /api/calendar/connection. Never contains a token or a calendar address. */
export interface CalendarConnectionStatus {
  google: { available: boolean; missing: string[]; connectOrigin: string | null };
  ical: { available: boolean; missing: string[]; extraHosts: string[] };
  connection: GoogleConnectionView | FeedConnectionView | null;
  refresh: { lastSuccessAt: string | null; lastError: CalendarErrorReason | null; lastErrorDetail: string | null };
}

/** A checked iCal address, waiting for the parent to confirm it. */
export interface FeedCheck {
  checkId: string;
  provider: FeedProvider;
  providerName: string;
  host: string;
  calendarName: string;
  upcomingEvents: number;
  replaces: ConnectionSummary | null;
}

export interface CalendarChoice {
  id: string;
  name: string;
  primary: boolean;
  selected: boolean;
}

export const CONNECTION_PROBLEMS: Record<CalendarMethod, Record<ConnectionProblem, string>> = {
  google: {
    revoked:
      'Google no longer accepts this connection. Access may have been removed in the Google account, the password changed, or the Google app is still in “Testing” (connections then expire after 7 days). Reconnect to fix it.',
    key_changed: 'The family server’s secret key changed, so the saved connection can’t be read. Reconnect to fix it.',
    not_configured: 'The family server’s Google settings were removed, so this connection can’t be used. Ask whoever runs the server, or use a calendar address instead.',
  },
  ical: {
    revoked: 'The calendar address stopped working. Enter the current address again.',
    key_changed: 'The family server’s secret key changed, so the saved address can’t be read. Enter the address again.',
    not_configured: 'The family server’s secret key is missing, so the saved address can’t be read.',
  },
};

/** Settings-card wording for the last refresh problem, by reason. */
export const REFRESH_PROBLEMS: Partial<Record<CalendarErrorReason, string>> = {
  auth: 'The provider refused the last refresh: the connection or address may have been removed or reset.',
  feed_invalid: 'The address didn’t return a usable calendar at the last refresh.',
  access: 'Google refused access to the chosen calendar at the last refresh.',
  not_found: 'The chosen calendar wasn’t found at the last refresh.',
  setup: 'Google refused the family server’s OAuth settings at the last refresh.',
  unavailable: 'The provider couldn’t be reached at the last refresh. The family sees the last good copy for today.',
};

/** Messages for the redirect back from Google (/#google-calendar=<result>). */
export const CONNECT_RESULTS: Record<string, { message: string; kind: 'success' | 'error' | 'info' }> = {
  connected: { message: 'Google Calendar connected. The whole family can now see it.', kind: 'success' },
  denied: { message: 'Google Calendar wasn’t connected: access was cancelled on Google’s page. Nothing was changed.', kind: 'info' },
  scope_missing: { message: 'Google Calendar wasn’t connected: please allow “See your calendars” on Google’s page and try again.', kind: 'error' },
  invalid_state: { message: 'That connection attempt expired or was started in another browser. Please press Connect again.', kind: 'error' },
  calendar_api: { message: 'Google refused calendar access. Check that the Google Calendar API is enabled for the server’s Google Cloud project.', kind: 'error' },
  setup: { message: 'Google refused the family server’s OAuth client. Check its client ID and secret.', kind: 'error' },
  changed: { message: 'Google Calendar wasn’t connected: another parent changed the family’s calendar meanwhile. Nothing was replaced.', kind: 'info' },
  not_configured: { message: 'Google Calendar isn’t set up on this family server.', kind: 'error' },
  failed: { message: 'Google Calendar couldn’t be connected. Please try again.', kind: 'error' },
};


export const CONNECT_RESULT_HASH = 'google-calendar';

/** Reads "#google-calendar=<result>" (after Google sends the parent back), or null. */
export function connectResultFromHash(hash: string): string | null {
  const m = /^#google-calendar=([a-z_]{1,40})$/.exec(hash);
  return m ? m[1]! : null;
}
