import clsx from 'clsx';
import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';

import { InfoIcon } from './icons';

/**
 * DESIGN.md §6.16, copy per view enumerated in IA.md §7.2.
 *
 * `action` is REQUIRED, and that is the whole design of this file. DESIGN.md
 * §6.16: "Every empty state in the product names a next step; a dead end is a
 * bug." Typing the next step as required turns that review rule into a compile
 * error, which is the only version of it that survives a deadline.
 *
 * A view that genuinely has no forward action does not use an empty state — the
 * home page's live strip, for example, is removed entirely rather than
 * rendering "nothing is live" (IA.md §7.2).
 */

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** One sentence, sentence case. e.g. "Nothing live right now." */
  title: ReactNode;
  /** Why it is empty and what happens next. Clamped to ~36ch for a readable measure. */
  description?: ReactNode;
  /**
   * The next step. Required: see the note above. Pass a `Button`, a link, or a
   * fragment of both — this primitive does not decide what the action is.
   */
  action: ReactNode;
  /** A quieter alternative next to the primary action. */
  secondaryAction?: ReactNode;
  /**
   * 28px inline SVG (DESIGN.md §7 caps decorative glyphs at 28px outside the
   * hero). Rendered in `text-fg-faint` and `aria-hidden` by the wrapper.
   */
  icon?: ReactNode;
  /**
   * Heading level. Defaults to 3 — an empty state almost always sits inside a
   * section that already has an h2, and skipping levels breaks the document
   * outline a screen-reader user navigates by.
   */
  headingLevel?: 2 | 3 | 4;
  children?: ReactNode;
}

export const EmptyState = forwardRef<HTMLDivElement, EmptyStateProps>(function EmptyState(
  { title, description, action, secondaryAction, icon, headingLevel = 3, children, className, ...rest },
  ref,
) {
  const Heading = `h${headingLevel}` as const;

  return (
    <div
      ref={ref}
      className={clsx('flex flex-col items-center gap-3 px-6 py-12 text-center', className)}
      {...rest}
    >
      <span className="text-fg-faint" aria-hidden="true">
        {icon ?? <InfoIcon width={28} height={28} className="h-7 w-7" />}
      </span>

      <Heading className="text-lg font-bold text-fg">{title}</Heading>

      {description ? (
        <p className="max-w-[36ch] text-sm text-fg-muted">{description}</p>
      ) : null}

      {children}

      <div className="mt-1 flex flex-col items-center gap-2 sm:flex-row sm:gap-3">
        {action}
        {secondaryAction}
      </div>
    </div>
  );
});
