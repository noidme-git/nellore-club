/**
 * GameBadge — DESIGN.md §6.7. Monochrome by design.
 *
 * There is no per-game art in v1 (CONTENT.md §2.9) and no per-game colour. A
 * colour per game would collide with the four status colours, would be
 * undiscoverable (nobody learns that teal means scrabble), and would fail WCAG
 * 1.4.1 unless every one also carried a glyph — at which point the glyph is
 * doing all the work and the colour is noise. So: one of three category glyphs
 * plus `short_name`. Adding Ludo stays one JSON object and zero component
 * changes.
 *
 * THE ACCENT RULE, and what it actually does in v1. §6.7 allows the game
 * record's optional `accent` to tint the glyph, and requires the implementation
 * to assert it measures >= 3:1 against `--surface-2` or fall back to
 * `--fg-muted`. `--surface-2` is a different colour in each theme and the theme
 * is only known at paint time, so the assertion below demands >= 3:1 against
 * BOTH values — a tint that is only safe in one theme is not safe, and there is
 * no second render to fix it in.
 *
 * Consequence, stated rather than hidden: CONTENT.md §2.9 requires every accent
 * to reach 4.5:1 against WHITE, which pushes every accent in `content/games.json`
 * dark, and a dark accent cannot also reach 3:1 against the dark `--surface-2`.
 * So today every accent falls back and every badge is monochrome — which is
 * exactly what §6.7's headline says the badge is. Tinting would need a second,
 * light accent per game in the content file.
 */

import type { ComponentPropsWithRef, JSX } from 'react';
import clsx from 'clsx';

import type { GameCategory } from '@/lib/types';

import { BallIcon, GamepadIcon, PawnIcon, type IconComponent } from './icons';

export interface GameBadgeProps extends ComponentPropsWithRef<'span'> {
  category: GameCategory;
  /** `games.short_name` — "BGMI", "Chess", "Box Cricket". */
  name: string;
  /** `games.accent_hex`. `#rrggbb` or nothing; anything else is ignored. */
  accent?: string | null;
}

const CATEGORY_GLYPH: Record<GameCategory, IconComponent> = {
  esport: GamepadIcon,
  board: PawnIcon,
  outdoor: BallIcon,
};

/**
 * Relative luminance of `--surface-2` in each theme (`#1C2634` / `#E9EFF5`,
 * app/globals.css). Stored as luminance rather than as a colour so this file
 * carries no hex literal and so the check is one subtraction rather than a
 * parse on every render.
 */
const SURFACE_2_LUMINANCE = { dark: 0.018827, light: 0.856486 } as const;

/** WCAG 1.4.11: a non-text graphic must reach 3:1 against its background. */
const MIN_GRAPHIC_CONTRAST = 3;

const CHANNEL_WEIGHT = [0.2126, 0.7152, 0.0722] as const;

function relativeLuminance(hex: string): number | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (match === null) return null;
  const digits = match[1];
  if (digits === undefined) return null;

  let luminance = 0;
  for (let i = 0; i < 3; i += 1) {
    const weight = CHANNEL_WEIGHT[i];
    if (weight === undefined) return null;
    const srgb = Number.parseInt(digits.slice(i * 2, i * 2 + 2), 16) / 255;
    const linear = srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
    luminance += weight * linear;
  }
  return luminance;
}

function contrast(a: number, b: number): number {
  return a > b ? (a + 0.05) / (b + 0.05) : (b + 0.05) / (a + 0.05);
}

/** Exported so a content lint or the games seeder can use the same predicate. */
export function accentIsLegible(accent: string | null | undefined): boolean {
  if (accent === null || accent === undefined) return false;
  const luminance = relativeLuminance(accent);
  if (luminance === null) return false;
  return (
    contrast(luminance, SURFACE_2_LUMINANCE.dark) >= MIN_GRAPHIC_CONTRAST &&
    contrast(luminance, SURFACE_2_LUMINANCE.light) >= MIN_GRAPHIC_CONTRAST
  );
}

const BASE =
  'inline-flex shrink-0 items-center gap-1.5 h-6 px-2 rounded-sm bg-surface-2 ' +
  'text-fg-muted text-2xs uppercase border border-line whitespace-nowrap';

export function GameBadge({
  category,
  name,
  accent,
  className,
  ...rest
}: GameBadgeProps): JSX.Element {
  const Glyph = CATEGORY_GLYPH[category];
  const tinted = accentIsLegible(accent);

  return (
    <span {...rest} className={clsx(BASE, className)}>
      <Glyph
        className="h-3.5 w-3.5 shrink-0"
        width={14}
        height={14}
        style={tinted && accent ? { color: accent } : undefined}
      />
      <span>{name}</span>
    </span>
  );
}
