import { describe, expect, it } from 'vitest';
import { addMonths, calendarDays, dayHeading, eventColour, monthCellEntries, monthGrid, monthOf, monthsBetween, type CalendarEvent } from './calendar';

const RANGE = { start: '2026-10-24', end: '2026-10-30' };
const timed = (id: string, title: string, date: string, startTime: string, endTime: string, endDate = date): CalendarEvent => ({
  id,
  title,
  allDay: false,
  startDate: date,
  endDate,
  startTime,
  endTime,
});

describe('calendarDays', () => {
  it('lists every day of the range, including empty ones', () => {
    const days = calendarDays(RANGE, []);
    expect(days.map((d) => d.date)).toEqual(['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30']);
    expect(days.every((d) => d.entries.length === 0)).toBe(true);
  });

  it('orders all-day events first, then by start time', () => {
    const [sat] = calendarDays(RANGE, [
      timed('b', 'Swimming', '2026-10-24', '14:00', '15:00'),
      { id: 'a', title: 'Birthday', allDay: true, startDate: '2026-10-24', endDate: '2026-10-24' },
      timed('c', 'Breakfast', '2026-10-24', '08:00', '08:30'),
    ]);
    expect(sat!.entries.map((e) => [e.event.title, e.when])).toEqual([
      ['Birthday', 'All day'],
      ['Breakfast', '08:00 – 08:30'],
      ['Swimming', '14:00 – 15:00'],
    ]);
  });

  it('shows a multi-day event on each day it covers', () => {
    const days = calendarDays(RANGE, [
      timed('t', 'Sleepover', '2026-10-24', '18:00', '11:00', '2026-10-26'),
      { id: 'h', title: 'Half term', allDay: true, startDate: '2026-10-20', endDate: '2026-10-25' },
    ]);
    const on = (date: string) => days.find((d) => d.date === date)!.entries.map((e) => `${e.event.title}: ${e.when}`);
    expect(on('2026-10-24')).toEqual(['Half term: All day', 'Sleepover: From 18:00']);
    expect(on('2026-10-25')).toEqual(['Half term: All day', 'Sleepover: Continues']);
    expect(on('2026-10-26')).toEqual(['Sleepover: Until 11:00']);
    expect(on('2026-10-27')).toEqual([]);
  });
});

describe('monthGrid (Sunday-to-Saturday month view)', () => {
  it.each([
    // month, first day shown, last day shown, weeks
    ['2026-10', '2026-09-27', '2026-10-31', 5], // 1 October is a Thursday; 31 October a Saturday (no days from November)
    ['2026-08', '2026-07-26', '2026-09-05', 6], // 1 August is a Saturday: six weeks
    ['2026-11', '2026-11-01', '2026-12-05', 5], // starts on a Sunday
    ['2026-02', '2026-02-01', '2026-02-28', 4], // 28 days from a Sunday: exactly four weeks
    ['2027-05', '2027-04-25', '2027-06-05', 6], // 31 days from a Saturday: six weeks
    ['2026-12', '2026-11-29', '2027-01-02', 5], // into the next year
    ['2028-02', '2028-01-30', '2028-03-04', 5], // leap year (29 February)
  ])('%s runs from %s to %s in %i weeks', (month, start, end, weeks) => {
    const grid = monthGrid(month);
    expect(grid).toMatchObject({ month, start, end });
    expect(grid.weeks).toHaveLength(weeks);
    expect(grid.weeks.every((w) => w.length === 7)).toBe(true);
    expect(grid.weeks.flat()[0]).toBe(start);
    expect(grid.weeks.flat().at(-1)).toBe(end);
    // Every day of the month is in the grid exactly once, in order.
    const days = grid.weeks.flat();
    expect(new Set(days).size).toBe(days.length);
    expect(days.filter((d) => d.startsWith(month))).toHaveLength(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0)).getUTCDate());
  });

  it('keeps its weeks Sunday-first across the clocks changing', () => {
    // London's clocks go back on 25 October 2026 and forward on 29 March 2026.
    for (const month of ['2026-03', '2026-10']) {
      for (const week of monthGrid(month).weeks) expect(new Date(`${week[0]}T12:00:00Z`).getUTCDay(), `${month} ${week[0]}`).toBe(0);
    }
  });

  it('steps between months and years', () => {
    expect(addMonths('2026-10', 1)).toBe('2026-11');
    expect(addMonths('2026-12', 1)).toBe('2027-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2026-10', -22)).toBe('2024-12');
    expect(monthsBetween('2026-10', '2027-10')).toBe(12);
    expect(monthsBetween('2026-10', '2025-10')).toBe(-12);
    expect(monthOf('2026-10-24')).toBe('2026-10');
  });
});

describe('monthCellEntries', () => {
  const halfTerm: CalendarEvent = { id: 'h', title: 'Half term', allDay: true, startDate: '2026-10-22', endDate: '2026-10-27' };
  const day = (date: string, events: CalendarEvent[]) => calendarDays({ start: date, end: date }, events)[0]!;

  it('draws all-day and multi-day events as blocks, squared where they run on, titled on their first day and each new week', () => {
    const at = (date: string) => {
      const [e] = monthCellEntries(day(date, [halfTerm]));
      return { block: e!.block, before: e!.continuesBefore, after: e!.continuesAfter, title: e!.showTitle };
    };
    expect(at('2026-10-22')).toEqual({ block: true, before: false, after: true, title: true }); // Thursday: first day
    expect(at('2026-10-24')).toEqual({ block: true, before: true, after: true, title: false }); // Saturday: carries on
    expect(at('2026-10-25')).toEqual({ block: true, before: true, after: true, title: true }); // Sunday: a new week row
    expect(at('2026-10-27')).toEqual({ block: true, before: true, after: false, title: false }); // last day
  });

  it('draws a single-day timed event as a timed row, and an overnight one as a block', () => {
    const swim = timed('s', 'Swimming', '2026-10-24', '09:00', '10:00');
    const sleepover = timed('o', 'Sleepover', '2026-10-24', '18:00', '10:00', '2026-10-25');
    const entries = monthCellEntries(day('2026-10-24', [swim, sleepover]));
    expect(entries.map((e) => [e.event.title, e.block, e.continuesAfter])).toEqual([
      ['Swimming', false, false],
      ['Sleepover', true, true],
    ]);
  });
});

describe('eventColour', () => {
  it('gives a repeating event (same title) the same colour, from a fixed palette', () => {
    expect(eventColour({ title: 'Swimming' })).toBe(eventColour({ title: 'Swimming' }));
    const colours = new Set(['Swimming', 'Football', 'Dentist', 'Piano', 'Half term', 'Birthday', 'Library', 'Cubs'].map((title) => eventColour({ title })));
    expect(colours.size).toBeGreaterThan(3);
    for (const c of colours) expect(c).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe('dayHeading', () => {
  it('names today and tomorrow, with the full date as detail', () => {
    expect(dayHeading('2026-10-24', '2026-10-24').label).toBe('Today');
    expect(dayHeading('2026-10-25', '2026-10-24').label).toBe('Tomorrow');
    expect(dayHeading('2026-10-24', '2026-10-24').detail).toMatch(/24/);
    expect(dayHeading('2026-10-27', '2026-10-24')).toEqual({ label: expect.stringMatching(/27/), detail: null });
  });
});
