import { describe, expect, it } from 'vitest';
import type { FamilyData, MealEntry } from '../types';
import { completeChore } from './chores';
import { addDays } from './dates';
import { deleteChild } from './manage';
import {
  MEAL_WEEKS,
  isSchoolDay,
  lastPlannedDate,
  mealFor,
  mealReminders,
  mealWeeks,
  mealWindowEnd,
  mondayOf,
  saveMealWeek,
  schoolDays,
  shouldShowMealReminder,
  weekRows,
  copyWeekRows,
  clearWeekRows,
  rowsDiffer,
} from './meals';
import { addFoodOption } from './foodOptions';
import { pointsBalance } from './points';
import { redeemReward } from './rewards';
import { makeFamily, MONDAY, SUNDAY, TUESDAY } from './testFixtures';
import { validateMealRows } from './validation';

const meal = (childId: string, date: string, main = 'Pizza', pudding = 'Jelly'): MealEntry => ({
  id: `m_${childId}_${date}`,
  childId,
  date,
  main,
  pudding,
});

function withMeals(meals: MealEntry[]): FamilyData {
  return { ...makeFamily(), meals };
}

describe('planning window', () => {
  it('knows school days and Mondays', () => {
    expect(isSchoolDay(MONDAY)).toBe(true);
    expect(isSchoolDay(SUNDAY)).toBe(false);
    expect(mondayOf(TUESDAY)).toBe(MONDAY);
    expect(mondayOf(SUNDAY)).toBe(MONDAY);
    expect(schoolDays(MONDAY)).toEqual(['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16']);
  });

  it('offers six weeks starting this week on a school day', () => {
    const weeks = mealWeeks(TUESDAY);
    expect(weeks).toHaveLength(MEAL_WEEKS);
    expect(weeks[0]).toBe(MONDAY);
    expect(weeks[5]).toBe(addDays(MONDAY, 35));
    expect(mealWindowEnd(TUESDAY)).toBe(addDays(MONDAY, 39)); // Friday of week 6
  });

  it('starts from next week at the weekend', () => {
    expect(mealWeeks(SUNDAY)[0]).toBe(addDays(MONDAY, 7));
  });
});

