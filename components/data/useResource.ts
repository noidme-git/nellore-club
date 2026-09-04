'use client';

/**
 * The data-fetching hook and its `localStorage` cache. IA.md §7.1.
 *
 * ```
 * mount ─► BOOT (read cache) ─┬─ hit  ─► STALE  (paint + "as of" chip) ─┐
 *                             └─ miss ─► LOADING (skeleton after 250 ms)┴─► READY
 *                                                     fetch throws / 5xx ─► ERROR/OFFLINE
 * ```
 *
 * Cache key `nc:v1:<method>:<path>`, value `{ etag, fetchedAt, body }`.
 * "Soft" TTL means paint from cache and revalidate; past the "hard" TTL do not
 * paint from cache at all and go to LOADING. Revalidation always sends
 * `If-None-Match`, so the steady state during a live event is a ~200-byte 304.
 *
 * **Every `localStorage` call in this file is inside a try/catch, without
 * exception.** Private-mode WebViews throw on `getItem`, Safari throws on
 * `setItem` at quota, and some Android WebViews throw on `length`. An uncaught
 * throw here happens during render of the tournament page and takes the whole
 * page down — replacing a stale bracket with a white screen, which is strictly
 * worse than having no cache at all.
 *
 * **Authenticated paths are never written to the cache.** `/me/*`,
 * `/organizer/*`, `/admin/*`, `/auth/*` and `/guest/*` are `private, no-store`
 * (API.md §8.2) and their bodies carry masked phone numbers, payment references
 * and organiser notes. Writing them to `localStorage` on a phone that gets
 * handed round a venue desk is a PII leak with no expiry (SECURITY.md §10). The
 * rule is enforced structurally here, not left to each call site.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ApiError, NetworkError, QueryParams, ResponseMeta } from '@/lib/api';
import { apiPath, isApiError, isNetworkError, request } from '@/lib/api';

import { recordServerTime } from './useClockSkew';
import { reportNetworkFailure, reportNetworkSuccess } from './useOffline';
import type { PollOutcome } from './usePoller';
import { reportRateLimit } from './usePoller';

/* =====================================================================
 * TTL table — IA.md §7.1
 * ===================================================================== */

export interface Ttl {
  /** Seconds. Past this, paint from cache AND revalidate. */
  soft: number;
  /** Seconds. Past this, do not paint from cache; go to LOADING. */
  hard: number;
}

export type TtlPreset = 'live' | 'list' | 'leaderboard' | 'static';

export const TTL: Readonly<Record<TtlPreset, Ttl>> = {
  /** bracket, live, standings, entrants. */
  live: { soft: 60, hard: 24 * 3600 },
  /** the tournament list. */
  list: { soft: 5 * 60, hard: 7 * 24 * 3600 },
  leaderboard: { soft: 10 * 60, hard: 7 * 24 * 3600 },
  /** game catalogue, club, rules — things that change on a deploy, not on a score. */
  static: { soft: 24 * 3600, hard: 30 * 24 * 3600 },
};

function resolveTtl(ttl: TtlPreset | Ttl | undefined): Ttl {
  if (ttl === undefined) return TTL.list;
  if (typeof ttl === 'string') return TTL[ttl];
  return ttl;
}

/* =====================================================================
 * The localStorage layer
 * ===================================================================== */

export const CACHE_PREFIX = 'nc:v1:';

/**
 * IA.md §7.1's 2 MB guard. Browsers meter `localStorage` in UTF-16 code units,
 * so a character costs two bytes; the budget is compared in bytes and sizes are
 * computed as `(key.length + value.length) × 2`.
 */
export const CACHE_BUDGET_BYTES = 2 * 1024 * 1024;

export interface CacheEntry<T> {
  etag: string | null;
  /** Unix seconds. Bumped on a 304, because a 304 proves the body is current. */
  fetchedAt: number;
  /** Unix seconds of the last read. The LRU key. */
  readAt: number;
  body: T;
}

/** Never cached. See the file header. */
const PRIVATE_PREFIXES = ['/api/v1/me', '/api/v1/organizer', '/api/v1/admin', '/api/v1/auth', '/api/v1/guest'];

export function isCacheablePath(path: string): boolean {
  return !PRIVATE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export function cacheKey(path: string, method = 'GET'): string {
  return `${CACHE_PREFIX}${method}:${path}`;
}

function storage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    // Accessing `localStorage` itself throws when cookies are blocked.
    return null;
  }
}

