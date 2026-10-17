import { existsSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { completeChore } from '../src/lib/chores';
import { makeFamily } from '../src/lib/testFixtures';
import { buildApp } from './app';
import { AuthService } from './auth/service';
import { backupDir, listBackups } from './db/backup';
import { FamilyStore } from './family/store';
import { openData } from './open';
import { tempDir } from './testUtils';

let tmp: ReturnType<typeof tempDir>;
let app: FastifyInstance;
let opened: Awaited<ReturnType<typeof openData>>;

async function start(devUnauthenticatedApi = true) {
  opened = await openData(tmp.dir, 'Europe/London');
  app = buildApp({
    config: { devUnauthenticatedApi, bodyLimit: 64 * 1024, timeZone: 'Europe/London', port: 80, dataDir: tmp.dir },
    db: opened.db,
    store: opened.store,
    auth: devUnauthenticatedApi ? undefined : new AuthService(opened.db),
  });
  await app.ready();
}

beforeEach(() => {
  tmp = tempDir();
});
afterEach(async () => {
  await app?.close();
  opened?.db.close();
  tmp.cleanup();
});

function browserData() {
  const r = completeChore(makeFamily(), 'a-bed', '2026-10-12');
  if (!r.ok) throw new Error(r.error);
  return JSON.parse(JSON.stringify(r.data));
}

const preview = (data: unknown) => app.inject({ method: 'POST', url: '/api/import/preview', payload: { data } as object });
const apply = (body: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/import/apply', payload: body });

describe('import preview', () => {
  it('summarises without changing anything', async () => {
    await start();
    const r = await preview(browserData());
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.summary.counts.children).toBe(2);
    expect(body.summary.pinIgnored).toBe(true);
    expect(body.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(body.server).toEqual({ stateVersion: 1, empty: true });
    expect(opened.store.read().stateVersion).toBe(1);
    expect(listBackups(tmp.dir)).toEqual([]);
  });

  it('rejects an invalid file with 422 and a clear message', async () => {
    await start();
    const r = await preview({ version: 3, settings: {} });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toMatchObject({ error: 'invalid_file' });
  });
});

describe('import apply', () => {
  it('imports into an empty server, after a backup, without needing "replace"', async () => {
    await start();
    const data = browserData();
    const p = (await preview(data)).json();
    const r = await apply({ data, checksum: p.checksum, expectedStateVersion: 1, replace: false });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ stateVersion: 2 });
    expect(r.json().backup).toMatch(/^chorechart-.*-pre-import\.db$/);
    expect(existsSync(path.join(backupDir(tmp.dir), r.json().backup))).toBe(true);
    const s = opened.store.read();
    expect(s.family.children.map((c) => c.name)).toEqual(['Alex', 'Bea']);
    expect(s.family.completions).toHaveLength(1);
    expect(JSON.stringify(s.family)).not.toContain('parentPin');
    // Every imported record gets the new version.
    expect(s.recordVersions['child:a']).toBe(2);
  });

  it('refuses to overwrite a populated server unless "replace" is confirmed, and makes no backup when refusing', async () => {
    await start();
    opened.store.apply({ type: 'loadDemoFamily', payload: {} }, 'test');
    const before = opened.store.read();
    const data = browserData();
    const p = (await preview(data)).json();
    expect(p.server.empty).toBe(false);

    const refused = await apply({ data, checksum: p.checksum, expectedStateVersion: before.stateVersion, replace: false });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('server_not_empty');
    expect(opened.store.read()).toEqual(before);
    expect(listBackups(tmp.dir)).toEqual([]);

    const replaced = await apply({ data, checksum: p.checksum, expectedStateVersion: before.stateVersion, replace: true });
    expect(replaced.statusCode).toBe(200);
    expect(opened.store.read().family.children.map((c) => c.name)).toEqual(['Alex', 'Bea']);
    // The backup holds the replaced demo family.
    expect(listBackups(tmp.dir)).toHaveLength(1);
  });

  it('refuses if the data changed since the preview', async () => {
    await start();
    const data = browserData();
    const p = (await preview(data)).json();
    opened.store.apply({ type: 'saveChild', payload: { name: 'Zed', avatar: '🐼', color: 'teal' } }, 'test');
    const r = await apply({ data, checksum: p.checksum, expectedStateVersion: 1, replace: true });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('changed_since_preview');
    expect(opened.store.read().family.children.map((c) => c.name)).toEqual(['Zed']);
  });

  it('refuses data that differs from the previewed file (checksum binding)', async () => {
    await start();
    const data = browserData();
    const p = (await preview(data)).json();
    data.children[0].name = 'Changed after preview';
    const r = await apply({ data, checksum: p.checksum, expectedStateVersion: 1, replace: false });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('checksum_mismatch');
    expect(opened.store.read().stateVersion).toBe(1);
  });

  it('rejects invalid data at apply time too, changing nothing', async () => {
    await start();
    const bad = browserData();
    bad.chores.push({ id: 'x', childId: 'a', title: '', icon: '', points: -1, period: 'night', schedule: { type: 'daily' } });
    const r = await apply({ data: bad, checksum: 'a'.repeat(64), expectedStateVersion: 1, replace: true });
    expect(r.statusCode).toBe(422);
    expect(opened.store.read().stateVersion).toBe(1);
    expect(listBackups(tmp.dir)).toEqual([]);
  });

  it.each([
    ['missing replace flag', { checksum: 'a'.repeat(64), expectedStateVersion: 1 }],
    ['bad checksum format', { checksum: 'nope', expectedStateVersion: 1, replace: false }],
    ['extra field', { checksum: 'a'.repeat(64), expectedStateVersion: 1, replace: false, force: true }],
    ['string replace flag', { checksum: 'a'.repeat(64), expectedStateVersion: 1, replace: 'yes' }],
  ])('rejects a malformed apply request (%s) with 400', async (_label, rest) => {
    await start();
    const r = await apply({ data: browserData(), ...rest });
    expect(r.statusCode).toBe(400);
    expect(opened.store.read().stateVersion).toBe(1);
  });

  it('is all-or-nothing: a failure inside the transaction leaves the old data', async () => {
    await start();
    const failing = new FamilyStore(opened.db, {
      timeZone: 'UTC',
      beforeCommit: () => {
        throw new Error('simulated crash');
      },
    });
    const parsed = (await preview(browserData())).json();
    expect(parsed.summary).toBeTruthy();
    const { parseImport } = await import('./family/importer');
    const imp = parseImport(browserData());
    if (!imp.ok) throw new Error('setup');
    expect(() => failing.importDocument(imp.doc, { expectedStateVersion: 1, replace: true }, 'test')).toThrow('simulated crash');
    const s = opened.store.read();
    expect(s.stateVersion).toBe(1);
    expect(s.family.children).toEqual([]);
    expect(s.recordVersions).toEqual({});
  });

  it('accepts larger imports than ordinary commands (up to 5 MB)', async () => {
    await start();
    const data = browserData();
    // ~200 KB of valid history: well above the 64 KB command limit.
    for (let i = 0; i < 1500; i++) {
      const d = new Date(Date.UTC(2022, 0, 1) + i * 86400000).toISOString().slice(0, 10);
      data.completions.push({ id: `h${i}`, choreId: 'a-bed', childId: 'a', date: d, points: 5, completedAt: '2026-01-01T00:00:00.000Z' });
    }
    expect(JSON.stringify(data).length).toBeGreaterThan(64 * 1024);
    const r = await preview(data);
    expect(r.statusCode).toBe(200);
    expect(r.json().summary.counts.completions).toBe(1501);
  });
});

describe('export', () => {
  it('exports the server data without any PIN, and it re-imports identically', async () => {
    await start();
    opened.store.apply({ type: 'loadDemoFamily', payload: {} }, 'test');
    const r = await app.inject('/api/export');
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-disposition']).toMatch(/^attachment; filename="chore-chart-export-\d{4}-\d{2}-\d{2}\.json"$/);
    const file = r.json();
    expect(file).toMatchObject({ app: 'smart-family-chore-chart', exportFormat: 1, source: 'server' });
    expect(r.body).not.toContain('parentPin');
    const p = (await preview(file)).json();
    expect(p.summary.counts.children).toBe(3);
    expect(p.summary.pinIgnored).toBe(false);
  });
});

describe('normal mode keeps import/export closed without a signed-in parent', () => {
  it.each([
    ['GET', '/api/export'],
    ['POST', '/api/import/preview'],
    ['POST', '/api/import/apply'],
  ])('%s %s -> 401', async (method, url) => {
    await start(false);
    const r = await app.inject({ method: method as 'GET', url, payload: method === 'POST' ? { data: browserData() } : undefined });
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe('unauthenticated');
    expect(r.body).not.toContain('children');
    expect(opened.store.read().stateVersion).toBe(1);
  });
});
