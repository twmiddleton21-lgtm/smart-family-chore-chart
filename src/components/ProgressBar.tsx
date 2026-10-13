interface ProgressBarProps {
  done: number;
  total: number;
  /** Accessible name, e.g. "Maya's chores today". */
  label: string;
  size?: 'sm' | 'lg';
}

export function ProgressBar({ done, total, label, size = 'sm' }: ProgressBarProps) {
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return (
    <div
      className={`progress progress-${size}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      aria-valuetext={`${done} of ${total} done`}
    >
      <div className="progress-fill" style={{ width: `${percent}%` }} />
    </div>
  );
}
