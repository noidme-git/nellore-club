/**
 * The whole icon set. DESIGN.md §7.
 *
 * Hand-rolled inline SVG, no package, no sprite, no icon font. `lucide-react`
 * and friends cost ~6 KB of wrapper before the first glyph and still do not
 * contain a pawn, a rupee-clock or a bracket junction, so half the set would be
 * hand-drawn anyway; an `<use href="/icons.svg#x">` sprite is one extra request
 * at a 400 ms RTT and it is render-blocking above the fold. Each glyph below is
 * 1-3 path elements, averages ~190 bytes, and is tree-shaken per route when
 * imported by name.
 *
 * Every glyph is drawn on the same 24x24 grid at stroke-width 1.75 with round
 * caps and joins, so mixing them in one row does not read as two typefaces.
 * They are `aria-hidden` by default and are expected to sit next to text; the
 * only exception is an icon-only control, which carries an `aria-label` on the
 * BUTTON, not on the svg (see Button.tsx), or `<Icon label>` for the rare
 * standalone graphic.
 */

import type { JSX, ReactNode, ComponentPropsWithRef } from 'react';

/**
 * `viewBox` is fixed: a glyph drawn on a different grid has a different optical
 * weight and the set stops looking like a set. Size comes from `className`
 * (h-4 w-4 …) or from the width/height attributes, which the CSS overrides.
 */
export type IconSvgProps = Omit<ComponentPropsWithRef<'svg'>, 'viewBox' | 'children'>;

export type IconComponent = (props: IconSvgProps) => JSX.Element;

