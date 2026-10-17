import path from 'node:path';
import { createBackup } from './db/backup';
import { openDatabase, type SqlDatabase } from './db/database';
import { currentSchemaVersion, MIGRATIONS, pendingMigrations, runMigrations, type Migration } from './db/migrations';
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
    const { created } = store.initialize();
    return { db, store, migrated, preMigrationBackup, created };
  } catch (error) {
    db.close();
    throw error;
  }
}
