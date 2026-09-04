'use client';

/**
 * Textarea — DESIGN.md §6.2 ("same recipe with h-auto min-h-[96px] py-2.5
 * leading-6").
 *
 * Label, hint and error behave exactly as in Input.tsx, and for the same
 * reasons: the always-mounted `aria-live` container is what makes the message
 * audible, and `aria-describedby` points at the error id only while there is
 * one. The skin classes are imported rather than retyped so the two controls
 * cannot drift apart visually.
 *
 * `rows` is deliberately not defaulted to a number: `min-h-[96px]` sets the
 * floor in CSS, and a `rows` attribute would fight it at every zoom level.
 */

import { useId, type ComponentPropsWithRef, type JSX, type ReactNode } from 'react';
import clsx from 'clsx';

import { AlertTriangleIcon } from './icons';
import {
  ERROR_CLASS,
  FIELD_BASE,
  FIELD_BORDER,
  FIELD_BORDER_INVALID,
  HINT_CLASS,
  LABEL_CLASS,
} from './Input';

export interface TextareaProps extends ComponentPropsWithRef<'textarea'> {
  label: ReactNode;
  labelHidden?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  containerClassName?: string;
  required?: boolean;
}

export const TEXTAREA_BOX = 'min-h-[96px] px-3 py-2.5 leading-6';
export const TEXTAREA_CLASS = `${FIELD_BASE} ${FIELD_BORDER} ${TEXTAREA_BOX}`;

export function Textarea({
  label,
  labelHidden = false,
  hint,
  error,
  containerClassName,
  className,
  id,
  required,
  ...rest
}: TextareaProps): JSX.Element {
  const reactId = useId();
  const fieldId = id ?? `nc-textarea-${reactId}`;
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;
  const invalid = error !== undefined && error !== null && error !== false && error !== '';

  const describedBy =
    [hint ? hintId : null, invalid ? errorId : null, rest['aria-describedby']]
      .filter(Boolean)
      .join(' ') || undefined;

  return (
    <div className={containerClassName}>
      <label htmlFor={fieldId} className={clsx(LABEL_CLASS, labelHidden && 'nc-sr-only')}>
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

      <textarea
        {...rest}
        id={fieldId}
        required={required}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className={clsx(
          FIELD_BASE,
          invalid ? FIELD_BORDER_INVALID : FIELD_BORDER,
          TEXTAREA_BOX,
          className,
        )}
      />

      {hint !== undefined && hint !== null && hint !== '' && (
        <p id={hintId} className={HINT_CLASS}>
          {hint}
        </p>
      )}

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
