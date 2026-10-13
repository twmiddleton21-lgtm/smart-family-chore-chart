import type { Chore, Completion, DateKey, FamilyData, Period, Result } from '../types';
import { isScheduledOn } from './dates';
import { createId } from './ids';
import { pointsBalance } from './points';

/** Chores assigned to a child that are scheduled on the given date. */
export function choresForChildOn(data: FamilyData, childId: string, date: DateKey): Chore[] {
  return data.chores.filter((c) => c.childId === childId && isScheduledOn(c.schedule, date));
}

export function choresByPeriod(chores: Chore[]): Record<Period, Chore[]> {
  return {
    morning: chores.filter((c) => c.period === 'morning'),
    afternoon: chores.filter((c) => c.period === 'afternoon'),
    evening: chores.filter((c) => c.period === 'evening'),
  };
}

export function findCompletion(
  data: FamilyData,
  chore: Chore,
  date: DateKey,
): Completion | undefined {
  // Match on childId too, so a chore reassigned to another child does not
  // show the previous child's completion.
  return data.completions.find(
    (c) => c.choreId === chore.id && c.childId === chore.childId && c.date === date,
  );
}

export function isChoreDone(data: FamilyData, chore: Chore, date: DateKey): boolean {
  return findCompletion(data, chore, date) !== undefined;
}

/** Mark a chore complete for a date. Completing twice never awards twice. */
export function completeChore(
  data: FamilyData,
  choreId: string,
  date: DateKey,
  now: Date = new Date(),
): Result {
  const chore = data.chores.find((c) => c.id === choreId);
  if (!chore) return { ok: false, error: 'That chore no longer exists.' };
  if (!isScheduledOn(chore.schedule, date)) {
    return { ok: false, error: 'That chore is not scheduled for today.' };
  }
  if (isChoreDone(data, chore, date)) return { ok: true, data };

  const completion: Completion = {
    id: createId('done'),
    choreId: chore.id,
    childId: chore.childId,
    date,
    points: chore.points,
    completedAt: now.toISOString(),
  };
  return { ok: true, data: { ...data, completions: [...data.completions, completion] } };
}

/** Undo a completion for a date, reversing exactly the points it awarded. */
export function uncompleteChore(data: FamilyData, choreId: string, date: DateKey): Result {
  const chore = data.chores.find((c) => c.id === choreId);
  if (!chore) return { ok: false, error: 'That chore no longer exists.' };
  const completion = findCompletion(data, chore, date);
  if (!completion) return { ok: true, data };

  // Points that have already been spent on a reward cannot be taken back,
  // otherwise the balance would go negative.
  if (pointsBalance(data, chore.childId) - completion.points < 0) {
    return {
      ok: false,
      error: 'Those points have already been spent on a reward, so this chore can’t be unticked. Ask a grown-up for help.',
    };
  }
  return {
    ok: true,
    data: { ...data, completions: data.completions.filter((c) => c.id !== completion.id) },
  };
}

export function toggleChore(
  data: FamilyData,
  choreId: string,
  date: DateKey,
  now: Date = new Date(),
): Result {
  const chore = data.chores.find((c) => c.id === choreId);
  if (!chore) return { ok: false, error: 'That chore no longer exists.' };
  return isChoreDone(data, chore, date)
    ? uncompleteChore(data, choreId, date)
    : completeChore(data, choreId, date, now);
}

export interface DayProgress {
  done: number;
  total: number;
  pointsToday: number;
}

export function childProgress(data: FamilyData, childId: string, date: DateKey): DayProgress {
  const chores = choresForChildOn(data, childId, date);
  let done = 0;
  let pointsToday = 0;
  for (const chore of chores) {
    const completion = findCompletion(data, chore, date);
    if (completion) {
      done += 1;
      pointsToday += completion.points;
    }
  }
  return { done, total: chores.length, pointsToday };
}
