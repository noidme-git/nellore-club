'use client';

/**
 * The live-polling contract. **API.md §8.4 is normative and this file
 * implements it exactly.**
 *
 * ```
 * 1. Poll only while the tab is visible. On visibilitychange→hidden stop; on
 *    →visible poll once immediately and resume.
 * 2. Wait Poll-After seconds × a random jitter in [0.85, 1.15].
 * 3. Always send If-None-Match with the last ETag.          (useResource does this)
 * 4. After each consecutive 304, ×1.5, capped at 120 s. Reset on any 200.
 * 5. On 429, honour Retry-After exactly and do not multiply.
 * 6. On a network error, exponential backoff 5 s → 120 s with jitter; do not
 *    count these toward the 304 streak.
 * 7. Never poll faster than 5 s regardless of what the server says.
 * 8. ONE poller per tab per slug, shared across the bracket/standings/entrants
 *    views — three components on one page must not each open their own timer.
 * ```
 *
 * Rule 2 is the one that looks cosmetic and is not. Four hundred phones that
 * opened the same WhatsApp message in the same second would otherwise poll in
 * lockstep forever, turning a smooth 5–7 invocations/second into a spike every
 * ten seconds for three hours.
 *
 * Rule 8 is why the timer lives in a module-level registry keyed by slug rather
 * than in a `useEffect`: the bracket, the standings table and the entrant count
 * are three components with three different endpoints on one screen, and they
 * must share one clock. Each registers a callback; one tick fans out to all of
 * them; the group's backoff is decided from the union of their answers.
 *
 * Beyond §8.4, IA.md §7.4 adds the connection gate: on `saveData` or a 2g
 * `effectiveType` polling is **off entirely** and the toolbar shows a Refresh
 * button instead. Someone on a metered 2g connection did not agree to a
 * background download every ten seconds.
 */

import { useEffect, useRef, useState } from 'react';

/** What a subscriber reports back so the group can pick the next interval. */
export type PollOutcome =
  /** A `200`: something changed. Resets the backoff. */
  | 'changed'
  /** A `304`: nothing changed. Advances the ×1.5 backoff. */
  | 'unchanged'
  /** No response arrived. Exponential backoff; does NOT touch the 304 streak. */
  | 'error'
  /** A `429`. `Retry-After` is honoured exactly and the interval is not multiplied. */
  | 'rate_limited'
  /** The subscriber chose not to poll this tick (disabled, already in flight). */
  | 'skipped';

/** API.md §8.4 rule 7. */
export const MIN_INTERVAL_SECONDS = 5;
/** API.md §8.4 rule 4. */
export const MAX_INTERVAL_SECONDS = 120;
/** Used when the server sent no `Poll-After` at all. */
export const DEFAULT_INTERVAL_SECONDS = 60;
/** API.md §8.4 rule 6: network-error backoff floor and growth. */
const ERROR_BACKOFF_START_SECONDS = 5;

export interface PollerState {
  /** A timer is scheduled. */
  active: boolean;
  /** The tab is hidden. Resumes with an immediate poll on return. */
  paused: boolean;
  /**
   * Polling is off for the session: `saveData`, a 2g connection, or every
   * subscriber saying `Poll-After: 0`. The view shows a Refresh button.
   */
  disabled: boolean;
  disabledReason: 'save_data' | 'slow_connection' | 'not_pollable' | null;
  /** Seconds until the next tick, as last scheduled. */
  intervalSeconds: number;
  /** Consecutive ticks in which nothing changed. Drives the ×1.5 backoff. */
  unchangedStreak: number;
}

interface Subscriber {
  onPoll: () => Promise<PollOutcome> | PollOutcome;
  /** The server's `Poll-After` for this subscriber's endpoint. `0` = never poll. */
  pollAfter: number | null;
  notify: (state: PollerState) => void;
}

interface Group {
  key: string;
  subscribers: Map<number, Subscriber>;
  timer: ReturnType<typeof setTimeout> | null;
  unchangedStreak: number;
  errorStreak: number;
  /** Set by a 429: the exact wall-clock time the next poll may happen. */
  retryNotBefore: number | null;
  ticking: boolean;
  state: PollerState;
}

const groups = new Map<string, Group>();
let nextSubscriberId = 1;

const IDLE_STATE: PollerState = {
  active: false,
  paused: false,
  disabled: false,
  disabledReason: null,
  intervalSeconds: DEFAULT_INTERVAL_SECONDS,
  unchangedStreak: 0,
};

/* =====================================================================
 * Connection and visibility gates
 * ===================================================================== */

interface NetworkInformationLike {
  saveData?: boolean;
  effectiveType?: string;
}

