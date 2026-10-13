import type { DateKey, FamilyData, FoodCategory, FoodOption, FoodOptions, MealEntry } from '../types';
import { createId } from './ids';
import { mealWindowStart } from './meals';
import { cleanText, LIMITS } from './validation';

// The reusable catalog of school-meal choices. Planned meals store the chosen
// name as text (a snapshot), so the catalog only drives the dropdowns: it
// never rewrites existing meals.

const LIST_KEY = { main: 'mains', pudding: 'puddings' } as const satisfies Record<FoodCategory, keyof FoodOptions>;

export const FOOD_LABEL: Record<FoodCategory, { singular: string; plural: string }> = {
  main: { singular: 'main meal', plural: 'Main meals' },
  pudding: { singular: 'pudding', plural: 'Puddings' },
};

/** Comparison key: trimmed, whitespace-collapsed, case-insensitive. */
export function foodKey(name: string): string {
  return cleanText(name).toLocaleLowerCase();
}

export function optionsFor(data: FamilyData, category: FoodCategory): FoodOption[] {
  return data.foodOptions[LIST_KEY[category]];
}

/** Options sorted alphabetically for display. */
export function sortedOptions(options: FoodOption[]): FoodOption[] {
  return [...options].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

/** Validate a new option name against one category. Returns the cleaned name or an error. */
export function validateFoodName(
  name: string,
  existing: FoodOption[],
  category: FoodCategory,
): { ok: true; value: string } | { ok: false; error: string } {
  const value = cleanText(name);
  const label = FOOD_LABEL[category].singular;
  if (value === '') return { ok: false, error: `Please type a name for the ${label}.` };
  if (value.length > LIMITS.mealTextMax) {
    return { ok: false, error: `Keep the name to ${LIMITS.mealTextMax} characters or fewer.` };
  }
  const key = foodKey(value);
  const clash = existing.find((o) => foodKey(o.name) === key);
  if (clash) return { ok: false, error: `“${clash.name}” is already in the ${label} list.` };
  return { ok: true, value };
}

export type FoodResult = { ok: true; data: FamilyData } | { ok: false; error: string };

export function addFoodOption(data: FamilyData, category: FoodCategory, name: string): FoodResult {
  const list = optionsFor(data, category);
  const checked = validateFoodName(name, list, category);
  if (!checked.ok) return checked;
  const option: FoodOption = { id: createId(`food_${category}`), name: checked.value };
  return {
    ok: true,
    data: { ...data, foodOptions: { ...data.foodOptions, [LIST_KEY[category]]: [...list, option] } },
  };
}

/**
 * Planned meals that use an option: any meal on a date the planner can show
 * (from the start of the planning window onwards) whose main or pudding
 * matches the option's name, ignoring case and spacing. Older history is
 * not counted. It keeps its own text and is unaffected by removal.
 */
export function foodOptionUsage(
  data: FamilyData,
  category: FoodCategory,
  name: string,
  today: DateKey,
): MealEntry[] {
  const key = foodKey(name);
  const from = mealWindowStart(today);
  return data.meals
    .filter((m) => m.date >= from && foodKey(category === 'main' ? m.main : m.pudding) === key)
    .sort((a, b) => a.date.localeCompare(b.date) || a.childId.localeCompare(b.childId));
}

/**
 * Remove an option only if no planned meal uses it. Existing meal
 * assignments are never changed by this function.
 */
export function removeFoodOption(data: FamilyData, category: FoodCategory, id: string, today: DateKey): FoodResult {
  const list = optionsFor(data, category);
  const option = list.find((o) => o.id === id);
  if (!option) return { ok: false, error: 'That option has already been removed.' };
  const used = foodOptionUsage(data, category, option.name, today);
  if (used.length > 0) {
    return {
      ok: false,
      error: `“${option.name}” is planned on ${used.length} day${used.length === 1 ? '' : 's'}. Change those days first.`,
    };
  }
  return {
    ok: true,
    data: { ...data, foodOptions: { ...data.foodOptions, [LIST_KEY[category]]: list.filter((o) => o.id !== id) } },
  };
}

/**
 * Build a list of unique names with deterministic IDs. Names are sorted
 * alphabetically; among spellings that differ only in case, the one with
 * capitals first wins (e.g. "Pizza" over "pizza").
 */
function uniqueOptions(names: string[], category: FoodCategory): FoodOption[] {
  const sorted = names
    .map(cleanText)
    .filter((n) => n !== '')
    .sort(
      (a, b) =>
        a.localeCompare(b, 'en', { sensitivity: 'base' }) || a.localeCompare(b, 'en', { caseFirst: 'upper' }),
    );
  const seen = new Set<string>();
  const options: FoodOption[] = [];
  for (const name of sorted) {
    const key = foodKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({ id: `food_${category}_${options.length + 1}`, name });
  }
  return options;
}

/**
 * Deterministically derive a catalog from existing meal names. Used when
 * upgrading v1/v2 data so every existing assignment appears in the dropdowns.
 */
export function deriveFoodOptions(meals: Pick<MealEntry, 'main' | 'pudding'>[]): FoodOptions {
  return {
    mains: uniqueOptions(
      meals.map((m) => m.main),
      'main',
    ),
    puddings: uniqueOptions(
      meals.map((m) => m.pudding),
      'pudding',
    ),
  };
}

/** Build a catalog from plain name lists (used for the sample data). */
export function foodOptionsFromNames(mains: string[], puddings: string[]): FoodOptions {
  return { mains: uniqueOptions(mains, 'main'), puddings: uniqueOptions(puddings, 'pudding') };
}
