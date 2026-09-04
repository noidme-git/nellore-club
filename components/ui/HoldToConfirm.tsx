'use client';

import clsx from 'clsx';
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';

import { Modal } from './Modal';

/**
 * `Lock result`, `Generate bracket`, `Apply correction`, `Close registration`.
 * DESIGN.md §6.1 (hold-to-confirm variant), IA.md Journey 4e and 5.
 *
 * WHY A HOLD AT ALL. A stray tap while a phone is in a pocket must not advance a
 * bracket in front of a room. 1.2 s of deliberate pressure is the cheapest
 * possible guard that does not cost a second screen for every single result.
 *
 * ============================================================================
 * WCAG 2.2 §2.5.7 — HOLDING IS NEVER THE ONLY WAY. THIS IS THE POINT OF THE FILE.
 * ============================================================================
 * A hold is a path-and-duration gesture. An organiser using a screen reader, a
 * switch, voice control, or a keyboard cannot perform one, and "cannot lock a
 * score" means "cannot run the tournament". So there are always two routes to
 * the same confirmation, and the second is not a lesser one:
 *
 *   1. **Hold** — pointer only. 1.2 s with a filling bar.
 *   2. **Dialog** — everything else. Activating the button from the keyboard, a
 *      screen reader, voice control or an AT click opens a normal confirm dialog
 *      with a real button in it.
 *
 * Route 2 is chosen automatically, never by asking the user to declare
 * themselves, using `event.detail === 0`. A click synthesised by Enter, Space,
 * VoiceOver's double-tap, TalkBack, Voice Control's "click Lock result" and
 * `element.click()` all report `detail: 0`; a click that came from a real
 * pointer reports `detail >= 1`. That single check covers every assistive path
 * without a capability sniff and without an "accessibility mode" toggle.
 *
 * Route 2 is also forced, for everyone, when:
 *   - `prefers-reduced-motion: reduce` is set (DESIGN.md §4.4 says so
 *     explicitly: a filling bar is the animation, and without it the hold has no
 *     feedback at all), or
 *   - the organiser turned on **Simple confirmations** in `/me/settings/`
 *     (IA.md Journey 4e) — tremor, cold hands, gloves, a cracked digitiser.
 *
 * The hint text is rendered visibly and wired with `aria-describedby`, because a
 * control whose activation method is invisible is a control nobody uses twice.
 */

export type HoldToConfirmVariant = 'primary' | 'danger';

export interface HoldToConfirmProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'children' | 'type'> {
  label: ReactNode;
  /** Runs once the hold completes, or once the dialog is confirmed. */
  onConfirm: () => void;
  /** DESIGN.md §6.1: 1200ms. The bar's fill duration is derived from this, so they cannot disagree. */
  holdMs?: number;
  variant?: HoldToConfirmVariant;
  /** IA.md Journey 4e: the `/me/settings/` preference. Forces the dialog path. */
  simpleConfirmations?: boolean;
  /** Dialog heading. Defaults to the button's own label when it is a plain string. */
  confirmTitle?: string;
  /** The consequences, stated exactly (IA.md §4c). */
  confirmDescription?: ReactNode;
  /** Extra content inside the dialog — e.g. the impact list of IA.md Journey 5 step 3. */
  confirmContent?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Replaces the generated hint. Pass `null` to render no hint at all. */
  hint?: ReactNode;
  /** In flight. Disables both routes and sets `aria-busy`. */
  busy?: boolean;
  fullWidth?: boolean;
  /** Disable the confirming button in the dialog — e.g. until "I understand match 41 is live" is ticked. */
  confirmDisabled?: boolean;
}

const BASE =
  'nc-focus relative inline-flex select-none items-center justify-center gap-2 overflow-hidden whitespace-nowrap rounded-md font-bold transition-[transform,filter,background-color] duration-1 ease-out active:translate-y-px disabled:pointer-events-none disabled:opacity-40';

const VARIANT: Record<HoldToConfirmVariant, string> = {
  primary: 'bg-brand-fill text-on-brand hover:brightness-105 active:brightness-95',
  danger: 'bg-live text-on-brand hover:brightness-105',
};

