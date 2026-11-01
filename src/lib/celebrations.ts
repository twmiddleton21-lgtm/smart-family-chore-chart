import {
  THEME_IDS,
  type BonusAward,
  type CelebrationSettings,
  type ChildBirthday,
  type DateKey,
  type FamilyData,
  type ThemeDates,
  type ThemeId,
  type ThemeSetting,
} from '../types';
import { createId } from './ids';

// Seasonal themes and birthdays: pure date rules, shared by the browser and
// the family server.
//
// Every calculation works on plain calendar dates (YYYY-MM-DD) counted as
// whole days, never on times of day. The caller supplies "today" in the
// household's time zone (the server's SFCC_TIMEZONE, or this browser's own
// date in the browser-only build), so there are no UTC midnight surprises.
//
// Recurring defaults and parents' own dates (SFC-D-024):
//   - Default dates are worked out again for every year: the Monday-Sunday
//     week containing the holiday, except Christmas (1 November - 25 December).
//   - A parent's own dates are saved as days before/after the holiday, so they
//     repeat every year without anyone re-entering them, follow Easter when
//     it moves, and are never changed by the app when the year changes.
//     "Restore default dates" removes them.

// ---------- Whole-day calendar arithmetic (UTC-based, no time zones) ----------

const MS_PER_DAY = 86_400_000;
const pad2 = (n: number) => String(n).padStart(2, '0');