export function readCache<T>(key: string): CacheEntry<T> | null {
  const store = storage();
  if (store === null) return null;
  try {
    const raw = store.getItem(key);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as CacheEntry<T>;
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.fetchedAt !== 'number') {
      return null;
    }
    return parsed;
  } catch {
    // Corrupt JSON, a half-written entry from a killed tab, or a quota throw on
    // read. Treat it as a miss and move on; do not try to repair it here.
    return null;
  }
}

/** Update `readAt` in place so the LRU order reflects use, not just writes. */
function touchCache(key: string, entry: CacheEntry<unknown>): void {
  const store = storage();
  if (store === null) return;
  const now = Math.floor(Date.now() / 1000);
  // Throttled: rewriting a 60 KB bracket entry on every read to move a
  // timestamp by two seconds is a measurable main-thread stall on a phone.
  if (now - entry.readAt < 60) return;
  try {
    store.setItem(key, JSON.stringify({ ...entry, readAt: now }));
  } catch {
    /* A failed touch costs nothing; the entry keeps its old readAt. */
  }
}

function entryBytes(key: string, value: string): number {
  return (key.length + value.length) * 2;
}

/**
 * Least-recently-used eviction down to the budget. Called before a write that
 * would push the store over, and again after a quota throw — a browser's idea
 * of "full" and ours will not agree, and the second pass is what makes the
 * retry succeed rather than silently losing every future write.
 */
export function evictToBudget(headroomBytes = 0): void {
  const store = storage();
  if (store === null) return;

  try {
    const entries: { key: string; bytes: number; readAt: number }[] = [];
    let total = 0;

    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key === null || !key.startsWith(CACHE_PREFIX)) continue;
      const value = store.getItem(key);
      if (value === null) continue;
      const bytes = entryBytes(key, value);
      total += bytes;

      let readAt = 0;
      try {
        const parsed = JSON.parse(value) as Partial<CacheEntry<unknown>>;
        readAt = parsed.readAt ?? parsed.fetchedAt ?? 0;
      } catch {
        // An unparseable entry is worthless: sort it first so it is the first
        // thing evicted.
        readAt = 0;
      }
      entries.push({ key, bytes, readAt });
    }

    const target = CACHE_BUDGET_BYTES - headroomBytes;
    if (total <= target) return;

    entries.sort((a, b) => a.readAt - b.readAt);
    for (const entry of entries) {
      if (total <= target) break;
      try {
        store.removeItem(entry.key);
        total -= entry.bytes;
      } catch {
        /* Skip and keep going: one stuck key must not abort the sweep. */
      }
    }
  } catch {
    /* `store.length` / `store.key` throw in some WebViews. Give up quietly. */
  }
}

export function writeCache<T>(key: string, entry: CacheEntry<T>): void {
  const store = storage();
  if (store === null) return;

  let serialised: string;
  try {
    serialised = JSON.stringify(entry);
  } catch {
    // A body with a cycle cannot happen from JSON.parse, but a caller could
    // hand us anything.
    return;
  }

  const bytes = entryBytes(key, serialised);
  // A single entry larger than a quarter of the budget is not worth evicting
  // the rest of the site's cache for.
  if (bytes > CACHE_BUDGET_BYTES / 4) return;

  try {
    store.setItem(key, serialised);
    return;
  } catch {
    /* Quota. Fall through to evict and retry once. */
  }

  evictToBudget(bytes);

  try {
    store.setItem(key, serialised);
  } catch {
    /* Still no room, or private mode. The app works without a cache. */
  }
}

export function dropCache(key: string): void {
  const store = storage();
  if (store === null) return;
  try {
    store.removeItem(key);
  } catch {
    /* nothing to do */
  }
}

/** Sign-out and "clear cached data" both call this. */
export function clearResourceCache(): void {
  const store = storage();
  if (store === null) return;
  try {
    const doomed: string[] = [];
    for (let i = 0; i < store.length; i += 1) {
      const key = store.key(i);
      if (key !== null && key.startsWith(CACHE_PREFIX)) doomed.push(key);
    }
    for (const key of doomed) {
      try {
        store.removeItem(key);
      } catch {
        /* keep going */
      }
    }
  } catch {
    /* nothing to do */
  }
}

