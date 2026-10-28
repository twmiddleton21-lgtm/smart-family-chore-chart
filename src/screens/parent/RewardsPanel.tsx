import { useState, type FormEvent } from 'react';
import type { FamilyData, Reward } from '../../types';
import { validateReward, LIMITS, type RewardDraft, type RewardField } from '../../lib/validation';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ErrorSummary, TextField } from '../../components/Field';
import { Modal } from '../../components/Modal';
import { EmojiPicker } from '../../components/Pickers';
import type { FamilyActions } from '../../state/useFamilyStore';
import { useToast } from '../../state/toast';

const REWARD_ICONS = ['🎁', '📺', '🎬', '🍪', '🍦', '🛝', '🌙', '🎮', '📖', '🎨', '⚽', '🍕'];

interface PanelProps {
  data: FamilyData;
  actions: FamilyActions;
}

// `version`: the record version when the dialog opened, so a stale save is refused (409).
type Editing = { mode: 'add' } | { mode: 'edit'; reward: Reward; version: number } | null;

export function RewardsPanel({ data, actions }: PanelProps) {
  const notify = useToast();
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<Reward | null>(null);
  const [deleteVersion, setDeleteVersion] = useState(0);
  const startDelete = (item: Reward) => {
    setDeleteVersion(actions.versionOf(`reward:${item.id}`));
    setDeleting(item);
  };
  const rewards = [...data.rewards].sort((a, b) => a.cost - b.cost);

  return (
    <div className="panel">
      <div className="panel-toolbar">
        <p className="muted">Rewards are shared by all children. No money or payments are involved.</p>
        <button type="button" className="button button-primary" onClick={() => setEditing({ mode: 'add' })}>
          ＋ Add reward
        </button>
      </div>

      {rewards.length === 0 ? (
        <div className="empty-card">
          <p>No rewards yet. Add something fun to work towards!</p>
        </div>
      ) : (
        <ul className="admin-list admin-cards">
          {rewards.map((reward) => (
            <li key={reward.id} className="admin-row">
              <span className="admin-icon" aria-hidden="true">
                {reward.icon}
              </span>
              <span className="admin-main">
                <span className="admin-name">{reward.name}</span>
                <span className="admin-meta">
                  ⭐ {reward.cost} points{reward.description ? ` · ${reward.description}` : ''}
                </span>
              </span>
              <span className="admin-actions">
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => setEditing({ mode: 'edit', reward, version: actions.versionOf(`reward:${reward.id}`) })}
                  aria-label={`Edit ${reward.name}`}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="button button-danger-outline"
                  onClick={() => startDelete(reward)}
                  aria-label={`Delete ${reward.name}`}
                >
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <RewardForm
          reward={editing.mode === 'edit' ? editing.reward : undefined}
          onCancel={() => setEditing(null)}
          onSave={async (value) => {
            const id = editing.mode === 'edit' ? editing.reward.id : undefined;
            const result = await actions.saveReward(value, id, editing.mode === 'edit' ? editing.version : undefined);
            if (!result.ok) {
              notify(result.error, 'error');
              return;
            }
            setEditing(null);
            notify(id ? `Saved “${value.name}”.` : `Added “${value.name}”.`);
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title="Delete this reward?"
          tone="danger"
          confirmLabel="Yes, delete it"
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            const result = await actions.deleteReward(deleting.id, deleteVersion);
            if (!result.ok) {
              notify(result.error, 'error');
              setDeleting(null);
              return;
            }
            notify(`Deleted “${deleting.name}”.`, 'info');
            setDeleting(null);
          }}
        >
          <p>
            <strong>
              {deleting.icon} {deleting.name}
            </strong>{' '}
            will no longer be available. Past redemptions stay in each child’s history.
          </p>
        </ConfirmDialog>
      )}
    </div>
  );
}

interface RewardFormProps {
  reward?: Reward;
  onSave: (value: Omit<Reward, 'id'>) => void;
  onCancel: () => void;
}

function RewardForm({ reward, onSave, onCancel }: RewardFormProps) {
  const [draft, setDraft] = useState<RewardDraft>({
    name: reward?.name ?? '',
    description: reward?.description ?? '',
    icon: reward?.icon ?? '🎁',
    cost: String(reward?.cost ?? 25),
  });
  const [errors, setErrors] = useState<Partial<Record<RewardField, string>>>({});
  const set = (key: keyof RewardDraft, value: string) => setDraft((d) => ({ ...d, [key]: value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = validateReward(draft);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    onSave(result.value);
  };

  return (
    <Modal title={reward ? 'Edit reward' : 'Add a reward'} onClose={onCancel} size="lg" editing>
      <form className="form" onSubmit={submit} noValidate>
        <ErrorSummary errors={errors} />
        <TextField
          id="reward-name"
          data-autofocus
          label="Reward name"
          value={draft.name}
          onChange={(v) => set('name', v)}
          error={errors.name}
          maxLength={LIMITS.rewardNameMax + 10}
          placeholder="e.g. Ice cream trip"
          autoComplete="off"
        />
        <TextField
          id="reward-description"
          label="Description (optional)"
          value={draft.description}
          onChange={(v) => set('description', v)}
          error={errors.description}
          maxLength={LIMITS.descriptionMax + 10}
          autoComplete="off"
        />
        <EmojiPicker
          idPrefix="reward-icon"
          legend="Icon"
          value={draft.icon}
          options={REWARD_ICONS}
          onChange={(v) => set('icon', v)}
          error={errors.icon}
        />
        <TextField
          id="reward-cost"
          label="Cost in points"
          value={draft.cost}
          onChange={(v) => set('cost', v)}
          error={errors.cost}
          hint={`A whole number from ${LIMITS.rewardMinCost} to ${LIMITS.rewardMaxCost}.`}
          inputMode="numeric"
          autoComplete="off"
        />
        <div className="button-row">
          <button type="button" className="button button-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="button button-primary">
            {reward ? 'Save changes' : 'Add reward'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
