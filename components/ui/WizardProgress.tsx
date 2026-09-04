import clsx from 'clsx';
import { forwardRef, type HTMLAttributes } from 'react';

/**
 * DESIGN.md §6.19. Used by the registration wizard (IA.md Journey 2) and the
 * create-tournament wizard (Journey 4a).
 *
 * A bar alone is not accessible, so this renders three encodings of the same
 * fact: the visible `Step 2 of 5` text, the fill width, and
 * `role="progressbar"` with an `aria-valuetext` that includes the step's name.
 * `aria-valuetext` overrides the "40%" a screen reader would otherwise compute
 * from valuenow/valuemax — a percentage is not what the user is being asked to
 * track, a step is.
 *
 * The fill transitions at `--dur-2`; under reduced motion globals.css collapses
 * that to 1ms and the bar simply snaps, which is correct — the bar is feedback,
 * not decoration.
 */

export interface WizardProgressProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  /** 1-based. Clamped to `[1, total]`. */
  current: number;
  total: number;
  /** Names the progressbar, e.g. "Registration progress". */
  label: string;
  /** The current step's own name, e.g. "Format". Appended to the announcement. */
  stepName?: string;
  /** Hide the `Step 2 of 5` line when the surrounding heading already says it. */
  hideStepText?: boolean;
}

export const WizardProgress = forwardRef<HTMLDivElement, WizardProgressProps>(
  function WizardProgress(
    { current, total, label, stepName, hideStepText = false, className, ...rest },
    ref,
  ) {
    const safeTotal = Math.max(1, Math.floor(total));
    const safeCurrent = Math.min(safeTotal, Math.max(1, Math.floor(current)));
    const stepText = `Step ${safeCurrent} of ${safeTotal}`;
    const percent = (safeCurrent / safeTotal) * 100;

    return (
      <div ref={ref} className={clsx('flex flex-col gap-2', className)} {...rest}>
        {hideStepText ? null : (
          <p className="nums-tab text-xs text-fg-faint">
            {stepText}
            {stepName ? ` · ${stepName}` : ''}
          </p>
        )}

        <div
          role="progressbar"
          aria-label={label}
          aria-valuemin={1}
          aria-valuemax={safeTotal}
          aria-valuenow={safeCurrent}
          aria-valuetext={stepName ? `${stepText}: ${stepName}` : stepText}
          className="h-1 w-full overflow-hidden rounded-full bg-surface-2"
        >
          <div
            className="h-full rounded-full bg-brand-fill transition-[width] duration-2 ease-out"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>
    );
  },
);
