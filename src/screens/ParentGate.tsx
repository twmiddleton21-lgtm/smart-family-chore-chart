import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Modal } from '../components/Modal';
import { DEFAULT_PIN } from '../lib/sampleData';

interface ParentGateProps {
  pin: string;
  onUnlock: () => void;
  onCancel: () => void;
}

const MAX_ATTEMPTS = 5;
const LOCKOUT_SECONDS = 30;

/**
 * A simple PIN gate that keeps children out of the parent area.
 * This is a convenience barrier only: the PIN is stored in the browser and
 * anyone with access to developer tools can read or bypass it.
 */
export function ParentGate({ pin, onUnlock, onCancel }: ParentGateProps) {
  const [entry, setEntry] = useState('');
  const [error, setError] = useState('');
  const [attempts, setAttempts] = useState(0);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [, forceTick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const locked = lockedUntil !== null && Date.now() < lockedUntil;
  const secondsLeft = locked ? Math.ceil((lockedUntil - Date.now()) / 1000) : 0;

  useEffect(() => {
    if (!lockedUntil) return;
    const id = window.setInterval(() => {
      if (Date.now() >= lockedUntil) {
        setLockedUntil(null);
        setAttempts(0);
        setError('');
      }
      forceTick((n) => n + 1);
    }, 500);
    return () => window.clearInterval(id);
  }, [lockedUntil]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (locked) return;
    if (entry === pin) {
      onUnlock();
      return;
    }
    const next = attempts + 1;
    setAttempts(next);
    setEntry('');
    if (next >= MAX_ATTEMPTS) {
      setLockedUntil(Date.now() + LOCKOUT_SECONDS * 1000);
      setError(`Too many tries. Please wait ${LOCKOUT_SECONDS} seconds.`);
    } else {
      setError('That PIN isn’t right. Please try again.');
    }
    inputRef.current?.focus();
  };

  const press = (digit: string) => {
    if (locked) return;
    setError('');
    setEntry((e) => (e.length < 8 ? e + digit : e));
  };

  return (
    <Modal title="Parent area" onClose={onCancel} size="sm">
      <form className="pin-form" onSubmit={submit} noValidate>
        <label htmlFor="parent-pin" className="field-label">
          Enter the parent PIN
        </label>
        <input
          ref={inputRef}
          id="parent-pin"
          className="input pin-input"
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={8}
          value={entry}
          disabled={locked}
          data-autofocus
          onChange={(e) => {
            setError('');
            setEntry(e.target.value.replace(/\D/g, '').slice(0, 8));
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby="pin-help"
        />
        <p id="pin-help" className={error ? 'field-error' : 'field-hint'} role={error ? 'alert' : undefined}>
          {locked ? `Too many tries. Please wait ${secondsLeft} seconds.` : error || 'Grown-ups only, please.'}
        </p>

        <div className="keypad" role="group" aria-label="PIN keypad">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
            <button key={d} type="button" className="key" onClick={() => press(d)} disabled={locked}>
              {d}
            </button>
          ))}
          <button
            type="button"
            className="key key-muted"
            onClick={() => setEntry((e) => e.slice(0, -1))}
            disabled={locked}
            aria-label="Delete last digit"
          >
            ⌫
          </button>
          <button type="button" className="key" onClick={() => press('0')} disabled={locked}>
            0
          </button>
          <button type="submit" className="key key-go" disabled={locked || entry.length === 0} aria-label="Unlock">
            ✓
          </button>
        </div>

        {pin === DEFAULT_PIN && (
          <p className="field-hint pin-demo">
            Demo PIN: <strong>{DEFAULT_PIN}</strong>. Change it in Parent area → Settings.
          </p>
        )}
      </form>
    </Modal>
  );
}