function Glyph({ children, ...rest }: IconSvgProps & { children: ReactNode }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      width={24}
      height={24}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      // A focusable <svg> is a phantom tab stop in IE/old Edge and in some
      // Android webviews; the icon is never the interactive element.
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/* =====================================================================
 * The mark
 * ===================================================================== */

/**
 * "The Fork" — the club mark. Two entrants in, one winner out: literally a
 * bracket junction, which is the one shape every game on the platform shares.
 * Path data is DESIGN.md §1 verbatim; the vertical from (14,10) to (14,14) is
 * the merge bar and the exit stroke leaves from its midpoint at y=12.
 */
export const ForkIcon: IconComponent = (props) => (
  <Glyph {...props}>
    <path d="M6 6h4a4 4 0 0 1 4 4v4" />
    <path d="M6 18h4a4 4 0 0 0 4-4" />
    <path d="M14 12h4" />
  </Glyph>
);

/* =====================================================================
 * Navigation and identity
 * ===================================================================== */

export const SearchIcon: IconComponent = (props) => (
  <Glyph {...props}>
    <circle cx="11" cy="11" r="7" />
    <path d="m16.2 16.2 4.3 4.3" />
  </Glyph>
);

export const UserIcon: IconComponent = (props) => (
  <Glyph {...props}>
    <circle cx="12" cy="8" r="3.5" />
    <path d="M5 20a7 7 0 0 1 14 0" />
  </Glyph>
);

export const UsersIcon: IconComponent = (props) => (
  <Glyph {...props}>
    <circle cx="9" cy="8" r="3.4" />
    <path d="M2.6 20a6.4 6.4 0 0 1 12.8 0" />
    <path d="M16.4 4.9a3.4 3.4 0 0 1 0 6.2M17.9 14.4a6.4 6.4 0 0 1 3.5 5.6" />
  </Glyph>
);

export const HomeIcon: IconComponent = (props) => (
  <Glyph {...props}>
    <path d="M3 11 12 3.5 21 11" />
    <path d="M5.5 9.5V20h4.5v-5.5h4V20h4.5V9.5" />
  </Glyph>
);

export const TrophyIcon: IconComponent = (props) => (
  <Glyph {...props}>
    <path d="M7 4h10v5a5 5 0 0 1-10 0z" />
    <path d="M7 5.5H4.5V7a3.5 3.5 0 0 0 3 3.45M17 5.5h2.5V7a3.5 3.5 0 0 1-3 3.45" />
    <path d="M12 14v3.5M8 20.5h8" />
  </Glyph>
);

/** A four-entrant tree: the only honest picture of what this site does. */
export const BracketIcon: IconComponent = (props) => (
  <Glyph {...props}>
    <path d="M3 5h4v5H3M3 14h4v5H3" />
    <path d="M7 7.5h6v9H7" />
    <path d="M13 12h7" />
  </Glyph>
);

export const ListIcon: IconComponent = (props) => (
  <Glyph {...props}>
    <path d="M8.5 6h12M8.5 12h12M8.5 18h12" />
    <path d="M3.75 6h.01M3.75 12h.01M3.75 18h.01" />
  </Glyph>
);

export const TableIcon: IconComponent = (props) => (
  <Glyph {...props}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="1.75" />
    <path d="M3.5 9.5h17M9.75 9.5v10M3.5 14.5h17" />
  </Glyph>
);

/* =====================================================================
 * Time and place
 * ===================================================================== */

export const CalendarIcon: IconComponent = (props) => (
  <Glyph {...props}>
    <rect x="3.5" y="5.5" width="17" height="15" rx="1.75" />
    <path d="M8 3v5M16 3v5M3.5 10.5h17" />
  </Glyph>
);

export const ClockIcon: IconComponent = (props) => (
  <Glyph {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 6.75V12l3.5 2.1" />
  </Glyph>
);

export const MapPinIcon: IconComponent = (props) => (
  <Glyph {...props}>
    <path d="M12 21.5s7-6.4 7-11.3a7 7 0 1 0-14 0c0 4.9 7 11.3 7 11.3z" />
    <circle cx="12" cy="10" r="2.5" />
  </Glyph>
);

/* =====================================================================
 * Money
 * ===================================================================== */

/** ₹. Entry fee, prize pool, payout — the numbers that make this real. */
export const RupeeIcon: IconComponent = (props) => (
  <Glyph {...props}>
    <path d="M6.5 4h11M6.5 8.5h11" />
    <path d="M6.5 13h2.6c3.3 0 6-2.7 6-6" />
    <path d="m6.5 13 8 7" />
  </Glyph>
);

/**
 * Payment pending (IA.md §8.3). Not in DESIGN.md §7's list of the base set, but
 * §6.8 requires a distinct glyph for the payment-pending pill and colour alone
 * is not allowed to carry it; a bare clock would collide with the "closes in"
 * pill, which is a different state with a different action.
 */
export const RupeeClockIcon: IconComponent = (props) => (
  <Glyph {...props}>
    <path d="M4 4.5h7.5M4 8h7.5" />
    <path d="M4 11.5h2c3 0 5-2.2 5-5M4 11.5 8.5 16" />
    <circle cx="17.5" cy="17.5" r="4.5" />
    <path d="M17.5 15.3v2.4l1.7 1" />
  </Glyph>
);

/* =====================================================================
 * Direction
 * ===================================================================== */

export const ChevronLeftIcon: IconComponent = (props) => (
  <Glyph {...props}>
    <path d="m15 5-7 7 7 7" />
  </Glyph>
);

export const ChevronRightIcon: IconComponent = (props) => (
  <Glyph {...props}>
    <path d="m9 5 7 7-7 7" />
  </Glyph>
);

export const ChevronDownIcon: IconComponent = (props) => (
  <Glyph {...props}>
    <path d="m5 9 7 7 7-7" />
  </Glyph>
);

export const ArrowRightIcon: IconComponent = (props) => (
  <Glyph {...props}>
    <path d="M4 12h15" />
    <path d="m13 6 6 6-6 6" />
  </Glyph>
);

/* =====================================================================
 * Actions and state
 * ===================================================================== */

export const PlusIcon: IconComponent = (props) => (
  <Glyph {...props}>
    <path d="M12 5v14M5 12h14" />
  </Glyph>
);

/** The "registration open" glyph (IA.md §8.3 spells it "`+` in a circle"). */
export const PlusCircleIcon: IconComponent = (props) => (
  <Glyph {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 8.25v7.5M8.25 12h7.5" />
  </Glyph>
);

export const MinusIcon: IconComponent = (props) => (
  <Glyph {...props}>
    <path d="M5 12h14" />
  </Glyph>
);

export const CheckIcon: IconComponent = (props) => (
  <Glyph {...props}>
    <path d="m4.5 12.5 5 5 10-11" />
  </Glyph>
);

export const XIcon: IconComponent = (props) => (
  <Glyph {...props}>
    <path d="m6 6 12 12M18 6 6 18" />
  </Glyph>
);

export const AlertTriangleIcon: IconComponent = (props) => (
  <Glyph {...props}>
    <path d="m10.3 4.4-8 13.6A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3l-8-13.6a2 2 0 0 0-3.4 0z" />
    <path d="M12 10v4.5M12 17.75h.01" />
  </Glyph>
);

export const InfoIcon: IconComponent = (props) => (
  <Glyph {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11.25V16.5M12 8h.01" />
  </Glyph>
);

export const CopyIcon: IconComponent = (props) => (
  <Glyph {...props}>
    <rect x="9" y="9" width="11.5" height="11.5" rx="2" />
    <path d="M5.5 15h-1A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5v1" />
  </Glyph>
);

export const ShareIcon: IconComponent = (props) => (
  <Glyph {...props}>
    <path d="M12 15.5V3.5" />
    <path d="m7.75 7.75 4.25-4.25 4.25 4.25" />
    <path d="M5 12v6.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V12" />
  </Glyph>
);

export const DownloadIcon: IconComponent = (props) => (
  <Glyph {...props}>
    <path d="M12 3.5v11" />
    <path d="m7.5 10.25 4.5 4.25 4.5-4.25" />
    <path d="M4.5 19.5h15" />
  </Glyph>
);

/**
 * Offline. The one glyph the product shows when it cannot promise the data is
 * current, so it must not be mistakable for anything else in the set.
 */
export const CloudOffIcon: IconComponent = (props) => (
  <Glyph {...props}>
    <path d="M8.5 18h8a3.75 3.75 0 0 0 1.35-7.25A5.5 5.5 0 0 0 9.6 7.35" />
    <path d="M6.6 10.35A3.85 3.85 0 0 0 7.5 18" />
    <path d="m3.5 3.5 17 17" />
  </Glyph>
);

/** Passkey. AUTH.md's primary credential, so it appears on the sign-in button. */
export const KeyIcon: IconComponent = (props) => (
  <Glyph {...props}>
    <circle cx="8" cy="12" r="4.25" />
    <path d="M12.25 12h8.25" />
    <path d="M17.5 12v3.25M20.5 12v2.5" />
  </Glyph>
);

/**
 * The live dot. Filled, not stroked — a 5 px ring at 14 px reads as a smudge,
 * and this glyph has to survive being the smallest thing on the card.
 */
export const DotIcon: IconComponent = (props) => (
  <Glyph fill="currentColor" stroke="none" {...props}>
    <circle cx="12" cy="12" r="5" />
  </Glyph>
);

/* =====================================================================
 * Category glyphs — the three that stand in for every game
 *
 * CONTENT.md §2.9: there is no per-game art in v1. A game renders as its
 * category glyph next to `short_name`, which is why adding Chess960 is one JSON
 * object and zero component changes.
 * ===================================================================== */

/** `category: 'esport'` */
export const GamepadIcon: IconComponent = (props) => (
  <Glyph {...props}>
    <rect x="2.5" y="7" width="19" height="10" rx="4" />
    <path d="M7 10.75v2.5M5.75 12h2.5" />
    <path d="M15.75 11h.01M17.75 13.5h.01" />
  </Glyph>
);

/** `category: 'board'` — a pawn, because chess and carrom are the same shelf. */
export const PawnIcon: IconComponent = (props) => (
  <Glyph {...props}>
    <circle cx="12" cy="6.5" r="3" />
    <path d="M9 9.5h6" />
    <path d="M9.5 9.5c0 5-1.5 7.5-2.5 9.5h10c-1-2-2.5-4.5-2.5-9.5" />
  </Glyph>
);

/** `category: 'outdoor'` — a seamed ball: cricket, volleyball, kabaddi. */
export const BallIcon: IconComponent = (props) => (
  <Glyph {...props}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M7.6 4.9c2.8 4.4 2.8 9.8 0 14.2" />
    <path d="M9.6 3.9c3 4.9 3 11.3 0 16.2" />
  </Glyph>
);

/* =====================================================================
 * The registry
 *
 * Importing a glyph BY NAME (`import { CheckIcon } from './icons'`) is what
 * gets tree-shaken. This record exists for the cases where the name is data —
 * a status pill mapping, an empty state, a game category — and referencing it
 * pulls the whole set (~5 KB inlined). That is the deliberate trade; do not
 * reach for `<Icon name="check">` in a hot path where the literal import works.
 * ===================================================================== */

export const ICONS = {
  fork: ForkIcon,
  search: SearchIcon,
  user: UserIcon,
  users: UsersIcon,
  home: HomeIcon,
  trophy: TrophyIcon,
  bracket: BracketIcon,
  list: ListIcon,
  table: TableIcon,
  calendar: CalendarIcon,
  clock: ClockIcon,
  'map-pin': MapPinIcon,
  rupee: RupeeIcon,
  'rupee-clock': RupeeClockIcon,
  'chevron-left': ChevronLeftIcon,
  'chevron-right': ChevronRightIcon,
  'chevron-down': ChevronDownIcon,
  'arrow-right': ArrowRightIcon,
  plus: PlusIcon,
  'plus-circle': PlusCircleIcon,
  minus: MinusIcon,
  check: CheckIcon,
  x: XIcon,
  'alert-triangle': AlertTriangleIcon,
  info: InfoIcon,
  copy: CopyIcon,
  share: ShareIcon,
  download: DownloadIcon,
  'cloud-off': CloudOffIcon,
  key: KeyIcon,
  dot: DotIcon,
  gamepad: GamepadIcon,
  pawn: PawnIcon,
  ball: BallIcon,
} satisfies Record<string, IconComponent>;

export type IconName = keyof typeof ICONS;

/** Stable, sorted-by-declaration list — the gallery route renders from this. */
export const ICON_NAMES = Object.keys(ICONS) as IconName[];
