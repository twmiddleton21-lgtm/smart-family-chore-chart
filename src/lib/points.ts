import type { FamilyData } from '../types';

// Balances are always derived from the completion and redemption records.
// There is deliberately no stored "balance" field that could drift.

/** Chore points plus bonus awards (birthday gifts). */
export function pointsEarned(data: FamilyData, childId: string): number {
  const chores = data.completions.filter((c) => c.childId === childId).reduce((sum, c) => sum + c.points, 0);
  const bonus = (data.bonusAwards ?? []).filter((a) => a.childId === childId).reduce((sum, a) => sum + a.points, 0);
  return chores + bonus;
}

export function pointsSpent(data: FamilyData, childId: string): number {
  return data.redemptions
    .filter((r) => r.childId === childId)
    .reduce((sum, r) => sum + r.cost, 0);
}

export function pointsBalance(data: FamilyData, childId: string): number {
  return pointsEarned(data, childId) - pointsSpent(data, childId);
}
