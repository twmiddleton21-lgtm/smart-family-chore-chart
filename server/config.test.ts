import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config';
import { tempDir } from './testUtils';
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

  it('Google Calendar: off by default, listing what is missing (names only)', () => {
    const plain = loadConfig({});
    expect(plain.google).toBeUndefined();
    expect(plain.secretKey).toBeUndefined();
    expect(plain.googleMissing).toEqual(['SFCC_GOOGLE_CLIENT_ID', 'SFCC_GOOGLE_CLIENT_SECRET_FILE', 'SFCC_GOOGLE_REDIRECT_URI', 'SFCC_SECRET_KEY_FILE']);
    expect(plain.devCalendarFixture).toBeUndefined();
    expect(plain.calendarFeedHosts).toEqual([]);
  });

  it('SFCC_CALENDAR_FEED_HOSTS: extra public host names for iCal addresses, nothing else', () => {
    expect(loadConfig({ SFCC_CALENDAR_FEED_HOSTS: 'calendar.school.example, Feeds.Club.Example' }).calendarFeedHosts).toEqual([
      'calendar.school.example',
      'feeds.club.example',
    ]);
    for (const bad of ['127.0.0.1', '10.0.0.1', 'localhost', 'intranet', 'x.localhost', 'cal.example:8443', '*.example.com', 'https://cal.example', '[::1]']) {
      expect(() => loadConfig({ SFCC_CALENDAR_FEED_HOSTS: bad }), bad).toThrow(/SFCC_CALENDAR_FEED_HOSTS/);
    }
  });

  describe('Google Calendar settings', () => {
    let dir: string;
    let cleanup: () => void;
    beforeEach(() => ({ dir, cleanup } = tempDir()));
    afterEach(() => cleanup());

    const KEY = Buffer.alloc(32, 7).toString('base64');
    const full = () => {
      writeFileSync(path.join(dir, 'secret.txt'), 'test-client-secret\n');
      writeFileSync(path.join(dir, 'key.txt'), `${KEY}\n`);
      return {
        SFCC_GOOGLE_CLIENT_ID: '123-abc.apps.googleusercontent.com',
        SFCC_GOOGLE_CLIENT_SECRET_FILE: 'secret.txt',
        SFCC_GOOGLE_REDIRECT_URI: 'https://chores.example.com/api/calendar/google/callback',
        SFCC_ALLOWED_HOSTS: 'chores.example.com',
        SFCC_SECRET_KEY_FILE: 'key.txt',
      };
    };

    it('reads secrets from files (trimmed) and is complete when everything is set', () => {
      const c = loadConfig(full(), dir);
      expect(c.google).toEqual({ clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'test-client-secret', redirectUri: 'https://chores.example.com/api/calendar/google/callback' });
      expect(c.secretKey).toEqual(Buffer.alloc(32, 7));
      expect(c.googleMissing).toEqual([]);
    });

    it('partial settings leave Google off and say what is missing', () => {
      const { SFCC_SECRET_KEY_FILE: _k, ...noKey } = full();
      const c = loadConfig(noKey, dir);
      expect(c.google).toBeDefined();
      expect(c.googleMissing).toEqual(['SFCC_SECRET_KEY_FILE']);
    });

    it('accepts http only for localhost redirect URIs, with the exact callback path', () => {
      expect(loadConfig({ ...full(), SFCC_GOOGLE_REDIRECT_URI: 'http://localhost:3000/api/calendar/google/callback' }, dir).google?.redirectUri).toBe(
        'http://localhost:3000/api/calendar/google/callback',
      );
      for (const bad of [
        'http://192.168.1.20:3080/api/calendar/google/callback', // Google refuses plain-HTTP LAN addresses
        'https://chores.example.com/api/calendar/google/callback?x=1',
        'https://chores.example.com/callback',
        'not a url',
      ]) {
        expect(() => loadConfig({ ...full(), SFCC_GOOGLE_REDIRECT_URI: bad }, dir), bad).toThrow(/SFCC_GOOGLE_REDIRECT_URI/);
      }
    });

    it('requires the redirect host in SFCC_ALLOWED_HOSTS (or Google’s redirect back would get 421)', () => {
      expect(() => loadConfig({ ...full(), SFCC_ALLOWED_HOSTS: '' }, dir)).toThrow(/SFCC_ALLOWED_HOSTS/);
    });

    it('rejects a malformed client ID, an unreadable secret file and a weak key', () => {
      expect(() => loadConfig({ ...full(), SFCC_GOOGLE_CLIENT_ID: 'abc' }, dir)).toThrow(/SFCC_GOOGLE_CLIENT_ID/);
      expect(() => loadConfig({ ...full(), SFCC_GOOGLE_CLIENT_SECRET_FILE: 'missing.txt' }, dir)).toThrow(/can't be read/);
      writeFileSync(path.join(dir, 'short.txt'), 'too-short');
      expect(() => loadConfig({ ...full(), SFCC_SECRET_KEY_FILE: 'short.txt' }, dir)).toThrow(/openssl rand -base64 32/);
      expect(loadConfig({ ...full(), SFCC_SECRET_KEY_FILE: '', SFCC_SECRET_KEY: 'ab'.repeat(32) }, dir).secretKey).toHaveLength(32);
    });

    it('never allows the development calendar fixture in production', () => {
      expect(loadConfig({ SFCC_DEV_CALENDAR_FIXTURE: 'cal.json' }, '/srv').devCalendarFixture).toMatch(/cal\.json$/);
      expect(() => loadConfig({ SFCC_DEV_CALENDAR_FIXTURE: 'cal.json', NODE_ENV: 'production' })).toThrow(/development and tests only/);
    });
  });

  it('trusts no reverse proxy by default; SFCC_TRUST_PROXY lists them explicitly', () => {
    expect(loadConfig({}).trustProxy).toEqual([]);
    expect(loadConfig({ SFCC_TRUST_PROXY: '' }).trustProxy).toEqual([]);
    expect(loadConfig({ SFCC_TRUST_PROXY: '172.18.0.0/16, 127.0.0.1,::1,fd00::/8' }).trustProxy).toEqual(['172.18.0.0/16', '127.0.0.1', '::1', 'fd00::/8']);
  });

  it.each(['true', '*', 'all', '1', 'loopback', 'example.com', '10.0.0.0/33', '::/129', '10.0.0.1/8/1', '10.0.0.1,', '300.1.1.1'])(
    'refuses SFCC_TRUST_PROXY=%s (only explicit addresses, never "trust everything")',
    (value) => {
      expect(() => loadConfig({ SFCC_TRUST_PROXY: value })).toThrow(ConfigError);
    },
  );

  it('answers only to loopback names by default; SFCC_ALLOWED_HOSTS adds explicit names', () => {
    expect(loadConfig({}).allowedHosts).toEqual([]);
    expect(loadConfig({ SFCC_ALLOWED_HOSTS: 'Chores.Example.com, 192.168.1.20:3000,[fd00::1]:3000,localhost' }).allowedHosts).toEqual([
      'chores.example.com',
      '192.168.1.20:3000',
      '[fd00::1]:3000',
      'localhost',
    ]);
  });

  it.each(['*', '*.example.com', 'https://chores.example.com', 'chores.example.com/path', 'a b', 'example.com:0', 'example.com:70000', '-bad.example', 'fd00::1', 'chores.example.com,', '1.2.3'])(
    'refuses SFCC_ALLOWED_HOSTS=%s',
    (value) => {
      expect(() => loadConfig({ SFCC_ALLOWED_HOSTS: value })).toThrow(ConfigError);
    },
  );

  it('refuses a trusted proxy together with the development API', () => {
    expect(() => loadConfig({ SFCC_DEV_UNAUTHENTICATED_API: '1', SFCC_TRUST_PROXY: '127.0.0.1' })).toThrow(/SFCC_TRUST_PROXY/);
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