/**
 * IA.md §7.4. `navigator.connection` is Chromium-only, which is most of the
 * target audience; its absence is treated as "unmetered", because assuming a
 * fast link on Safari is the same assumption the rest of the web makes and the
 * alternative is disabling live scores on every iPhone.
 */
function connectionGate(): PollerState['disabledReason'] {
  if (typeof navigator === 'undefined') return null;
  const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
  if (connection === undefined) return null;
  if (connection.saveData === true) return 'save_data';
  const type = connection.effectiveType;
  if (type === '2g' || type === 'slow-2g') return 'slow_connection';
  return null;
}

function isVisible(): boolean {
  if (typeof document === 'undefined') return false;
  return document.visibilityState === 'visible';
}

/** API.md §8.4 rule 2. */
function jitter(): number {
  return 0.85 + Math.random() * 0.3;
}

/* =====================================================================
 * The group
 * ===================================================================== */

function baseInterval(group: Group): number | null {
  let base: number | null = null;
  let anyPollable = false;

  for (const subscriber of group.subscribers.values()) {
    const value = subscriber.pollAfter;
    // `Poll-After: 0` means "do not poll this endpoint" — /overview says it
    // about itself. A subscriber that says 0 does not contribute a cadence, but
    // it must not veto one either: the bracket next to it still polls.
    if (value === null) continue;
    if (value <= 0) continue;
    anyPollable = true;
    base = base === null ? value : Math.min(base, value);
  }

  if (!anyPollable) {
    // No subscriber has yet seen a Poll-After. Poll at the conservative default
    // until one does, rather than never polling a page whose first response has
    // not arrived.
    const anyUnknown = [...group.subscribers.values()].some((s) => s.pollAfter === null);
    return anyUnknown ? DEFAULT_INTERVAL_SECONDS : null;
  }

  return base;
}

function nextIntervalSeconds(group: Group): number | null {
  const base = baseInterval(group);
  if (base === null) return null;

  if (group.errorStreak > 0) {
    // Rule 6: exponential from 5 s to 120 s, jittered, independent of the 304
    // streak — a flaky connection must not make a live bracket act "settled".
    const backoff = Math.min(
      ERROR_BACKOFF_START_SECONDS * 2 ** (group.errorStreak - 1),
      MAX_INTERVAL_SECONDS,
    );
    return Math.max(MIN_INTERVAL_SECONDS, backoff * jitter());
  }

  // Rule 4: ×1.5 per consecutive 304, capped at 120 s. The cap is applied
  // before the jitter, so the jitter can put one tick a little past 120 s —
  // which is the intent: the cap bounds the cadence, not every sample.
  const multiplied = base * 1.5 ** group.unchangedStreak;
  const capped = Math.min(Math.max(multiplied, MIN_INTERVAL_SECONDS), MAX_INTERVAL_SECONDS);
  return Math.max(MIN_INTERVAL_SECONDS, capped * jitter());
}

function publish(group: Group, patch: Partial<PollerState>): void {
  group.state = { ...group.state, ...patch };
  for (const subscriber of group.subscribers.values()) subscriber.notify(group.state);
}

function clearTimer(group: Group): void {
  if (group.timer !== null) {
    clearTimeout(group.timer);
    group.timer = null;
  }
}

function schedule(group: Group): void {
  clearTimer(group);

  if (group.subscribers.size === 0) return;

  const reason = connectionGate();
  if (reason !== null) {
    publish(group, { active: false, paused: false, disabled: true, disabledReason: reason });
    return;
  }

  if (!isVisible()) {
    // Rule 1. Not "disabled": the view keeps its freshness chip and resumes
    // with one immediate poll when the tab comes back.
    publish(group, { active: false, paused: true, disabled: false, disabledReason: null });
    return;
  }

  const interval = nextIntervalSeconds(group);
  if (interval === null) {
    publish(group, {
      active: false,
      paused: false,
      disabled: true,
      disabledReason: 'not_pollable',
    });
    return;
  }

  // Rule 5: a 429 pins the next poll to the exact Retry-After the server gave.
  const now = Date.now();
  const earliest = group.retryNotBefore ?? 0;
  const delayMs = Math.max(interval * 1000, earliest - now);

  publish(group, {
    active: true,
    paused: false,
    disabled: false,
    disabledReason: null,
    intervalSeconds: Math.round(delayMs / 1000),
    unchangedStreak: group.unchangedStreak,
  });

  group.timer = setTimeout(() => {
    void tick(group);
  }, delayMs);
}

