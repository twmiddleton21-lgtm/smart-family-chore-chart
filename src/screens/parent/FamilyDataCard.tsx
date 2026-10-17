import { useRef, useState, type ChangeEvent } from 'react';
import type { DataSource } from '../../config';
import { toDateKey } from '../../lib/dates';
import { exportFileName } from '../../lib/exportFile';
import { getBrowserStorage, readBrowserFamilyData, readMigrationMarker, writeMigrationMarker } from '../../lib/storage';
import type { FamilyActions } from '../../state/storeTypes';
import { useToast } from '../../state/toast';
import { ImportDialog, type ImportSource } from './ImportDialog';

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

interface FamilyDataCardProps {
  actions: FamilyActions;
  mode: DataSource;
}

/** Export (both modes) and deliberate import (family-server mode only). */
export function FamilyDataCard({ actions, mode }: FamilyDataCardProps) {
  const notify = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState<{ source: ImportSource; data: unknown } | null>(null);
  const storage = getBrowserStorage();
  // Only offer "import from this browser" if this address holds old data.
  const browserData = mode === 'api' ? readBrowserFamilyData(storage) : null;
  const [marker, setMarker] = useState(() => readMigrationMarker(storage));

  const exportNow = async () => {
    const r = await actions.exportData();
    if (!r.ok) {
      notify(r.error, 'error');
      return;
    }
    const blob = new Blob([JSON.stringify(r.file, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFileName(toDateKey(new Date()));
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    notify('Family data exported. Keep the file somewhere safe: it contains your family’s chart.', 'info');
  };

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // allow choosing the same file again
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      notify('That file is too large to import (limit 5 MB).', 'error');
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(await file.text());
    } catch {
      notify('That file isn’t a valid family data file (it isn’t JSON).', 'error');
      return;
    }
    setImporting({ source: { kind: 'file', name: file.name }, data });
  };

  return (
    <section className="settings-card">
      <h2 className="section-subtitle">Family data</h2>
      <p>
        <strong>Export</strong> saves a copy of all family data to a file (the old parent PIN is never included).
      </p>
      <button type="button" className="button button-secondary" onClick={() => void exportNow()}>
        ⬇️ Export family data
      </button>

      {mode === 'api' ? (
        <>
          <p>
            <strong>Import</strong> replaces the family data on this server with data from an export file or from this
            browser. You’ll see a preview first, and nothing changes until you confirm.
          </p>
          <div className="button-row data-buttons">
            <button type="button" className="button button-secondary" onClick={() => fileInput.current?.click()}>
              📄 Import from a file…
            </button>
            {browserData !== null && (
              <button
                type="button"
                className="button button-secondary"
                onClick={() => setImporting({ source: { kind: 'browser' }, data: browserData })}
              >
                🌐 Import from this browser
              </button>
            )}
          </div>
          <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={(e) => void onFile(e)} data-testid="import-file" />
          {browserData !== null && marker && (
            <p className="muted">
              This browser’s data was imported on {new Date(marker.importedAt).toLocaleString()}. It is still kept in this
              browser.
            </p>
          )}
        </>
      ) : (
        <p className="muted">
          To move this chart to a shared family server later, export it here and import the file there.
        </p>
      )}

      {importing && (
        <ImportDialog
          actions={actions}
          source={importing.source}
          data={importing.data}
          onClose={() => setImporting(null)}
          onImported={({ backup }) => {
            if (importing.source.kind === 'browser') {
              const m = { importedAt: new Date().toISOString() };
              writeMigrationMarker(storage, m);
              setMarker(m);
            }
            setImporting(null);
            notify(`Family data imported. The server saved a backup of its previous data (${backup}).`);
          }}
        />
      )}
    </section>
  );
}
