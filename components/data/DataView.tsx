'use client';

/**
 * The five-state machine of IA.md §7.1. **There is no sixth state and there is
 * no "spinner forever."**
 *
 * ```
 *                 ┌──────────┐
 *    mount ─────► │  BOOT    │ read localStorage (useResource)
 *                 └────┬─────┘
 *         cache hit    │    cache miss
 *       ┌──────────────┴───────────────┐
 *       ▼                              ▼
 * ┌───────────┐  revalidate      ┌───────────┐
 * │  STALE    │ ───────────────► │ LOADING   │  skeleton after 250 ms
 * │ (content  │ ◄─────────────── │ (skeleton)│  "still loading…" + Retry at 10 s
 * │  + chip)  │    304 / 200     └─────┬─────┘
 * └─────┬─────┘                        │
 *       │                              ▼
 *       └───────────────────────►┌───────────┐
 *                                │  READY    │
 *                                └─────┬─────┘
 *          fetch throws / 5xx / offline│
 *                                ┌─────▼─────┐   no cache
 *                                │  ERROR    │◄──────────
 *                                │ or OFFLINE│
 *                                └───────────┘
 * ```
 *
 * `DataView` is **headless** (DESIGN.md §6): it owns the machine, the 250 ms
 * delay, the freshness chip's text and the shared per-slug poller, and it
 * renders nothing of its own but a wrapper and one visually hidden live
 * region. Every visible pixel comes from a slot the caller supplies, because
 * the skeleton has to be laid out to the exact dimensions of the real content
 * — a generic spinner is precisely the layout shift this design forbids.
 *
 * **The 250 ms delay is not a nicety.** On a warm cache or a fast connection a
 * response arrives in 80 ms; painting a skeleton for those 80 ms is a flash of
 * grey blocks that reads as a broken page. The skeleton is mounted only if the
 * request is still outstanding at 250 ms.
 *
 * **A view that hand-rolls its own loading state is a PR rejection.** One
 * implementation is what makes "no spinner forever" checkable.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import type { ApiError, NetworkError } from '@/lib/api';
import { formatOfflineLabel, formatUpdatedLabel } from '@/lib/format';

import { useClockSkew } from './useClockSkew';
import { useOffline } from './useOffline';
import { usePoller, type PollerState } from './usePoller';
import type { ResourceResult } from './useResource';

/** IA.md §7.1. */
export const SKELETON_DELAY_MS = 250;
/** The diagram's "still loading… + Retry at 10s". */
export const SLOW_LOADING_MS = 10_000;
/** How often the "4 min ago" chip is recomputed. */
const FRESHNESS_TICK_MS = 30_000;

export type DataViewState = 'loading' | 'empty' | 'error' | 'offline' | 'ready';

export interface FreshnessInfo {
  /** Unix seconds the data was last known current. `null` before the first load. */
  fetchedAt: number | null;
  /** `Updated 4 min ago`, `Updated 6:42 PM IST`, or `Offline · as of 7:41 PM IST`. */
  label: string | null;
  /** Older than the soft TTL, or painted from cache while a revalidate runs. */
  stale: boolean;
  offline: boolean;
  revalidating: boolean;
  /** Tapping the chip forces a revalidate (IA.md §7.1). */
  refresh: () => void;
  /**
   * Polling is off — `saveData`, a 2g connection, or a non-pollable endpoint —
   * so the toolbar must show an explicit **Refresh** button next to the chip
   * (IA.md §7.4).
   */
  showRefreshButton: boolean;
  poller: PollerState | null;
}

export interface LoadingSlotInfo {
  /** The request has been outstanding for 10 s. Show "Still loading…" and a Retry. */
  slow: boolean;
  retry: () => void;
}

export interface ErrorSlotInfo {
  error: ApiError | NetworkError | null;
  retry: () => void;
  /** True when stale content is being shown underneath; the error is then inline, not a full card. */
  hasStaleData: boolean;
}

export interface OfflineSlotInfo {
  retry: () => void;
  /** Unix seconds of the cached copy on screen, for "showing data from 7:41 PM IST". */
  fetchedAt: number | null;
  hasStaleData: boolean;
}

