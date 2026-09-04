'use client';

/**
 * Button — DESIGN.md §6.1.
 *
 * Always a real <button>. A clickable <div> is not focusable, not in the tab
 * order, does not fire on Enter/Space and does not submit a form; every one of
 * those is a bug that only shows up on somebody else's device.
 *
 * Three things here are not obvious:
 *
 *  1. `disabled` vs `aria-disabled`. A `disabled` button is removed from the
 *     tab order, so a keyboard user sweeping a form never finds it and is never
 *     told why the form will not submit. Pass `aria-disabled` instead when the
 *     control should stay reachable and explain itself (pair it with
 *     `aria-describedby`); this component then swallows the click. `disabled`
 *     stays correct for a control that is genuinely inert — a submit already in
 *     flight, a button in a section the user cannot act on at all.
 *  2. The loading announcement. `aria-busy` alone is not spoken by most screen
 *     readers, and the spec's `loading` state also sets `disabled`, which moves
 *     focus off the button — so the user is left with silence at exactly the
 *     moment they need feedback. The live region below is mounted from the
 *     first render (a region added to the DOM at the same moment as its text is
 *     unreliably announced) and only for buttons that opt into the state.
 *  3. Class ORDER decides nothing. Two Tailwind utilities for the same property
 *     have equal specificity, so the winner is whichever the generated
 *     stylesheet emits later — not whichever is later in `className`. That is
 *     why `link` and `iconOnly` SUPPRESS the size classes rather than
 *     overriding them with `h-auto`/`px-0`.
 */

import type { ComponentPropsWithRef, JSX, MouseEvent, ReactNode } from 'react';
import clsx from 'clsx';

import { CheckIcon } from './icons';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'link'
  | 'danger'
  | 'danger-outline';

export type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonOwnProps {
  variant?: ButtonVariant;
  /**
   * `sm` is for dense tables and toolbars only. It renders 36 px tall and gets
   * `.nc-hit`, which grows the pointer target to 44 px without moving the row.
   */
  size?: ButtonSize;
  /**
   * Replaces the visible label with a spinner, keeps the label as the
   * accessible name, sets `aria-busy` and `disabled`, and announces
   * `busyLabel`. Passing it at all (even as `false`) mounts the live region.
   */
  loading?: boolean;
  busyLabel?: string;
  /**
   * Momentary confirmation. The 1.5 s window in DESIGN.md §6.1 belongs to the
   * caller's state machine — a primitive that owns a timer cannot be driven
   * from a fixture or asserted in a unit test.
   */
  success?: boolean;
  successLabel?: string;
  fullWidth?: boolean;
  children?: ReactNode;
}

type ButtonBaseProps = ComponentPropsWithRef<'button'> & ButtonOwnProps;

/**
 * An icon-only button has no text node, so its accessible name can only come
 * from `aria-label`. Requiring it in the type is the only way to stop one
 * shipping unnamed — a lint rule cannot see through a wrapper component.
 */
export type ButtonProps = ButtonBaseProps &
  ({ iconOnly: true; 'aria-label': string } | { iconOnly?: false });

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-md font-bold whitespace-nowrap ' +
  'select-none transition-[transform,filter,background-color,border-color] duration-1 ease-out ' +
  'active:translate-y-px disabled:opacity-40 disabled:pointer-events-none ' +
  // aria-disabled must NOT get pointer-events-none: the whole point is that the
  // control stays hoverable, focusable and able to explain itself.
  'aria-disabled:opacity-40 aria-disabled:cursor-not-allowed nc-focus';

const SIZE: Record<ButtonSize, { box: string; pad: string; text: string; square: string }> = {
  sm: { box: 'h-9 min-w-touch nc-hit', pad: 'px-3', text: 'text-sm', square: 'w-9' },
  md: { box: 'h-11 min-w-touch', pad: 'px-4', text: 'text-[15px] leading-none', square: 'w-11' },
  lg: { box: 'h-14', pad: 'px-6', text: 'text-lg', square: 'w-14' },
};

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-brand-fill text-on-brand hover:brightness-105 active:brightness-95',
  secondary: 'bg-surface-2 text-fg border border-line-strong hover:bg-surface-3',
  ghost: 'bg-transparent text-fg-muted hover:bg-surface-2 hover:text-fg',
  // No height, no padding, no min-width: this one sits inline in a sentence,
  // where WCAG 2.5.8's inline exception applies and a 44 px box would break the
  // line box it lives in.
  link: 'h-auto px-0 text-info underline underline-offset-2 hover:text-fg',
  danger: 'bg-live text-on-brand hover:brightness-105',
  'danger-outline': 'bg-transparent text-live border border-live hover:bg-live-tint',
};

function Spinner(): JSX.Element {
  return (
    <svg
      className="h-4 w-4 animate-spin motion-reduce:animate-none"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden
      focusable="false"
    >
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path
        d="M14.25 8A6.25 6.25 0 0 0 8 1.75"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Button(props: ButtonProps): JSX.Element {
  const {
    variant = 'primary',
    size = 'md',
    loading,
    busyLabel = 'Working…',
    success,
    successLabel = 'Saved',
    fullWidth = false,
    iconOnly = false,
    className,
    children,
    disabled,
    onClick,
    type = 'button',
    ...rest
  } = props;

  const ariaDisabled = rest['aria-disabled'];
  const softDisabled = ariaDisabled === true || ariaDisabled === 'true';
  const sized = variant !== 'link';
  const busy = loading === true;

  // Opting into either transient state mounts the live region for the lifetime
  // of the button, so the text change is what the screen reader hears.
  const announces = loading !== undefined || success !== undefined;

  function handleClick(event: MouseEvent<HTMLButtonElement>): void {
    if (softDisabled || busy) {
      // Also stops a `type="submit"` from submitting the form it sits in.
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onClick?.(event);
  }

  return (
    <>
      <button
        {...rest}
        type={type}
        disabled={disabled === true || busy}
        aria-busy={busy || undefined}
        onClick={handleClick}
        className={clsx(
          BASE,
          VARIANT[variant],
          sized && SIZE[size].box,
          sized && SIZE[size].text,
          sized && (iconOnly ? SIZE[size].square : SIZE[size].pad),
          fullWidth && 'w-full',
          className,
        )}
      >
        {busy ? (
          <>
            <Spinner />
            {/* The label survives as the accessible name, so the button does
                not silently rename itself to "" mid-submit. */}
            <span className="nc-sr-only">{children}</span>
          </>
        ) : success === true ? (
          <>
            <CheckIcon className="h-4 w-4 shrink-0" width={16} height={16} />
            {!iconOnly && <span>{successLabel}</span>}
          </>
        ) : (
          children
        )}
      </button>
      {announces && (
        <span role="status" aria-live="polite" className="nc-sr-only">
          {busy ? busyLabel : success === true ? successLabel : ''}
        </span>
      )}
    </>
  );
}
