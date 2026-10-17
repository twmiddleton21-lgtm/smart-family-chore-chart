import { useEffect, useState, type FormEvent } from 'react';
import type { DateKey, FamilyData, FoodOption } from '../../types';
import { parseDateKey } from '../../lib/dates';
import { optionsFor, sortedOptions } from '../../lib/foodOptions';
import {
  MEAL_WEEKS,
  clearWeekRows,
  copyWeekRows,
  lastPlannedDate,
  mealFor,
  mealReminders,
  mealWeeks,
  mealWindowEnd,
  rowsDiffer,
  schoolDays,
  weekRows,
  type MealRow,
} from '../../lib/meals';
import { validateMealRows } from '../../lib/validation';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ErrorSummary } from '../../components/Field';
import type { FamilyActions } from '../../state/useFamilyStore';
import { recordKey } from '../../state/apiCommands';
import { useToast } from '../../state/toast';
import { FoodOptionsPanel } from './FoodOptionsPanel';

interface PanelProps {
  data: FamilyData;
  actions: FamilyActions;
  today: DateKey;
}

const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
const shortFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const weekFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

const fmtDate = (format: Intl.DateTimeFormat, key: DateKey) => {
  const date = parseDateKey(key);
  return date ? format.format(date) : key;
};

function weekLabel(index: number, monday: DateKey) {
  if (index === 0) return 'This week';
  if (index === 1) return 'Next week';
  return `w/c ${fmtDate(weekFormat, monday)}`;
}

type View = 'plan' | 'foods';
type Target = { view: View; childId: string; week: number };