export interface DataViewRenderInfo<T> {
  data: T;
  freshness: FreshnessInfo;
  state: DataViewState;
}

export interface DataViewProps<T> {
  /** The result of `useResource`. */
  resource: ResourceResult<T>;
  /** Announced to screen readers and used as the wrapper's accessible name. */
  label: string;

  /**
   * True when a successful response has nothing to show. Defaults to a
   * conservative check: `null`, an empty array, or `{ data: [] }`. Anything
   * else needs an explicit predicate — "no rows in this table but the
   * tournament exists" is a different empty state from "no tournaments".
   */
  isEmpty?: (data: T) => boolean;

  /** Rendered only after 250 ms, and only while there is nothing to paint. */
  skeleton?: ReactNode | ((info: LoadingSlotInfo) => ReactNode);
  /** IA.md §7.2 fixes the copy per view; there is no generic empty state. */
  empty?: ReactNode;
  error?: (info: ErrorSlotInfo) => ReactNode;
  /** Falls back to the `error` slot when omitted. */
  offline?: (info: OfflineSlotInfo) => ReactNode;

  children: (info: DataViewRenderInfo<T>) => ReactNode;

  /**
   * The poller group key — **the tournament slug**, so the bracket, standings
   * and entrants views on one page share one timer (API.md §8.4 rule 8).
   * Omitted means this view does not poll.
   */
  pollKey?: string;
  /** Only `/live/`, the tournament overview, the bracket, standings and check-in poll (IA.md §7.4). */
  poll?: boolean;

  /**
   * Keep painting cached content when a revalidate fails. On by default: a
   * stale bracket with an honest "as of" chip beats an error card, and it is
   * the entire point of the cache.
   */
  keepStaleOnError?: boolean;

  className?: string;
}

function defaultIsEmpty(data: unknown): boolean {
  if (data === null || data === undefined) return true;
  if (Array.isArray(data)) return data.length === 0;
  if (typeof data === 'object' && 'data' in data) {
    const inner = (data as { data: unknown }).data;
    return Array.isArray(inner) && inner.length === 0;
  }
  return false;
}

/**
 * `true` once `active` has been continuously true for `delayMs`. Resets the
 * moment `active` goes false, so a fast response never leaves a skeleton
 * queued to appear after the content has already painted.
 */
