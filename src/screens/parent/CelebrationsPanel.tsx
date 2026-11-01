import { useState } from 'react';
import { THEME_IDS, type BirthdayReward, type Child, type DateKey, type FamilyData, type ThemeId } from '../../types';
import {
  THEMES,
  activeTheme,
  birthdayLabel,
  birthdayOf,
  customDatesFor,
  daysBetween,
  seasonGreeting,
  themeStatus,
  type ThemeStatus,
} from '../../lib/celebrations';
import { parseDateKey } from '../../lib/dates';
import { Avatar } from '../../components/Avatar';
import { recordKey } from '../../state/apiCommands';
import type { FamilyActions } from '../../state/storeTypes';
import { useToast } from '../../state/toast';
import type { CelebrationPreview } from '../../state/celebration';
import { BirthdayDialog, birthdayRewardStatus } from './BirthdayDialog';

interface PanelProps {
  data: FamilyData;
  actions: FamilyActions;
  today: DateKey;
  onPreview: (preview: CelebrationPreview, reward?: BirthdayReward) => void;
}

const rangeFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const fmt = (key: DateKey) => {
  const d = parseDateKey(key);
  return d ? rangeFormat.format(d) : key;
};

const STATE_LABEL: Record<ThemeStatus['state'], string> = { active: 'Showing now', upcoming: 'Upcoming', disabled: 'Switched off' };

function whenText(status: ThemeStatus, today: DateKey): string {
  const o = status.occurrence;
  if (status.state === 'active') {
    const left = daysBetween(today, o.end);
    return left === 0 ? 'Last day today.' : `Showing until ${fmt(o.end)} (${left} more day${left === 1 ? '' : 's'}).`;
  }
  if (status.state === 'disabled') return 'Won’t show until you switch it back on.';
  const days = daysBetween(today, o.start);
  return `Starts in ${days} day${days === 1 ? '' : 's'}.`;
}

/**
 * Parent area → Themes & Celebrations. Every change is saved to the family
 * data (all devices); previews are not saved anywhere.
 */