export function MealsPanel({ data, actions, today }: PanelProps) {
  const [view, setView] = useState<View>('plan');
  const [childId, setChildId] = useState(data.children[0]?.id ?? '');
  const [week, setWeek] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<Target | null>(null);

  const weeks = mealWeeks(today);
  const reminders = mealReminders(data, today);
  const child = data.children.find((c) => c.id === childId) ?? data.children[0];

  // Switching view, child or week throws away unsaved edits, so ask first.
  const apply = (next: Target) => {
    setView(next.view);
    setChildId(next.childId);
    setWeek(next.week);
    setDirty(false);
    setPending(null);
  };
  const switchTo = (next: Target) => {
    if (dirty && view === 'plan') setPending(next);
    else apply(next);
  };
  const current = { view, childId: child?.id ?? '', week };

  const viewSwitch = (
    <div className="view-switch" role="group" aria-label="School meals section">
      <button
        type="button"
        className="view-switch-button"
        aria-pressed={view === 'plan'}
        onClick={() => view !== 'plan' && switchTo({ ...current, view: 'plan' })}
      >
        <span aria-hidden="true">📅</span> Plan meals
      </button>
      <button
        type="button"
        className="view-switch-button"
        aria-pressed={view === 'foods'}
        onClick={() => view !== 'foods' && switchTo({ ...current, view: 'foods' })}
      >
        <span aria-hidden="true">🧾</span> Manage Food Options
      </button>
    </div>
  );

  const discardDialog = pending && (
    <ConfirmDialog
      title="Discard unsaved meals?"
      tone="danger"
      confirmLabel="Discard changes"
      cancelLabel="Keep editing"
      onCancel={() => setPending(null)}
      onConfirm={() => apply(pending)}
    >
      <p>You have changes to this week that haven’t been saved yet.</p>
    </ConfirmDialog>
  );

  if (view === 'foods') {
    return (
      <div className="panel">
        {viewSwitch}
        <FoodOptionsPanel data={data} actions={actions} today={today} />
        {discardDialog}
      </div>
    );
  }

  if (!child) {
    return (
      <div className="panel">
        {viewSwitch}
        <div className="empty-card">
          <p>Add a child profile first (Children tab), then you can plan their school meals.</p>
        </div>
      </div>
    );
  }

  const monday = weeks[week]!;
  const noMains = data.foodOptions.mains.length === 0;
  const noPuddings = data.foodOptions.puddings.length === 0;

  return (
    <div className="panel">
      {viewSwitch}

      <section className="settings-card meals-intro" aria-label="Meal plan status">
        <p>
          Plan each child’s school lunch (main and pudding) up to <strong>{MEAL_WEEKS} weeks</strong> ahead, until{' '}
          <strong>{fmtDate(shortFormat, mealWindowEnd(today))}</strong>. Today’s meals appear on the home screen.
        </p>
        <ul className="meal-status-list">
          {data.children.map((c) => {
            const last = lastPlannedDate(data, c.id);
            const warn = reminders.some((r) => r.childId === c.id);
            return (
              <li key={c.id} className={warn ? 'meal-status-warn' : ''}>
                <span aria-hidden="true">{c.avatar}</span> <strong>{c.name}:</strong>{' '}
                {last === null
                  ? 'no meals planned'
                  : last < today
                    ? `plan ran out on ${fmtDate(shortFormat, last)}`
                    : `planned until ${fmtDate(shortFormat, last)}`}
                {warn && <span className="meal-warn-tag">⚠ Needs more weeks</span>}
              </li>
            );
          })}
        </ul>
      </section>

      {(noMains || noPuddings) && (
        <div className="banner banner-info meal-catalog-hint" role="status">
          <span>
            ℹ️ The {noMains && noPuddings ? 'main meal and pudding lists are' : noMains ? 'main meal list is' : 'pudding list is'}{' '}
            empty. Add choices first, then pick them for each day.
          </span>
          <button type="button" className="button button-primary" onClick={() => switchTo({ ...current, view: 'foods' })}>
            Manage Food Options
          </button>
        </div>
      )}

      <div className="chip-row" role="group" aria-label="Choose child">
        {data.children.map((c) => (
          <button
            key={c.id}
            type="button"
            className="chip"
            aria-pressed={c.id === child.id}
            onClick={() => c.id !== child.id && switchTo({ ...current, childId: c.id })}
          >
            <span aria-hidden="true">{c.avatar}</span> {c.name}
          </button>
        ))}
      </div>

      <div className="chip-row" role="group" aria-label="Choose week">
        {weeks.map((m, i) => {
          const planned = schoolDays(m).filter((d) => mealFor(data, child.id, d)).length;
          return (
            <button
              key={m}
              type="button"
              className="chip week-chip"
              aria-pressed={i === week}
              onClick={() => i !== week && switchTo({ ...current, week: i })}
            >
              <span>{weekLabel(i, m)}</span>
              <span className="week-chip-count">{planned}/5 days</span>
            </button>
          );
        })}
      </div>

      <WeekEditor
        key={`${child.id}|${monday}`}
        data={data}
        actions={actions}
        today={today}
        childId={child.id}
        childName={child.name}
        monday={monday}
        previousMonday={week > 0 ? weeks[week - 1]! : null}
        onDirtyChange={setDirty}
      />

      {discardDialog}
    </div>
  );
}

interface MealSelectProps {
  id: string;
  label: string;
  icon: string;
  blankLabel: string;
  value: string;
  options: FoodOption[];
  onChange: (value: string) => void;
  invalid: boolean;
}

/**
 * A large native dropdown of saved options. If the day already holds text
 * that is not in the list (older data, or an option renamed elsewhere), it
 * is kept as an extra choice so nothing is silently lost.
 */
