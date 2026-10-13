import type { Child, Chore, FamilyData, Reward, Settings } from '../types';
import { createId } from './ids';

// Parent-area mutations. Inputs are expected to be validated already
// (see validation.ts). Each function returns a new FamilyData object.

export function saveChild(data: FamilyData, value: Omit<Child, 'id'>, id?: string): FamilyData {
  if (id) {
    return { ...data, children: data.children.map((c) => (c.id === id ? { ...value, id } : c)) };
  }
  return { ...data, children: [...data.children, { ...value, id: createId('child') }] };
}

/**
 * Remove a child and everything that belongs to them: chores, completions,
 * redemptions and school meals. Other children are untouched.
 */
export function deleteChild(data: FamilyData, id: string): FamilyData {
  return {
    ...data,
    children: data.children.filter((c) => c.id !== id),
    chores: data.chores.filter((c) => c.childId !== id),
    completions: data.completions.filter((c) => c.childId !== id),
    redemptions: data.redemptions.filter((r) => r.childId !== id),
    meals: data.meals.filter((m) => m.childId !== id),
  };
}

export function saveChore(data: FamilyData, value: Omit<Chore, 'id'>, id?: string): FamilyData {
  if (id) {
    return { ...data, chores: data.chores.map((c) => (c.id === id ? { ...value, id } : c)) };
  }
  return { ...data, chores: [...data.chores, { ...value, id: createId('chore') }] };
}

/**
 * Deleting a chore keeps its past completion records, so points a child has
 * already earned are not taken away.
 */
export function deleteChore(data: FamilyData, id: string): FamilyData {
  return { ...data, chores: data.chores.filter((c) => c.id !== id) };
}

export function saveReward(data: FamilyData, value: Omit<Reward, 'id'>, id?: string): FamilyData {
  if (id) {
    return { ...data, rewards: data.rewards.map((r) => (r.id === id ? { ...value, id } : r)) };
  }
  return { ...data, rewards: [...data.rewards, { ...value, id: createId('reward') }] };
}

/** Past redemptions keep their own name/cost snapshot, so history survives. */
export function deleteReward(data: FamilyData, id: string): FamilyData {
  return { ...data, rewards: data.rewards.filter((r) => r.id !== id) };
}

export function updateSettings(data: FamilyData, patch: Partial<Settings>): FamilyData {
  return { ...data, settings: { ...data.settings, ...patch } };
}
