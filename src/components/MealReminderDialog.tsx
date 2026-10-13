import type { DateKey } from '../types';
import { parseDateKey } from '../lib/dates';
import type { MealReminder } from '../lib/meals';
import { Modal } from './Modal';

const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

interface MealReminderDialogProps {
  reminders: MealReminder[];
  today: DateKey;
  onLater: () => void;
  onPlanNow: () => void;
}

/** Pops up on the home screen when a child's school meal plan is about to run out. */
export function MealReminderDialog({ reminders, today, onLater, onPlanNow }: MealReminderDialogProps) {
  return (
    <Modal title="School meals running low" onClose={onLater} size="sm">
      <div className="confirm-body">
        <p className="confirm-emoji" aria-hidden="true">
          🍽️
        </p>
        <p>The school meal plan needs topping up:</p>
        <ul className="plain-list">
          {reminders.map((r) => {
            const date = parseDateKey(r.lastDate);
            const label = date ? dayFormat.format(date) : r.lastDate;
            return (
              <li key={r.childId}>
                <strong>{r.name}</strong>: {r.lastDate < today ? `ran out on ${label}` : `ends on ${label}`}
              </li>
            );
          })}
        </ul>
        <p>A grown-up can add up to 6 weeks of meals in Parent area → School meals.</p>
      </div>
      <div className="button-row">
        <button type="button" className="button button-secondary" onClick={onLater} data-autofocus>
          Remind me tomorrow
        </button>
        <button type="button" className="button button-primary" onClick={onPlanNow}>
          Plan meals now
        </button>
      </div>
    </Modal>
  );
}
