import { useCallback, useEffect, useState } from 'react';
import type { ImportPreview } from '../../api/client';
import { Modal } from '../../components/Modal';
import type { FamilyActions } from '../../state/storeTypes';

export type ImportSource = { kind: 'file'; name: string } | { kind: 'browser' };

interface ImportDialogProps {
  actions: FamilyActions;
  source: ImportSource;
  data: unknown;
  onClose: () => void;
  onImported: (result: { backup: string }) => void;
}

type Step =
  | { name: 'previewing' }
  | { name: 'preview'; preview: ImportPreview }
  | { name: 'applying'; preview: ImportPreview }
  | { name: 'error'; message: string; canRetryPreview: boolean };

/**
 * Deliberate, two-step import: the server validates the data and shows what
 * it contains (nothing is changed), then the parent confirms. Replacing a
 * server that already has data needs an extra explicit confirmation, and the
 * server keeps a backup of what it replaces.
 */
export function ImportDialog({ actions, source, data, onClose, onImported }: ImportDialogProps) {
  const [step, setStep] = useState<Step>({ name: 'previewing' });
  const [confirmReplace, setConfirmReplace] = useState(false);

  const runPreview = useCallback(async () => {
    setStep({ name: 'previewing' });
    setConfirmReplace(false);
    const r = await actions.previewImport(data);
    if (r.ok) setStep({ name: 'preview', preview: r.preview });
    else setStep({ name: 'error', message: r.error, canRetryPreview: r.kind === 'unreachable' || r.kind === 'server' });
  }, [actions, data]);

  useEffect(() => {
    void runPreview();
  }, [runPreview]);

  const apply = async (preview: ImportPreview) => {
    const replace = !preview.server.empty;
    if (replace && !confirmReplace) return;
    setStep({ name: 'applying', preview });
    const r = await actions.applyImport(data, preview, replace);
    if (r.ok) {
      onImported({ backup: r.backup });
      return;
    }
    setStep({ name: 'error', message: r.error, canRetryPreview: true });
  };

  const sourceLabel = source.kind === 'file' ? `the file “${source.name}”` : 'this browser’s saved data';

  return (
    <Modal title="Import family data" onClose={onClose} size="md">
      {step.name === 'previewing' && <p role="status">Checking {sourceLabel}…</p>}

      {step.name === 'error' && (
        <div className="confirm-body">
          <div className="error-summary" role="alert">
            <p>
              <strong>Nothing was imported.</strong>
            </p>
            <p>{step.message}</p>
          </div>
          <div className="button-row">
            <button type="button" className="button button-secondary" onClick={onClose} data-autofocus>
              Close
            </button>
            {step.canRetryPreview && (
              <button type="button" className="button button-primary" onClick={() => void runPreview()}>
                Check again
              </button>
            )}
          </div>
        </div>
      )}

      {(step.name === 'preview' || step.name === 'applying') && (
        <ImportPreviewView
          preview={step.preview}
          sourceLabel={sourceLabel}
          busy={step.name === 'applying'}
          confirmReplace={confirmReplace}
          onConfirmReplace={setConfirmReplace}
          onCancel={onClose}
          onImport={() => void apply(step.preview)}
        />
      )}
    </Modal>
  );
}

interface PreviewViewProps {
  preview: ImportPreview;
  sourceLabel: string;
  busy: boolean;
  confirmReplace: boolean;
  onConfirmReplace: (v: boolean) => void;
  onCancel: () => void;
  onImport: () => void;
}

function ImportPreviewView({ preview, sourceLabel, busy, confirmReplace, onConfirmReplace, onCancel, onImport }: PreviewViewProps) {
  const { summary, server } = preview;
  const c = summary.counts;
  const replace = !server.empty;
  return (
    <div className="confirm-body import-preview">
      <p>
        Here’s what {sourceLabel} contains. <strong>Nothing has been changed yet.</strong>
      </p>
      <dl className="import-summary">
        <div>
          <dt>Family name</dt>
          <dd>{summary.familyName}</dd>
        </div>
        <div>
          <dt>Children</dt>
          <dd>
            {summary.children.length === 0
              ? 'None'
              : summary.children.map((ch) => `${ch.name} (⭐ ${ch.points})`).join(', ')}
          </dd>
        </div>
        <div>
          <dt>Chores and rewards</dt>
          <dd>
            {c.chores} chores, {c.rewards} rewards
          </dd>
        </div>
        <div>
          <dt>History</dt>
          <dd>
            {c.completions} completed chores, {c.redemptions} redeemed rewards
          </dd>
        </div>
        <div>
          <dt>School meals</dt>
          <dd>
            {c.meals} planned days; {c.mainMeals} main meals and {c.puddings} puddings in the food lists
          </dd>
        </div>
      </dl>
      {summary.upgraded && <p className="muted">This data is from an older version and will be upgraded automatically.</p>}
      {summary.pinIgnored && (
        <p className="muted">The old parent PIN in this data is ignored. It isn’t used for sign-in with the family server.</p>
      )}

      {replace ? (
        <div className="danger-box" role="alert">
          <p>
            <strong>This server already has family data.</strong> Importing will <strong>replace all of it</strong>: children,
            chores, points, rewards and meals. The server saves a backup of the current data first.
          </p>
          <label className="check-row">
            <input type="checkbox" checked={confirmReplace} onChange={(e) => onConfirmReplace(e.target.checked)} />
            <span>Yes, replace all family data on this server</span>
          </label>
        </div>
      ) : (
        <p>The server has no family data yet, so this will become your family’s data. A backup is saved first.</p>
      )}

      <div className="button-row">
        <button type="button" className="button button-secondary" onClick={onCancel} disabled={busy} data-autofocus>
          Cancel
        </button>
        <button
          type="button"
          className={`button ${replace ? 'button-danger' : 'button-primary'}`}
          onClick={onImport}
          disabled={busy || (replace && !confirmReplace)}
        >
          {busy ? 'Importing…' : replace ? 'Replace server data' : 'Import'}
        </button>
      </div>
    </div>
  );
}
