import { useState } from 'react';
import { useFamilyStore } from './state/useFamilyStore';
import type { FamilyStore } from './state/storeTypes';
import { ToastProvider } from './state/toast';
import { Dashboard } from './screens/Dashboard';
import { ChildChart } from './screens/ChildChart';
import { RewardsScreen } from './screens/RewardsScreen';
import { ParentGate } from './screens/ParentGate';
import { DevParentNotice } from './screens/DevParentNotice';
import { ParentArea, type ParentTab } from './screens/parent/ParentArea';
import { MealReminderDialog } from './components/MealReminderDialog';
import { DevBuildBanner, ServerStatusScreen } from './components/ServerStatus';
import { mealReminders, shouldShowMealReminder } from './lib/meals';
import type { FamilyData } from './types';

type Screen =
  | { name: 'dashboard' }
  | { name: 'child'; childId: string }
  | { name: 'rewards'; childId: string }
  | { name: 'parent' };

export function App() {
  return (
    <ToastProvider>
      <AppShell />
    </ToastProvider>
  );
}

function AppShell() {
  const store = useFamilyStore();
  if (!store.data) {
    return (
      <div className="app">
        {store.mode === 'api' && <DevBuildBanner />}
        <ServerStatusScreen store={store} />
      </div>
    );
  }
  return <AppContent store={store} data={store.data} />;
}

function AppContent({ store, data }: { store: FamilyStore; data: FamilyData }) {
  const { actions, today } = store;
  const [screen, setScreen] = useState<Screen>({ name: 'dashboard' });
  const [gateOpen, setGateOpen] = useState(false);
  const [loadNotice, setLoadNotice] = useState(store.loadNotice);
  const [parentTab, setParentTab] = useState<ParentTab>('chores');
  // "Plan meals now" hides the reminder for this visit; "Remind me tomorrow" persists.
  const [reminderHidden, setReminderHidden] = useState(false);

  const goHome = () => setScreen({ name: 'dashboard' });

  // If the selected child disappears (e.g. removed on another device), fall back home.
  const selectedChild =
    screen.name === 'child' || screen.name === 'rewards' ? data.children.find((c) => c.id === screen.childId) : undefined;
  const effective: Screen = (screen.name === 'child' || screen.name === 'rewards') && !selectedChild ? { name: 'dashboard' } : screen;

  const openParent = () => {
    setGateOpen(false);
    setScreen({ name: 'parent' });
  };

  return (
    <div className="app">
      {store.mode === 'api' && <DevBuildBanner />}
      {store.saveFailed && (
        <div className="banner banner-warning" role="alert">
          ⚠️ This browser is not letting the app save. Changes will be lost when the page is closed. Check that site
          storage is allowed and the browser is not in private mode.
        </div>
      )}
      {store.connectionLost && (
        <div className="banner banner-warning" role="alert">
          <span>📡 Can’t reach the family server. You’re seeing the last loaded data; changes can’t be saved right now.</span>
          <button type="button" className="button button-ghost" onClick={() => void actions.refresh()}>
            Try again
          </button>
        </div>
      )}
      {loadNotice && (
        <div className="banner banner-info" role="status">
          <span>ℹ️ {loadNotice}</span>
          <button type="button" className="button button-ghost" onClick={() => setLoadNotice(null)}>
            OK
          </button>
        </div>
      )}

      {effective.name === 'dashboard' && (
        <Dashboard
          data={data}
          today={today}
          onSelectChild={(child) => setScreen({ name: 'child', childId: child.id })}
          onOpenParent={() => {
            setParentTab('chores');
            setGateOpen(true);
          }}
        />
      )}
      {effective.name === 'child' && selectedChild && (
        <ChildChart
          key={selectedChild.id}
          data={data}
          child={selectedChild}
          today={today}
          actions={actions}
          onBack={goHome}
          onOpenRewards={() => setScreen({ name: 'rewards', childId: selectedChild.id })}
        />
      )}
      {effective.name === 'rewards' && selectedChild && (
        <RewardsScreen
          key={selectedChild.id}
          data={data}
          child={selectedChild}
          actions={actions}
          onBack={() => setScreen({ name: 'child', childId: selectedChild.id })}
        />
      )}
      {effective.name === 'parent' && (
        <ParentArea data={data} actions={actions} mode={store.mode} today={today} initialTab={parentTab} onExit={goHome} />
      )}

      {effective.name === 'dashboard' && !gateOpen && !reminderHidden && shouldShowMealReminder(data, today) && (
        <MealReminderDialog
          reminders={mealReminders(data, today)}
          today={today}
          onLater={() => void actions.dismissMealReminder()}
          onPlanNow={() => {
            setReminderHidden(true);
            setParentTab('meals');
            setGateOpen(true);
          }}
        />
      )}

      {gateOpen &&
        (store.mode === 'api' ? (
          <DevParentNotice onCancel={() => setGateOpen(false)} onContinue={openParent} />
        ) : (
          <ParentGate pin={data.settings.parentPin} onCancel={() => setGateOpen(false)} onUnlock={openParent} />
        ))}
    </div>
  );
}
