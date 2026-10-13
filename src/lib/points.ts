import type { FamilyData } from '../types';

// Balances are always derived from the completion and redemption records.
// There is deliberately no stored "balance" field that could drift.

export function pointsEarned(data: FamilyData, childId: string): number {
  return data.completions
    .filter((c) => c.childId === childId)
    .reduce((sum, c) => sum + c.points, 0);
}

export function pointsSpent(data: FamilyData, childId: string): number {
  return data.redemptions
    .filter((r) => r.childId === childId)
    .reduce((sum, r) => sum + r.cost, 0);
}

export function pointsBalance(data: FamilyData, childId: string): number {
  return pointsEarned(data, childId) - pointsSpent(data, childId);
}
