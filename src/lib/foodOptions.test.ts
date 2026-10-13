import { describe, expect, it } from 'vitest';
import type { FamilyData, MealEntry } from '../types';
import { addDays } from './dates';
import {
  addFoodOption,
  deriveFoodOptions,
  foodOptionUsage,
  optionsFor,
  removeFoodOption,
  sortedOptions,
  validateFoodName,
} from './foodOptions';
import { mealFor, saveMealWeek } from './meals';
import { makeFamily, MONDAY, TUESDAY } from './testFixtures';

const meal = (childId: string, date: string, main: string, pudding: string): MealEntry => ({
  id: `m_${childId}_${date}`,
  childId,
  date,
  main,
  pudding,
});

function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`Expected success: ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}

describe('adding food options', () => {
  it('adds a main meal and a pudding to separate lists, trimmed', () => {
    let data = ok(addFoodOption(makeFamily(), 'main', '  Fish   pie ')).data;
    data = ok(addFoodOption(data, 'pudding', 'Apple crumble')).data;
    expect(optionsFor(data, 'main').map((o) => o.name)).toEqual(['Pizza', 'Curry', 'Fish pie']);
    expect(optionsFor(data, 'pudding').map((o) => o.name)).toEqual(['Jelly', 'Yoghurt', 'Apple crumble']);
  });

  it.each(['', '   ', '\t'])('rejects an empty name %j', (name) => {
    const r = addFoodOption(makeFamily(), 'main', name);
    expect(r.ok).toBe(false);
  });

  it.each(['Pizza', 'pizza', '  PIZZA  ', 'piZZa'])('rejects duplicate main %j (case and spacing ignored)', (name) => {
    const r = addFoodOption(makeFamily(), 'main', name);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/already/);
  });

  it('treats internal spacing differences as duplicates too', () => {
    const data = ok(addFoodOption(makeFamily(), 'pudding', 'Apple crumble')).data;
    expect(addFoodOption(data, 'pudding', 'apple   CRUMBLE').ok).toBe(false);
  });

  it('allows the same name in the other category', () => {
    expect(addFoodOption(makeFamily(), 'pudding', 'Pizza').ok).toBe(true);
  });

  it('rejects names over 60 characters', () => {
    expect(validateFoodName('x'.repeat(61), [], 'main').ok).toBe(false);
    expect(validateFoodName('x'.repeat(60), [], 'main').ok).toBe(true);
  });

  it('sorts options alphabetically, ignoring case', () => {
    const sorted = sortedOptions([
      { id: '1', name: 'banana' },
      { id: '2', name: 'Apple' },
      { id: '3', name: 'cherry' },
    ]);
    expect(sorted.map((o) => o.name)).toEqual(['Apple', 'banana', 'cherry']);
  });
});

describe('removing food options safely', () => {
  it('removes an option that is not planned on any day', () => {
    const data = ok(removeFoodOption(makeFamily(), 'main', 'fm-curry', TUESDAY)).data;
    expect(optionsFor(data, 'main').map((o) => o.id)).toEqual(['fm-pizza']);
  });

  it('blocks removal while the option is planned, and changes nothing', () => {
    const before: FamilyData = {
      ...makeFamily(),
      meals: [meal('a', TUESDAY, 'Pizza', 'Jelly'), meal('b', addDays(TUESDAY, 7), 'pizza', '')],
    };
    const r = removeFoodOption(before, 'main', 'fm-pizza', TUESDAY);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/2 days/);
    // Usage is found for both children, matching case-insensitively.
    expect(foodOptionUsage(before, 'main', 'Pizza', TUESDAY).map((m) => m.childId)).toEqual(['a', 'b']);
    expect(before.meals).toHaveLength(2);
    expect(optionsFor(before, 'main')).toHaveLength(2);
  });

  it('checks puddings independently of mains', () => {
    const data: FamilyData = { ...makeFamily(), meals: [meal('a', TUESDAY, 'Curry', 'Jelly')] };
    expect(removeFoodOption(data, 'pudding', 'fp-jelly', TUESDAY).ok).toBe(false);
    expect(removeFoodOption(data, 'pudding', 'fp-yoghurt', TUESDAY).ok).toBe(true);
  });

  it('ignores past history before the planning window; past meals keep their text', () => {
    const lastWeek = addDays(MONDAY, -7);
    const data: FamilyData = { ...makeFamily(), meals: [meal('a', lastWeek, 'Pizza', 'Jelly')] };
    const removed = ok(removeFoodOption(data, 'main', 'fm-pizza', TUESDAY)).data;
    expect(mealFor(removed, 'a', lastWeek)?.main).toBe('Pizza');
  });

  it('counts earlier days of the current week as planned (they are still editable)', () => {
    const data: FamilyData = { ...makeFamily(), meals: [meal('a', MONDAY, 'Pizza', '')] };
    expect(removeFoodOption(data, 'main', 'fm-pizza', TUESDAY).ok).toBe(false);
  });

  it('can be removed once the planned day is changed and saved', () => {
    let data: FamilyData = { ...makeFamily(), meals: [meal('a', TUESDAY, 'Pizza', 'Jelly')] };
    data = ok(saveMealWeek(data, 'a', MONDAY, [{ date: TUESDAY, main: 'Curry', pudding: 'Jelly' }], TUESDAY)).data;
    expect(removeFoodOption(data, 'main', 'fm-pizza', TUESDAY).ok).toBe(true);
  });

  it('reports an option that no longer exists', () => {
    expect(removeFoodOption(makeFamily(), 'main', 'missing', TUESDAY).ok).toBe(false);
  });
});

describe('deriving a catalog from existing meals (migration)', () => {
  const meals = [
    { main: 'Pizza', pudding: 'Jelly' },
    { main: 'pizza', pudding: '' },
    { main: ' Fish  fingers ', pudding: 'Jelly' },
    { main: '', pudding: 'Apple crumble' },
  ];

  it('collects unique, trimmed names per category, skipping blanks', () => {
    expect(deriveFoodOptions(meals)).toEqual({
      mains: [
        { id: 'food_main_1', name: 'Fish fingers' },
        { id: 'food_main_2', name: 'Pizza' },
      ],
      puddings: [
        { id: 'food_pudding_1', name: 'Apple crumble' },
        { id: 'food_pudding_2', name: 'Jelly' },
      ],
    });
  });

  it('is deterministic regardless of input order', () => {
    expect(deriveFoodOptions([...meals].reverse())).toEqual(deriveFoodOptions(meals));
  });
});
