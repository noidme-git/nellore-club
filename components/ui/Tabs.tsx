'use client';

/**
 * Tabs — DESIGN.md §6.4, keyboard model per WAI-ARIA APG.
 *
 * §6.4 covers two things that look identical and behave differently, so this
 * component has two modes and no third:
 *
 *  - `mode="tabs"` (default): a real tablist. Roving `tabindex` means the whole
 *    strip is ONE tab stop, which matters when a double-elimination bracket has
 *    fourteen rounds — otherwise Tab has to be pressed fourteen times to get
 *    past the strip to the matches. Left/Right move, Home/End jump, and
 *    `activation="manual"` (the IA.md §8.2 model for bracket rounds) separates
 *    moving focus from selecting so an arrow key does not fetch a round the
 *    user was only passing over. The consumer MUST render a panel per item
 *    using `tabPanelId()`/`tabTriggerId()`; `aria-controls` points at it.
 *  - `mode="nav"`: the tournament sub-nav, which is links to real URLs. These
 *    are NOT tabs — each one is a navigation, so each is its own tab stop, the
 *    active one carries `aria-current="page"`, and arrow keys do nothing
 *    (hijacking them inside a list of links breaks caret browsing).
 *
 * Three signals mark the active item — underline, weight, and
 * `aria-selected`/`aria-current` — of which exactly one is colour (DESIGN.md
 * §12 rule 2).
 *
 * `next/link` is deliberately absent: this primitive is rendered inside
 * `app/shell/**`, where the App Router client router is forbidden
 * (ARCHITECTURE.md §4 rule 7). Plain <a href>.
 */

import { useId, useRef, type JSX, type KeyboardEvent, type ReactNode } from 'react';
import clsx from 'clsx';

import { Icon, type IconName } from './Icon';

export interface TabItem {
  /** Stable, URL-safe: it becomes part of the tab and panel element ids. */
  id: string;
  label: ReactNode;
  icon?: IconName;
  /** Trailing count or dot. Give it its own accessible text if it means something. */
  badge?: ReactNode;
  disabled?: boolean;
  /** `mode="nav"` only. Ignored in tabs mode. */
  href?: string;
}

export interface TabsProps {
  items: readonly TabItem[];
  /** The id of the selected item. Controlled: this component holds no state. */
  value: string;
  /** Required in tabs mode; unused in nav mode, where the <a> navigates. */
  onValueChange?: (id: string) => void;
  /** Accessible name for the tablist / nav landmark, e.g. "Bracket rounds". */
  label: string;
  mode?: 'tabs' | 'nav';
  /**
   * `automatic` selects on arrow (right for cheap, local panel swaps).
   * `manual` moves focus only and waits for Enter/Space — use it whenever
   * selecting costs a fetch.
   */
  activation?: 'automatic' | 'manual';
  /** Override only when the ids must be stable across a remount (deep links). */
  idPrefix?: string;
  className?: string;
}

export function tabTriggerId(prefix: string, id: string): string {
  return `${prefix}-tab-${id}`;
}

export function tabPanelId(prefix: string, id: string): string {
  return `${prefix}-panel-${id}`;
}

const STRIP =
  'relative flex gap-1 overflow-x-auto scroll-smooth motion-reduce:scroll-auto snap-x ' +
  'snap-proximity [scrollbar-width:none] [&::-webkit-scrollbar]:hidden border-b border-line';

const ITEM =
  'snap-start shrink-0 h-11 px-3 inline-flex items-center gap-1.5 text-sm nc-focus relative ' +
  'hover:text-fg disabled:opacity-40 disabled:pointer-events-none';

/**
 * The 2 px amber underline. `-bottom-px` sits it ON the container's hairline so
 * the strip does not grow by a pixel when selection moves.
 */
const ACTIVE =
  'text-fg font-bold after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 ' +
  'after:bg-brand-fill after:rounded-full';

const INACTIVE = 'text-fg-muted font-semibold';

export function Tabs({
  items,
  value,
  onValueChange,
  label,
  mode = 'tabs',
  activation = 'automatic',
  idPrefix,
  className,
}: TabsProps): JSX.Element {
  const reactId = useId();
  const prefix = idPrefix ?? `nc-tabs-${reactId}`;
  const triggers = useRef(new Map<string, HTMLButtonElement | null>());

  const enabled = items.filter((item) => item.disabled !== true);
  // If the selected id is missing or disabled, the first enabled item owns the
  // single tab stop — a strip with no reachable element is a keyboard trap in
  // reverse: Tab skips straight past the whole control.
  const rovingId =
    enabled.find((item) => item.id === value)?.id ?? enabled[0]?.id ?? items[0]?.id ?? '';

  function focusItem(id: string): void {
    const node = triggers.current.get(id);
    if (!node) return;
    node.focus();
    // The strip scrolls horizontally; without this, arrowing to round 14 moves
    // focus off-screen, which is a WCAG 2.4.11 failure.
    node.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function move(from: string, delta: 1 | -1 | 'first' | 'last'): void {
    if (enabled.length === 0) return;
    let next: TabItem | undefined;
    if (delta === 'first') {
      next = enabled[0];
    } else if (delta === 'last') {
      next = enabled[enabled.length - 1];
    } else {
      const index = enabled.findIndex((item) => item.id === from);
      const base = index === -1 ? 0 : index;
      next = enabled[(base + delta + enabled.length) % enabled.length];
    }
    if (!next) return;
    focusItem(next.id);
    if (activation === 'automatic') onValueChange?.(next.id);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, id: string): void {
    switch (event.key) {
      case 'ArrowRight':
        move(id, 1);
        break;
      case 'ArrowLeft':
        move(id, -1);
        break;
      case 'Home':
        move(id, 'first');
        break;
      case 'End':
        move(id, 'last');
        break;
      default:
        return;
    }
    // Only reached when a key was handled: Home/End would otherwise scroll the
    // document out from under the strip.
    event.preventDefault();
  }

  const body = items.map((item) => {
    const selected = item.id === value;
    const classes = clsx(ITEM, selected ? ACTIVE : INACTIVE);
    const content = (
      <>
        {item.icon !== undefined && <Icon name={item.icon} size={16} />}
        <span>{item.label}</span>
        {item.badge !== undefined && <span className="nums-tab text-xs">{item.badge}</span>}
      </>
    );

    if (mode === 'nav') {
      return (
        <a
          key={item.id}
          href={item.href}
          aria-current={selected ? 'page' : undefined}
          aria-disabled={item.disabled === true || undefined}
          className={classes}
        >
          {content}
        </a>
      );
    }

    return (
      <button
        key={item.id}
        type="button"
        role="tab"
        id={tabTriggerId(prefix, item.id)}
        aria-selected={selected}
        aria-controls={tabPanelId(prefix, item.id)}
        disabled={item.disabled === true}
        tabIndex={item.id === rovingId ? 0 : -1}
        ref={(node) => {
          triggers.current.set(item.id, node);
        }}
        onClick={() => onValueChange?.(item.id)}
        onKeyDown={(event) => onKeyDown(event, item.id)}
        className={classes}
      >
        {content}
      </button>
    );
  });

  if (mode === 'nav') {
    return (
      <nav aria-label={label} className={clsx(STRIP, className)}>
        {body}
      </nav>
    );
  }

  return (
    <div role="tablist" aria-label={label} className={clsx(STRIP, className)}>
      {body}
    </div>
  );
}
