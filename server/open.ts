import path from 'node:path';
import { createBackup } from './db/backup';
import { openDatabase, type SqlDatabase } from './db/database';
import { currentSchemaVersion, MIGRATIONS, pendingMigrations, runMigrations, type Migration } from './db/migrations';
import { DATA_VERSION } from '../src/types';
import { FamilyStore } from './family/store';

export const DATABASE_FILE = 'chorechart.db';

export function databasePath(dataDir: string): string {
  return path.join(dataDir, DATABASE_FILE);
}

export interface OpenedData {
  db: SqlDatabase;
  store: FamilyStore;
  migrated: number[];
  preMigrationBackup: string | null;
  /** Set when a family document from an older release was upgraded (e.g. v3 → v4). */
  formatUpgrade: { from: number; to: number; backup: string } | null;
  created: boolean;
}

/**
 * Open the database, take a verified backup before upgrading an existing
 * database, apply pending migrations and make sure the household exists.
 * Refuses (SchemaTooNewError) to open a database from a newer release.
 */
export async function openData(
  dataDir: string,
  timeZone: string,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<OpenedData> {
  const db = openDatabase(databasePath(dataDir));
  try {
    const pending = pendingMigrations(db, migrations);
    const target = migrations[migrations.length - 1]?.version ?? 0;
    const from = currentSchemaVersion(db);
    let preMigrationBackup: string | null = null;
    if (pending.length > 0 && from > 0) {
      preMigrationBackup = await createBackup(db, dataDir, `pre-migration-v${from}-to-v${target}`);
    }
    const migrated = runMigrations(db, migrations);
    const store = new FamilyStore(db, { timeZone });
    // A family document saved by an older release (format 3, up to 0.6.0):
    // back up the whole database first, then upgrade it in one transaction.
    let formatUpgrade: OpenedData['formatUpgrade'] = null;
    const format = store.storedFormat();
    if (format !== null && format < DATA_VERSION) {
      const backup = await createBackup(db, dataDir, `pre-format-v${format}-to-v${DATA_VERSION}`);
      const upgraded = store.upgradeFormat();
      if (upgraded) formatUpgrade = { ...upgraded, backup };
    }
    const { created } = store.initialize();
    return { db, store, migrated, preMigrationBackup, formatUpgrade, created };
  } catch (error) {
    db.close();
    throw error;
  }
}
