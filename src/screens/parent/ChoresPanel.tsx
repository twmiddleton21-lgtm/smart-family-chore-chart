import { useState, type FormEvent } from 'react';
import { PERIODS, type Chore, type FamilyData, type Weekday } from '../../types';
import { WEEKDAYS, describeSchedule } from '../../lib/dates';
import { validateChore, LIMITS, type ChoreDraft, type ChoreField } from '../../lib/validation';
import { Avatar } from '../../components/Avatar';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ErrorSummary, TextField } from '../../components/Field';
import { Modal } from '../../components/Modal';
import { EmojiPicker } from '../../components/Pickers';
import { PERIOD_INFO } from '../../components/PeriodSection';
import type { FamilyActions } from '../../state/useFamilyStore';
import { useToast } from '../../state/toast';

const CHORE_ICONS = ['🛏️', '🪥', '👕', '🎒', '📚', '✏️', '🐱', '🐶', '🪴', '🍽️', '🧸', '🧺', '🧹', '🛁', '♻️', '🎹'];

interface PanelProps {
  data: FamilyData;
  actions: FamilyActions;
}

// `version`: the record version when the dialog opened, so a stale save is refused (409).
type Editing = { mode: 'add' } | { mode: 'edit'; chore: Chore; version: number } | null;

export function ChoresPanel({ data, actions }: PanelProps) {
  const notify = useToast();
  const [filter, setFilter] = useState<string>('all');
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<Chore | null>(null);
  const [deleteVersion, setDeleteVersion] = useState(0);
  const startDelete = (item: Chore) => {
    setDeleteVersion(actions.versionOf(`chore:${item.id}`));
    setDeleting(item);
  };

  const children = data.children;
  const visibleChildren = filter === 'all' ? children : children.filter((c) => c.id === filter);

  if (children.length === 0) {
    return (
      <div className="empty-card">
        <p>Add a child profile first (Children tab), then you can give them chores.</p>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-toolbar">
        <div className="chip-row" role="group" aria-label="Show chores for">
          <button type="button" className="chip" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
            Everyone
          </button>
          {children.map((c) => (
            <button key={c.id} type="button" className="chip" aria-pressed={filter === c.id} onClick={() => setFilter(c.id)}>
              <span aria-hidden="true">{c.avatar}</span> {c.name}
            </button>
          ))}
        </div>
        <button type="button" className="button button-primary" onClick={() => setEditing({ mode: 'add' })}>
          ＋ Add chore
        </button>
      </div>

      {visibleChildren.map((child) => {
        const chores = data.chores.filter((c) => c.childId === child.id);
        return (
          <section key={child.id} className={`admin-group accent-${child.color}`} aria-label={`${child.name}'s chores`}>
            <h2 className="admin-group-title">
              <Avatar child={child} size="sm" /> {child.name}
              <span className="muted"> · {chores.length} chores</span>
            </h2>
            {chores.length === 0 ? (
              <p className="muted">No chores yet.</p>
            ) : (
              PERIODS.map((period) => {
                const list = chores.filter((c) => c.period === period);
                if (list.length === 0) return null;
                return (
                  <div key={period} className="admin-period">
                    <h3 className={`admin-period-title period-tag-${period}`}>
                      <span aria-hidden="true">{PERIOD_INFO[period].icon}</span> {PERIOD_INFO[period].label}
                    </h3>
                    <ul className="admin-list">
                      {list.map((chore) => (
                        <li key={chore.id} className="admin-row">
                          <span className="admin-icon" aria-hidden="true">
                            {chore.icon}
                          </span>
                          <span className="admin-main">
                            <span className="admin-name">{chore.title}</span>
                            <span className="admin-meta">
                              ⭐ {chore.points} points · {describeSchedule(chore.schedule)}
                            </span>
                          </span>
                          <span className="admin-actions">
                            <button
                              type="button"
                              className="button button-secondary"
                              onClick={() => setEditing({ mode: 'edit', chore, version: actions.versionOf(`chore:${chore.id}`) })}
                              aria-label={`Edit ${chore.title} for ${child.name}`}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="button button-danger-outline"
                              onClick={() => startDelete(chore)}
                              aria-label={`Delete ${chore.title} for ${child.name}`}
                            >
                              Delete
                            </button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })
            )}
          </section>
        );
      })}

      {editing && (
        <ChoreForm
          data={data}
          chore={editing.mode === 'edit' ? editing.chore : undefined}
          defaultChildId={filter !== 'all' ? filter : children[0]!.id}
          onCancel={() => setEditing(null)}
          onSave={async (value) => {
            const id = editing.mode === 'edit' ? editing.chore.id : undefined;
            const result = await actions.saveChore(value, id, editing.mode === 'edit' ? editing.version : undefined);
            if (!result.ok) {
              notify(result.error, 'error');
              return;
            }
            setEditing(null);
            notify(id ? `Saved changes to “${value.title}”.` : `Added “${value.title}”.`);
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title="Delete this chore?"
          tone="danger"
          confirmLabel="Yes, delete it"
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            const result = await actions.deleteChore(deleting.id, deleteVersion);
            if (!result.ok) {
              notify(result.error, 'error');
              setDeleting(null);
              return;
            }
            notify(`Deleted “${deleting.title}”.`, 'info');
            setDeleting(null);
          }}
        >
          <p>
            <strong>
              {deleting.icon} {deleting.title}
            </strong>{' '}
            will be removed from {children.find((c) => c.id === deleting.childId)?.name ?? 'this child'}’s chart. Points
            already earned for it are kept.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

interface ChoreFormProps {
  data: FamilyData;
  chore?: Chore;
  defaultChildId: string;
  onSave: (value: Omit<Chore, 'id'>) => void;
  onCancel: () => void;
}

function ChoreForm({ data, chore, defaultChildId, onSave, onCancel }: ChoreFormProps) {
  const [draft, setDraft] = useState<ChoreDraft>(() => ({
    title: chore?.title ?? '',
    icon: chore?.icon ?? '⭐',
    childId: chore?.childId ?? defaultChildId,
    period: chore?.period ?? 'morning',
    points: String(chore?.points ?? 5),
    scheduleType: chore?.schedule.type ?? 'daily',
    days: chore?.schedule.type === 'weekly' ? chore.schedule.days : [1, 2, 3, 4, 5],
  }));
  const [errors, setErrors] = useState<Partial<Record<ChoreField, string>>>({});

  const set = <K extends keyof ChoreDraft>(key: K, value: ChoreDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const toggleDay = (day: Weekday) =>
    set('days', draft.days.includes(day) ? draft.days.filter((d) => d !== day) : [...draft.days, day]);

  const stepPoints = (delta: number) => {
    const current = Number.parseInt(draft.points, 10);
    const base = Number.isFinite(current) ? current : 0;
    set('points', String(Math.min(LIMITS.choreMaxPoints, Math.max(LIMITS.choreMinPoints, base + delta))));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = validateChore(
      draft,
      data.children.map((c) => c.id),
    );
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    onSave(result.value);
  };

  return (
    <Modal title={chore ? 'Edit chore' : 'Add a chore'} onClose={onCancel} size="lg" editing>
      <form className="form" onSubmit={submit} noValidate>
        <ErrorSummary errors={errors} />

        <TextField
          id="chore-title"
          data-autofocus
          label="Chore name"
          value={draft.title}
          onChange={(v) => set('title', v)}
          error={errors.title}
          maxLength={LIMITS.titleMax + 10}
          placeholder="e.g. Feed the fish"
          autoComplete="off"
        />

        <EmojiPicker
          idPrefix="chore-icon"
          legend="Icon"
          value={draft.icon}
          options={CHORE_ICONS}
          onChange={(v) => set('icon', v)}
          error={errors.icon}
        />

        <fieldset className="field">
          <legend className="field-label">Who is it for?</legend>
          <div className="choice-row">
            {data.children.map((c) => (
              <label key={c.id} className={`choice accent-${c.color}`}>
                <input
                  type="radio"
                  name="chore-child"
                  value={c.id}
                  checked={draft.childId === c.id}
                  onChange={() => set('childId', c.id)}
                />
                <span>
                  <span aria-hidden="true">{c.avatar}</span> {c.name}
                </span>
              </label>
            ))}
          </div>
          {errors.childId && <p className="field-error">{errors.childId}</p>}
        </fieldset>

        <fieldset className="field">
          <legend className="field-label">Time of day</legend>
          <div className="choice-row">
            {PERIODS.map((p) => (
              <label key={p} className={`choice period-tag-${p}`}>
                <input type="radio" name="chore-period" value={p} checked={draft.period === p} onChange={() => set('period', p)} />
                <span>
                  <span aria-hidden="true">{PERIOD_INFO[p].icon}</span> {PERIOD_INFO[p].label}
                </span>
              </label>
            ))}
          </div>
          {errors.period && <p className="field-error">{errors.period}</p>}
        </fieldset>

        <div className="field">
          <label htmlFor="chore-points" className="field-label">
            Points
          </label>
          <div className="stepper">
            <button type="button" className="key stepper-button" onClick={() => stepPoints(-1)} aria-label="One point fewer">
              −
            </button>
            <input
              id="chore-points"
              className="input stepper-input"
              inputMode="numeric"
              value={draft.points}
              onChange={(e) => set('points', e.target.value)}
              aria-invalid={errors.points ? true : undefined}
              aria-describedby={errors.points ? 'chore-points-error' : 'chore-points-hint'}
            />
            <button type="button" className="key stepper-button" onClick={() => stepPoints(1)} aria-label="One point more">
              +
            </button>
          </div>
          {errors.points ? (
            <p id="chore-points-error" className="field-error">
              {errors.points}
            </p>
          ) : (
            <p id="chore-points-hint" className="field-hint">
              A whole number from {LIMITS.choreMinPoints} to {LIMITS.choreMaxPoints}.
            </p>
          )}
        </div>

        <fieldset className="field">
          <legend className="field-label">How often?</legend>
          <div className="choice-row">
            <label className="choice">
              <input
                type="radio"
                name="chore-schedule"
                checked={draft.scheduleType === 'daily'}
                onChange={() => set('scheduleType', 'daily')}
              />
              <span>Every day</span>
            </label>
            <label className="choice">
              <input
                type="radio"
                name="chore-schedule"
                checked={draft.scheduleType === 'weekly'}
                onChange={() => set('scheduleType', 'weekly')}
              />
              <span>Selected days</span>
            </label>
          </div>
          {draft.scheduleType === 'weekly' && (
            <div className="choice-row days-row" role="group" aria-label="Days of the week">
              {WEEKDAYS.map((w) => (
                <label key={w.day} className="choice choice-day">
                  <input type="checkbox" checked={draft.days.includes(w.day)} onChange={() => toggleDay(w.day)} />
                  <span>
                    <span aria-hidden="true">{w.short}</span>
                    <span className="visually-hidden">{w.long}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
          {errors.days && <p className="field-error">{errors.days}</p>}
        </fieldset>

        <div className="button-row">
          <button type="button" className="button button-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="button button-primary">
            {chore ? 'Save changes' : 'Add chore'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
