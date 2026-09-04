/**
 * The closed error-code enum → HTTP status map, and `ApiError`.
 *
 * `ERROR_STATUS` is a `Record<ErrorCode, number>`, which is the point: adding a
 * code to `lib/types/api.ts` without adding it here is a compile error, and
 * adding one here that is not in the union is a compile error too. A code with
 * no status would otherwise fall through to 500, so a `409 stale_version` the
 * client knows how to recover from would present as an unrecoverable crash.
 *
 * Clients branch on `code`, never on `message` (API.md §0.5). The message is
 * English, safe to show a player verbatim, and must never contain a stack
 * trace, a SQL fragment, an internal id the caller cannot see, or a hostname.
 */

import type { ApiErrorDetails, ErrorCode } from '../../lib/types/api';

/**
 * API.md §0.6, plus the AUTH.md ceremony codes at the statuses stated there and
 * `no_active_season` at §4.16.
 */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  bad_request: 400,
  malformed_json: 400,
  validation_failed: 400,
  invalid_cursor: 400,

  unauthenticated: 401,
  session_expired: 401,
  guest_token_invalid: 401,

  forbidden: 403,
  csrf_failed: 403,
  origin_not_allowed: 403,
  step_up_required: 403,
  uv_required: 403,
  recovery_scope_only: 403,

  // Deliberately ambiguous: "does not exist" and "exists, is not publicly
  // visible, and you failed the predicate" are the same answer. SECURITY.md §4.
  not_found: 404,

  method_not_allowed: 405,

  conflict: 409,
  slug_taken: 409,
  handle_taken: 409,
  already_registered: 409,
  stale_version: 409,
  idempotency_key_reuse: 409,
  idempotency_in_progress: 409,
  invalid_state_transition: 409,
  bracket_exists: 409,
  bracket_locked: 409,
  registration_closed: 409,
  tournament_full: 409,
  checkin_closed: 409,
  entrant_locked: 409,
  credential_exists: 409,
  bootstrap_closed: 409,
  no_active_season: 409,

  gone: 410,

  payload_too_large: 413,
  unsupported_media_type: 415,

  rate_limited: 429,
  recovery_locked: 429,

  internal_error: 500,
  email_auth_disabled: 501,
  not_implemented: 501,
  database_unavailable: 503,

  // AUTH.md ceremony codes.
  webauthn_challenge_expired: 400,
  webauthn_verification_failed: 400,
  // A usernameless login against an account with no live credential. 401,
  // because the caller is not authenticated, not 404 — that would be an
  // enumeration oracle on handles.
  no_credentials: 401,
  invalid_recovery_code: 401,
  signup_closed: 403,
  turnstile_failed: 403,
  invalid_join_code: 403,
};

/**
 * Default messages. Every one is written to be read by a player standing in a
 * hall on bad signal, not by the developer who caused it: it says what happened
 * and what to do, and it never names a table, a column or a binding.
 *
 * A handler may override any of these with something more specific — "Team name
 * must be 2–40 characters" beats "Some of the details you entered are not
 * valid" — but the default must never be a placeholder.
 */
export const ERROR_MESSAGE: Record<ErrorCode, string> = {
  bad_request: 'That request could not be understood.',
  malformed_json: 'That request could not be read. Please try again.',
  validation_failed: 'Some of the details you entered are not valid.',
  invalid_cursor: 'This page link has expired. Load the list again.',

  unauthenticated: 'Sign in to continue.',
  session_expired: 'You have been signed out. Sign in again to continue.',
  guest_token_invalid: 'This guest link is no longer valid. Ask the organiser for a new one.',

  forbidden: 'You do not have permission to do that.',
  csrf_failed: 'Your session could not be verified. Refresh the page and try again.',
  origin_not_allowed: 'This request did not come from nellore.club.',
  step_up_required: 'Confirm it is you with your passkey to continue.',
  uv_required: 'This action needs your fingerprint, face or device PIN.',
  recovery_scope_only: 'You signed in with a recovery code. Add a passkey first.',

  not_found: 'Not found.',
  method_not_allowed: 'That method is not allowed here.',

  conflict: 'That could not be done in the current state.',
  slug_taken: 'That web address is already in use.',
  handle_taken: 'That handle is already taken.',
  already_registered: 'You are already registered for this tournament.',
  stale_version: 'Somebody else changed this while you were editing. Review their change first.',
  idempotency_key_reuse: 'That request was already used for something different.',
  idempotency_in_progress: 'That request is still being processed. Try again in a moment.',
  invalid_state_transition: 'That change is not allowed from the current state.',
  bracket_exists: 'A bracket already exists for this tournament.',
  bracket_locked: 'Results are published. Unpublish before editing.',
  registration_closed: 'Registration is not open for this tournament.',
  tournament_full: 'This tournament is full.',
  checkin_closed: 'Check-in is not open right now.',
  entrant_locked: 'This entry can no longer be changed. Ask the organiser.',
  credential_exists: 'This device already has a passkey for your account.',
  bootstrap_closed: 'An administrator already exists.',
  no_active_season: 'There is no active season, so points cannot be awarded yet.',

  gone: 'This is no longer available.',

  payload_too_large: 'That was too large to send.',
  unsupported_media_type: 'That content type is not accepted here.',

  rate_limited: 'Too many attempts. Wait a moment and try again.',
  recovery_locked: 'Too many incorrect recovery codes. Try again later.',

  internal_error: 'Something went wrong at our end. Quote the request id if you report this.',
  email_auth_disabled: 'Email sign-in is not available. Use a passkey.',
  not_implemented: 'That feature is not available yet.',
  database_unavailable: 'The service is briefly unavailable. Try again in a few seconds.',

  webauthn_challenge_expired: 'That took too long. Start again.',
  webauthn_verification_failed: 'That passkey could not be verified. Try again.',
  no_credentials: 'No passkey is registered for that account.',
  invalid_recovery_code: 'That recovery code is not valid.',
  signup_closed: 'New sign-ups are closed right now.',
  turnstile_failed: 'That check did not pass. Reload the page and try again.',
  invalid_join_code: 'That join code is not valid for this tournament.',
};

