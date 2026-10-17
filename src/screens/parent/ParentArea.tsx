import { useRef, useState, type KeyboardEvent } from 'react';
import type { DateKey, FamilyData } from '../../types';
import type { DataSource } from '../../config';
import { ScreenTitle } from '../../components/ScreenTitle';
import type { FamilyActions } from '../../state/useFamilyStore';
import { ChoresPanel } from './ChoresPanel';
import { ChildrenPanel } from './ChildrenPanel';
import { MealsPanel } from './MealsPanel';
import { RewardsPanel } from './RewardsPanel';
import { SettingsPanel } from './SettingsPanel';
import { AccessPanel } from './AccessPanel';
import type { Access } from '../../state/access';

export type ParentTab = 'chores' | 'children' | 'meals' | 'rewards' | 'settings' | 'access';
type Tab = ParentTab;

const ACCESS_TAB = { id: 'access' as const, label: 'Family access', icon: '🔑' };
const BASE_TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'chores', label: 'Chores', icon: '🧹' },
  { id: 'children', label: 'Children', icon: '👧' },
  { id: 'meals', label: 'School meals', icon: '🍽️' },
  { id: 'rewards', label: 'Rewards', icon: '🎁' },
  { id: 'settings', label: 'Settings', icon: '⚙️' },
];

interface ParentAreaProps {
  data: FamilyData;
  actions: FamilyActions;
  mode: DataSource;
  today: DateKey;
  initialTab?: ParentTab;
  /** Server build with sign-in: enables the Family access tab. */
  access?: Access | null;
  onExit: () => void;
  onSignOut?: () => void;
}

export function ParentArea({ data, actions, mode, today, initialTab = 'chores', access = null, onExit, onSignOut }: ParentAreaProps) {
  const TABS = access ? [...BASE_TABS, ACCESS_TAB] : BASE_TABS;
  const [tab, setTab] = useState<Tab>(initialTab);
  // On a parent's own (unpaired) device, leaving keeps them signed in; on a
  // shared family device, or with the browser PIN, leaving locks the area.
  const exitLabel = access && !access.status.device ? 'Done' : 'Done – lock & exit';
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({
    chores: null,
    children: null,
    meals: null,
    rewards: null,
    settings: null,
    access: null,
  });

  // Arrow-key navigation between tabs, per the WAI-ARIA tabs pattern.
  const onTabKey = (event: KeyboardEvent, index: number) => {
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    else return;
    event.preventDefault();
    const id = TABS[next]!.id;
    setTab(id);
    tabRefs.current[id]?.focus();
  };

  return (
    <main className="screen parent">
      <header className="topbar">
        <ScreenTitle className="parent-title">
          <span aria-hidden="true">🔓</span> Parent area
        </ScreenTitle>
        <button type="button" className="button button-primary" onClick={onExit}>
          {exitLabel}
        </button>
      </header>

      <div className="tabs" role="tablist" aria-label="Parent area sections">
        {TABS.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[t.id] = el;
            }}
            id={`tab-${t.id}`}
            type="button"
            role="tab"
            className="tab"
            aria-selected={tab === t.id}
            aria-controls={`panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            onKeyDown={(e) => onTabKey(e, i)}
          >
            <span aria-hidden="true">{t.icon}</span> {t.label}
          </button>
        ))}
      </div>

      <section id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`} className="tab-panel">
        {tab === 'chores' && <ChoresPanel data={data} actions={actions} />}
        {tab === 'children' && <ChildrenPanel data={data} actions={actions} />}
        {tab === 'meals' && <MealsPanel data={data} actions={actions} today={today} />}
        {tab === 'rewards' && <RewardsPanel data={data} actions={actions} />}
        {tab === 'settings' && <SettingsPanel data={data} actions={actions} mode={mode} />}
        {tab === 'access' && access && <AccessPanel access={access} onSignOut={() => onSignOut?.()} />}
      </section>
    </main>
  );
}
