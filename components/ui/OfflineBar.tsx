'use client';

import clsx from 'clsx';
import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';

import { CloudOffIcon } from './icons';

/**
 * DESIGN.md §6.19, IA.md §7.3.
 *
 * Patchy 4G at a venue is the normal condition, not the edge case, so the bar's
 * job is to make "what you are looking at is not live" impossible to miss while
 * staying out of the way of the thing the user came for. Hence a 36px strip
 * directly under the header in `--surface-2`, not a modal and not a toast: it
 * blocks nothing, it dismisses nothing, and it stays until the network returns.
 *
 * `offline` is decided by the caller (`components/data/useOffline`), never by
 * `navigator.onLine` alone — on Android that API reports "online" for a radio
 * that is associated with a tower and passing zero packets, which is why IA.md
 * §7.3 defines the real signal as the `offline` event OR two consecutive fetch
 * failures.
 *
 * The `role="status"` wrapper is mounted unconditionally, empty, so the live
 * region is registered with the screen reader before it ever has content —
 * regions that appear and gain text in the same frame are announced
 * unreliably. When online the wrapper has no box and costs one empty div.
 */

export interface OfflineBarProps extends Omit<HTMLAttributes<HTMLDivElement>, 'role' | 'children'> {
  offline: boolean;
  /**
   * When the visible data was fetched, already formatted in IST by
   * `lib/format/datetime`, e.g. `7:41 PM IST`. Omit and the bar drops the
   * "showing data from …" clause.
   */
  asOfLabel?: string;
  /** Replaces the whole sentence when a view needs different wording. */
  message?: ReactNode;
  onRetry?: () => void;
  retrying?: boolean;
  retryLabel?: string;
}

export const OfflineBar = forwardRef<HTMLDivElement, OfflineBarProps>(function OfflineBar(
  {
    offline,
    asOfLabel,
    message,
    onRetry,
    retrying = false,
    retryLabel = 'Retry',
    className,
    ...rest
  },
  ref,
) {
  return (
    <div
      ref={ref}
      role="status"
      aria-live="polite"
      // Paper is offline by definition; the bar says nothing there.
      data-print="hide"
      className={className}
      {...rest}
    >
      {offline ? (
        <div className="flex h-9 w-full items-center gap-2 border-b border-line bg-surface-2 px-4 text-sm text-fg-muted">
          <CloudOffIcon width={16} height={16} className="h-4 w-4 shrink-0" />

          <span className="min-w-0 flex-1 truncate">
            {message ?? (asOfLabel ? `Offline — showing data from ${asOfLabel}` : 'Offline')}
          </span>

          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              disabled={retrying}
              aria-busy={retrying || undefined}
              className="nc-focus nc-hit -my-1 inline-flex shrink-0 items-center px-1 text-sm font-bold text-info underline underline-offset-2 transition-colors duration-1 ease-out hover:text-fg disabled:pointer-events-none disabled:opacity-50"
            >
              {retrying ? 'Retrying…' : retryLabel}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
