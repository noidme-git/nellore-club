/**
 * `ok()` / `err()` / `noContent()` — the ONE place a response envelope is
 * constructed.
 *
 * Every 2xx JSON response is `{ "data": … }` and every non-2xx is
 * `{ "error": { code, message, details?, request_id } }`, including the ones
 * produced by the routing layer, the rate limiter and the unhandled-exception
 * catch (API.md §0.4, §0.5). Centralising that is not tidiness: a client that
 * unwraps `data` blindly and meets a bare array from one hand-rolled handler
 * fails in a way that only shows up on the endpoint nobody tested.
 *
 * Two headers are set on EVERY response, success or failure, 304s included:
 *
 *   X-Request-Id  the ULID a player quotes to an organiser when something breaks.
 *   X-NC-Now      server epoch SECONDS. The client computes
 *                 `skew = X-NC-Now − Date.now()/1000` once and renders every
 *                 countdown against it, because a mid-range Android clock is
 *                 routinely minutes wrong and a check-in countdown that lies is
 *                 worse than no countdown.
 *
 * `X-NC-Now` must NEVER be written into a `caches.default` entry (API.md §8.5
 * rule 3) — a cached one is minutes stale, which is precisely the bug it exists
 * to prevent. `cacheHeaders()` below is the header set that is safe to store;
 * the dispatch layer re-stamps the live one on the way out.
 */

import type {
  ApiCollection,
  ApiErrorEnvelope,
  ApiSuccess,
  ErrorCode,
  JsonObject,
  PageInfo,
} from '../../lib/types/api';
import { ApiError, ERROR_MESSAGE, ERROR_STATUS } from './errors';

export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/** Everything a response needs from the request that produced it. */
export interface ResponseContext {
  /** The ULID minted at the top of dispatch and echoed as `X-Request-Id`. */
  requestId: string;
  /** Unix SECONDS. Passed in rather than read here so one request has one clock. */
  now: number;
}

export interface RespondInit {
  status?: number;
  /** Merged last, so a handler can override `Cache-Control`, add `ETag`, `Poll-After`, `Vary`. */
  headers?: HeadersInit;
  /** `meta` on the envelope. Present only where an endpoint documents it. */
  meta?: JsonObject;
}

/**
 * The base headers of every response. Kept separate from the body so a 304 —
 * which by HTTP has no body at all — still carries the request id, the clock
 * and the validator.
 */
export function baseHeaders(ctx: ResponseContext): Headers {
  const headers = new Headers();
  headers.set('X-Request-Id', ctx.requestId);
  headers.set('X-NC-Now', String(ctx.now));
  return headers;
}

function withBaseHeaders(ctx: ResponseContext, extra?: HeadersInit): Headers {
  const headers = baseHeaders(ctx);
  if (extra) {
    new Headers(extra).forEach((value, key) => headers.set(key, value));
  }
  return headers;
}

/**
 * A 2xx singleton. `data` is always an object or a value, never a bare array at
 * the top level — that is a legacy JSON-hijacking footgun and it makes client
 * code inconsistent (API.md §0.4). Use `okCollection` for a list.
 */
