import { useState, type FormEvent } from 'react';
import type { DateKey, FamilyData, FoodCategory, FoodOption, MealEntry } from '../../types';
import { parseDateKey } from '../../lib/dates';
import { FOOD_LABEL, foodOptionUsage, optionsFor, sortedOptions } from '../../lib/foodOptions';
import { LIMITS } from '../../lib/validation';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Modal } from '../../components/Modal';
import type { FamilyActions } from '../../state/useFamilyStore';
import { useToast } from '../../state/toast';

interface PanelProps {
  data: FamilyData;
  actions: FamilyActions;
  today: DateKey;
}

const shortFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const fmt = (key: DateKey) => {
  const date = parseDateKey(key);
  return date ? shortFormat.format(date) : key;
};

const ICON: Record<FoodCategory, string> = { main: '🍝', pudding: '🍰' };
/** How many in-use days to list before summarising the rest. */
const USAGE_LIST_LIMIT = 10;

type Removing = { category: FoodCategory; option: FoodOption; usage: MealEntry[] } | null;

/** Parent → School meals → Manage Food Options: the shared main and pudding lists. */
export function FoodOptionsPanel({ data, actions, today }: PanelProps) {
  const notify = useToast();
  const [removing, setRemoving] = useState<Removing>(null);

  const startRemove = (category: FoodCategory, option: FoodOption) =>
    setRemoving({ category, option, usage: foodOptionUsage(data, category, option.name, today) });

  const childName = (id: string) => data.children.find((c) => c.id === id)?.name ?? 'Unknown';

  return (
    <>
      <p className="muted">
        These lists are shared by all children and every week. Pick from them in <strong>Plan meals</strong>. An option that
        is planned on any day can’t be removed until those days are changed.
      </p>
      <div className="food-columns">
        {(['main', 'pudding'] as const).map((category) => (
          <FoodCategoryCard
            key={category}
            category={category}
            data={data}
            today={today}
            actions={actions}
            onRemove={(option) => startRemove(category, option)}
          />
        ))}
      </div>

      {removing && removing.usage.length > 0 && (
        <Modal title={`“${removing.option.name}” is still planned`} onClose={() => setRemoving(null)} size="sm">
          <div className="confirm-body">
            <p>
              This {FOOD_LABEL[removing.category].singular} is chosen on <strong>{removing.usage.length}</strong> planned day
              {removing.usage.length === 1 ? '' : 's'}, so it can’t be removed yet. Nothing has been changed.
            </p>
            <ul className="plain-list usage-list">
              {removing.usage.slice(0, USAGE_LIST_LIMIT).map((m) => (
                <li key={m.id}>
                  <strong>{childName(m.childId)}</strong>: {fmt(m.date)}
                </li>
              ))}
            </ul>
            {removing.usage.length > USAGE_LIST_LIMIT && (
              <p className="muted">…and {removing.usage.length - USAGE_LIST_LIMIT} more.</p>
            )}
            <p>
              To remove it, open <strong>Plan meals</strong>, choose something else (or “No {removing.category}”) on those
              days and save each week. Then try again.
            </p>
          </div>
          <div className="button-row">
            <button type="button" className="button button-primary" onClick={() => setRemoving(null)} data-autofocus>
              OK
            </button>
          </div>
        </Modal>
      )}

      {removing && removing.usage.length === 0 && (
        <ConfirmDialog
          title={`Remove “${removing.option.name}”?`}
          tone="danger"
          confirmLabel="Yes, remove it"
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            const result = await actions.removeFoodOption(removing.category, removing.option.id);
            setRemoving(null);
            if (result.ok) notify(`Removed “${removing.option.name}” from ${FOOD_LABEL[removing.category].plural.toLowerCase()}.`, 'info');
            else notify(result.error, 'error');
          }}
        >
          <p>
            It will no longer appear in the {FOOD_LABEL[removing.category].singular} dropdown. It isn’t planned on any
            upcoming day, and past meals keep their names.
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}

interface CategoryCardProps {
  category: FoodCategory;
  data: FamilyData;
  today: DateKey;
  actions: FamilyActions;
  onRemove: (option: FoodOption) => void;
}

function FoodCategoryCard({ category, data, today, actions, onRemove }: CategoryCardProps) {
  const notify = useToast();
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const label = FOOD_LABEL[category];
  const options = sortedOptions(optionsFor(data, category));
  const inputId = `new-${category}`;

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const result = await actions.addFoodOption(category, name);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(undefined);
    notify(`Added “${name.trim()}” to ${label.plural.toLowerCase()}.`);
    setName('');
  };

  return (
    <section className="settings-card food-card" aria-labelledby={`${category}-heading`}>
      <h2 id={`${category}-heading`} className="section-subtitle">
        <span aria-hidden="true">{ICON[category]}</span> {label.plural} <span className="muted">({options.length})</span>
      </h2>

      <form className="food-add" onSubmit={add} noValidate>
        <label htmlFor={inputId} className="field-label">
          Add a new {label.singular}
        </label>
        <div className="food-add-row">
          <input
            id={inputId}
            className="input"
            value={name}
            maxLength={LIMITS.mealTextMax + 10}
            placeholder={category === 'main' ? 'e.g. Fish pie' : 'e.g. Apple crumble'}
            autoComplete="off"
            onChange={(e) => {
              setName(e.target.value);
              setError(undefined);
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${inputId}-error` : undefined}
          />
          <button type="submit" className="button button-primary">
            ＋ Add {label.singular}
          </button>
        </div>
        {error && (
          <p id={`${inputId}-error`} className="field-error" role="alert">
            {error}
          </p>
        )}
      </form>

      {options.length === 0 ? (
        <p className="muted">No {label.plural.toLowerCase()} yet. Add the first one above.</p>
      ) : (
        <ul className="food-list">
          {options.map((option) => {
            const used = foodOptionUsage(data, category, option.name, today).length;
            return (
              <li key={option.id} className="food-row">
                <span className="food-name">{option.name}</span>
                <span className={`food-usage ${used > 0 ? 'food-usage-on' : ''}`}>
                  {used > 0 ? `Planned on ${used} day${used === 1 ? '' : 's'}` : 'Not planned'}
                </span>
                <button
                  type="button"
                  className="button button-danger-outline"
                  onClick={() => onRemove(option)}
                  aria-label={`Remove ${option.name}`}
                >
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
