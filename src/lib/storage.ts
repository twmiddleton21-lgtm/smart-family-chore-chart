import {
  ACCENT_COLORS,
  DATA_VERSION,
  PERIODS,
  type AccentColor,
  type Child,
  type Chore,
  type Completion,
  type DateKey,
  type FamilyData,
  type FoodOption,
  type MealEntry,
  type Period,
  type Redemption,
  type Reward,
  type Schedule,
  type Settings,
  type Weekday,
} from '../types';
import { isDateKey } from './dates';
import { deriveFoodOptions, foodKey } from './foodOptions';
import { createSampleData, DEFAULT_PIN } from './sampleData';

// The only module that touches localStorage. Stored data is treated as
// untrusted input: it is parsed defensively and every record is checked
// before the app uses it.

export const STORAGE_KEY = 'smart-family-chore-chart:data';
/** Unreadable data is copied here before being replaced, so nothing is silently lost. */
export const BACKUP_KEY = 'smart-family-chore-chart:unreadable-backup';

/** The subset of the Web Storage API we use, so tests can pass a fake. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type LoadStatus = 'new' | 'loaded' | 'repaired' | 'recovered' | 'unavailable';

export interface LoadResult {
  data: FamilyData;
  status: LoadStatus;
}

// ---------- Record validators ----------

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const isPoints = (v: unknown, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;
const isIsoTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));

function toSchedule(v: unknown): Schedule | null {
  if (!isObj(v)) return null;
  if (v.type === 'daily') return { type: 'daily' };
  if (v.type === 'weekly' && Array.isArray(v.days)) {
    const days = v.days.filter((d): d is Weekday => Number.isInteger(d) && d >= 0 && d <= 6);
    if (days.length === 0 || days.length !== v.days.length) return null;
    return { type: 'weekly', days: [...new Set(days)].sort() };
  }
  return null;
}

function toChild(v: unknown): Child | null {
  if (!isObj(v) || !isStr(v.id) || !isStr(v.name, 40) || !isStr(v.avatar, 16)) return null;
  if (!ACCENT_COLORS.includes(v.color as AccentColor)) return null;
  return { id: v.id, name: v.name, avatar: v.avatar, color: v.color as AccentColor };
}

function toChore(v: unknown): Chore | null {
  if (!isObj(v) || !isStr(v.id) || !isStr(v.childId) || !isStr(v.title, 80) || !isStr(v.icon, 16)) return null;
  if (!isPoints(v.points, 1000) || !PERIODS.includes(v.period as Period)) return null;
  const schedule = toSchedule(v.schedule);
  if (!schedule) return null;
  return {
    id: v.id,
    childId: v.childId,
    title: v.title,
    icon: v.icon,
    points: v.points,
    period: v.period as Period,
    schedule,
  };
}

function toReward(v: unknown): Reward | null {
  if (!isObj(v) || !isStr(v.id) || !isStr(v.name, 80) || !isStr(v.icon, 16)) return null;
  if (typeof v.description !== 'string' || v.description.length > 200) return null;
  if (!isPoints(v.cost, 100000)) return null;
  return { id: v.id, name: v.name, description: v.description, icon: v.icon, cost: v.cost };
}

function toCompletion(v: unknown): Completion | null {
  if (!isObj(v) || !isStr(v.id) || !isStr(v.choreId) || !isStr(v.childId)) return null;
  if (!isDateKey(v.date) || !isPoints(v.points, 1000) || !isIsoTime(v.completedAt)) return null;
  return {
    id: v.id,
    choreId: v.choreId,
    childId: v.childId,
    date: v.date,
    points: v.points,
    completedAt: v.completedAt,
  };
}

function toRedemption(v: unknown): Redemption | null {
  if (!isObj(v) || !isStr(v.id) || !isStr(v.childId) || !isStr(v.rewardId) || !isStr(v.rewardName, 80)) return null;
  if (!isDateKey(v.date) || !isPoints(v.cost, 100000) || !isIsoTime(v.redeemedAt)) return null;
  return {
    id: v.id,
    childId: v.childId,
    rewardId: v.rewardId,
    rewardName: v.rewardName,
    cost: v.cost,
    date: v.date,
    redeemedAt: v.redeemedAt,
  };
}

function toMeal(v: unknown): MealEntry | null {
  if (!isObj(v) || !isStr(v.id) || !isStr(v.childId) || !isDateKey(v.date)) return null;
  if (typeof v.main !== 'string' || v.main.length > 120) return null;
  if (typeof v.pudding !== 'string' || v.pudding.length > 120) return null;
  if (v.main === '' && v.pudding === '') return null;
  return { id: v.id, childId: v.childId, date: v.date, main: v.main, pudding: v.pudding };
}

function toFoodOption(v: unknown): FoodOption | null {
  if (!isObj(v) || !isStr(v.id) || !isStr(v.name, 120) || v.name.trim() === '') return null;
  return { id: v.id, name: v.name };
}

/** Valid options with unique IDs and unique names (case-insensitive) within one category. */
function cleanFoodList(raw: unknown): { items: FoodOption[]; dropped: boolean } {
  if (!Array.isArray(raw)) return { items: [], dropped: true };
  const byId = cleanList(raw, toFoodOption);
  const seen = new Set<string>();
  const items = byId.items.filter((o) => {
    const key = foodKey(o.name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { items, dropped: byId.dropped || items.length !== byId.items.length };
}

function toSettings(v: unknown, pinRequired: boolean): Settings | null {
  if (!isObj(v) || !isStr(v.familyName, 60)) return null;
  if (!pinRequired) {
    // Server-side documents never hold the legacy client-side PIN.
    const dismissed = isDateKey(v.mealReminderDismissedOn) ? v.mealReminderDismissedOn : null;
    return { familyName: v.familyName, parentPin: '', mealReminderDismissedOn: dismissed };
  }
  if (typeof v.parentPin !== 'string' || !/^\d{4,8}$/.test(v.parentPin)) return null;
  // Added in v2; absent in v1 data.
  const dismissed = isDateKey(v.mealReminderDismissedOn) ? v.mealReminderDismissedOn : null;
  return { familyName: v.familyName, parentPin: v.parentPin, mealReminderDismissedOn: dismissed };
}

/** Keep valid records with unique IDs; report whether anything was dropped. */
function cleanList<T extends { id: string }>(raw: unknown[], convert: (v: unknown) => T | null) {
  const seen = new Set<string>();
  const items: T[] = [];
  for (const entry of raw) {
    const item = convert(entry);
    if (item && !seen.has(item.id)) {
      seen.add(item.id);
      items.push(item);
    }
  }
  return { items, dropped: items.length !== raw.length };
}

export interface ParseOptions {
  /**
   * The browser app keeps a client-side PIN in its settings (default: true).
   * The server stores family data without it, so it passes false: any PIN is
   * ignored and `settings.parentPin` comes back as ''.
   */
  pinRequired?: boolean;
}

export interface ParsedData {
  data: FamilyData;
  /** Some invalid records were dropped. */
  repaired: boolean;
  /** Data was upgraded from an older version and should be re-saved. */
  migrated: boolean;
}

/**
 * Validate an unknown value as FamilyData. Returns null if the overall shape
 * is unusable (unknown version or missing collections). Older versions are
 * upgraded: v1 has no meals yet; v1 and v2 have no food catalog, so one is
 * derived from the existing meal names. Individual invalid records are
 * dropped and reported via `repaired`.
 */
export function parseFamilyData(value: unknown, options: ParseOptions = {}): ParsedData | null {
  const pinRequired = options.pinRequired ?? true;
  if (!isObj(value) || (value.version !== 1 && value.version !== 2 && value.version !== DATA_VERSION)) return null;
  const version = value.version as 1 | 2 | 3;
  const migrated = version !== DATA_VERSION;
  const lists = ['children', 'chores', 'rewards', 'completions', 'redemptions'] as const;
  if (!lists.every((k) => Array.isArray(value[k]))) return null;
  if (version >= 2 && !Array.isArray(value.meals)) return null;
  if (version >= 3 && !isObj(value.foodOptions)) return null;

  const children = cleanList(value.children as unknown[], toChild);
  const childIds = new Set(children.items.map((c) => c.id));
  // Chores for a child that no longer exists could never be shown, so drop them.
  const chores = cleanList(value.chores as unknown[], (v) => {
    const chore = toChore(v);
    return chore && childIds.has(chore.childId) ? chore : null;
  });
  const rewards = cleanList(value.rewards as unknown[], toReward);
  const completions = cleanList(value.completions as unknown[], toCompletion);
  const redemptions = cleanList(value.redemptions as unknown[], toRedemption);
  const meals = cleanList(version >= 2 ? (value.meals as unknown[]) : [], (v) => {
    const meal = toMeal(v);
    return meal && childIds.has(meal.childId) ? meal : null;
  });

  // At most one meal per child per day.
  const seenMeal = new Set<string>();
  const uniqueMeals = meals.items.filter((m) => {
    const key = `${m.childId}|${m.date}`;
    if (seenMeal.has(key)) return false;
    seenMeal.add(key);
    return true;
  });

  // Enforce at most one completion per chore, child and day.
  const seenDay = new Set<string>();
  const uniqueCompletions = completions.items.filter((c) => {
    const key = `${c.choreId}|${c.childId}|${c.date}`;
    if (seenDay.has(key)) return false;
    seenDay.add(key);
    return true;
  });

  // v3 stores the catalog. Older data gets one built from its meal names so
  // every existing assignment can still be chosen in the dropdowns.
  let mains: { items: FoodOption[]; dropped: boolean };
  let puddings: { items: FoodOption[]; dropped: boolean };
  if (version >= 3) {
    const food = value.foodOptions as Record<string, unknown>;
    mains = cleanFoodList(food.mains);
    puddings = cleanFoodList(food.puddings);
  } else {
    const derived = deriveFoodOptions(uniqueMeals);
    mains = { items: derived.mains, dropped: false };
    puddings = { items: derived.puddings, dropped: false };
  }

  const settings = toSettings(value.settings, pinRequired);

  const repaired =
    children.dropped ||
    chores.dropped ||
    rewards.dropped ||
    completions.dropped ||
    redemptions.dropped ||
    meals.dropped ||
    mains.dropped ||
    puddings.dropped ||
    uniqueMeals.length !== meals.items.length ||
    uniqueCompletions.length !== completions.items.length ||
    settings === null;

  return {
    data: {
      version: DATA_VERSION,
      settings: settings ?? { familyName: 'Our Family', parentPin: pinRequired ? DEFAULT_PIN : '', mealReminderDismissedOn: null },
      children: children.items,
      chores: chores.items,
      rewards: rewards.items,
      completions: uniqueCompletions,
      redemptions: redemptions.items,
      meals: uniqueMeals,
      foodOptions: { mains: mains.items, puddings: puddings.items },
    },
    repaired,
    migrated,
  };
}

// ---------- Load / save / reset ----------

export function loadData(storage: StorageLike | null, today: DateKey): LoadResult {
  if (!storage) return { data: createSampleData(today), status: 'unavailable' };

  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return { data: createSampleData(today), status: 'unavailable' };
  }

  if (raw === null) {
    const data = createSampleData(today);
    saveData(storage, data);
    return { data, status: 'new' };
  }

  let parsed: ReturnType<typeof parseFamilyData> = null;
  try {
    parsed = parseFamilyData(JSON.parse(raw));
  } catch {
    parsed = null;
  }

  if (!parsed) {
    // Keep a copy of the unreadable data rather than destroying it.
    try {
      storage.setItem(BACKUP_KEY, raw);
    } catch {
      // Backup is best-effort only.
    }
    const data = createSampleData(today);
    saveData(storage, data);
    return { data, status: 'recovered' };
  }

  if (parsed.repaired || parsed.migrated) saveData(storage, parsed.data);
  return { data: parsed.data, status: parsed.repaired ? 'repaired' : 'loaded' };
}

/** Returns false if the browser refused to save (e.g. storage full or blocked). */
export function saveData(storage: StorageLike | null, data: FamilyData): boolean {
  if (!storage) return false;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

/** Replace all saved data with fresh demonstration data. */
export function resetData(storage: StorageLike | null, today: DateKey): FamilyData {
  const data = createSampleData(today);
  saveData(storage, data);
  return data;
}

/** window.localStorage, or null when it is unavailable or blocked. */
export function getBrowserStorage(): StorageLike | null {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;
    const probe = '__sfcc_probe__';
    storage.setItem(probe, probe);
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

// ---------- Moving browser data to a family server (import) ----------

/** Records that this browser's data was imported to a server (data is kept). */
export const MIGRATION_MARKER_KEY = 'smart-family-chore-chart:migrated-to-server';

export interface MigrationMarker {
  importedAt: string;
}

/**
 * The raw saved family data in this browser (as v0.1.0-v0.3.0 stored it),
 * parsed as JSON, or null if there is none or it is unreadable. Read-only:
 * never modifies or clears anything.
 */
export function readBrowserFamilyData(storage: StorageLike | null): unknown {
  if (!storage) return null;
  try {
    const raw = storage.getItem(STORAGE_KEY);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

export function readMigrationMarker(storage: StorageLike | null): MigrationMarker | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(MIGRATION_MARKER_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<MigrationMarker>;
    return typeof v.importedAt === 'string' ? { importedAt: v.importedAt } : null;
  } catch {
    return null;
  }
}

/** Remember the import; the browser's own family data is left untouched. */
export function writeMigrationMarker(storage: StorageLike | null, marker: MigrationMarker): void {
  try {
    storage?.setItem(MIGRATION_MARKER_KEY, JSON.stringify(marker));
  } catch {
    // Best effort only.
  }
}
