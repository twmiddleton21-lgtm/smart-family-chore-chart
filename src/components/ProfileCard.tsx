import type { Child } from '../types';
import type { DayProgress } from '../lib/chores';
import { Avatar } from './Avatar';
import { ProgressBar } from './ProgressBar';

interface ProfileCardProps {
  child: Child;
  progress: DayProgress;
  balance: number;
  onSelect: (child: Child) => void;
  /** It's this child's birthday (and the birthday theme is on). */
  birthday?: boolean;
}

export function ProfileCard({ child, progress, balance, onSelect, birthday = false }: ProfileCardProps) {
  const allDone = progress.total > 0 && progress.done === progress.total;
  return (
    <li>
      <button
        type="button"
        className={`profile-card accent-${child.color}`}
        onClick={() => onSelect(child)}
        aria-label={`Open ${child.name}'s chore chart. ${progress.done} of ${progress.total} chores done today. ${balance} points.${birthday ? ' Happy birthday!' : ''}`}
      >
        <Avatar child={child} size="xl" />
        <span className="profile-info">
          <span className="profile-name">
            {child.name}
            {birthday && (
              <span className="birthday-badge" aria-hidden="true">
                🎂 Birthday!
              </span>
            )}
          </span>
          <span className="profile-stats">
            <span className="profile-done">
              {allDone ? '🎉 All done today!' : `${progress.done} of ${progress.total} chores done`}
            </span>
            <span className="points-pill">⭐ {balance} points</span>
          </span>
          <ProgressBar done={progress.done} total={progress.total} label={`${child.name}'s chores today`} />
        </span>
        <span className="profile-go" aria-hidden="true">
          ➜
        </span>
      </button>
    </li>
  );
}
