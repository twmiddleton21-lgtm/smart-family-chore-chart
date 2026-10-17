import type { FamilyData } from '../types';

type FamilyContent = Pick<FamilyData, 'children' | 'chores' | 'rewards' | 'completions' | 'redemptions' | 'meals' | 'foodOptions'>;

/** True when the household has no family data at all (a fresh installation). */
export function isEmptyFamily(data: FamilyContent): boolean {
  return (
    data.children.length === 0 &&
    data.chores.length === 0 &&
    data.rewards.length === 0 &&
    data.completions.length === 0 &&
    data.redemptions.length === 0 &&
    data.meals.length === 0 &&
    data.foodOptions.mains.length === 0 &&
    data.foodOptions.puddings.length === 0
  );
}
