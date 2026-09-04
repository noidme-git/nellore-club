/**
 * The one fetch wrapper. API.md §0.4/§0.5/§0.10, AUTH.md §12.
 *
 * Everything the browser half knows about HTTP lives here: the envelope is
 * unwrapped in one place, an error becomes a typed `ApiError` in one place, and
 * the CSRF token, the idempotency key and `credentials: 'same-origin'` are
 * attached in one place. A component that calls `fetch` directly is a bug —
 * it will be the one that forgets `X-CSRF-Token` and 403s on match day.
 *
 * Four decisions worth the words:
 *
 *  - **`credentials: 'same-origin'` is stated explicitly** even though it is the
 *    default for a same-origin request. A later refactor to an absolute origin
 *    would otherwise silently stop sending the session cookie, and the symptom
 *    is "everyone is signed out", not a type error (AUTH.md §12).
 *  - **The CSRF token is read from a bridge, never from storage.** AUTH.md §5.7:
 *    it is deliberately not a cookie and is held in memory only, so XSS cannot
 *    read it and it does not outlive the session.
 *  - **Retries are bounded and counted per call, never per handler.** The
 *    `csrf_failed` → refresh → retry path is exactly one retry; a second
 *    failure is treated as a 401. AUTH.md §12 says "never loop", and an
 *    unbounded refresh loop against a rate-limited endpoint is a self-inflicted
 *    denial of service.
 *  - **A conditional GET returns `notModified`, it does not throw.** A 304 is
 *    the *expected* answer during a live event (API.md §8.3) and costs ~200
 *    bytes; making the happy path an exception would put a throw on the hot
 *    path of every poll on every phone in the hall.
 */

import type {
  ApiCollection,
  ApiErrorDetails,
  ApiErrorEnvelope,
  ApiResponseMeta,
  ApiSuccess,
  ErrorCode,
  FieldErrors,
  JsonObject,
  PageInfo,
} from '../types';

/** API.md §0.2. Always apex-relative — never an absolute origin. */
export const API_BASE = '/api/v1';

/** API.md §0.3: the hard cap for JSON endpoints. */
export const MAX_BODY_BYTES = 64 * 1024;

/** The two endpoints API.md §0.3 exempts: lobby results and reseed. */
export const MAX_BODY_BYTES_LARGE = 256 * 1024;

/** Long enough for a cold Worker on 4G, short enough that a dead socket is not forever. */
export const DEFAULT_TIMEOUT_MS = 15_000;

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/* =====================================================================
 * Response metadata
 * ===================================================================== */

export interface RateLimitInfo {
  limit: number | null;
  remaining: number | null;
  /** Unix seconds, or seconds-until-reset — the Worker sends the former. */
  reset: number | null;
}

/**
 * `ApiResponseMeta` (lib/types) plus the two facts only the transport knows.
 *
 * `cacheControl` is here for exactly one reason: API.md §8.5 makes it the
 * client's test for whether `X-NC-Now` may be trusted. A cached public GET can
 * carry an `X-NC-Now` that is minutes stale, and seeding the clock skew from it
 * produces a confidently wrong countdown on a phone whose clock is correct.
 */
export interface ResponseMeta extends ApiResponseMeta {
  status: number;
  cacheControl: string | null;
  /** Seconds, from `Retry-After`. Present on every 429 and 503. */
  retryAfter: number | null;
  rateLimit: RateLimitInfo | null;
}

export interface ApiOk<T> {
  notModified: false;
  status: number;
  data: T;
  /** Present on and only on collection responses (API.md §0.4). */
  page: PageInfo | null;
  /** The optional `meta` object of the envelope, where an endpoint documents one. */
  extra: JsonObject | null;
  meta: ResponseMeta;
}

export interface ApiNotModified {
  notModified: true;
  status: 304;
  data: null;
  page: null;
  extra: null;
  meta: ResponseMeta;
}

export type ApiOutcome<T> = ApiOk<T> | ApiNotModified;

/* =====================================================================
 * Errors
 * ===================================================================== */

/**
 * A structured non-2xx from the API. Callers branch on `code`, never on
 * `message` (API.md §0.6) — `message` is player-facing English and is expected
 * to be reworded.
 */
export class ApiError extends Error {
  readonly name = 'ApiError';
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: ApiErrorDetails | undefined;
  /** ULID. This is what a player quotes to an organizer when something breaks. */
  readonly requestId: string;
  readonly retryAfter: number | null;
  readonly meta: ResponseMeta;