function parts(key: DateKey): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) throw new Error(`Invalid date key: ${key}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Days since 1970-01-01 for a calendar date. */
export function dayNumber(key: DateKey): number {
  const [y, m, d] = parts(key);
  return Math.round(Date.UTC(y, m - 1, d) / MS_PER_DAY);
}

export function fromDayNumber(n: number): DateKey {
  const date = new Date(n * MS_PER_DAY);
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: DateKey, to: DateKey): number {
  return dayNumber(to) - dayNumber(from);
}

export function shiftDate(key: DateKey, days: number): DateKey {
  return fromDayNumber(dayNumber(key) + days);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOfKey(key: DateKey): number {
  return new Date(dayNumber(key) * MS_PER_DAY).getUTCDay();
}

export function yearOf(key: DateKey): number {
  return parts(key)[0];
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const key = (y: number, m: number, d: number): DateKey => `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;

// ---------- Holidays ----------

/** Western (Gregorian) Easter Sunday: the Meeus/Jones/Butcher algorithm. */
export function easterSunday(year: number): DateKey {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return key(year, month, day);
}

export interface ThemeInfo {
  id: ThemeId;
  name: string;
  icon: string;
  /** The day itself, for parents: "31 October", "Easter Sunday". */
  holidayName: string;
  /** How the default dates are chosen. */
  defaultRule: string;
}

export const THEMES: Record<ThemeId, ThemeInfo> = {
  newYear: {
    id: 'newYear',
    name: 'New Year',
    icon: '🎆',
    holidayName: 'New Year’s Day (1 January)',
    defaultRule: 'The Monday–Sunday week containing 1 January.',
  },
  valentines: {
    id: 'valentines',
    name: 'Valentine’s Day',
    icon: '💖',
    holidayName: 'Valentine’s Day (14 February)',
    defaultRule: 'The Monday–Sunday week containing 14 February.',
  },
  easter: {
    id: 'easter',
    name: 'Easter',
    icon: '🐣',
    holidayName: 'Easter Sunday (worked out for each year)',
    defaultRule: 'The Monday–Sunday week ending on Easter Sunday.',
  },
  halloween: {
    id: 'halloween',
    name: 'Halloween',
    icon: '🎃',
    holidayName: 'Halloween (31 October)',
    defaultRule: 'The Monday–Sunday week containing 31 October.',
  },
  christmas: {
    id: 'christmas',
    name: 'Christmas',
    icon: '🎄',
    holidayName: 'Christmas Day (25 December)',
    defaultRule: '1 November to Christmas Day, with a countdown.',
  },
};

/** The holiday itself in a given year. */
export function holidayDate(id: ThemeId, year: number): DateKey {
  switch (id) {
    case 'newYear':
      return key(year, 1, 1);
    case 'valentines':
      return key(year, 2, 14);
    case 'easter':
      return easterSunday(year);
    case 'halloween':
      return key(year, 10, 31);
    case 'christmas':
      return key(year, 12, 25);
  }
}

/** Monday of the Monday-Sunday week containing `date`. */
export function mondayOfWeek(date: DateKey): DateKey {
  return shiftDate(date, -((weekdayOfKey(date) + 6) % 7));
}

export interface DateRange {
  start: DateKey;
  end: DateKey;
}

/** The recurring default dates for one year's holiday. */
export function defaultRange(id: ThemeId, year: number): DateRange {
  const holiday = holidayDate(id, year);
  if (id === 'christmas') return { start: key(year, 11, 1), end: holiday };
  const start = mondayOfWeek(holiday);
  return { start, end: shiftDate(start, 6) };
}

/** One year's showing of a theme. */
export interface Occurrence extends DateRange {
  themeId: ThemeId;
  /** The holiday this showing belongs to. */
  holiday: DateKey;
  /** True when a parent's own dates are used. */
  custom: boolean;
}

export function occurrenceFor(id: ThemeId, year: number, setting: ThemeSetting): Occurrence {
  const holiday = holidayDate(id, year);
  if (setting.custom) {
    return {
      themeId: id,
      holiday,
      start: shiftDate(holiday, setting.custom.startOffset),
      end: shiftDate(holiday, setting.custom.endOffset),
      custom: true,
    };
  }
  return { themeId: id, holiday, ...defaultRange(id, year), custom: false };
}

export type ThemeState = 'active' | 'upcoming' | 'disabled';

export interface ThemeStatus {
  id: ThemeId;
  state: ThemeState;
  /** The showing that is on now, or else the next one (shown even when disabled). */
  occurrence: Occurrence;
}

/**
 * Where a theme stands on `today`: showing now, or the next showing. The
 * holiday of the year before, this year and next year are all checked, so
 * ranges that cross New Year (e.g. 28 December - 3 January) work.
 */
export function themeStatus(id: ThemeId, setting: ThemeSetting, today: DateKey): ThemeStatus {
  const year = yearOf(today);
  const showings = [year - 1, year, year + 1, year + 2].map((y) => occurrenceFor(id, y, setting));
  const now = showings.find((o) => o.start <= today && today <= o.end);
  const next = now ?? showings.filter((o) => o.start > today).sort((a, b) => a.start.localeCompare(b.start))[0]!;
  return { id, state: !setting.enabled ? 'disabled' : now ? 'active' : 'upcoming', occurrence: next };
}

export function themeStatuses(settings: CelebrationSettings, today: DateKey): ThemeStatus[] {
  return THEME_IDS.map((id) => themeStatus(id, settings.themes[id], today));
}

/**
 * The seasonal theme to show today, or null. If parents' dates make two
 * themes overlap, the one that started most recently wins (e.g. Christmas
 * from 1 November over the end of Halloween week).
 */
export function activeTheme(settings: CelebrationSettings, today: DateKey): Occurrence | null {
  const active = themeStatuses(settings, today).filter((s) => s.state === 'active');
  if (active.length === 0) return null;
  active.sort((a, b) => b.occurrence.start.localeCompare(a.occurrence.start) || THEME_IDS.indexOf(b.id) - THEME_IDS.indexOf(a.id));
  return active[0]!.occurrence;
}

export interface SeasonGreeting {
  headline: string;
  /** Whole days until the holiday (0 on the day), or null once it has passed. */
  daysToGo: number | null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The banner text for a theme showing, including the countdowns. */
export function seasonGreeting(occurrence: Occurrence, today: DateKey): SeasonGreeting {
  const days = daysBetween(today, occurrence.holiday);
  const daysToGo = days >= 0 ? days : null;
  switch (occurrence.themeId) {
    case 'christmas':
      if (days > 1) return { headline: `${plural(days, 'day')} to Christmas!`, daysToGo };
      if (days === 1) return { headline: 'It’s Christmas Eve! 1 day to go!', daysToGo };
      if (days === 0) return { headline: 'Merry Christmas!', daysToGo };
      return { headline: 'Happy holidays!', daysToGo };
    case 'newYear': {
      const year = yearOf(occurrence.holiday);
      if (days > 1) return { headline: `${plural(days, 'day')} until ${year}!`, daysToGo };
      if (days === 1) return { headline: `It’s New Year’s Eve! 1 day until ${year}!`, daysToGo };
      return { headline: `Happy New Year ${year}!`, daysToGo };
    }
    case 'halloween':
      if (days > 1) return { headline: `${plural(days, 'day')} until Halloween!`, daysToGo };
      if (days === 1) return { headline: 'Halloween is tomorrow!', daysToGo };
      if (days === 0) return { headline: 'Happy Halloween!', daysToGo };
      return { headline: 'Spooky week!', daysToGo };
    case 'easter':
      if (days > 1) return { headline: `${plural(days, 'day')} until Easter!`, daysToGo };
      if (days === 1) return { headline: 'Easter is tomorrow!', daysToGo };
      return { headline: 'Happy Easter!', daysToGo };
    case 'valentines':
      if (days > 1) return { headline: `${plural(days, 'day')} until Valentine’s Day!`, daysToGo };
      if (days === 1) return { headline: 'Valentine’s Day is tomorrow!', daysToGo };
      if (days === 0) return { headline: 'Happy Valentine’s Day!', daysToGo };
      return { headline: 'Spread the love!', daysToGo };
  }
}

// ---------- Parents' own dates ----------

/** Own dates may start or end at most this many days from the holiday. */
export const MAX_THEME_OFFSET = 120;
/** And may last at most this many days. */
export const MAX_THEME_DAYS = 100;

export function defaultCelebrationSettings(): CelebrationSettings {
  const themes = {} as Record<ThemeId, ThemeSetting>;
  for (const id of THEME_IDS) themes[id] = { enabled: true, custom: null };
  return { themes, birthdaysEnabled: true };
}

/** Check a parent's dates for one showing and turn them into offsets from its holiday. */
export function customDatesFor(holiday: DateKey, start: string, end: string): { ok: true; value: ThemeDates } | { ok: false; error: string } {
  const valid = (k: string) => /^\d{4}-\d{2}-\d{2}$/.test(k) && fromDayNumber(dayNumber(k)) === k;
  if (!valid(start) || !valid(end)) return { ok: false, error: 'Choose a start and an end date.' };
  if (end < start) return { ok: false, error: 'The end date must be on or after the start date.' };
  if (daysBetween(start, end) + 1 > MAX_THEME_DAYS) return { ok: false, error: `A theme can run for at most ${MAX_THEME_DAYS} days.` };
  const startOffset = daysBetween(holiday, start);
  const endOffset = daysBetween(holiday, end);
  if (Math.abs(startOffset) > MAX_THEME_OFFSET || Math.abs(endOffset) > MAX_THEME_OFFSET) {
    return { ok: false, error: `Keep the dates within ${MAX_THEME_OFFSET} days of the holiday.` };
  }
  return { ok: true, value: { startOffset, endOffset } };
}

function isThemeDates(v: unknown): v is ThemeDates {
  if (typeof v !== 'object' || v === null) return false;
  const { startOffset, endOffset } = v as Record<string, unknown>;
  return (
    Number.isInteger(startOffset) &&
    Number.isInteger(endOffset) &&
    Math.abs(startOffset as number) <= MAX_THEME_OFFSET &&
    Math.abs(endOffset as number) <= MAX_THEME_OFFSET &&
    (endOffset as number) >= (startOffset as number) &&
    (endOffset as number) - (startOffset as number) + 1 <= MAX_THEME_DAYS
  );
}

function toThemeSetting(v: unknown): ThemeSetting | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.enabled !== 'boolean') return null;
  if (o.custom !== null && !isThemeDates(o.custom)) return null;
  const custom = o.custom === null ? null : { startOffset: (o.custom as ThemeDates).startOffset, endOffset: (o.custom as ThemeDates).endOffset };
  return { enabled: o.enabled, custom };
}