export function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [flag, setFlag] = useState(false);

  useEffect(() => {
    if (!active) {
      setFlag(false);
      return;
    }
    const timer = setTimeout(() => {
      setFlag(true);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [active, delayMs]);

  return flag;
}

/**
 * The state machine on its own, for a view that cannot use the component —
 * the tournament page paints its header from the boot island and only the
 * blocks below it are data-backed (IA.md §7.2).
 */
export function useDataViewState<T>(
  resource: ResourceResult<T>,
  isEmpty: (data: T) => boolean = defaultIsEmpty as (data: T) => boolean,
): DataViewState {
  const { offline } = useOffline();

  if (resource.status === 'loading' || resource.status === 'idle') {
    return resource.data === null ? 'loading' : 'ready';
  }

  if (resource.status === 'error' && resource.data === null) {
    return offline || (resource.error !== null && resource.error.name === 'NetworkError')
      ? 'offline'
      : 'error';
  }

  if (resource.data === null) return 'loading';
  return isEmpty(resource.data) ? 'empty' : 'ready';
}

export function DataView<T>(props: DataViewProps<T>): ReactNode {
  const {
    resource,
    label,
    isEmpty = defaultIsEmpty as (data: T) => boolean,
    skeleton,
    empty,
    error,
    offline: offlineSlot,
    children,
    pollKey,
    poll = false,
    keepStaleOnError = true,
    className,
  } = props;

  const offlineState = useOffline();
  const skew = useClockSkew();

  // The shared per-slug timer. `usePoller` is a no-op when disabled, and the
  // key is what makes three views on one page one timer rather than three.
  const poller = usePoller({
    key: pollKey ?? '',
    enabled: poll && pollKey !== undefined && pollKey !== '',
    pollAfter: resource.pollAfter,
    onPoll: resource.refresh,
  });

  const state = useDataViewState<T>(resource, isEmpty);

  const waiting = state === 'loading';
  const showSkeleton = useDelayedFlag(waiting, SKELETON_DELAY_MS);
  const slow = useDelayedFlag(waiting, SLOW_LOADING_MS);

  // Recompute "4 min ago" on a slow tick rather than on every render.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (resource.fetchedAt === null) return;
    const timer = setInterval(() => {
      setTick((n) => n + 1);
    }, FRESHNESS_TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [resource.fetchedAt]);

  const freshness = useMemo<FreshnessInfo>(() => {
    const now = Math.floor(Date.now() / 1000) + skew.offsetSeconds;
    const fetchedAt = resource.fetchedAt;
    return {
      fetchedAt,
      label:
        fetchedAt === null
          ? null
          : offlineState.offline
            ? formatOfflineLabel(fetchedAt)
            : formatUpdatedLabel(fetchedAt, now),
      stale: resource.stale || (resource.error !== null && resource.data !== null),
      offline: offlineState.offline,
      revalidating: resource.revalidating,
      refresh: () => {
        void resource.refresh();
      },
      showRefreshButton: poll && poller.disabled,
      poller: poll ? poller : null,
    };
    // `setTick` above is what makes the relative label refresh; including the
    // tick in the dependency list would be the same thing said twice.
  }, [
    resource.fetchedAt,
    resource.stale,
    resource.error,
    resource.data,
    resource.revalidating,
    resource.refresh,
    offlineState.offline,
    skew.offsetSeconds,
    poll,
    poller,
  ]);

  const retry = (): void => {
    void resource.refresh();
  };

  // The live region announces state transitions. A client-side data view that
  // silently swaps a skeleton for a table is invisible to a screen reader
  // (IA.md §8.1); `polite` because none of these are interruptions.
  const announcement = useAnnouncement(state, label);

  let body: ReactNode = null;

  switch (state) {
    case 'loading':
      body = showSkeleton
        ? typeof skeleton === 'function'
          ? skeleton({ slow, retry })
          : (skeleton ?? null)
        : null;
      break;

    case 'empty':
      body = empty ?? null;
      break;

    case 'offline':
      body =
        offlineSlot?.({ retry, fetchedAt: resource.fetchedAt, hasStaleData: false }) ??
        error?.({ error: resource.error, retry, hasStaleData: false }) ??
        null;
      break;

    case 'error':
      body = error?.({ error: resource.error, retry, hasStaleData: false }) ?? null;
      break;

    case 'ready':
      // `state === 'ready'` implies data is non-null; the machine above is the
      // only place that decides it, so the assertion is local and checkable.
      body = children({ data: resource.data as T, freshness, state });
      // A failed revalidate over content we can still show: the content stays
      // and the error is offered as an inline slot. IA.md §7.2, "existing
      // results stay visible".
      if (keepStaleOnError && resource.error !== null) {
        const inline = offlineState.offline
          ? offlineSlot?.({ retry, fetchedAt: resource.fetchedAt, hasStaleData: true })
          : error?.({ error: resource.error, retry, hasStaleData: true });
        if (inline !== undefined && inline !== null) {
          body = (
            <>
              {inline}
              {body}
            </>
          );
        }
      }
      break;

    default:
      body = null;
  }

  return (
    <div className={className} aria-busy={waiting} data-state={state}>
      <p className="nc-sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      {body}
    </div>
  );
}

/**
 * One short sentence per state change, and nothing while a state persists —
 * a live region that re-announces on every poll is unusable.
 */
function useAnnouncement(state: DataViewState, label: string): string {
  const previous = useRef<DataViewState | null>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (previous.current === state) return;
    const wasLoading = previous.current === 'loading' || previous.current === null;
    previous.current = state;

    switch (state) {
      case 'loading':
        setMessage(`Loading ${label}.`);
        break;
      case 'ready':
        setMessage(wasLoading ? `${label} loaded.` : `${label} updated.`);
        break;
      case 'empty':
        setMessage(`No ${label}.`);
        break;
      case 'error':
        setMessage(`Could not load ${label}.`);
        break;
      case 'offline':
        setMessage(`Offline. Showing the last saved ${label}.`);
        break;
      default:
        setMessage('');
    }
  }, [state, label]);

  return message;
}
