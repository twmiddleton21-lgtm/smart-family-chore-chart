import type { DateKey } from '../../src/types';
import { DATA_VERSION } from '../../src/types';
import type { SqlDatabase } from '../db/database';
import { todayInZone } from '../time';
import { executeCommand, type Command, type CommandError } from './commands';
import { changedRecords, emptyFamily, parseStoredDocument, validateDocument, type FamilyDocument } from './document';

// The authoritative family state for this installation, stored as one
// versioned document in SQLite. Every change runs inside a single write
// transaction (BEGIN IMMEDIATE): read the current state, apply the command
// with the existing business rules, validate, write the next version. Writes
// are therefore serialised: no command can work from a stale copy, so
// updates are never lost.

export interface FamilyState {
  stateVersion: number;
  family: FamilyDocument;
  /** "<kind>:<id>" -> state version that last changed that record. */
  recordVersions: Record<string, number>;
  updatedAt: string;
}

export type ApplyResult =
  | { ok: true; stateVersion: number; changed: string[]; noChange: boolean }
  | CommandError;

export interface StoreOptions {
  timeZone: string;
  now?: () => Date;
  /** TEST ONLY: called after the new state is written, before commit. */
  beforeCommit?: () => void;
}

interface StateRow {
  version: number;
  data: string;
  updated_at: string;
}

export class FamilyStore {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly options: StoreOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  today(): DateKey {
    return todayInZone(this.options.timeZone, this.now());
  }

  /** Create the empty household on first start. Safe to call every start. */
  initialize(): { created: boolean } {
    return this.db.transaction(() => {
      const existing = this.db.get('SELECT version FROM family_state WHERE id = 1');
      if (existing) {
        // Fail loudly at start-up rather than serving corrupt data.
        this.readRow();
        return { created: false };
      }
      const doc = validateDocument(emptyFamily(), true);
      this.db.run(
        'INSERT INTO family_state (id, version, format, data, updated_at) VALUES (1, 1, ?, ?, ?)',
        DATA_VERSION,
        JSON.stringify(doc),
        this.now().toISOString(),
      );
      return { created: true };
    });
  }

  private readRow(): { row: StateRow; doc: FamilyDocument } {
    const row = this.db.get<StateRow & Record<string, unknown>>('SELECT version, data, updated_at FROM family_state WHERE id = 1');
    if (!row) throw new Error('Family state is not initialised.');
    return { row: { version: Number(row.version), data: row.data, updated_at: row.updated_at }, doc: parseStoredDocument(row.data) };
  }

  private recordVersionMap(): Map<string, number> {
    const rows = this.db.all<{ kind: string; record_id: string; version: number }>('SELECT kind, record_id, version FROM record_versions');
    return new Map(rows.map((r) => [`${r.kind}:${r.record_id}`, Number(r.version)]));
  }

  read(): FamilyState {
    const { row, doc } = this.readRow();
    return {
      stateVersion: row.version,
      family: doc,
      recordVersions: Object.fromEntries(this.recordVersionMap()),
      updatedAt: row.updated_at,
    };
  }

  stateVersion(): number {
    return this.readRow().row.version;
  }

  apply(command: Command, actor: string): ApplyResult {
    return this.db.transaction((): ApplyResult => {
      const { row, doc } = this.readRow();
      const versions = this.recordVersionMap();
      const now = this.now();
      const outcome = executeCommand(command, doc, {
        today: todayInZone(this.options.timeZone, now),
        now,
        recordVersion: (key) => versions.get(key) ?? 0,
      });
      if (!outcome.ok) return outcome; // nothing written; the transaction commits empty

      // Defensive: never store something the shared validator would reject.
      const next = validateDocument(JSON.parse(JSON.stringify(outcome.doc)), true);
      const before = JSON.stringify(doc);
      const after = JSON.stringify(next);
      if (before === after) return { ok: true, stateVersion: row.version, changed: [], noChange: true };

      const nextVersion = row.version + 1;
      const changed = changedRecords(doc, next);
      const at = now.toISOString();
      const updated = this.db.run(
        'UPDATE family_state SET version = ?, format = ?, data = ?, updated_at = ? WHERE id = 1 AND version = ?',
        nextVersion,
        DATA_VERSION,
        after,
        at,
        row.version,
      );
      // Belt and braces: the transaction already serialises writers.
      if (updated.changes !== 1) throw new Error('Family state changed during the transaction.');
      for (const key of changed) {
        const split = key.indexOf(':');
        this.db.run(
          `INSERT INTO record_versions (kind, record_id, version) VALUES (?, ?, ?)
           ON CONFLICT (kind, record_id) DO UPDATE SET version = excluded.version`,
          key.slice(0, split),
          key.slice(split + 1),
          nextVersion,
        );
      }
      this.db.run('INSERT INTO command_log (state_version, type, actor, applied_at) VALUES (?, ?, ?, ?)', nextVersion, command.type, actor, at);
      this.options.beforeCommit?.();
      return { ok: true, stateVersion: nextVersion, changed, noChange: false };
    });
  }
}
