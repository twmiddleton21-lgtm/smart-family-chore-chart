import type { DateKey, Schedule, Weekday } from '../types';

// All dates in the app are local calendar dates. We never use
// toISOString() for day keys because that converts to UTC and can put an
// evening completion on the wrong day.

const pad = (n: number) => String(n).padStart(2, '0');

export function toDateKey(date: Date): DateKey {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Parse a YYYY-MM-DD key into a local Date at midnight, or null if invalid. */
export function parseDateKey(key: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const date = new Date(y, m - 1, d);
  // Reject rollovers such as 2026-02-31.
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date;
}

export function isDateKey(value: unknown): value is DateKey {
  return typeof value === 'string' && parseDateKey(value) !== null;
}

export function weekdayOf(key: DateKey): Weekday {
  const date = parseDateKey(key);
  if (!date) throw new Error(`Invalid date key: ${key}`);
  return date.getDay() as Weekday;
}

/** Shift a date key by a number of calendar days (DST-safe). */
export function addDays(key: DateKey, days: number): DateKey {
  const date = parseDateKey(key);
  if (!date) throw new Error(`Invalid date key: ${key}`);
  date.setDate(date.getDate() + days);
  return toDateKey(date);
}

export function isScheduledOn(schedule: Schedule, key: DateKey): boolean {
  if (schedule.type === 'daily') return true;
  return schedule.days.includes(weekdayOf(key));
}

export const WEEKDAYS: readonly { day: Weekday; short: string; long: string }[] = [
  { day: 1, short: 'Mon', long: 'Monday' },
  { day: 2, short: 'Tue', long: 'Tuesday' },
  { day: 3, short: 'Wed', long: 'Wednesday' },
  { day: 4, short: 'Thu', long: 'Thursday' },
  { day: 5, short: 'Fri', long: 'Friday' },
  { day: 6, short: 'Sat', long: 'Saturday' },
  { day: 0, short: 'Sun', long: 'Sunday' },
];

export function describeSchedule(schedule: Schedule): string {
  if (schedule.type === 'daily') return 'Every day';
  const days = WEEKDAYS.filter((w) => schedule.days.includes(w.day));
  if (days.length === 7) return 'Every day';
  const weekdays = [1, 2, 3, 4, 5];
  if (days.length === 5 && days.every((d) => weekdays.includes(d.day))) return 'Weekdays';
  if (days.length === 2 && days.every((d) => d.day === 0 || d.day === 6)) return 'Weekends';
  return days.map((d) => d.short).join(', ');
}

export function greetingFor(date: Date): string {
  const h = date.getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}
