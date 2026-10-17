import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { openDatabase, toSingleFile, type SqlDatabase } from './database';
import { currentSchemaVersion, LATEST_SCHEMA_VERSION } from './migrations';

// SQLite-safe backups. Never copy a live WAL database file directly: the
// newest changes may still be in the -wal file. Instead use SQLite's online
// backup API (via SqlDatabase.backupTo), which produces a single,
// consistent, self-contained file while the app keeps running.

export const BACKUP_DIR_NAME = 'backups';
const BACKUP_PATTERN = /^chorechart-(\d{8}T\d{6}Z)(?:-[a-z0-9-]+)?\.db$/;

export function backupDir(dataDir: string): string {
  return path.join(dataDir, BACKUP_DIR_NAME);
}

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export interface BackupCheck {
  ok: boolean;
  schemaVersion: number;
  stateVersion: number | null;
  error?: string;
}

/** Open a backup read-only and check integrity, schema and family state. */
export function verifyBackup(file: string): BackupCheck {
  if (!existsSync(file)) return { ok: false, schemaVersion: 0, stateVersion: null, error: 'File not found' };
  let db: SqlDatabase | undefined;
  try {
    db = openDatabase(file, { readOnly: true });
    const integrity = db.get<{ integrity_check: string }>('PRAGMA integrity_check');
    if (integrity?.integrity_check !== 'ok') {
      return { ok: false, schemaVersion: 0, stateVersion: null, error: `Integrity check failed: ${integrity?.integrity_check}` };
    }
    const schemaVersion = currentSchemaVersion(db);
    if (schemaVersion > LATEST_SCHEMA_VERSION) {
      return { ok: false, schemaVersion, stateVersion: null, error: 'Backup is from a newer app version' };
    }
    const hasState = db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'family_state'");
    const state = hasState ? db.get<{ version: number }>('SELECT version FROM family_state WHERE id = 1') : undefined;
    return { ok: true, schemaVersion, stateVersion: state ? Number(state.version) : null };
  } catch (error) {
    return { ok: false, schemaVersion: 0, stateVersion: null, error: (error as Error).message };
  } finally {
    db?.close();
  }
}

/**
 * Create a consistent backup of the live database in <dataDir>/backups and
 * verify it. `label` is a short tag such as "manual" or "pre-migration-v1".
 */
export async function createBackup(db: SqlDatabase, dataDir: string, label = 'manual', now = new Date()): Promise<string> {
  if (!/^[a-z0-9-]{1,40}$/.test(label)) throw new Error('Backup label must be lowercase letters, digits or hyphens.');
  const dir = backupDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `chorechart-${stamp(now)}-${label}.db`);
  if (existsSync(file)) throw new Error(`Backup already exists: ${file}`);
  await db.backupTo(file);
  // The copy inherits WAL mode; make it one self-contained file so it can be
  // copied off the machine safely on its own.
  toSingleFile(file);
  const check = verifyBackup(file);
  if (!check.ok) throw new Error(`Backup verification failed: ${check.error}`);
  return file;
}

export function listBackups(dataDir: string): string[] {
  const dir = backupDir(dataDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => BACKUP_PATTERN.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

/** Keep the newest `keep` backups whose label matches; delete older ones. */
export function pruneBackups(dataDir: string, keep: number, label?: string): string[] {
  if (!Number.isInteger(keep) || keep < 1) throw new Error('keep must be a positive integer');
  const matching = listBackups(dataDir).filter((f) => !label || path.basename(f).endsWith(`-${label}.db`));
  const remove = matching.slice(0, Math.max(0, matching.length - keep));
  for (const f of remove) unlinkSync(f);
  return remove;
}

/**
 * OFFLINE restore: the server must be stopped. Verifies the backup, moves
 * the current database (and any -wal/-shm files) aside to
 * <dataDir>/backups/replaced-<timestamp>-*.db, then copies the backup into
 * place. Returns the path of the moved-aside database (if there was one).
 */
export function restoreBackup(backupFile: string, dbFile: string, now = new Date()): { movedAside: string | null } {
  const check = verifyBackup(backupFile);
  if (!check.ok) throw new Error(`Refusing to restore: ${check.error}`);
  const dataDir = path.dirname(dbFile);
  const aside = path.join(backupDir(dataDir), `replaced-${stamp(now)}`);
  let movedAside: string | null = null;
  if (existsSync(dbFile) && statSync(dbFile).size > 0) {
    mkdirSync(backupDir(dataDir), { recursive: true });
    movedAside = `${aside}.db`;
    renameSync(dbFile, movedAside);
  }
  for (const suffix of ['-wal', '-shm']) {
    if (existsSync(dbFile + suffix)) {
      if (movedAside) renameSync(dbFile + suffix, `${aside}.db${suffix}`);
      else unlinkSync(dbFile + suffix);
    }
  }
  copyFileSync(backupFile, dbFile);
  return { movedAside };
}