/* =====================================================================
 * The hook
 * ===================================================================== */

export type ResourceStatus = 'idle' | 'loading' | 'success' | 'error';

export interface ResourceResult<T> {
  data: T | null;
  status: ResourceStatus;
  error: ApiError | NetworkError | null;
  /** Unix seconds the body was last known current (a 304 counts). */
  fetchedAt: number | null;
  /** Painted from cache and older than the soft TTL. Drives the freshness chip. */
  stale: boolean;
  /** A request is in flight over data that is already on screen. */
  revalidating: boolean;
  fromCache: boolean;
  etag: string | null;
  /** The server's `Poll-After`, in seconds. Feed it to `usePoller`. */
  pollAfter: number | null;
  meta: ResponseMeta | null;
  /** Force a revalidate. Resolves with what happened, so `usePoller` can use it directly. */
  refresh: () => Promise<PollOutcome>;
}

export interface UseResourceOptions {
  /** Path under `/api/v1`, e.g. `/tournaments/bgmi-diwali-2026/bracket`. */
  path: string;
  query?: QueryParams;
  ttl?: TtlPreset | Ttl;
  /** `false` parks the hook in `idle` — for a view whose slug is not resolved yet. */
  enabled?: boolean;
  /** Force the cache off even for a public path (a `?q=` search, for instance). */
  cache?: boolean;
  timeoutMs?: number;
  /**
   * The `usePoller` group key, so a 429 on this resource pins the shared
   * timer's next tick. Normally the tournament slug.
   */
  pollerKey?: string;
}

interface InternalState<T> {
  data: T | null;
  status: ResourceStatus;
  error: ApiError | NetworkError | null;
  fetchedAt: number | null;
  stale: boolean;
  revalidating: boolean;
  fromCache: boolean;
  etag: string | null;
  pollAfter: number | null;
  meta: ResponseMeta | null;
}

const INITIAL: InternalState<never> = {
  data: null,
  status: 'idle',
  error: null,
  fetchedAt: null,
  stale: false,
  revalidating: false,
  fromCache: false,
  etag: null,
  pollAfter: null,
  meta: null,
};

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/**
 * Fetch one resource, with the cache, the conditional request and the TTL
 * table. Presentation — the 250 ms skeleton delay, the five display states,
 * the empty predicate — belongs to `DataView`; this hook only knows about data.
 */
