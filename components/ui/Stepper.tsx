'use client';

import clsx from 'clsx';
import { forwardRef, useCallback, type HTMLAttributes, type ReactNode } from 'react';

import { MinusIcon, PlusIcon } from './icons';

/**
 * The live-scoring stepper. DESIGN.md §6.19, IA.md Journey 4e.
 *
 * Used standing up, one-handed, in bad light, on a phone. Hence 64px buttons and
 * a `text-score` numeral, and hence two deliberate omissions:
 *
 *  - NO long-press repeat. A repeat that fires while the organiser is deciding
 *    is a wrong score, and a wrong score two rounds deep costs the correction
 *    flow of IA.md Journey 5. Large values go through `onRequestSetValue`, which
 *    opens a numeric keypad sheet (cricket runs, scrabble points).
 *  - NO `<input type="number">`. On Android it summons a keyboard that covers
 *    the score, and its spin buttons are ~12px.
 *
 * Semantics: a `group` labelled with the entrant name, two buttons whose
 * accessible names name the entrant ("Increase Team Vega's score" — the score of
 * the *other* team is one thumb away, so "Increase" alone is not enough), and
 * the value as a polite live region so every press is confirmed audibly. It is
 * NOT a `spinbutton`: that role promises arrow-key adjustment on a focused
 * value, which does not exist here.
 */

export interface StepperProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange' | 'children'> {
  value: number;
  onChange: (next: number) => void;
  /**
   * Whose score this is. Used to build the button labels; the visible entrant
   * name is rendered by the caller's row, not here.
   */
  entrantName: string;
  /** What is being counted. Default "score". */
  unitName?: string;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  /**
   * Opens the caller's numeric keypad sheet. Omit for a small-integer score
   * (a BGMI placement, a chess result) where the buttons are faster.
   */
  onRequestSetValue?: () => void;
  setValueLabel?: string;
  /** Rendered under the value — e.g. a computed `Pts` figure. */
  footnote?: ReactNode;
}

const BUTTON =
  'nc-focus inline-flex h-16 w-16 shrink-0 items-center justify-center rounded-lg border border-line-strong bg-surface-2 text-fg transition-[background-color,transform] duration-1 ease-out active:translate-y-px active:bg-surface-3 disabled:pointer-events-none disabled:opacity-40';

export const Stepper = forwardRef<HTMLDivElement, StepperProps>(function Stepper(
  {
    value,
    onChange,
    entrantName,
    unitName = 'score',
    min = 0,
    max,
    step = 1,
    disabled = false,
    onRequestSetValue,
    setValueLabel = 'Set score…',
    footnote,
    className,
    ...rest
  },
  ref,
) {
  const clamp = useCallback(
    (next: number) => {
      const lowerBounded = Math.max(min, next);
      return max === undefined ? lowerBounded : Math.min(max, lowerBounded);
    },
    [min, max],
  );

  const atMin = value <= min;
  const atMax = max !== undefined && value >= max;

  return (
    <div ref={ref} className={clsx('flex flex-col items-center gap-1', className)} {...rest}>
      <div
        role="group"
        aria-label={`${entrantName} ${unitName}`}
        className="flex items-center gap-3"
      >
        <button
          type="button"
          onClick={() => onChange(clamp(value - step))}
          disabled={disabled || atMin}
          aria-label={`Decrease ${entrantName}'s ${unitName}`}
          className={BUTTON}
        >
          <MinusIcon width={28} height={28} className="h-7 w-7" />
        </button>

        {/*
          `role="status"` rather than an `aria-live` on a plain span: the value is
          the entire message, and re-announcing it on every press is the point —
          an organiser who cannot see the screen in the glare still hears "3".
          `aria-atomic` keeps it from announcing a bare digit out of context. The
          entrant name is inside the region rather than on an `aria-label`,
          because a label on a live region names it but is not necessarily what
          gets read when the content changes.
        */}
        <span
          role="status"
          aria-atomic="true"
          className="nums-tab min-w-[3ch] text-center text-score font-extrabold text-fg"
        >
          <span className="nc-sr-only">{`${entrantName}: `}</span>
          {value}
        </span>

        <button
          type="button"
          onClick={() => onChange(clamp(value + step))}
          disabled={disabled || atMax}
          aria-label={`Increase ${entrantName}'s ${unitName}`}
          className={BUTTON}
        >
          <PlusIcon width={28} height={28} className="h-7 w-7" />
        </button>
      </div>

      {footnote ? <div className="nums-tab text-xs text-fg-faint">{footnote}</div> : null}

      {onRequestSetValue ? (
        <button
          type="button"
          onClick={onRequestSetValue}
          disabled={disabled}
          className="nc-focus inline-flex min-h-touch items-center px-2 text-sm text-info underline underline-offset-2 transition-colors duration-1 ease-out hover:text-fg disabled:pointer-events-none disabled:opacity-40"
        >
          {setValueLabel}
          <span className="nc-sr-only">{` for ${entrantName}`}</span>
        </button>
      ) : null}
    </div>
  );
});