/** Validate stored settings; anything unusable falls back to its default and is reported. */
export function parseCelebrationSettings(v: unknown): { settings: CelebrationSettings; repaired: boolean } {
  const defaults = defaultCelebrationSettings();
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { settings: defaults, repaired: true };
  const o = v as Record<string, unknown>;
  let repaired = false;
  const rawThemes = typeof o.themes === 'object' && o.themes !== null && !Array.isArray(o.themes) ? (o.themes as Record<string, unknown>) : null;
  if (!rawThemes) repaired = true;
  const themes = {} as Record<ThemeId, ThemeSetting>;
  for (const id of THEME_IDS) {
    const setting = rawThemes ? toThemeSetting(rawThemes[id]) : null;
    if (!setting) repaired = true;
    themes[id] = setting ?? defaults.themes[id];
  }
  const birthdaysEnabled = typeof o.birthdaysEnabled === 'boolean' ? o.birthdaysEnabled : (repaired = true, true);
  return { settings: { themes, birthdaysEnabled }, repaired };
}

/** Strict check for settings sent by a device: null if anything is wrong. */
export function validCelebrationSettings(v: unknown): CelebrationSettings | null {
  const parsed = parseCelebrationSettings(v);
  if (parsed.repaired) return null;
  const o = v as Record<string, unknown>;
  const themeKeys = Object.keys(o.themes as object);
  if (Object.keys(o).some((k) => k !== 'themes' && k !== 'birthdaysEnabled')) return null;
  if (themeKeys.length !== THEME_IDS.length || themeKeys.some((k) => !(THEME_IDS as readonly string[]).includes(k))) return null;
  return parsed.settings;
}