  constructor(init: {
    status: number;
    code: ErrorCode;
    message: string;
    details?: ApiErrorDetails;
    requestId: string;
    meta: ResponseMeta;
  }) {
    super(init.message);
    this.status = init.status;
    this.code = init.code;
    this.details = init.details;
    this.requestId = init.requestId;
    this.meta = init.meta;
    this.retryAfter =
      init.meta.retryAfter ??
      (typeof init.details?.retry_after === 'number' ? init.details.retry_after : null);
  }

  /** `details.fields` for `validation_failed`: `{ field_name: reason_code }`. */
  get fields(): FieldErrors {
    return this.details?.fields ?? {};
  }

  /** The session is gone. The SPA clears its auth context and shows the sign-in sheet. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  /** Someone else wrote first. The organizer is shown `details.current` and chooses. */
  get isStaleVersion(): boolean {
    return this.code === 'stale_version';
  }

  get isRateLimited(): boolean {
    return this.status === 429;
  }

  /**
   * Worth retrying on its own later: the server said so, or the database blinked.
   * A `validation_failed` is not retryable and a spinner that retries it forever
   * is how a form becomes unusable.
   */
  get isRetryable(): boolean {
    return this.status === 429 || this.status === 503 || this.code === 'idempotency_in_progress';
  }
}

/** The request never produced an HTTP response: offline, DNS, TLS, abort, timeout. */
export class NetworkError extends Error {
  readonly name = 'NetworkError';
  readonly path: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;

  constructor(message: string, init: { path: string; timedOut?: boolean; aborted?: boolean; cause?: unknown }) {
    super(message, { cause: init.cause });
    this.path = init.path;
    this.timedOut = init.timedOut ?? false;
    this.aborted = init.aborted ?? false;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

export function isNetworkError(value: unknown): value is NetworkError {
  return value instanceof NetworkError;
}

/* =====================================================================
 * Configuration — the auth bridge
 * ===================================================================== */

/**
 * What the auth provider installs so this module can satisfy AUTH.md §12
 * without importing a React context, `@simplewebauthn/browser`, or anything
 * else. `lib/api` depends on `lib/types` and nothing else (ARCHITECTURE.md §4).
 *
 * Every member is optional: the public read paths work with no bridge at all,
 * which is what makes the tournament page render for a signed-out phone in one
 * paint.
 */
export interface AuthBridge {
  /** In-memory CSRF token from `GET /auth/session`. `null` when anonymous. */
  csrfToken(): string | null;
  /** Re-fetch `GET /auth/session`; resolve with the fresh token, or `null`. */
  refreshSession(): Promise<string | null>;
  /**
   * Run the passkey ceremony with `userVerification: 'required'` for the
   * already-signed-in user. Resolve `true` when the session was rotated and the
   * original request is worth retrying.
   */
  stepUp(reason: 'step_up_required' | 'uv_required'): Promise<boolean>;
  /** Clear the auth context and show the sign-in sheet, preserving the pending action. */
  onUnauthenticated(error: ApiError): void;
  /** The 43-char guest capability token for `/api/v1/guest/*` (API.md §3.5). */
  guestToken(): string | null;
  /** Test seam. Never set in production. */
  fetchImpl: typeof fetch;
}

const bridge: Partial<AuthBridge> = {};

export function configureApi(next: Partial<AuthBridge>): void {
  Object.assign(bridge, next);
}

/** Drops every installed hook. Used by tests and by sign-out. */
export function resetApiConfig(): void {
  for (const key of Object.keys(bridge)) {
    delete bridge[key as keyof AuthBridge];
  }
}

/* =====================================================================
 * Query strings
 * ===================================================================== */

export type QueryValue = string | number | boolean | null | undefined | (string | number)[];
export type QueryParams = Record<string, QueryValue>;

/**
 * `null` and `undefined` are dropped, arrays are comma-joined (API.md uses
 * comma-separated enums throughout, never repeated keys), booleans become
 * `true`/`false`.
 *
 * Key order is preserved as written, not sorted. The Worker's cache key is the
 * full URL, so two call sites that build the same filter set in different
 * orders would otherwise be two edge-cache entries for one answer.
 */
export function buildQuery(params: QueryParams | undefined): string {
  if (params === undefined) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      search.set(key, value.join(','));
      continue;
    }
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded === '' ? '' : `?${encoded}`;
}

/**
 * `/tournaments/:slug` + params → the path this module fetches and the
 * `localStorage` cache is keyed on. Exported so `useResource` and `usePoller`
 * key on exactly the string that was requested.
 */
export function apiPath(path: string, params?: QueryParams): string {
  const normalised = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE}${normalised}${buildQuery(params)}`;
}

/* =====================================================================
 * Idempotency keys — API.md §6.1
 * ===================================================================== */

/**
 * One key per **logical attempt**, reused across every retry of that attempt.
 * A fresh key per retry defeats the entire mechanism: the audience is on patchy
 * 4G, a registration POST that times out client-side has almost certainly
 * reached the Worker, and the retry must not create a second entrant.
 */
export function newIdempotencyKey(): string {
  // Structurally typed rather than as `Crypto`: `worker/tsconfig.json` includes
  // `../lib/**` and checks this file against `@cloudflare/workers-types`, whose
  // `Crypto` and the DOM's are different declarations of the same object.
  const c = (globalThis as unknown as {
    crypto?: {
      randomUUID?: () => string;
      getRandomValues?: (array: Uint8Array) => Uint8Array;
    };
  }).crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();

  // Every target browser has getRandomValues; this branch is for a stripped
  // test environment, and it is still CSPRNG-backed where one exists.
  const bytes = new Uint8Array(16);
  if (typeof c?.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/* =====================================================================
 * The request
 * ===================================================================== */

export interface RequestOptions {
  method?: HttpMethod;
  query?: QueryParams;
  /** Serialised as JSON. `undefined` means no body and no `Content-Type`. */
  body?: unknown;
  /** Sent as `If-None-Match`. A match answers `304` and `notModified: true`. */
  ifNoneMatch?: string | null;
  /** API.md §6.1. Required on the ten endpoints listed there. */
  idempotencyKey?: string | null;
  /** Overrides the bridge's guest token for `/guest/*`. */
  guestToken?: string | null;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Raise to `MAX_BODY_BYTES_LARGE` for lobby-results and reseed. */
  maxBodyBytes?: number;
  /**
   * Skip the AUTH.md §12 recovery ladder (session refresh, step-up). Set by the
   * session endpoints themselves, so a failing `GET /auth/session` cannot
   * recurse into refreshing the session.
   */
  noAuthRecovery?: boolean;
}

const MUTATION_METHODS: ReadonlySet<HttpMethod> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function parseIntHeader(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null) return null;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : null;
}

