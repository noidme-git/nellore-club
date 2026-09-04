'use client';

/**
 * Offline detection. IA.md §7.3.
 *
 * **`navigator.onLine` lies.** On Android it reports `true` whenever there is
 * *a* network interface up, which includes a captive-portal wifi that answers
 * every request with a login page, a hotel wifi that has stopped forwarding,
 * and the fifteen seconds after a train enters a tunnel. On a venue's
 * overloaded wifi it is true continuously while nothing loads at all.
 *
 * So the signal is the union of two things, exactly as IA.md §7.3 specifies:
 *
 *   1. the `offline` **event** (which is trustworthy in the negative direction
 *      — the browser only fires it when it is sure), **or**
 *   2. **two consecutive fetch failures** (the empirical signal that actually
 *      matches what the user is experiencing).
 *
 * Recovery is symmetric and deliberately asymmetric in trust: the `online`
 * event clears only the event half, because it is the direction
 * `navigator.onLine` is wrong about. The failure half is cleared by a request
 * that actually succeeded.
 *
 * A failure here means **no HTTP response arrived** — `NetworkError` from
 * `lib/api`. A 404, a 409 or a 500 is not being offline; counting them would
 * put the offline bar on the screen of a player whose tournament slug was
 * mistyped, and the Retry button would never help.
 */

import { useEffect, useSyncExternalStore } from 'react';

/** IA.md §7.3: "two consecutive fetch failures". */
export const FAILURE_THRESHOLD = 2;

export interface OfflineState {
  offline: boolean;
  /** Consecutive transport failures since the last success. */
  failures: number;
  /** Device time (unix seconds) the offline state began, or `null`. */
  since: number | null;
  /** Which signal fired. `event` is the browser's; `failures` is ours. */
  reason: 'event' | 'failures' | null;
}

const ONLINE: OfflineState = { offline: false, failures: 0, since: null, reason: null };

let snapshot: OfflineState = ONLINE;
let eventOffline = false;
let failures = 0;

const listeners = new Set<() => void>();

function recompute(): void {
  const offline = eventOffline || failures >= FAILURE_THRESHOLD;
  const reason: OfflineState['reason'] = eventOffline ? 'event' : offline ? 'failures' : null;

  if (
    snapshot.offline === offline &&
    snapshot.failures === failures &&
    snapshot.reason === reason
  ) {
    return;
  }

  snapshot = {
    offline,
    failures,
    // Keep the original timestamp while we stay offline: the offline bar reads
    // "showing data from 7:41 PM IST" and that time must not creep forward.
    since: offline ? (snapshot.since ?? Math.floor(Date.now() / 1000)) : null,
    reason,
  };

  for (const listener of listeners) listener();
}

/** Call on a `NetworkError` — never on an `ApiError`. */
export function reportNetworkFailure(): void {
  failures += 1;
  recompute();
}

/** Call on any response, including a 4xx: the transport worked. */
export function reportNetworkSuccess(): void {
  if (failures === 0 && !eventOffline) return;
  failures = 0;
  eventOffline = false;
  recompute();
}

/** Test seam. */
export function resetOfflineState(): void {
  failures = 0;
  eventOffline = false;
  snapshot = ONLINE;
  for (const listener of listeners) listener();
}

export function getOfflineSnapshot(): OfflineState {
  return snapshot;
}

let bound = false;

function handleOffline(): void {
  eventOffline = true;
  recompute();
}

function handleOnline(): void {
  // Only the event half. `navigator.onLine` going true means an interface came
  // up, not that requests succeed; the failure count stands until one does.
  eventOffline = false;
  recompute();
}

function bindWindowEvents(): void {
  if (bound || typeof window === 'undefined') return;
  bound = true;
  window.addEventListener('offline', handleOffline);
  window.addEventListener('online', handleOnline);
  // Seed from the browser's opinion once. It is trustworthy in this direction:
  // `onLine === false` genuinely means no interface at all.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    eventOffline = true;
    recompute();
  }
}

function subscribe(listener: () => void): () => void {
  bindWindowEvents();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): OfflineState {
  return snapshot;
}

/** A static export prerenders as online; there is no network at build time. */
function getServerSnapshot(): OfflineState {
  return ONLINE;
}

/**
 * The offline signal. Drives the global `OfflineBar`, disables mutating
 * controls (IA.md §7.3 "Write attempts while offline"), and pauses the poller.
 */
export function useOffline(): OfflineState {
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Listeners are bound on first subscribe; this covers the case where a
  // component reads the state without any subscriber having mounted yet.
  useEffect(bindWindowEvents, []);

  return state;
}
