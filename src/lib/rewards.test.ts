import { describe, expect, it } from 'vitest';
import type { FamilyData } from '../types';
import { completeChore, uncompleteChore } from './chores';
import { addDays } from './dates';
import { deleteChore, deleteReward } from './manage';
import { pointsBalance, pointsEarned, pointsSpent } from './points';
import { recentRedemptions, redeemReward } from './rewards';
import { makeFamily, MONDAY } from './testFixtures';

/** Give child "a" some points: 5 (bed) + 10 (bins) on Monday = 15. */
function withPoints(): FamilyData {
  let data = makeFamily();
  for (const id of ['a-bed', 'a-bins']) {
    const r = completeChore(data, id, MONDAY);
    if (!r.ok) throw new Error(r.error);
    data = r.data;
  }
  return data;
}

describe('point balance', () => {
  it('is earned minus spent, per child', () => {
    let data = withPoints();
    expect(pointsEarned(data, 'a')).toBe(15);
    const r = redeemReward(data, 'a', 'r-small', MONDAY);
    if (!r.ok) throw new Error(r.error);
    data = r.data;
    expect(pointsSpent(data, 'a')).toBe(5);
    expect(pointsBalance(data, 'a')).toBe(10);
    expect(pointsBalance(data, 'b')).toBe(0);
  });

  it('keeps earned points when a chore is deleted', () => {
    const data = deleteChore(withPoints(), 'a-bed');
    expect(pointsBalance(data, 'a')).toBe(15);
  });
});

describe('redeeming rewards', () => {
  it('deducts the reward cost and records the redemption', () => {
    const r = redeemReward(withPoints(), 'a', 'r-small', MONDAY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(pointsBalance(r.data, 'a')).toBe(10);
    expect(r.redemption).toMatchObject({ childId: 'a', rewardId: 'r-small', cost: 5, rewardName: 'Sticker', date: MONDAY });
    expect(recentRedemptions(r.data, 'a')).toHaveLength(1);
    expect(recentRedemptions(r.data, 'b')).toHaveLength(0);
  });

  it('rejects redemption when the balance is too low and changes nothing', () => {
    const before = withPoints();
    const r = redeemReward(before, 'a', 'r-big', MONDAY);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/35 more points/);
    expect(pointsBalance(before, 'a')).toBe(15);
    expect(before.redemptions).toHaveLength(0);
  });

  it('allows spending the exact balance, then rejects further spending', () => {
    let data = withPoints();
    for (let i = 0; i < 3; i++) {
      const r = redeemReward(data, 'a', 'r-small', MONDAY);
      if (!r.ok) throw new Error(r.error);
      data = r.data;
    }
    expect(pointsBalance(data, 'a')).toBe(0);
    expect(redeemReward(data, 'a', 'r-small', MONDAY).ok).toBe(false);
  });

  it('one child cannot spend another child’s points', () => {
    const r = redeemReward(withPoints(), 'b', 'r-small', MONDAY);
    expect(r.ok).toBe(false);
  });

  it('rejects unknown rewards and children', () => {
    expect(redeemReward(withPoints(), 'a', 'missing', MONDAY).ok).toBe(false);
    expect(redeemReward(withPoints(), 'zzz', 'r-small', MONDAY).ok).toBe(false);
  });

  it('keeps redemption history when the reward is later deleted', () => {
    const r = redeemReward(withPoints(), 'a', 'r-small', MONDAY);
    if (!r.ok) throw new Error(r.error);
    const data = deleteReward(r.data, 'r-small');
    expect(pointsBalance(data, 'a')).toBe(10);
    expect(recentRedemptions(data, 'a')[0]?.rewardName).toBe('Sticker');
  });
});

describe('interaction between unticking and spent points', () => {
  it('blocks unticking a chore whose points were already spent', () => {
    let data = withPoints(); // 15 points
    for (let i = 0; i < 2; i++) {
      const r = redeemReward(data, 'a', 'r-small', MONDAY);
      if (!r.ok) throw new Error(r.error);
      data = r.data;
    } // balance 5
    const blocked = uncompleteChore(data, 'a-bins', MONDAY); // would go to -5
    expect(blocked.ok).toBe(false);
    expect(pointsBalance(data, 'a')).toBe(5);

    const allowed = uncompleteChore(data, 'a-bed', MONDAY); // exactly 0
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(pointsBalance(allowed.data, 'a')).toBe(0);
  });

  it('balance never goes negative across a mixed sequence', () => {
    let data = makeFamily();
    let day = MONDAY;
    for (let i = 0; i < 14; i++) {
      const r = completeChore(data, 'a-bed', day);
      if (r.ok) data = r.data;
      const spend = redeemReward(data, 'a', 'r-small', day);
      if (spend.ok) data = spend.data;
      const undo = uncompleteChore(data, 'a-bed', day);
      if (undo.ok) data = undo.data;
      expect(pointsBalance(data, 'a')).toBeGreaterThanOrEqual(0);
      day = addDays(day, 1);
    }
  });
});
