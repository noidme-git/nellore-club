'use client';

import clsx from 'clsx';
import { forwardRef, type ReactNode } from 'react';

import { Sheet, type SheetProps } from './Sheet';

/**
 * DESIGN.md §6.13: "On mobile every modal is a bottom sheet." A modal and a
 * sheet are therefore the same object with different desktop geometry and
 * different defaults — not two components.
 *
 * So this file is deliberately a preset over `Sheet`, not a second
 * implementation. Duplicating the focus trap, the scroll lock and the focus
 * restore into a "real" Modal is how two overlays drift apart and one of them
 * quietly stops trapping focus. Everything hard lives in exactly one place; this
 * file owns only the three things that genuinely differ for a decision dialog:
 *
 *  1. `role="alertdialog"` when the decision is destructive, so a screen reader
 *     announces the whole dialog rather than just its name.
 *  2. Backdrop dismissal off by default for a destructive decision (IA.md §4c:
 *     click-to-dismiss for non-destructive sheets only). Escape still works —
 *     Sheet never traps it.
 *  3. A standard action row: column-reverse on mobile so the confirming action,
 *     which is written last in the DOM, renders nearest the thumb, and
 *     right-aligned on desktop where the reading order is what matters.
 */

export type ModalTone = 'default' | 'destructive';

export interface ModalProps extends Omit<SheetProps, 'footer' | 'role'> {
  /**
   * `destructive` promotes the dialog to `alertdialog` and turns off
   * click-outside-to-dismiss. Use it for anything that loses data or money:
   * close registration, generate bracket, correct a result, reject an entrant.
   */
  tone?: ModalTone;
  /**
   * The buttons, in reading order (cancel first, confirm last). Passed as nodes
   * because `components/ui` primitives compose; Modal does not decide what the
   * confirming action is called or what it does.
   */
  actions?: ReactNode;
  /** Class for the action row wrapper. */
  actionsClassName?: string;
}

export const Modal = forwardRef<HTMLDialogElement, ModalProps>(function Modal(
  { tone = 'default', actions, actionsClassName, dismissOnBackdrop, size = 'md', ...rest },
  ref,
) {
  return (
    <Sheet
      ref={ref}
      role={tone === 'destructive' ? 'alertdialog' : 'dialog'}
      dismissOnBackdrop={dismissOnBackdrop ?? tone !== 'destructive'}
      size={size}
      footer={
        actions ? (
          <div
            className={clsx(
              'flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-3',
              actionsClassName,
            )}
          >
            {actions}
          </div>
        ) : undefined
      }
      {...rest}
    />
  );
});