export function MealSelect({ id, label, icon, blankLabel, value, options, onChange, invalid }: MealSelectProps) {
  const known = value === '' || options.some((o) => o.name === value);
  return (
    <div className="meal-field">
      <label htmlFor={id} className="meal-field-label">
        <span aria-hidden="true">{icon}</span> {label}
      </label>
      <select
        id={id}
        className={`select ${value === '' ? 'select-blank' : ''}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={invalid ? true : undefined}
      >
        <option value="">{blankLabel}</option>
        {!known && <option value={value}>{value} (not in food list)</option>}
        {options.map((o) => (
          <option key={o.id} value={o.name}>
            {o.name}
          </option>
        ))}
      </select>
    </div>
  );
}

interface WeekEditorProps {
  data: FamilyData;
  actions: FamilyActions;
  today: DateKey;
  childId: string;
  childName: string;
  monday: DateKey;
  previousMonday: DateKey | null;
  onDirtyChange: (dirty: boolean) => void;
}

function WeekEditor({ data, actions, today, childId, childName, monday, previousMonday, onDirtyChange }: WeekEditorProps) {
  const notify = useToast();
  const [rows, setRows] = useState<MealRow[]>(() => weekRows(data, childId, monday));
  const [errors, setErrors] = useState<Record<string, string>>({});
  // Version of this child's week when editing started (server mode), so a
  // save based on stale data is refused instead of overwriting newer meals.
  const versionKey = recordKey.mealWeek(childId, monday);
  const [baseVersion, setBaseVersion] = useState(() => actions.versionOf(versionKey));
  const [saving, setSaving] = useState(false);

  const mains = sortedOptions(optionsFor(data, 'main'));
  const puddings = sortedOptions(optionsFor(data, 'pudding'));

  // Unsaved changes = the draft differs from what is stored for this week.
  const dirty = rowsDiffer(weekRows(data, childId, monday), rows);
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const update = (date: DateKey, field: 'main' | 'pudding', value: string) =>
    setRows((list) => list.map((r) => (r.date === date ? { ...r, [field]: value } : r)));

  const copyPrevious = () => {
    if (!previousMonday) return;
    const copied = copyWeekRows(rows, weekRows(data, childId, previousMonday));
    if (!copied) {
      notify('The previous week has no meals to copy.', 'info');
      return;
    }
    setRows(copied);
    notify('Copied last week’s meals. Check them, then save.', 'info');
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    const result = validateMealRows(rows);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setSaving(true);
    const saved = await actions.saveMealWeek(childId, monday, result.value, baseVersion);
    setSaving(false);
    if (!saved.ok) {
      notify(saved.error, 'error');
      return;
    }
    setBaseVersion(actions.versionOf(versionKey));
    setRows(result.value);
    notify(`Saved ${childName}’s meals for the week of ${fmtDate(weekFormat, monday)}.`);
  };

  return (
    <form className="settings-card form meal-week" onSubmit={submit} noValidate>
      <h2 className="section-subtitle">
        {childName}’s meals · week of {fmtDate(weekFormat, monday)}
        {dirty && <span className="unsaved-tag">Unsaved changes</span>}
      </h2>
      <ErrorSummary
        errors={Object.fromEntries(Object.entries(errors).map(([d, m]) => [d, `${fmtDate(shortFormat, d)}: ${m}`]))}
      />

      <div className="meal-days">
        {rows.map((row) => {
          const past = row.date < today;
          return (
            <fieldset
              key={row.date}
              className={`meal-day ${row.date === today ? 'meal-day-today' : ''} ${past ? 'meal-day-past' : ''}`}
            >
              <legend className="field-label">
                {fmtDate(dayFormat, row.date)}
                {row.date === today && <span className="meal-today-tag">Today</span>}
              </legend>
              <MealSelect
                id={`main-${row.date}`}
                label="Main"
                icon="🍽️"
                blankLabel="— No main —"
                value={row.main}
                options={mains}
                onChange={(v) => update(row.date, 'main', v)}
                invalid={Boolean(errors[row.date])}
              />
              <MealSelect
                id={`pudding-${row.date}`}
                label="Pudding"
                icon="🍰"
                blankLabel="— No pudding —"
                value={row.pudding}
                options={puddings}
                onChange={(v) => update(row.date, 'pudding', v)}
                invalid={Boolean(errors[row.date])}
              />
            </fieldset>
          );
        })}
      </div>

      <p className="field-hint">
        Leave both as “No main” and “No pudding” if there’s no school meal that day (packed lunch, holiday or inset day).
      </p>

      <div className="button-row meal-actions">
        {previousMonday && (
          <button type="button" className="button button-secondary" onClick={copyPrevious}>
            Copy previous week
          </button>
        )}
        <button type="button" className="button button-danger-outline" onClick={() => setRows(clearWeekRows(rows))}>
          Clear week
        </button>
        <button type="submit" className="button button-primary">
          Save week
        </button>
      </div>
    </form>
  );
}