export function saveCelebrationSettings(data: FamilyData, settings: CelebrationSettings): FamilyData {
  return { ...data, celebrations: settings };
}

// ---------- Birthdays ----------

export const BIRTHDAY_MAX_POINTS = 1000;
export const GIFT_MAX = 60;

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** Largest day a birthday may have in a month (29 for February). */
export function maxBirthdayDay(month: number): number {
  return daysInMonth(2024, month); // 2024 is a leap year
}

/** The date a birthday is celebrated in a year (29 February → 28 February in other years). */
export function birthdayIn(birthday: Pick<ChildBirthday, 'month' | 'day'>, year: number): DateKey {
  const day = Math.min(birthday.day, daysInMonth(year, birthday.month));
  return key(year, birthday.month, day);
}

export function isBirthdayOn(birthday: Pick<ChildBirthday, 'month' | 'day'>, today: DateKey): boolean {
  return birthdayIn(birthday, yearOf(today)) === today;
}

/** The next birthday on or after today. */
export function nextBirthday(birthday: Pick<ChildBirthday, 'month' | 'day'>, today: DateKey): DateKey {
  const thisYear = birthdayIn(birthday, yearOf(today));
  return thisYear >= today ? thisYear : birthdayIn(birthday, yearOf(today) + 1);
}

/** "12 March" */
export function birthdayLabel(birthday: Pick<ChildBirthday, 'month' | 'day'>): string {
  return `${birthday.day} ${MONTH_NAMES[birthday.month - 1]}`;
}

export function birthdayOf(data: Pick<FamilyData, 'birthdays'>, childId: string): ChildBirthday | undefined {
  return data.birthdays.find((b) => b.childId === childId);
}

export function birthdayAward(data: Pick<FamilyData, 'bonusAwards'>, childId: string, year: number): BonusAward | undefined {
  return data.bonusAwards.find((a) => a.kind === 'birthday' && a.childId === childId && a.year === year);
}

/** What a shared screen needs to know about today's birthdays (no dates or reward details). */
export interface BirthdayToday {
  childId: string;
  /** A reward is set up for this birthday. */
  rewardEnabled: boolean;
  /** This year's reward has been given. */
  claimed: boolean;
}

export function birthdaysToday(data: Pick<FamilyData, 'birthdays' | 'bonusAwards' | 'children'>, today: DateKey): BirthdayToday[] {
  const year = yearOf(today);
  return data.children
    .map((child) => ({ child, birthday: birthdayOf(data, child.id) }))
    .filter(({ birthday }) => birthday && isBirthdayOn(birthday, today))
    .map(({ child, birthday }) => ({
      childId: child.id,
      rewardEnabled: birthday!.reward.enabled,
      claimed: birthdayAward(data, child.id, year) !== undefined,
    }));
}

export type ClaimResult =
  | { ok: true; data: FamilyData; awarded: boolean; award: BonusAward }
  | { ok: false; error: string };

/**
 * Give a child this year's birthday reward, once. Calling it again (another
 * tap, a reload, another device) changes nothing and reports awarded: false.
 * Only on the child's birthday, and only when a reward is set up.
 */
export function claimBirthdayReward(data: FamilyData, childId: string, today: DateKey, now: Date = new Date()): ClaimResult {
  const child = data.children.find((c) => c.id === childId);
  if (!child) return { ok: false, error: 'That profile no longer exists.' };
  const birthday = birthdayOf(data, childId);
  if (!birthday || !isBirthdayOn(birthday, today)) return { ok: false, error: `It isn’t ${child.name}’s birthday today.` };
  if (!birthday.reward.enabled) return { ok: false, error: `No birthday reward is set up for ${child.name}.` };
  const year = yearOf(today);
  const existing = birthdayAward(data, childId, year);
  if (existing) return { ok: true, data, awarded: false, award: existing };
  const award: BonusAward = {
    id: createId('bonus'),
    childId,
    kind: 'birthday',
    year,
    date: today,
    points: birthday.reward.points,
    note: birthday.reward.gift,
    awardedAt: now.toISOString(),
  };
  return { ok: true, data: { ...data, bonusAwards: [...data.bonusAwards, award] }, awarded: true, award };
}