const DIALOG_CONFIRM: Record<HoldToConfirmVariant, string> = {
  primary:
    'nc-focus inline-flex h-11 min-w-touch items-center justify-center rounded-md bg-brand-fill px-4 text-[15px] font-bold leading-none text-on-brand transition-[transform,filter] duration-1 ease-out active:translate-y-px hover:brightness-105 disabled:pointer-events-none disabled:opacity-40',
  danger:
    'nc-focus inline-flex h-11 min-w-touch items-center justify-center rounded-md bg-live px-4 text-[15px] font-bold leading-none text-on-brand transition-[transform,filter] duration-1 ease-out active:translate-y-px hover:brightness-105 disabled:pointer-events-none disabled:opacity-40',
};

const DIALOG_CANCEL =
  'nc-focus inline-flex h-11 min-w-touch items-center justify-center rounded-md border border-line-strong bg-surface-2 px-4 text-[15px] font-bold leading-none text-fg transition-colors duration-1 ease-out hover:bg-surface-3';

/**
 * DESIGN.md §6.1 gives this sentence verbatim for the default 1200ms hold. The
 * duration is rounded to whole seconds because "hold for 1.2 seconds" invites
 * someone to count, and the exact figure is not the instruction — "keep pressing
 * until the bar fills" is.
 */
function describeHold(holdMs: number): string {
  const seconds = Math.max(1, Math.round(holdMs / 1000));
  return `Press and hold for ${seconds} second${seconds === 1 ? '' : 's'}, or press Enter to confirm in a dialog.`;
}