export function CelebrationsPanel({ data, actions, today, onPreview }: PanelProps) {
  const notify = useToast();
  const settings = data.celebrations;
  const [editing, setEditing] = useState<ThemeId | null>(null);
  const [birthdayFor, setBirthdayFor] = useState<Child | null>(null);
  const [saving, setSaving] = useState(false);
  const showing = activeTheme(settings, today);

  const save = async (next: typeof settings, message: string) => {
    setSaving(true);
    const r = await actions.saveCelebrationSettings(next, actions.versionOf(recordKey.celebrations()));
    setSaving(false);
    if (!r.ok) {
      notify(r.error, 'error');
      return false;
    }
    notify(message);
    return true;
  };
  const withTheme = (id: ThemeId, patch: Partial<(typeof settings.themes)[ThemeId]>) => ({
    ...settings,
    themes: { ...settings.themes, [id]: { ...settings.themes[id], ...patch } },
  });

  return (
    <div className="panel celebrations-panel">
      <section className="settings-card celebrations-now" aria-labelledby="celebrations-now-title">
        <h2 id="celebrations-now-title" className="section-subtitle">
          On the home screen today
        </h2>
        {showing ? (
          <p className="celebrations-now-text">
            <span aria-hidden="true">{THEMES[showing.themeId].icon}</span> <strong>{THEMES[showing.themeId].name}</strong> —{' '}
            {seasonGreeting(showing, today).headline}
          </p>
        ) : (
          <p className="celebrations-now-text">No seasonal theme today.</p>
        )}
        <p className="muted">
          Themes switch on and off by themselves on their dates, using the family’s time zone. Your changes apply to every
          screen in the family. <strong>Preview</strong> shows a theme on this screen only: nothing is saved and no points
          are given.
        </p>
      </section>

      <ul className="theme-grid">
        {THEME_IDS.map((id) => {
          const info = THEMES[id];
          const setting = settings.themes[id];
          const status = themeStatus(id, setting, today);
          const o = status.occurrence;
          const greeting = id === 'christmas' || id === 'newYear' ? seasonGreeting(o, today) : null;
          return (
            <li key={id} className={`theme-card theme-card-${id} theme-state-${status.state}`} data-testid={`theme-card-${id}`}>
              <div className="theme-card-head">
                <span className="theme-card-icon" aria-hidden="true">
                  {info.icon}
                </span>
                <h3 className="theme-card-title">{info.name}</h3>
                <span className={`status-pill status-${status.state}`}>{STATE_LABEL[status.state]}</span>
              </div>
              <p className="theme-dates">
                <strong>
                  {fmt(o.start)} – {fmt(o.end)}
                </strong>
                <br />
                <span className="muted">
                  {o.custom ? 'Your own dates (they repeat every year, the same way around the holiday).' : `Default: ${info.defaultRule}`}
                </span>
              </p>
              <p className="theme-when">{whenText(status, today)}</p>
              {greeting && greeting.daysToGo !== null && greeting.daysToGo > 0 && (
                <p className="theme-countdown" data-testid={`${id}-panel-countdown`}>
                  <span aria-hidden="true">⏳</span> {greeting.headline}
                </p>
              )}
              <label className="switch">
                <input
                  type="checkbox"
                  role="switch"
                  checked={setting.enabled}
                  disabled={saving}
                  aria-label={`Show the ${info.name} theme`}
                  onChange={(e) =>
                    void save(withTheme(id, { enabled: e.target.checked }), `${info.name} theme switched ${e.target.checked ? 'on' : 'off'}.`)
                  }
                />
                <span className="switch-track" aria-hidden="true" />
                <span>Show this theme</span>
              </label>
              <div className="button-row theme-actions">
                <button type="button" className="button button-secondary" onClick={() => onPreview({ kind: 'theme', themeId: id })}>
                  Preview
                </button>
                <button type="button" className="button button-secondary" onClick={() => setEditing(editing === id ? null : id)} aria-expanded={editing === id}>
                  Change dates
                </button>
                {setting.custom && (
                  <button
                    type="button"
                    className="button button-ghost"
                    disabled={saving}
                    onClick={() => void save(withTheme(id, { custom: null }), `${info.name} is back to its default dates.`)}
                  >
                    Restore default dates
                  </button>
                )}
              </div>
              {editing === id && (
                <DatesForm
                  themeName={info.name}
                  holidayName={info.holidayName}
                  holiday={o.holiday}
                  start={o.start}
                  end={o.end}
                  busy={saving}
                  onCancel={() => setEditing(null)}
                  onSave={async (start, end) => {
                    const r = customDatesFor(o.holiday, start, end);
                    if (!r.ok) return r.error;
                    if (await save(withTheme(id, { custom: r.value }), `${info.name} dates saved.`)) setEditing(null);
                    return null;
                  }}
                />
              )}
            </li>
          );
        })}

        <li className="theme-card theme-card-birthday" data-testid="theme-card-birthday">
          <div className="theme-card-head">
            <span className="theme-card-icon" aria-hidden="true">
              🎂
            </span>
            <h3 className="theme-card-title">Birthday celebrations</h3>
            <span className={`status-pill status-${settings.birthdaysEnabled ? 'upcoming' : 'disabled'}`}>
              {settings.birthdaysEnabled ? 'On' : 'Switched off'}
            </span>
          </div>
          <p className="muted">
            Balloons, cake and a birthday banner with the child’s name, on top of any seasonal theme. Rewards are set up for
            each child and can be on even when the birthday theme is off.
          </p>
          <label className="switch">
            <input
              type="checkbox"
              role="switch"
              checked={settings.birthdaysEnabled}
              disabled={saving}
              aria-label="Show birthday celebrations"
              onChange={(e) =>
                void save({ ...settings, birthdaysEnabled: e.target.checked }, `Birthday celebrations switched ${e.target.checked ? 'on' : 'off'}.`)
              }
            />
            <span className="switch-track" aria-hidden="true" />
            <span>Show birthday celebrations</span>
          </label>
          {data.children.length === 0 ? (
            <p className="muted">Add a child first (Children tab).</p>
          ) : (
            <ul className="admin-list birthday-list">
              {data.children.map((child) => {
                const b = birthdayOf(data, child.id);
                return (
                  <li key={child.id} className={`admin-row accent-${child.color}`}>
                    <Avatar child={child} size="sm" />
                    <span className="admin-main">
                      <span className="admin-name">
                        {child.name}
                        {b ? ` · 🎂 ${birthdayLabel(b)}` : ''}
                      </span>
                      <span className="admin-meta">{birthdayRewardStatus(data, child, today)}</span>
                    </span>
                    <span className="admin-actions">
                      <button type="button" className="button button-secondary" onClick={() => setBirthdayFor(child)} aria-label={`Set up ${child.name}’s birthday`}>
                        {b ? 'Edit birthday' : 'Add birthday'}
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </li>
      </ul>

      {birthdayFor && (
        <BirthdayDialog
          child={birthdayFor}
          data={data}
          today={today}
          actions={actions}
          onClose={() => setBirthdayFor(null)}
          onPreview={(childId, reward) => onPreview({ kind: 'birthday', childId }, reward)}
        />
      )}
    </div>
  );
}

function DatesForm({
  themeName,
  holidayName,
  holiday,
  start: initialStart,
  end: initialEnd,
  busy,
  onSave,
  onCancel,
}: {
  themeName: string;
  holidayName: string;
  holiday: DateKey;
  start: DateKey;
  end: DateKey;
  busy: boolean;
  onSave: (start: string, end: string) => Promise<string | null>;
  onCancel: () => void;
}) {
  const [start, setStart] = useState(initialStart);
  const [end, setEnd] = useState(initialEnd);
  const [error, setError] = useState<string | null>(null);
  const idBase = `dates-${themeName.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <form
      className="dates-form"
      data-editing="true"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(start, end).then(setError);
      }}
    >
      <p className="field-hint">
        Dates for this year’s {themeName} ({holidayName}: {fmt(holiday)}). They are kept as days before and after the
        holiday, so next year they move with it.
      </p>
      <div className="birthday-date-row">
        <div className="field">
          <label htmlFor={`${idBase}-start`} className="field-label">
            Start
          </label>
          <input id={`${idBase}-start`} className="input" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`${idBase}-end`} className="field-label">
            End
          </label>
          <input id={`${idBase}-end`} className="input" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="button-row">
        <button type="button" className="button button-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="button button-primary" disabled={busy}>
          Save dates
        </button>
      </div>
    </form>
  );
}
