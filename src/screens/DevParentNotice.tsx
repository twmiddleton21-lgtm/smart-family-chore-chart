import { Modal } from '../components/Modal';

interface DevParentNoticeProps {
  onContinue: () => void;
  onCancel: () => void;
}

/**
 * Server development build only: there is NO parent sign-in yet, so instead
 * of a PIN that would only look like protection, say so plainly.
 */
export function DevParentNotice({ onContinue, onCancel }: DevParentNoticeProps) {
  return (
    <Modal title="Parent area (development build)" onClose={onCancel} size="sm">
      <div className="confirm-body">
        <p className="confirm-emoji" aria-hidden="true">
          🧪
        </p>
        <p>
          This development build has <strong>no parent sign-in yet</strong>. Anyone using this computer can change family
          data here.
        </p>
        <p className="muted">Parent accounts and device pairing arrive in a later version. Don’t use this build for real family data.</p>
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
