import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../db/database';
import { databasePath, openData } from '../open';
import { FIXED_NOW, tempDir } from '../testUtils';
import { FamilyStore, type ApplyResult } from './store';

let tmp: ReturnType<typeof tempDir>;
const closers: (() => void)[] = [];
beforeEach(() => {
  tmp = tempDir();
});
afterEach(() => {
  for (const c of closers.splice(0)) c();
  tmp.cleanup();
});

async function setup(timeZone = 'Europe/London', now = () => FIXED_NOW) {
  const opened = await openData(tmp.dir, timeZone);
  closers.push(() => opened.db.close());
  const store = new FamilyStore(opened.db, { timeZone, now });
  return { ...opened, store };
}

function ok(r: ApplyResult) {
  if (!r.ok) throw new Error(`${r.status} ${r.error}: ${r.message}`);
  return r;
}

const child = (name: string) => ({ type: 'saveChild' as const, payload: { name, avatar: '🐼', color: 'teal' } });
const chore = (childId: string, title = 'Make bed') => ({
  type: 'saveChore' as const,
  payload: { title, icon: '🛏️', childId, period: 'morning', points: 5, scheduleType: 'daily', days: [] },
});

describe('initialisation', () => {
  it('starts with an empty household at state version 1 (no sample family, no PIN)', async () => {
    const { store, created } = await setup();
    expect(created).toBe(true);
    const s = store.read();
    expect(s.stateVersion).toBe(1);
    expect(s.family.children).toEqual([]);
    expect(s.family.chores).toEqual([]);
    expect(s.family.settings).toEqual({ familyName: 'Our Family', mealReminderDismissedOn: null });
    expect('parentPin' in s.family.settings).toBe(false);
  });

  it('is idempotent across restarts and keeps existing data', async () => {
    const first = await setup();
    ok(first.store.apply(child('Alex'), 'test'));
    first.db.close();
    closers.length = 0;
    const second = await setup();
    expect(second.created).toBe(false);
    expect(second.store.read().family.children.map((c) => c.name)).toEqual(['Alex']);
  });

  it('refuses to start on corrupt stored family data instead of serving it', async () => {
    const first = await setup();
    first.db.run("UPDATE family_state SET data = '{\"version\":3}' WHERE id = 1");
    first.db.close();
    closers.length = 0;
    await expect(openData(tmp.dir, 'UTC')).rejects.toThrow(/unusable|invalid/i);
  });
});

