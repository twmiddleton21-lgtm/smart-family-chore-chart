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

// ---------- Seasonal themes and birthdays (format v4) ----------

/** The seasonal themes, in calendar order. */
export const THEME_IDS = ['newYear', 'valentines', 'easter', 'halloween', 'christmas'] as const;
export type ThemeId = (typeof THEME_IDS)[number];

/**
 * A parent's own dates for a theme, saved as whole days before (negative) or
 * after the holiday itself, so they repeat every year and follow a holiday
 * that moves (Easter). Null = the recurring default dates.
 */
export interface ThemeDates {
  startOffset: number;
  endOffset: number;
}

export interface ThemeSetting {
  enabled: boolean;
  custom: ThemeDates | null;
}

export interface CelebrationSettings {
  themes: Record<ThemeId, ThemeSetting>;
  /** The visual birthday theme and banner. Rewards are switched per child. */
  birthdaysEnabled: boolean;
}

/** A child's birthday: month and day only (the year of birth is never stored). */
export interface ChildBirthday {
  childId: string;
  /** 1–12 */
  month: number;
  /** 1–31 (29 February is celebrated on 28 February in other years). */
  day: number;
  reward: BirthdayReward;
}

export interface BirthdayReward {
  enabled: boolean;
  /** Bonus points (0 allowed when there is a gift). */
  points: number;
  /** What the child gets, e.g. "Cinema trip". May be empty when points > 0. */
  gift: string;
}

/**
 * Points given outside chores. A birthday award is unique per child and
 * calendar year; `points` and `note` are snapshots of the reward at the time.
 */
export interface BonusAward {
  id: string;
  childId: string;
  kind: 'birthday';
  /** The birthday year this award belongs to. */
  year: number;
  /**
   * The day and time it was given. Always stored (the record validator
   * requires both), but left out of a paired device's view of the family:
   * they would reveal the child's birthday (server/app.ts deviceFamily).
   */
  date?: DateKey;
  awardedAt?: string;
  points: number;
  note: string;
}

/**
 * v1 → v2 (2026-10-13): added `meals` and `settings.mealReminderDismissedOn`.
 * v2 → v3 (2026-10-13): added `foodOptions` (catalog built from existing meal names).
 * v3 → v4 (2026-10-31): added `celebrations`, `birthdays` and `bonusAwards`
 *   (defaults: every theme on with its default dates, no birthdays, no awards).
 */
export const DATA_VERSION = 4;

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
  celebrations: CelebrationSettings;
  birthdays: ChildBirthday[];
  bonusAwards: BonusAward[];
}

/** Result type used by all state-changing business logic. */
export type Result = { ok: true; data: FamilyData } | { ok: false; error: string };
