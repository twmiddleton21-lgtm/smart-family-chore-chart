import { Modal } from '../components/Modal';

interface DevParentNoticeProps {
  onContinue: () => void;
  onCancel: () => void;
}

/**
 * Server DEVELOPMENT MODE only: there is no parent sign-in in this mode, so
 * instead of a PIN that would only look like protection, say so plainly.
 */
export function DevParentNotice({ onContinue, onCancel }: DevParentNoticeProps) {
  return (
    <Modal title="Parent area (development mode)" onClose={onCancel} size="sm">
      <div className="confirm-body">
        <p className="confirm-emoji" aria-hidden="true">
          🧪
        </p>
        <p>
          The family server is running in development mode, which has <strong>no parent sign-in</strong>. Anyone using
          this computer can change family data here.
        </p>
        <p className="muted">Start the server normally to use parent accounts and device pairing. Don’t use development mode for real family data.</p>
      </div>
      <div className="button-row">
        <button type="button" className="button button-secondary" onClick={onCancel} data-autofocus>
          Cancel
        </button>
        <button type="button" className="button button-primary" onClick={onContinue}>
          Continue to parent area
        </button>
      </div>
    </Modal>
  );
}
