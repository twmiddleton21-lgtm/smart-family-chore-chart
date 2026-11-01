import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultCelebrationSettings } from '../src/lib/celebrations';
import { buildApp } from './app';
import { AuthService } from './auth/service';
import { openDatabase } from './db/database';
import { FamilyStore } from './family/store';
import { databasePath, openData } from './open';
import { tempDir } from './testUtils';

// Seasonal themes, birthdays and the once-only birthday reward, through the
// real HTTP API with sign-in on: parents configure, paired devices claim.

const PASSWORD = 'correct horse battery';
// 23:30 UTC on 30 October is already 31 October in Auckland, but still 30
// October in London: "today" must follow the household time zone.
const NOW = new Date('2026-10-30T23:30:00Z');

let tmp: ReturnType<typeof tempDir>;
let app: FastifyInstance;
let opened: Awaited<ReturnType<typeof openData>>;
let setupCode: string;

async function start(timeZone = 'Europe/London', now = NOW) {
  opened = await openData(tmp.dir, timeZone);
  const auth = new AuthService(opened.db, { now: () => now });
  setupCode = auth.prepareSetup()!;
  const store = new FamilyStore(opened.db, { timeZone, now: () => now });
  app = buildApp({
    config: { devUnauthenticatedApi: false, bodyLimit: 64 * 1024, timeZone, port: 80, dataDir: tmp.dir, cookieSecure: 'auto' },
    db: opened.db,
    store,
    auth,
  });
  await app.ready();
}
async function stop() {
  await app?.close();
  opened?.db.close();
}

beforeEach(() => {
  tmp = tempDir();
});
afterEach(async () => {
  await stop();
  tmp.cleanup();
});

type Jar = Record<string, string>;
async function req(jar: Jar | null, opts: InjectOptions): Promise<LightMyRequestResponse> {
  const r = await app.inject({ ...opts, cookies: { ...(jar ?? {}), ...(opts.cookies ?? {}) } });
  if (jar) for (const c of r.cookies as { name: string; value: string }[]) jar[c.name] = c.value;
  return r;
}
const post = (jar: Jar | null, url: string, payload: object = {}) => req(jar, { method: 'POST', url, payload });
const get = (jar: Jar | null, url: string) => req(jar, { method: 'GET', url });
const command = (jar: Jar | null, type: string, payload: object, expectedVersion?: number) =>
  post(jar, '/api/commands', { type, payload, ...(expectedVersion === undefined ? {} : { expectedVersion }) });

async function parent(): Promise<Jar> {
  const jar: Jar = {};
  const r = await post(jar, '/api/auth/setup', { setupCode, username: 'sam', displayName: 'Sam', password: PASSWORD });
  expect(r.statusCode).toBe(200);
  return jar;
}
async function kiosk(parentJar: Jar, name = 'Kitchen kiosk'): Promise<Jar> {
  const code = (await post(parentJar, '/api/devices/pairing-codes', { name })).json().code as string;
  const jar: Jar = {};
  expect((await post(jar, '/api/devices/pair', { code })).statusCode).toBe(200);
  return jar;
}
async function state(jar: Jar) {
  const r = await get(jar, '/api/state');
  expect(r.statusCode).toBe(200);
  return r.json();
}
/** A household with Maya (birthday today, 30 October, +50 and a gift) and Leo. */
async function household() {
  const p = await parent();
  expect((await command(p, 'saveChild', { name: 'Maya', avatar: '🦄', color: 'pink' })).statusCode).toBe(200);
  expect((await command(p, 'saveChild', { name: 'Leo', avatar: '🦖', color: 'teal' })).statusCode).toBe(200);
  const s = await state(p);
  const [maya, leo] = s.family.children as { id: string }[];
  const saved = await command(p, 'saveBirthday', { childId: maya!.id, month: 10, day: 30, rewardEnabled: true, points: 50, gift: 'Cinema trip' }, 0);
  expect(saved.statusCode).toBe(200);
  return { p, maya: maya!.id, leo: leo!.id };
}

