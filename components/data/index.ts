/**
 * Barrel for the shared data layer. ARCHITECTURE.md §4 rule 3:
 * `components/data/` owns loading, caching, polling and the five states of
 * IA.md §7.1; `components/ui/` takes props and never imports this module; a
 * feature component composes the two.
 */

export {
  DataView,
  useDataViewState,
  useDelayedFlag,
  SKELETON_DELAY_MS,
  SLOW_LOADING_MS,
} from './DataView';
export type {
  DataViewProps,
  DataViewRenderInfo,
  DataViewState,
  ErrorSlotInfo,
  FreshnessInfo,
  LoadingSlotInfo,
  OfflineSlotInfo,
} from './DataView';

export {
  useResource,
  TTL,
  CACHE_PREFIX,
  CACHE_BUDGET_BYTES,
  cacheKey,
  isCacheablePath,
  readCache,
  writeCache,
  dropCache,
  evictToBudget,
  clearResourceCache,
} from './useResource';
export type {
  CacheEntry,
  ResourceResult,
  ResourceStatus,
  Ttl,
  TtlPreset,
  UseResourceOptions,
} from './useResource';

export {
  usePoller,
  pollNow,
  reportRateLimit,
  resetPollers,
  MIN_INTERVAL_SECONDS,
  MAX_INTERVAL_SECONDS,
  DEFAULT_INTERVAL_SECONDS,
} from './usePoller';
export type { PollOutcome, PollerState, UsePollerOptions } from './usePoller';

export {
  useClockSkew,
  useServerNow,
  recordServerTime,
  serverNowSeconds,
  resetClockSkew,
  isTrustworthyClockSource,
  SKEW_WARN_SECONDS,
} from './useClockSkew';
export type { ClockSkew } from './useClockSkew';

export {
  useOffline,
  reportNetworkFailure,
  reportNetworkSuccess,
  resetOfflineState,
  getOfflineSnapshot,
  FAILURE_THRESHOLD,
} from './useOffline';
export type { OfflineState } from './useOffline';
