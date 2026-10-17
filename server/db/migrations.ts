import type { SqlDatabase } from './database';

// Numbered, append-only schema migrations. Never edit a released migration;
// add a new one. Each runs in its own transaction together with its
// schema_migrations row, so a failure leaves the database at the previous
// version.

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'family state, record versions and command log',
    sql: `
      -- The single authoritative family document for this installation.
      CREATE TABLE family_state (
        id          INTEGER PRIMARY KEY CHECK (id = 1),
        version     INTEGER NOT NULL CHECK (version >= 1),
        format      INTEGER NOT NULL,          -- FamilyData format version (src/types.ts)
        data        TEXT    NOT NULL,          -- JSON, without the legacy client-side PIN
        updated_at  TEXT    NOT NULL
      );

      -- Which state version last changed each editable record, used to
      -- detect conflicting edits from different devices.
      CREATE TABLE record_versions (
        kind        TEXT    NOT NULL,
        record_id   TEXT    NOT NULL,
        version     INTEGER NOT NULL,
        PRIMARY KEY (kind, record_id)
      );

      -- Minimal audit trail of applied commands (no request payloads).
      CREATE TABLE command_log (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        state_version  INTEGER NOT NULL,
        type           TEXT    NOT NULL,
        actor          TEXT    NOT NULL,
        applied_at     TEXT    NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: 'parent accounts, sessions, paired devices and pairing codes',
    sql: `
      -- Parent accounts. Passwords are stored only as scrypt hashes.
      CREATE TABLE parents (
        id                   TEXT PRIMARY KEY,
        username             TEXT NOT NULL UNIQUE COLLATE NOCASE,
        display_name         TEXT NOT NULL,
        password_hash        TEXT NOT NULL,
        created_at           TEXT NOT NULL,
        password_changed_at  TEXT NOT NULL
      );

      -- Household devices (e.g. a kiosk) paired by a parent.
      CREATE TABLE devices (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        created_by    TEXT REFERENCES parents(id) ON DELETE SET NULL,
        created_at    TEXT NOT NULL,
        last_seen_at  TEXT
      );

      -- Sessions. Only a SHA-256 hash of the random token is stored; the
      -- token itself lives only in the browser's HttpOnly cookie.
      CREATE TABLE sessions (
        token_hash           TEXT PRIMARY KEY,
        kind                 TEXT NOT NULL CHECK (kind IN ('parent', 'device')),
        parent_id            TEXT REFERENCES parents(id) ON DELETE CASCADE,
        device_id            TEXT REFERENCES devices(id) ON DELETE CASCADE,
        remember             INTEGER NOT NULL DEFAULT 0,
        created_at           TEXT NOT NULL,
        last_used_at         TEXT NOT NULL,
        idle_expires_at      TEXT NOT NULL,
        absolute_expires_at  TEXT NOT NULL,
        CHECK ((kind = 'parent' AND parent_id IS NOT NULL AND device_id IS NULL)
            OR (kind = 'device' AND device_id IS NOT NULL AND parent_id IS NULL))
      );
      CREATE INDEX sessions_by_parent ON sessions(parent_id);
      CREATE INDEX sessions_by_device ON sessions(device_id);

      -- One-time pairing codes (hashed), created by a signed-in parent.
      CREATE TABLE pairing_codes (
        code_hash    TEXT PRIMARY KEY,
        device_name  TEXT NOT NULL,
        created_by   TEXT NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
        created_at   TEXT NOT NULL,
        expires_at   TEXT NOT NULL,
        used_at      TEXT
      );
    `,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export class SchemaTooNewError extends Error {
  constructor(public readonly found: number, public readonly supported: number) {
    super(
      `The database schema is version ${found}, but this app only supports up to ${supported}. ` +
        'It was probably created by a newer release. Refusing to start to protect your data.',
    );
  }
}

function ensureMigrationsTable(db: SqlDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT    NOT NULL,
      applied_at  TEXT    NOT NULL
    );
  `);
}

/** Highest applied migration, or 0 for a new database. Never writes. */
export function currentSchemaVersion(db: SqlDatabase): number {
  const table = db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'");
  if (!table) return 0;
  const row = db.get<{ v: number | null }>('SELECT MAX(version) AS v FROM schema_migrations');
  return Number(row?.v ?? 0);
}

export function pendingMigrations(db: SqlDatabase, migrations: readonly Migration[] = MIGRATIONS): Migration[] {
  ensureMigrationsTable(db);
  const current = currentSchemaVersion(db);
  const latest = migrations.length ? migrations[migrations.length - 1]!.version : 0;
  if (current > latest) throw new SchemaTooNewError(current, latest);
  return migrations.filter((m) => m.version > current);
}

/** Apply all pending migrations in order. Returns the versions applied. */
export function runMigrations(
  db: SqlDatabase,
  migrations: readonly Migration[] = MIGRATIONS,
  now: () => Date = () => new Date(),
): number[] {
  const applied: number[] = [];
  for (const m of pendingMigrations(db, migrations)) {
    db.transaction(() => {
      db.exec(m.sql);
      db.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', m.version, m.name, now().toISOString());
    });
    applied.push(m.version);
  }
  return applied;
}
