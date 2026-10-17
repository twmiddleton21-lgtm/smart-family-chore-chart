import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import { openData } from './open';
import { tempDir } from './testUtils';

let tmp: ReturnType<typeof tempDir>;
let app: FastifyInstance;
let closeDb: () => void;

async function start(devUnauthenticatedApi: boolean) {
  const opened = await openData(tmp.dir, 'Europe/London');
  closeDb = () => opened.db.close();
  app = buildApp({ config: { devUnauthenticatedApi, bodyLimit: 64 * 1024, timeZone: 'Europe/London' }, db: opened.db, store: opened.store });
  await app.ready();
  return opened;
}

beforeEach(() => {
  tmp = tempDir();
});
afterEach(async () => {
  await app?.close();
  closeDb?.();
  tmp.cleanup();
});

const post = (payload: unknown, opts: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: '/api/commands', payload: payload as object, ...opts });

describe('health endpoints (always available, no family data)', () => {
  it('/healthz and /readyz report ok', async () => {
    await start(false);
    const h = await app.inject('/healthz');
    expect(h.statusCode).toBe(200);
    expect(h.json()).toEqual({ status: 'ok' });
    const r = await app.inject('/readyz');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'ready', schemaVersion: 1 });
  });

  it('/readyz reports 503 when the database is unavailable', async () => {
    await start(false);
    closeDb();
    closeDb = () => {};
    const r = await app.inject('/readyz');
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ status: 'not_ready', reason: 'database_unavailable' });
  });

  it('sets defensive headers', async () => {
    await start(false);
    const r = await app.inject('/healthz');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
  });
});

describe('default (non-development) mode exposes no family data', () => {
  it.each([
    ['GET', '/api/state'],
    ['POST', '/api/commands'],
    ['GET', '/api/anything'],
  ])('%s %s -> 503', async (method, url) => {
    await start(false);
    const r = await app.inject({ method: method as 'GET', url, payload: method === 'POST' ? { type: 'loadDemoFamily', payload: {} } : undefined });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toBe('api_unavailable');
    expect(r.body).not.toContain('children');
  });

  it('a command sent in default mode changes nothing', async () => {
    const { store } = await start(false);
    await post({ type: 'loadDemoFamily', payload: {} });
    expect(store.read().stateVersion).toBe(1);
  });
});

describe('development API (unauthenticated, loopback only)', () => {
  it('GET /api/state returns the empty household, versions, today and zone, without any PIN', async () => {
    await start(true);
    const r = await app.inject('/api/state');
    expect(r.statusCode).toBe(200);
    expect(r.headers['x-sfcc-dev-mode']).toBe('unauthenticated-loopback-only');
    const body = r.json();
    expect(body).toMatchObject({ stateVersion: 1, recordVersions: {}, timeZone: 'Europe/London' });
    expect(body.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.family.children).toEqual([]);
    expect(r.body).not.toContain('parentPin');
  });

  it('refuses non-loopback clients even in development mode', async () => {
    await start(true);
    const r = await app.inject({ method: 'GET', url: '/api/state', remoteAddress: '192.168.1.50' });
    expect(r.statusCode).toBe(403);
    expect(r.body).not.toContain('family');
  });

  it('applies a valid command and reports the new version and changed records', async () => {
    await start(true);
    const r = await post({ type: 'saveChild', payload: { name: 'Alex', avatar: '🐼', color: 'teal' } });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.stateVersion).toBe(2);
    expect(body.changed).toHaveLength(1);
    expect(body.changed[0]).toMatch(/^child:/);
  });

  it('returns 422 with field errors for invalid values', async () => {
    await start(true);
    const r = await post({ type: 'saveChore', payload: { title: '', icon: '', childId: 'nope', period: 'night', points: -1, scheduleType: 'daily' } });
    expect(r.statusCode).toBe(422);
    expect(r.json()).toMatchObject({ error: 'rejected' });
    expect(Object.keys(r.json().fields)).toEqual(expect.arrayContaining(['title', 'childId', 'period', 'points']));
  });

  it('returns 409 for a stale edit', async () => {
    await start(true);
    await post({ type: 'saveChild', payload: { name: 'Alex', avatar: '🐼', color: 'teal' } });
    const state = (await app.inject('/api/state')).json();
    const id = state.family.children[0].id;
    const v = state.recordVersions[`child:${id}`];
    expect((await post({ type: 'saveChild', expectedVersion: v, payload: { id, name: 'A1', avatar: '🐼', color: 'teal' } })).statusCode).toBe(200);
    const stale = await post({ type: 'saveChild', expectedVersion: v, payload: { id, name: 'A2', avatar: '🐼', color: 'teal' } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: 'conflict', record: `child:${id}` });
  });

  it.each([
    ['unknown command type', { type: 'dropTables', payload: {} }],
    ['missing payload', { type: 'toggleChore' }],
    ['extra top-level field', { type: 'toggleChore', payload: { choreId: 'x' }, admin: true }],
    ['negative expectedVersion', { type: 'deleteChild', payload: { id: 'x' }, expectedVersion: -1 }],
    ['payload not an object', { type: 'toggleChore', payload: 'x' }],
    ['expectedVersion as a string', { type: 'deleteChild', payload: { id: 'x' }, expectedVersion: '3' }],
  ])('rejects %s with 400', async (_label, body) => {
    await start(true);
    const r = await post(body);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('invalid_request');
  });

  it('rejects non-JSON content types with 415', async () => {
    await start(true);
    const r = await app.inject({ method: 'POST', url: '/api/commands', payload: 'type=loadDemoFamily', headers: { 'content-type': 'text/plain' } });
    expect(r.statusCode).toBe(415);
    const form = await app.inject({ method: 'POST', url: '/api/commands', payload: 'a=b', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(form.statusCode).toBe(415);
  });

  it('rejects oversized bodies with 413', async () => {
    await start(true);
    const r = await post({ type: 'saveChild', payload: { name: 'x'.repeat(70 * 1024), avatar: '🐼', color: 'teal' } });
    expect(r.statusCode).toBe(413);
  });

  it('rejects malformed JSON with 400 without leaking internals', async () => {
    await start(true);
    const r = await app.inject({ method: 'POST', url: '/api/commands', payload: '{"type":', headers: { 'content-type': 'application/json' } });
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toMatch(/at .*\.ts|stack/i);
  });

  it('unknown routes return a JSON 404', async () => {
    await start(true);
    const r = await app.inject('/nope');
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: 'not_found', message: 'Not found.' });
  });

  it('many concurrent requests are all applied: no lost updates', async () => {
    const { store } = await start(true);
    const responses = await Promise.all(
      Array.from({ length: 40 }, (_, i) => post({ type: 'saveChild', payload: { name: `Kid ${i}`, avatar: '🐼', color: 'teal' } })),
    );
    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    const versions = responses.map((r) => r.json().stateVersion).sort((a, b) => a - b);
    expect(versions).toEqual(Array.from({ length: 40 }, (_, i) => i + 2)); // each got its own version
    expect(store.read().family.children).toHaveLength(40);
  });
});