export function setBirthday(data: FamilyData, value: ChildBirthday): FamilyData {
  const others = data.birthdays.filter((b) => b.childId !== value.childId);
  return { ...data, birthdays: [...others, value] };
}

/** Removing a birthday keeps any reward already given (its points stay). */
export function removeBirthday(data: FamilyData, childId: string): FamilyData {
  return { ...data, birthdays: data.birthdays.filter((b) => b.childId !== childId) };
}

export function recentBonusAwards(data: Pick<FamilyData, 'bonusAwards'>, childId: string, limit = 5): BonusAward[] {
  return data.bonusAwards
    .filter((a) => a.childId === childId)
    .sort((a, b) => b.awardedAt.localeCompare(a.awardedAt))
    .slice(0, limit);
}

// ---------- Validation of stored records ----------

const isInt = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

export function toBirthday(v: unknown): ChildBirthday | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.childId !== 'string' || o.childId === '' || o.childId.length > 200) return null;
  if (!isInt(o.month, 1, 12) || !isInt(o.day, 1, maxBirthdayDay(o.month))) return null;
  const r = o.reward as Record<string, unknown> | null;
  if (typeof r !== 'object' || r === null || Array.isArray(r)) return null;
  if (typeof r.enabled !== 'boolean' || !isInt(r.points, 0, BIRTHDAY_MAX_POINTS)) return null;
  if (typeof r.gift !== 'string' || r.gift.length > GIFT_MAX) return null;
  return { childId: o.childId, month: o.month, day: o.day, reward: { enabled: r.enabled, points: r.points, gift: r.gift } };
}

export function toBonusAward(v: unknown): BonusAward | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const str = (x: unknown) => typeof x === 'string' && x !== '' && x.length <= 200;
  if (!str(o.id) || !str(o.childId) || o.kind !== 'birthday') return null;
  if (!isInt(o.year, 1900, 9999) || typeof o.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.date)) return null;
  if (fromDayNumber(dayNumber(o.date)) !== o.date || yearOf(o.date) !== o.year) return null;
  if (!isInt(o.points, 0, BIRTHDAY_MAX_POINTS) || typeof o.note !== 'string' || o.note.length > GIFT_MAX) return null;
  if (typeof o.awardedAt !== 'string' || Number.isNaN(Date.parse(o.awardedAt))) return null;
  return {
    id: o.id as string,
    childId: o.childId as string,
    kind: 'birthday',
    year: o.year,
    date: o.date,
    points: o.points,
    note: o.note,
    awardedAt: o.awardedAt,
  };
}

// ---------- Form validation (parent area) ----------

export interface BirthdayDraft {
  month: string;
  day: string;
  rewardEnabled: boolean;
  points: string;
  gift: string;
}
export type BirthdayField = 'month' | 'day' | 'points' | 'gift';

export function validateBirthday(
  draft: BirthdayDraft,
): { ok: true; value: Omit<ChildBirthday, 'childId'> } | { ok: false; errors: Partial<Record<BirthdayField, string>> } {
  const errors: Partial<Record<BirthdayField, string>> = {};
  const month = /^\d{1,2}$/.test(draft.month.trim()) ? Number(draft.month) : NaN;
  const day = /^\d{1,2}$/.test(draft.day.trim()) ? Number(draft.day) : NaN;
  if (!isInt(month, 1, 12)) errors.month = 'Choose the birthday month.';
  else if (!isInt(day, 1, maxBirthdayDay(month))) errors.day = `Choose a day from 1 to ${maxBirthdayDay(month)}.`;
  const pointsText = draft.points.trim() === '' ? '0' : draft.points.trim();
  const points = /^\d+$/.test(pointsText) ? Number(pointsText) : NaN;
  if (!isInt(points, 0, BIRTHDAY_MAX_POINTS)) errors.points = `Use a whole number from 0 to ${BIRTHDAY_MAX_POINTS}.`;
  const gift = draft.gift.replace(/\s+/g, ' ').trim();
  if (gift.length > GIFT_MAX) errors.gift = `Keep the gift to ${GIFT_MAX} characters or fewer.`;
  if (draft.rewardEnabled && !errors.points && points === 0 && gift === '') {
    errors.points = 'Add some bonus points or describe a gift (or switch the reward off).';
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { month, day, reward: { enabled: draft.rewardEnabled, points, gift } } };
}