export function ok<T>(ctx: ResponseContext, data: T, init: RespondInit = {}): Response {
  const body: ApiSuccess<T> = init.meta === undefined ? { data } : { data, meta: init.meta };
  const headers = withBaseHeaders(ctx, init.headers);
  headers.set('Content-Type', JSON_CONTENT_TYPE);
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

/**
 * A 2xx collection: `data` plus `page`. `page` is present on and only on
 * collection responses, and `page.has_more` is the boolean form of
 * `next_cursor !== null` — both are emitted because forgetting the null check
 * is a classic infinite-loop bug.
 */
export function okCollection<T, M extends JsonObject = JsonObject>(
  ctx: ResponseContext,
  data: T[],
  page: PageInfo,
  init: Omit<RespondInit, 'meta'> & { meta?: M } = {},
): Response {
  const body: ApiCollection<T, M> =
    init.meta === undefined ? { data, page } : { data, page, meta: init.meta };
  const headers = withBaseHeaders(ctx, init.headers);
  headers.set('Content-Type', JSON_CONTENT_TYPE);
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

/**
 * Build a `PageInfo` from the rows a handler fetched. Callers must select
 * `limit + 1` rows and pass all of them: the extra row is how "is there another
 * page" is answered without a `COUNT(*)`, which API.md §0.9 forbids on a
 * user-facing read path.
 *
 * Returns the rows to actually emit alongside the page info, so the +1 row
 * cannot leak into a response by being forgotten.
 */
export function paginate<T>(
  rows: readonly T[],
  limit: number,
  cursorFor: (row: T) => string,
): { rows: T[]; page: PageInfo } {
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: page,
    page: {
      next_cursor: hasMore && last !== undefined ? cursorFor(last) : null,
      has_more: hasMore,
      limit,
    },
  };
}

/** `204 No Content` has no body at all (API.md §0.4). */
export function noContent(ctx: ResponseContext, init: Pick<RespondInit, 'headers'> = {}): Response {
  return new Response(null, { status: 204, headers: withBaseHeaders(ctx, init.headers) });
}

/**
 * `304 Not Modified` — the one non-2xx with no body, per HTTP. The validator
 * and the cache policy must be repeated here: a 304 that drops `ETag` or
 * `Cache-Control` makes the next request unconditional, which turns the
 * cheapest path in the system (1 D1 statement, ~200 bytes) back into the most
 * expensive one, 400 phones at a time.
 */
export function notModified(
  ctx: ResponseContext,
  etag: string,
  init: Pick<RespondInit, 'headers'> = {},
): Response {
  const headers = withBaseHeaders(ctx, init.headers);
  headers.set('ETag', etag);
  return new Response(null, { status: 304, headers });
}

export interface ErrInit extends Pick<RespondInit, 'headers'> {
  message?: string;
  details?: Record<string, unknown>;
  retryAfter?: number;
  allow?: readonly string[];
}

/**
 * The error envelope. Accepts either an `ApiError` (the normal path — a handler
 * throws, dispatch catches) or a bare code plus overrides.
 *
 * `Retry-After` and `Allow` are set from the error rather than left to the
 * caller, because API.md §0.10 makes them unconditional on 429/503 and 405 and
 * "the one place the envelope is built" is the only place that can guarantee it.
 */
export function err(ctx: ResponseContext, error: ApiError): Response;
export function err(ctx: ResponseContext, code: ErrorCode, init?: ErrInit): Response;
export function err(
  ctx: ResponseContext,
  errorOrCode: ApiError | ErrorCode,
  init: ErrInit = {},
): Response {
  const isApiError = ApiError.is(errorOrCode);
  const code: ErrorCode = isApiError ? errorOrCode.code : errorOrCode;
  const status = isApiError ? errorOrCode.status : ERROR_STATUS[code];
  const message = isApiError ? errorOrCode.message : (init.message ?? ERROR_MESSAGE[code]);
  const details = isApiError ? errorOrCode.details : init.details;
  const retryAfter = isApiError ? errorOrCode.retryAfter : init.retryAfter;
  const allow = isApiError ? errorOrCode.allow : init.allow;

  const body: ApiErrorEnvelope = {
    error: {
      code,
      message,
      ...(details !== undefined && Object.keys(details).length > 0
        ? { details: details as never }
        : {}),
      request_id: ctx.requestId,
    },
  };

  const headers = withBaseHeaders(ctx, init.headers);
  headers.set('Content-Type', JSON_CONTENT_TYPE);
  // An error is never edge-cached and never stored by a browser: a 409 held for
  // 30 seconds is a player who cannot retry a registration that would now work.
  headers.set('Cache-Control', 'private, no-store');
  if (retryAfter !== undefined) headers.set('Retry-After', String(retryAfter));
  if (allow !== undefined && allow.length > 0) headers.set('Allow', allow.join(', '));

  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Turn an unknown throw into a Response. Anything that is not an `ApiError` is a
 * genuine bug: it becomes `500 internal_error` with the request id as the only
 * diagnostic the caller gets, deliberately, because a D1 error string routinely
 * contains a fragment of the failing query.
 *
 * The caller is expected to log `cause` alongside the request id.
 */
export function errFromUnknown(ctx: ResponseContext, thrown: unknown): Response {
  if (ApiError.is(thrown)) return err(ctx, thrown);
  return err(ctx, 'internal_error');
}

/**
 * The header set that is SAFE TO STORE in `caches.default`.
 *
 * It deliberately omits `X-NC-Now` and `X-Request-Id`. A cached `X-NC-Now` is
 * the clock every countdown on the page is computed against, minutes stale; a
 * cached `X-Request-Id` makes two different requests indistinguishable in the
 * logs. Step 13 of dispatch re-stamps both on the way out, on cache hits and
 * 304s included.
 *
 * Companion rule (API.md §8.5, and a real optoads.com outage): write the cache
 * entry from the SAME STRING the response is built from —
 *
 *     const body = JSON.stringify(payload);
 *     ctx.waitUntil(cache.put(key, new Response(body, cacheHeaders(...))));
 *     return new Response(body, responseHeaders);
 *
 * never `cache.put(key, response.clone())`, which silently truncated a JS
 * bundle with no console error. Two Responses from one string costs nothing.
 */
export function cacheHeaders(cacheControl: string, extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set('Content-Type', JSON_CONTENT_TYPE);
  headers.set('Cache-Control', cacheControl);
  headers.delete('X-NC-Now');
  headers.delete('X-Request-Id');
  return headers;
}
