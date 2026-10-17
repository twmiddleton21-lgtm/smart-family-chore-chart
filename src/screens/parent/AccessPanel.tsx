import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { passwordProblem, usernameProblem, type DeviceListItem, type ParentListItem } from '../../api/auth';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { TextField } from '../../components/Field';
import { Modal } from '../../components/Modal';
import type { Access } from '../../state/access';
import { useToast } from '../../state/toast';
import { errorText } from '../auth/ParentSignInDialog';

// Parent accounts and paired devices (server builds with sign-in).
// Equal parents: any parent can add or remove parents and devices; each
// parent changes only their own password. The last parent can't be removed.

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never');

export function AccessPanel({ access, onSignOut }: { access: Access; onSignOut: () => void }) {
  const notify = useToast();
  const { client, status } = access;
  const [parents, setParents] = useState<ParentListItem[]>([]);
  const [devices, setDevices] = useState<DeviceListItem[]>([]);
  const [loadError, setLoadError] = useState<string>();

  const reload = useCallback(async () => {
    try {
      const [p, d] = await Promise.all([client.listParents(), client.listDevices()]);
      setParents(p);
      setDevices(d);
      setLoadError(undefined);
    } catch (e) {
      setLoadError(errorText(e));
    }
  }, [client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="panel settings-grid">
      {loadError && (
        <p className="field-error" role="alert">
          {loadError}
        </p>
      )}
      <section className="settings-card">
        <h2 className="section-subtitle">You</h2>
        <p>
          Signed in as <strong>{status.parent?.displayName}</strong> ({status.parent?.username}).
        </p>
        <button type="button" className="button button-secondary" onClick={onSignOut}>
          Sign out
        </button>
      </section>

      <ChangePasswordCard access={access} />

      <section className="settings-card">
        <h2 className="section-subtitle">Parents</h2>
        <ParentList parents={parents} access={access} onChanged={reload} onRemovedSelf={() => void access.refresh()} />
        <AddParentForm access={access} onAdded={reload} />
      </section>

      <section className="settings-card">
        <h2 className="section-subtitle">Family devices</h2>
        <p className="muted">
          Paired devices (like a kitchen tablet) can show the chart, tick chores and redeem rewards without a parent. The
          parent area always needs a parent to sign in.
        </p>
        {devices.length === 0 ? (
          <p>No devices are paired yet.</p>
        ) : (
          <ul className="access-list">
            {devices.map((d) => (
              <DeviceRow key={d.id} device={d} access={access} onChanged={reload} />
            ))}
          </ul>
        )}
        <PairingCard access={access} onPaired={() => void Promise.all([reload(), access.refresh()]).then(() => notify('This device is now a family device.'))} />
      </section>
    </div>
  );
}

function ChangePasswordCard({ access }: { access: Access }) {
  const notify = useToast();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const problem = passwordProblem(next, access.status.parent?.username ?? '') ?? (next !== confirm ? 'The two new passwords don’t match.' : null);
    if (!current) return setError('Enter your current password.');
    if (problem) return setError(problem);
    try {
      await access.client.changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      setError(undefined);
      notify('Password changed. You’ve been signed out on your other devices.');
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <form className="settings-card form" onSubmit={(e) => void submit(e)} noValidate>
      <h2 className="section-subtitle">Change your password</h2>
      <TextField id="pw-current" label="Current password" type="password" value={current} onChange={setCurrent} autoComplete="current-password" />
      <TextField id="pw-new" label="New password" hint="At least 10 characters." type="password" value={next} onChange={setNext} autoComplete="new-password" />
      <TextField id="pw-confirm" label="Type the new password again" type="password" value={confirm} onChange={setConfirm} autoComplete="new-password" error={error} />
      <button type="submit" className="button button-primary">
        Change password
      </button>
    </form>
  );
}

function ParentList({ parents, access, onChanged, onRemovedSelf }: { parents: ParentListItem[]; access: Access; onChanged: () => Promise<void>; onRemovedSelf: () => void }) {
  const notify = useToast();
  const [removing, setRemoving] = useState<ParentListItem | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const last = parents.length <= 1;

  const confirmRemove = async (event: FormEvent) => {
    event.preventDefault();
    if (!removing) return;
    try {
      const r = await access.client.removeParent(removing.id, password);
      setRemoving(null);
      notify(`${removing.displayName} can no longer sign in.`);
      if (r.removedSelf) onRemovedSelf();
      else await onChanged();
    } catch (e) {
      setPassword('');
      setError(errorText(e));
    }
  };

  return (
    <>
      <ul className="access-list">
        {parents.map((p) => (
          <li key={p.id} className="access-row">
            <span>
              <strong>{p.displayName}</strong> <span className="muted">({p.username})</span>
              {p.isYou && <span className="pill">You</span>}
            </span>
            <button
              type="button"
              className="button button-ghost"
              disabled={last}
              title={last ? 'The last parent account can’t be removed.' : undefined}
              onClick={() => {
                setPassword('');
                setError(undefined);
                setRemoving(p);
              }}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      {removing && (
        <Modal title={`Remove ${removing.displayName}?`} onClose={() => setRemoving(null)} size="sm">
          <form className="form" onSubmit={(e) => void confirmRemove(e)} noValidate>
            <p>
              {removing.isYou ? 'You will be signed out and won’t be able to sign in again.' : `${removing.displayName} will be signed out everywhere and won’t be able to sign in.`}{' '}
              Family data isn’t affected.
            </p>
            <TextField id="remove-password" label="Your password, to confirm" type="password" value={password} onChange={setPassword} autoComplete="current-password" error={error} data-autofocus />
            <div className="button-row">
              <button type="button" className="button button-secondary" onClick={() => setRemoving(null)}>
                Cancel
              </button>
              <button type="submit" className="button button-danger">
                Remove parent
              </button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

function AddParentForm({ access, onAdded }: { access: Access; onAdded: () => Promise<void> }) {
  const notify = useToast();
  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();

  if (!open) {
    return (
      <button type="button" className="button button-secondary" onClick={() => setOpen(true)}>
        Add a parent
      </button>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const problem = (displayName.trim() ? null : 'Enter their name.') ?? usernameProblem(username.trim()) ?? passwordProblem(password, username.trim());
    if (problem) return setError(problem);
    try {
      await access.client.addParent({ displayName: displayName.trim(), username: username.trim(), password });
      notify(`${displayName.trim()} can now sign in.`);
      setOpen(false);
      setDisplayName('');
      setUsername('');
      setPassword('');
      setError(undefined);
      await onAdded();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <form className="form" onSubmit={(e) => void submit(e)} noValidate>
      <h3 className="field-label">New parent</h3>
      <TextField id="add-name" label="Their name" value={displayName} onChange={setDisplayName} maxLength={40} autoComplete="off" />
      <TextField id="add-username" label="Username" value={username} onChange={setUsername} autoComplete="off" autoCapitalize="none" spellCheck={false} />
      <TextField
        id="add-password"
        label="Starting password"
        hint="Tell them in person. They can change it after signing in."
        type="password"
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
        error={error}
      />
      <div className="button-row">
        <button type="button" className="button button-secondary" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button type="submit" className="button button-primary">
          Add parent
        </button>
      </div>
    </form>
  );
}

function DeviceRow({ device, access, onChanged }: { device: DeviceListItem; access: Access; onChanged: () => Promise<void> }) {
  const notify = useToast();
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="access-row">
      <span>
        <strong>{device.name}</strong>
        {device.isThisDevice && <span className="pill">This device</span>}
        <br />
        <span className="muted">
          Paired {when(device.createdAt)} · last used {when(device.lastSeenAt)}
        </span>
      </span>
      <button type="button" className="button button-ghost" onClick={() => setConfirming(true)}>
        Unpair
      </button>
      {confirming && (
        <ConfirmDialog
          title={`Unpair ${device.name}?`}
          tone="danger"
          confirmLabel="Unpair device"
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            setConfirming(false);
            try {
              await access.client.revokeDevice(device.id);
              notify(`${device.name} is no longer paired.`);
              await onChanged();
              if (device.isThisDevice) await access.refresh();
            } catch (e) {
              notify(errorText(e), 'error');
            }
          }}
        >
          <p>It will stop showing the family chart straight away. You can pair it again later with a new code.</p>
        </ConfirmDialog>
      )}
    </li>
  );
}

function PairingCard({ access, onPaired }: { access: Access; onPaired: () => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const [issued, setIssued] = useState<{ code: string; expiresAt: string; name: string } | null>(null);
  const thisPaired = access.status.device !== null;

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return setError('Give the device a name, like “Kitchen tablet”.');
    try {
      const r = await access.client.createPairingCode(name.trim());
      setIssued({ ...r, name: name.trim() });
      setName('');
      setError(undefined);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const pairHere = async () => {
    if (!name.trim()) return setError('Give this device a name, like “Kitchen tablet”.');
    try {
      const r = await access.client.createPairingCode(name.trim());
      await access.client.pair(r.code);
      setName('');
      setError(undefined);
      onPaired();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <form className="form" onSubmit={(e) => void create(e)} noValidate>
      <h3 className="field-label">Pair a device</h3>
      <TextField id="device-name" label="Device name" value={name} onChange={setName} maxLength={40} autoComplete="off" error={error} />
      <div className="button-row data-buttons">
        <button type="submit" className="button button-primary">
          Create pairing code
        </button>
        {!thisPaired && (
          <button type="button" className="button button-secondary" onClick={() => void pairHere()}>
            Make this a family device
          </button>
        )}
      </div>
      {issued && (
        <div className="pairing-code" role="status">
          <p>
            On “{issued.name}”, open the chart and enter this code:
          </p>
          <p className="pairing-code-value" data-testid="pairing-code">
            {issued.code}
          </p>
          <p className="muted">It works once and expires at {new Date(issued.expiresAt).toLocaleTimeString(undefined, { timeStyle: 'short' })}.</p>
        </div>
      )}
    </form>
  );
}
