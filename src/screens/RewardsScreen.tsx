import { useState } from 'react';
import type { Child, FamilyData, Reward } from '../types';
import { pointsBalance } from '../lib/points';
import { recentRedemptions } from '../lib/rewards';
import { parseDateKey } from '../lib/dates';
import { Avatar } from '../components/Avatar';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ScreenTitle } from '../components/ScreenTitle';
import type { FamilyActions } from '../state/useFamilyStore';
import { useToast } from '../state/toast';

interface RewardsScreenProps {
  data: FamilyData;
  child: Child;
  actions: FamilyActions;
  onBack: () => void;
}

const shortDate = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

export function RewardsScreen({ data, child, actions, onBack }: RewardsScreenProps) {
  const notify = useToast();
  const [pending, setPending] = useState<Reward | null>(null);
  const balance = pointsBalance(data, child.id);
  const history = recentRedemptions(data, child.id);
  const rewards = [...data.rewards].sort((a, b) => a.cost - b.cost);

  const [redeeming, setRedeeming] = useState(false);

  const confirmRedeem = async () => {
    if (!pending || redeeming) return;
    const reward = pending;
    setRedeeming(true);
    const result = await actions.redeemReward(child.id, reward.id);
    setRedeeming(false);
    setPending(null);
    if (result.ok) {
      notify(`${child.name} redeemed “${reward.name}”! ${reward.cost} points used. Show a grown-up!`);
    } else {
      notify(result.error, 'error');
    }
  };

  return (
    <main className={`screen rewards accent-${child.color}`}>
      <header className="topbar">
        <button type="button" className="button button-ghost" onClick={onBack}>
          <span aria-hidden="true">←</span> Back to chores
        </button>
      </header>

      <section className="chart-hero">
        <Avatar child={child} size="lg" />
        <div className="chart-hero-text">
          <ScreenTitle>{child.name}’s rewards</ScreenTitle>
          <p className="chart-summary">Spend your points on something fun.</p>
        </div>
        <div className="chart-points" aria-label={`${balance} points to spend`}>
          <span className="chart-points-value">⭐ {balance}</span>
          <span className="chart-points-label">points to spend</span>
        </div>
      </section>

      {rewards.length === 0 ? (
        <div className="empty-card">
          <p className="empty-emoji" aria-hidden="true">
            🎁
          </p>
          <p>No rewards yet. A grown-up can add some in the Parent area.</p>
        </div>
      ) : (
        <ul className="reward-grid">
          {rewards.map((reward) => {
            const affordable = balance >= reward.cost;
            return (
              <li key={reward.id} className={`reward-card ${affordable ? 'reward-affordable' : 'reward-locked'}`}>
                <span className="reward-icon" aria-hidden="true">
                  {reward.icon}
                </span>
                <h2 className="reward-name">{reward.name}</h2>
                {reward.description && <p className="reward-description">{reward.description}</p>}
                <p className="reward-cost">⭐ {reward.cost} points</p>
                {affordable ? (
                  <button type="button" className="button button-primary button-block" onClick={() => setPending(reward)}>
                    Redeem
                  </button>
                ) : (
                  <p className="reward-need">
                    <span aria-hidden="true">🔒</span> Need {reward.cost - balance} more points
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <section className="history" aria-labelledby="history-title">
        <h2 id="history-title" className="section-subtitle">
          Recently redeemed
        </h2>
        {history.length === 0 ? (
          <p className="muted">Nothing redeemed yet.</p>
        ) : (
          <ul className="history-list">
            {history.map((r) => (
              <li key={r.id}>
                <span>{r.rewardName}</span>
                <span className="muted">
                  {parseDateKey(r.date) ? shortDate.format(parseDateKey(r.date)!) : r.date} · −{r.cost} points
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {pending && (
        <ConfirmDialog
          title={`Redeem ${pending.name}?`}
          confirmLabel={`Yes, use ${pending.cost} points`}
          cancelLabel="Not now"
          onConfirm={confirmRedeem}
          onCancel={() => setPending(null)}
        >
          <p className="confirm-emoji" aria-hidden="true">
            {pending.icon}
          </p>
          <p>
            This will use <strong>{pending.cost}</strong> of {child.name}’s <strong>{balance}</strong> points. You’ll
            have <strong>{balance - pending.cost}</strong> left.
          </p>
        </ConfirmDialog>
      )}
    </main>
  );
}
