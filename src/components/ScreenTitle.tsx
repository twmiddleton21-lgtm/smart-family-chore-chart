import { useEffect, useRef, type ReactNode } from 'react';

/**
 * The screen's main heading. It takes focus when the screen opens, so
 * keyboard and screen-reader users land at the top of the new screen.
 */
export function ScreenTitle({ children, className = '' }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, []);
  return (
    <h1 ref={ref} tabIndex={-1} className={`screen-title ${className}`}>
      {children}
    </h1>
  );
}
