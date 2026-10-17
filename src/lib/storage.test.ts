import { describe, expect, it } from 'vitest';
import { completeChore } from './chores';
import { pointsBalance } from './points';
import { redeemReward } from './rewards';
import { BACKUP_KEY, STORAGE_KEY, loadData, parseFamilyData, resetData, saveData } from './storage';
import { makeFamily, MemoryStorage, MONDAY } from './testFixtures';

describe('first run', () => {
  it('initialises sample data and saves it', () => {
    const storage = new MemoryStorage();
    const { data, status } = loadData(storage, MONDAY);
    expect(status).toBe('new');
    expect(data.children.length).toBeGreaterThan(0);
    expect(data.chores.length).toBeGreaterThan(0);
    expect(data.rewards.length).toBeGreaterThan(0);
    expect(storage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it('sample data is internally valid', () => {
    const storage = new MemoryStorage();
    const { data } = loadData(storage, MONDAY);
    const parsed = parseFamilyData(JSON.parse(JSON.stringify(data)));
    expect(parsed?.repaired).toBe(false);
  });
});

describe('persistence across reloads', () => {
  it('restores completions, points and redemptions exactly', () => {
    const storage = new MemoryStorage();
    let data = makeFamily();
    const c = completeChore(data, 'a-bed', MONDAY);
    if (!c.ok) throw new Error(c.error);
    data = c.data;
    const r = redeemReward(data, 'a', 'r-small', MONDAY);
    if (!r.ok) throw new Error(r.error);
    data = r.data;
    expect(saveData(storage, data)).toBe(true);

    // Simulate a page reload.
    const reloaded = loadData(storage, MONDAY);
    expect(reloaded.status).toBe('loaded');
    expect(reloaded.data).toEqual(data);
    expect(pointsBalance(reloaded.data, 'a')).toBe(0);
  });

  it('does not overwrite existing valid data on startup', () => {
    const storage = new MemoryStorage();
    const data = { ...makeFamily(), settings: { familyName: 'Keep Me', parentPin: '9876', mealReminderDismissedOn: null } };
    saveData(storage, data);
    const before = storage.getItem(STORAGE_KEY);
    const loaded = loadData(storage, MONDAY);
    expect(loaded.data.settings.familyName).toBe('Keep Me');
    expect(storage.getItem(STORAGE_KEY)).toBe(before);
  });
});

describe('malformed or incompatible data', () => {
  it('recovers from invalid JSON and keeps a backup of the raw value', () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, '{not json');
    const { data, status } = loadData(storage, MONDAY);
    expect(status).toBe('recovered');
    expect(data.children.length).toBeGreaterThan(0);
    expect(storage.getItem(BACKUP_KEY)).toBe('{not json');
  });

  it('upgrades version 1 data without losing anything', () => {
    const storage = new MemoryStorage();
    const c = completeChore(makeFamily(), 'a-bed', MONDAY);
    if (!c.ok) throw new Error(c.error);
    // Shape of data saved by v0.1.0: no meals, no reminder setting.
    const { meals: _meals, ...rest } = c.data;
    const v1 = { ...rest, version: 1, settings: { familyName: 'Test Family', parentPin: '4321' } };
    storage.setItem(STORAGE_KEY, JSON.stringify(v1));

    const { data, status } = loadData(storage, MONDAY);
    expect(status).toBe('loaded');
    expect(data.version).toBe(3);
    expect(data.meals).toEqual([]);
    expect(data.foodOptions).toEqual({ mains: [], puddings: [] });
    expect(data.settings).toEqual({ familyName: 'Test Family', parentPin: '4321', mealReminderDismissedOn: null });
    expect(pointsBalance(data, 'a')).toBe(5);
    expect(storage.getItem(BACKUP_KEY)).toBeNull();
    // The upgraded data was saved back.
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!).version).toBe(3);
  });

  it('upgrades version 0.2.0 (v2) data: meals kept exactly, catalog built from their names', () => {
    const storage = new MemoryStorage();
    const { foodOptions: _drop, ...rest } = makeFamily();
    const v2Meals = [
      { id: 'm1', childId: 'a', date: MONDAY, main: 'Roast chicken dinner', pudding: 'Apple crumble & custard' },
      { id: 'm2', childId: 'b', date: MONDAY, main: 'Fish fingers & chips', pudding: '' },
      { id: 'm3', childId: 'b', date: '2026-10-13', main: '', pudding: 'Jelly' },
    ];
    const v2 = { ...rest, version: 2, meals: v2Meals };
    storage.setItem(STORAGE_KEY, JSON.stringify(v2));

    const { data, status } = loadData(storage, MONDAY);
    expect(status).toBe('loaded');
    expect(data.version).toBe(3);
    expect(data.meals).toEqual(v2Meals);
    expect(data.foodOptions.mains.map((o) => o.name)).toEqual(['Fish fingers & chips', 'Roast chicken dinner']);
    expect(data.foodOptions.puddings.map((o) => o.name)).toEqual(['Apple crumble & custard', 'Jelly']);
    expect(data.children).toEqual(rest.children);
    expect(storage.getItem(BACKUP_KEY)).toBeNull();
    expect(JSON.parse(storage.getItem(STORAGE_KEY)!).version).toBe(3);

    // Loading the upgraded data again changes nothing (stable, deterministic).
    const again = loadData(storage, MONDAY);
    expect(again.status).toBe('loaded');
    expect(again.data).toEqual(data);
  });

  it('persists the food catalog across reloads', () => {
    const storage = new MemoryStorage();
    const family = makeFamily();
    family.foodOptions.mains.push({ id: 'fm-new', name: 'Fish pie' });
    saveData(storage, family);
    expect(loadData(storage, MONDAY).data.foodOptions).toEqual(family.foodOptions);
  });

  it('drops invalid and duplicate food options (case-insensitive) and reports a repair', () => {
    const family = makeFamily();
    const raw = {
      ...family,
      foodOptions: {
        mains: [
          { id: 'x1', name: 'Pizza' },
          { id: 'x2', name: 'PIZZA ' },
          { id: 'x3', name: '' },
          { id: 'x1', name: 'Duplicate id' },
          { id: 'x4', name: 42 },
        ],
        puddings: 'not a list',
      },
    };
    const parsed = parseFamilyData(raw);
    expect(parsed?.repaired).toBe(true);
    expect(parsed?.data.foodOptions).toEqual({ mains: [{ id: 'x1', name: 'Pizza' }], puddings: [] });
  });

  it('treats version 3 data without a food catalog as unreadable', () => {
    const { foodOptions: _drop, ...rest } = makeFamily();
    expect(parseFamilyData(rest)).toBeNull();
  });

  it('drops invalid or duplicate meals and meals for unknown children', () => {
    const family = makeFamily();
    const raw = {
      ...family,
      meals: [
        { id: 'm1', childId: 'a', date: MONDAY, main: 'Pizza', pudding: 'Jelly' },
        { id: 'm2', childId: 'a', date: MONDAY, main: 'Duplicate', pudding: '' },
        { id: 'm3', childId: 'ghost', date: MONDAY, main: 'Pizza', pudding: '' },
        { id: 'm4', childId: 'b', date: 'not-a-date', main: 'Pizza', pudding: '' },
        { id: 'm5', childId: 'b', date: MONDAY, main: 42, pudding: '' },
      ],
    };
    const parsed = parseFamilyData(raw);
    expect(parsed?.repaired).toBe(true);
    expect(parsed?.data.meals.map((m) => m.id)).toEqual(['m1']);
  });

  it('recovers from an incompatible version', () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, JSON.stringify({ ...makeFamily(), version: 99 }));
    expect(loadData(storage, MONDAY).status).toBe('recovered');
  });

  it('recovers from the wrong top-level shape', () => {
    for (const bad of ['null', '[]', '42', '"hello"', JSON.stringify({ version: 1 })]) {
      const storage = new MemoryStorage();
      storage.setItem(STORAGE_KEY, bad);
      expect(loadData(storage, MONDAY).status).toBe('recovered');
    }
  });

  it('drops individual invalid records but keeps the rest', () => {
    const family = makeFamily();
    const tampered = {
      ...family,
      children: [...family.children, { id: 'x', name: '', avatar: '🙂', color: 'pink' }],
      chores: [
        ...family.chores,
        { id: 'bad-points', childId: 'a', title: 'Bad', icon: '❌', points: -5, period: 'morning', schedule: { type: 'daily' } },
        { id: 'bad-period', childId: 'a', title: 'Bad', icon: '❌', points: 5, period: 'midnight', schedule: { type: 'daily' } },
        { id: 'orphan', childId: 'ghost', title: 'Orphan', icon: '👻', points: 5, period: 'morning', schedule: { type: 'daily' } },
      ],
      completions: [
        { id: 'c1', choreId: 'a-bed', childId: 'a', date: MONDAY, points: 5, completedAt: new Date().toISOString() },
        { id: 'c2', choreId: 'a-bed', childId: 'a', date: MONDAY, points: 5, completedAt: new Date().toISOString() },
        { id: 'c3', choreId: 'a-bed', childId: 'a', date: 'yesterday', points: 5, completedAt: new Date().toISOString() },
      ],
    };
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEY, JSON.stringify(tampered));
    const { data, status } = loadData(storage, MONDAY);
    expect(status).toBe('repaired');
    expect(data.children.map((c) => c.id)).toEqual(['a', 'b']);
    expect(data.chores.map((c) => c.id)).toEqual(['a-bed', 'a-bins', 'b-bed']);
    // Duplicate same-day completion and invalid date are removed: no double points.
    expect(data.completions).toHaveLength(1);
    expect(pointsBalance(data, 'a')).toBe(5);
  });

  it('does not treat stored text as anything but plain strings', () => {
    const family = makeFamily();
    family.children[0]!.name = '<img src=x onerror=alert(1)>';
    const parsed = parseFamilyData(JSON.parse(JSON.stringify(family)));
    // Stored as an ordinary string; React escapes it when rendering.
    expect(parsed?.data.children[0]?.name).toBe('<img src=x onerror=alert(1)>');
  });

  it('copes with storage that throws', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {},
    };
    const { data, status } = loadData(throwing, MONDAY);
    expect(status).toBe('unavailable');
    expect(data.children.length).toBeGreaterThan(0);
    expect(saveData(throwing, data)).toBe(false);
  });

  it('works with no storage at all', () => {
    expect(loadData(null, MONDAY).status).toBe('unavailable');
  });
});