async function tick(group: Group): Promise<void> {
  if (group.ticking) return;
  group.ticking = true;

  const results = await Promise.all(
    [...group.subscribers.values()].map(async (subscriber): Promise<PollOutcome> => {
      try {
        return await subscriber.onPoll();
      } catch {
        // A subscriber that throws is treated as a transport failure rather
        // than being allowed to kill the shared timer for every other view on
        // the page.
        return 'error';
      }
    }),
  );

  group.ticking = false;

  if (results.includes('rate_limited')) {
    // The subscriber that saw the 429 has already set `retryNotBefore` via
    // `reportRateLimit`. Rule 5: do not multiply.
    group.errorStreak = 0;
  } else if (results.includes('error')) {
    group.errorStreak += 1;
  } else if (results.includes('changed')) {
    // Rule 4: any 200 resets the backoff, for the whole group. A score landing
    // in the bracket means the standings are about to change too.
    group.errorStreak = 0;
    group.unchangedStreak = 0;
  } else if (results.includes('unchanged')) {
    group.errorStreak = 0;
    group.unchangedStreak += 1;
  }

  schedule(group);
}

function getGroup(key: string): Group {
  let group = groups.get(key);
  if (group === undefined) {
    group = {
      key,
      subscribers: new Map(),
      timer: null,
      unchangedStreak: 0,
      errorStreak: 0,
      retryNotBefore: null,
      ticking: false,
      state: IDLE_STATE,
    };
    groups.set(key, group);
  }
  return group;
}

/* ---- Global visibility and connection listeners, bound once ---- */

let globalListenersBound = false;

function onVisibilityChange(): void {
  for (const group of groups.values()) {
    if (isVisible() && group.subscribers.size > 0) {
      // Rule 1: "on visible, poll once immediately (with If-None-Match) and
      // resume". The immediate poll is what makes coming back to a tab feel
      // instant rather than up-to-two-minutes stale.
      clearTimer(group);
      void tick(group);
    } else {
      schedule(group);
    }
  }
}

function onConnectionChange(): void {
  for (const group of groups.values()) schedule(group);
}

function bindGlobalListeners(): void {
  if (globalListenersBound || typeof document === 'undefined') return;
  globalListenersBound = true;
  document.addEventListener('visibilitychange', onVisibilityChange);

  const connection = (navigator as Navigator & { connection?: EventTarget }).connection;
  connection?.addEventListener('change', onConnectionChange);
}

/* =====================================================================
 * Public API
 * ===================================================================== */

/**
 * Tell the poller a 429 was seen and when the server said to come back.
 * Called by whoever made the request, because only they saw the header.
 */
export function reportRateLimit(key: string, retryAfterSeconds: number): void {
  const group = groups.get(key);
  if (group === undefined) return;
  const seconds = Math.max(1, Math.trunc(retryAfterSeconds));
  group.retryNotBefore = Date.now() + seconds * 1000;
}

/** Force a tick now — the freshness chip's tap target and the Refresh button. */
export function pollNow(key: string): void {
  const group = groups.get(key);
  if (group === undefined) return;
  clearTimer(group);
  void tick(group);
}

export interface UsePollerOptions {
  /**
   * The sharing key. **Use the tournament slug**, so the bracket, standings and
   * entrants views on one page share one timer (rule 8).
   */
  key: string;
  enabled?: boolean;
  /** The server's `Poll-After` for this subscriber's endpoint, in seconds. */
  pollAfter?: number | null;
  /** Revalidate. Resolve with what happened so the group can pick the next interval. */
  onPoll: () => Promise<PollOutcome> | PollOutcome;
}

/**
 * Join the poller for `key`. Returns the shared group's state, which is what
 * the toolbar renders: a Refresh button when `disabled`, nothing when
 * `paused` (the tab is not visible, so nobody is looking).
 */
export function usePoller(options: UsePollerOptions): PollerState {
  const { key, enabled = true, pollAfter = null, onPoll } = options;
  const [state, setState] = useState<PollerState>(IDLE_STATE);

  // The callback identity changes on every render of a component that closes
  // over its own state; holding it in a ref keeps the subscription stable so a
  // re-render does not tear down and rebuild the shared timer.
  const onPollRef = useRef(onPoll);
  onPollRef.current = onPoll;

  useEffect(() => {
    if (!enabled) {
      setState(IDLE_STATE);
      return;
    }

    bindGlobalListeners();

    const group = getGroup(key);
    const id = nextSubscriberId;
    nextSubscriberId += 1;

    group.subscribers.set(id, {
      onPoll: () => onPollRef.current(),
      pollAfter,
      notify: setState,
    });

    schedule(group);

    return () => {
      group.subscribers.delete(id);
      if (group.subscribers.size === 0) {
        clearTimer(group);
        groups.delete(key);
      } else {
        schedule(group);
      }
    };
  }, [key, enabled, pollAfter]);

  return state;
}

/** Test seam: drop every timer and every group. */
export function resetPollers(): void {
  for (const group of groups.values()) clearTimer(group);
  groups.clear();
}