describe('commands reuse the existing business rules', () => {
  it('adds a child and chore, ticks it once per day, and points are derived', async () => {
    const { store } = await setup();
    ok(store.apply(child('Alex'), 'test'));
    const alex = store.read().family.children[0]!;
    ok(store.apply(chore(alex.id), 'test'));
    const bed = store.read().family.chores[0]!;

    const t1 = ok(store.apply({ type: 'toggleChore', payload: { choreId: bed.id } }, 'test'));
    expect(t1.noChange).toBe(false);
    const fam = store.read().family;
    expect(fam.completions).toHaveLength(1);
    expect(fam.completions[0]).toMatchObject({ choreId: bed.id, childId: alex.id, date: '2026-10-13', points: 5 });

    // Toggling again undoes it (the existing toggle rule).
    ok(store.apply({ type: 'toggleChore', payload: { choreId: bed.id } }, 'test'));
    expect(store.read().family.completions).toHaveLength(0);
  });

  it('uses the household time zone for "today", not UTC', async () => {
    // 23:30 UTC on 13 Oct is already 14 Oct 00:30 in London (BST).
    const late = new Date('2026-10-13T23:30:00Z');
    const { store } = await setup('Europe/London', () => late);
    expect(store.today()).toBe('2026-10-14');
    ok(store.apply(child('Alex'), 'test'));
    ok(store.apply(chore(store.read().family.children[0]!.id), 'test'));
    ok(store.apply({ type: 'toggleChore', payload: { choreId: store.read().family.chores[0]!.id } }, 'test'));
    expect(store.read().family.completions[0]!.date).toBe('2026-10-14');
  });

  it('rejects invalid input with field errors and stores nothing', async () => {
    const { store } = await setup();
    const r = store.apply({ type: 'saveChild', payload: { name: '', avatar: '', color: 'neon' } }, 'test');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(422);
      expect(Object.keys(r.fields ?? {}).sort()).toEqual(['avatar', 'color', 'name']);
    }
    expect(store.read().stateVersion).toBe(1);
  });

  it('rejects malformed payload types with 400', async () => {
    const { store } = await setup();
    const r = store.apply({ type: 'toggleChore', payload: { choreId: 42 } }, 'test');
    expect(r).toMatchObject({ ok: false, status: 400, error: 'invalid_request' });
  });

  it('enforces reward balances server-side (insufficient points rejected)', async () => {
    const { store } = await setup();
    ok(store.apply(child('Alex'), 'test'));
    ok(store.apply({ type: 'saveReward', payload: { name: 'Park', description: '', icon: '🛝', cost: 50 } }, 'test'));
    const s = store.read().family;
    const r = store.apply({ type: 'redeemReward', payload: { childId: s.children[0]!.id, rewardId: s.rewards[0]!.id } }, 'test');
    expect(r).toMatchObject({ ok: false, status: 422 });
    expect(store.read().family.redemptions).toHaveLength(0);
  });

  it('never stores a parent PIN', async () => {
    const { store, db } = await setup();
    const r = store.apply({ type: 'updateSettings', expectedVersion: 0, payload: { familyName: 'X', parentPin: '1234' } }, 'test');
    expect(r).toMatchObject({ ok: false, status: 400 });
    ok(store.apply({ type: 'loadDemoFamily', payload: {} }, 'test'));
    const raw = db.get<{ data: string }>('SELECT data FROM family_state')!.data;
    expect(raw).not.toContain('parentPin');
  });

  it('loads the demo family only into an empty household', async () => {
    const { store } = await setup();
    ok(store.apply({ type: 'loadDemoFamily', payload: {} }, 'test'));
    expect(store.read().family.children.map((c) => c.name)).toEqual(['Maya', 'Leo', 'Ivy']);
    const again = store.apply({ type: 'loadDemoFamily', payload: {} }, 'test');
    expect(again).toMatchObject({ ok: false, status: 409 });
  });

  it('a command that changes nothing does not bump the version', async () => {
    const { store } = await setup();
    const r = ok(store.apply({ type: 'dismissMealReminder', payload: {} }, 'test'));
    expect(r.noChange).toBe(false);
    const again = ok(store.apply({ type: 'dismissMealReminder', payload: {} }, 'test'));
    expect(again.noChange).toBe(true);
    expect(again.stateVersion).toBe(r.stateVersion);
  });
});

