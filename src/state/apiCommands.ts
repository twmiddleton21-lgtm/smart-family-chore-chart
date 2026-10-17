import type { CommandBody } from '../api/client';
import type { Child, Chore, DateKey, FoodCategory, Reward } from '../types';
import type { MealRow } from '../lib/meals';

// Pure mapping from UI actions to server commands (kept separate so it can
// be unit-tested). Edits of existing records always carry expectedVersion:
// the version the device saw when the edit started.

export const recordKey = {
  child: (id: string) => `child:${id}`,
  chore: (id: string) => `chore:${id}`,
  reward: (id: string) => `reward:${id}`,
  mealWeek: (childId: string, monday: DateKey) => `mealWeek:${childId}:${monday}`,
  settings: () => 'settings:household',
};

type VersionOf = (key: string) => number;

/** Use the version captured when the edit started, else the current one. */
function versioned(key: string, base: number | undefined, versionOf: VersionOf): number {
  return base ?? versionOf(key);
}

export const commands = {
  toggleChore: (choreId: string): CommandBody => ({ type: 'toggleChore', payload: { choreId } }),

  redeemReward: (childId: string, rewardId: string): CommandBody => ({ type: 'redeemReward', payload: { childId, rewardId } }),

  dismissMealReminder: (): CommandBody => ({ type: 'dismissMealReminder', payload: {} }),

  saveChild: (value: Omit<Child, 'id'>, id: string | undefined, base: number | undefined, versionOf: VersionOf): CommandBody =>
    id === undefined
      ? { type: 'saveChild', payload: { name: value.name, avatar: value.avatar, color: value.color } }
      : { type: 'saveChild', payload: { id, name: value.name, avatar: value.avatar, color: value.color }, expectedVersion: versioned(recordKey.child(id), base, versionOf) },

  deleteChild: (id: string, base: number | undefined, versionOf: VersionOf): CommandBody => ({
    type: 'deleteChild',
    payload: { id },
    expectedVersion: versioned(recordKey.child(id), base, versionOf),
  }),

  saveChore: (value: Omit<Chore, 'id'>, id: string | undefined, base: number | undefined, versionOf: VersionOf): CommandBody => {
    const payload: Record<string, unknown> = {
      title: value.title,
      icon: value.icon,
      childId: value.childId,
      period: value.period,
      points: value.points,
      scheduleType: value.schedule.type,
      days: value.schedule.type === 'weekly' ? value.schedule.days : [],
    };
    return id === undefined
      ? { type: 'saveChore', payload }
      : { type: 'saveChore', payload: { id, ...payload }, expectedVersion: versioned(recordKey.chore(id), base, versionOf) };
  },

  deleteChore: (id: string, base: number | undefined, versionOf: VersionOf): CommandBody => ({
    type: 'deleteChore',
    payload: { id },
    expectedVersion: versioned(recordKey.chore(id), base, versionOf),
  }),

  saveReward: (value: Omit<Reward, 'id'>, id: string | undefined, base: number | undefined, versionOf: VersionOf): CommandBody => {
    const payload = { name: value.name, description: value.description, icon: value.icon, cost: value.cost };
    return id === undefined
      ? { type: 'saveReward', payload }
      : { type: 'saveReward', payload: { id, ...payload }, expectedVersion: versioned(recordKey.reward(id), base, versionOf) };
  },

  deleteReward: (id: string, base: number | undefined, versionOf: VersionOf): CommandBody => ({
    type: 'deleteReward',
    payload: { id },
    expectedVersion: versioned(recordKey.reward(id), base, versionOf),
  }),

  saveMealWeek: (childId: string, monday: DateKey, rows: MealRow[], base: number | undefined, versionOf: VersionOf): CommandBody => ({
    type: 'saveMealWeek',
    payload: { childId, monday, rows: rows.map((r) => ({ date: r.date, main: r.main, pudding: r.pudding })) },
    expectedVersion: versioned(recordKey.mealWeek(childId, monday), base, versionOf),
  }),

  addFoodOption: (category: FoodCategory, name: string): CommandBody => ({ type: 'addFoodOption', payload: { category, name } }),

  removeFoodOption: (category: FoodCategory, id: string): CommandBody => ({ type: 'removeFoodOption', payload: { category, id } }),

  updateFamilyName: (name: string, base: number | undefined, versionOf: VersionOf): CommandBody => ({
    type: 'updateSettings',
    payload: { familyName: name },
    expectedVersion: versioned(recordKey.settings(), base, versionOf),
  }),

  loadDemoFamily: (): CommandBody => ({ type: 'loadDemoFamily', payload: {} }),
};
