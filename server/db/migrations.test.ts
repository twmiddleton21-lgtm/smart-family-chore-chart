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
      expect(tables(db)).toEqual(['command_log', 'devices', 'family_state', 'google_calendar_connection', 'ical_feed_connection', 'pairing_codes', 'parents', 'record_versions', 'schema_migrations', 'sessions']);
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
      expect(second.preMigrationBackup).toMatch(new RegExp(`pre-migration-v${LATEST_SCHEMA_VERSION}-to-v${LATEST_SCHEMA_VERSION + 1}\\.db$`));
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

  it('upgrades a real Stage A/B (schema v1) database to v2: family data kept, backup taken, no accounts yet', async () => {
    // Build a schema-v1 database exactly as Stage A/B left it, with family data.
    const v1 = openDatabase(path.join(tmp.dir, 'chorechart.db'));
    runMigrations(v1, MIGRATIONS.slice(0, 1));
    const { FamilyStore } = await import('../family/store');
    const oldStore = new FamilyStore(v1, { timeZone: 'UTC' });
    oldStore.initialize();
    oldStore.apply({ type: 'loadDemoFamily', payload: {} }, 'test');
    const before = oldStore.read();
    v1.close();

    const upgraded = await openData(tmp.dir, 'UTC');
    try {
      expect(upgraded.migrated).toEqual([2, 3, 4]);
      expect(upgraded.preMigrationBackup).toMatch(/pre-migration-v1-to-v4\.db$/);
      expect(upgraded.store.read()).toEqual(before);
      expect(upgraded.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM parents')!.n).toBe(0);
      expect(currentSchemaVersion(upgraded.db)).toBe(4);
    } finally {
      upgraded.db.close();
    }
  });

  it('upgrades a v0.4.0 (schema v2) database to v4: family, parents, sessions and devices kept; no calendar connection', async () => {
    const v2 = openDatabase(path.join(tmp.dir, 'chorechart.db'));
    runMigrations(v2, MIGRATIONS.slice(0, 2));
    const { FamilyStore } = await import('../family/store');
    const oldStore = new FamilyStore(v2, { timeZone: 'UTC' });
    oldStore.initialize();
    oldStore.apply({ type: 'loadDemoFamily', payload: {} }, 'test');
    v2.run("INSERT INTO parents (id, username, display_name, password_hash, created_at, password_changed_at) VALUES ('p1', 'sam', 'Sam', 'x', 't', 't')");
    v2.run("INSERT INTO devices (id, name, created_by, created_at) VALUES ('d1', 'Kitchen', 'p1', 't')");
    const before = { family: oldStore.read(), parents: v2.all('SELECT * FROM parents'), devices: v2.all('SELECT * FROM devices') };
    v2.close();

    const upgraded = await openData(tmp.dir, 'UTC');
    try {
      expect(upgraded.migrated).toEqual([3, 4]);
      expect(upgraded.preMigrationBackup).toMatch(/pre-migration-v2-to-v4\.db$/);
      expect(upgraded.store.read()).toEqual(before.family);
      expect(upgraded.db.all('SELECT * FROM parents')).toEqual(before.parents);
      expect(upgraded.db.all('SELECT * FROM devices')).toEqual(before.devices);
      expect(upgraded.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM google_calendar_connection')!.n).toBe(0);
    } finally {
      upgraded.db.close();
    }
  });

  it('allows at most one family calendar connection per installation', () => {
    const db = openDatabase(path.join(tmp.dir, 'a.db'));
    try {
      runMigrations(db);
      const insert = (id: number) =>
        db.run(
          "INSERT INTO google_calendar_connection (id, account_email, refresh_token_enc, key_id, scope, calendar_id, calendar_name, status, connected_at, updated_at) VALUES (?, 'a', 'x', 'k', 's', 'c', 'n', 'connected', 't', 't')",
          id,
        );
      insert(1);
      expect(() => insert(2)).toThrow();
      // …and never a Google connection and an iCal feed at the same time (v4 triggers).
      const insertFeed = () =>
        db.run(
          "INSERT INTO ical_feed_connection (id, url_enc, key_id, provider, host, calendar_name, connected_at, updated_at) VALUES (1, 'x', 'k', 'google', 'calendar.google.com', 'n', 't', 't')",
        );
      expect(insertFeed).toThrow(/already has a Google Calendar connection/);
      db.run('DELETE FROM google_calendar_connection');
      insertFeed();
      expect(() => insert(1)).toThrow(/already has an iCal feed connection/);
      expect(() => insertFeed()).toThrow(); // still one feed at most
    } finally {
      db.close();
    }
  });

  it('upgrades a schema v3 database to v4 keeping its Google Calendar connection exactly', async () => {
    const v3 = openDatabase(path.join(tmp.dir, 'chorechart.db'));
    runMigrations(v3, MIGRATIONS.slice(0, 3));
    const { FamilyStore } = await import('../family/store');
    new FamilyStore(v3, { timeZone: 'UTC' }).initialize();
    v3.run(
      "INSERT INTO google_calendar_connection (id, account_email, refresh_token_enc, key_id, scope, calendar_id, calendar_name, status, connected_at, updated_at) VALUES (1, 'family@example.test', 'v1.sealed', 'k1', 's', 'family@example.test', 'Family', 'connected', '2026-10-24T08:00:00.000Z', '2026-10-24T08:00:00.000Z')",
    );
    const before = v3.all('SELECT * FROM google_calendar_connection');
    v3.close();

    const upgraded = await openData(tmp.dir, 'UTC');
    try {
      expect(upgraded.migrated).toEqual([4]);
      expect(upgraded.preMigrationBackup).toMatch(/pre-migration-v3-to-v4\.db$/);
      expect(upgraded.db.all('SELECT * FROM google_calendar_connection')).toEqual(before);
      expect(upgraded.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ical_feed_connection')!.n).toBe(0);
      const backup = openDatabase(upgraded.preMigrationBackup!, { readOnly: true });
      try {
        expect(currentSchemaVersion(backup)).toBe(3);
        expect(backup.all('SELECT * FROM google_calendar_connection')).toEqual(before);
      } finally {
        backup.close();
      }
    } finally {
      upgraded.db.close();
    }
  });
});
