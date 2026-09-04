/**
 * StatusPill — DESIGN.md §6.8, mapping enforced by IA.md §8.3.
 *
 * Every pill is GLYPH + TEXT + colour, and it is legible with the colour
 * removed entirely. That is not a formality here: roughly 8% of Indian men have
 * a colour vision deficiency, red/green is the commonest form, and the two
 * states this product most needs distinguished at a glance across a noisy hall
 * are "registration open" (green) and "live" (red). A pill that relied on hue
 * would be a coin flip for one player in twelve.
 *
 * There is deliberately no amber pill. Amber is the brand and means "you",
 * "your action" or "winning" (DESIGN.md §2.3); the status ramp is green / cyan
 * / red / slate so amber never has to mean two things at once. Where a real
 * warning is needed the system uses the red family plus an explicit sentence,
 * and urgency is a ticking number, not a colour change.
 *
 * The kind list is exactly IA.md §8.3's table. Adding a status means adding a
 * row THERE first — a pill invented at a call site is how colour-only status
 * gets back into a product.
 */

import type { ComponentPropsWithRef, JSX } from 'react';
import clsx from 'clsx';

import {
  CalendarIcon,
  CheckIcon,
  ClockIcon,
  CloudOffIcon,
  MinusIcon,
  PlusCircleIcon,
  RupeeClockIcon,
  XIcon,
  type IconComponent,
} from './icons';

export type StatusPillKind =
  | 'registration_open'
  | 'registration_closing'
  | 'scheduled'
  | 'live'
  | 'completed'
  | 'cancelled'
  | 'payment_pending'
  | 'queued'
  | 'eliminated';

export interface StatusPillProps extends ComponentPropsWithRef<'span'> {
  kind: StatusPillKind;
  /**
   * Overrides the default text. Use it for the states whose whole value is the
   * number — `Closes in 6h 12m`, `Starts 6:00 PM IST`, `Eliminated in R2`.
   */
  label?: string;
}

interface PillSpec {
  /** `null` means the live dot, which is a shape, not a glyph. */
  icon: IconComponent | null;
  tone: string;
  label: string;
}

const SPEC: Record<StatusPillKind, PillSpec> = {
  registration_open: {
    icon: PlusCircleIcon,
    tone: 'bg-ok-tint text-ok', // 8.16
    label: 'Registration open',
  },
  registration_closing: {
    // Still green: closing is not an error, and a colour change would be the
    // only signal a screen reader never gets. The countdown carries the urgency.
    icon: ClockIcon,
    tone: 'bg-ok-tint text-ok',
    label: 'Closing soon',
  },
  scheduled: {
    icon: CalendarIcon,
    tone: 'bg-info-tint text-info', // 8.14
    label: 'Scheduled',
  },
  live: {
    icon: null,
    tone: 'bg-live-tint text-live', // 6.17
    label: 'Live',
  },
  completed: {
    icon: CheckIcon,
    tone: 'bg-surface-2 text-fg-muted', // 7.47
    label: 'Completed',
  },
  cancelled: {
    icon: XIcon,
    tone: 'bg-surface-2 text-fg-faint', // 5.38
    label: 'Cancelled',
  },
  payment_pending: {
    icon: RupeeClockIcon,
    tone: 'bg-surface-2 text-fg-muted',
    label: 'Payment pending',
  },
  queued: {
    icon: CloudOffIcon,
    tone: 'bg-surface-2 text-fg-muted',
    label: 'Queued — will sync',
  },
  eliminated: {
    // IA.md §8.3 dims the eliminated ROW to 70%; the pill itself keeps full
    // opacity, because 5.38 x 0.7 is no longer AA.
    icon: MinusIcon,
    tone: 'bg-surface-2 text-fg-faint',
    label: 'Eliminated',
  },
};

const BASE =
  'inline-flex shrink-0 items-center gap-1.5 h-6 pl-1.5 pr-2.5 rounded-full ' +
  'text-2xs font-bold uppercase whitespace-nowrap';

export function StatusPill({ kind, label, className, ...rest }: StatusPillProps): JSX.Element {
  const spec = SPEC[kind];
  const Glyph = spec.icon;

  return (
    <span {...rest} className={clsx(BASE, spec.tone, className)}>
      {Glyph === null ? (
        // The pulse is opacity-only, so it survives `prefers-reduced-motion` as
        // a static dot; app/globals.css then gives it a ring so "live" is still
        // carried by more than colour and more than motion.
        <span
          className="h-2 w-2 shrink-0 rounded-full bg-live animate-nc-pulse motion-reduce:animate-none"
          aria-hidden
        />
      ) : (
        <Glyph className="h-3.5 w-3.5 shrink-0" width={14} height={14} />
      )}
      <span>{label ?? spec.label}</span>
    </span>
  );
}
