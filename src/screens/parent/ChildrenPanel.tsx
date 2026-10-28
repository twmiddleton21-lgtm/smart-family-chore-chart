import { useState, type FormEvent } from 'react';
import type { Child, FamilyData } from '../../types';
import { validateChild, LIMITS, type ChildDraft, type ChildField } from '../../lib/validation';
import { pointsBalance } from '../../lib/points';
import { Avatar } from '../../components/Avatar';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ErrorSummary, TextField } from '../../components/Field';
import { Modal } from '../../components/Modal';
import { ColorPicker, EmojiPicker } from '../../components/Pickers';
import type { FamilyActions } from '../../state/useFamilyStore';
import { useToast } from '../../state/toast';

const AVATARS = ['🦄', '🦖', '🦊', '🐼', '🐯', '🐸', '🐙', '🦁', '🐰', '🐨', '🚀', '⚽', '🌈', '🌻', '🎨', '🦋'];

interface PanelProps {
  data: FamilyData;
  actions: FamilyActions;
}

// `version`: the record version when the dialog opened, so a stale save is refused (409).
type Editing = { mode: 'add' } | { mode: 'edit'; child: Child; version: number } | null;

export function ChildrenPanel({ data, actions }: PanelProps) {
  const notify = useToast();
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<Child | null>(null);
  const [deleteVersion, setDeleteVersion] = useState(0);
  const startDelete = (item: Child) => {
    setDeleteVersion(actions.versionOf(`child:${item.id}`));
    setDeleting(item);
  };

  return (
    <div className="panel">
      <div className="panel-toolbar">
        <p className="muted">Use a first name or nickname only. No other personal details are needed.</p>
        <button type="button" className="button button-primary" onClick={() => setEditing({ mode: 'add' })}>
          ＋ Add child
        </button>
      </div>

      {data.children.length === 0 ? (
        <div className="empty-card">
          <p>No profiles yet. Add the first one!</p>
        </div>
      ) : (
        <ul className="admin-list admin-cards">
          {data.children.map((child) => (
            <li key={child.id} className={`admin-row accent-${child.color}`}>
              <Avatar child={child} size="md" />
              <span className="admin-main">
                <span className="admin-name">{child.name}</span>
                <span className="admin-meta">
                  {data.chores.filter((c) => c.childId === child.id).length} chores · ⭐ {pointsBalance(data, child.id)} points
                </span>
              </span>
              <span className="admin-actions">
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => setEditing({ mode: 'edit', child, version: actions.versionOf(`child:${child.id}`) })}
                  aria-label={`Edit ${child.name}`}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="button button-danger-outline"
                  onClick={() => startDelete(child)}
                  aria-label={`Delete ${child.name}`}
                >
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <ChildForm
          child={editing.mode === 'edit' ? editing.child : undefined}
          onCancel={() => setEditing(null)}
          onSave={async (value) => {
            const id = editing.mode === 'edit' ? editing.child.id : undefined;
            const result = await actions.saveChild(value, id, editing.mode === 'edit' ? editing.version : undefined);
            if (!result.ok) {
              notify(result.error, 'error');
              return;
            }
            setEditing(null);
            notify(id ? `Saved ${value.name}’s profile.` : `Added ${value.name}! Now give them some chores.`);
          }}
        />
      )}

      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.name}?`}
          tone="danger"
          confirmLabel={`Yes, delete ${deleting.name}`}
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            const result = await actions.deleteChild(deleting.id, deleteVersion);
            if (!result.ok) {
              notify(result.error, 'error');
              setDeleting(null);
              return;
            }
            notify(`Deleted ${deleting.name}’s profile.`, 'info');
            setDeleting(null);
          }}
        >
          <p className="confirm-emoji" aria-hidden="true">
            {deleting.avatar}
          </p>
          <p>
            This permanently removes <strong>{deleting.name}</strong> and everything that belongs to them:
          </p>
          <ul className="plain-list">
            <li>{data.chores.filter((c) => c.childId === deleting.id).length} chores</li>
            <li>⭐ {pointsBalance(data, deleting.id)} points and their history</li>
            <li>Redeemed rewards and planned school meals</li>
          </ul>
          <p>Other children are not affected. This can’t be undone.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}

interface ChildFormProps {
  child?: Child;
  onSave: (value: Omit<Child, 'id'>) => void;
  onCancel: () => void;
}

function ChildForm({ child, onSave, onCancel }: ChildFormProps) {
  const [draft, setDraft] = useState<ChildDraft>({
    name: child?.name ?? '',
    avatar: child?.avatar ?? AVATARS[3]!,
    color: child?.color ?? 'sky',
  });
  const [errors, setErrors] = useState<Partial<Record<ChildField, string>>>({});

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = validateChild(draft);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    onSave(result.value);
  };

  return (
    <Modal title={child ? `Edit ${child.name}` : 'Add a child'} onClose={onCancel} size="lg" editing>
      <form className="form" onSubmit={submit} noValidate>
        <ErrorSummary errors={errors} />
        <TextField
          id="child-name"
          data-autofocus
          label="Name or nickname"
          value={draft.name}
          onChange={(name) => setDraft((d) => ({ ...d, name }))}
          error={errors.name}
          hint="First name or nickname only."
          maxLength={LIMITS.nameMax + 10}
          autoComplete="off"
        />
        <EmojiPicker
          idPrefix="child-avatar"
          legend="Avatar"
          value={draft.avatar}
          options={AVATARS}
          onChange={(avatar) => setDraft((d) => ({ ...d, avatar }))}
          error={errors.avatar}
        />
        <ColorPicker value={draft.color} onChange={(color) => setDraft((d) => ({ ...d, color }))} error={errors.color} />
        <div className="button-row">
          <button type="button" className="button button-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="button button-primary">
            {child ? 'Save changes' : 'Add child'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
