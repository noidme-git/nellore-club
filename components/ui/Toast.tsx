'use client';

import clsx from 'clsx';
import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from 'react';

import { AlertTriangleIcon, CheckIcon, InfoIcon, XIcon, type IconComponent } from './icons';

/**
 * One toast. DESIGN.md §6.14.
 *
 * The timer lives here rather than in ToastHost because the two things that
 * pause it — hover and focus — are events on this element. Hoisting the timer
 * into the host would mean the host subscribing to child pointer/focus events
 * and keeping a parallel map of paused ids, for no gain.
 *
 * A toast NEVER takes focus. It is an announcement, and stealing focus from the
 * control the organiser just pressed loses their place mid-round (WCAG 2.2
 * §3.2.1). The dismiss button is reachable by Tab, which is enough. DESIGN.md
 * §6.14 also makes this non-authoritative: a toast is never the only report of
 * an error that blocks progress — that also renders inline.
 */

export type ToastKind = 'success' | 'error' | 'info';

export interface ToastAction {
  label: string;
  onClick: () => void;
  /** Dismiss the toast once the action runs. Default true. */
  dismissOnClick?: boolean;
}

export interface ToastItem {
  /** Stable identity; the host keys and de-duplicates on it. */
  id: string;
  kind?: ToastKind;
  message: ReactNode;
  action?: ToastAction;
  /**
   * Milliseconds before auto-dismiss. Defaults to 5000, or 8000 when the toast
   * carries an action (DESIGN.md §6.14) — an action the user cannot reach in
   * time is worse than no action. `0` pins the toast until dismissed.
   */
  durationMs?: number;
}

export interface ToastProps extends Omit<HTMLAttributes<HTMLDivElement>, 'id' | 'children' | 'role'> {
  toast: ToastItem;
  onDismiss: (id: string) => void;
  dismissLabel?: string;
}

const DEFAULT_DURATION_MS = 5000;
const DEFAULT_DURATION_WITH_ACTION_MS = 8000;

const KIND_BORDER: Record<ToastKind, string> = {
  success: 'border-l-ok',
  error: 'border-l-live',
  info: 'border-l-line-strong',
};

const KIND_ICON_COLOR: Record<ToastKind, string> = {
  success: 'text-ok',
  error: 'text-live',
  info: 'text-fg-muted',
};

/** Colour is never the only encoding (IA.md §8.3): every kind also carries a glyph. */
const KIND_GLYPH: Record<ToastKind, IconComponent> = {
  success: CheckIcon,
  error: AlertTriangleIcon,
  info: InfoIcon,
};

export const Toast = forwardRef<HTMLDivElement, ToastProps>(function Toast(
  { toast, onDismiss, dismissLabel = 'Dismiss', className, ...rest },
  ref,
) {
  const { id, kind = 'info', message, action } = toast;
  const duration =
    toast.durationMs ?? (action ? DEFAULT_DURATION_WITH_ACTION_MS : DEFAULT_DURATION_MS);
  const Glyph = KIND_GLYPH[kind];

  const [entered, setEntered] = useState(false);
  const [paused, setPaused] = useState(false);
  const remainingRef = useRef(duration);
  const startedAtRef = useRef(0);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  // Two frames of "mounted at rest" would be skipped by React batching, so the
  // enter state is flipped in an effect rather than during render.
  useEffect(() => {
    const raf = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    if (duration <= 0 || paused) return undefined;
    startedAtRef.current = Date.now();
    const timer = window.setTimeout(() => onDismissRef.current(id), remainingRef.current);
    return () => {
      window.clearTimeout(timer);
      // Bank the time actually spent visible, so hovering for ten seconds does
      // not restart a five-second toast from the top.
      remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedAtRef.current));
    };
  }, [duration, paused, id]);

  const pause = useCallback(() => setPaused(true), []);
  const resume = useCallback(() => setPaused(false), []);

  const handleAction = useCallback(() => {
    if (!action) return;
    action.onClick();
    if (action.dismissOnClick !== false) onDismiss(id);
  }, [action, onDismiss, id]);

  return (
    // The fade and the slide are split across two elements on purpose. The
    // reduced-motion block in globals.css clamps every transition to 1ms and
    // then re-raises `.nc-fade` to 120ms; a single element carrying both
    // properties can only have one transition-duration, so it would either
    // move when it must not, or pop when it should still fade. Outer fades,
    // inner moves — reduced motion then correctly yields a still 120ms fade.
    <div
      ref={ref}
      className={clsx('nc-fade duration-2 ease-out', entered ? 'opacity-100' : 'opacity-0')}
      // An error toast escalates its own subtree to assertive inside the host's
      // polite region; ARIA resolves live-region politeness at the nearest
      // ancestor with the attribute, so nesting is well-defined here.
      role={kind === 'error' ? 'alert' : undefined}
      onMouseEnter={pause}
      onMouseLeave={resume}
      onFocusCapture={pause}
      onBlurCapture={resume}
      {...rest}
    >
      <div
        className={clsx(
          'pointer-events-auto flex items-start gap-3 rounded-md border border-l-[3px] border-line-strong bg-surface-2 p-3 text-sm text-fg shadow-3',
          'transition-transform duration-2 ease-out',
          KIND_BORDER[kind],
          entered ? 'translate-y-0' : 'translate-y-2',
          className,
        )}
      >
        <Glyph width={18} height={18} className={clsx('mt-px h-[18px] w-[18px]', KIND_ICON_COLOR[kind])} />

        <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">{message}</div>

        {action ? (
          <button
            type="button"
            onClick={handleAction}
            // `min-h-touch` rather than `nc-hit`: this button sits 12px from the
            // dismiss button, and two overlapping 44px pseudo-element hit areas
            // put "Undo" under the finger that aimed at "close" (IA.md §8.1
            // requires ≥8px between adjacent targets).
            className="nc-focus -my-2 inline-flex min-h-touch shrink-0 items-center self-start whitespace-nowrap px-0 text-sm font-bold text-info underline underline-offset-2 transition-colors duration-1 ease-out hover:text-fg"
          >
            {action.label}
          </button>
        ) : null}

        <button
          type="button"
          onClick={() => onDismiss(id)}
          aria-label={dismissLabel}
          className="nc-focus nc-hit -m-1 shrink-0 self-start rounded-sm p-1 text-fg-muted transition-colors duration-1 ease-out hover:text-fg"
        >
          <XIcon width={16} height={16} className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
});
