'use client';

import clsx from 'clsx';
import { forwardRef, type HTMLAttributes } from 'react';

import { Toast, type ToastItem } from './Toast';

/**
 * The toast viewport. DESIGN.md §6.14.
 *
 * THREE THINGS THIS FILE EXISTS TO GET RIGHT
 *
 * 1. The live region is always mounted, even with nothing to show. A
 *    `role="status"` container that is inserted into the DOM at the same moment
 *    it gains content is announced unreliably (NVDA and VoiceOver both want the
 *    region to have been registered beforehand). An empty, zero-height,
 *    pointer-transparent fixed div costs nothing and makes announcements
 *    dependable.
 *
 * 2. It queues, it does not stack. Beyond `maxVisible` the surplus toasts are
 *    not rendered at all, so a burst — five results locked in ten seconds while
 *    the write queue drains — cannot bury the screen or push the earliest toast
 *    off the top before it has been read. A queued toast's timer starts when it
 *    becomes visible, not when it was enqueued, so nothing expires unseen.
 *
 * 3. It never takes focus and it holds no state. The store lives in the app
 *    layer; `components/ui` takes props (ARCHITECTURE.md §4 rule 3).
 */

export interface ToastHostProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'role'> {
  /** Oldest first. The host renders the first `maxVisible` and holds the rest. */
  toasts: readonly ToastItem[];
  onDismiss: (id: string) => void;
  /** DESIGN.md §6.14: max 3 stacked. */
  maxVisible?: number;
  dismissLabel?: string;
}

export const ToastHost = forwardRef<HTMLDivElement, ToastHostProps>(function ToastHost(
  { toasts, onDismiss, maxVisible = 3, dismissLabel, className, ...rest },
  ref,
) {
  const visible = toasts.slice(0, Math.max(1, maxVisible));

  return (
    <div
      ref={ref}
      role="status"
      aria-live="polite"
      // Each toast is a self-contained sentence, so announcing only the added
      // node is right; `aria-atomic` would re-read every toast on screen each
      // time one arrives.
      aria-atomic="false"
      aria-relevant="additions"
      // A toast is a transient acknowledgement of an action taken on screen. On
      // the printed pack (OPERATIONS.md §12 / DESIGN.md §11) it is noise.
      data-print="hide"
      className={clsx(
        // z-[60] clears the sheet (z-50) so a toast raised by a sheet's own
        // action is still visible over it.
        'pointer-events-none fixed left-1/2 z-[60] flex w-[calc(100%-32px)] max-w-sheet -translate-x-1/2 flex-col gap-2',
        // Clears the mobile bottom tab bar, and its safe-area inset with it.
        'bottom-[calc(theme(spacing.bottombar)+12px)] md:bottom-6',
        className,
      )}
      {...rest}
    >
      {visible.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={onDismiss} dismissLabel={dismissLabel} />
      ))}
    </div>
  );
});