describe('conflicting edits and record versions', () => {
  it('requires expectedVersion when editing an existing record', async () => {
    const { store } = await setup();
    ok(store.apply(child('Alex'), 'test'));
    const alex = store.read().family.children[0]!;
    const r = store.apply({ type: 'saveChild', payload: { id: alex.id, name: 'Alexa', avatar: '🐼', color: 'teal' } }, 'test');
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it('a stale edit is rejected with 409 instead of overwriting a newer one', async () => {
    const { store } = await setup();
    ok(store.apply(child('Alex'), 'test'));
    const s1 = store.read();
    const alex = s1.family.children[0]!;
    const seen = s1.recordVersions[`child:${alex.id}`]!; // both devices saw this version
    expect(seen).toBe(2);

    // Device A saves first.
    ok(store.apply({ type: 'saveChild', expectedVersion: seen, payload: { id: alex.id, name: 'Alexa', avatar: '🐼', color: 'teal' } }, 'test'));
    // Device B, still holding the old version, tries to save a different change.
    const b = store.apply({ type: 'saveChild', expectedVersion: seen, payload: { id: alex.id, name: 'Al', avatar: '🦊', color: 'pink' } }, 'test');
    expect(b).toMatchObject({ ok: false, status: 409, error: 'conflict', record: `child:${alex.id}`, currentVersion: 3 });
    expect(store.read().family.children[0]!.name).toBe('Alexa');
  });

  it('edits to different records do not conflict', async () => {
    const { store } = await setup();
    ok(store.apply(child('Alex'), 'test'));
    ok(store.apply(child('Bea'), 'test'));
    const s = store.read();
    const [a, b] = s.family.children;
    ok(store.apply({ type: 'saveChild', expectedVersion: s.recordVersions[`child:${a!.id}`], payload: { id: a!.id, name: 'Alexa', avatar: '🐼', color: 'teal' } }, 'test'));
    ok(store.apply({ type: 'saveChild', expectedVersion: s.recordVersions[`child:${b!.id}`], payload: { id: b!.id, name: 'Bee', avatar: '🦊', color: 'pink' } }, 'test'));
    expect(store.read().family.children.map((c) => c.name)).toEqual(['Alexa', 'Bee']);
  });

  it('deleting a child also versions its cascaded records, so stale edits to them conflict', async () => {
    const { store } = await setup();
    ok(store.apply(child('Alex'), 'test'));
    ok(store.apply(chore(store.read().family.children[0]!.id), 'test'));
    const s = store.read();
    const alex = s.family.children[0]!;
    const bed = s.family.chores[0]!;
    const deleted = ok(store.apply({ type: 'deleteChild', expectedVersion: s.recordVersions[`child:${alex.id}`], payload: { id: alex.id } }, 'test'));
    expect(deleted.changed).toEqual(expect.arrayContaining([`child:${alex.id}`, `chore:${bed.id}`]));
    const stale = store.apply({ type: 'deleteChore', expectedVersion: s.recordVersions[`chore:${bed.id}`], payload: { id: bed.id } }, 'test');
    expect(stale).toMatchObject({ ok: false, status: 404 });
  });

  it('meal weeks are versioned per child and week', async () => {
    const { store } = await setup();
    ok(store.apply(child('Alex'), 'test'));
    ok(store.apply({ type: 'addFoodOption', payload: { category: 'main', name: 'Pizza' } }, 'test'));
    const alex = store.read().family.children[0]!;
    const save = (expectedVersion: number, main: string) =>
      store.apply({ type: 'saveMealWeek', expectedVersion, payload: { childId: alex.id, monday: '2026-10-12', rows: [{ date: '2026-10-13', main, pudding: '' }] } }, 'test');
    ok(save(0, 'Pizza'));
    const key = `mealWeek:${alex.id}:2026-10-12`;
    const v = store.read().recordVersions[key]!;
    expect(v).toBeGreaterThan(0);
    expect(save(0, 'Curry')).toMatchObject({ ok: false, status: 409, record: key });
    ok(save(v, 'Curry'));
  });
});

describe('transactions and lost updates', () => {
  it('a failure after writing but before commit leaves the state unchanged', async () => {
    const opened = await setup();
    let fail = true;
    const store = new FamilyStore(opened.db, {
      timeZone: 'UTC',
      now: () => FIXED_NOW,
      beforeCommit: () => {
        if (fail) throw new Error('simulated crash before commit');
      },
    });
    expect(() => store.apply(child('Alex'), 'test')).toThrow('simulated crash');
    const s = store.read();
    expect(s.stateVersion).toBe(1);
    expect(s.family.children).toEqual([]);
    expect(s.recordVersions).toEqual({});
    expect(opened.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM command_log')!.n).toBe(0);
    fail = false;
    ok(store.apply(child('Alex'), 'test'));
    expect(store.read().stateVersion).toBe(2);
  });

  it('two connections (e.g. two processes) applying commands never lose an update', async () => {
    const { store: a } = await setup();
    const dbB = openDatabase(databasePath(tmp.dir));
    closers.push(() => dbB.close());
    const b = new FamilyStore(dbB, { timeZone: 'UTC', now: () => FIXED_NOW });

    // Both "devices" read the same state first...
    expect(a.read().stateVersion).toBe(b.read().stateVersion);
    // ...then write alternately. Each write re-reads inside its transaction.
    for (let i = 0; i < 10; i++) {
      ok((i % 2 ? a : b).apply(child(`Kid ${i}`), 'test'));
    }
    const final = a.read();
    expect(final.family.children).toHaveLength(10);
    expect(final.stateVersion).toBe(11);
    expect(b.read().stateVersion).toBe(11);
  });

  it('a writer blocked by another transaction waits instead of overwriting', async () => {
    const { store: a, db: dbA } = await setup();
    const dbB = openDatabase(databasePath(tmp.dir), { busyTimeoutMs: 0 });
    closers.push(() => dbB.close());
    const b = new FamilyStore(dbB, { timeZone: 'UTC', now: () => FIXED_NOW });
    dbA.transaction(() => {
      dbA.run("UPDATE family_state SET updated_at = 'locked' WHERE id = 1");
      // With no wait allowed, B is refused rather than writing on a stale copy.
      expect(() => b.apply(child('Bea'), 'test')).toThrow(/locked|busy/i);
    });
    ok(b.apply(child('Bea'), 'test'));
    expect(a.read().family.children.map((c) => c.name)).toEqual(['Bea']);
  });

  it('records a minimal audit log without request payloads', async () => {
    const { store, db } = await setup();
    ok(store.apply(child('Alex'), 'dev'));
    const rows = db.all('SELECT state_version, type, actor FROM command_log');
    expect(rows).toEqual([{ state_version: 2, type: 'saveChild', actor: 'dev' }]);
  });
});
