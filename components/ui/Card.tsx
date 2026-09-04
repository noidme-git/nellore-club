/**
 * Card — DESIGN.md §6.5, elevation level 1 (§4.3).
 *
 * Elevation in dark mode is a surface step plus a hairline, not a shadow:
 * `shadow-1` resolves to `none` under the default theme and to a real shadow
 * under `[data-theme='light']`, which is why the same recipe is correct in both
 * and why there is no `dark:` variant here.
 *
 * An interactive card is NOT a button. Wrapping a card in a click handler
 * destroys the accessible name (the whole card becomes one long label), hides
 * the destination from the status bar, and breaks middle-click and
 * open-in-new-tab. Instead the card is `relative`, the heading contains a real
 * <a href> carrying `CARD_STRETCHED_LINK`, and the link's ::after covers the
 * card: the tap target is the whole card, the accessible name is the heading,
 * and `focus-within` draws the focus ring on the card while the ring's owner is
 * the link. Text inside the card stays selectable except where it sits under
 * the pseudo-element, which is why any secondary link in a card needs
 * `relative` to lift itself back above it.
 */

import type { ComponentPropsWithRef, JSX } from 'react';
import clsx from 'clsx';

export interface CardProps extends ComponentPropsWithRef<'div'> {
  /**
   * `article` for a self-contained item in a feed, `li` inside a list, `section`
   * for a labelled region. Props and the ref are typed against <div>; the tag
   * only changes the semantics, never the shape of the attributes used here.
   */
  as?: 'div' | 'article' | 'section' | 'li';
  /** Adds the hover/focus-within treatment. Pair with a stretched link. */
  interactive?: boolean;
  /** Off for cards that own their own padding, e.g. a full-bleed table. */
  padded?: boolean;
}

export const CARD_BASE = 'rounded-lg bg-surface border border-line shadow-1';
export const CARD_PADDING = 'p-4 md:p-5';

export const CARD_INTERACTIVE =
  'relative transition-colors duration-1 hover:bg-surface-2 ' +
  'focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 ' +
  'focus-within:outline-focus';

/**
 * Put this on the single <a> that names the card. It must be a descendant of a
 * `relative` box — `Card interactive` provides that.
 */
export const CARD_STRETCHED_LINK = 'after:absolute after:inset-0 after:content-[""]';

export function Card({
  as = 'div',
  interactive = false,
  padded = true,
  className,
  ...rest
}: CardProps): JSX.Element {
  // The cast keeps the intrinsic-element props resolvable to one shape; the
  // rendered tag is still whatever `as` says.
  const Tag = as as 'div';

  return (
    <Tag
      {...rest}
      className={clsx(CARD_BASE, padded && CARD_PADDING, interactive && CARD_INTERACTIVE, className)}
    />
  );
}