describe('access control', () => {
  it('lets only signed-in parents change themes and birthdays', async () => {
    await start();
    const { p, maya } = await household();
    const k = await kiosk(p);
    const settings = defaultCelebrationSettings();
    for (const [type, payload] of [
      ['saveCelebrationSettings', { settings }],
      ['saveBirthday', { childId: maya, month: 1, day: 1, rewardEnabled: false, points: 0, gift: '' }],
      ['removeBirthday', { childId: maya }],
    ] as const) {
      expect((await command(k, type, payload, 1)).statusCode).toBe(403);
      expect((await command(null, type, payload, 1)).statusCode).toBe(401);
    }
    expect((await command(null, 'claimBirthdayReward', { childId: maya })).statusCode).toBe(401);
    expect((await get(null, '/api/state')).statusCode).toBe(401);
  });

  it('keeps birthdays and reward settings away from paired devices', async () => {
    await start();
    const { p, maya } = await household();
    const k = await kiosk(p);
    const forKiosk = await state(k);
    expect(forKiosk.family.birthdays).toEqual([]);
    expect(JSON.stringify(forKiosk)).not.toContain('Cinema trip');
    expect(forKiosk.birthdaysToday).toEqual([{ childId: maya, rewardEnabled: true, claimed: false }]);
    const forParent = await state(p);
    expect(forParent.family.birthdays).toEqual([{ childId: maya, month: 10, day: 30, reward: { enabled: true, points: 50, gift: 'Cinema trip' } }]);
    // Parents' exports keep them (a full backup of the family).
    expect((await get(p, '/api/export')).json().data.birthdays).toHaveLength(1);
    expect((await get(k, '/api/export')).statusCode).toBe(403);
  });

  it('never lets a paired device work out a birthday afterwards, while parents keep the full records', async () => {
    await start();
    const { p, maya } = await household();
    const k = await kiosk(p);
    expect((await command(k, 'claimBirthdayReward', { childId: maya })).json().noChange).toBe(false);
    expect((await command(k, 'claimBirthdayReward', { childId: maya })).json().noChange).toBe(true); // once per year

    // Two weeks later: nothing in the kiosk's view points to 30 October.
    await stop();
    await start('Europe/London', new Date('2026-11-13T12:00:00Z'));
    const later = await state(k);
    expect(later.today).toBe('2026-11-13');
    expect(later.birthdaysToday).toEqual([]);
    expect(later.family.birthdays).toEqual([]);
    expect(later.family.bonusAwards).toEqual([{ id: expect.any(String), childId: maya, kind: 'birthday', year: 2026, points: 50, note: 'Cinema trip' }]);
    expect(Object.keys(later.recordVersions).filter((key) => key.startsWith('birthday:'))).toEqual([]);
    expect(Object.keys(later.recordVersions)).toContain(`child:${maya}`); // other records keep their versions
    const text = JSON.stringify(later);
    for (const clue of ['10-30', '2026-10-30', '23:30', NOW.toISOString(), '"date"', 'awardedAt', '"month"', '"day"']) expect(text).not.toContain(clue);

    // The balance is the same for the kiosk and for a parent: 50 birthday points.
    const login = await post({}, '/api/auth/login', { username: 'sam', password: PASSWORD });
    expect(login.statusCode).toBe(200);
    const p2: Jar = {};
    for (const c of login.cookies as { name: string; value: string }[]) p2[c.name] = c.value;
    const full = await state(p2);
    const bonus = (s: { family: { bonusAwards: { childId: string; points: number }[] } }) =>
      s.family.bonusAwards.filter((a) => a.childId === maya).reduce((sum, a) => sum + a.points, 0);
    expect(bonus(later)).toBe(50);
    expect(bonus(full)).toBe(50);
    // Parents still see everything: the birthday, the award's day and time, and the record version.
    expect(full.family.birthdays).toEqual([expect.objectContaining({ childId: maya, month: 10, day: 30 })]);
    expect(full.family.bonusAwards).toEqual([expect.objectContaining({ date: '2026-10-30', awardedAt: NOW.toISOString(), year: 2026 })]);
    expect(full.recordVersions[`birthday:${maya}`]).toBeGreaterThan(0);
    expect((await get(p2, '/api/export')).json().data.bonusAwards[0]).toMatchObject({ date: '2026-10-30', awardedAt: NOW.toISOString() });
    // And can still edit the birthday with the version they were given.
    const edit = await command(p2, 'saveBirthday', { childId: maya, month: 10, day: 30, rewardEnabled: true, points: 60, gift: '' }, full.recordVersions[`birthday:${maya}`]);
    expect(edit.statusCode).toBe(200);
  });

  it('checks settings sent by a parent and refuses stale edits', async () => {
    await start();
    const { p } = await household();
    const settings = defaultCelebrationSettings();
    settings.themes.halloween.enabled = false;
    expect((await command(p, 'saveCelebrationSettings', { settings })).statusCode).toBe(400); // no expectedVersion
    expect((await command(p, 'saveCelebrationSettings', { settings: { ...settings, themes: {} } }, 0)).statusCode).toBe(400);
    const bad = { ...settings, themes: { ...settings.themes, christmas: { enabled: true, custom: { startOffset: 0, endOffset: -3 } } } };
    expect((await command(p, 'saveCelebrationSettings', { settings: bad }, 0)).statusCode).toBe(400);
    expect((await command(p, 'saveCelebrationSettings', { settings }, 0)).statusCode).toBe(200);
    expect((await command(p, 'saveCelebrationSettings', { settings }, 0)).statusCode).toBe(409); // stale
    const s = await state(p);
    expect(s.family.celebrations.themes.halloween.enabled).toBe(false);
    expect(s.recordVersions['celebrations:household']).toBeGreaterThan(0);
  });

  it('rejects impossible birthdays', async () => {
    await start();
    const { p, leo } = await household();
    const r = await command(p, 'saveBirthday', { childId: leo, month: 2, day: 30, rewardEnabled: true, points: 10, gift: '' }, 0);
    expect(r.statusCode).toBe(422);
    expect((await command(p, 'saveBirthday', { childId: 'nobody', month: 2, day: 3, rewardEnabled: false, points: 0, gift: '' }, 0)).statusCode).toBe(404);
  });
});