export const HoldToConfirm = forwardRef<HTMLButtonElement, HoldToConfirmProps>(
  function HoldToConfirm(
    {
      label,
      onConfirm,
      holdMs = 1200,
      variant = 'primary',
      simpleConfirmations = false,
      confirmTitle,
      confirmDescription,
      confirmContent,
      confirmLabel = 'Confirm',
      cancelLabel = 'Cancel',
      hint,
      busy = false,
      fullWidth = false,
      confirmDisabled = false,
      disabled,
      className,
      onPointerDown,
      onPointerUp,
      onPointerLeave,
      onPointerCancel,
      ...rest
    },
    ref,
  ) {
    const reactId = useId();
    const hintId = `${reactId}-hint`;

    const [holding, setHolding] = useState(false);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [reducedMotion, setReducedMotion] = useState(false);
    const holdTimer = useRef(0);
    /**
     * Belt and braces for the `detail === 0` test below: a click that arrived
     * without a preceding pointerdown on this element did not come from a
     * finger, whatever `detail` claims. Between the two checks there is no
     * assistive path that can reach a dead button.
     */
    const sawPointerRef = useRef(false);

    // Read in an effect, not in render: `matchMedia` does not exist on the build
    // machine that prerenders this markup (`output: 'export'`), and the
    // preference can be toggled by the OS mid-session.
    useEffect(() => {
      const query = window.matchMedia('(prefers-reduced-motion: reduce)');
      const sync = (): void => setReducedMotion(query.matches);
      sync();
      query.addEventListener('change', sync);
      return () => query.removeEventListener('change', sync);
    }, []);

    useEffect(() => () => window.clearTimeout(holdTimer.current), []);

    const inert = Boolean(disabled) || busy;
    const dialogOnly = reducedMotion || simpleConfirmations;

    const cancelHold = useCallback(() => {
      window.clearTimeout(holdTimer.current);
      setHolding(false);
    }, []);

    const handlePointerDown = useCallback(
      (event: PointerEvent<HTMLButtonElement>) => {
        onPointerDown?.(event);
        sawPointerRef.current = true;
        if (dialogOnly || inert || event.defaultPrevented) return;
        // Secondary mouse buttons open the context menu, not a tournament result.
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        setHolding(true);
        window.clearTimeout(holdTimer.current);
        holdTimer.current = window.setTimeout(() => {
          setHolding(false);
          onConfirm();
        }, holdMs);
      },
      [onPointerDown, dialogOnly, inert, holdMs, onConfirm],
    );

    const handlePointerUp = useCallback(
      (event: PointerEvent<HTMLButtonElement>) => {
        onPointerUp?.(event);
        cancelHold();
      },
      [onPointerUp, cancelHold],
    );

    // Pointer capture is deliberately NOT taken: sliding a thumb off the button
    // must abort. That is the escape hatch for "I started this by mistake", and
    // it only exists if leave events still fire.
    const handlePointerLeave = useCallback(
      (event: PointerEvent<HTMLButtonElement>) => {
        onPointerLeave?.(event);
        cancelHold();
      },
      [onPointerLeave, cancelHold],
    );

    const handlePointerCancel = useCallback(
      (event: PointerEvent<HTMLButtonElement>) => {
        onPointerCancel?.(event);
        cancelHold();
      },
      [onPointerCancel, cancelHold],
    );

    const handleClick = useCallback(
      (event: MouseEvent<HTMLButtonElement>) => {
        const cameFromPointer = sawPointerRef.current;
        sawPointerRef.current = false;
        if (inert) return;
        // detail === 0 ⇒ the click was synthesised (keyboard, screen reader,
        // voice control, .click()). A real pointer click is detail >= 1 AND was
        // preceded by a pointerdown here; it is ignored, because the pointer
        // path already ran or the user let go early and meant to abort.
        if (dialogOnly || event.detail === 0 || !cameFromPointer) setDialogOpen(true);
      },
      [inert, dialogOnly],
    );

    const resolvedHint =
      hint !== undefined
        ? hint
        : dialogOnly
          ? 'Opens a confirmation dialog.'
          : describeHold(holdMs);

    const dialogTitle =
      confirmTitle ?? (typeof label === 'string' ? label : 'Confirm this action');

    return (
      <>
        <button
          ref={ref}
          type="button"
          disabled={inert}
          aria-busy={busy || undefined}
          aria-describedby={resolvedHint ? hintId : undefined}
          onClick={handleClick}
          onPointerDown={handlePointerDown}
          onPointerUp={handlePointerUp}
          onPointerLeave={handlePointerLeave}
          onPointerCancel={handlePointerCancel}
          onBlur={cancelHold}
          // Android fires a long-press context menu at ~500ms, i.e. halfway
          // through the hold, which cancels the pointer stream.
          onContextMenu={(event) => event.preventDefault()}
          className={clsx(
            BASE,
            VARIANT[variant],
            // DESIGN.md §6.1 `lg`: sticky CTAs and the live-scoring lock button.
            'h-14 px-6 text-lg',
            // Without this a hold that drifts a pixel is interpreted as the start
            // of a scroll and the pointer stream is cancelled.
            !dialogOnly && 'touch-none',
            fullWidth && 'w-full',
            className,
          )}
          {...rest}
        >
          {/* The fill. `opacity-[0.15]` rather than DESIGN.md's `bg-on-brand/15`:
              `--on-brand` is a plain custom property, so Tailwind cannot compose
              an alpha channel into it, and writing the literal rgb() would put a
              hex in a component. Identical rendering, no hard-coded colour.
              Width is driven by a CSS transition rather than rAF so it stays on
              the compositor; the duration is derived from `holdMs`, so the bar
              can never finish before or after the timer. */}
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-0 bg-on-brand opacity-[0.15] transition-[width] ease-linear"
            style={{
              width: holding ? '100%' : '0%',
              transitionDuration: holding ? `${holdMs}ms` : '120ms',
            }}
          />
          <span className="relative">{label}</span>
        </button>

        {resolvedHint ? (
          <p id={hintId} className="mt-1.5 text-xs text-fg-faint">
            {resolvedHint}
          </p>
        ) : null}

        <Modal
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          tone={variant === 'danger' ? 'destructive' : 'default'}
          title={dialogTitle}
          description={confirmDescription}
          actions={
            <>
              <button
                type="button"
                className={DIALOG_CANCEL}
                onClick={() => setDialogOpen(false)}
              >
                {cancelLabel}
              </button>
              <button
                type="button"
                className={DIALOG_CONFIRM[variant]}
                disabled={confirmDisabled || busy}
                onClick={() => {
                  setDialogOpen(false);
                  onConfirm();
                }}
              >
                {confirmLabel}
              </button>
            </>
          }
        >
          {confirmContent}
        </Modal>
      </>
    );
  },
);
