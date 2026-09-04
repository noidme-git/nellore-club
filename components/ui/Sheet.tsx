'use client';

import clsx from 'clsx';
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useRef,
  type HTMLAttributes,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from 'react';

import { XIcon } from './icons';

/**
 * The overlay primitive. DESIGN.md §6.13 — "on mobile every modal is a bottom
 * sheet", so there is one implementation and `Modal.tsx` is a thin preset over
 * this file rather than a second focus-trap.
 *
 * WHY NATIVE `<dialog>` AND NOT A PORTAL + HAND-ROLLED TRAP
 * --------------------------------------------------------
 * `showModal()` gives us, from the platform, four things that are individually
 * easy to write and collectively impossible to get right in ~80 lines:
 *
 *  1. A real focus trap that includes the browser's own chrome (URL bar,
 *     find-in-page, the Android WebView's overflow menu). A JS trap that cycles
 *     `[tabindex]:not([tabindex="-1"])` cannot see those, so Tab eventually
 *     escapes into the address bar and back into the page *behind* the sheet.
 *  2. `inert` on everything outside the dialog — the rest of the DOM leaves the
 *     accessibility tree, so a VoiceOver swipe cannot walk into the page under
 *     the sheet. Reproducing that means writing `aria-hidden` onto every sibling
 *     of every ancestor and undoing it correctly on unmount.
 *  3. The top layer, which means no `z-index` arithmetic against the sticky
 *     header (z-30), the toast host (z-60) and the bracket's absolutely
 *     positioned connector SVG.
 *  4. `::backdrop`, so the scrim is not an extra DOM node that has to be
 *     kept in sync with the dialog's mounted state.
 *
 * `showModal()` is Chrome 37+ / Safari 15.4+ / Firefox 98+, which covers the
 * mid-range Android target with room to spare. Under `output: 'export'` the
 * markup prerenders as a closed `<dialog>` — display:none, out of the a11y tree
 * — which is the correct initial state and costs nothing on first paint.
 *
 * What the platform does NOT give us and this file therefore does:
 *  - scroll lock (see `lockScroll`),
 *  - focus landing on the heading rather than the first focusable control,
 *  - focus restoration when the trigger unmounted while the sheet was open,
 *  - Escape routed back through React state instead of closing behind its back.
 */

/* ------------------------------------------------------------------ *
 * Scroll lock
 * ------------------------------------------------------------------ */

/**
 * Depth counter so a Sheet opened from inside a Sheet (the 409 conflict sheet
 * over the live-scoring `Set score…` sheet) does not unlock the page when the
 * inner one closes. Module state is safe here because `Modal.tsx` and
 * `HoldToConfirm.tsx` both route through this module — there is exactly one
 * instance of it in the bundle.
 */
let lockDepth = 0;
let restore: { overflow: string; position: string; top: string; left: string; right: string; width: string; paddingRight: string; scrollY: number } | null =
  null;

function lockScroll(): void {
  lockDepth += 1;
  if (lockDepth > 1) return;

  const body = document.body;
  const scrollY = window.scrollY;
  restore = {
    overflow: body.style.overflow,
    position: body.style.position,
    top: body.style.top,
    left: body.style.left,
    right: body.style.right,
    width: body.style.width,
    paddingRight: body.style.paddingRight,
    scrollY,
  };

  // `overflow: hidden` alone is ignored by iOS Safari, which keeps scrolling the
  // document under a fixed overlay; pinning the body is the only technique that
  // actually holds there. Pinning loses the scroll offset, hence the explicit
  // restore in `unlockScroll`.
  //
  // Removing the document scrollbar reflows the page ~15px narrower on a
  // desktop browser and every `position: fixed` element (header, toast host)
  // visibly jumps. Reserving the measured gutter as padding is what makes the
  // lock layout-neutral; on the phone target the gap is 0 and this is a no-op.
  const gutter = window.innerWidth - document.documentElement.clientWidth;

  body.style.overflow = 'hidden';
  body.style.position = 'fixed';
  body.style.top = `-${scrollY}px`;
  body.style.left = '0';
  body.style.right = '0';
  body.style.width = '100%';
  if (gutter > 0) body.style.paddingRight = `${gutter}px`;
}

