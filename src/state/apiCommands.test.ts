import { describe, expect, it } from 'vitest';
import { commands, recordKey } from './apiCommands';

const versions: Record<string, number> = { 'child:a': 4, 'chore:c1': 7, 'reward:r1': 2, 'mealWeek:a:2026-10-12': 9, 'settings:household': 3 };
const versionOf = (k: string) => versions[k] ?? 0;

describe('UI action -> server command mapping', () => {
  it('creates need no expectedVersion', () => {
    expect(commands.saveChild({ name: 'Sam', avatar: '🐼', color: 'teal' }, undefined, undefined, versionOf)).toEqual({
      type: 'saveChild',
      payload: { name: 'Sam', avatar: '🐼', color: 'teal' },
    });
  });

  it('edits send the version captured when the edit started, not the latest one', () => {
    const cmd = commands.saveChild({ name: 'Sam', avatar: '🐼', color: 'teal' }, 'a', 2, versionOf);
    expect(cmd).toEqual({ type: 'saveChild', payload: { id: 'a', name: 'Sam', avatar: '🐼', color: 'teal' }, expectedVersion: 2 });
  });

  it('falls back to the current version when no base version was captured', () => {
    expect(commands.deleteChild('a', undefined, versionOf).expectedVersion).toBe(4);
    expect(commands.deleteChore('c1', undefined, versionOf).expectedVersion).toBe(7);
    expect(commands.deleteReward('r1', undefined, versionOf).expectedVersion).toBe(2);
    expect(commands.updateFamilyName('X', undefined, versionOf).expectedVersion).toBe(3);
  });

  it('maps a chore schedule to the server fields', () => {
    const daily = commands.saveChore({ title: 'Bed', icon: '🛏️', childId: 'a', period: 'morning', points: 5, schedule: { type: 'daily' } }, undefined, undefined, versionOf);
    expect(daily.payload).toEqual({ title: 'Bed', icon: '🛏️', childId: 'a', period: 'morning', points: 5, scheduleType: 'daily', days: [] });
    const weekly = commands.saveChore({ title: 'Bins', icon: '♻️', childId: 'a', period: 'evening', points: 10, schedule: { type: 'weekly', days: [1, 3] } }, 'c1', 7, versionOf);
    expect(weekly).toMatchObject({ payload: { id: 'c1', scheduleType: 'weekly', days: [1, 3] }, expectedVersion: 7 });
  });

  it('meal weeks are versioned per child and week (0 for a new week)', () => {
    const rows = [{ date: '2026-10-13', main: 'Pizza', pudding: '' }];
    expect(commands.saveMealWeek('a', '2026-10-12', rows, undefined, versionOf).expectedVersion).toBe(9);
    expect(commands.saveMealWeek('b', '2026-10-12', rows, undefined, versionOf).expectedVersion).toBe(0);
    expect(recordKey.mealWeek('a', '2026-10-12')).toBe('mealWeek:a:2026-10-12');
  });

  it('never sends a PIN; settings only carry the family name', () => {
    const cmd = commands.updateFamilyName('Smiths', 3, versionOf);
    expect(cmd).toEqual({ type: 'updateSettings', payload: { familyName: 'Smiths' }, expectedVersion: 3 });
  });

  it('intent commands carry only identifiers', () => {
    expect(commands.toggleChore('c1')).toEqual({ type: 'toggleChore', payload: { choreId: 'c1' } });
    expect(commands.redeemReward('a', 'r1')).toEqual({ type: 'redeemReward', payload: { childId: 'a', rewardId: 'r1' } });
    expect(commands.removeFoodOption('main', 'f1')).toEqual({ type: 'removeFoodOption', payload: { category: 'main', id: 'f1' } });
  });
});
