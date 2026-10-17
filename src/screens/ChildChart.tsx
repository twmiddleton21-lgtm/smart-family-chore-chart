import { useRef } from 'react';
import { PERIODS, type Child, type Chore, type DateKey, type FamilyData } from '../types';
import { childProgress, choresByPeriod, choresForChildOn, isChoreDone } from '../lib/chores';
import { pointsBalance } from '../lib/points';
import { Avatar } from '../components/Avatar';
import { PeriodSection } from '../components/PeriodSection';
import { ProgressBar } from '../components/ProgressBar';
import { ScreenTitle } from '../components/ScreenTitle';
import type { FamilyActions } from '../state/useFamilyStore';
import { useToast } from '../state/toast';

interface ChildChartProps {
  data: FamilyData;
  child: Child;
  today: DateKey;
  actions: FamilyActions;
  onBack: () => void;
  onOpenRewards: () => void;
}

const CHEERS = ['Great job', 'Nice work', 'Brilliant', 'Super', 'Way to go', 'Awesome'];

export function ChildChart({ data, child, today, actions, onBack, onOpenRewards }: ChildChartProps) {
  const notify = useToast();
  const chores = choresForChildOn(data, child.id, today);
  const byPeriod = choresByPeriod(chores);
  const progress = childProgress(data, child.id, today);
  const balance = pointsBalance(data, child.id);
  const allDone = progress.total > 0 && progress.done === progress.total;

  // Ignore repeat taps on a chore while its change is being saved.
  const busy = useRef(new Set<string>());

  const handleToggle = async (chore: Chore) => {
    if (busy.current.has(chore.id)) return;
    busy.current.add(chore.id);
    const wasDone = isChoreDone(data, chore, today);
    const result = await actions.toggleChore(chore.id).finally(() => busy.current.delete(chore.id));
    if (!result.ok) {
      notify(result.error, 'error');
      return;
    }
    if (!wasDone) {
      const cheer = CHEERS[Math.floor(Math.random() * CHEERS.length)];
      notify(`${cheer}, ${child.name}! +${chore.points} points for “${chore.title}”.`);
    } else {
      notify(`“${chore.title}” unticked. ${chore.points} points removed.`, 'info');
    }
  };

  return (
    <main className={`screen chart accent-${child.color}`}>
      <header className="topbar">
        <button type="button" className="button button-ghost" onClick={onBack}>
          <span aria-hidden="true">←</span> All profiles
        </button>
        <button type="button" className="button button-reward" onClick={onOpenRewards}>
          <span aria-hidden="true">🎁</span> Rewards
        </button>
      </header>

      <section className="chart-hero">
        <Avatar child={child} size="lg" />
        <div className="chart-hero-text">
          <ScreenTitle>{child.name}’s chores</ScreenTitle>
          <p className="chart-summary">
            {progress.total === 0
              ? 'No chores scheduled today.'
              : allDone
                ? `🎉 All ${progress.total} chores done today. Amazing!`
                : `${progress.done} of ${progress.total} chores done today`}
          </p>
          <ProgressBar done={progress.done} total={progress.total} label={`${child.name}'s chores today`} size="lg" />
        </div>
        <div className="chart-points" aria-label={`${balance} points to spend. ${progress.pointsToday} earned today.`}>
          <span className="chart-points-value">⭐ {balance}</span>
          <span className="chart-points-label">points</span>
          <span className="chart-points-today">+{progress.pointsToday} today</span>
        </div>
      </section>

      <div className="periods">
        {PERIODS.map((period) => (
          <PeriodSection
            key={period}
            period={period}
            chores={byPeriod[period]}
            isDone={(chore) => isChoreDone(data, chore, today)}
            onToggle={handleToggle}
          />
        ))}
      </div>
    </main>
  );
}