export function statusFor(code: ErrorCode): number {
  return ERROR_STATUS[code];
}

export function defaultMessageFor(code: ErrorCode): string {
  return ERROR_MESSAGE[code];
}

export interface ApiErrorInit {
  /** Overrides the default; must still be safe to show a player verbatim. */
  message?: string;
  details?: ApiErrorDetails;
  /**
   * Seconds. Sets the `Retry-After` header AND `details.retry_after`. API.md
   * §0.10 says `Retry-After` is always set on 429 and 503, and clients that
   * only read the body still need the number.
   */
  retryAfter?: number;
  /** For 405. API.md Appendix A: a 405 always carries `Allow`. */
  allow?: readonly string[];
  /** The original throw, for the log line only. NEVER serialised into the response. */
  cause?: unknown;
}

/**
 * The one error type handlers throw. `worker/lib/respond.ts` is the only thing
 * that turns it into a Response, so the envelope is constructed in exactly one
 * place and cannot drift between the router, the rate limiter and a handler.
 *
 * Anything that is NOT an `ApiError` reaching the top-level catch is a genuine
 * bug and becomes `500 internal_error` with the request id as the only
 * diagnostic the caller gets — deliberately, because the alternative is leaking
 * a D1 error string containing a fragment of a query.
 */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: ApiErrorDetails | undefined;
  readonly retryAfter: number | undefined;
  readonly allow: readonly string[] | undefined;

  constructor(code: ErrorCode, init: ApiErrorInit = {}) {
    super(init.message ?? ERROR_MESSAGE[code]);
    this.name = 'ApiError';
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.retryAfter = init.retryAfter;
    this.allow = init.allow;
    if (init.cause !== undefined) this.cause = init.cause;

    // Fold retryAfter into details so a client that reads only the body gets
    // the same number as one that reads only the header.
    if (init.retryAfter !== undefined) {
      this.details = { ...init.details, retry_after: init.retryAfter };
    } else {
      this.details = init.details;
    }
  }

  static is(value: unknown): value is ApiError {
    return value instanceof ApiError;
  }
}

/* ---------------------------------------------------------------------
 * Constructors for the codes whose `details` shape is contractual, so a
 * handler cannot emit a `stale_version` without `current_version` — which
 * would leave the client with a 409 it has no way to recover from.
 * ------------------------------------------------------------------- */

/** `details.fields` is a flat `{ field_name: reason_code }` map. */
export function validationFailed(fields: Record<string, string>, message?: string): ApiError {
  const init: ApiErrorInit = { details: { fields } };
  if (message !== undefined) init.message = message;
  return new ApiError('validation_failed', init);
}

/**
 * `current` is the fresh object, not just the number: the organiser at the
 * scorer's table needs to see what the other organiser entered, in a compare
 * sheet, before choosing. A bare version number forces a second round-trip on
 * the exact connection that caused the conflict.
 */
export function staleVersion(currentVersion: number, current?: unknown): ApiError {
  return new ApiError('stale_version', {
    details:
      current === undefined
        ? { current_version: currentVersion }
        : { current_version: currentVersion, current: current as never },
  });
}

export function invalidStateTransition(from: string, to: string, allowed: readonly string[]): ApiError {
  return new ApiError('invalid_state_transition', {
    details: { from, to, allowed: [...allowed] },
  });
}

export function rateLimited(retryAfterSeconds: number): ApiError {
  return new ApiError('rate_limited', { retryAfter: retryAfterSeconds });
}

export function methodNotAllowed(allow: readonly string[]): ApiError {
  return new ApiError('method_not_allowed', { allow });
}

/**
 * D1 threw. `Retry-After: 5` per API.md §0.6. The original error is attached as
 * `cause` for the log line and never reaches the response body — a D1 message
 * routinely contains the failing SQL.
 */
export function databaseUnavailable(cause: unknown): ApiError {
  return new ApiError('database_unavailable', { retryAfter: 5, cause });
}
