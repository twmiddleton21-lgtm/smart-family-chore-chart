import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { DateKey } from '../types';
import { ApiError, createRequester } from '../api/client';
import {
  addMonths,
  CALENDAR_PROBLEMS,
  calendarDays,
  calendarProblem,
  dayHeading,
  eventColour,
  monthCellEntries,
  monthGrid,
  monthLabel,
  monthOf,
  monthsBetween,
  MONTH_VIEW_REACH,
  SOURCE_LABELS,
  WEEKDAYS,
  type CalendarDay,
  type CalendarResponse,
  type MonthKey,
} from '../lib/calendar';
import { parseDateKey } from '../lib/dates';
import { Modal } from '../components/Modal';
import { ScreenTitle } from '../components/ScreenTitle';

// Family calendar page (server builds only). Read-only: a month view of the
// family's calendar (Google or a private iCal address), fetched by the family
// server for the weeks the month grid shows. It is separate from chores and
// rewards and changes nothing.

export type CalendarLoad =
  | { state: 'loading' }
  | { state: 'loaded'; response: CalendarResponse }
  | { state: 'unreachable' };

const request = createRequester();
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const shortMonth = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const fullDate = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

interface CalendarScreenProps {
  today: DateKey;
  onBack: () => void;
}

export function CalendarScreen({ today, onBack }: CalendarScreenProps) {
  const [month, setMonth] = useState<MonthKey>(() => monthOf(today));
  const [load, setLoad] = useState<CalendarLoad>({ state: 'loading' });
  const current = useRef(0);

  const refresh = useCallback(async (shown: MonthKey) => {
    const id = ++current.current;
    const { start, end } = monthGrid(shown);
    // Refreshing the same month keeps its events on screen meanwhile.
    setLoad((prev) => (prev.state === 'loaded' && prev.response.status === 'ok' && prev.response.range.start === start ? prev : { state: 'loading' }));
    try {
      const response = await request<CalendarResponse>('GET', `/api/calendar?start=${start}&end=${end}`, undefined, { timeoutMs: 20_000 });
      if (id === current.current) setLoad({ state: 'loaded', response });
    } catch (error) {
      // 401 (sign-in ended) is handled by the app's sign-in check, which
      // locks the screen; everything else here means "can't reach the server".
      if (id === current.current && !(error instanceof ApiError && error.kind === 'unauthenticated')) setLoad({ state: 'unreachable' });
    }
  }, []);

  useEffect(() => {
    void refresh(month);
  }, [refresh, month]);

  return <CalendarView load={load} today={today} month={month} onMonthChange={setMonth} onBack={onBack} onRefresh={() => void refresh(month)} />;
}

interface CalendarViewProps {
  load: CalendarLoad;
  today: DateKey;
  /** The month shown (default: today's). */
  month?: MonthKey;
  onMonthChange?: (month: MonthKey) => void;
  onBack: () => void;
  onRefresh: () => void;
}

