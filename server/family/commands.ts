import type { DateKey, FamilyData, FoodCategory, Weekday } from '../../src/types';
import { toggleChore } from '../../src/lib/chores';
import { addFoodOption, removeFoodOption } from '../../src/lib/foodOptions';
import * as manage from '../../src/lib/manage';
import { saveMealWeek } from '../../src/lib/meals';
import { redeemReward } from '../../src/lib/rewards';
import { createSampleData } from '../../src/lib/sampleData';
import { validateChild, validateChore, validateFamilyName, validateMealRows, validateReward } from '../../src/lib/validation';
import { fromLib, isEmptyHousehold, toLib, type FamilyDocument } from './document';

// Commands are intents sent by a device. Each one maps onto the existing
// pure business-rule functions in src/lib; nothing here re-implements them.
// Edits that replace or delete an existing record must include the record
// version the device last saw (expectedVersion) so a stale edit can never
// silently overwrite a newer change made on another device.

export const COMMAND_TYPES = [
  'toggleChore',
  'redeemReward',
  'dismissMealReminder',
  'saveChild',
  'deleteChild',
  'saveChore',
  'deleteChore',
  'saveReward',
  'deleteReward',
  'saveMealWeek',
  'addFoodOption',
  'removeFoodOption',
  'updateSettings',
  'loadDemoFamily',
] as const;

export type CommandType = (typeof COMMAND_TYPES)[number];

export interface Command {
  type: CommandType;
  payload: Record<string, unknown>;
  /** Version of the target record the device last saw (0 = did not exist). */
  expectedVersion?: number;
}

export interface CommandContext {
  today: DateKey;
  now: Date;
  /** Current version of an editable record ("<kind>:<id>"), 0 if never changed. */
  recordVersion: (key: string) => number;
}

export type CommandError = {
  ok: false;
  status: 400 | 404 | 409 | 422;
  error: 'invalid_request' | 'not_found' | 'conflict' | 'rejected';
  message: string;
  fields?: Record<string, string>;
  record?: string;
  currentVersion?: number;
};

export type CommandOutcome = { ok: true; doc: FamilyDocument } | CommandError;

// ---------- payload helpers ----------

class PayloadError extends Error {}

function str(p: Record<string, unknown>, key: string, max = 200): string {
  const v = p[key];
  if (typeof v !== 'string' || v.length > max) throw new PayloadError(`"${key}" must be a string of at most ${max} characters.`);
  return v;
}
function optStr(p: Record<string, unknown>, key: string, max = 200): string | undefined {
  return p[key] === undefined ? undefined : str(p, key, max);
}
function id(p: Record<string, unknown>, key: string): string {
  const v = str(p, key, 100);
  if (v === '') throw new PayloadError(`"${key}" is required.`);
  return v;
}

const bad = (message: string): CommandError => ({ ok: false, status: 400, error: 'invalid_request', message });
const notFound = (message: string): CommandError => ({ ok: false, status: 404, error: 'not_found', message });
const rejected = (message: string, fields?: Record<string, string>): CommandError => ({
  ok: false,
  status: 422,
  error: 'rejected',
  message,
  ...(fields ? { fields } : {}),
});

/** Require and check expectedVersion for an existing record. */
function checkVersion(cmd: Command, ctx: CommandContext, key: string): CommandError | null {
  if (cmd.expectedVersion === undefined) return bad(`expectedVersion is required when changing ${key}.`);
  const current = ctx.recordVersion(key);
  if (cmd.expectedVersion !== current) {
    return {
      ok: false,
      status: 409,
      error: 'conflict',
      message: 'This was changed on another device. Reload and try again.',
      record: key,
      currentVersion: current,
    };
  }
  return null;
}

function libResult(r: { ok: true; data: FamilyData } | { ok: false; error: string }): CommandOutcome {
  return r.ok ? { ok: true, doc: fromLib(r.data) } : rejected(r.error);
}

// ---------- the command handlers ----------

