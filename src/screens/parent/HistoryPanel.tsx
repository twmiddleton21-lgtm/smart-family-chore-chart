import { useState } from 'react';
import type { DateKey, FamilyData } from '../../types';
import { addDays, parseDateKey } from '../../lib/dates';
import { mondayOf } from '../../lib/meals';
import {
  HISTORY_DAYS,
  childHistoryOn,
  clampToHistory,
  historyDayLabel,
  historyFullDate,
  historyWeekLabel,
  historyWeeks,
  inHistoryWindow,
  stepHistory,
  weekDays,
} from '../../lib/history';
import { Avatar } from '../../components/Avatar';

interface PanelProps {
  data: FamilyData;
  today: DateKey;
}

const dayChipFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric' });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

function dayChipLabel(date: DateKey, today: DateKey) {
  if (date === today) return 'Today';
  const parsed = parseDateKey(date);
  return parsed ? dayChipFormat.format(parsed) : date;
}

function completedAt(iso: string) {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : timeFormat.format(at);
}

/** Read-only chore history for the last 42 days. Changing the date never changes any data. */
export function HistoryPanel({ data, today }: PanelProps) {
  const [selected, setSelected] = useState<DateKey>(today);
  const [chosen, setFilter] = useState<string>('all');
  // A child removed on another device falls back to everyone.
  const filter = data.children.some((c) => c.id === chosen) ? chosen : 'all';
  // The window moves on at midnight; keep the selection inside it.
  const date = clampToHistory(selected, today);
  const previous = stepHistory(date, -1, today);
  const next = stepHistory(date, 1, today);
  const weeks = historyWeeks(today);
  const monday = mondayOf(date);
  const weekday = weekDays(monday).indexOf(date);
  const label = historyDayLabel(date, today);
  const full = historyFullDate(date);

  if (data.children.length === 0) {
    return (
      <div className="empty-card">
        <p>Add a child profile first (Children tab), then their chore history appears here.</p>
      </div>
    );
  }

  const children = filter === 'all' ? data.children : data.children.filter((c) => c.id === filter);
  const isPast = date < today;

  return (
    <div className="panel">
      <p className="muted history-intro">
        Ticked and unticked chores for any day in the last {HISTORY_DAYS} days ({HISTORY_DAYS / 7} weeks). Looking at an
        earlier day changes nothing.
      </p>

      <div className="history-nav" role="group" aria-label="Choose day">
        <button
          type="button"
          className="chip history-step"
          onClick={() => previous && setSelected(previous)}
          disabled={!previous}
          aria-label="Previous day"
        >
          <span aria-hidden="true">‹</span>
        </button>
        <h2 className="history-date" aria-live="polite">
          <span className="history-date-main">{label}</span>
          {label !== full && <span className="history-date-full">{full}</span>}
        </h2>
        <button
          type="button"
          className="chip history-step"
          onClick={() => next && setSelected(next)}
          disabled={!next}
          aria-label="Next day"
        >
          <span aria-hidden="true">›</span>
        </button>
      </div>

      <div className="chip-row history-weeks" role="group" aria-label="Choose week">
        {weeks.map((m) => (
          <button
            key={m}
            type="button"
            className="chip"
            aria-pressed={m === monday}
            // Same weekday in the chosen week, kept inside the window.
            onClick={() => setSelected(clampToHistory(addDays(m, weekday), today))}
          >
            {historyWeekLabel(m, today)}
          </button>
        ))}
      </div>

      <div className="chip-row history-days" role="group" aria-label="Choose a day this week">
        {weekDays(monday).map((d) => (
          <button
            key={d}
            type="button"
            className="chip history-day"
            aria-pressed={d === date}
            disabled={!inHistoryWindow(d, today)}
            onClick={() => setSelected(d)}
            aria-label={historyFullDate(d)}
          >
            {dayChipLabel(d, today)}
          </button>
        ))}
        {date !== today && (
          <button type="button" className="button button-secondary history-today" onClick={() => setSelected(today)}>
            Back to today
          </button>
        )}
      </div>

      <div className="chip-row" role="group" aria-label="Show history for">
        <button type="button" className="chip" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
          Everyone
        </button>
        {data.children.map((c) => (
          <button key={c.id} type="button" className="chip" aria-pressed={filter === c.id} onClick={() => setFilter(c.id)}>
            <span aria-hidden="true">{c.avatar}</span> {c.name}
          </button>
        ))}
      </div>

      {children.map((child) => {
        const day = childHistoryOn(data, child.id, date);
        return (
          <section key={child.id} className={`admin-group accent-${child.color}`} aria-label={`${child.name}'s chores on ${full}`}>
            <h3 className="admin-group-title">
              <Avatar child={child} size="sm" /> {child.name}
              <span className="muted">
                {' '}
                · {day.done} of {day.total} done · ⭐ {day.pointsEarned} points
              </span>
            </h3>
            {day.items.length === 0 ? (
              <p className="muted">No chores that day.</p>
            ) : (
              <ul className="admin-list">
                {day.items.map((item) => {
                  const time = item.completion ? completedAt(item.completion.completedAt) : null;
                  const status = item.done ? 'Done' : isPast ? 'Not done' : 'To do';
                  return (
                    <li key={item.key} className={`admin-row history-row ${item.done ? 'history-done' : 'history-open'}`}>
                      <span className="admin-icon" aria-hidden="true">
                        {item.icon}
                      </span>
                      <span className="admin-main">
                        <span className="admin-name">{item.title}</span>
                        <span className="admin-meta">
                          ⭐ {item.points} points
                          {item.done && time ? ` · ticked at ${time}` : ''}
                        </span>
                      </span>
                      <span className={`history-status ${item.done ? 'history-status-done' : ''}`}>
                        <span aria-hidden="true">{item.done ? '✓' : '○'}</span> {status}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}

      <p className="field-hint">
        Chores that weren’t ticked are worked out from the current chore list and schedules, so a chore added or changed
        since may show on days before it existed. Deleted chores appear only where they were ticked.
      </p>
    </div>
  );
}
