'use client';

import clsx from 'clsx';
import { forwardRef, type ButtonHTMLAttributes } from 'react';

import { formatIstTimeWithZone } from '@/lib/format/datetime';

import { ClockIcon, CloudOffIcon } from './icons';

/**
 * DESIGN.md §6.19, IA.md §7.1 — mandatory on every live view.
 *
 * This chip is the only thing that distinguishes a bracket that is live from a
 * bracket that was live eleven minutes ago when the phone last had signal. On a
 * 4G connection that drops in a hall full of people, that distinction is the
 * whole product: an organiser who trusts a stale score locks a wrong result.
 *
 * It is a **button**, not a label. Tapping forces a revalidate, which is also
 * the manual refresh path required when polling is switched off by
 * `saveData`/2g (IA.md §7.4). `nc-hit` gives the 32px-tall pill a 44px target
 * without letting it change the toolbar's height.
 *
 * Unobtrusive but unmissable: `--surface-2` on a hairline, `text-xs`, no colour
 * of its own — until it goes offline, when the glyph changes shape (cloud-off)
 * as well as the wording. Shape, not colour, because DESIGN.md §2.3 reserves
 * amber and IA.md §8.3 forbids colour as the only encoding.
 */

/**
 * `6:42 PM IST` comes from `lib/format/datetime`, not from a local
 * `Intl.DateTimeFormat` here. Integration note: this file originally carried its
 * own formatter because `lib/format` did not exist when it was written. Two
 * copies of the IST-suffix rule is exactly the drift that ends with one surface
 * saying `6:42 PM` and another `18:42`, so the local copy is gone. `lib/format`
 * is pure and does no I/O, so importing it does not breach ARCHITECTURE.md §4
 * rule 3 — that rule bans fetching, and the §4 graph has `components/` depending
 * on `lib/`. The import is of the file, not the `lib/format` barrel, so a chip on
 * a byte-budgeted route does not drag `share.ts` in behind it.
 */

export interface FreshnessChipProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'onClick' | 'type'> {
  /** Unix seconds: when the currently painted data was fetched. */
  updatedAt: number;
  /**
   * Server-corrected unix seconds (`components/data/useClockSkew`). The chip does
   * not tick on its own — the view re-renders on every poll, which is exactly
   * when this label needs to change.
   */
  now: number;
  offline?: boolean;
  refreshing?: boolean;
  onRefresh: () => void;
  /** IST formatter from `lib/format/datetime`. */
  formatAbsolute?: (unixSeconds: number) => string;
}

/** Relative under an hour (IA.md §7.1), absolute after. `null` = use the absolute form. */
function relativeMinutes(ageSeconds: number): string | null {
  if (ageSeconds < 45) return 'just now';
  const minutes = Math.round(ageSeconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return null;
}

export const FreshnessChip = forwardRef<HTMLButtonElement, FreshnessChipProps>(
  function FreshnessChip(
    {
      updatedAt,
      now,
      offline = false,
      refreshing = false,
      onRefresh,
      formatAbsolute = formatIstTimeWithZone,
      className,
      disabled,
      ...rest
    },
    ref,
  ) {
    // A negative age means the device clock ran ahead of the correction that
    // produced `updatedAt`. Clamp rather than render "Updated in 3 min".
    const age = Math.max(0, now - updatedAt);
    const absolute = formatAbsolute(updatedAt);
    const relative = relativeMinutes(age);

    const visible = offline
      ? `Offline · as of ${absolute}`
      : relative
        ? `Updated ${relative}`
        : `Updated ${absolute}`;

    // The visible string is abbreviated for the chip; the accessible name spells
    // it out and names the action, because "Updated 4 min ago" alone does not
    // tell a screen-reader user that this is a refresh button.
    const spokenAge = offline
      ? `Offline. Showing data from ${absolute}.`
      : relative === 'just now'
        ? 'Updated just now.'
        : relative
          ? `Updated ${relative.replace(' min ', ' minutes ')}.`
          : `Updated at ${absolute}.`;

    return (
      <button
        ref={ref}
        type="button"
        onClick={onRefresh}
        disabled={disabled ?? refreshing}
        aria-busy={refreshing || undefined}
        aria-label={`${spokenAge} Refresh.`}
        // Freshness is a screen concept; the printed pack carries its own
        // generation time (DESIGN.md §11).
        data-print="hide"
        className={clsx(
          'nc-focus nc-hit inline-flex h-8 shrink-0 items-center gap-1 rounded-full border border-line bg-surface-2 px-2.5 text-xs text-fg-muted',
          'transition-colors duration-1 ease-out hover:text-fg disabled:opacity-60',
          className,
        )}
        {...rest}
      >
        {/* Shape, not colour: cloud-off vs clock is the offline signal
            (IA.md §8.3 forbids colour as the only encoding). */}
        {offline ? (
          <CloudOffIcon width={14} height={14} className="h-3.5 w-3.5 shrink-0" />
        ) : (
          <ClockIcon width={14} height={14} className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="nums-tab truncate">{refreshing ? 'Refreshing…' : visible}</span>
      </button>
    );
  },
);
