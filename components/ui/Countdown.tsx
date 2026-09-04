'use client';

import clsx from 'clsx';
import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from 'react';

/**
 * DESIGN.md §6.19, IA.md Journey 3 ("Clock trust").
 *
 * THE CLOCK
 * ---------
 * A phone whose clock is six minutes fast turns "Check-in opens in 24:11" into a
 * lie, and the captain misses the window. So this component never reads the
 * device wall clock: it takes `nowSeconds` — already corrected by the caller
 * with the skew derived from `X-NC-Now` (API.md §0.10, `components/data/
 * useClockSkew`) — and ticks forward from it with `performance.now()`, a
 * monotonic source that cannot jump when Android resyncs NTP or the user changes
 * timezone mid-countdown. Re-supplying `nowSeconds` after a poll resyncs.
 *
 * `components/ui` never fetches (ARCHITECTURE.md §4 rule 3), which is why the
 * correction arrives as a prop rather than through a hook import.
 *
 * NEVER NEGATIVE. Remaining time is clamped at zero: a bracket that says
 * "-00:04" is a bug report from every viewer at once.
 *
 * ANNOUNCEMENTS
 * -------------
 * The visible element is `role="timer" aria-live="off"` — a per-second live
 * region is unusable, it talks over everything else on the page. A separate
 * visually-hidden `role="status"` fires at exactly 60s, 10s and 0 (DESIGN.md
 * §6.19). Mounting below a threshold does not retro-fire it.
 *
 * The §6.19 recipe's `text-3xl` is applied by the caller, not baked in: the same
 * countdown renders inside a `text-2xs` status pill ("Closes in 6h 12m",
 * IA.md §8.3) where a 3xl numeral would be wrong. Only `nums-tab` — mandatory on
 * every countdown so the digits do not shuffle each second — is unconditional.
 */

export type CountdownVariant = 'clock' | 'compact';

export interface CountdownProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'children'> {
  /** Unix seconds. Storage and wire units are integer seconds (ARCHITECTURE.md §6.6). */
  targetAt: number;
  /**
   * Server-corrected unix seconds at render time. Comes from the data layer's
   * clock-skew hook; the component ticks on from here monotonically.
   */
  nowSeconds: number;
  /**
   * `clock` → `24:11`, `1:02:33` (check-in, room-code reveal).
   * `compact` → `6h 12m`, `3d 4h` (registration close, a distant fixture).
   */
  variant?: CountdownVariant;
  /** Override the visible string entirely; receives whole seconds remaining, never negative. */
  format?: (secondsRemaining: number) => string;
  /**
   * Prefix for the announcement only, e.g. "Check-in opens in". Not rendered
   * visibly — the surrounding copy already says it.
   */
  announceLabel?: string;
  /** Override the announced sentence at 60s / 10s / 0. */
  announce?: (secondsRemaining: number) => string;
  /** Fires once, when the countdown reaches zero while mounted. */
  onComplete?: () => void;
  /** Rendered instead of `0:00` once elapsed. */
  completedContent?: ReactNode;
}

const ANNOUNCE_AT = [60, 10, 0] as const;

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** `24:11`, `1:02:33`. Hours are unpadded so the leading digit is not a lonely `0`. */
function formatClock(total: number): string {
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

/** `3d 4h`, `6h 12m`, `4m 30s`, `9s`. Two units, never more — precision nobody acts on is noise. */
function formatCompact(total: number): string {
  const days = Math.floor(total / 86400);
  const hours = Math.floor(total / 3600) % 24;
  const minutes = Math.floor(total / 60) % 60;
  const seconds = total % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`;
  return `${seconds}s`;
}

function defaultAnnouncement(remaining: number): string {
  if (remaining <= 0) return 'Time is up.';
  if (remaining === 1) return '1 second left.';
  if (remaining < 60) return `${remaining} seconds left.`;
  const minutes = Math.round(remaining / 60);
  return minutes === 1 ? '1 minute left.' : `${minutes} minutes left.`;
}

export const Countdown = forwardRef<HTMLSpanElement, CountdownProps>(function Countdown(
  {
    targetAt,
    nowSeconds,
    variant = 'clock',
    format,
    announceLabel,
    announce,
    onComplete,
    completedContent,
    className,
    ...rest
  },
  ref,
) {
  // First paint is a pure function of the props, so the prerendered HTML and the
  // first client render agree; ticking only starts in the effect below.
  const [remaining, setRemaining] = useState(() => Math.max(0, Math.round(targetAt - nowSeconds)));
  const [announcement, setAnnouncement] = useState('');

  const announcedRef = useRef<Set<number>>(new Set());
  const completedRef = useRef(false);
  // Callbacks go through refs so an inline arrow in the caller's JSX cannot
  // land in the effect's dep array — restarting the effect would reset the
  // monotonic baseline back to the last polled `nowSeconds` and the number
  // would visibly jump backwards on every parent render.
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const announceRef = useRef(announce);
  announceRef.current = announce;

  // Thresholds already passed at mount are marked spent, so opening a page with
  // 8 seconds left does not immediately shout "60 seconds left".
  const seededRef = useRef(false);
  if (!seededRef.current) {
    seededRef.current = true;
    const initial = Math.max(0, Math.round(targetAt - nowSeconds));
    for (const threshold of ANNOUNCE_AT) {
      if (initial <= threshold) announcedRef.current.add(threshold);
    }
    if (initial <= 0) completedRef.current = true;
  }

  useEffect(() => {
    const baseline = performance.now();
    const baseNow = nowSeconds;

    const tick = (): void => {
      const elapsed = (performance.now() - baseline) / 1000;
      // Clamped at zero: never render a negative countdown.
      const next = Math.max(0, Math.round(targetAt - (baseNow + elapsed)));
      setRemaining(next);

      for (const threshold of ANNOUNCE_AT) {
        if (next <= threshold && !announcedRef.current.has(threshold)) {
          announcedRef.current.add(threshold);
          setAnnouncement((announceRef.current ?? defaultAnnouncement)(next));
        }
      }

      if (next <= 0 && !completedRef.current) {
        completedRef.current = true;
        onCompleteRef.current?.();
      }
    };

    tick();
    // 250ms, not 1000ms: a 1s interval drifts against the true second boundary
    // and the visible number can lag by almost a full second, which is very
    // obvious next to a projected match clock. React bails out of the render
    // when the value is unchanged, so three of every four ticks are free.
    const interval = window.setInterval(tick, 250);
    return () => window.clearInterval(interval);
  }, [targetAt, nowSeconds]);

  const elapsed = remaining <= 0;
  const rendered = format
    ? format(remaining)
    : variant === 'compact'
      ? formatCompact(remaining)
      : formatClock(remaining);

  return (
    <>
      <span
        ref={ref}
        role="timer"
        aria-live="off"
        className={clsx('nums-tab', className)}
        {...rest}
      >
        {elapsed && completedContent !== undefined ? completedContent : rendered}
      </span>
      <span className="nc-sr-only" role="status" aria-atomic="true">
        {announcement ? (announceLabel ? `${announceLabel} ${announcement}` : announcement) : ''}
      </span>
    </>
  );
});