export function useResource<T>(options: UseResourceOptions): ResourceResult<T> {
  const { path, query, ttl, enabled = true, cache, timeoutMs, pollerKey } = options;

  const fullPath = apiPath(path, query);
  const key = cacheKey(fullPath);
  const ttlValues = resolveTtl(ttl);
  const cacheable = (cache ?? true) && isCacheablePath(fullPath);

  const [state, setState] = useState<InternalState<T>>(INITIAL as InternalState<T>);

  // Everything the fetcher needs that must not re-create it on every render.
  const mounted = useRef(true);
  const etagRef = useRef<string | null>(null);
  const inFlight = useRef<AbortController | null>(null);
  const hasDataRef = useRef(false);

  const settings = useRef({ path, query, key, cacheable, timeoutMs, pollerKey });
  settings.current = { path, query, key, cacheable, timeoutMs, pollerKey };

  const load = useCallback(async (): Promise<PollOutcome> => {
    const s = settings.current;

    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;

    setState((prev) => ({
      ...prev,
      status: prev.data === null ? 'loading' : prev.status,
      revalidating: prev.data !== null,
    }));

    try {
      const result = await request<T>(s.path, {
        method: 'GET',
        query: s.query,
        // Only send a validator we actually have a body for. Sending one
        // without a cached body would answer 304 with nothing to paint.
        ifNoneMatch: hasDataRef.current ? etagRef.current : null,
        signal: controller.signal,
        timeoutMs: s.timeoutMs,
      });

      reportNetworkSuccess();
      recordServerTime(result.meta);

      if (!mounted.current) return 'skipped';

      if (result.notModified) {
        const at = nowSeconds();
        if (s.cacheable) {
          const cached = readCache<T>(s.key);
          // A 304 proves the cached body is current: bump `fetchedAt` so the
          // freshness chip resets and the soft TTL restarts. ~200 bytes bought
          // a fresh copy.
          if (cached !== null) writeCache(s.key, { ...cached, fetchedAt: at, readAt: at });
        }
        setState((prev) => ({
          ...prev,
          status: 'success',
          error: null,
          fetchedAt: at,
          stale: false,
          revalidating: false,
          pollAfter: result.meta.pollAfter,
          meta: result.meta,
        }));
        return 'unchanged';
      }

      const at = nowSeconds();
      etagRef.current = result.meta.etag;
      hasDataRef.current = true;

      if (s.cacheable) {
        writeCache<T>(s.key, {
          etag: result.meta.etag,
          fetchedAt: at,
          readAt: at,
          body: result.data,
        });
      }

      setState({
        data: result.data,
        status: 'success',
        error: null,
        fetchedAt: at,
        stale: false,
        revalidating: false,
        fromCache: false,
        etag: result.meta.etag,
        pollAfter: result.meta.pollAfter,
        meta: result.meta,
      });
      return 'changed';
    } catch (caught) {
      // An abort is us: a newer request superseded this one, the path changed,
      // or the view unmounted. It is never a failure, and it must not paint an
      // error card — under StrictMode's double-mount that would flash one on
      // every dev page load, and on a real navigation it would replace the
      // outgoing view with "Couldn't load".
      if (controller.signal.aborted) return 'skipped';

      if (isNetworkError(caught)) {
        if (caught.aborted) return 'skipped';
        // The transport failed. Two of these in a row is what actually means
        // "offline" on Android (IA.md §7.3) — `navigator.onLine` does not.
        reportNetworkFailure();
        if (mounted.current) {
          setState((prev) => ({
            ...prev,
            // Cached content stays on screen with the offline chip; only a
            // view with nothing to show becomes an error card.
            status: prev.data === null ? 'error' : 'success',
            error: caught,
            revalidating: false,
          }));
        }
        return 'error';
      }

      if (isApiError(caught)) {
        // An HTTP answer arrived, so the network is fine even though the
        // request is not.
        reportNetworkSuccess();
        if (caught.isRateLimited && s.pollerKey !== undefined && caught.retryAfter !== null) {
          reportRateLimit(s.pollerKey, caught.retryAfter);
        }
        if (mounted.current) {
          setState((prev) => ({
            ...prev,
            status: prev.data === null ? 'error' : 'success',
            error: caught,
            revalidating: false,
          }));
        }
        return caught.isRateLimited ? 'rate_limited' : 'error';
      }

      if (mounted.current) {
        setState((prev) => ({ ...prev, status: 'error', revalidating: false }));
      }
      return 'error';
    } finally {
      if (inFlight.current === controller) inFlight.current = null;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      inFlight.current?.abort();
    };
  }, []);

  // BOOT: read the cache and decide between STALE and LOADING, then revalidate.
  useEffect(() => {
    if (!enabled) {
      setState(INITIAL as InternalState<T>);
      return;
    }

    etagRef.current = null;
    hasDataRef.current = false;

    let painted = false;
    if (cacheable) {
      const cached = readCache<T>(key);
      if (cached !== null) {
        const age = nowSeconds() - cached.fetchedAt;
        if (age <= ttlValues.hard) {
          // Past the hard TTL the body is not shown at all — a two-day-old
          // bracket painted as if it were current is worse than a skeleton.
          etagRef.current = cached.etag;
          hasDataRef.current = true;
          painted = true;
          touchCache(key, cached);
          setState({
            data: cached.body,
            status: 'success',
            error: null,
            fetchedAt: cached.fetchedAt,
            stale: age > ttlValues.soft,
            revalidating: true,
            fromCache: true,
            etag: cached.etag,
            pollAfter: null,
            meta: null,
          });
        } else {
          dropCache(key);
        }
      }
    }

    if (!painted) {
      setState({ ...(INITIAL as InternalState<T>), status: 'loading' });
    }

    void load();

    return () => {
      inFlight.current?.abort();
    };
    // `ttlValues` is derived from `ttl` and would be a new object every render.
  }, [key, enabled, cacheable, ttlValues.soft, ttlValues.hard, load]);

  return {
    data: state.data,
    status: state.status,
    error: state.error,
    fetchedAt: state.fetchedAt,
    stale: state.stale,
    revalidating: state.revalidating,
    fromCache: state.fromCache,
    etag: state.etag,
    pollAfter: state.pollAfter,
    meta: state.meta,
    refresh: load,
  };
}
