import type { Child, DateKey, FamilyData } from '../types';
import { childProgress } from '../lib/chores';
import { pointsBalance } from '../lib/points';
import { Clock } from '../components/Clock';
import { ProfileCard } from '../components/ProfileCard';
import { ScreenTitle } from '../components/ScreenTitle';
import { TodaysMeals } from '../components/TodaysMeals';

interface DashboardProps {
  data: FamilyData;
  today: DateKey;
  onSelectChild: (child: Child) => void;
  onOpenParent: () => void;
}

export function Dashboard({ data, today, onSelectChild, onOpenParent }: DashboardProps) {
  const progress = data.children.map((child) => childProgress(data, child.id, today));
  const familyDone = progress.reduce((sum, p) => sum + p.done, 0);
  const familyTotal = progress.reduce((sum, p) => sum + p.total, 0);

  return (
    <main className="screen dashboard">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ✓
          </span>
          <span className="brand-name">Smart Family Chore Chart</span>
        </div>
        <button type="button" className="button button-ghost" onClick={onOpenParent}>
          <span aria-hidden="true">🔒</span> Parent area
        </button>
      </header>

      <Clock familyName={data.settings.familyName} />

      <TodaysMeals data={data} today={today} />

      <section className="profiles" aria-labelledby="profiles-title">
        <div className="section-heading">
          <ScreenTitle className="profiles-title">
            <span id="profiles-title">Who’s doing chores?</span>
          </ScreenTitle>
          {familyTotal > 0 && (
            <p className="family-progress">
              Family today: <strong>{familyDone}</strong> of <strong>{familyTotal}</strong> chores done
            </p>
          )}
        </div>

        {data.children.length === 0 ? (
          <div className="empty-card">
            <p className="empty-emoji" aria-hidden="true">
              👋
            </p>
            <p>No profiles yet. A grown-up can add one in the Parent area.</p>
            <button type="button" className="button button-primary" onClick={onOpenParent}>
              Open parent area
            </button>
          </div>
        ) : (
          <ul className="profile-list">
            {data.children.map((child, i) => (
              <ProfileCard
                key={child.id}
                child={child}
                progress={progress[i]!}
                balance={pointsBalance(data, child.id)}
                onSelect={onSelectChild}
              />
            ))}
          </ul>
        )}
      </section>

      <footer className="dashboard-footer">
        <p>Tap your picture to see today’s chores. Data is saved on this device only.</p>
      </footer>
    </main>
  );
}