describe('reset', () => {
  it('replaces saved data with fresh sample data', () => {
    const storage = new MemoryStorage();
    saveData(storage, { ...makeFamily(), settings: { familyName: 'Old', parentPin: '5555', mealReminderDismissedOn: null } });
    const fresh = resetData(storage, MONDAY);
    expect(fresh.settings.parentPin).toBe('1234');
    expect(loadData(storage, MONDAY).data.settings.familyName).toBe(fresh.settings.familyName);
  });
});

describe('pinRequired option (server documents)', () => {
  it('default (browser): a missing PIN is treated as a repair and falls back to the demo PIN', () => {
    const { settings: _s, ...rest } = makeFamily();
    const parsed = parseFamilyData({ ...rest, settings: { familyName: 'Test Family', mealReminderDismissedOn: null } });
    expect(parsed?.repaired).toBe(true);
    expect(parsed?.data.settings.parentPin).toBe('1234');
  });

  it('pinRequired: false accepts settings without a PIN and never invents one', () => {
    const { settings: _s, ...rest } = makeFamily();
    const parsed = parseFamilyData({ ...rest, settings: { familyName: 'Test Family', mealReminderDismissedOn: null } }, { pinRequired: false });
    expect(parsed?.repaired).toBe(false);
    expect(parsed?.data.settings.parentPin).toBe('');
  });

  it('pinRequired: false ignores a PIN that is present', () => {
    const parsed = parseFamilyData(JSON.parse(JSON.stringify(makeFamily())), { pinRequired: false });
    expect(parsed?.data.settings.parentPin).toBe('');
  });
});
