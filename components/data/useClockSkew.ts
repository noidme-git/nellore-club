'use client';

/**
 * Client↔server clock offset, derived from the `X-NC-Now` response header.
 * API.md §0.10 and §8.5.
 *
 * **Every countdown in the product goes through this.** A mid-range Android
 * phone's clock is routinely minutes wrong — the OS gives up on NTP on a flaky
 * connection, and a factory-reset handset can be years out. A check-in
 * countdown computed against `Date.now()` on such a phone tells a squad the
 * window is still open twenty minutes after it closed, and the squad believes
 * the page.
 *
 * The seeding rule is narrow and is the whole correctness argument (API.md
 * §8.5):
 *
 *   **Seed only from a response carrying `Cache-Control: private, no-store`,
 *   and ignore `X-NC-Now` on any response carrying an `ETag`.**
 *
 * A public GET may be served from `caches.default`, the browser cache or a
 * downstream cache with up to an hour of `stale-while-revalidate`, so its
 * `X-NC-Now` can be an hour old. Seeding from it produces a confidently wrong
 * countdown *and* fires the "your clock is wrong" warning on a phone whose
 * clock is correct — a bug living inside the mechanism that exists to prevent
 * one. `GET /api/v1/auth/session` is called on every boot and is exactly a
 * `private, no-store` response, so there is always a trustworthy source.
 *
 * Until a trustworthy response arrives the offset is `0`, i.e. the device
 * clock. That is the right default: a slightly wrong countdown beats no
 * countdown, and `seeded` lets a UI hold back anything that must not be wrong.
 */

import { useCallback, useSyncExternalStore } from 'react';

import type { ResponseMeta } from '@/lib/api';

/** Beyond this the device clock is materially wrong and the UI should say so. */
export const SKEW_WARN_SECONDS = 120;

export interface ClockSkew {
  /** `serverNow − deviceNow`, in seconds. `0` until seeded. */
  offsetSeconds: number;
  /** True once a `private, no-store` response has been observed. */
  seeded: boolean;
  /** `|offset| > 120`. The phone's clock is wrong, not the server's. */
  suspect: boolean;
  /** Device time of the last seed, unix seconds. */
  seededAt: number | null;
}

const UNSEEDED: ClockSkew = {
  offsetSeconds: 0,
  seeded: false,
  suspect: false,
  seededAt: null,
};

/**
 * The snapshot is a stable reference that is only replaced when a value
 * actually changes. `useSyncExternalStore` compares snapshots by identity and
 * will loop forever if `getSnapshot` allocates.
 */
let snapshot: ClockSkew = UNSEEDED;

const listeners = new Set<() => void>();

function publish(next: ClockSkew): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ClockSkew {
  return snapshot;
}

/**
 * Prerender has no server and no clock offset. Returning the module constant
 * (not a fresh object) keeps hydration from mismatching.
 */
function getServerSnapshot(): ClockSkew {
  return UNSEEDED;
}

/**
 * A response is a trustworthy clock source only if it cannot have come from a
 * cache. Two independent signals, and both must hold:
 *
 *  - no `ETag` — API.md §8.5 calls this "the 'this may have come from a cache'
 *    signal, and it costs nothing to obey";
 *  - `Cache-Control` contains `no-store` — the header the Worker puts on every
 *    authenticated and every mutation response.
 */
export function isTrustworthyClockSource(meta: Pick<ResponseMeta, 'etag' | 'cacheControl'>): boolean {
  if (meta.etag !== null) return false;
  const cc = meta.cacheControl;
  return cc !== null && cc.toLowerCase().includes('no-store');
}

/**
 * Feed a response's metadata in. Called by `useResource` and by the auth
 * provider after `GET /auth/session`; safe to call with anything, since
 * untrustworthy responses are dropped here rather than at every call site.
 */
export function recordServerTime(meta: Pick<ResponseMeta, 'ncNow' | 'etag' | 'cacheControl'>): void {
  if (meta.ncNow === null || !Number.isFinite(meta.ncNow)) return;
  if (!isTrustworthyClockSource(meta)) return;

  const deviceNow = Date.now() / 1000;
  const offsetSeconds = Math.round(meta.ncNow - deviceNow);

  // Sub-second drift is noise; re-publishing it would re-render every countdown
  // on the page on every request.
  if (snapshot.seeded && Math.abs(offsetSeconds - snapshot.offsetSeconds) < 1) return;

  publish({
    offsetSeconds,
    seeded: true,
    suspect: Math.abs(offsetSeconds) > SKEW_WARN_SECONDS,
    seededAt: Math.floor(deviceNow),
  });
}

/** Corrected unix seconds. Use this, never `Date.now()`, for anything time-critical. */
export function serverNowSeconds(): number {
  return Math.floor(Date.now() / 1000) + snapshot.offsetSeconds;
}

/** Test seam, and what sign-out calls so a shared phone does not keep a stale offset. */
export function resetClockSkew(): void {
  publish(UNSEEDED);
}

/** Subscribe to the offset. Re-renders only when the offset actually moves. */
export function useClockSkew(): ClockSkew {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * A corrected `now()` that does **not** re-render on every tick. Components
 * that count down own their own interval (they choose its period from
 * `countdownTickMs`); this hook gives them the clock, not the tick.
 */
export function useServerNow(): () => number {
  const skew = useClockSkew();
  return useCallback(() => Math.floor(Date.now() / 1000) + skew.offsetSeconds, [skew.offsetSeconds]);
}
