'use client';

/**
 * SegmentedControl — DESIGN.md §6.19. Bracket `Winners / Losers / Final`, view
 * mode `Rounds / Follow / Map`, any other pick-exactly-one-of-a-few control.
 *
 * NOT a tablist: the segments do not each own a panel, and announcing "tab 2 of
 * 3" for a filter that changes what a single region contains is a lie a screen
 * reader user has to work around.
 *
 * DEVIATION from §6.19, stated: that section specifies `role="group"` with
 * `aria-pressed` on each segment. This implements `role="radiogroup"` with
 * `role="radio"` + `aria-checked`. Both are legitimate ARIA patterns, but a
 * group of toggle buttons announces "pressed"/"not pressed" per button and
 * gives no total ("1 of 3"), makes every segment its own tab stop, and does not
 * carry the mutual exclusion that is the entire semantic of this control. The
 * radiogroup pattern announces the set, is one tab stop with a roving
 * `tabindex`, and gets arrow-key selection — which is what the assignment for
 * this workstream requires. The visual recipe is §6.19 verbatim.
 *
 * Renders nothing when there is one segment or fewer: a control with a single
 * option is a label pretending to be a choice.
 */

import { useRef, type JSX, type KeyboardEvent, type ReactNode } from 'react';
import clsx from 'clsx';

import { Icon, type IconName } from './Icon';

export interface SegmentItem {
  value: string;
  label: ReactNode;
  icon?: IconName;
  disabled?: boolean;
}

export interface SegmentedControlProps {
  items: readonly SegmentItem[];
  value: string;
  onValueChange: (value: string) => void;
  /** Accessible name for the group, e.g. "Bracket view mode". */
  label: string;
  className?: string;
}

const GROUP = 'inline-flex p-0.5 rounded-md bg-surface-2 border border-line';

/**
 * `min-w-touch` + `.nc-hit` is what gets a 36 px-tall segment to a 44 px target
 * (DESIGN.md §12 rule 3). The width floor also stops two adjacent hit-area
 * pseudo-elements from overlapping, which would silently steal the edge of the
 * neighbouring segment.
 */
const SEGMENT =
  'h-9 px-3 min-w-touch nc-hit inline-flex items-center justify-center gap-1.5 ' +
  'rounded-[7px] text-sm font-semibold nc-focus transition-colors duration-1 ease-out ' +
  'disabled:opacity-40 disabled:pointer-events-none';

const SELECTED = 'bg-surface-3 text-fg shadow-1';
const UNSELECTED = 'text-fg-muted hover:text-fg';

export function SegmentedControl({
  items,
  value,
  onValueChange,
  label,
  className,
}: SegmentedControlProps): JSX.Element | null {
  const buttons = useRef(new Map<string, HTMLButtonElement | null>());

  if (items.length <= 1) return null;

  const enabled = items.filter((item) => item.disabled !== true);
  const rovingValue =
    enabled.find((item) => item.value === value)?.value ?? enabled[0]?.value ?? items[0]?.value ?? '';

  function select(next: SegmentItem | undefined): void {
    if (!next) return;
    buttons.current.get(next.value)?.focus();
    onValueChange(next.value);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, current: string): void {
    if (enabled.length === 0) return;
    const index = enabled.findIndex((item) => item.value === current);
    const base = index === -1 ? 0 : index;

    switch (event.key) {
      // Up/Left and Down/Right are both bound: the radiogroup pattern does not
      // know or care that this particular group happens to be laid out in a row.
      case 'ArrowRight':
      case 'ArrowDown':
        select(enabled[(base + 1) % enabled.length]);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        select(enabled[(base - 1 + enabled.length) % enabled.length]);
        break;
      case 'Home':
        select(enabled[0]);
        break;
      case 'End':
        select(enabled[enabled.length - 1]);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  return (
    <div role="radiogroup" aria-label={label} className={clsx(GROUP, className)}>
      {items.map((item) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={item.disabled === true}
            tabIndex={item.value === rovingValue ? 0 : -1}
            ref={(node) => {
              buttons.current.set(item.value, node);
            }}
            onClick={() => onValueChange(item.value)}
            onKeyDown={(event) => onKeyDown(event, item.value)}
            className={clsx(SEGMENT, selected ? SELECTED : UNSELECTED)}
          >
            {item.icon !== undefined && <Icon name={item.icon} size={16} />}
            <span>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
