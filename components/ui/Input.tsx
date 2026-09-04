'use client';

/**
 * Input — DESIGN.md §6.2, IA.md §8.1 ("Forms").
 *
 * The label is always visible and always associated. A placeholder-as-label
 * disappears the moment the user types, which is the single most common form
 * failure on a phone: the field with the error is the one field whose purpose
 * you can no longer see.
 *
 * The error message lives in a container that is mounted on EVERY render and is
 * empty when the field is valid. An `aria-live` region that appears at the same
 * moment as its text is not reliably announced by NVDA or TalkBack; one that is
 * already there and then changes, is. `aria-describedby` still references the
 * error id only while there is an error, so a valid field does not carry a
 * pointer to an empty node.
 *
 * The error is `polite`, not `role="alert"`. IA.md §8.1 puts the assertive
 * summary at the top of the form on submit; making the per-field message
 * assertive as well means a user who fails validation on six fields hears
 * twelve interruptions.
 */

import { useId, type ComponentPropsWithRef, type JSX, type ReactNode } from 'react';
import clsx from 'clsx';

import { AlertTriangleIcon } from './icons';

/**
 * `code` is the room-code / recovery-code field: mono, tracked, uppercased.
 * There is no per-character grid and `onPaste` is never intercepted (WCAG 2.2
 * §3.3.8) — a recovery code is pasted from a password manager far more often
 * than it is typed.
 */
export type InputFieldVariant = 'text' | 'numeric' | 'code';

export interface InputProps extends Omit<ComponentPropsWithRef<'input'>, 'size'> {
  /** Required. There is no unlabelled input in this product. */
  label: ReactNode;
  /**
   * Hides the label visually only — it stays in the accessibility tree. Use it
   * where an adjacent heading already names the field (the search box), never
   * to save vertical space.
   */
  labelHidden?: boolean;
  hint?: ReactNode;
  /** Presence of an error is what sets `aria-invalid`; there is no separate flag. */
  error?: ReactNode;
  fieldVariant?: InputFieldVariant;
  /** Class for the wrapping <div>, so a caller can control the field's width. */
  containerClassName?: string;
  /** Renders the required marker next to the label and sets `required`. */
  required?: boolean;
}

/**
 * The shared control skin, carrying NO height and NO padding.
 *
 * Textarea.tsx and Select.tsx compose their own box off this rather than
 * overriding `h-11`/`px-3` with `h-auto`/`pr-9`: two Tailwind utilities for the
 * same property have equal specificity, so the winner is whichever the
 * generated stylesheet emits later, which is not something a component should
 * be betting on. There is no shared `field.ts` because this workstream owns one
 * file per component; these constants are the seam.
 */
export const FIELD_BASE =
  'w-full rounded-md bg-surface-2 text-fg placeholder:text-fg-faint ' +
  'border text-base nc-focus disabled:opacity-50 read-only:bg-surface';

/**
 * The border COLOUR is separate for the same reason: `border-live` beating
 * `border-line-strong` currently depends on `live` being declared after `line`
 * in tailwind.config.ts, which is not a fact a form's error state should rest
 * on. Emit exactly one of the two.
 *
 * `--line-strong`, never `--line`: a border that communicates the boundary of
 * an interactive control has to be perceivable (DESIGN.md §2.2), and `--line`
 * measures 1.61 against the page.
 */
export const FIELD_BORDER = 'border-line-strong';
export const FIELD_BORDER_INVALID = 'border-live';

export const INPUT_CLASS = `${FIELD_BASE} ${FIELD_BORDER} h-11 px-3`;

export const LABEL_CLASS = 'block text-sm font-semibold text-fg-muted mb-1.5';
export const HINT_CLASS = 'mt-1 text-xs text-fg-faint';
export const ERROR_CLASS = 'mt-1 flex items-start gap-1.5 text-sm text-live';

const VARIANT_CLASS: Record<InputFieldVariant, string> = {
  text: '',
  numeric: 'nums-tab',
  code: 'font-mono text-code uppercase tracking-[0.14em]',
};

export function Input({
  label,
  labelHidden = false,
  hint,
  error,
  fieldVariant = 'text',
  containerClassName,
  className,
  id,
  required,
  ...rest
}: InputProps): JSX.Element {
  const reactId = useId();
  const inputId = id ?? `nc-input-${reactId}`;
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const invalid = error !== undefined && error !== null && error !== false && error !== '';

  const describedBy =
    [hint ? hintId : null, invalid ? errorId : null, rest['aria-describedby']]
      .filter(Boolean)
      .join(' ') || undefined;

  return (
    <div className={containerClassName}>
      <label htmlFor={inputId} className={clsx(LABEL_CLASS, labelHidden && 'nc-sr-only')}>
        {label}
        {required === true && (
          <>
            {' '}
            <span className="text-live" aria-hidden>
              *
            </span>
            <span className="nc-sr-only"> (required)</span>
          </>
        )}
      </label>

      <input
        {...rest}
        id={inputId}
        required={required}
        // `inputmode` is what puts the numeric keypad on an Android phone;
        // type="number" is deliberately not used — it rejects pasted values
        // with spaces, adds spinners nobody can hit, and scroll-wheels the
        // score of the match you are standing in front of.
        inputMode={rest.inputMode ?? (fieldVariant === 'numeric' ? 'numeric' : undefined)}
        autoCapitalize={rest.autoCapitalize ?? (fieldVariant === 'code' ? 'characters' : undefined)}
        autoCorrect={rest.autoCorrect ?? (fieldVariant === 'code' ? 'off' : undefined)}
        spellCheck={rest.spellCheck ?? (fieldVariant === 'code' ? false : undefined)}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className={clsx(
          FIELD_BASE,
          invalid ? FIELD_BORDER_INVALID : FIELD_BORDER,
          'h-11 px-3',
          VARIANT_CLASS[fieldVariant],
          className,
        )}
      />

      {hint !== undefined && hint !== null && hint !== '' && (
        <p id={hintId} className={HINT_CLASS}>
          {hint}
        </p>
      )}

      {/* Always mounted. See the header comment: this is what makes the
          message audible, and the glyph is what makes a red border legible to
          the ~8% of Indian men with a colour vision deficiency. */}
      <div aria-live="polite">
        {invalid && (
          <p id={errorId} className={ERROR_CLASS}>
            <AlertTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" width={16} height={16} />
            <span>{error}</span>
          </p>
        )}
      </div>
    </div>
  );
}
