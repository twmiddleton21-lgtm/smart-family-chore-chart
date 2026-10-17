import { createHash } from 'node:crypto';
import { DATA_VERSION } from '../../src/types';
import { pointsBalance } from '../../src/lib/points';
import { EXPORT_APP, EXPORT_FORMAT, toExportFile, type ExportFile } from '../../src/lib/exportFile';
import { parseFamilyData } from '../../src/lib/storage';
import { fromLib, toLib, validateDocument, type FamilyDocument } from './document';

// Validation of family-data files for import. Accepts:
//   - an export file: { app: "smart-family-chore-chart", exportFormat: 1, data: <family data> }
//   - raw browser data from v0.1.0-v0.3.0 (format versions 1, 2 or 3),
//     e.g. the value of localStorage "smart-family-chore-chart:data".
// Any legacy client-side PIN is ignored and never stored. Files that are
// not usable, from a newer version, or contain invalid records are rejected
// outright (nothing is silently dropped).

export { EXPORT_APP, EXPORT_FORMAT };
export type { ExportFile };

export interface ImportSummary {
  /** Data format version found in the file (1, 2 or 3). */
  sourceFormatVersion: number;
  /** True if the data was upgraded to the current format. */
  upgraded: boolean;
  /** True if the file contained an old client-side PIN (ignored). */
  pinIgnored: boolean;
  familyName: string;
  counts: {
    children: number;
    chores: number;
    rewards: number;
    completions: number;
    redemptions: number;
    meals: number;
    mainMeals: number;
    puddings: number;
  };
  children: { name: string; points: number }[];
}

export type ImportParse =
  | { ok: true; doc: FamilyDocument; summary: ImportSummary; checksum: string }
  | { ok: false; error: 'invalid_file' | 'unsupported_version' | 'invalid_records'; message: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const LISTS = ['children', 'chores', 'rewards', 'completions', 'redemptions', 'meals'] as const;

export function checksumOf(doc: FamilyDocument): string {
  return createHash('sha256').update(JSON.stringify(doc)).digest('hex');
}

export function parseImport(input: unknown): ImportParse {
  if (!isObj(input)) return { ok: false, error: 'invalid_file', message: 'This is not a family data file.' };

  // Unwrap an export file.
  let data: unknown = input;
  if ('app' in input || 'exportFormat' in input) {
    if (input.app !== EXPORT_APP) return { ok: false, error: 'invalid_file', message: 'This file is not from Smart Family Chore Chart.' };
    if (typeof input.exportFormat !== 'number' || !Number.isInteger(input.exportFormat)) {
      return { ok: false, error: 'invalid_file', message: 'The export file is missing its format number.' };
    }
    if (input.exportFormat > EXPORT_FORMAT) {
      return { ok: false, error: 'unsupported_version', message: 'This file was exported by a newer version of the app.' };
    }
    data = input.data;
  }
  if (!isObj(data)) return { ok: false, error: 'invalid_file', message: 'The file does not contain family data.' };
  if (!('version' in data) && !('children' in data) && !('settings' in data)) {
    return { ok: false, error: 'invalid_file', message: 'This is not a family data file.' };
  }

  const version = data.version;
  if (typeof version === 'number' && Number.isInteger(version) && version > DATA_VERSION) {
    return { ok: false, error: 'unsupported_version', message: 'This data comes from a newer version of the app.' };
  }

  const parsed = parseFamilyData(data, { pinRequired: false });
  if (!parsed) return { ok: false, error: 'invalid_file', message: 'The family data is damaged or in an unknown format.' };

  if (parsed.repaired) {
    // Count what the validator would have dropped, so the message is useful.
    let dropped = 0;
    for (const key of LISTS) {
      const before = Array.isArray(data[key]) ? (data[key] as unknown[]).length : 0;
      const after = (parsed.data[key] as unknown[]).length;
      dropped += Math.max(0, before - after);
    }
    const food = isObj(data.foodOptions) ? data.foodOptions : {};
    for (const key of ['mains', 'puddings'] as const) {
      const before = Array.isArray(food[key]) ? (food[key] as unknown[]).length : 0;
      dropped += Math.max(0, before - parsed.data.foodOptions[key].length);
    }
    return {
      ok: false,
      error: 'invalid_records',
      message:
        dropped > 0
          ? `The file contains ${dropped} invalid record${dropped === 1 ? '' : 's'}. Nothing was imported.`
          : 'The file contains invalid settings or records. Nothing was imported.',
    };
  }

  const doc = validateDocument(JSON.parse(JSON.stringify(fromLib(parsed.data))), true);
  const settings = isObj(data.settings) ? data.settings : {};
  const lib = toLib(doc);
  const summary: ImportSummary = {
    sourceFormatVersion: typeof version === 'number' ? version : 0,
    upgraded: parsed.migrated,
    pinIgnored: typeof settings.parentPin === 'string' && settings.parentPin !== '',
    familyName: doc.settings.familyName,
    counts: {
      children: doc.children.length,
      chores: doc.chores.length,
      rewards: doc.rewards.length,
      completions: doc.completions.length,
      redemptions: doc.redemptions.length,
      meals: doc.meals.length,
      mainMeals: doc.foodOptions.mains.length,
      puddings: doc.foodOptions.puddings.length,
    },
    children: doc.children.map((c) => ({ name: c.name, points: pointsBalance(lib, c.id) })),
  };
  return { ok: true, doc, summary, checksum: checksumOf(doc) };
}

export function buildExportFile(doc: FamilyDocument, source: ExportFile['source'], now = new Date()): ExportFile {
  return toExportFile(doc, source, now);
}