export function executeCommand(cmd: Command, doc: FamilyDocument, ctx: CommandContext): CommandOutcome {
  const p = cmd.payload;
  const data = toLib(doc);
  try {
    switch (cmd.type) {
      case 'toggleChore': {
        const choreId = id(p, 'choreId');
        if (!data.chores.some((c) => c.id === choreId)) return notFound('That chore no longer exists.');
        return libResult(toggleChore(data, choreId, ctx.today, ctx.now));
      }

      case 'redeemReward': {
        const r = redeemReward(data, id(p, 'childId'), id(p, 'rewardId'), ctx.today, ctx.now);
        return r.ok ? { ok: true, doc: fromLib(r.data) } : rejected(r.error);
      }

      case 'dismissMealReminder':
        return { ok: true, doc: fromLib(manage.updateSettings(data, { mealReminderDismissedOn: ctx.today })) };

      case 'saveChild': {
        const childId = optStr(p, 'id', 100);
        const v = validateChild({ name: str(p, 'name'), avatar: str(p, 'avatar', 50), color: str(p, 'color', 30) });
        if (!v.ok) return rejected('Please check the child details.', v.errors as Record<string, string>);
        if (childId !== undefined) {
          if (!data.children.some((c) => c.id === childId)) return notFound('That profile no longer exists.');
          const conflict = checkVersion(cmd, ctx, `child:${childId}`);
          if (conflict) return conflict;
        }
        return { ok: true, doc: fromLib(manage.saveChild(data, v.value, childId)) };
      }

      case 'deleteChild': {
        const childId = id(p, 'id');
        if (!data.children.some((c) => c.id === childId)) return notFound('That profile no longer exists.');
        const conflict = checkVersion(cmd, ctx, `child:${childId}`);
        if (conflict) return conflict;
        return { ok: true, doc: fromLib(manage.deleteChild(data, childId)) };
      }

      case 'saveChore': {
        const choreId = optStr(p, 'id', 100);
        const rawDays = p.days;
        if (rawDays !== undefined && (!Array.isArray(rawDays) || rawDays.length > 7)) return bad('"days" must be a list of weekdays.');
        const days = (rawDays ?? []) as unknown[];
        if (!days.every((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)) {
          return bad('"days" must contain weekday numbers 0-6.');
        }
        const scheduleType = str(p, 'scheduleType', 10);
        if (scheduleType !== 'daily' && scheduleType !== 'weekly') return bad('"scheduleType" must be "daily" or "weekly".');
        const points = p.points;
        if (typeof points !== 'number' && typeof points !== 'string') return bad('"points" must be a number.');
        const v = validateChore(
          {
            title: str(p, 'title'),
            icon: str(p, 'icon', 50),
            childId: str(p, 'childId', 100),
            period: str(p, 'period', 20),
            points: String(points),
            scheduleType,
            days: days as Weekday[],
          },
          data.children.map((c) => c.id),
        );
        if (!v.ok) return rejected('Please check the chore details.', v.errors as Record<string, string>);
        if (choreId !== undefined) {
          if (!data.chores.some((c) => c.id === choreId)) return notFound('That chore no longer exists.');
          const conflict = checkVersion(cmd, ctx, `chore:${choreId}`);
          if (conflict) return conflict;
        }
        return { ok: true, doc: fromLib(manage.saveChore(data, v.value, choreId)) };
      }

      case 'deleteChore': {
        const choreId = id(p, 'id');
        if (!data.chores.some((c) => c.id === choreId)) return notFound('That chore no longer exists.');
        const conflict = checkVersion(cmd, ctx, `chore:${choreId}`);
        if (conflict) return conflict;
        return { ok: true, doc: fromLib(manage.deleteChore(data, choreId)) };
      }

      case 'saveReward': {
        const rewardId = optStr(p, 'id', 100);
        const cost = p.cost;
        if (typeof cost !== 'number' && typeof cost !== 'string') return bad('"cost" must be a number.');
        const v = validateReward({
          name: str(p, 'name'),
          description: optStr(p, 'description', 500) ?? '',
          icon: str(p, 'icon', 50),
          cost: String(cost),
        });
        if (!v.ok) return rejected('Please check the reward details.', v.errors as Record<string, string>);
        if (rewardId !== undefined) {
          if (!data.rewards.some((r) => r.id === rewardId)) return notFound('That reward no longer exists.');
          const conflict = checkVersion(cmd, ctx, `reward:${rewardId}`);
          if (conflict) return conflict;
        }
        return { ok: true, doc: fromLib(manage.saveReward(data, v.value, rewardId)) };
      }

      case 'deleteReward': {
        const rewardId = id(p, 'id');
        if (!data.rewards.some((r) => r.id === rewardId)) return notFound('That reward no longer exists.');
        const conflict = checkVersion(cmd, ctx, `reward:${rewardId}`);
        if (conflict) return conflict;
        return { ok: true, doc: fromLib(manage.deleteReward(data, rewardId)) };
      }

      case 'saveMealWeek': {
        const childId = id(p, 'childId');
        const monday = str(p, 'monday', 10);
        const rawRows = p.rows;
        if (!Array.isArray(rawRows) || rawRows.length > 5) return bad('"rows" must be a list of at most 5 days.');
        const rows = rawRows.map((r) => {
          if (typeof r !== 'object' || r === null) throw new PayloadError('Each row must be an object.');
          const row = r as Record<string, unknown>;
          return { date: str(row, 'date', 10), main: str(row, 'main', 200), pudding: str(row, 'pudding', 200) };
        });
        if (!data.children.some((c) => c.id === childId)) return notFound('That profile no longer exists.');
        const conflict = checkVersion(cmd, ctx, `mealWeek:${childId}:${monday}`);
        if (conflict) return conflict;
        const v = validateMealRows(rows);
        if (!v.ok) return rejected('Please check the meals.', v.errors);
        return libResult(saveMealWeek(data, childId, monday, v.value, ctx.today));
      }

      case 'addFoodOption': {
        const category = str(p, 'category', 10);
        if (category !== 'main' && category !== 'pudding') return bad('"category" must be "main" or "pudding".');
        return libResult(addFoodOption(data, category as FoodCategory, str(p, 'name')));
      }

      case 'removeFoodOption': {
        const category = str(p, 'category', 10);
        if (category !== 'main' && category !== 'pudding') return bad('"category" must be "main" or "pudding".');
        return libResult(removeFoodOption(data, category as FoodCategory, id(p, 'id'), ctx.today));
      }

      case 'updateSettings': {
        if ('parentPin' in p) return bad('The parent PIN is not stored on the server.');
        const conflict = checkVersion(cmd, ctx, 'settings:household');
        if (conflict) return conflict;
        const v = validateFamilyName(str(p, 'familyName'));
        if (!v.ok) return rejected('Please check the family name.', v.errors as Record<string, string>);
        return { ok: true, doc: fromLib(manage.updateSettings(data, { familyName: v.value })) };
      }

      case 'loadDemoFamily': {
        if (!isEmptyHousehold(doc)) {
          return { ok: false, status: 409, error: 'conflict', message: 'The demo family can only be loaded into an empty household.' };
        }
        return { ok: true, doc: fromLib(createSampleData(ctx.today, ctx.now)) };
      }

      default:
        return bad('Unknown command.');
    }
  } catch (error) {
    if (error instanceof PayloadError) return bad(error.message);
    throw error;
  }
}

