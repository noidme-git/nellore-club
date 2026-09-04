/**
 * <Icon name="…"> — the by-name wrapper over the hand-rolled set in ./icons.
 *
 * Two jobs the raw glyph components deliberately do not do:
 *
 *  1. SIZE. DESIGN.md §7 caps decorative icons at 28 px outside empty states
 *     and the hero, so the size prop is a closed union rather than a number.
 *     Both the CSS class and the width/height attributes are set: the class is
 *     what actually renders, the attributes are what keep the glyph the right
 *     size in the ~200 ms before the stylesheet lands on a 400 kbps link.
 *  2. LABELLING. An icon is `aria-hidden` and sits next to text. The exception
 *     is a standalone graphic that carries meaning on its own, which needs
 *     role="img" + a name. An icon-only BUTTON is not that case — the label
 *     belongs on the button (see Button.tsx), because the accessible name of
 *     the control is what a screen-reader user hears in the tab order.
 */

import type { JSX } from 'react';
import clsx from 'clsx';

import { ICONS, type IconName, type IconSvgProps } from './icons';

export type { IconName };

/** DESIGN.md §7: nothing larger than 28 px outside an empty state or the hero. */
export type IconSize = 14 | 16 | 20 | 24 | 28;

export interface IconProps extends Omit<IconSvgProps, 'width' | 'height'> {
  name: IconName;
  /** Default 20: the size that sits on the baseline of `text-sm`/`text-base`. */
  size?: IconSize;
  /**
   * Supply ONLY when the glyph is the sole carrier of meaning. Setting it flips
   * the svg from `aria-hidden` to `role="img"`, which puts it in the
   * accessibility tree — an unnecessary one is a stray announcement in every
   * row of a list.
   */
  label?: string;
}

const SIZE_CLASS: Record<IconSize, string> = {
  14: 'h-3.5 w-3.5',
  16: 'h-4 w-4',
  20: 'h-5 w-5',
  24: 'h-6 w-6',
  28: 'h-7 w-7',
};

export function Icon({ name, size = 20, label, className, ...rest }: IconProps): JSX.Element {
  const Glyph = ICONS[name];
  const labelled = label !== undefined && label !== '';

  return (
    <Glyph
      width={size}
      height={size}
      className={clsx('shrink-0', SIZE_CLASS[size], className)}
      // Explicit `undefined` is load-bearing: it overrides the `aria-hidden`
      // the glyph sets by default, and React then omits the attribute.
      aria-hidden={labelled ? undefined : true}
      role={labelled ? 'img' : undefined}
      aria-label={labelled ? label : undefined}
      {...rest}
    />
  );
}
