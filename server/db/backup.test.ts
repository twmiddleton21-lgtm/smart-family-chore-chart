import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { databasePath, openData } from '../open';
import { tempDir } from '../testUtils';
import { createBackup, listBackups, pruneBackups, restoreBackup, verifyBackup } from './backup';
import { openDatabase } from './database';
import { LATEST_SCHEMA_VERSION, MIGRATIONS, runMigrations } from './migrations';
import { AuthService } from '../auth/service';
import { FamilyStore } from '../family/store';

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir();
});
afterEach(() => tmp.cleanup());

const addChild = (store: Awaited<ReturnType<typeof openData>>['store'], name: string) => {
  const r = store.apply({ type: 'saveChild', payload: { name, avatar: '🐼', color: 'teal' } }, 'test');
  if (!r.ok) throw new Error(r.message);
};

describe('backups', () => {
  it('captures changes still in the WAL file (not yet checkpointed)', async () => {
    const { db, store } = await openData(tmp.dir, 'UTC');
    try {
      addChild(store, 'Alex');
      // The newest commit lives in chorechart.db-wal until a checkpoint.
      expect(existsSync(databasePath(tmp.dir) + '-wal')).toBe(true);
      const file = await createBackup(db, tmp.dir, 'manual');
      const check = verifyBackup(file);
      expect(check).toMatchObject({ ok: true, schemaVersion: LATEST_SCHEMA_VERSION, stateVersion: 2 });
      const b = openDatabase(file, { readOnly: true });
      try {
        expect(JSON.parse(b.get<{ data: string }>('SELECT data FROM family_state')!.data).children[0].name).toBe('Alex');
      } finally {
        b.close();
      }
    } finally {
      db.close();
    }
  });

  it('is a self-contained single file (no -wal needed to read it)', async () => {
    const { db, store } = await openData(tmp.dir, 'UTC');
    try {
      addChild(store, 'Alex');
      const file = await createBackup(db, tmp.dir, 'manual');
      expect(existsSync(file + '-wal')).toBe(false);
      expect(existsSync(file + '-shm')).toBe(false);
      const b = openDatabase(file, { readOnly: true });
      try {
        expect(b.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode).toBe('delete');
      } finally {
        b.close();
      }
    } finally {
      db.close();
    }
  });

  it('rejects unsafe labels and a corrupt backup file', async () => {
    const { db } = await openData(tmp.dir, 'UTC');
    try {
      await expect(createBackup(db, tmp.dir, '../escape')).rejects.toThrow(/label/);
    } finally {
      db.close();
    }
    const junk = path.join(tmp.dir, 'junk.db');
    writeFileSync(junk, 'this is not a database');
    expect(verifyBackup(junk).ok).toBe(false);
    expect(verifyBackup(path.join(tmp.dir, 'missing.db')).ok).toBe(false);
  });

  it('prunes old backups, keeping the newest', async () => {
    const { db } = await openData(tmp.dir, 'UTC');
    try {
      for (let i = 0; i < 4; i++) await createBackup(db, tmp.dir, 'daily', new Date(Date.UTC(2026, 9, 10 + i, 3)));
      await createBackup(db, tmp.dir, 'manual', new Date(Date.UTC(2026, 9, 1, 3)));
    } finally {
      db.close();
    }
    const removed = pruneBackups(tmp.dir, 2, 'daily');
    expect(removed.map((f) => path.basename(f))).toEqual(['chorechart-20261010T030000Z-daily.db', 'chorechart-20261011T030000Z-daily.db']);
    expect(listBackups(tmp.dir).map((f) => path.basename(f))).toEqual([
      'chorechart-20261001T030000Z-manual.db',
      'chorechart-20261012T030000Z-daily.db',
      'chorechart-20261013T030000Z-daily.db',
    ]);
  });

  it('restore round trip: later changes are undone, the replaced database is kept aside', async () => {
    let backupFile: string;
    {
      const { db, store } = await openData(tmp.dir, 'UTC');
      addChild(store, 'Alex');
      backupFile = await createBackup(db, tmp.dir, 'manual');
      addChild(store, 'Bea'); // after the backup
      db.close(); // server stopped
    }
    const { movedAside } = restoreBackup(backupFile, databasePath(tmp.dir));
    expect(movedAside).toMatch(/replaced-.*\.db$/);
    expect(existsSync(movedAside!)).toBe(true);

    const { db, store } = await openData(tmp.dir, 'UTC');
    try {
      expect(store.read().family.children.map((c) => c.name)).toEqual(['Alex']);
    } finally {
      db.close();
    }
    // The moved-aside database still has the newer data.
    const aside = openDatabase(movedAside!, { readOnly: true });
    try {
      expect(JSON.parse(aside.get<{ data: string }>('SELECT data FROM family_state')!.data).children).toHaveLength(2);
    } finally {
      aside.close();
    }
  });

  it('a restore signs everyone out: no session, paired device or pairing code from the backup comes back', async () => {
    let backupFile: string;
    let parentToken: string;
    let deviceToken: string;
    let revokedDeviceToken: string;
    {
      const { db, store } = await openData(tmp.dir, 'UTC');
      const auth = new AuthService(db, { setupCode: 'RESTORETEST01' });
      auth.prepareSetup();
      const setup = await auth.completeSetup({ setupCode: 'RESTORETEST01', username: 'sam', displayName: 'Sam', password: 'correct horse battery' }, '127.0.0.1');
      if (!setup.ok) throw new Error(setup.message);
      parentToken = setup.token;
      const pair = (name: string) => {
        const c = auth.createPairingCode(setup.parent.id, name);
        if (!c.ok) throw new Error(c.message);
        const d = auth.pairDevice(c.code, '127.0.0.1');
        if (!d.ok) throw new Error(d.message);
        return d;
      };
      deviceToken = pair('Kitchen tablet').token;
      const revoked = pair('Old tablet');
      revokedDeviceToken = revoked.token;
      if (!auth.createPairingCode(setup.parent.id, 'Not yet paired').ok) throw new Error('code');
      addChild(store, 'Alex');
      backupFile = await createBackup(db, tmp.dir, 'manual');
      // After the backup: the parent signs out and a device is unpaired.
      auth.logout(parentToken);
      auth.revokeDevice(revoked.device.id);
      db.close(); // server stopped
    }
    restoreBackup(backupFile, databasePath(tmp.dir));

    const { db, store } = await openData(tmp.dir, 'UTC');
    try {
      const count = (table: string) => Number(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n);
      expect([count('sessions'), count('devices'), count('pairing_codes')]).toEqual([0, 0, 0]);
      expect(count('parents')).toBe(1); // accounts are kept
      expect(store.read().family.children.map((c) => c.name)).toEqual(['Alex']); // and the family data
      const auth = new AuthService(db);
      for (const [parent, device] of [[parentToken, deviceToken], [undefined, revokedDeviceToken]] as const) {
        expect(auth.authenticate(parent, device)).toEqual({ parent: null, device: null, parentSessionHash: null });
      }
      expect((await auth.login('sam', 'correct horse battery', false, '127.0.0.1')).ok).toBe(true); // sign in again
    } finally {
      db.close();
    }
  });

  it('a backup from before parent accounts existed restores as before', async () => {
    const dbFile = databasePath(tmp.dir);
    let backupFile: string;
    {
      const db = openDatabase(dbFile);
      runMigrations(db, MIGRATIONS.slice(0, 1));
      new FamilyStore(db, { timeZone: 'UTC' }).initialize();
      backupFile = await createBackup(db, tmp.dir, 'manual');
      db.close();
    }
    restoreBackup(backupFile, dbFile);
    const { db, migrated } = await openData(tmp.dir, 'UTC');
    try {
      expect(migrated).toEqual([2, 3, 4]);
      expect(new AuthService(db).isSetupRequired()).toBe(true);
    } finally {
      db.close();
    }
  });

  it('if the restored copy can’t be prepared, the current database is left untouched', async () => {
    const { db, store } = await openData(tmp.dir, 'UTC');
    addChild(store, 'Alex');
    const backupFile = await createBackup(db, tmp.dir, 'manual');
    db.close();
    // Something in the way of the prepared copy (a directory with its name).
    mkdirSync(`${databasePath(tmp.dir)}.restoring`);
    expect(() => restoreBackup(backupFile, databasePath(tmp.dir))).toThrow();
    const again = await openData(tmp.dir, 'UTC');
    try {
      expect(again.store.read().family.children).toHaveLength(1);
    } finally {
      again.db.close();
    }
  });

  it('refuses to restore an invalid backup and leaves the current database untouched', async () => {
    const { db, store } = await openData(tmp.dir, 'UTC');
    addChild(store, 'Alex');
    db.close();
    const junk = path.join(tmp.dir, 'junk.db');
    writeFileSync(junk, 'nope');
    expect(() => restoreBackup(junk, databasePath(tmp.dir))).toThrow(/Refusing to restore/);
    const again = await openData(tmp.dir, 'UTC');
    try {
      expect(again.store.read().family.children).toHaveLength(1);
    } finally {
      again.db.close();
    }
  });
});
