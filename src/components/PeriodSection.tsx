import type { Chore, Period } from '../types';
import { ChoreItem } from './ChoreItem';

export const PERIOD_INFO: Record<Period, { label: string; icon: string; empty: string }> = {
  morning: { label: 'Morning', icon: '☀️', empty: 'No morning chores today. Enjoy your breakfast!' },
  afternoon: { label: 'Afternoon', icon: '🌤️', empty: 'No afternoon chores today. Time to play!' },
  evening: { label: 'Evening', icon: '🌙', empty: 'No evening chores today. Relax and unwind!' },
};

interface PeriodSectionProps {
  period: Period;
  chores: Chore[];
  isDone: (chore: Chore) => boolean;
  onToggle: (chore: Chore) => void;
}

export function PeriodSection({ period, chores, isDone, onToggle }: PeriodSectionProps) {
  const info = PERIOD_INFO[period];
  const done = chores.filter(isDone).length;
  const headingId = `period-${period}`;
  const allDone = chores.length > 0 && done === chores.length;

  return (
    <section className={`period period-${period}`} aria-labelledby={headingId}>
      <header className="period-header">
        <h2 id={headingId} className="period-title">
          <span aria-hidden="true">{info.icon}</span> {info.label}
        </h2>
        {chores.length > 0 && (
          <span className={`period-count ${allDone ? 'period-count-done' : ''}`}>
            {allDone ? '🎉 All done!' : `${done} of ${chores.length} done`}
          </span>
        )}
      </header>
      {chores.length === 0 ? (
        <p className="period-empty">{info.empty}</p>
      ) : (
        <ul className="chore-list">
          {chores.map((chore) => (
            <ChoreItem key={chore.id} chore={chore} done={isDone(chore)} onToggle={onToggle} />
          ))}
        </ul>
      )}
    </section>
  );
}
