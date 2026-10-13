import {
  ACCENT_COLORS,
  PERIODS,
  type AccentColor,
  type Child,
  type Chore,
  type Period,
  type Reward,
  type Schedule,
  type Weekday,
} from '../types';

// Form validation for the parent area. Each validator takes raw form input
// (strings straight from inputs) and returns either a clean value or a map
// of field → human-readable error message.

export type Validated<T, F extends string> =
  | { ok: true; value: T }
  | { ok: false; errors: Partial<Record<F, string>> };

export const LIMITS = {
  nameMax: 20,
  titleMax: 40,
  rewardNameMax: 40,
  descriptionMax: 100,
  iconMax: 16,
  choreMinPoints: 1,
  choreMaxPoints: 100,
  rewardMinCost: 1,
  rewardMaxCost: 1000,
  familyNameMax: 30,
  mealTextMax: 60,
} as const;

/** Trim and collapse internal whitespace. */
export function cleanText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function parseWholeNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return Number(trimmed);
}

function validateIcon(raw: string, fallback: string): { value: string; error?: string } {
  const icon = raw.trim();
  if (icon === '') return { value: fallback };
  if (icon.length > LIMITS.iconMax) return { value: icon, error: 'Use a single emoji for the icon.' };
  return { value: icon };
}

// ---------- Children ----------

export interface ChildDraft {
  name: string;
  avatar: string;
  color: string;
}
export type ChildField = keyof ChildDraft;

export function validateChild(draft: ChildDraft): Validated<Omit<Child, 'id'>, ChildField> {
  const errors: Partial<Record<ChildField, string>> = {};
  const name = cleanText(draft.name);
  if (name === '') errors.name = 'Please enter a name or nickname.';
  else if (name.length > LIMITS.nameMax) errors.name = `Keep the name to ${LIMITS.nameMax} characters or fewer.`;

  const avatar = draft.avatar.trim();
  if (avatar === '') errors.avatar = 'Please choose an avatar.';
  else if (avatar.length > LIMITS.iconMax) errors.avatar = 'Use a single emoji for the avatar.';

  if (!ACCENT_COLORS.includes(draft.color as AccentColor)) errors.color = 'Please choose a colour.';

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { name, avatar, color: draft.color as AccentColor } };
}

// ---------- Chores ----------

export interface ChoreDraft {
  title: string;
  icon: string;
  childId: string;
  period: string;
  points: string;
  scheduleType: 'daily' | 'weekly';
  days: Weekday[];
}
export type ChoreField = keyof ChoreDraft;

export function validateChore(
  draft: ChoreDraft,
  childIds: readonly string[],
): Validated<Omit<Chore, 'id'>, ChoreField> {
  const errors: Partial<Record<ChoreField, string>> = {};

  const title = cleanText(draft.title);
  if (title === '') errors.title = 'Please give the chore a name.';
  else if (title.length > LIMITS.titleMax) errors.title = `Keep the name to ${LIMITS.titleMax} characters or fewer.`;

  const icon = validateIcon(draft.icon, '⭐');
  if (icon.error) errors.icon = icon.error;

  if (!childIds.includes(draft.childId)) errors.childId = 'Please choose who this chore is for.';

  if (!PERIODS.includes(draft.period as Period)) errors.period = 'Please choose morning, afternoon or evening.';

  const points = parseWholeNumber(draft.points);
  if (points === null) errors.points = 'Points must be a whole number, like 5.';
  else if (points < LIMITS.choreMinPoints || points > LIMITS.choreMaxPoints) {
    errors.points = `Points must be between ${LIMITS.choreMinPoints} and ${LIMITS.choreMaxPoints}.`;
  }

  let schedule: Schedule = { type: 'daily' };
  if (draft.scheduleType === 'weekly') {
    const days = [...new Set(draft.days)].filter((d) => d >= 0 && d <= 6).sort();
    if (days.length === 0) errors.days = 'Pick at least one day of the week.';
    schedule = { type: 'weekly', days };
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      title,
      icon: icon.value,
      childId: draft.childId,
      period: draft.period as Period,
      points: points as number,
      schedule,
    },
  };
}

// ---------- Rewards ----------

export interface RewardDraft {
  name: string;
  description: string;
  icon: string;
  cost: string;
}
export type RewardField = keyof RewardDraft;

export function validateReward(draft: RewardDraft): Validated<Omit<Reward, 'id'>, RewardField> {
  const errors: Partial<Record<RewardField, string>> = {};

  const name = cleanText(draft.name);
  if (name === '') errors.name = 'Please give the reward a name.';
  else if (name.length > LIMITS.rewardNameMax) errors.name = `Keep the name to ${LIMITS.rewardNameMax} characters or fewer.`;

  const description = cleanText(draft.description);
  if (description.length > LIMITS.descriptionMax) {
    errors.description = `Keep the description to ${LIMITS.descriptionMax} characters or fewer.`;
  }

  const icon = validateIcon(draft.icon, '🎁');
  if (icon.error) errors.icon = icon.error;

  const cost = parseWholeNumber(draft.cost);
  if (cost === null) errors.cost = 'Cost must be a whole number of points, like 50.';
  else if (cost < LIMITS.rewardMinCost || cost > LIMITS.rewardMaxCost) {
    errors.cost = `Cost must be between ${LIMITS.rewardMinCost} and ${LIMITS.rewardMaxCost} points.`;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: { name, description, icon: icon.value, cost: cost as number } };
}

// ---------- Settings ----------

export function validatePin(pin: string): string | null {
  if (!/^\d{4,8}$/.test(pin)) return 'The PIN must be 4 to 8 digits.';
  return null;
}

export function validateFamilyName(raw: string): Validated<string, 'familyName'> {
  const name = cleanText(raw);
  if (name === '') return { ok: false, errors: { familyName: 'Please enter a family name.' } };
  if (name.length > LIMITS.familyNameMax) {
    return { ok: false, errors: { familyName: `Keep it to ${LIMITS.familyNameMax} characters or fewer.` } };
  }
  return { ok: true, value: name };
}

// ---------- School meals ----------

export interface MealRowDraft {
  date: string;
  main: string;
  pudding: string;
}

/** Clean a week of meal rows. Errors are keyed by date. */
export function validateMealRows(
  rows: MealRowDraft[],
): { ok: true; value: MealRowDraft[] } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const value = rows.map((row) => {
    const main = cleanText(row.main);
    const pudding = cleanText(row.pudding);
    if (main.length > LIMITS.mealTextMax || pudding.length > LIMITS.mealTextMax) {
      errors[row.date] = `Keep each meal to ${LIMITS.mealTextMax} characters or fewer.`;
    }
    return { date: row.date, main, pudding };
  });
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value };
}
