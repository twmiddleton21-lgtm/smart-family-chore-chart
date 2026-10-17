import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { backup, DatabaseSync, type SQLInputValue } from 'node:sqlite';

// The ONLY module that talks to the SQLite library. Everything else uses the
// small SqlDatabase interface, so the storage library can be swapped later
// (e.g. for better-sqlite3) by reimplementing this file.

export type SqlValue = SQLInputValue;
export type Row = Record<string, unknown>;

export interface SqlDatabase {
  readonly path: string;
  exec(sql: string): void;
  run(sql: string, ...params: SqlValue[]): { changes: number };
  get<T extends Row = Row>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T extends Row = Row>(sql: string, ...params: SqlValue[]): T[];
  /**
   * Run fn inside a write transaction (BEGIN IMMEDIATE). Commits if fn
   * returns, rolls back if it throws. Not re-entrant.
   */
  transaction<T>(fn: () => T): T;
  /** Online, WAL-consistent copy of the whole database to destPath. */
  backupTo(destPath: string): Promise<void>;
  close(): void;
}

/**
 * Turn a database file (e.g. a fresh backup copy, which inherits WAL mode)
 * into a single self-contained file: checkpoint everything into the main
 * file and switch to the rollback journal, so no -wal/-shm file is needed.
 */
export function toSingleFile(filePath: string): void {
  const db = new DatabaseSync(filePath);
  try {
    db.exec('PRAGMA journal_mode = DELETE;');
  } finally {
    db.close();
  }
}

export interface OpenOptions {
  /** Milliseconds to wait for another connection's write lock. */
  busyTimeoutMs?: number;
  /** Open without write access (e.g. to inspect a backup). */
  readOnly?: boolean;
}

export function openDatabase(filePath: string, options: OpenOptions = {}): SqlDatabase {
  const memory = filePath === ':memory:';
  const readOnly = options.readOnly === true;
  if (!memory && !readOnly) mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath, { readOnly });
  let inTransaction = false;

  // WAL allows readers during writes; FULL sync favours durability over speed
  // (family data is small and written rarely).
  if (!memory && !readOnly) db.exec('PRAGMA journal_mode = WAL;');
  if (!readOnly) db.exec('PRAGMA synchronous = FULL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? 5000))};`);

  return {
    path: filePath,
    exec: (sql) => db.exec(sql),
    run: (sql, ...params) => {
      const r = db.prepare(sql).run(...params);
      return { changes: Number(r.changes) };
    },
    get: <T extends Row>(sql: string, ...params: SqlValue[]) => db.prepare(sql).get(...params) as T | undefined,
    all: <T extends Row>(sql: string, ...params: SqlValue[]) => db.prepare(sql).all(...params) as T[],
    transaction<T>(fn: () => T): T {
      if (inTransaction) throw new Error('Nested transactions are not supported.');
      db.exec('BEGIN IMMEDIATE;');
      inTransaction = true;
      try {
        const result = fn();
        db.exec('COMMIT;');
        return result;
      } catch (error) {
        try {
          db.exec('ROLLBACK;');
        } catch {
          // The transaction may already have been rolled back by SQLite.
        }
        throw error;
      } finally {
        inTransaction = false;
      }
    },
    async backupTo(destPath: string) {
      mkdirSync(path.dirname(destPath), { recursive: true });
      await backup(db, destPath);
    },
    close: () => db.close(),
  };
}
