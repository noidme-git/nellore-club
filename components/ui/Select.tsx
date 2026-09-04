'use client';

/**
 * Select — DESIGN.md §6.3. A native <select>, always.
 *
 * A custom listbox is ~6 KB of JS, is worse on Android (it loses the OS wheel
 * picker, which is the control every user of this site already knows), and is
 * worse with a screen reader unless the full ARIA combobox pattern is
 * implemented perfectly. Nothing in this product needs option-level markup.
 *
 * DEVIATION from §6.3, stated: the chevron is an overlaid inline SVG rather
 * than a `bg-[url(data:…)]` background image. The spec's recipe requires the
 * stroke colour to be baked into the data URI per theme, which needs two
 * declarations in `app/globals.css` (one per `[data-theme]`) that the token
 * layer does not carry. An overlaid glyph inherits `currentColor`, so it is
 * correct in both themes and in the print palette with no extra CSS and no
 * second copy of the asset. It is `pointer-events-none`, so the whole control —
 * including the chevron — still opens the native picker on tap.
 */

import { useId, type ComponentPropsWithRef, type JSX, type ReactNode } from 'react';
import clsx from 'clsx';

import { AlertTriangleIcon, ChevronDownIcon } from './icons';
import {
  ERROR_CLASS,
  FIELD_BASE,
  FIELD_BORDER,
  FIELD_BORDER_INVALID,
  HINT_CLASS,
  LABEL_CLASS,
} from './Input';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectOptionGroup {
  label: string;
  options: readonly SelectOption[];
}

export type SelectItem = SelectOption | SelectOptionGroup;

export interface SelectProps extends Omit<ComponentPropsWithRef<'select'>, 'size'> {
  label: ReactNode;
  labelHidden?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  containerClassName?: string;
  required?: boolean;
  /** Omit and pass <option> children instead when the list needs custom markup. */
  options?: readonly SelectItem[];
  /**
   * Rendered as a disabled empty-valued first option. Use it for "Choose a
   * game", never as the label — the label is always visible above the control.
   */
  placeholder?: string;
}

export const SELECT_BOX = 'h-11 pl-3 pr-9 appearance-none';
export const SELECT_CLASS = `${FIELD_BASE} ${FIELD_BORDER} ${SELECT_BOX}`;

function isGroup(item: SelectItem): item is SelectOptionGroup {
  return 'options' in item;
}

function renderOption(option: SelectOption): JSX.Element {
  return (
    <option key={option.value} value={option.value} disabled={option.disabled}>
      {option.label}
    </option>
  );
}

export function Select({
  label,
  labelHidden = false,
  hint,
  error,
  containerClassName,
  className,
  id,
  required,
  options,
  placeholder,
  children,
  ...rest
}: SelectProps): JSX.Element {
  const reactId = useId();
  const fieldId = id ?? `nc-select-${reactId}`;
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

      <div className="relative">
        <select
          {...rest}
          id={fieldId}
          required={required}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          className={clsx(
            FIELD_BASE,
            invalid ? FIELD_BORDER_INVALID : FIELD_BORDER,
            SELECT_BOX,
            className,
          )}
        >
          {placeholder !== undefined && (
            <option value="" disabled>
              {placeholder}
            </option>
          )}
          {options?.map((item) =>
            isGroup(item) ? (
              <optgroup key={item.label} label={item.label}>
                {item.options.map(renderOption)}
              </optgroup>
            ) : (
              renderOption(item)
            ),
          )}
          {children}
        </select>
        <ChevronDownIcon
          className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted"
          width={16}
          height={16}
        />
      </div>

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
