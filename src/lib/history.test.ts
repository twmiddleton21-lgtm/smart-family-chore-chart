import { describe, expect, it } from 'vitest';
import type { Completion, FamilyData } from '../types';
import {
  HISTORY_DAYS,
  childHistoryOn,
  clampToHistory,
  historyDayLabel,
  historyWeekLabel,
  historyWeeks,
  historyWindow,
  inHistoryWindow,
  stepHistory,
  weekDays,
} from './history';
import { addDays } from './dates';
import { pointsBalance } from './points';

function family(completions: Completion[] = []): FamilyData {
  return {
    version: 3,
    settings: { familyName: 'Test', parentPin: '1234', mealReminderDismissedOn: null },
    children: [
      { id: 'a', name: 'Alex', avatar: '🦊', color: 'teal' },
      { id: 'b', name: 'Bea', avatar: '🐼', color: 'pink' },
    ],
    chores: [
      { id: 'bed', childId: 'a', title: 'Make bed', icon: '🛏️', points: 5, period: 'morning', schedule: { type: 'daily' } },
      // Mondays and Wednesdays only.
      { id: 'bins', childId: 'a', title: 'Bins', icon: '🗑️', points: 10, period: 'evening', schedule: { type: 'weekly', days: [1, 3] } },
      { id: 'teeth', childId: 'b', title: 'Brush teeth', icon: '🪥', points: 2, period: 'evening', schedule: { type: 'daily' } },
    ],
    rewards: [],
    completions,
    redemptions: [],
    meals: [],
    foodOptions: { mains: [], puddings: [] },
  };
}

const done = (id: string, choreId: string, childId: string, date: string, points: number): Completion => ({
  id,
  choreId,
  childId,
  date,
  points,
  completedAt: `${date}T07:30:00.000Z`,
});

describe('history window', () => {
  it('covers exactly 42 calendar days ending today', () => {
    const { start, end } = historyWindow('2026-10-28');
    expect(end).toBe('2026-10-28');
    expect(start).toBe('2026-09-17');
    expect(addDays(start, HISTORY_DAYS - 1)).toBe(end);
    expect(inHistoryWindow('2026-09-17', '2026-10-28')).toBe(true);
    expect(inHistoryWindow('2026-09-16', '2026-10-28')).toBe(false);
    expect(inHistoryWindow('2026-10-29', '2026-10-28')).toBe(false); // never the future
  });

  it('moves on by calendar date across month and year boundaries (and leap days)', () => {
    expect(historyWindow('2027-01-05').start).toBe('2026-11-25');
    expect(historyWindow('2027-01-01').start).toBe('2026-11-21');
    expect(historyWindow('2028-03-01').start).toBe('2028-01-20'); // 2028 is a leap year
    expect(historyWindow('2026-03-29').start).toBe('2026-02-16'); // UK clocks change that day
    // The next day drops exactly one day from the start.
    expect(historyWindow('2027-01-01').start).toBe(addDays(historyWindow('2026-12-31').start, 1));
  });

  it('steps stay inside the window, and a selection is kept inside it when the day moves on', () => {
    const today = '2026-10-28';
    expect(stepHistory(today, 1, today)).toBeNull();
    expect(stepHistory(today, -1, today)).toBe('2026-10-27');
    expect(stepHistory('2026-09-17', -1, today)).toBeNull();
    expect(clampToHistory('2026-09-17', '2026-10-29')).toBe('2026-09-18');
    expect(clampToHistory('2026-11-02', today)).toBe(today);
    expect(clampToHistory('2026-10-01', today)).toBe('2026-10-01');
  });

  it('lists the Monday-based weeks that overlap the window, oldest first', () => {
    const weeks = historyWeeks('2026-10-28'); // a Wednesday; window starts Thu 17 Sep
    expect(weeks[0]).toBe('2026-09-14');
    expect(weeks.at(-1)).toBe('2026-10-26');
    expect(weeks).toHaveLength(7);
    expect(historyWeeks('2026-10-25')).toHaveLength(6); // a Sunday: 6 whole weeks
    expect(weekDays('2026-12-28')).toEqual(['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']);
  });

  it('labels today, yesterday and other dates', () => {
    expect(historyDayLabel('2027-01-01', '2027-01-01')).toBe('Today');
    expect(historyDayLabel('2026-12-31', '2027-01-01')).toBe('Yesterday');
    const other = historyDayLabel('2026-12-30', '2027-01-01');
    expect(other).not.toMatch(/Today|Yesterday/);
    expect(other).toContain('2026');
    expect(historyWeekLabel('2026-10-26', '2026-10-28')).toBe('This week');
    expect(historyWeekLabel('2026-10-19', '2026-10-28')).toBe('Last week');
    expect(historyWeekLabel('2026-10-12', '2026-10-28')).toMatch(/^w\/c /);
  });
});

describe('childHistoryOn', () => {
  it('shows completed and not completed chores scheduled that day, with the stored points', () => {
    // Mon 26 Oct: bed (daily) and bins (Mon/Wed) are due; bins was ticked when it was worth 8.
    const data = family([done('c1', 'bins', 'a', '2026-10-26', 8)]);
    const day = childHistoryOn(data, 'a', '2026-10-26');
    expect(day.items.map((i) => [i.title, i.done, i.points])).toEqual([
      ['Make bed', false, 5],
      ['Bins', true, 8],
    ]);
    expect(day).toMatchObject({ done: 1, total: 2, pointsEarned: 8 });
    // Tue 27 Oct: bins isn't scheduled.
    expect(childHistoryOn(data, 'a', '2026-10-27').items.map((i) => i.title)).toEqual(['Make bed']);
  });

  it('keeps completions of deleted, rescheduled or reassigned chores, and never mixes children', () => {
    const data = family([
      done('c1', 'gone', 'a', '2026-10-27', 4), // chore deleted since
      done('c2', 'bins', 'a', '2026-10-27', 10), // ticked on a Tuesday; now Mon/Wed only
      done('c3', 'teeth', 'b', '2026-10-27', 2), // Bea's
      done('c4', 'bed', 'a', '2026-10-20', 5), // another day
    ]);
    const day = childHistoryOn(data, 'a', '2026-10-27');
    expect(day.items.map((i) => [i.title, i.done])).toEqual([
      ['Make bed', false],
      ['A chore that has since been deleted', true],
      ['Bins', true],
    ]);
    expect(day.pointsEarned).toBe(14);
    expect(childHistoryOn(data, 'b', '2026-10-27')).toMatchObject({ done: 1, total: 1, pointsEarned: 2 });
  });

  it('only reads: the data and points balances are unchanged', () => {
    const data = family([done('c1', 'bed', 'a', '2026-01-01', 5), done('c2', 'bed', 'a', '2026-10-27', 5)]);
    const before = JSON.stringify(data);
    for (let d = 0; d < HISTORY_DAYS; d++) childHistoryOn(data, 'a', addDays('2026-10-28', -d));
    expect(JSON.stringify(data)).toBe(before);
    expect(pointsBalance(data, 'a')).toBe(10); // the January completion, outside the window, still counts
  });
});
