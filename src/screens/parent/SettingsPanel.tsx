import { useState, type FormEvent } from 'react';
import type { FamilyData } from '../../types';
import { validateFamilyName, validatePin, LIMITS } from '../../lib/validation';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { TextField } from '../../components/Field';
import type { FamilyActions } from '../../state/useFamilyStore';
import { useToast } from '../../state/toast';

interface PanelProps {
  data: FamilyData;
  actions: FamilyActions;
}

export function SettingsPanel({ data, actions }: PanelProps) {
  const notify = useToast();
  const [familyName, setFamilyName] = useState(data.settings.familyName);
  const [nameError, setNameError] = useState<string>();
  const [pin, setPin] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [pinError, setPinError] = useState<string>();
  const [confirmReset, setConfirmReset] = useState(false);

  const saveName = (event: FormEvent) => {
    event.preventDefault();
    const result = validateFamilyName(familyName);
    if (!result.ok) {
      setNameError(result.errors.familyName);
      return;
    }
    setNameError(undefined);
    actions.updateSettings({ familyName: result.value });
    setFamilyName(result.value);
    notify('Family name saved.');
  };

  const savePin = (event: FormEvent) => {
    event.preventDefault();
    const error = validatePin(pin) ?? (pin !== pinConfirm ? 'The two PINs don’t match.' : null);
    if (error) {
      setPinError(error);
      return;
    }
    setPinError(undefined);
    actions.updateSettings({ parentPin: pin });
    setPin('');
    setPinConfirm('');
    notify('Parent PIN changed.');
  };

  return (
    <div className="panel settings-grid">
      <form className="settings-card form" onSubmit={saveName} noValidate>
        <h2 className="section-subtitle">Family name</h2>
        <TextField
          id="family-name"
          label="Shown on the home screen"
          value={familyName}
          onChange={setFamilyName}
          error={nameError}
          maxLength={LIMITS.familyNameMax + 10}
          autoComplete="off"
        />
        <button type="submit" className="button button-primary">
          Save name
        </button>
      </form>

      <form className="settings-card form" onSubmit={savePin} noValidate>
        <h2 className="section-subtitle">Parent PIN</h2>
        <TextField
          id="new-pin"
          label="New PIN (4–8 digits)"
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          value={pin}
          onChange={(v) => setPin(v.replace(/\D/g, '').slice(0, 8))}
        />
        <TextField
          id="confirm-pin"
          label="Type it again"
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          value={pinConfirm}
          onChange={(v) => setPinConfirm(v.replace(/\D/g, '').slice(0, 8))}
          error={pinError}
        />
        <p className="field-hint">
          The PIN keeps little hands out of this area. It is stored in this browser and is <strong>not</strong> strong
          security.
        </p>
        <button type="submit" className="button button-primary">
          Change PIN
        </button>
      </form>

      <section className="settings-card">
        <h2 className="section-subtitle">Privacy &amp; storage</h2>
        <ul className="plain-list">
          <li>Everything is saved in this browser on this device only.</li>
          <li>Nothing is sent to the internet. There are no accounts, ads or tracking.</li>
          <li>Other devices or browsers will not see these chores.</li>
          <li>Clearing your browser data will erase the chart.</li>
        </ul>
      </section>

      <section className="settings-card settings-danger">
        <h2 className="section-subtitle">Reset demo data</h2>
        <p>Replace all profiles, chores, rewards, points and history with the sample family. This can’t be undone.</p>
        <button type="button" className="button button-danger" onClick={() => setConfirmReset(true)}>
          Reset to sample data
        </button>
      </section>

      {confirmReset && (
        <ConfirmDialog
          title="Reset everything?"
          tone="danger"
          confirmLabel="Yes, reset everything"
          onCancel={() => setConfirmReset(false)}
          onConfirm={() => {
            actions.resetDemoData();
            setConfirmReset(false);
            setFamilyName('The Rivera Family');
            notify('Demo data restored. The PIN is back to 1234.', 'info');
          }}
        >
          <p>All current profiles, chores, rewards, points and history will be replaced with the sample family.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