function unlockScroll(): void {
  lockDepth = Math.max(0, lockDepth - 1);
  if (lockDepth > 0 || restore === null) return;

  const body = document.body;
  const previous = restore;
  restore = null;

  body.style.overflow = previous.overflow;
  body.style.position = previous.position;
  body.style.top = previous.top;
  body.style.left = previous.left;
  body.style.right = previous.right;
  body.style.width = previous.width;
  body.style.paddingRight = previous.paddingRight;

  // `html { scroll-behavior: smooth }` would animate this restore into a visible
  // scroll-back, so the jump is forced instant.
  window.scrollTo({ top: previous.scrollY, left: 0, behavior: 'instant' });
}

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */

export type SheetSize = 'md' | 'lg';

export interface SheetProps
  extends Omit<
    HTMLAttributes<HTMLDialogElement>,
    // `onClick` and `onCancel` are the backdrop-dismiss and Escape paths; `rest`
    // is spread last, so leaving them assignable would let a caller silently
    // delete the only two ways out of the dialog.
    'title' | 'role' | 'children' | 'onClose' | 'onClick' | 'onCancel'
  > {
  /** Controlled. The dialog is opened/closed by React state, never imperatively by a caller. */
  open: boolean;
  /**
   * Asked to close: backdrop click, the close button, or Escape. The sheet does
   * not close itself — the parent flips `open`, so a sheet with unsaved work can
   * intercept.
   */
  onClose: () => void;
  /** Labels the dialog (`aria-labelledby`). Rendered as the `<h2>` in the header. */
  title: ReactNode;
  /** Optional `aria-describedby` paragraph directly under the header. */
  description?: ReactNode;
  children?: ReactNode;
  /** Pinned action row at the bottom edge, above the safe-area inset. */
  footer?: ReactNode;
  /**
   * IA.md §4c: click-to-dismiss is for non-destructive sheets only. Escape is
   * NOT gated on this — a dialog you cannot leave from the keyboard is a WCAG
   * 2.1.2 keyboard trap, and "are you sure" is not a good enough reason.
   */
  dismissOnBackdrop?: boolean;
  showCloseButton?: boolean;
  /** `alertdialog` for a destructive confirm; see Modal.tsx. */
  role?: 'dialog' | 'alertdialog';
  /** Desktop width. Mobile is always full-bleed. */
  size?: SheetSize;
  /** Focus this instead of the heading on open — e.g. the search field of a picker sheet. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Keep the accessible name but hide the visible heading (a sheet whose content is its own title). */
  hideTitle?: boolean;
  /** Class for the scrollable body wrapper, not the dialog. */
  contentClassName?: string;
  closeLabel?: string;
}

const SIZE_CLASS: Record<SheetSize, string> = {
  md: 'sm:max-w-sheet',
  lg: 'sm:max-w-3xl',
};

