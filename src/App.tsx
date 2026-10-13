import { useState } from 'react';
import { useFamilyStore } from './state/useFamilyStore';
import { useToday } from './state/time';
import { ToastProvider } from './state/toast';
import { Dashboard } from './screens/Dashboard';
import { ChildChart } from './screens/ChildChart';
import { RewardsScreen } from './screens/RewardsScreen';
import { ParentGate } from './screens/ParentGate';
import { ParentArea, type ParentTab } from './screens/parent/ParentArea';
import { MealReminderDialog } from './components/MealReminderDialog';
import { mealReminders, shouldShowMealReminder } from './lib/meals';

type Screen =
  | { name: 'dashboard' }
  | { name: 'child'; childId: string }
  | { name: 'rewards'; childId: string }
  | { name: 'parent' };

const LOAD_MESSAGES: Partial<Record<string, string>> = {
  recovered:
    'Saved data could not be read, so the sample family has been loaded. A copy of the old data was kept in browser storage.',
  repaired: 'Some saved items were damaged and have been skipped. Everything else loaded normally.',
};

export function App() {
  return (
    <ToastProvider>
      <AppContent />
    </ToastProvider>
  );
}

function AppContent() {
  const { data, actions, loadStatus, saveFailed } = useFamilyStore();
  const today = useToday();
  const [screen, setScreen] = useState<Screen>({ name: 'dashboard' });
  const [gateOpen, setGateOpen] = useState(false);
  const [loadNotice, setLoadNotice] = useState(LOAD_MESSAGES[loadStatus]);
  const [parentTab, setParentTab] = useState<ParentTab>('chores');
  // "Plan meals now" hides the reminder for this visit; "Remind me tomorrow" persists.
  const [reminderHidden, setReminderHidden] = useState(false);

  const goHome = () => setScreen({ name: 'dashboard' });

  // If the selected child disappears (e.g. data reset in another tab), fall back home.
  const selectedChild =
    screen.name === 'child' || screen.name === 'rewards' ? data.children.find((c) => c.id === screen.childId) : undefined;
  const effective: Screen = (screen.name === 'child' || screen.name === 'rewards') && !selectedChild ? { name: 'dashboard' } : screen;

  return (
    <div className="app">
      {saveFailed && (
        <div className="banner banner-warning" role="alert">
          ⚠️ This browser is not letting the app save. Changes will be lost when the page is closed. Check that site
          storage is allowed and the browser is not in private mode.
        </div>
      )}
      {loadNotice && (
        <div className="banner banner-info" role="status">
          <span>ℹ️ {loadNotice}</span>
          <button type="button" className="button button-ghost" onClick={() => setLoadNotice(undefined)}>
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
          today={today}
          actions={actions}
          onBack={() => setScreen({ name: 'child', childId: selectedChild.id })}
        />
      )}
      {effective.name === 'parent' && (
        <ParentArea data={data} actions={actions} today={today} initialTab={parentTab} onExit={goHome} />
      )}

      {effective.name === 'dashboard' && !gateOpen && !reminderHidden && shouldShowMealReminder(data, today) && (
        <MealReminderDialog
          reminders={mealReminders(data, today)}
          today={today}
          onLater={() => actions.dismissMealReminder(today)}
          onPlanNow={() => {
            setReminderHidden(true);
            setParentTab('meals');
            setGateOpen(true);
          }}
        />
      )}

      {gateOpen && (
        <ParentGate
          pin={data.settings.parentPin}
          onCancel={() => setGateOpen(false)}
          onUnlock={() => {
            setGateOpen(false);
            setScreen({ name: 'parent' });
          }}
        />
      )}
    </div>
  );
}
