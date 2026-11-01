import { useState, type FormEvent } from 'react';
import type { BirthdayReward, Child, DateKey, FamilyData } from '../../types';
import {
  BIRTHDAY_MAX_POINTS,
  GIFT_MAX,
  MONTH_NAMES,
  birthdayAward,
  birthdayLabel,
  birthdayOf,
  isBirthdayOn,
  maxBirthdayDay,
  nextBirthday,
  validateBirthday,
  yearOf,
  type BirthdayDraft,
  type BirthdayField,
} from '../../lib/celebrations';
import { parseDateKey } from '../../lib/dates';
import { ErrorSummary, TextField } from '../../components/Field';
import { Modal } from '../../components/Modal';
import { recordKey } from '../../state/apiCommands';
import type { FamilyActions } from '../../state/storeTypes';
import { useToast } from '../../state/toast';

const longDate = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const formatKey = (key: DateKey) => {
  const d = parseDateKey(key);
  return d ? longDate.format(d) : key;
};

/** "This year's reward: given on …" / "not given yet" — for parents. */
export function birthdayRewardStatus(data: FamilyData, child: Child, today: DateKey): string {
  const birthday = birthdayOf(data, child.id);
  const year = yearOf(today);
  const award = birthdayAward(data, child.id, year);
  if (award) {
    const parts = [award.points > 0 ? `+${award.points} points` : null, award.note || null].filter(Boolean).join(' and ');
    // Parents always have the day and time; the guards only satisfy the shared type (see BonusAward).
    const at = new Date(award.awardedAt ?? '');
    const on = award.date ? ` on ${formatKey(award.date)}` : '';
    return `${year} birthday reward given${on}${Number.isNaN(at.getTime()) ? '' : ` at ${timeFormat.format(at)}`}${parts ? `: ${parts}` : ''}.`;
  }
  if (!birthday) return 'No birthday set.';
  if (!birthday.reward.enabled) return `No birthday reward is set up (the birthday theme still shows on ${birthdayLabel(birthday)}).`;
  if (isBirthdayOn(birthday, today)) return `Today is ${child.name}’s birthday! The reward is given at the first tap on a shared family screen.`;
  const next = nextBirthday(birthday, today);
  return yearOf(next) === year
    ? `${year} birthday reward not given yet. It will be given on ${formatKey(next)}.`
    : `${year} birthday has passed without a reward. Next birthday: ${formatKey(next)}.`;
}

interface BirthdayDialogProps {
  child: Child;
  data: FamilyData;
  today: DateKey;
  actions: FamilyActions;
  onClose: () => void;
  /** Show this child's birthday celebration on this screen, with the reward as filled in (nothing is given). */
  onPreview?: (childId: string, reward: BirthdayReward) => void;
}