describe('saving a week of meals', () => {
  it('stores meals per child and day and reads them back', () => {
    const rows = schoolDays(MONDAY).map((date) => ({ date, main: `Main ${date}`, pudding: 'Yoghurt' }));
    const r = saveMealWeek(makeFamily(), 'a', MONDAY, rows, TUESDAY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(mealFor(r.data, 'a', TUESDAY)).toMatchObject({ main: `Main ${TUESDAY}`, pudding: 'Yoghurt' });
    expect(mealFor(r.data, 'b', TUESDAY)).toBeUndefined();
    expect(r.data.meals).toHaveLength(5);
  });

  it('replaces the week and clears days left blank', () => {
    let data = withMeals(schoolDays(MONDAY).map((d) => meal('a', d)));
    const rows = schoolDays(MONDAY).map((date, i) => ({ date, main: i === 0 ? 'Curry' : '', pudding: '' }));
    const r = saveMealWeek(data, 'a', MONDAY, rows, TUESDAY);
    if (!r.ok) throw new Error(r.error);
    data = r.data;
    expect(data.meals).toHaveLength(1);
    expect(mealFor(data, 'a', MONDAY)?.main).toBe('Curry');
  });

  it("does not touch another child's meals", () => {
    const data = withMeals([meal('b', TUESDAY, 'Fish')]);
    const r = saveMealWeek(data, 'a', MONDAY, [{ date: TUESDAY, main: 'Pasta', pudding: '' }], TUESDAY);
    if (!r.ok) throw new Error(r.error);
    expect(mealFor(r.data, 'b', TUESDAY)?.main).toBe('Fish');
    expect(mealFor(r.data, 'a', TUESDAY)?.main).toBe('Pasta');
  });

  it('holds a full six weeks', () => {
    let data = makeFamily();
    for (const monday of mealWeeks(TUESDAY)) {
      const r = saveMealWeek(data, 'a', monday, schoolDays(monday).map((date) => ({ date, main: 'X', pudding: 'Y' })), TUESDAY);
      if (!r.ok) throw new Error(r.error);
      data = r.data;
    }
    expect(data.meals).toHaveLength(30);
    expect(lastPlannedDate(data, 'a')).toBe(mealWindowEnd(TUESDAY));
  });

  it('rejects weeks beyond six weeks, days outside the week and unknown children', () => {
    const tooFar = addDays(MONDAY, 42);
    expect(saveMealWeek(makeFamily(), 'a', tooFar, [], TUESDAY).ok).toBe(false);
    expect(saveMealWeek(makeFamily(), 'a', MONDAY, [{ date: SUNDAY, main: 'X', pudding: '' }], TUESDAY).ok).toBe(false);
    expect(saveMealWeek(makeFamily(), 'zzz', MONDAY, [], TUESDAY).ok).toBe(false);
  });

  it('prunes meals older than four weeks when saving', () => {
    const old = addDays(MONDAY, -35);
    const data = withMeals([meal('a', old), meal('b', addDays(MONDAY, -7))]);
    const r = saveMealWeek(data, 'a', MONDAY, [{ date: MONDAY, main: 'New', pudding: '' }], TUESDAY);
    if (!r.ok) throw new Error(r.error);
    expect(r.data.meals.map((m) => m.date)).toEqual([addDays(MONDAY, -7), MONDAY]);
  });
});

describe('meal plan reminders', () => {
  it('does not remind about children with no meals at all', () => {
    expect(mealReminders(makeFamily(), TUESDAY)).toEqual([]);
  });

  it('reminds when a plan ends within 7 days', () => {
    const data = withMeals([meal('a', addDays(TUESDAY, 6)), meal('b', addDays(TUESDAY, 7))]);
    expect(mealReminders(data, TUESDAY)).toEqual([{ childId: 'a', name: 'Alex', lastDate: addDays(TUESDAY, 6) }]);
  });

  it('reminds when a plan has already run out', () => {
    const data = withMeals([meal('a', addDays(TUESDAY, -3))]);
    expect(mealReminders(data, TUESDAY)).toHaveLength(1);
  });

  it('does not remind when the plan runs well into the future', () => {
    const data = withMeals([meal('a', TUESDAY), meal('a', addDays(TUESDAY, 20))]);
    expect(mealReminders(data, TUESDAY)).toEqual([]);
  });

  it('can be dismissed for the day, and returns the next day', () => {
    const base = withMeals([meal('a', TUESDAY)]);
    expect(shouldShowMealReminder(base, TUESDAY)).toBe(true);
    const dismissed = { ...base, settings: { ...base.settings, mealReminderDismissedOn: TUESDAY } };
    expect(shouldShowMealReminder(dismissed, TUESDAY)).toBe(false);
    expect(shouldShowMealReminder(dismissed, addDays(TUESDAY, 1))).toBe(true);
  });
});

describe('meal text validation', () => {
  it('trims text and limits length', () => {
    const ok = validateMealRows([{ date: TUESDAY, main: '  Fish   pie ', pudding: '' }]);
    expect(ok).toEqual({ ok: true, value: [{ date: TUESDAY, main: 'Fish pie', pudding: '' }] });
    const bad = validateMealRows([{ date: TUESDAY, main: 'x'.repeat(61), pudding: '' }]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors[TUESDAY]).toBeTruthy();
  });
});

describe('deleting a child', () => {
  it("removes the child and all of their records, and nobody else's", () => {
    let data = withMeals([meal('a', TUESDAY), meal('b', TUESDAY)]);
    for (const id of ['a-bed', 'b-bed']) {
      const r = completeChore(data, id, MONDAY);
      if (!r.ok) throw new Error(r.error);
      data = r.data;
    }
    const spend = redeemReward(data, 'a', 'r-small', MONDAY);
    if (!spend.ok) throw new Error(spend.error);
    data = deleteChild(spend.data, 'a');

    expect(data.children.map((c) => c.id)).toEqual(['b']);
    expect(data.chores.every((c) => c.childId === 'b')).toBe(true);
    expect(data.completions.every((c) => c.childId === 'b')).toBe(true);
    expect(data.redemptions).toHaveLength(0);
    expect(data.meals.map((m) => m.childId)).toEqual(['b']);
    expect(pointsBalance(data, 'b')).toBe(7);
    expect(data.rewards).toHaveLength(2);
  });
});

describe('planner week helpers (copy, clear, unsaved changes)', () => {
  const rows = (pairs: [string, string][]) =>
    schoolDays(MONDAY).map((date, i) => ({ date, main: pairs[i]?.[0] ?? '', pudding: pairs[i]?.[1] ?? '' }));

  it('builds the five rows for a child and week from saved data, blank where unplanned', () => {
    const data = withMeals([meal('a', TUESDAY, 'Pizza', 'Jelly'), meal('b', TUESDAY, 'Curry', '')]);
    const week = weekRows(data, 'a', MONDAY);
    expect(week).toHaveLength(5);
    expect(week[0]).toEqual({ date: MONDAY, main: '', pudding: '' });
    expect(week[1]).toEqual({ date: TUESDAY, main: 'Pizza', pudding: 'Jelly' });
  });

  it('copies the previous week onto the same weekdays', () => {
    const previous = rows([['Pizza', 'Jelly'], ['', ''], ['Curry', '']]);
    const next = schoolDays(addDays(MONDAY, 7)).map((date) => ({ date, main: 'Old', pudding: 'Old' }));
    const copied = copyWeekRows(next, previous)!;
    expect(copied.map((r) => r.date)).toEqual(schoolDays(addDays(MONDAY, 7)));
    expect(copied.map((r) => [r.main, r.pudding])).toEqual([
      ['Pizza', 'Jelly'],
      ['', ''],
      ['Curry', ''],
      ['', ''],
      ['', ''],
    ]);
  });

  it('refuses to copy an empty previous week', () => {
    expect(copyWeekRows(rows([['X', 'Y']]), rows([]))).toBeNull();
  });

  it('clears every day but keeps the dates', () => {
    const cleared = clearWeekRows(rows([['Pizza', 'Jelly'], ['Curry', 'Yoghurt']]));
    expect(cleared.every((r) => r.main === '' && r.pudding === '')).toBe(true);
    expect(cleared.map((r) => r.date)).toEqual(schoolDays(MONDAY));
  });

  it('detects unsaved changes: selecting, clearing and copying all count; identical drafts do not', () => {
    const data = withMeals([meal('a', TUESDAY, 'Pizza', 'Jelly')]);
    const saved = weekRows(data, 'a', MONDAY);
    expect(rowsDiffer(saved, weekRows(data, 'a', MONDAY))).toBe(false);
    const selected = saved.map((r) => (r.date === MONDAY ? { ...r, main: 'Curry' } : r));
    expect(rowsDiffer(saved, selected)).toBe(true);
    expect(rowsDiffer(saved, clearWeekRows(saved))).toBe(true);
    // Selecting back to the saved value is no longer a change.
    const reverted = selected.map((r) => (r.date === MONDAY ? { ...r, main: '' } : r));
    expect(rowsDiffer(saved, reverted)).toBe(false);
  });

  it('after saving a draft, the saved rows equal the draft (no lingering unsaved state)', () => {
    const draft = rows([['Pizza', ''], ['', 'Jelly']]);
    const r = saveMealWeek(makeFamily(), 'a', MONDAY, draft, TUESDAY);
    if (!r.ok) throw new Error(r.error);
    expect(rowsDiffer(weekRows(r.data, 'a', MONDAY), draft)).toBe(false);
  });
});

describe('blank-day semantics and selection saving', () => {
  it('saves a chosen main and pudding for one child and date only', () => {
    const r = saveMealWeek(makeFamily(), 'b', MONDAY, [{ date: TUESDAY, main: 'Curry', pudding: 'Yoghurt' }], TUESDAY);
    if (!r.ok) throw new Error(r.error);
    expect(mealFor(r.data, 'b', TUESDAY)).toMatchObject({ main: 'Curry', pudding: 'Yoghurt' });
    expect(mealFor(r.data, 'a', TUESDAY)).toBeUndefined();
    expect(mealFor(r.data, 'b', MONDAY)).toBeUndefined();
  });

  it('keeps a day with only a main or only a pudding; drops a fully blank day', () => {
    const data = withMeals([meal('a', MONDAY, 'Pizza', 'Jelly')]);
    const r = saveMealWeek(
      data,
      'a',
      MONDAY,
      [
        { date: MONDAY, main: '', pudding: '' },
        { date: TUESDAY, main: 'Curry', pudding: '' },
        { date: addDays(MONDAY, 2), main: '', pudding: 'Jelly' },
      ],
      TUESDAY,
    );
    if (!r.ok) throw new Error(r.error);
    expect(mealFor(r.data, 'a', MONDAY)).toBeUndefined();
    expect(mealFor(r.data, 'a', TUESDAY)).toMatchObject({ main: 'Curry', pudding: '' });
    expect(mealFor(r.data, 'a', addDays(MONDAY, 2))).toMatchObject({ main: '', pudding: 'Jelly' });
  });
});

describe('meal cleanup regression (unchanged behaviour)', () => {
  it("saving one child's week also removes OTHER children's entries older than 28 days", () => {
    const tooOld = addDays(TUESDAY, -29);
    const edge = addDays(TUESDAY, -28);
    const data = withMeals([meal('b', tooOld, 'Pizza', ''), meal('b', edge, 'Curry', ''), meal('b', TUESDAY, 'Pizza', '')]);
    const r = saveMealWeek(data, 'a', MONDAY, [{ date: TUESDAY, main: 'Curry', pudding: '' }], TUESDAY);
    if (!r.ok) throw new Error(r.error);
    expect(mealFor(r.data, 'b', tooOld)).toBeUndefined(); // pruned although child b was not edited
    expect(mealFor(r.data, 'b', edge)?.main).toBe('Curry'); // exactly 28 days old is kept
    expect(mealFor(r.data, 'b', TUESDAY)?.main).toBe('Pizza');
  });

  it('nothing is pruned without a save', () => {
    const data = withMeals([meal('b', addDays(TUESDAY, -60), 'Pizza', '')]);
    expect(mealReminders(data, TUESDAY)).toHaveLength(1);
    expect(data.meals).toHaveLength(1);
  });

  it('food catalog changes never touch meals or trigger cleanup', () => {
    const old = meal('b', addDays(TUESDAY, -60), 'Pizza', '');
    const data = withMeals([old]);
    const added = addFoodOption(data, 'main', 'Fish pie');
    if (!added.ok) throw new Error(added.error);
    expect(added.data.meals).toEqual([old]);
  });
});
