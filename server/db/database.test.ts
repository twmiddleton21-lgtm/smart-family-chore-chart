import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../testUtils';
import { openDatabase, type SqlDatabase } from './database';

let tmp: ReturnType<typeof tempDir>;
const open: SqlDatabase[] = [];
const db = (options = {}) => {
  const d = openDatabase(path.join(tmp.dir, 'test.db'), options);
  open.push(d);
  return d;
};

beforeEach(() => {
  tmp = tempDir();
});
afterEach(() => {
  for (const d of open.splice(0)) {
    try {
      d.close();
    } catch {
      // already closed
    }
  }
  tmp.cleanup();
});

describe('database module', () => {
  it('uses WAL journal mode, full sync and foreign keys', () => {
    const d = db();
    expect(d.get<{ journal_mode: string }>('PRAGMA journal_mode')?.journal_mode).toBe('wal');
    expect(Number(d.get<{ synchronous: number }>('PRAGMA synchronous')?.synchronous)).toBe(2); // FULL
    expect(Number(d.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys)).toBe(1);
  });

  it('commits a transaction when the function returns', () => {
    const d = db();
    d.exec('CREATE TABLE t (v INTEGER)');
    d.transaction(() => d.run('INSERT INTO t VALUES (1)'));
    expect(d.all('SELECT v FROM t')).toEqual([{ v: 1 }]);
  });

  it('rolls back every statement when the function throws', () => {
    const d = db();
    d.exec('CREATE TABLE t (v INTEGER)');
    expect(() =>
      d.transaction(() => {
        d.run('INSERT INTO t VALUES (1)');
        d.run('INSERT INTO t VALUES (2)');
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(d.all('SELECT v FROM t')).toEqual([]);
  });

  it('rolls back when a constraint fails part-way through', () => {
    const d = db();
    d.exec('CREATE TABLE t (v INTEGER UNIQUE)');
    expect(() =>
      d.transaction(() => {
        d.run('INSERT INTO t VALUES (1)');
        d.run('INSERT INTO t VALUES (1)');
      }),
    ).toThrow();
    expect(d.all('SELECT v FROM t')).toEqual([]);
    // The connection is still usable afterwards.
    d.transaction(() => d.run('INSERT INTO t VALUES (5)'));
    expect(d.all('SELECT v FROM t')).toEqual([{ v: 5 }]);
  });

  it('rejects nested transactions', () => {
    const d = db();
    expect(() => d.transaction(() => d.transaction(() => 1))).toThrow(/Nested/);
  });

  it('a second connection cannot write while the first holds the write lock', () => {
    const a = db();
    a.exec('CREATE TABLE t (v INTEGER)');
    const b = db({ busyTimeoutMs: 0 });
    a.transaction(() => {
      a.run('INSERT INTO t VALUES (1)');
      // b must not be able to start a write transaction meanwhile.
      expect(() => b.transaction(() => b.run('INSERT INTO t VALUES (2)'))).toThrow(/locked|busy/i);
      // b can still read the last committed state (WAL readers are not blocked).
      expect(b.all('SELECT v FROM t')).toEqual([]);
    });
    expect(b.all('SELECT v FROM t')).toEqual([{ v: 1 }]);
  });

  it('opens read-only without changing the file', () => {
    const a = db();
    a.exec('CREATE TABLE t (v INTEGER)');
    a.close();
    open.pop();
    const ro = db({ readOnly: true });
    expect(() => ro.exec('INSERT INTO t VALUES (1)')).toThrow(/readonly|read-only/i);
  });
});
