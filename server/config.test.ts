import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config';
import { todayInZone } from './time';

describe('configuration', () => {
  it('has safe defaults: loopback, API disabled, data dir under cwd', () => {
    const c = loadConfig({}, '/srv/app');
    expect(c).toMatchObject({ host: '127.0.0.1', port: 3000, devUnauthenticatedApi: false, timeZone: 'UTC', production: false });
    expect(c.dataDir).toBe(path.resolve('/srv/app', 'data'));
  });

  it('reads data dir, port and household time zone', () => {
    const c = loadConfig({ SFCC_DATA_DIR: '/data', SFCC_PORT: '8080', SFCC_TIMEZONE: 'Europe/London' }, '/x');
    expect(c).toMatchObject({ dataDir: path.resolve('/data'), port: 8080, timeZone: 'Europe/London' });
  });

  it('falls back to TZ for the household time zone', () => {
    expect(loadConfig({ TZ: 'America/New_York' }).timeZone).toBe('America/New_York');
  });

  it.each([['SFCC_TIMEZONE', 'Mars/Olympus'], ['SFCC_PORT', 'abc'], ['SFCC_PORT', '70000']])('rejects invalid %s=%s', (key, value) => {
    expect(() => loadConfig({ [key]: value })).toThrow(ConfigError);
  });

  it('allows the development API only on loopback and never in production', () => {
    expect(loadConfig({ SFCC_DEV_UNAUTHENTICATED_API: '1' }).devUnauthenticatedApi).toBe(true);
    expect(loadConfig({ SFCC_DEV_UNAUTHENTICATED_API: '1', SFCC_HOST: '::1' }).devUnauthenticatedApi).toBe(true);
    expect(() => loadConfig({ SFCC_DEV_UNAUTHENTICATED_API: '1', SFCC_HOST: '0.0.0.0' })).toThrow(/loopback/);
    expect(() => loadConfig({ SFCC_DEV_UNAUTHENTICATED_API: '1', SFCC_HOST: '192.168.1.10' })).toThrow(/loopback/);
    expect(() => loadConfig({ SFCC_DEV_UNAUTHENTICATED_API: '1', NODE_ENV: 'production' })).toThrow(/production/);
  });

  it('only the exact value "1" enables the development API', () => {
    for (const v of ['true', 'yes', '0', '']) expect(loadConfig({ SFCC_DEV_UNAUTHENTICATED_API: v }).devUnauthenticatedApi).toBe(false);
  });
});

describe('household date', () => {
  it('computes today in the household zone', () => {
    const t = new Date('2026-10-13T23:30:00Z');
    expect(todayInZone('UTC', t)).toBe('2026-10-13');
    expect(todayInZone('Europe/London', t)).toBe('2026-10-14'); // BST, UTC+1
    expect(todayInZone('America/Los_Angeles', t)).toBe('2026-10-13');
  });

  it('handles the end of British Summer Time (25 Oct 2026)', () => {
    expect(todayInZone('Europe/London', new Date('2026-10-24T23:30:00Z'))).toBe('2026-10-25'); // still BST
    expect(todayInZone('Europe/London', new Date('2026-10-25T23:30:00Z'))).toBe('2026-10-25'); // GMT now
  });
});
