import { describe, expect, it } from 'vitest';
import type { FamilyData, Result } from '../types';
import { childProgress, choresForChildOn, completeChore, isChoreDone, toggleChore, uncompleteChore } from './chores';
import { addDays } from './dates';
import { saveChore } from './manage';
import { pointsBalance } from './points';
import { makeFamily, MONDAY, TUESDAY } from './testFixtures';

function ok(result: Result): FamilyData {
  if (!result.ok) throw new Error(`Expected success, got: ${result.error}`);
  return result.data;
}

const chore = (data: FamilyData, id: string) => data.chores.find((c) => c.id === id)!;

describe('completing and uncompleting chores', () => {
  it('completing a chore awards its points', () => {
    const data = ok(completeChore(makeFamily(), 'a-bed', MONDAY));
    expect(isChoreDone(data, chore(data, 'a-bed'), MONDAY)).toBe(true);
    expect(pointsBalance(data, 'a')).toBe(5);
  });

  it('completing the same chore twice does not award points twice', () => {
    let data = ok(completeChore(makeFamily(), 'a-bed', MONDAY));
    data = ok(completeChore(data, 'a-bed', MONDAY));
    data = ok(completeChore(data, 'a-bed', MONDAY));
    expect(data.completions).toHaveLength(1);
    expect(pointsBalance(data, 'a')).toBe(5);
  });

  it('uncompleting reverses exactly the points awarded', () => {
    let data = ok(completeChore(makeFamily(), 'a-bed', MONDAY));
    data = ok(completeChore(data, 'a-bins', MONDAY));
    expect(pointsBalance(data, 'a')).toBe(15);
    data = ok(uncompleteChore(data, 'a-bed', MONDAY));
    expect(pointsBalance(data, 'a')).toBe(10);
    expect(isChoreDone(data, chore(data, 'a-bed'), MONDAY)).toBe(false);
  });

  it('uncompleting a chore that is not done is a harmless no-op', () => {
    const data = ok(uncompleteChore(makeFamily(), 'a-bed', MONDAY));
    expect(pointsBalance(data, 'a')).toBe(0);
  });

  it('toggle flips between done and not done without drift', () => {
    let data = makeFamily();
    for (let i = 0; i < 9; i++) data = ok(toggleChore(data, 'a-bed', MONDAY));
    expect(isChoreDone(data, chore(data, 'a-bed'), MONDAY)).toBe(true);
    expect(pointsBalance(data, 'a')).toBe(5);
    expect(data.completions).toHaveLength(1);
  });

  it('keeps the points snapshot even if the chore value is edited later', () => {
    let data = ok(completeChore(makeFamily(), 'a-bed', MONDAY));
    data = saveChore(data, { ...chore(data, 'a-bed'), points: 50 }, 'a-bed');
    expect(pointsBalance(data, 'a')).toBe(5);
    data = ok(uncompleteChore(data, 'a-bed', MONDAY));
    expect(pointsBalance(data, 'a')).toBe(0);
  });

  it('rejects chores that are not scheduled on that day', () => {
    const result = completeChore(makeFamily(), 'a-bins', TUESDAY);
    expect(result.ok).toBe(false);
  });

  it('rejects unknown chores', () => {
    expect(completeChore(makeFamily(), 'nope', MONDAY).ok).toBe(false);
  });
});

describe('recurring availability across dates', () => {
  it('a completed daily chore is fresh again the next day', () => {
    const data = ok(completeChore(makeFamily(), 'a-bed', MONDAY));
    const tuesday = addDays(MONDAY, 1);
    expect(isChoreDone(data, chore(data, 'a-bed'), MONDAY)).toBe(true);
    expect(isChoreDone(data, chore(data, 'a-bed'), tuesday)).toBe(false);
  });

  it('completing on a new day awards points again, once', () => {
    let data = ok(completeChore(makeFamily(), 'a-bed', MONDAY));
    const tuesday = addDays(MONDAY, 1);
    data = ok(completeChore(data, 'a-bed', tuesday));
    data = ok(completeChore(data, 'a-bed', tuesday));
    expect(pointsBalance(data, 'a')).toBe(10);
  });

  it('weekly chores appear only on their days and reappear the following week', () => {
    const data = makeFamily();
    const ids = (date: string) => choresForChildOn(data, 'a', date).map((c) => c.id);
    expect(ids(MONDAY)).toContain('a-bins');
    expect(ids(TUESDAY)).not.toContain('a-bins');
    expect(ids(addDays(MONDAY, 7))).toContain('a-bins');
  });

  it('progress counts only chores scheduled that day', () => {
    let data = ok(completeChore(makeFamily(), 'a-bed', MONDAY));
    expect(childProgress(data, 'a', MONDAY)).toEqual({ done: 1, total: 2, pointsToday: 5 });
    data = ok(completeChore(data, 'a-bed', TUESDAY));
    expect(childProgress(data, 'a', TUESDAY)).toEqual({ done: 1, total: 1, pointsToday: 5 });
  });
});

describe('keeping children separate', () => {
  it("one child's completions never affect another child", () => {
    let data = ok(completeChore(makeFamily(), 'a-bed', MONDAY));
    expect(pointsBalance(data, 'a')).toBe(5);
    expect(pointsBalance(data, 'b')).toBe(0);
    expect(isChoreDone(data, chore(data, 'b-bed'), MONDAY)).toBe(false);

    data = ok(completeChore(data, 'b-bed', MONDAY));
    expect(pointsBalance(data, 'a')).toBe(5);
    expect(pointsBalance(data, 'b')).toBe(7);
    expect(childProgress(data, 'a', MONDAY).done).toBe(1);
    expect(childProgress(data, 'b', MONDAY).done).toBe(1);
  });

  it('reassigning a chore does not carry the previous child’s completion or points', () => {
    let data = ok(completeChore(makeFamily(), 'a-bed', MONDAY));
    data = saveChore(data, { ...chore(data, 'a-bed'), childId: 'b' }, 'a-bed');
    // Alex keeps the points already earned; Bea does not see it as done.
    expect(pointsBalance(data, 'a')).toBe(5);
    expect(pointsBalance(data, 'b')).toBe(0);
    expect(isChoreDone(data, chore(data, 'a-bed'), MONDAY)).toBe(false);
  });
});
