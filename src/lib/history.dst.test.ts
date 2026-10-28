import { afterEach, describe, expect, it } from 'vitest';
import { HISTORY_DAYS, clampToHistory, historyWeeks, historyWindow, stepHistory, weekDays } from './history';
import { addDays } from './dates';

// History dates under real daylight-saving rules. Node applies a change of
// process.env.TZ at once. Europe/London changes at 01:00; America/Santiago
// at midnight, so on its spring-forward day local midnight doesn't exist
// (the hardest case for date keys built from local Dates).
const original = process.env.TZ;
afterEach(() => {
  process.env.TZ = original;
});

/** The next calendar date, worked out in UTC (no time zone involved). */
function nextDateUtc(key: string): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

describe.each(['Europe/London', 'America/Santiago', 'UTC'])('chore history dates in %s', (zone) => {
  it('steps one calendar day at a time through a whole year, including the clock changes', () => {
    process.env.TZ = zone;
    if (zone === 'America/Santiago') {
      // Proves the zone is active: midnight on 6 Sep 2026 is skipped, so local "midnight" is 01:00.
      expect(new Date(2026, 8, 6).getHours()).toBe(1);
    }
    let day = '2026-01-01';
    for (let i = 0; i < 400; i++) {
      const next = addDays(day, 1);
      expect(next).toBe(nextDateUtc(day));
      expect(addDays(next, -1)).toBe(day);
      day = next;
    }
  });

  it('keeps exactly 42 distinct days in the window and walks it with previous/next', () => {
    process.env.TZ = zone;
    for (const today of ['2026-03-29', '2026-04-05', '2026-09-06', '2026-10-25', '2027-01-01', '2026-11-03']) {
      const { start, end } = historyWindow(today);
      const days: string[] = [];
      for (let d: string | null = end; d !== null; d = stepHistory(d, -1, today)) days.push(d);
      expect(days).toHaveLength(HISTORY_DAYS);
      expect(new Set(days).size).toBe(HISTORY_DAYS);
      expect(days.at(-1)).toBe(start);
      expect(clampToHistory(addDays(start, -1), today)).toBe(start);
      // Weeks are 7 distinct days, Monday first, and cover the window.
      const weeks = historyWeeks(today);
      expect(weeks.length === 6 || weeks.length === 7).toBe(true);
      const covered = new Set(weeks.flatMap(weekDays));
      for (const d of days) expect(covered.has(d)).toBe(true);
    }
  });
});