/** The page for a given load state and month (no fetching; rendered directly by tests). */
export function CalendarView({ load, today, month = monthOf(today), onMonthChange = () => {}, onBack, onRefresh }: CalendarViewProps) {
  const grid = monthGrid(month);
  const response = load.state === 'loaded' ? load.response : null;
  // Events only for the month they were fetched for.
  const ok = response?.status === 'ok' && response.range.start === grid.start && response.range.end === grid.end ? response : null;
  const problem =
    load.state === 'unreachable'
      ? CALENDAR_PROBLEMS.unreachable
      : response?.status === 'not_configured' || response?.status === 'not_connected'
        ? CALENDAR_PROBLEMS[response.status]
        : response?.status === 'error'
          ? calendarProblem(response.reason, response.source)
          : null;
  // Waiting for a grown-up, not for the network: "Try again" wouldn't help.
  const retryable = !(response?.status === 'not_configured' || response?.status === 'not_connected');
  const loading = load.state === 'loading' || (response?.status === 'ok' && !ok);
  const reach = monthsBetween(monthOf(today), month);
  const [openDay, setOpenDay] = useState<DateKey | null>(null);
  const days = calendarDays(grid, ok?.events ?? []);
  const dayOf = (date: DateKey) => days.find((d) => d.date === date)!;

  return (
    <main className="screen calendar-screen" aria-busy={loading}>
      {/* Three columns: back and title | ‹ month › (centred) | Today and Refresh. */}
      <header className="calendar-toolbar">
        <div className="calendar-toolbar-start">
          <button type="button" className="button button-ghost calendar-back" onClick={onBack} aria-label="Back to chore chart">
            <span aria-hidden="true">←</span> Chore chart
          </button>
          <div className="calendar-brand">
            <span className="calendar-brand-icon" aria-hidden="true">
              📅
            </span>
            <div className="calendar-brand-text">
              <ScreenTitle className="calendar-brand-title">Family Calendar</ScreenTitle>
              {ok && (
                <p className="calendar-source">
                  <strong>{ok.calendarName}</strong>
                  <span>{SOURCE_LABELS[ok.source]}</span>
                </p>
              )}
            </div>
          </div>
        </div>
        {!problem && (
          <nav className="calendar-nav" aria-label="Month">
            <button
              type="button"
              className="icon-button calendar-step"
              aria-label="Previous month"
              onClick={() => onMonthChange(addMonths(month, -1))}
              disabled={reach <= -MONTH_VIEW_REACH}
            >
              <span aria-hidden="true">‹</span>
            </button>
            <h2 className="calendar-month-title" aria-live="polite">
              {monthLabel(month)}
            </h2>
            <button
              type="button"
              className="icon-button calendar-step"
              aria-label="Next month"
              onClick={() => onMonthChange(addMonths(month, 1))}
              disabled={reach >= MONTH_VIEW_REACH}
            >
              <span aria-hidden="true">›</span>
            </button>
          </nav>
        )}
        <div className="calendar-toolbar-end">
          {loading && !problem && (
            <p className="calendar-loading" role="status">
              Loading the family calendar…
            </p>
          )}
          {!problem && (
            <button type="button" className="button button-secondary calendar-today-button" onClick={() => onMonthChange(monthOf(today))} disabled={reach === 0}>
              Today
            </button>
          )}
          {load.state !== 'loading' && (
            <button type="button" className="icon-button calendar-refresh" onClick={onRefresh} aria-label="Refresh" title="Refresh">
              <span aria-hidden="true">🔄</span>
            </button>
          )}
        </div>
      </header>

      {ok?.stale && (
        <p className="banner banner-warning calendar-note" role="status">
          Can’t reach {ok.source === 'google' ? 'Google Calendar' : 'the calendar'} right now. Showing events as they were at{' '}
          {timeFormat.format(new Date(ok.fetchedAt))}.
        </p>
      )}

      {problem ? (
        <div className="status-card calendar-status" role="alert">
          <p className="status-emoji" aria-hidden="true">
            {problem.emoji}
          </p>
          <h2 className="calendar-status-title">{problem.title}</h2>
          <p className="status-message">{problem.message}</p>
          {retryable && (
            <button type="button" className="button button-primary" onClick={onRefresh}>
              Try again
            </button>
          )}
        </div>
      ) : (
        <MonthGridView grid={grid} days={days} today={today} onOpenDay={setOpenDay} />
      )}

      {openDay && <DayDialog day={dayOf(openDay)} today={today} onClose={() => setOpenDay(null)} />}
    </main>
  );
}

/**
 * How many event rows fit in a day cell: the space below the date, measured
 * on the first cell, divided by one row's height (--month-row in the CSS).
 */
