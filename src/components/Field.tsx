import type { InputHTMLAttributes } from 'react';

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'> {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
}

/** Labelled text input with an associated hint and error message. */
export function TextField({ id, label, value, onChange, error, hint, ...rest }: TextFieldProps) {
  const describedBy = [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined;
  return (
    <div className="field">
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <input
        id={id}
        className="input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
      />
      {hint && (
        <p id={`${id}-hint`} className="field-hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="field-error">
          {error}
        </p>
      )}
    </div>
  );
}

/** Shown at the top of a form when validation fails. */
export function ErrorSummary({ errors }: { errors: Record<string, string | undefined> }) {
  const messages = Object.values(errors).filter(Boolean);
  if (messages.length === 0) return null;
  return (
    <div className="error-summary" role="alert">
      <p>
        <strong>Please fix {messages.length === 1 ? 'this' : `these ${messages.length} things`}:</strong>
      </p>
      <ul>
        {messages.map((m) => (
          <li key={m}>{m}</li>
        ))}
      </ul>
    </div>
  );
}
