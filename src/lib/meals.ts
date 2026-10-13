import type { DateKey, FamilyData, MealEntry, Result } from '../types';
import { addDays, weekdayOf } from './dates';
import { createId } from './ids';

// School meals: one entry per child per school day (Mon–Fri), planned up to
// six weeks ahead. Dates are local calendar date keys, like everything else.

/** How many weeks ahead parents can plan, including the current week. */
export const MEAL_WEEKS = 6;
/** Remind parents when a child's plan ends within this many days. */
export const MEAL_REMINDER_DAYS = 7;
/** Past meals older than this are discarded when a week is saved. */
export const MEAL_HISTORY_DAYS = 28;

export function isSchoolDay(date: DateKey): boolean {
  const day = weekdayOf(date);
  return day >= 1 && day <= 5;
}

/** The Monday of the week containing `date`. */
export function mondayOf(date: DateKey): DateKey {
  return addDays(date, -((weekdayOf(date) + 6) % 7));
}

/** First Monday of the planning window: this week, or next week at weekends. */
export function mealWindowStart(today: DateKey): DateKey {
  const monday = mondayOf(today);
  return isSchoolDay(today) ? monday : addDays(monday, 7);
}

/** The Mondays of the six plannable weeks. */
export function mealWeeks(today: DateKey): DateKey[] {
  const start = mealWindowStart(today);
  return Array.from({ length: MEAL_WEEKS }, (_, i) => addDays(start, i * 7));
}

/** The Friday that closes the planning window. */
export function mealWindowEnd(today: DateKey): DateKey {
  return addDays(mealWindowStart(today), (MEAL_WEEKS - 1) * 7 + 4);
}

/** Monday to Friday of the week starting on `monday`. */
export function schoolDays(monday: DateKey): DateKey[] {
  return [0, 1, 2, 3, 4].map((i) => addDays(monday, i));
}

export function mealFor(data: FamilyData, childId: string, date: DateKey): MealEntry | undefined {
  return data.meals.find((m) => m.childId === childId && m.date === date);
}

/** The latest date with a planned meal for a child, or null if none. */
export function lastPlannedDate(data: FamilyData, childId: string): DateKey | null {
  let last: DateKey | null = null;
  for (const meal of data.meals) {
    if (meal.childId === childId && (last === null || meal.date > last)) last = meal.date;
  }
  return last;
}

export interface MealReminder {
  childId: string;
  name: string;
  /** Last planned day; earlier than today means the plan has run out. */
  lastDate: DateKey;
}

/**
 * Children whose meal plan ends within MEAL_REMINDER_DAYS (or already has).
 * Children with no meals at all are not included: the family may simply not
 * use the meal planner for them.
 */
export function mealReminders(data: FamilyData, today: DateKey): MealReminder[] {
  const cutoff = addDays(today, MEAL_REMINDER_DAYS);
  const reminders: MealReminder[] = [];
  for (const child of data.children) {
    const lastDate = lastPlannedDate(data, child.id);
    if (lastDate !== null && lastDate < cutoff) {
      reminders.push({ childId: child.id, name: child.name, lastDate });
    }
  }
  return reminders;
}

export function shouldShowMealReminder(data: FamilyData, today: DateKey): boolean {
  return data.settings.mealReminderDismissedOn !== today && mealReminders(data, today).length > 0;
}

export interface MealRow {
  date: DateKey;
  main: string;
  pudding: string;
}

/**
 * Replace one child's meals for one planning week. Rows with both fields
 * empty clear that day. Text is expected to be validated already.
 * Old history beyond MEAL_HISTORY_DAYS is pruned to keep storage small.
 */
export function saveMealWeek(
  data: FamilyData,
  childId: string,
  monday: DateKey,
  rows: MealRow[],
  today: DateKey,
): Result {
  if (!data.children.some((c) => c.id === childId)) {
    return { ok: false, error: 'That profile no longer exists.' };
  }
  if (!mealWeeks(today).includes(monday)) {
    return { ok: false, error: `Meals can only be planned up to ${MEAL_WEEKS} weeks ahead.` };
  }
  const days = schoolDays(monday);
  if (rows.some((r) => !days.includes(r.date))) {
    return { ok: false, error: 'Meals can only be set for Monday to Friday of the chosen week.' };
  }

  const oldest = addDays(today, -MEAL_HISTORY_DAYS);
  const kept = data.meals.filter(
    (m) => m.date >= oldest && !(m.childId === childId && days.includes(m.date)),
  );
  const added: MealEntry[] = rows
    .filter((r) => r.main !== '' || r.pudding !== '')
    .map((r) => ({ id: createId('meal'), childId, date: r.date, main: r.main, pudding: r.pudding }));

  return { ok: true, data: { ...data, meals: [...kept, ...added].sort((a, b) => a.date.localeCompare(b.date)) } };
}

// ---------- Week editor helpers (pure, so the planner UI logic is testable) ----------

/** The five editable rows (Mon–Fri) for one child and week, from saved data. */
export function weekRows(data: FamilyData, childId: string, monday: DateKey): MealRow[] {
  return schoolDays(monday).map((date) => {
    const meal = mealFor(data, childId, date);
    return { date, main: meal?.main ?? '', pudding: meal?.pudding ?? '' };
  });
}

/**
 * Copy the previous week's choices onto the same weekdays of this week.
 * Returns null when the previous week has nothing to copy.
 */
export function copyWeekRows(current: MealRow[], previous: MealRow[]): MealRow[] | null {
  if (previous.every((r) => r.main === '' && r.pudding === '')) return null;
  return current.map((r, i) => ({ ...r, main: previous[i]?.main ?? '', pudding: previous[i]?.pudding ?? '' }));
}

/** Blank every day of the week (saving then clears those days). */
export function clearWeekRows(rows: MealRow[]): MealRow[] {
  return rows.map((r) => ({ ...r, main: '', pudding: '' }));
}

/** True when the draft differs from what is saved, i.e. there are unsaved changes. */
export function rowsDiffer(saved: MealRow[], draft: MealRow[]): boolean {
  return (
    saved.length !== draft.length ||
    saved.some((s, i) => s.date !== draft[i]!.date || s.main !== draft[i]!.main || s.pudding !== draft[i]!.pudding)
  );
}