function useEventSlots(weeks: number) {
  const ref = useRef<HTMLDivElement>(null);
  // Before measuring (and when rendered without a browser): three rows, or two and "N more".
  const [slots, setSlots] = useState({ all: 3, withMore: 2 });
  useLayoutEffect(() => {
    const body = ref.current;
    if (!body || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      const cell = body.querySelector<HTMLElement>('.month-cell');
      const date = cell?.querySelector<HTMLElement>('.month-date');
      if (!cell || !date) return;
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const row = (parseFloat(getComputedStyle(body).getPropertyValue('--month-row')) || 1.45) * rem;
      const cellStyle = getComputedStyle(cell);
      const used = date.offsetTop - cell.offsetTop + date.offsetHeight + parseFloat(getComputedStyle(date).marginBottom) + parseFloat(cellStyle.paddingBottom);
      const space = cell.clientHeight - used;
      // The "N more" line is shorter than an event row (about 0.8 of one).
      const all = Math.max(1, Math.floor(space / row));
      const withMore = Math.max(0, Math.floor((space - 0.8 * row) / row));
      setSlots((prev) => (prev.all === all && prev.withMore === withMore ? prev : { all, withMore }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(body);
    return () => observer.disconnect();
  }, [weeks]);
  return { ref, slots };
}

interface MonthGridViewProps {
  grid: ReturnType<typeof monthGrid>;
  days: CalendarDay[];
  today: DateKey;
  onOpenDay: (date: DateKey) => void;
}

/** The month as a Sunday-to-Saturday grid, events inside their days. */
function MonthGridView({ grid, days, today, onOpenDay }: MonthGridViewProps) {
  const { ref, slots } = useEventSlots(grid.weeks.length);
  const byDate = new Map(days.map((d) => [d.date, d]));

  return (
    <div className="month-grid" role="table" aria-label={monthLabel(grid.month)} style={{ '--month-weeks': grid.weeks.length } as CSSProperties}>
      <div className="month-weekdays" role="row">
        {WEEKDAYS.map((w) => (
          <div key={w.long} className="month-weekday" role="columnheader">
            <abbr title={w.long}>{w.short}</abbr>
          </div>
        ))}
      </div>
      <div className="month-body" ref={ref} role="rowgroup">
        {grid.weeks.map((week) => (
          <div key={week[0]} className="month-week" role="row">
            {week.map((date) => {
              const day = byDate.get(date) ?? { date, entries: [] };
              const entries = monthCellEntries(day);
              // All of them if they fit; otherwise as many as fit above "N more".
              const shown = entries.length <= slots.all ? entries : entries.slice(0, slots.withMore);
              const hidden = entries.length - shown.length;
              const outside = date.slice(0, 7) !== grid.month;
              const d = parseDateKey(date)!;
              const isFirst = date.endsWith('-01');
              return (
                <div
                  key={date}
                  role="cell"
                  className={['month-cell', outside ? 'month-cell-outside' : '', date === today ? 'month-cell-today' : ''].filter(Boolean).join(' ')}
                >
                  <button
                    type="button"
                    className="month-date"
                    onClick={() => onOpenDay(date)}
                    aria-label={`${fullDate.format(d)}${date === today ? ' (today)' : ''}: ${entries.length === 0 ? 'nothing on' : entries.length === 1 ? '1 event' : `${entries.length} events`}`}
                    aria-current={date === today ? 'date' : undefined}
                  >
                    {isFirst ? shortMonth.format(d) : d.getDate()}
                  </button>
                  {shown.length > 0 && (
                    <ul className="month-events">
                      {shown.map(({ event, when, block, continuesBefore, continuesAfter, showTitle }) => (
                        <li key={event.id}>
                          <button
                            type="button"
                            className={[
                              'month-event',
                              block ? 'month-event-block' : 'month-event-timed',
                              continuesBefore ? 'month-event-from-before' : '',
                              continuesAfter ? 'month-event-goes-on' : '',
                            ]
                              .filter(Boolean)
                              .join(' ')}
                            style={{ '--event-colour': eventColour(event) } as CSSProperties}
                            title={`${when}: ${event.title}${event.location ? ` (${event.location})` : ''}`}
                            onClick={() => onOpenDay(date)}
                          >
                            {!block && <span className="month-event-dot" aria-hidden="true" />}
                            {!block && !continuesBefore && event.startTime && <span className="month-event-time">{event.startTime}</span>}
                            <span className={showTitle ? 'month-event-title' : 'visually-hidden'}>
                              {block ? '' : <span className="visually-hidden">{when}: </span>}
                              {event.title}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {hidden > 0 && (
                    <button type="button" className="month-more" onClick={() => onOpenDay(date)}>
                      {hidden} more
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Everything on one day, in full: opened from a date, an event or "N more". */
function DayDialog({ day, today, onClose }: { day: CalendarDay; today: DateKey; onClose: () => void }) {
  const heading = dayHeading(day.date, today);
  return (
    <Modal title={heading.detail ? `${heading.label} · ${heading.detail}` : heading.label} onClose={onClose}>
      {day.entries.length === 0 ? (
        <p className="calendar-empty">Nothing on the calendar.</p>
      ) : (
        <ul className="calendar-events">
          {day.entries.map(({ event, when }) => (
            <li key={event.id} className="calendar-event" style={{ '--event-colour': eventColour(event) } as CSSProperties}>
              <span className="calendar-event-when">{when}</span>
              <span className="calendar-event-text">
                <span className="calendar-event-title">{event.title}</span>
                {event.location && (
                  <span className="calendar-event-location">
                    <span aria-hidden="true">📍 </span>
                    <span className="visually-hidden">Location: </span>
                    {event.location}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
