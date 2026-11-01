import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultCelebrationSettings } from '../../src/lib/celebrations';
import { openDatabase } from '../db/database';
import { verifyBackup } from '../db/backup';
import { databasePath, openData } from '../open';
import { FIXED_NOW, tempDir } from '../testUtils';
import { FamilyStore } from './store';

// Upgrading a family document saved by 0.6.0 and earlier (format 3) to
// format 4 when the new release starts: backup first, then one transaction,
// every record kept.

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir();
});
afterEach(() => tmp.cleanup());

/** Make a database whose family document looks exactly like 0.6.0 left it (format 3). */
async function v060Database(mutate: (doc: Record<string, unknown>) => void = () => {}) {
  const opened = await openData(tmp.dir, 'Europe/London');
  const store = new FamilyStore(opened.db, { timeZone: 'Europe/London', now: () => FIXED_NOW });
  const ok = (r: ReturnType<FamilyStore['apply']>) => {
    if (!r.ok) throw new Error(r.message);
  };
  ok(store.apply({ type: 'saveChild', payload: { name: 'Maya', avatar: '🦄', color: 'pink' } }, 'test'));
  const maya = store.read().family.children[0]!.id;
  ok(store.apply({ type: 'saveChore', payload: { title: 'Bed', icon: '🛏️', childId: maya, period: 'morning', points: 5, scheduleType: 'daily', days: [] } }, 'test'));
  const chore = store.read().family.chores[0]!.id;
  ok(store.apply({ type: 'toggleChore', payload: { choreId: chore } }, 'test'));
  ok(store.apply({ type: 'saveReward', payload: { name: 'Park', icon: '🛝', cost: 5 } }, 'test'));
  const row = opened.db.get<{ data: string; version: number }>('SELECT data, version FROM family_state WHERE id = 1')!;
  const doc = JSON.parse(row.data) as Record<string, unknown>;
  delete doc.celebrations;
  delete doc.birthdays;
  delete doc.bonusAwards;
  doc.version = 3;
  mutate(doc);
  opened.db.run('UPDATE family_state SET format = 3, data = ? WHERE id = 1', JSON.stringify(doc));
  const versions = opened.db.all('SELECT * FROM record_versions ORDER BY kind, record_id');
  opened.db.close();
  return { doc, stateVersion: Number(row.version), versions };
}

describe('family data format v3 → v4 on start-up', () => {
  it('backs up, then upgrades, keeping every record, record version and the state history', async () => {
    const before = await v060Database();
    const opened = await openData(tmp.dir, 'Europe/London');
    try {
      expect(opened.formatUpgrade).toMatchObject({ from: 3, to: 4 });
      const backup = opened.formatUpgrade!.backup;
      expect(backup).toMatch(/pre-format-v3-to-v4\.db$/);
      expect(existsSync(backup)).toBe(true);
      expect(verifyBackup(backup)).toMatchObject({ ok: true, stateVersion: before.stateVersion });

      const s = opened.store.read();
      expect(s.stateVersion).toBe(before.stateVersion + 1);
      const { celebrations, birthdays, bonusAwards, version, ...kept } = s.family;
      const { version: _v, ...expected } = before.doc;
      expect(kept).toEqual(expected);
      expect(version).toBe(4);
      expect(celebrations).toEqual(defaultCelebrationSettings());
      expect(birthdays).toEqual([]);
      expect(bonusAwards).toEqual([]);
      expect(opened.db.get<{ format: number }>('SELECT format FROM family_state')!.format).toBe(4);
      expect(opened.db.all('SELECT * FROM record_versions ORDER BY kind, record_id')).toEqual(before.versions);
      expect(opened.db.get<{ type: string; actor: string }>('SELECT type, actor FROM command_log ORDER BY id DESC LIMIT 1')).toEqual({ type: 'upgradeFormat:v3-to-v4', actor: 'system' });
    } finally {
      opened.db.close();
    }
  });

  it('happens once: the next start changes nothing', async () => {
    await v060Database();
    (await openData(tmp.dir, 'Europe/London')).db.close();
    const again = await openData(tmp.dir, 'Europe/London');
    try {
      expect(again.formatUpgrade).toBeNull();
      expect(again.migrated).toEqual([]);
    } finally {
      again.db.close();
    }
  });

  it('refuses to upgrade damaged data and leaves it exactly as it was', async () => {
    await v060Database((doc) => {
      (doc.chores as unknown[]).push({ id: 'broken', childId: 'nobody-here', title: '', points: -1 });
    });
    const raw = () => {
      const db = openDatabase(databasePath(tmp.dir), { readOnly: true });
      try {
        return db.get<{ format: number; data: string; version: number }>('SELECT format, data, version FROM family_state')!;
      } finally {
        db.close();
      }
    };
    const before = raw();
    await expect(openData(tmp.dir, 'Europe/London')).rejects.toThrow(/invalid records/);
    expect(raw()).toEqual(before);
  });

  it('a new installation starts at format 4 with no upgrade', async () => {
    const opened = await openData(tmp.dir, 'Europe/London');
    try {
      expect(opened.created).toBe(true);
      expect(opened.formatUpgrade).toBeNull();
      expect(opened.db.get<{ format: number }>('SELECT format FROM family_state')!.format).toBe(4);
    } finally {
      opened.db.close();
    }
  });
});
