import type { ApiErrorKind, ImportPreview } from '../api/client';
import type { DataSource } from '../config';
import type { Child, Chore, DateKey, FamilyData, FoodCategory, Reward } from '../types';
import type { ExportFile } from '../lib/exportFile';
import type { MealRow } from '../lib/meals';

// The contract between screens and the data source. Both the browser-local
// store and the server-backed store implement it.

export type ActionResult = { ok: true } | { ok: false; error: string; kind: ApiErrorKind | 'local' | 'unsupported' };

export type ImportApplyResult = { ok: true; backup: string } | { ok: false; error: string; kind: ApiErrorKind | 'unsupported' };

export interface FamilyActions {
  toggleChore(choreId: string): Promise<ActionResult>;
  redeemReward(childId: string, rewardId: string): Promise<ActionResult>;
  dismissMealReminder(): Promise<ActionResult>;
  /** `baseVersion`: record version captured when the edit started (server mode). */
  saveChild(value: Omit<Child, 'id'>, id?: string, baseVersion?: number): Promise<ActionResult>;
  deleteChild(id: string, baseVersion?: number): Promise<ActionResult>;
  saveChore(value: Omit<Chore, 'id'>, id?: string, baseVersion?: number): Promise<ActionResult>;
  deleteChore(id: string, baseVersion?: number): Promise<ActionResult>;
  saveReward(value: Omit<Reward, 'id'>, id?: string, baseVersion?: number): Promise<ActionResult>;
  deleteReward(id: string, baseVersion?: number): Promise<ActionResult>;
  saveMealWeek(childId: string, monday: DateKey, rows: MealRow[], baseVersion?: number): Promise<ActionResult>;
  addFoodOption(category: FoodCategory, name: string): Promise<ActionResult>;
  removeFoodOption(category: FoodCategory, id: string): Promise<ActionResult>;
  updateFamilyName(name: string, baseVersion?: number): Promise<ActionResult>;
  /** Browser-local mode only (the server never stores a PIN). */
  updatePin(pin: string): Promise<ActionResult>;
  /** Browser-local mode only. */
  resetDemoData(): Promise<ActionResult>;
  /** Server mode only, and only into an empty household. */
  loadDemoFamily(): Promise<ActionResult>;
  /** Current version of an editable record ("child:<id>", "mealWeek:<child>:<monday>"…). */
  versionOf(key: string): number;
  exportData(): Promise<{ ok: true; file: ExportFile } | { ok: false; error: string }>;
  /** Server mode only. */
  previewImport(data: unknown): Promise<{ ok: true; preview: ImportPreview } | { ok: false; error: string; kind: ApiErrorKind | 'unsupported' }>;
  /** Server mode only. */
  applyImport(data: unknown, preview: ImportPreview, replace: boolean): Promise<ImportApplyResult>;
  /** Re-read data from the source. */
  refresh(): Promise<void>;
}

export interface FamilyStore {
  mode: DataSource;
  status: 'loading' | 'ready' | 'error';
  /** Null only while loading or after a failed first load. */
  data: FamilyData | null;
  /** The household's "today" (server time zone in server mode). */
  today: DateKey;
  /** First-load failure (server mode). */
  error: { kind: ApiErrorKind; message: string } | null;
  /** Server mode: the last request could not reach the server. */
  connectionLost: boolean;
  /** Local mode: the browser refused to save. */
  saveFailed: boolean;
  /** Local mode: a one-off load notice (data repaired or recovered). */
  loadNotice: string | null;
  actions: FamilyActions;
}
