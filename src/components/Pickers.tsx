import { ACCENT_COLORS, type AccentColor } from '../types';

const COLOR_NAMES: Record<AccentColor, string> = {
  pink: 'Pink',
  teal: 'Teal',
  yellow: 'Yellow',
  lavender: 'Lavender',
  orange: 'Orange',
  sky: 'Sky blue',
  mint: 'Mint',
};

interface EmojiPickerProps {
  legend: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  error?: string;
  /** Label for the free-text box that accepts any emoji. */
  customLabel?: string;
  idPrefix: string;
}

/** A grid of large emoji choices plus a box for typing any other emoji. */
export function EmojiPicker({ legend, value, options, onChange, error, customLabel = 'Or type your own', idPrefix }: EmojiPickerProps) {
  const errorId = `${idPrefix}-error`;
  return (
    <fieldset className="field" aria-describedby={error ? errorId : undefined}>
      <legend className="field-label">{legend}</legend>
      <div className="emoji-grid">
        {options.map((emoji) => (
          <button
            key={emoji}
            type="button"
            className={`emoji-option ${value === emoji ? 'selected' : ''}`}
            aria-pressed={value === emoji}
            aria-label={emoji}
            onClick={() => onChange(emoji)}
          >
            {emoji}
          </button>
        ))}
      </div>
      <label className="emoji-custom">
        <span>{customLabel}</span>
        <input
          type="text"
          className="input input-emoji"
          value={value}
          maxLength={16}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={error ? true : undefined}
        />
      </label>
      {error && (
        <p id={errorId} className="field-error">
          {error}
        </p>
      )}
    </fieldset>
  );
}

interface ColorPickerProps {
  value: string;
  onChange: (value: AccentColor) => void;
  error?: string;
}

export function ColorPicker({ value, onChange, error }: ColorPickerProps) {
  return (
    <fieldset className="field">
      <legend className="field-label">Colour</legend>
      <div className="color-grid">
        {ACCENT_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            className={`color-option accent-${color} ${value === color ? 'selected' : ''}`}
            aria-pressed={value === color}
            onClick={() => onChange(color)}
          >
            <span className="color-swatch" aria-hidden="true">
              {value === color ? '✓' : ''}
            </span>
            {COLOR_NAMES[color]}
          </button>
        ))}
      </div>
      {error && <p className="field-error">{error}</p>}
    </fieldset>
  );
}
