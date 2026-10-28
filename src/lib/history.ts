import type { Chore, Completion, DateKey, FamilyData, Period } from '../types';
import { choresForChildOn, findCompletion } from './chores';
import { addDays, parseDateKey } from './dates';
import { mondayOf } from './meals';

// Chore history for parents: a rolling window of the last 42 calendar days,
// today included. The window is worked out from the household's "today", so
// it moves on by calendar date, not by visits.
//
// This only reads. Completions are never removed here: points balances are
// derived from every completion (SFC-D-003), so pruning old ones would
// change them.
//
// The model stores completions, not a record of which chores were due on a
// past day. "Not done" is therefore worked out from today's chore list and
// schedules. A chore deleted since is only seen through its completions, and
// one added or rescheduled since shows as due on days it wasn't.

export const HISTORY_DAYS = 42;

export interface HistoryWindow {
  start: DateKey;
  end: DateKey;
}

export function historyWindow(today: DateKey): HistoryWindow {
  return { start: addDays(today, -(HISTORY_DAYS - 1)), end: today };
}

export function inHistoryWindow(date: DateKey, today: DateKey): boolean {
  const { start, end } = historyWindow(today);
  return date >= start && date <= end;
}

/** Keep a selected date inside the window (e.g. after midnight moves it on). */
export function clampToHistory(date: DateKey, today: DateKey): DateKey {
  const { start, end } = historyWindow(today);
  return date < start ? start : date > end ? end : date;
}

/** Move by `days` within the window; null when that would leave it. */
export function stepHistory(date: DateKey, days: number, today: DateKey): DateKey | null {
  const next = addDays(date, days);
  return inHistoryWindow(next, today) ? next : null;
}

/** Mondays of the weeks that overlap the window, oldest first (6 or 7). */
export function historyWeeks(today: DateKey): DateKey[] {
  const { start } = historyWindow(today);
  const weeks: DateKey[] = [];
  for (let monday = mondayOf(start); monday <= today; monday = addDays(monday, 7)) weeks.push(monday);
  return weeks;
}

export function weekDays(monday: DateKey): DateKey[] {
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const weekFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

const format = (f: Intl.DateTimeFormat, key: DateKey) => {
  const date = parseDateKey(key);
  return date ? f.format(date) : key;
};

/** "Today", "Yesterday", or e.g. "Monday 12 October 2026". */
export function historyDayLabel(date: DateKey, today: DateKey): string {
  if (date === today) return 'Today';
  if (date === addDays(today, -1)) return 'Yesterday';
  return format(dayFormat, date);
}

/** The full date, shown under "Today" and "Yesterday" too. */
export function historyFullDate(date: DateKey): string {
  return format(dayFormat, date);
}

export function historyWeekLabel(monday: DateKey, today: DateKey): string {
  const thisWeek = mondayOf(today);
  if (monday === thisWeek) return 'This week';
  if (monday === addDays(thisWeek, -7)) return 'Last week';
  return `w/c ${format(weekFormat, monday)}`;
}

export interface HistoryItem {
  key: string;
  /** Null when the chore has since been deleted (only its completion is left). */
  chore: Chore | null;
  title: string;
  icon: string;
  period: Period | null;
  done: boolean;
  completion: Completion | null;
  /** Points the completion awarded (its snapshot), or the chore's current points if not done. */
  points: number;
}

export interface ChildDay {
  items: HistoryItem[];
  done: number;
  total: number;
  pointsEarned: number;
}

/** One child's chores on a date: completed and not completed. */
export function childHistoryOn(data: FamilyData, childId: string, date: DateKey): ChildDay {
  const items: HistoryItem[] = [];
  const shown = new Set<string>();
  for (const chore of choresForChildOn(data, childId, date)) {
    const completion = findCompletion(data, chore, date) ?? null;
    if (completion) shown.add(completion.id);
    items.push({
      key: chore.id,
      chore,
      title: chore.title,
      icon: chore.icon,
      period: chore.period,
      done: completion !== null,
      completion,
      points: completion?.points ?? chore.points,
    });
  }
  // Completions recorded that day for chores that are gone, or that today's
  // schedule no longer puts on that day: they happened, and earned points.
  for (const completion of data.completions) {
    if (completion.childId !== childId || completion.date !== date || shown.has(completion.id)) continue;
    const chore = data.chores.find((c) => c.id === completion.choreId) ?? null;
    items.push({
      key: completion.id,
      chore,
      title: chore?.title ?? 'A chore that has since been deleted',
      icon: chore?.icon ?? '🗂️',
      period: chore?.period ?? null,
      done: true,
      completion,
      points: completion.points,
    });
  }
  const completed = items.filter((i) => i.done);
  return {
    items,
    done: completed.length,
    total: items.length,
    pointsEarned: completed.reduce((sum, i) => sum + i.points, 0),
  };
}
