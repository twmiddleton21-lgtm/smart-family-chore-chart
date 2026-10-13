// Core data model. Everything the app persists lives in a single FamilyData
// object so it can be validated, saved and reset as one unit.

/** A local calendar date in YYYY-MM-DD form (never a UTC timestamp). */
export type DateKey = string;

/** 0 = Sunday … 6 = Saturday, matching Date.prototype.getDay(). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type Period = 'morning' | 'afternoon' | 'evening';

export const PERIODS: readonly Period[] = ['morning', 'afternoon', 'evening'];

export type AccentColor = 'pink' | 'teal' | 'yellow' | 'lavender' | 'orange' | 'sky' | 'mint';

export const ACCENT_COLORS: readonly AccentColor[] = [
  'pink',
  'teal',
  'yellow',
  'lavender',
  'orange',
  'sky',
  'mint',
];

export type Schedule = { type: 'daily' } | { type: 'weekly'; days: Weekday[] };

export interface Child {
  id: string;
  /** First name or nickname only. */
  name: string;
  /** A single emoji used as the avatar. */
  avatar: string;
  color: AccentColor;
}

export interface Chore {
  id: string;
  childId: string;
  title: string;
  icon: string;
  points: number;
  period: Period;
  schedule: Schedule;
}

export interface Reward {
  id: string;
  name: string;
  description: string;
  icon: string;
  cost: number;
}

/**
 * One record per chore per local day. `points` is a snapshot taken when the
 * chore was completed, so later edits to the chore never rewrite history.
 */
export interface Completion {
  id: string;
  choreId: string;
  childId: string;
  date: DateKey;
  points: number;
  completedAt: string;
}

/** A reward redemption. `cost` and `rewardName` are snapshots. */
export interface Redemption {
  id: string;
  childId: string;
  rewardId: string;
  rewardName: string;
  cost: number;
  date: DateKey;
  redeemedAt: string;
}

/** One child's school meal on one school day. */
export interface MealEntry {
  id: string;
  childId: string;
  date: DateKey;
  main: string;
  pudding: string;
}

/** A reusable school-meal choice (a main or a pudding) shared by all children. */
export interface FoodOption {
  id: string;
  name: string;
}

export type FoodCategory = 'main' | 'pudding';

/** Separate catalogs for mains and puddings. */
export interface FoodOptions {
  mains: FoodOption[];
  puddings: FoodOption[];
}

export interface Settings {
  familyName: string;
  /** Client-side PIN for the parent area. Not real security — see README. */
  parentPin: string;
  /** The day the "meal plan running out" reminder was last dismissed. */
  mealReminderDismissedOn: DateKey | null;
}

/**
 * v1 → v2 (2026-10-13): added `meals` and `settings.mealReminderDismissedOn`.
 * v2 → v3 (2026-10-13): added `foodOptions` (catalog built from existing meal names).
 */
export const DATA_VERSION = 3;

export interface FamilyData {
  version: typeof DATA_VERSION;
  settings: Settings;
  children: Child[];
  chores: Chore[];
  rewards: Reward[];
  completions: Completion[];
  redemptions: Redemption[];
  meals: MealEntry[];
  foodOptions: FoodOptions;
}

/** Result type used by all state-changing business logic. */
export type Result = { ok: true; data: FamilyData } | { ok: false; error: string };