describe('birthday reward', () => {
  it('is given once by the first device to claim it, and shows in the points and history', async () => {
    await start();
    const { p, maya } = await household();
    const k = await kiosk(p);
    const first = await command(k, 'claimBirthdayReward', { childId: maya });
    expect(first.statusCode).toBe(200);
    expect(first.json().noChange).toBe(false);
    const again = await command(k, 'claimBirthdayReward', { childId: maya });
    expect(again.json().noChange).toBe(true);

    const s = await state(k);
    expect(s.birthdaysToday).toEqual([{ childId: maya, rewardEnabled: true, claimed: true }]);
    // The kiosk sees the award by year, without the day it was given (see the privacy test below).
    expect(s.family.bonusAwards).toEqual([{ id: expect.any(String), childId: maya, kind: 'birthday', year: 2026, points: 50, note: 'Cinema trip' }]);
    expect((await state(p)).family.bonusAwards).toEqual([
      expect.objectContaining({ childId: maya, kind: 'birthday', year: 2026, date: '2026-10-30', points: 50, note: 'Cinema trip', awardedAt: NOW.toISOString() }),
    ]);
    const log = opened.db.all<{ type: string; actor: string }>("SELECT type, actor FROM command_log WHERE type = 'claimBirthdayReward'");
    expect(log).toHaveLength(1);
    expect(log[0]!.actor).toMatch(/^device:/);
  });

  it('survives a burst of simultaneous claims from several devices and tabs: exactly one award', async () => {
    await start();
    const { p, maya } = await household();
    const devices = [await kiosk(p, 'Kiosk'), await kiosk(p, 'Tablet'), p];
    const results = await Promise.all(Array.from({ length: 24 }, (_, i) => command(devices[i % devices.length]!, 'claimBirthdayReward', { childId: maya })));
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    expect(results.filter((r) => r.json().noChange === false)).toHaveLength(1);
    expect((await state(p)).family.bonusAwards).toHaveLength(1);
  });

  it('is serialised across separate database connections (e.g. two server processes)', async () => {
    await start();
    const { maya } = await household();
    const other = openDatabase(databasePath(tmp.dir), { busyTimeoutMs: 20 });
    try {
      const otherStore = new FamilyStore(other, { timeZone: 'Europe/London', now: () => NOW });
      let blocked: unknown = null;
      const store = new FamilyStore(opened.db, {
        timeZone: 'Europe/London',
        now: () => NOW,
        // While this claim's write is open, the other connection can't write at all.
        beforeCommit: () => {
          try {
            otherStore.apply({ type: 'claimBirthdayReward', payload: { childId: maya } }, 'device:other');
          } catch (e) {
            blocked = e;
          }
        },
      });
      const first = store.apply({ type: 'claimBirthdayReward', payload: { childId: maya } }, 'device:one');
      expect(first).toMatchObject({ ok: true, noChange: false });
      expect(String(blocked)).toMatch(/locked|busy/i);
      // Once it has committed, the other connection sees the award and changes nothing.
      expect(otherStore.apply({ type: 'claimBirthdayReward', payload: { childId: maya } }, 'device:other')).toMatchObject({ ok: true, noChange: true });
      expect(otherStore.read().family.bonusAwards).toHaveLength(1);
    } finally {
      other.close();
    }
  });

  it('is only for the right child on the right day', async () => {
    await start();
    const { p, leo } = await household();
    const k = await kiosk(p);
    const r = await command(k, 'claimBirthdayReward', { childId: leo });
    expect(r.statusCode).toBe(422);
    expect((await command(k, 'claimBirthdayReward', { childId: 'nobody' })).statusCode).toBe(404);
    expect((await state(p)).family.bonusAwards).toEqual([]);
  });

  it('uses the household time zone for “today”', async () => {
    // Same instant, but in Auckland it is already 31 October: not Maya's birthday.
    await start('Pacific/Auckland');
    const { p, maya } = await household();
    expect((await state(p)).today).toBe('2026-10-31');
    expect((await state(p)).birthdaysToday).toEqual([]);
    expect((await command(p, 'claimBirthdayReward', { childId: maya })).statusCode).toBe(422);
  });

  it('gives a zero-point gift, and nothing at all when the reward is off', async () => {
    await start();
    const { p, maya, leo } = await household();
    await command(p, 'saveBirthday', { childId: leo, month: 10, day: 30, rewardEnabled: true, points: 0, gift: 'Choose dinner' }, 0);
    expect((await command(p, 'claimBirthdayReward', { childId: leo })).json().noChange).toBe(false);
    const s = await state(p);
    expect(s.family.bonusAwards.find((a: { childId: string }) => a.childId === leo)).toMatchObject({ points: 0, note: 'Choose dinner' });
    await command(p, 'saveBirthday', { childId: maya, month: 10, day: 30, rewardEnabled: false, points: 0, gift: '' }, s.recordVersions[`birthday:${maya}`]);
    expect((await command(p, 'claimBirthdayReward', { childId: maya })).statusCode).toBe(422);
  });

  it('is remembered across a restart and on every device', async () => {
    await start();
    const { p, maya } = await household();
    const k = await kiosk(p);
    expect((await command(k, 'claimBirthdayReward', { childId: maya })).json().noChange).toBe(false);
    await stop();
    await start();
    const p2: Jar = {};
    // Sessions survive the restart too (same database).
    Object.assign(p2, p);
    const s = await state(p2);
    expect(s.family.bonusAwards).toHaveLength(1);
    expect(s.birthdaysToday[0].claimed).toBe(true);
    expect((await command(k, 'claimBirthdayReward', { childId: maya })).json().noChange).toBe(true);
  });

  it('keeps the reward when the birthday is removed, and removes both with the child', async () => {
    await start();
    const { p, maya } = await household();
    await command(p, 'claimBirthdayReward', { childId: maya });
    let s = await state(p);
    expect((await command(p, 'removeBirthday', { childId: maya }, s.recordVersions[`birthday:${maya}`])).statusCode).toBe(200);
    s = await state(p);
    expect(s.family.birthdays).toEqual([]);
    expect(s.family.bonusAwards).toHaveLength(1);
    expect((await command(p, 'deleteChild', { id: maya }, s.recordVersions[`child:${maya}`] ?? 0)).statusCode).toBe(200);
    expect((await state(p)).family.bonusAwards).toEqual([]);
  });
});

describe('public seasonal theme (sign-in and pairing screens)', () => {
  it('tells anyone only which theme shows today and its dates', async () => {
    await start('Europe/London', new Date('2026-10-30T12:00:00Z'));
    await household(); // Maya's birthday is today, with a gift
    const r = await get(null, '/api/celebrations/theme');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({
      today: '2026-10-30',
      occurrence: { themeId: 'halloween', holiday: '2026-10-31', start: '2026-10-26', end: '2026-11-01', custom: false },
    });
    const text = r.body;
    for (const secret of ['Maya', 'Cinema trip', 'birthday', 'Our Family']) expect(text).not.toContain(secret);
  });

  it('follows the parents’ switches', async () => {
    await start('Europe/London', new Date('2026-10-30T12:00:00Z'));
    const { p } = await household();
    const settings = defaultCelebrationSettings();
    settings.themes.halloween.enabled = false;
    expect((await command(p, 'saveCelebrationSettings', { settings }, 0)).statusCode).toBe(200);
    expect((await get(null, '/api/celebrations/theme')).json().occurrence).toBeNull();
  });
});
