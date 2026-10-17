import { useState, type FormEvent } from 'react';
import { TextField } from '../../components/Field';
import type { Access } from '../../state/access';
import { errorText, ParentSignInDialog } from './ParentSignInDialog';

/** Shown to a browser that is neither paired nor signed in: nothing of the family is visible. */
export function LockedScreen({ access }: { access: Access }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [signingIn, setSigningIn] = useState(false);

  const pair = async (event: FormEvent) => {
    event.preventDefault();
    if (!code.trim()) {
      setError('Enter the pairing code.');
      return;
    }
    setBusy(true);
    try {
      await access.client.pair(code.trim());
      await access.refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="screen status-screen">
      <div className="status-card auth-card">
        <p className="status-emoji" aria-hidden="true">
          🔒
        </p>
        <h1 className="screen-title">Connect this device</h1>
        <p>This device isn’t connected to your family chart yet.</p>

        <form className="form auth-section" onSubmit={(e) => void pair(e)} noValidate>
          <h2 className="section-subtitle">Pair a family device</h2>
          <TextField
            id="pairing-code"
            label="Pairing code"
            hint="A parent can create one in Parent area → Family access. Codes work once and expire after 10 minutes."
            value={code}
            onChange={(v) => {
              setError(undefined);
              setCode(v);
            }}
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            error={error}
          />
          <button type="submit" className="button button-primary" disabled={busy}>
            {busy ? 'Pairing…' : 'Pair this device'}
          </button>
        </form>

        <div className="auth-section">
          <h2 className="section-subtitle">Or, if you’re a parent</h2>
          <button type="button" className="button button-secondary" onClick={() => setSigningIn(true)}>
            Parent sign in
          </button>
        </div>
      </div>
      {signingIn && <ParentSignInDialog access={access} onCancel={() => setSigningIn(false)} onSignedIn={() => setSigningIn(false)} />}
    </main>
  );
}
