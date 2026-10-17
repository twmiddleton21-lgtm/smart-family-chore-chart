import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { AuthService } from './auth/service';
import { loadConfig } from './config';
import { openData } from './open';
import { tempDir } from './testUtils';

// Production: the same server serves the built app at / and the API at /api.

let tmp: ReturnType<typeof tempDir>;
let app: FastifyInstance;
let opened: Awaited<ReturnType<typeof openData>>;
let staticDir: string;

beforeEach(async () => {
  tmp = tempDir();
  staticDir = path.join(tmp.dir, 'app');
  mkdirSync(path.join(staticDir, 'assets'), { recursive: true });
  writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>Chore chart</title>');
  writeFileSync(path.join(staticDir, 'assets', 'app-123.js'), 'console.log(1)');
  writeFileSync(path.join(staticDir, '.secret'), 'nope');
  // A file outside the folder that must never be reachable.
  writeFileSync(path.join(tmp.dir, 'outside.txt'), 'private');
  opened = await openData(path.join(tmp.dir, 'data'), 'UTC');
});
afterEach(async () => {
  await app?.close();
  opened?.db.close();
  tmp.cleanup();
});

async function start(withStatic: boolean) {
  app = buildApp({
    config: { devUnauthenticatedApi: false, bodyLimit: 64 * 1024, timeZone: 'UTC', port: 3000, dataDir: tmp.dir, ...(withStatic ? { staticDir } : {}) },
    db: opened.db,
    store: opened.store,
    auth: new AuthService(opened.db),
  });
  await app.ready();
}

describe('serving the app', () => {
  it('serves index.html at / with the security headers, without signing in', async () => {
    await start(true);
    const r = await app.inject({ url: '/' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/html/);
    expect(r.body).toContain('<title>Chore chart</title>');
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('serves built assets with the right type', async () => {
    await start(true);
    const r = await app.inject({ url: '/assets/app-123.js' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/javascript/);
  });

  it('family data still needs a sign-in; unknown /api paths are JSON 404s, never files', async () => {
    await start(true);
    expect((await app.inject({ url: '/api/state' })).statusCode).toBe(401);
    const missing = await app.inject({ url: '/api/nothing-here' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'not_found', message: 'Not found.' });
    expect((await app.inject({ url: '/api' })).statusCode).toBe(404);
  });

  it.each(['/../outside.txt', '/%2e%2e/outside.txt', '/assets/..%2f..%2foutside.txt', '/.secret', '/assets/%2e%2e/.secret', '/missing.js'])(
    'refuses %s',
    async (url) => {
      await start(true);
      const r = await app.inject({ url });
      expect(r.statusCode).toBeGreaterThanOrEqual(400);
      expect(r.body).not.toContain('private');
      expect(r.body).not.toContain('nope');
    },
  );

  it('state-changing requests to app paths are still checked and never served', async () => {
    await start(true);
    expect((await app.inject({ method: 'POST', url: '/', payload: {}, headers: { origin: 'https://evil.example' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/', payload: {} })).statusCode).toBe(404);
  });

  it('without SFCC_STATIC_DIR the server is API only, as before', async () => {
    await start(false);
    expect((await app.inject({ url: '/' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/assets/app-123.js' })).statusCode).toBe(404);
  });

  it('SFCC_STATIC_DIR is read from the environment (resolved), unset by default', () => {
    expect(loadConfig({}).staticDir).toBeUndefined();
    expect(loadConfig({ SFCC_STATIC_DIR: 'dist-app' }, '/srv/app').staticDir).toBe(path.resolve('/srv/app', 'dist-app'));
  });
});
