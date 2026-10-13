import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}

/**
 * Accessible modal built on the native <dialog> element, which provides
 * focus trapping, the Escape key and a top-layer backdrop for free.
 * Mount it to open; unmount it to close.
 */
export function Modal({ title, onClose, children, size = 'md' }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useLayoutEffect(() => {
    const dialog = ref.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    if (dialog && !dialog.open) {
      dialog.showModal();
      // showModal() focuses the first focusable element (the close button),
      // overriding React's autoFocus. Honour an explicit data-autofocus instead.
      dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    }
    return () => {
      if (dialog?.open) dialog.close();
      // Return focus to whatever opened the dialog.
      previouslyFocused?.focus?.();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className={`modal modal-${size}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onCloseRef.current();
      }}
    >
      <div className="modal-header">
        <h2 id={titleId} className="modal-title">
          {title}
        </h2>
        <button type="button" className="icon-button" onClick={() => onCloseRef.current()} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="modal-body">{children}</div>
    </dialog>
  );
}
