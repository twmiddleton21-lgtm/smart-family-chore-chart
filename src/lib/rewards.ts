import type { DateKey, FamilyData, Redemption } from '../types';
import { createId } from './ids';
import { pointsBalance } from './points';

export type RedeemResult =
  | { ok: true; data: FamilyData; redemption: Redemption }
  | { ok: false; error: string };

export function redeemReward(
  data: FamilyData,
  childId: string,
  rewardId: string,
  date: DateKey,
  now: Date = new Date(),
): RedeemResult {
  const child = data.children.find((c) => c.id === childId);
  if (!child) return { ok: false, error: 'That profile no longer exists.' };
  const reward = data.rewards.find((r) => r.id === rewardId);
  if (!reward) return { ok: false, error: 'That reward is no longer available.' };

  const balance = pointsBalance(data, childId);
  if (balance < reward.cost) {
    return {
      ok: false,
      error: `${child.name} needs ${reward.cost - balance} more points for ${reward.name}.`,
    };
  }

  const redemption: Redemption = {
    id: createId('redeem'),
    childId,
    rewardId: reward.id,
    rewardName: reward.name,
    cost: reward.cost,
    date,
    redeemedAt: now.toISOString(),
  };
  return {
    ok: true,
    data: { ...data, redemptions: [...data.redemptions, redemption] },
    redemption,
  };
}

export function recentRedemptions(data: FamilyData, childId: string, limit = 5): Redemption[] {
  return data.redemptions
    .filter((r) => r.childId === childId)
    .sort((a, b) => b.redeemedAt.localeCompare(a.redeemedAt))
    .slice(0, limit);
}
