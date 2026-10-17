import { describe, expect, it } from 'vitest';
import { EXPORT_APP, EXPORT_FORMAT, exportFileName, toExportFile } from './exportFile';
import { MIGRATION_MARKER_KEY, readBrowserFamilyData, readMigrationMarker, STORAGE_KEY, writeMigrationMarker } from './storage';
import { makeFamily, MemoryStorage } from './testFixtures';

describe('export files', () => {
  it('wraps data with app and format, and never includes the PIN', () => {
    const file = toExportFile(makeFamily(), 'browser', new Date('2026-10-17T09:00:00Z'));
    expect(file).toMatchObject({ app: EXPORT_APP, exportFormat: EXPORT_FORMAT, source: 'browser', exportedAt: '2026-10-17T09:00:00.000Z' });
    expect('parentPin' in file.data.settings).toBe(false);
    expect(JSON.stringify(file)).not.toContain('parentPin');
    expect(JSON.stringify(file)).not.toContain('1234');
    expect(file.data.children).toHaveLength(2);
  });

  it('does not modify the original data', () => {
    const fam = makeFamily();
    toExportFile(fam, 'browser');
    expect(fam.settings.parentPin).toBe('1234');
  });

  it('names files by date', () => {
    expect(exportFileName('2026-10-17')).toBe('chore-chart-export-2026-10-17.json');
  });
});

describe('reading this browser’s data for import (read-only)', () => {
  it('returns the saved data without changing storage', () => {
    const storage = new MemoryStorage();
    const raw = JSON.stringify(makeFamily());
    storage.setItem(STORAGE_KEY, raw);
    expect(readBrowserFamilyData(storage)).toEqual(JSON.parse(raw));
    expect(storage.getItem(STORAGE_KEY)).toBe(raw);
    expect([...storage.store.keys()]).toEqual([STORAGE_KEY]);
  });

  it('returns null when there is nothing (or nothing readable)', () => {
    const storage = new MemoryStorage();
    expect(readBrowserFamilyData(storage)).toBeNull();
    storage.setItem(STORAGE_KEY, '{broken');
    expect(readBrowserFamilyData(storage)).toBeNull();
    expect(readBrowserFamilyData(null)).toBeNull();
  });

  it('the migration marker records the import but leaves the family data in place', () => {
    const storage = new MemoryStorage();
    const raw = JSON.stringify(makeFamily());
    storage.setItem(STORAGE_KEY, raw);
    expect(readMigrationMarker(storage)).toBeNull();
    writeMigrationMarker(storage, { importedAt: '2026-10-17T09:00:00.000Z' });
    expect(readMigrationMarker(storage)).toEqual({ importedAt: '2026-10-17T09:00:00.000Z' });
    expect(storage.getItem(STORAGE_KEY)).toBe(raw);
    storage.setItem(MIGRATION_MARKER_KEY, 'junk');
    expect(readMigrationMarker(storage)).toBeNull();
  });
});