function readMeta(response: Response): ResponseMeta {
  const headers = response.headers;
  const limit = parseIntHeader(headers, 'RateLimit-Limit');
  const remaining = parseIntHeader(headers, 'RateLimit-Remaining');
  const reset = parseIntHeader(headers, 'RateLimit-Reset');

  return {
    status: response.status,
    requestId: headers.get('X-Request-Id'),
    ncNow: parseIntHeader(headers, 'X-NC-Now'),
    etag: headers.get('ETag'),
    pollAfter: parseIntHeader(headers, 'Poll-After'),
    idempotentReplay: headers.get('Idempotent-Replay') === 'true',
    cacheControl: headers.get('Cache-Control'),
    retryAfter: parseIntHeader(headers, 'Retry-After'),
    rateLimit:
      limit === null && remaining === null && reset === null
        ? null
        : { limit, remaining, reset },
  };
}

/** UTF-8 byte length. `.length` counts UTF-16 units and under-counts Telugu by ~3×. */
function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function isCollection(value: object): value is ApiCollection<unknown> {
  return 'page' in value && Array.isArray((value as { data?: unknown }).data);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * The single entry point. Everything in `endpoints.ts` is a typed call to this.
 *
 * Throws `ApiError` for a structured non-2xx and `NetworkError` when no
 * response arrived at all — the two cases have genuinely different handling
 * (`useOffline` counts the second, never the first: a 404 is not being
 * offline).
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<ApiOutcome<T>> {
  const method = options.method ?? 'GET';
  const url = apiPath(path, options.query);
  const isMutation = MUTATION_METHODS.has(method);

  let serialisedBody: string | undefined;
  if (options.body !== undefined) {
    serialisedBody = JSON.stringify(options.body);
    const cap = options.maxBodyBytes ?? MAX_BODY_BYTES;
    if (byteLength(serialisedBody) > cap) {
      // Fail here rather than uploading 64 KiB over a 4G uplink to be told the
      // same thing. The synthetic requestId marks it as locally generated.
      throw new ApiError({
        status: 413,
        code: 'payload_too_large',
        message: 'That is too much data to send in one go.',
        requestId: 'req_local',
        meta: {
          status: 413,
          requestId: null,
          ncNow: null,
          etag: null,
          pollAfter: null,
          idempotentReplay: false,
          cacheControl: null,
          retryAfter: null,
          rateLimit: null,
        },
      });
    }
  }

  // Retry budget, per call. AUTH.md §12: one retry each, never a loop.
  let csrfRetries = 0;
  let stepUpRetries = 0;
  let inProgressRetries = 0;

  for (;;) {
    const headers = new Headers({ Accept: 'application/json' });

    if (serialisedBody !== undefined) {
      // API.md §0.3: this exact type is required on a body-bearing mutation. It
      // is a CSRF control, not a nicety — it forces a preflight cross-origin.
      headers.set('Content-Type', 'application/json; charset=utf-8');
    }
    if (options.ifNoneMatch !== null && options.ifNoneMatch !== undefined) {
      headers.set('If-None-Match', options.ifNoneMatch);
    }
    if (isMutation) {
      const token = bridge.csrfToken?.() ?? null;
      if (token !== null) headers.set('X-CSRF-Token', token);
    }
    if (options.idempotencyKey !== null && options.idempotencyKey !== undefined) {
      headers.set('Idempotency-Key', options.idempotencyKey);
    }
    const guest = options.guestToken ?? bridge.guestToken?.() ?? null;
    if (guest !== null) headers.set('X-Guest-Token', guest);

    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const onAbort = (): void => {
      controller.abort();
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    // `credentials` does not exist on workerd's `RequestInit`, and this file is
    // type-checked against both lib.dom and `@cloudflare/workers-types`
    // (worker/tsconfig.json includes `../lib/**`). The Worker never calls this
    // client; the init is assembled and cast once rather than dropping the
    // browser property that AUTH.md §12 requires to be explicit.
    const init = {
      method,
      headers,
      body: serialisedBody,
      // Stated, not inherited. See the file header.
      credentials: 'same-origin',
      redirect: 'follow',
      signal: controller.signal,
    } as unknown as Parameters<typeof fetch>[1];

    let response: Response;
    try {
      response = await (bridge.fetchImpl ?? fetch)(url, init);
    } catch (cause) {
      const aborted = options.signal?.aborted === true;
      throw new NetworkError(
        timedOut ? 'The network took too long to answer.' : 'Could not reach nellore.club.',
        { path: url, timedOut, aborted, cause },
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }

    const meta = readMeta(response);

    if (response.status === 304) {
      return { notModified: true, status: 304, data: null, page: null, extra: null, meta };
    }

    if (response.status === 204) {
      return {
        notModified: false,
        status: 204,
        data: null as T,
        page: null,
        extra: null,
        meta,
      };
    }

    const text = await response.text();
    let parsed: unknown = null;
    if (text !== '') {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = null;
      }
    }

    if (response.ok) {
      if (parsed === null || typeof parsed !== 'object' || !('data' in parsed)) {
        // A 2xx that is not an envelope means something between the phone and
        // the Worker rewrote the body — a captive portal is the usual culprit.
        throw new ApiError({
          status: response.status,
          code: 'internal_error',
          message: 'The server sent something we could not read.',
          requestId: meta.requestId ?? 'req_unknown',
          meta,
        });
      }

      const envelope = parsed as ApiSuccess<T>;
      return {
        notModified: false,
        status: response.status,
        data: envelope.data,
        page: isCollection(parsed) ? (parsed as ApiCollection<unknown>).page : null,
        extra: (envelope.meta as JsonObject | undefined) ?? null,
        meta,
      };
    }

    const error = toApiError(parsed, response.status, meta);

    if (options.noAuthRecovery !== true) {
      // ---- AUTH.md §12 error handling, in the order it is written there ----

      // 403 csrf_failed → one refresh, one retry. A second failure is a 401.
      if (error.code === 'csrf_failed' && csrfRetries === 0 && bridge.refreshSession !== undefined) {
        csrfRetries += 1;
        const token = await bridge.refreshSession();
        if (token !== null) continue;
        bridge.onUnauthenticated?.(error);
        throw error;
      }

      // 403 step_up_required / uv_required → re-run the ceremony, retry once.
      if (
        (error.code === 'step_up_required' || error.code === 'uv_required') &&
        stepUpRetries === 0 &&
        bridge.stepUp !== undefined
      ) {
        stepUpRetries += 1;
        const ok = await bridge.stepUp(error.code);
        if (ok) continue;
        throw error;
      }

      // 409 idempotency_in_progress → "client retries after 1 s" (API.md §6.1).
      // The first attempt is still running; this is the same logical attempt,
      // so the key is unchanged and a replay is the expected outcome.
      if (error.code === 'idempotency_in_progress' && inProgressRetries < 3) {
        inProgressRetries += 1;
        await sleep(Math.max(1, error.retryAfter ?? 1) * 1000);
        continue;
      }

      if (error.isUnauthenticated) {
        bridge.onUnauthenticated?.(error);
      }
    }

    throw error;
  }
}

/**
 * Every non-2xx is the §0.5 envelope — *including* ones from the routing layer,
 * the rate limiter and the unhandled-exception catch. When it is not (a
 * Cloudflare edge error page, a captive portal), a shape is synthesised from
 * the status so callers still get an `ErrorCode` to branch on.
 */
function toApiError(parsed: unknown, status: number, meta: ResponseMeta): ApiError {
  if (parsed !== null && typeof parsed === 'object' && 'error' in parsed) {
    const body = (parsed as ApiErrorEnvelope).error;
    return new ApiError({
      status,
      code: body.code,
      message: body.message,
      details: body.details,
      requestId: body.request_id ?? meta.requestId ?? 'req_unknown',
      meta,
    });
  }

  return new ApiError({
    status,
    code: statusToCode(status),
    message: genericMessage(status),
    requestId: meta.requestId ?? 'req_unknown',
    meta,
  });
}

function statusToCode(status: number): ErrorCode {
  switch (status) {
    case 400:
      return 'bad_request';
    case 401:
      return 'unauthenticated';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 405:
      return 'method_not_allowed';
    case 409:
      return 'conflict';
    case 410:
      return 'gone';
    case 413:
      return 'payload_too_large';
    case 415:
      return 'unsupported_media_type';
    case 429:
      return 'rate_limited';
    case 503:
      return 'database_unavailable';
    default:
      return 'internal_error';
  }
}

/** Player-facing English. CONTENT.md §10.6: say what happened and what to do. */
function genericMessage(status: number): string {
  if (status === 404) return "That page doesn't exist, or the link changed.";
  if (status === 429) return 'Too many requests. Try again in a moment.';
  if (status >= 500) return 'Something went wrong at our end. Try again in a moment.';
  return 'That request could not be completed.';
}

/* =====================================================================
 * Convenience wrappers
 *
 * `endpoints.ts` uses these. They unwrap `ApiOutcome` to the payload, because
 * an unconditional call can never be a 304 and forcing every call site to
 * narrow one would be noise.
 * ===================================================================== */

export async function get<T>(path: string, options: Omit<RequestOptions, 'method' | 'body'> = {}): Promise<T> {
  const result = await request<T>(path, { ...options, method: 'GET' });
  if (result.notModified) {
    // Only reachable if a caller passes `ifNoneMatch` to `get` instead of using
    // `request` — which is a programming error, not a runtime condition.
    throw new Error('get() received a 304; use request() when sending If-None-Match.');
  }
  return result.data;
}

/** A collection call: `data` and its `page` together, since a list view needs both. */
export interface Paged<T> {
  data: T[];
  page: PageInfo | null;
  meta: JsonObject | null;
}

export async function getPaged<T>(
  path: string,
  options: Omit<RequestOptions, 'method' | 'body'> = {},
): Promise<Paged<T>> {
  const result = await request<T[]>(path, { ...options, method: 'GET' });
  if (result.notModified) {
    throw new Error('getPaged() received a 304; use request() when sending If-None-Match.');
  }
  return { data: result.data, page: result.page, meta: result.extra };
}

async function send<T>(method: HttpMethod, path: string, options: RequestOptions): Promise<T> {
  const result = await request<T>(path, { ...options, method });
  if (result.notModified) throw new Error('A mutation returned 304, which cannot happen.');
  return result.data;
}

export function post<T>(path: string, options: Omit<RequestOptions, 'method'> = {}): Promise<T> {
  return send<T>('POST', path, options);
}

export function put<T>(path: string, options: Omit<RequestOptions, 'method'> = {}): Promise<T> {
  return send<T>('PUT', path, options);
}

export function patch<T>(path: string, options: Omit<RequestOptions, 'method'> = {}): Promise<T> {
  return send<T>('PATCH', path, options);
}

export function del<T>(path: string, options: Omit<RequestOptions, 'method'> = {}): Promise<T> {
  return send<T>('DELETE', path, options);
}
