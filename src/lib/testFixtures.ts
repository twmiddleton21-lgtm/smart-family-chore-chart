import { DATA_VERSION, type FamilyData } from '../types';
import type { StorageLike } from './storage';

// Shared test helpers. Not imported by app code.

// 2026-10-12 is a Monday; 2026-10-13 a Tuesday; 2026-10-18 a Sunday.
export const MONDAY = '2026-10-12';
export const TUESDAY = '2026-10-13';
export const SUNDAY = '2026-10-18';

export function makeFamily(): FamilyData {
  return {
    version: DATA_VERSION,
    settings: { familyName: 'Test Family', parentPin: '1234', mealReminderDismissedOn: null },
    children: [
      { id: 'a', name: 'Alex', avatar: '🐼', color: 'pink' },
      { id: 'b', name: 'Bea', avatar: '🦊', color: 'teal' },
    ],
    chores: [
      { id: 'a-bed', childId: 'a', title: 'Make bed', icon: '🛏️', points: 5, period: 'morning', schedule: { type: 'daily' } },
      { id: 'a-bins', childId: 'a', title: 'Bins', icon: '♻️', points: 10, period: 'evening', schedule: { type: 'weekly', days: [1, 3] } },
      { id: 'b-bed', childId: 'b', title: 'Make bed', icon: '🛏️', points: 7, period: 'morning', schedule: { type: 'daily' } },
    ],
    rewards: [
      { id: 'r-small', name: 'Sticker', description: '', icon: '⭐', cost: 5 },
      { id: 'r-big', name: 'Park trip', description: 'Fun', icon: '🛝', cost: 50 },
    ],
    completions: [],
    redemptions: [],
    meals: [],
    foodOptions: {
      mains: [
        { id: 'fm-pizza', name: 'Pizza' },
        { id: 'fm-curry', name: 'Curry' },
      ],
      puddings: [
        { id: 'fp-jelly', name: 'Jelly' },
        { id: 'fp-yoghurt', name: 'Yoghurt' },
      ],
    },
  };
}

export class MemoryStorage implements StorageLike {
  store = new Map<string, string>();
  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.store.set(key, value);
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
}
