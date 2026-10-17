import { describe, expect, it } from 'vitest';
import { makeFamily } from '../../src/lib/testFixtures';
import { completeChore } from '../../src/lib/chores';
import { buildExportFile, checksumOf, EXPORT_APP, parseImport } from './importer';

// Browser data as v0.3.0 stores it in localStorage (includes the PIN).
function v3BrowserData() {
  const r = completeChore(makeFamily(), 'a-bed', '2026-10-12');
  if (!r.ok) throw new Error(r.error);
  return JSON.parse(JSON.stringify(r.data));
}

describe('parseImport', () => {
  it('accepts raw v0.3.0 browser data, ignores the PIN and summarises it', () => {
    const r = parseImport(v3BrowserData());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('parentPin' in r.doc.settings).toBe(false);
    expect(JSON.stringify(r.doc)).not.toContain('parentPin');
    expect(r.summary).toMatchObject({
      sourceFormatVersion: 3,
      upgraded: false,
      pinIgnored: true,
      familyName: 'Test Family',
      counts: { children: 2, chores: 3, rewards: 2, completions: 1, redemptions: 0, meals: 0, mainMeals: 2, puddings: 2 },
    });
    expect(r.summary.children).toEqual([
      { name: 'Alex', points: 5 },
      { name: 'Bea', points: 0 },
    ]);
    expect(r.checksum).toBe(checksumOf(r.doc));
  });

  it('upgrades v0.1.0 (format 1) and v0.2.0 (format 2) data', () => {
    const { meals: _m, foodOptions: _f, ...v1Rest } = v3BrowserData();
    const v1 = { ...v1Rest, version: 1, settings: { familyName: 'Old', parentPin: '4321' } };
    const r1 = parseImport(v1);
    expect(r1.ok && r1.summary).toMatchObject({ sourceFormatVersion: 1, upgraded: true, pinIgnored: true });
    expect(r1.ok && r1.doc.meals).toEqual([]);

    const v2 = { ...v1Rest, version: 2, meals: [{ id: 'm1', childId: 'a', date: '2026-10-13', main: 'Pizza', pudding: 'Jelly' }], settings: { familyName: 'Old', parentPin: '4321', mealReminderDismissedOn: null } };
    const r2 = parseImport(v2);
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.summary).toMatchObject({ sourceFormatVersion: 2, upgraded: true });
      // Food lists are built from the meal names, as in the browser upgrade.
      expect(r2.doc.foodOptions.mains.map((o) => o.name)).toEqual(['Pizza']);
      expect(r2.doc.meals).toHaveLength(1);
    }
  });

  it('accepts an export file wrapper and round-trips exactly', () => {
    const first = parseImport(v3BrowserData());
    if (!first.ok) throw new Error('setup');
    const file = JSON.parse(JSON.stringify(buildExportFile(first.doc, 'server')));
    expect(file.app).toBe(EXPORT_APP);
    const again = parseImport(file);
    expect(again.ok && again.doc).toEqual(first.doc);
    expect(again.ok && again.checksum).toBe(first.checksum);
    expect(again.ok && again.summary.pinIgnored).toBe(false);
  });

  it.each([
    ['not an object', 'hello'],
    ['an array', []],
    ['null', null],
    ['an unrelated JSON object', { foo: 1 }],
    ['a file from another app', { app: 'other-app', exportFormat: 1, data: {} }],
    ['an export file with no format', { app: EXPORT_APP, data: {} }],
    ['an export file without data', { app: EXPORT_APP, exportFormat: 1 }],
    ['family data missing collections', { version: 3, settings: { familyName: 'X' } }],
  ])('rejects %s as an invalid file', (_label, input) => {
    const r = parseImport(input);
    expect(r).toMatchObject({ ok: false, error: 'invalid_file' });
  });

  it('says plainly when a JSON file is not family data at all', () => {
    expect(parseImport({ hello: 'world' })).toMatchObject({ ok: false, error: 'invalid_file', message: 'This is not a family data file.' });
  });

  it('rejects data or export files from a newer app version', () => {
    expect(parseImport({ ...v3BrowserData(), version: 99 })).toMatchObject({ ok: false, error: 'unsupported_version' });
    expect(parseImport({ app: EXPORT_APP, exportFormat: 2, data: v3BrowserData() })).toMatchObject({ ok: false, error: 'unsupported_version' });
  });

  it('rejects files with invalid records instead of silently dropping them', () => {
    const bad = v3BrowserData();
    bad.chores.push({ id: 'broken', childId: 'a', title: '', icon: '', points: -5, period: 'night', schedule: { type: 'daily' } });
    bad.completions.push({ id: 'c-bad', choreId: 'a-bed', childId: 'a', date: 'not-a-date', points: 5, completedAt: 'x' });
    const r = parseImport(bad);
    expect(r).toMatchObject({ ok: false, error: 'invalid_records' });
    if (!r.ok) expect(r.message).toMatch(/2 invalid records/);
  });

  it('rejects duplicate same-day completions (would double-count points)', () => {
    const bad = v3BrowserData();
    bad.completions.push({ ...bad.completions[0], id: 'dupe' });
    expect(parseImport(bad)).toMatchObject({ ok: false, error: 'invalid_records' });
  });
});
