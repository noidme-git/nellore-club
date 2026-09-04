/**
 * Avatar — DESIGN.md §6.12. Deterministic, generated, ZERO network.
 *
 * There are no avatar uploads in v1, and there is no Gravatar, no ui-avatars,
 * no DiceBear: every one of those is a third-party request per row, which on a
 * 20-row leaderboard over a 400 ms-RTT link is the slowest thing on the page
 * and leaks the club's membership to somebody else's log. This is a 5x5
 * mirrored identicon drawn from a hash of the seed, on one of eight fixed
 * tints, with the initials on top — a few hundred bytes of inline SVG, correct
 * before the stylesheet lands, identical on every device and in the printed
 * pack.
 *
 * Mirrored, because a symmetric 5x5 grid reads as a "thing" rather than as
 * noise, and because it halves the bits that have to be stable.
 *
 * NONE of the eight tints is amber. Amber means "you", "your action" or
 * "winning" (DESIGN.md §2.3); spraying it across a list of faces would be six
 * ambers on a page and the signal would be gone. Every tint is a 200-400 step
 * from the sky / mint / rose ramps of §2.5, all of which carry `--on-brand`
 * text at >= 6.9:1 in both themes (the ramp variables are theme-independent).
 */

import type { ComponentPropsWithRef, JSX } from 'react';
import clsx from 'clsx';

export type AvatarSize = 24 | 32 | 36 | 48 | 72;

export interface AvatarProps extends ComponentPropsWithRef<'span'> {
  /** Display name or team name. Becomes the initials and the accessible name. */
  name: string;
  /**
   * `PlayerRef.avatar_seed`, else the handle, else the entrant id. Anything
   * stable: the same seed must produce the same face on every device forever,
   * because that is the entire point of an identicon.
   */
  seed?: string | null;
  size?: AvatarSize;
  /**
   * Set when the name is already rendered next to the avatar — which is nearly
   * always. Two announcements of "Team Vega" per leaderboard row is noise.
   */
  decorative?: boolean;
}

const SIZE_CLASS: Record<AvatarSize, string> = {
  24: 'h-6 w-6 text-[10px]',
  32: 'h-8 w-8 text-xs',
  36: 'h-9 w-9 text-sm',
  48: 'h-12 w-12 text-base',
  72: 'h-[72px] w-[72px] text-2xl',
};

/** §2.5 ramp steps, referenced as variables so print and future themes follow. */
const TINTS = [
  'var(--sky-200)',
  'var(--sky-300)',
  'var(--sky-400)',
  'var(--mint-200)',
  'var(--mint-300)',
  'var(--mint-400)',
  'var(--rose-200)',
  'var(--rose-300)',
] as const;

/**
 * FNV-1a, 32-bit. Not a security primitive and not trying to be: it needs to be
 * stable, cheap, and identical in the Worker, in the browser and in a test.
 * `>>> 0` after the multiply keeps it in unsigned 32-bit space, which is what
 * makes it reproducible rather than drifting into float territory.
 */
function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Up to two initials, codepoint-safe. `charAt` would split a Telugu conjunct or
 * an emoji in half; `Array.from` iterates codepoints.
 */
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((word) => Array.from(word)[0] ?? '');
  const joined = letters.join('');
  return (joined === '' ? Array.from(name.trim())[0] ?? '?' : joined).toUpperCase();
}

export function Avatar({
  name,
  seed,
  size = 36,
  decorative = false,
  className,
  ...rest
}: AvatarProps): JSX.Element {
  const source = seed !== null && seed !== undefined && seed !== '' ? seed : name;
  const digest = hash32(source);
  const tint = TINTS[digest % TINTS.length] ?? TINTS[0];

  // 15 bits fill the left three columns; columns 3 and 4 mirror 1 and 0.
  const cells: JSX.Element[] = [];
  for (let row = 0; row < 5; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      const bit = row * 3 + col;
      if (((digest >>> bit) & 1) === 0) continue;
      cells.push(<rect key={`${row}-${col}`} x={col} y={row} width={1} height={1} />);
      if (col < 2) {
        cells.push(<rect key={`${row}-${4 - col}`} x={4 - col} y={row} width={1} height={1} />);
      }
    }
  }

  return (
    <span
      {...rest}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : name}
      aria-hidden={decorative ? true : undefined}
      className={clsx(
        'relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full',
        SIZE_CLASS[size],
        className,
      )}
    >
      <svg
        viewBox="0 0 5 5"
        className="absolute inset-0 h-full w-full"
        // Whole-pixel rects share edges; antialiasing them leaves hairlines
        // through the pattern at 24 px.
        shapeRendering="crispEdges"
        aria-hidden
        focusable="false"
      >
        <rect x={0} y={0} width={5} height={5} fill={tint} />
        {/* Texture, not content: low-alpha ink keeps the initials the only
            thing with real contrast on top of the tint. */}
        <g fill="var(--on-brand)" opacity={0.18}>
          {cells}
        </g>
      </svg>
      <span className="relative font-extrabold leading-none text-on-brand" aria-hidden>
        {initialsOf(name)}
      </span>
    </span>
  );
}
