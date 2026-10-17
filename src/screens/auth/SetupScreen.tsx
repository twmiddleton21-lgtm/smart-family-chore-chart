import { useState, type FormEvent } from 'react';
import { passwordProblem, usernameProblem } from '../../api/auth';
import { ErrorSummary, TextField } from '../../components/Field';
import type { Access } from '../../state/access';
import { errorText } from './ParentSignInDialog';

/** First run: create the first parent account using the code from the server's startup output. */
export function SetupScreen({ access }: { access: Access }) {
  const [setupCode, setSetupCode] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [serverError, setServerError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next = {
      setupCode: setupCode.trim() ? undefined : 'Enter the setup code from the server’s startup output.',
      displayName: displayName.trim() ? undefined : 'Enter your name.',
      username: usernameProblem(username.trim()) ?? undefined,
      password: passwordProblem(password, username.trim()) ?? undefined,
      confirm: password === confirm ? undefined : 'The two passwords don’t match.',
    };
    setErrors(next);
    setServerError(undefined);
    if (Object.values(next).some(Boolean)) return;
    setBusy(true);
    try {
      await access.client.setup({ setupCode: setupCode.trim(), username: username.trim(), displayName: displayName.trim(), password });
      await access.refresh();
    } catch (e) {
      setServerError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="screen status-screen">
      <form className="status-card auth-card form" onSubmit={(e) => void submit(e)} noValidate>
        <p className="status-emoji" aria-hidden="true">
          👋
        </p>
        <h1 className="screen-title">Set up your family server</h1>
        <p>Create the first parent account. You can add other parents afterwards.</p>
        <ErrorSummary errors={errors} />
        {serverError && (
          <p className="field-error" role="alert">
            {serverError}
          </p>
        )}
        <TextField
          id="setup-code"
          label="Setup code"
          hint="Shown once in the server’s startup output (for example XXXX-XXXX-XXXX)."
          value={setupCode}
          onChange={setSetupCode}
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          error={errors.setupCode}
          data-autofocus
        />
        <TextField id="setup-name" label="Your name" value={displayName} onChange={setDisplayName} maxLength={40} autoComplete="name" error={errors.displayName} />
        <TextField id="setup-username" label="Username" hint="3–32 letters, numbers, dots, dashes or underscores." value={username} onChange={setUsername} autoComplete="username" autoCapitalize="none" spellCheck={false} error={errors.username} />
        <TextField id="setup-password" label="Password" hint="At least 10 characters. A few random words work well." type="password" value={password} onChange={setPassword} autoComplete="new-password" error={errors.password} />
        <TextField id="setup-confirm" label="Type the password again" type="password" value={confirm} onChange={setConfirm} autoComplete="new-password" error={errors.confirm} />
        <button type="submit" className="button button-primary" disabled={busy}>
          {busy ? 'Creating…' : 'Create parent account'}
        </button>
      </form>
    </main>
  );
}
