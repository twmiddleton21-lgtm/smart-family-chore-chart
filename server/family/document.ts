import { DATA_VERSION, type FamilyData, type Settings } from '../../src/types';
import { mondayOf } from '../../src/lib/meals';
import { parseFamilyData } from '../../src/lib/storage';

// The server's family document: the browser FamilyData format (version 3)
// WITHOUT the legacy client-side PIN, which is never stored on or sent from
// the server. Business rules in src/lib work on FamilyData, so documents are
// converted at the boundary with toLib()/fromLib().

export type ServerSettings = Omit<Settings, 'parentPin'>;
export type FamilyDocument = Omit<FamilyData, 'settings'> & { settings: ServerSettings };

export class CorruptStateError extends Error {}

/** A new installation starts with an empty household (no sample family). */
export function emptyFamily(): FamilyDocument {
  return {
    version: DATA_VERSION,
    settings: { familyName: 'Our Family', mealReminderDismissedOn: null },
    children: [],
    chores: [],
    rewards: [],
    completions: [],
    redemptions: [],
    meals: [],
    foodOptions: { mains: [], puddings: [] },
  };
}

export function isEmptyHousehold(doc: FamilyDocument): boolean {
  return (
    doc.children.length === 0 &&
    doc.chores.length === 0 &&
    doc.rewards.length === 0 &&
    doc.completions.length === 0 &&
    doc.redemptions.length === 0 &&
    doc.meals.length === 0 &&
    doc.foodOptions.mains.length === 0 &&
    doc.foodOptions.puddings.length === 0
  );
}

/** For calling src/lib functions. The placeholder PIN is never persisted. */
export function toLib(doc: FamilyDocument): FamilyData {
  return { ...doc, settings: { ...doc.settings, parentPin: '' } };
}

/** Drop the legacy PIN from anything produced by src/lib (e.g. sample data). */
export function fromLib(data: FamilyData): FamilyDocument {
  const { parentPin: _drop, ...settings } = data.settings;
  return { ...data, settings };
}

/**
 * Validate a document with the same rules the browser uses. With
 * `strict`, any dropped record counts as corruption (used to check
 * documents we are about to store or have stored).
 */
export function validateDocument(value: unknown, strict: boolean): FamilyDocument {
  const parsed = parseFamilyData(value, { pinRequired: false });
  if (!parsed) throw new CorruptStateError('Family data has an unusable shape or version.');
  if (strict && (parsed.repaired || parsed.migrated)) {
    throw new CorruptStateError('Family data contains invalid records.');
  }
  return fromLib(parsed.data);
}

export function parseStoredDocument(json: string): FamilyDocument {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new CorruptStateError('Stored family data is not valid JSON.');
  }
  return validateDocument(value, true);
}

// ---------- Editable-record snapshots (for conflict detection) ----------

/**
 * Every record a device can edit, keyed "<kind>:<id>". Completions and
 * redemptions are intent-based (idempotent or re-checked) and not listed.
 * Meal plans are tracked per child and week ("mealWeek:<childId>:<monday>").
 */
export function recordSnapshots(doc: FamilyDocument): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of doc.children) map.set(`child:${c.id}`, JSON.stringify(c));
  for (const c of doc.chores) map.set(`chore:${c.id}`, JSON.stringify(c));
  for (const r of doc.rewards) map.set(`reward:${r.id}`, JSON.stringify(r));
  for (const o of doc.foodOptions.mains) map.set(`foodMain:${o.id}`, JSON.stringify(o));
  for (const o of doc.foodOptions.puddings) map.set(`foodPudding:${o.id}`, JSON.stringify(o));
  map.set('settings:household', JSON.stringify({ familyName: doc.settings.familyName }));
  const weeks = new Map<string, unknown[]>();
  for (const m of [...doc.meals].sort((a, b) => a.date.localeCompare(b.date))) {
    const key = `mealWeek:${m.childId}:${mondayOf(m.date)}`;
    const list = weeks.get(key) ?? [];
    list.push({ date: m.date, main: m.main, pudding: m.pudding });
    weeks.set(key, list);
  }
  for (const [key, list] of weeks) map.set(key, JSON.stringify(list));
  return map;
}

/** Keys of records that were added, removed or changed. */
export function changedRecords(before: FamilyDocument, after: FamilyDocument): string[] {
  const a = recordSnapshots(before);
  const b = recordSnapshots(after);
  const keys = new Set([...a.keys(), ...b.keys()]);
  return [...keys].filter((k) => a.get(k) !== b.get(k)).sort();
}
