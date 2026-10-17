import { useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client';
import { Modal } from '../../components/Modal';
import { TextField } from '../../components/Field';
import type { Access } from '../../state/access';

interface ParentSignInDialogProps {
  access: Access;
  onSignedIn: () => void;
  onCancel: () => void;
}

export const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');

/** Parent sign-in with the family server (replaces the browser PIN in server builds). */
export function ParentSignInDialog({ access, onSignedIn, onCancel }: ParentSignInDialogProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const shared = access.status.device !== null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!username.trim() || !password) {
      setError('Enter your username and password.');
      return;
    }
    setBusy(true);
    try {
      await access.client.login(username.trim(), password, remember);
      await access.refresh();
      onSignedIn();
    } catch (e) {
      setPassword('');
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Parent sign in" onClose={onCancel} size="sm">
      <form className="form" onSubmit={(e) => void submit(e)} noValidate>
        <TextField id="signin-username" label="Username" value={username} onChange={setUsername} autoComplete="username" autoCapitalize="none" spellCheck={false} data-autofocus />
        <TextField id="signin-password" label="Password" type="password" value={password} onChange={setPassword} autoComplete="current-password" error={error} />
        <label className="check-row">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Keep me signed in on this device
        </label>
        <p className="field-hint">
          {shared
            ? 'This is a shared family device. Leave this unticked so the parent area locks again when you’re done.'
            : 'Only tick this on your own phone or computer. Otherwise you’ll be signed out after 30 minutes without activity.'}
        </p>
        <div className="button-row">
          <button type="button" className="button button-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
