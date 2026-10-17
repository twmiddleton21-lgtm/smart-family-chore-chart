import { useState, type FormEvent } from 'react';
import type { DataSource } from '../../config';
import type { FamilyData } from '../../types';
import { isEmptyFamily } from '../../lib/family';
import { validateFamilyName, validatePin, LIMITS } from '../../lib/validation';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { TextField } from '../../components/Field';
import { recordKey } from '../../state/apiCommands';
import type { FamilyActions } from '../../state/storeTypes';
import { useToast } from '../../state/toast';
import { FamilyDataCard } from './FamilyDataCard';

interface PanelProps {
  data: FamilyData;
  actions: FamilyActions;
  mode: DataSource;
}

export function SettingsPanel({ data, actions, mode }: PanelProps) {
  const notify = useToast();
  const [familyName, setFamilyName] = useState(data.settings.familyName);
  // Version of the settings when this panel opened (server mode conflict check).
  const [settingsVersion, setSettingsVersion] = useState(() => actions.versionOf(recordKey.settings()));
  const [nameError, setNameError] = useState<string>();
  const [pin, setPin] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [pinError, setPinError] = useState<string>();
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmDemo, setConfirmDemo] = useState(false);

  const saveName = async (event: FormEvent) => {
    event.preventDefault();
    const result = validateFamilyName(familyName);
    if (!result.ok) {
      setNameError(result.errors.familyName);
      return;
    }
    setNameError(undefined);
    const saved = await actions.updateFamilyName(result.value, settingsVersion);
    if (!saved.ok) {
      notify(saved.error, 'error');
      if (saved.kind === 'conflict') {
        // Show the newer name and allow another try against it.
        setSettingsVersion(actions.versionOf(recordKey.settings()));
      }
      return;
    }
    setSettingsVersion(actions.versionOf(recordKey.settings()));
    setFamilyName(result.value);
    notify('Family name saved.');
  };

  const savePin = async (event: FormEvent) => {
    event.preventDefault();
    const error = validatePin(pin) ?? (pin !== pinConfirm ? 'The two PINs don’t match.' : null);
    if (error) {
      setPinError(error);
      return;
    }
    const saved = await actions.updatePin(pin);
    if (!saved.ok) {
      setPinError(saved.error);
      return;
    }
    setPinError(undefined);
    setPin('');
    setPinConfirm('');
    notify('Parent PIN changed.');
  };

  return (
    <div className="panel settings-grid">
      <form className="settings-card form" onSubmit={(e) => void saveName(e)} noValidate>
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

      {mode === 'local' ? (
        <form className="settings-card form" onSubmit={(e) => void savePin(e)} noValidate>
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
      ) : (
        <section className="settings-card settings-danger">
          <h2 className="section-subtitle">Parent sign-in</h2>
          <p>
            <strong>Not available yet.</strong> This development build of the shared family server has no parent accounts
            or device pairing, so anyone using this computer can change family data.
          </p>
          <p className="muted">Sign-in arrives in a later version. Don’t use this build for real family data.</p>
        </section>
      )}

      <FamilyDataCard actions={actions} mode={mode} />

      <section className="settings-card">
        <h2 className="section-subtitle">Privacy &amp; storage</h2>
        {mode === 'local' ? (
          <ul className="plain-list">
            <li>Everything is saved in this browser on this device only.</li>
            <li>Nothing is sent to the internet. There are no accounts, ads or tracking.</li>
            <li>Other devices or browsers will not see these chores.</li>
            <li>Clearing your browser data will erase the chart.</li>
          </ul>
        ) : (
          <ul className="plain-list">
            <li>Family data is stored on your own family server, not in this browser.</li>
            <li>No accounts with outside companies, ads or tracking.</li>
            <li>Other devices using the same server see the same family data after they reload.</li>
            <li>The server keeps backups when data is imported; regular backups are set up by whoever runs the server.</li>
          </ul>
        )}
      </section>

      {mode === 'local' ? (
        <section className="settings-card settings-danger">
          <h2 className="section-subtitle">Reset demo data</h2>
          <p>Replace all profiles, chores, rewards, points and history with the sample family. This can’t be undone.</p>
          <button type="button" className="button button-danger" onClick={() => setConfirmReset(true)}>
            Reset to sample data
          </button>
        </section>
      ) : (
        <section className="settings-card">
          <h2 className="section-subtitle">Demo family</h2>
          {isEmptyFamily(data) ? (
            <>
              <p>The server has no family data yet. You can load a fictional demo family to try the app.</p>
              <button type="button" className="button button-secondary" onClick={() => setConfirmDemo(true)}>
                Load demo family
              </button>
            </>
          ) : (
            <p className="muted">The demo family can only be loaded into an empty household.</p>
          )}
        </section>
      )}

      {confirmReset && (
        <ConfirmDialog
          title="Reset everything?"
          tone="danger"
          confirmLabel="Yes, reset everything"
          onCancel={() => setConfirmReset(false)}
          onConfirm={async () => {
            const r = await actions.resetDemoData();
            setConfirmReset(false);
            if (!r.ok) {
              notify(r.error, 'error');
              return;
            }
            setFamilyName('The Rivera Family');
            notify('Demo data restored. The PIN is back to 1234.', 'info');
          }}
        >
          <p>All current profiles, chores, rewards, points and history will be replaced with the sample family.</p>
        </ConfirmDialog>
      )}

      {confirmDemo && (
        <ConfirmDialog
          title="Load the demo family?"
          confirmLabel="Load demo family"
          onCancel={() => setConfirmDemo(false)}
          onConfirm={async () => {
            const r = await actions.loadDemoFamily();
            setConfirmDemo(false);
            if (!r.ok) {
              notify(r.error, 'error');
              return;
            }
            setFamilyName('The Rivera Family');
            setSettingsVersion(actions.versionOf(recordKey.settings()));
            notify('Demo family loaded.', 'info');
          }}
        >
          <p>This adds a fictional sample family (Maya, Leo and Ivy) with chores, rewards and meals.</p>
        </ConfirmDialog>
      )}
    </div>
  );
}