export const Sheet = forwardRef<HTMLDialogElement, SheetProps>(function Sheet(
  {
    open,
    onClose,
    title,
    description,
    children,
    footer,
    dismissOnBackdrop = true,
    showCloseButton = true,
    role = 'dialog',
    size = 'md',
    initialFocusRef,
    hideTitle = false,
    className,
    contentClassName,
    closeLabel = 'Close',
    ...rest
  },
  forwardedRef,
) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const reactId = useId();
  const titleId = `${reactId}-title`;
  const descriptionId = `${reactId}-desc`;

  const setRefs = useCallback(
    (node: HTMLDialogElement | null) => {
      dialogRef.current = node;
      if (typeof forwardedRef === 'function') forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    },
    [forwardedRef],
  );

  // One effect owns the whole open lifecycle: show, lock, focus in; and on the
  // cleanup pass close, unlock, focus out. Splitting it into two effects is how
  // you end up with a page that can never scroll again after a fast
  // open/close/unmount, which is exactly what a flaky 4G connection produces.
  useEffect(() => {
    const el = dialogRef.current;
    if (!el || !open) return undefined;

    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    if (!el.open) el.showModal();
    lockScroll();

    // The platform focuses the first focusable descendant, which on a sheet is
    // the close button — a screen-reader user then hears "Close, button" and has
    // no idea what opened. DESIGN.md §6.13 puts focus on the heading instead.
    const target = initialFocusRef?.current ?? headingRef.current;
    target?.focus({ preventScroll: true });

    return () => {
      if (el.open) el.close();
      unlockScroll();
      // Modern engines restore focus on close, but not when the trigger was
      // removed and re-added by a re-render, and not when close() runs inside a
      // React cleanup during an unmount. Doing it explicitly is the only way it
      // is reliable, and losing focus to <body> strands a keyboard user at the
      // top of the document.
      if (previouslyFocused && previouslyFocused.isConnected) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
    // Deps are `[open]` only, on purpose: `initialFocusRef` and `onClose` are
    // read at open time, and adding them would re-run the whole open/close
    // lifecycle every time the parent re-renders with a new closure.
  }, [open]);

  // Escape fires `cancel`; let React own the transition instead of the browser
  // tearing the dialog down behind the parent's state.
  const handleCancel = useCallback(
    (event: SyntheticEvent<HTMLDialogElement>) => {
      event.preventDefault();
      onClose();
    },
    [onClose],
  );

  const handleClick = useCallback(
    (event: MouseEvent<HTMLDialogElement>) => {
      if (!dismissOnBackdrop) return;
      if (event.target !== event.currentTarget) return;
      // A click on ::backdrop is dispatched at the dialog itself, and so is a
      // keyboard-activated click when focus happens to sit on the dialog box.
      // `detail === 0` marks the latter; a hit-test against the dialog's own
      // rect rejects clicks that landed on the sheet's own background.
      if (event.detail === 0) return;
      const rect = event.currentTarget.getBoundingClientRect();
      const insideSheet =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;
      if (!insideSheet) onClose();
    },
    [dismissOnBackdrop, onClose],
  );

  return (
    <dialog
      ref={setRefs}
      role={role}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={handleCancel}
      onClick={handleClick}
      className={clsx(
        // Reset the UA dialog box (margin:auto, width:fit-content, padding:1em,
        // border:solid, and the :modal max-width/height of calc(100% - 6px - 2em)).
        // Author rules beat the UA origin regardless of specificity, but `top`
        // has to be named explicitly or the UA's `inset-block-start: 0` survives.
        'm-0 max-h-none max-w-none border-0 p-0',
        // Mobile: the bottom sheet. DESIGN.md §6.13.
        'fixed inset-x-0 bottom-0 top-auto z-50 w-full max-h-[85dvh] overflow-y-auto overscroll-contain',
        'rounded-t-lg border-t border-line bg-surface pb-safe-b text-fg shadow-3',
        'animate-nc-sheet-in',
        // Scrim. Black at 60% rather than a token: it sits over the page in both
        // themes and must not invert with them.
        'backdrop:bg-[rgb(0_0_0/0.6)]',
        // Desktop: centred dialog. `sm:` is the literal breakpoint in the
        // DESIGN.md §6.13 recipe. The entry slide is dropped here because a
        // centred box sliding up from the viewport floor reads as a mistake.
        'sm:inset-auto sm:left-1/2 sm:top-1/2 sm:w-full sm:-translate-x-1/2 sm:-translate-y-1/2',
        'sm:rounded-lg sm:border sm:border-line sm:pb-0 sm:animate-none',
        SIZE_CLASS[size],
        className,
      )}
      {...rest}
    >
      {/* Purely a "you can drag this" affordance; there is no drag gesture to
          announce, and IA.md §8.1 forbids drag being the only way to do
          anything, so it is decoration. */}
      <div className="mx-auto mt-2 h-1 w-9 rounded-full bg-line-strong sm:hidden" aria-hidden="true" />

      <header className="sticky top-0 z-10 flex h-14 items-center justify-between gap-3 border-b border-line bg-surface px-4">
        <h2
          id={titleId}
          ref={headingRef}
          tabIndex={-1}
          className={clsx(
            'min-w-0 truncate text-lg font-bold text-fg outline-none',
            hideTitle && 'nc-sr-only',
          )}
        >
          {title}
        </h2>
        {showCloseButton ? (
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            className="nc-focus -mr-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-fg-muted transition-colors duration-1 ease-out hover:bg-surface-2 hover:text-fg"
          >
            <XIcon width={20} height={20} className="h-5 w-5" />
          </button>
        ) : null}
      </header>

      {description ? (
        <p id={descriptionId} className="px-4 pt-4 text-sm text-fg-muted">
          {description}
        </p>
      ) : null}

      <div className={clsx('px-4 py-4', contentClassName)}>{children}</div>

      {footer ? (
        <div className="sticky bottom-0 border-t border-line bg-surface px-4 py-3">{footer}</div>
      ) : null}
    </dialog>
  );
});