/** Parent-only: set, edit or remove a child's birthday and its reward. */
export function BirthdayDialog({ child, data, today, actions, onClose, onPreview }: BirthdayDialogProps) {
  const notify = useToast();
  const existing = birthdayOf(data, child.id);
  // The record version when the dialog opened, so a stale save is refused.
  const [version] = useState(() => actions.versionOf(recordKey.birthday(child.id)));
  const [draft, setDraft] = useState<BirthdayDraft>({
    month: existing ? String(existing.month) : '',
    day: existing ? String(existing.day) : '',
    rewardEnabled: existing?.reward.enabled ?? true,
    points: String(existing?.reward.points ?? 50),
    gift: existing?.reward.gift ?? '',
  });
  const [errors, setErrors] = useState<Partial<Record<BirthdayField, string>>>({});
  const [busy, setBusy] = useState(false);
  const month = Number(draft.month);
  const dayCount = month >= 1 && month <= 12 ? maxBirthdayDay(month) : 31;

  const set = <K extends keyof BirthdayDraft>(k: K, v: BirthdayDraft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const v = validateBirthday(draft);
    if (!v.ok) {
      setErrors(v.errors);
      return;
    }
    setErrors({});
    setBusy(true);
    const r = await actions.saveBirthday({ childId: child.id, ...v.value }, version);
    setBusy(false);
    if (!r.ok) {
      notify(r.error, 'error');
      if (r.kind === 'conflict') onClose();
      return;
    }
    notify(`Saved ${child.name}’s birthday (${birthdayLabel(v.value)}).`);
    onClose();
  };

  const remove = async () => {
    setBusy(true);
    const r = await actions.removeBirthday(child.id, version);
    setBusy(false);
    if (!r.ok) {
      notify(r.error, 'error');
      return;
    }
    notify(`Removed ${child.name}’s birthday. Any reward already given is kept.`, 'info');
    onClose();
  };

  return (
    <Modal title={`${child.name}’s birthday`} onClose={onClose} size="lg" editing>
      <form className="form" onSubmit={(e) => void save(e)} noValidate>
        <ErrorSummary errors={errors} />
        <p className="muted">
          Only the day and month are kept, never the year of birth. Birthdays are shown to signed-in parents only; shared
          screens just learn whose birthday it is on the day.
        </p>
        <div className="birthday-date-row">
          <div className="field">
            <label htmlFor="birthday-month" className="field-label">
              Month
            </label>
            <select
              id="birthday-month"
              className="select"
              value={draft.month}
              onChange={(e) => set('month', e.target.value)}
              aria-invalid={errors.month ? true : undefined}
              data-autofocus
            >
              <option value="">— Month —</option>
              {MONTH_NAMES.map((name, i) => (
                <option key={name} value={i + 1}>
                  {name}
                </option>
              ))}
            </select>
            {errors.month && <p className="field-error">{errors.month}</p>}
          </div>
          <div className="field">
            <label htmlFor="birthday-day" className="field-label">
              Day
            </label>
            <select
              id="birthday-day"
              className="select"
              value={draft.day}
              onChange={(e) => set('day', e.target.value)}
              aria-invalid={errors.day ? true : undefined}
            >
              <option value="">— Day —</option>
              {Array.from({ length: dayCount }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {i + 1}
                </option>
              ))}
            </select>
            {errors.day && <p className="field-error">{errors.day}</p>}
          </div>
        </div>
        {month === 2 && draft.day === '29' && <p className="field-hint">In years without 29 February, the birthday is celebrated on 28 February.</p>}

        <fieldset className="birthday-reward">
          <legend className="field-label">Birthday reward</legend>
          <label className="switch">
            <input type="checkbox" role="switch" checked={draft.rewardEnabled} onChange={(e) => set('rewardEnabled', e.target.checked)} />
            <span className="switch-track" aria-hidden="true" />
            <span>Give a birthday reward</span>
          </label>
          <p className="field-hint">
            Given once per birthday, at the first tap on a shared family screen that day. It shows in the points and chore
            history. The birthday theme is switched separately in Themes &amp; Celebrations.
          </p>
          {draft.rewardEnabled && (
            <>
              <TextField
                id="birthday-points"
                label="Bonus points"
                inputMode="numeric"
                value={draft.points}
                onChange={(v) => set('points', v.replace(/\D/g, '').slice(0, 4))}
                error={errors.points}
                hint={`0 to ${BIRTHDAY_MAX_POINTS}. Use 0 for a gift without points.`}
                autoComplete="off"
              />
              <TextField
                id="birthday-gift"
                label="Gift or treat (optional)"
                value={draft.gift}
                onChange={(v) => set('gift', v)}
                error={errors.gift}
                hint="For example “Cinema trip” or “Choose dinner”. Shown to the child when the reward is given."
                maxLength={GIFT_MAX + 10}
                autoComplete="off"
              />
            </>
          )}
        </fieldset>

        <p className="birthday-status" data-testid="birthday-status">
          <span aria-hidden="true">🎁</span> {birthdayRewardStatus(data, child, today)}
        </p>

        <div className="button-row">
          {existing && (
            <button type="button" className="button button-danger-outline" onClick={() => void remove()} disabled={busy}>
              Remove birthday
            </button>
          )}
          {onPreview && (
            <button
              type="button"
              className="button button-secondary"
              onClick={() =>
                onPreview(child.id, {
                  enabled: draft.rewardEnabled,
                  points: Math.min(BIRTHDAY_MAX_POINTS, Number(draft.points) || 0),
                  gift: draft.gift.replace(/\s+/g, ' ').trim().slice(0, GIFT_MAX),
                })
              }
              disabled={busy}
            >
              Preview celebration
            </button>
          )}
          <button type="button" className="button button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={busy}>
            Save birthday
          </button>
        </div>
      </form>
    </Modal>
  );
}
