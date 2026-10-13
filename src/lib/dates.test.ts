import { describe, expect, it } from 'vitest';
import { addDays, describeSchedule, isScheduledOn, parseDateKey, toDateKey, weekdayOf } from './dates';
import { MONDAY, SUNDAY, TUESDAY } from './testFixtures';

describe('date keys', () => {
  it('uses the local calendar date, not UTC', () => {
    // 23:30 local time must stay on the same local day.
    expect(toDateKey(new Date(2026, 9, 13, 23, 30))).toBe('2026-10-13');
    expect(toDateKey(new Date(2026, 9, 13, 0, 5))).toBe('2026-10-13');
  });

  it('parses valid keys and rejects invalid ones', () => {
    expect(parseDateKey('2026-10-13')?.getDate()).toBe(13);
    expect(parseDateKey('2026-02-31')).toBeNull();
    expect(parseDateKey('13/10/2026')).toBeNull();
    expect(parseDateKey('')).toBeNull();
  });

  it('knows the weekday', () => {
    expect(weekdayOf(MONDAY)).toBe(1);
    expect(weekdayOf(TUESDAY)).toBe(2);
    expect(weekdayOf(SUNDAY)).toBe(0);
  });

  it('adds days across month and year boundaries', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('recurring schedules', () => {
  it('daily chores are available every day', () => {
    for (let i = 0; i < 7; i++) {
      expect(isScheduledOn({ type: 'daily' }, addDays(MONDAY, i))).toBe(true);
    }
  });

  it('weekly chores are only available on selected days', () => {
    const monWed = { type: 'weekly', days: [1, 3] } as const;
    expect(isScheduledOn({ ...monWed, days: [...monWed.days] }, MONDAY)).toBe(true);
    expect(isScheduledOn({ ...monWed, days: [...monWed.days] }, TUESDAY)).toBe(false);
    expect(isScheduledOn({ ...monWed, days: [...monWed.days] }, addDays(MONDAY, 2))).toBe(true);
    expect(isScheduledOn({ ...monWed, days: [...monWed.days] }, addDays(MONDAY, 7))).toBe(true);
  });

  it('describes schedules in plain words', () => {
    expect(describeSchedule({ type: 'daily' })).toBe('Every day');
    expect(describeSchedule({ type: 'weekly', days: [1, 2, 3, 4, 5] })).toBe('Weekdays');
    expect(describeSchedule({ type: 'weekly', days: [0, 6] })).toBe('Weekends');
    expect(describeSchedule({ type: 'weekly', days: [3, 1] })).toBe('Mon, Wed');
  });
});
