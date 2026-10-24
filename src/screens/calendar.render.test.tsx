import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DevModeBanner } from '../components/ServerStatus';
import type { CalendarResponse } from '../lib/calendar';
import { makeFamily } from '../lib/testFixtures';
import { ChoreItem } from '../components/ChoreItem';
import { CalendarView, type CalendarLoad } from './CalendarScreen';
import { Dashboard } from './Dashboard';

// Static render checks (no DOM or browser): the markup for each state.
// Calendar data here is made up; nothing contacts Google.

const noop = () => {};
const TODAY = '2026-10-24';
const view = (load: CalendarLoad, month?: string) => renderToStaticMarkup(<CalendarView load={load} today={TODAY} month={month} onBack={noop} onRefresh={noop} />);
const loaded = (response: CalendarResponse, month?: string) => view({ state: 'loaded', response }, month);

const LONG_TITLE = 'Grandma and Grandad’s anniversary lunch at the riverside garden centre café';
/** October 2026's grid: Sunday 27 September to Saturday 31 October (five weeks). */
const OCTOBER = { start: '2026-09-27', end: '2026-10-31' };
/** November 2026's grid: Sunday 1 November to Saturday 5 December. */
const NOVEMBER = { start: '2026-11-01', end: '2026-12-05' };
/** A day's accessible name, whichever way the test machine's language punctuates dates. */
const dayLabel = (weekday: string, rest: string) => new RegExp(`aria-label="${weekday},? ${rest}`);
const OK: CalendarResponse = {
  status: 'ok',
  calendarName: 'Rivera Family',
  timeZone: 'Europe/London',
  range: OCTOBER,
  fetchedAt: '2026-10-24T07:00:00.000Z',
  stale: false,
  source: 'google',
  events: [
    { id: 'a', title: 'Football training', allDay: false, startDate: '2026-10-24', endDate: '2026-10-24', startTime: '09:30', endTime: '11:00', location: 'Park pitches' },
    { id: 'b', title: LONG_TITLE, allDay: false, startDate: '2026-10-25', endDate: '2026-10-25', startTime: '12:30', endTime: '15:00' },
    { id: 'c', title: 'Half term', allDay: true, startDate: '2026-10-26', endDate: '2026-10-29' },
    { id: 'd', title: 'Harvest festival', allDay: true, startDate: '2026-09-28', endDate: '2026-09-28' }, // in September's days at the start of the grid
  ],
};

/** The markup of one day's cell (between its date button and the next cell). */
const cell = (html: string, dateLabel: RegExp) => {
  const i = html.search(dateLabel);
  expect(i, String(dateLabel)).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<div role="cell"', i);
  const end = html.indexOf('<div role="cell"', i);
  return html.slice(start, end < 0 ? undefined : end);
};

