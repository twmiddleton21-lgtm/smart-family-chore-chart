import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openData } from '../open';
import { tempDir } from '../testUtils';
import { openDatabase } from './database';
import { currentSchemaVersion, LATEST_SCHEMA_VERSION, MIGRATIONS, runMigrations, SchemaTooNewError, type Migration } from './migrations';

let tmp: ReturnType<typeof tempDir>;
beforeEach(() => {
  tmp = tempDir();
});
afterEach(() => tmp.cleanup());

const tables = (db: ReturnType<typeof openDatabase>) =>
  db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);

describe('schema migrations', () => {
  it('migrations are numbered 1..n without gaps', () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
  });

  it('initialises a fresh database to the latest schema', () => {
    const db = openDatabase(path.join(tmp.dir, 'a.db'));
    try {
      expect(currentSchemaVersion(db)).toBe(0);
      expect(runMigrations(db)).toEqual(MIGRATIONS.map((m) => m.version));
      expect(currentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(tables(db)).toEqual(['command_log', 'family_state', 'record_versions', 'schema_migrations']);
    } finally {
      db.close();
    }
  });

  it('is idempotent: running again applies nothing', () => {
    const db = openDatabase(path.join(tmp.dir, 'a.db'));
    try {
      runMigrations(db);
      expect(runMigrations(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('a failing migration is rolled back completely and the version is unchanged', () => {
    const db = openDatabase(path.join(tmp.dir, 'a.db'));
    try {
      runMigrations(db);
      const broken: Migration[] = [
        ...MIGRATIONS,
        { version: LATEST_SCHEMA_VERSION + 1, name: 'broken', sql: 'CREATE TABLE half_done (x INTEGER); THIS IS NOT SQL;' },
      ];
      expect(() => runMigrations(db, broken)).toThrow();
      expect(currentSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
      expect(tables(db)).not.toContain('half_done');
    } finally {
      db.close();
    }
  });

  it('refuses a database created by a newer release', async () => {
    const db = openDatabase(path.join(tmp.dir, 'chorechart.db'));
    runMigrations(db);
    db.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, 'future', '2030-01-01')", LATEST_SCHEMA_VERSION + 1);
    db.close();
    await expect(openData(tmp.dir, 'UTC')).rejects.toBeInstanceOf(SchemaTooNewError);
  });

  it('takes a verified backup before upgrading an existing database, but not for a new one', async () => {
    const first = await openData(tmp.dir, 'UTC');
    expect(first.created).toBe(true);
    expect(first.preMigrationBackup).toBeNull();
    first.store.apply({ type: 'saveChild', payload: { name: 'Sam', avatar: '🐼', color: 'teal' } }, 'test');
    first.db.close();

    const next: Migration[] = [...MIGRATIONS, { version: LATEST_SCHEMA_VERSION + 1, name: 'add index', sql: 'CREATE INDEX idx_log_type ON command_log(type);' }];
    const second = await openData(tmp.dir, 'UTC', next);
    try {
      expect(second.created).toBe(false);
      expect(second.migrated).toEqual([LATEST_SCHEMA_VERSION + 1]);
      expect(second.preMigrationBackup).toMatch(/pre-migration-v1-to-v2\.db$/);
      // The backup holds the pre-upgrade schema and the family data.
      const backup = openDatabase(second.preMigrationBackup!, { readOnly: true });
      try {
        expect(currentSchemaVersion(backup)).toBe(LATEST_SCHEMA_VERSION);
        const data = JSON.parse(backup.get<{ data: string }>('SELECT data FROM family_state')!.data);
        expect(data.children.map((c: { name: string }) => c.name)).toEqual(['Sam']);
      } finally {
        backup.close();
      }
    } finally {
      second.db.close();
    }
  });
});
