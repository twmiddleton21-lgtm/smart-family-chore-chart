import type { Chore } from '../types';

interface ChoreItemProps {
  chore: Chore;
  done: boolean;
  onToggle: (chore: Chore) => void;
}

/**
 * One chore as a large toggle button. State is conveyed by aria-pressed,
 * a checkmark, a "Done!" label and colour — never colour alone.
 */
export function ChoreItem({ chore, done, onToggle }: ChoreItemProps) {
  return (
    <li>
      <button
        type="button"
        className={`chore ${done ? 'chore-done' : ''}`}
        aria-pressed={done}
        aria-label={`${chore.title}, ${chore.points} points, ${done ? 'done. Tap to undo.' : 'not done yet. Tap when finished.'}`}
        onClick={() => onToggle(chore)}
      >
        <span className="chore-check" aria-hidden="true">
          {done ? '✓' : ''}
        </span>
        <span className="chore-icon" aria-hidden="true">
          {chore.icon}
        </span>
        <span className="chore-text">
          <span className="chore-title">{chore.title}</span>
          <span className="chore-status">{done ? 'Done!' : 'To do'}</span>
        </span>
        <span className="chore-points" aria-hidden="true">
          <span className="chore-points-star">⭐</span>
          {chore.points}
        </span>
      </button>
    </li>
  );
}