describe('family calendar page', () => {
  it('always offers a way back to the chore chart', () => {
    for (const html of [view({ state: 'loading' }), view({ state: 'unreachable' }), loaded(OK), loaded({ status: 'not_configured' })]) {
      expect(html).toContain('Back to chore chart');
      expect(html).toContain('Family Calendar');
    }
  });

  it('shows a loading state', () => {
    const html = view({ state: 'loading' });
    expect(html).toContain('Loading the family calendar');
    expect(html).toContain('aria-busy="true"');
  });

  it('shows the whole month as a Sunday-to-Saturday grid, with the neighbouring months’ days', () => {
    const html = loaded(OK);
    expect(html).toContain('<strong>Rivera Family</strong>');
    expect(html).toContain('read-only from Google Calendar');
    expect(html).toMatch(/<h2 class="calendar-month-title"[^>]*>October 2026<\/h2>/);
    // Seven weekday columns, Sunday first.
    expect(html.match(/role="columnheader"/g)).toHaveLength(7);
    expect(html).toMatch(/role="columnheader"><abbr title="Sunday">/);
    // Five weeks of seven days: 27 September to 31 October.
    expect(html.match(/role="row"/g)).toHaveLength(1 + 5);
    expect(html.match(/role="cell"/g)).toHaveLength(35);
    expect(cell(html, dayLabel('Sunday', '27 September 2026'))).toContain('month-cell-outside');
    expect(cell(html, dayLabel('Thursday', '1 October 2026'))).not.toContain('month-cell-outside');
    expect(cell(html, dayLabel('Thursday', '1 October 2026'))).toMatch(/>1 Oct<\/button>/); // the 1st names its month
    expect(html).not.toContain('role="alert"');
  });

  it('shows the next month’s days at the end of the grid, with their events', () => {
    const html = loaded(
      {
        ...OK,
        range: NOVEMBER,
        events: [{ id: 'e', title: 'Christmas fair', allDay: false, startDate: '2026-12-04', endDate: '2026-12-04', startTime: '18:00', endTime: '20:00' }],
      } as CalendarResponse,
      '2026-11',
    );
    expect(html.match(/role="cell"/g)).toHaveLength(35);
    const fri = cell(html, dayLabel('Friday', '4 December 2026'));
    expect(fri).toContain('month-cell-outside');
    expect(fri).toMatch(/18:00.*Christmas fair/);
  });

  it('puts each event in its day’s cell: timed ones with their start time, all-day ones as blocks', () => {
    const html = loaded(OK);
    const sat = cell(html, dayLabel('Saturday', '24 October 2026 \\(today\\): 1 event"'));
    expect(sat).toContain('month-cell-today');
    expect(sat).toContain('aria-current="date"');
    expect(sat).toMatch(/month-event-timed.*<span class="month-event-time">09:30<\/span>.*Football training/);
    expect(sat).toContain('title="09:30 – 11:00: Football training (Park pitches)"');
    expect(cell(html, dayLabel('Sunday', '25 October 2026'))).toContain(LONG_TITLE); // the whole title is there; the cell shortens it visually
    // A four-day all-day event: a block in each of its days, squared where it runs on.
    for (const [weekday, date, from, on] of [
      ['Monday', '26', false, true],
      ['Tuesday', '27', true, true],
      ['Thursday', '29', true, false],
    ] as const) {
      const c = cell(html, dayLabel(weekday, `${date} October 2026`));
      expect(c, date).toContain('month-event-block');
      expect(c.includes('month-event-from-before'), date).toBe(from);
      expect(c.includes('month-event-goes-on'), date).toBe(on);
    }
    expect(cell(html, dayLabel('Friday', '30 October 2026'))).not.toContain('Half term');
    // Events in the previous month's days at the start of the grid are shown too.
    expect(cell(html, dayLabel('Monday', '28 September 2026'))).toContain('Harvest festival');
  });

  it('shows "N more" when a day has more events than fit, and never drops one silently', () => {
    const busy = Array.from({ length: 6 }, (_, i) => ({
      id: `x${i}`,
      title: `Club ${i + 1}`,
      allDay: false,
      startDate: '2026-10-14',
      endDate: '2026-10-14',
      startTime: `1${i}:00`,
      endTime: `1${i}:30`,
    }));
    const html = loaded({ ...OK, events: busy } as CalendarResponse);
    const c = cell(html, dayLabel('Wednesday', '14 October 2026: 6 events"'));
    // Three rows before the page has measured the cell: two events and "4 more".
    expect(c.match(/month-event /g)).toHaveLength(2);
    expect(c).toMatch(/<button type="button" class="month-more">4(<!-- -->)? more<\/button>/);
  });

  it('shows other months: e.g. February 2026 needs only four weeks, and the Today button comes back', () => {
    const feb = { start: '2026-02-01', end: '2026-02-28' };
    const html = loaded({ ...OK, range: feb, events: [] } as CalendarResponse, '2026-02');
    expect(html).toMatch(/>February 2026<\/h2>/);
    expect(html.match(/role="cell"/g)).toHaveLength(28);
    expect(html).not.toContain('month-cell-today');
    expect(html).toMatch(/<button type="button" class="button button-secondary calendar-today-button">Today<\/button>/);
    // In the current month, Today is disabled.
    expect(loaded(OK)).toMatch(/calendar-today-button" disabled="">Today/);
  });

  it('puts the arrows either side of the month, and Today beside Refresh (not with the arrows)', () => {
    const html = loaded(OK);
    const nav = /<nav class="calendar-nav" aria-label="Month">(.*?)<\/nav>/.exec(html)![1]!;
    // ‹ October 2026 › — in that order, nothing else.
    expect(nav).toMatch(/^<button[^>]*aria-label="Previous month"[^>]*>.*?<\/button><h2 class="calendar-month-title"[^>]*>October 2026<\/h2><button[^>]*aria-label="Next month"[^>]*>.*?<\/button>$/);
    expect(nav).not.toContain('Today');
    const end = /<div class="calendar-toolbar-end">(.*?)<\/div><\/header>/.exec(html)![1]!;
    expect(end).toMatch(/calendar-today-button[^>]*>Today<\/button><button[^>]*aria-label="Refresh"/);
    // The back button and title are in the first column.
    expect(html).toMatch(/<div class="calendar-toolbar-start"><button[^>]*aria-label="Back to chore chart"/);
  });

  it('stops the month buttons a year either way (as far as the server answers)', () => {
    const html = (month: string) => view({ state: 'loading' }, month);
    expect(html('2027-10')).toMatch(/aria-label="Next month" disabled=""/);
    expect(html('2027-10')).not.toMatch(/aria-label="Previous month" disabled=""/);
    expect(html('2025-10')).toMatch(/aria-label="Previous month" disabled=""/);
  });

  it('shows the grid (without another month’s events) while a month loads', () => {
    // Still holding October's answer while November loads.
    const html = loaded(OK, '2026-11');
    expect(html).toMatch(/>November 2026<\/h2>/);
    expect(html).toContain('Loading the family calendar');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('Football training');
  });

  it('names where the events come from (Google or a calendar address)', () => {
    expect(loaded({ ...OK, source: 'ical' } as CalendarResponse)).toContain('read-only from a calendar address');
    expect(loaded({ ...OK, source: 'ical', stale: true } as CalendarResponse)).toContain('Can’t reach the calendar right now.');
  });

  it('marks a stale copy when Google is unreachable', () => {
    expect(loaded({ ...OK, stale: true } as CalendarResponse)).toContain('Can’t reach Google Calendar right now. Showing events as they were');
  });

  it.each([
    [{ status: 'not_configured' } as const, 'isn’t set up yet', false],
    [{ status: 'not_connected' } as const, 'Parent area → Settings → Integrations', false],
    [{ status: 'error', reason: 'auth', source: 'google' } as const, 'needs attention', true],
    [{ status: 'error', reason: 'setup', source: 'google' } as const, 'Google settings need checking', true],
    [{ status: 'error', reason: 'access', source: 'google' } as const, 'won’t share this calendar', true],
    [{ status: 'error', reason: 'not_found', source: 'google' } as const, 'Calendar not found', true],
    [{ status: 'error', reason: 'unavailable', source: 'google' } as const, 'Can’t reach Google Calendar', true],
    // The same problems for a calendar address (iCal) are worded without Google.
    [{ status: 'error', reason: 'auth', source: 'ical' } as const, 'calendar address stopped working', true],
    [{ status: 'error', reason: 'feed_invalid', source: 'ical' } as const, 'address isn’t working', true],
    [{ status: 'error', reason: 'unavailable', source: 'ical' } as const, 'Can’t reach the calendar right now', true],
  ])('explains %j', (response, text, retry) => {
    const html = loaded(response);
    expect(html).toContain(text);
    expect(html).toContain('role="alert"');
    expect(html.includes('Try again')).toBe(retry);
    expect(html).not.toContain('month-grid');
  });

  it('explains an unreachable family server', () => {
    const html = view({ state: 'unreachable' });
    expect(html).toContain('Can’t reach the family server');
    expect(html).toContain('Try again');
  });
});

describe('pre-release strip (removed)', () => {
  it('the banner renders nothing outside development mode', () => {
    expect(renderToStaticMarkup(<DevModeBanner />)).toBe('');
  });

  it('the wording appears nowhere in the app’s source', () => {
    const root = fileURLToPath(new URL('..', import.meta.url)); // src/
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((f) => /\.(tsx?|css|html)$/.test(f) && !/\.test\.tsx?$/.test(f));
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) expect(readFileSync(path.join(root, f), 'utf8'), f).not.toMatch(/Pre-release build|Not ready for real family data/);
    expect(readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8')).not.toMatch(/Pre-release build/);
  });
});

describe('home page Family Calendar button', () => {
  const render = (onOpenCalendar?: () => void) =>
    renderToStaticMarkup(<Dashboard data={makeFamily()} today={TODAY} onSelectChild={noop} onOpenParent={noop} onOpenCalendar={onOpenCalendar} />);

  it('is shown when the build has a family calendar (server builds)', () => {
    expect(render(noop)).toMatch(/<button type="button" class="button button-calendar">.*Family Calendar<\/button>/);
  });

  it('is absent in the browser-only build', () => {
    expect(render()).not.toContain('Family Calendar');
  });
});

describe('chore item layout', () => {
  const chore = { ...makeFamily().chores[0]!, title: 'Unload and reorganise the dishwasher now', points: 10 };

  it('puts the points on the row below the full title, never beside it', () => {
    const html = renderToStaticMarkup(<ChoreItem chore={chore} done={false} onToggle={noop} />);
    expect(html).toMatch(
      /<span class="chore-text"><span class="chore-title">Unload and reorganise the dishwasher now<\/span><span class="chore-meta"><span class="chore-status">To do<\/span><span class="chore-points" aria-hidden="true">.*10<\/span><\/span><\/span>/,
    );
    expect(html).toContain('aria-label="Unload and reorganise the dishwasher now, 10 points, not done yet. Tap when finished."');
  });
});
