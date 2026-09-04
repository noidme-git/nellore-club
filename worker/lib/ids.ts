/**
 * Prefixed ULIDs: mint, parse, validate.
 *
 * Every primary key in the database is `<3-char prefix>_<26-char Crockford
 * base32 ULID>`, exactly 30 characters, and every table enforces it with
 * `CHECK (id GLOB 'xxx_*' AND length(id) = 30)`.
 *
 *   trn_01JB2KQ8ZT4R9V6M0X3H7C1N2P
 *
 * Three properties are load bearing:
 *
 *   - **80 bits of CSPRNG randomness** make enumeration of tournaments and
 *     entrants infeasible, which is half the IDOR defence (the other half is
 *     the predicate check, which is mandatory anyway).
 *   - **The 48-bit millisecond timestamp prefix keeps them lexicographically
 *     sortable**, which makes cursor pagination a plain `WHERE id < ?` with no
 *     extra index and makes `audit_log`'s primary key index the chronological
 *     index.
 *   - **The type prefix** makes logs and error reports readable, and makes an id
 *     pasted into the wrong field fail at the database rather than silently
 *     matching nothing.
 *
 * IDs are minted in the Worker, never by the database, so a whole bracket —
 * including its cross-referencing source pointers — can be written in ONE
 * `.batch()`: the adapter builds the `code -> id` map before the batch and every
 * foreign key in it is a real ULID.
 *
 * NOT a ULID, and deliberately: `matches.code` (the engine's `W2-3`, `GF2`,
 * `G1R3-2`), `webauthn_challenges.challenge` (base64url), and the composite keys
 * of `match_participants`, `standings`, `tournament_organizers`,
 * `stage_entrants`, `player_ratings`, `idempotency_keys`, `rate_counters`,
 * `settings`, `slug_redirects` and `handle_reservations`.
 */

import { decodeTime, monotonicFactory } from 'ulid';
import type { PrefixedId } from '../../lib/types/db';

/**
 * The prefix registry — ARCHITECTURE.md §6.3. Every prefix is exactly three
 * lowercase letters, so the id length is uniform at 30 and the CHECK is a
 * one-liner. (`cred_` became `crd_` for exactly that reason.)
 */
export const ID_PREFIXES = {
  usr: 'user',
  ses: 'session',
  crd: 'WebAuthn credential',
  rec: 'recovery code',
  otp: 'email OTP',
  gam: 'game',
  sea: 'season',
  trn: 'tournament',
  mat: 'match',
  mad: 'match audit row',
  led: 'points ledger row',
  aud: 'audit log row',
  ann: 'announcement',
  inv: 'invite / join code',
  ven: 'venue',
  stg: 'stage',
  ent: 'entrant',
  mem: 'entrant member',
  /** Not a table row: the `request_id` echoed in every error body and `X-Request-Id`. */
  req: 'request',
} as const;

export type IdPrefix = keyof typeof ID_PREFIXES;

/** Total length: 3 prefix + 1 underscore + 26 ULID. */
export const ID_LENGTH = 30;
export const ULID_LENGTH = 26;

/**
 * Crockford base32 without I, L, O and U. The first character is capped at `7`
 * because the 48-bit timestamp cannot exceed `7ZZZZZZZZZ` — a leading `8`-`Z`
 * is a string that is 26 characters of the right alphabet and still not a ULID.
 */
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

const ID_PATTERN = /^([a-z]{3})_([0-7][0-9A-HJKMNP-TV-Z]{25})$/;

/* =====================================================================
 * The PRNG
 * ===================================================================== */

/**
 * A CSPRNG-backed `() => number` in [0, 1) for `ulid`.
 *
 * Pooled because a ULID draws sixteen random characters and the engine mints up
 * to 1024 match ids in one request: one `getRandomValues` call per character
 * would be 16,384 calls against a CPU budget that also has to run
 * `generateBracket` in 15 ms. A 256-word pool makes it 64 calls.
 *
 * `ulid`'s own `detectPRNG()` is deliberately not used. Its Node build imports
 * `node:crypto` at module scope, and this Worker runs without `nodejs_compat`;
 * passing our own PRNG means the bundler's condition resolution can never
 * become load bearing.
 */
function createCryptoPrng(poolWords = 256): () => number {
  const pool = new Uint32Array(poolWords);
  let index = pool.length;
  return () => {
    if (index >= pool.length) {
      crypto.getRandomValues(pool);
      index = 0;
    }
    const value = pool[index];
    index += 1;
    if (value === undefined) {
      // Unreachable: index was just bounds-checked. Throwing rather than
      // falling back to 0 because a ULID with a zeroed random half is an
      // enumeration oracle, and a silent one.
      throw new Error('ids: PRNG pool exhausted unexpectedly');
    }
    return value / 0x1_0000_0000;
  };
}

/**
 * One monotonic factory for the isolate.
 *
 * `monotonicFactory` guarantees that two ids minted in the same millisecond are
 * strictly increasing, by incrementing the random half rather than redrawing
 * it. That matters because workerd freezes `Date.now()` between I/O operations:
 * every id minted while assembling a 126-match double-elimination bracket
 * carries the SAME timestamp, so without monotonicity their sort order would be
 * random — and `matches` is written in topological order, `audit_log`'s primary
 * key is its chronological index, and cursor pagination is `WHERE id < ?`.
 *
 * Sharing it across requests in one isolate is correct and intended: the
 * guarantee needed is "later id sorts after earlier id", which is stronger, not
 * weaker, when the sequence is global.
 */
const nextUlid = monotonicFactory(createCryptoPrng());

/* =====================================================================
 * Mint
 * ===================================================================== */

/**
 * Mint one prefixed id.
 *
 * @param prefix one of the registered three-letter prefixes
 * @param seedTimeMs optional epoch MILLISECONDS for the timestamp half. This is
 *   the one place in the system that speaks milliseconds, because that is the
 *   ULID wire format; every column, the engine and `X-NC-Now` are seconds.
 */
export function mintId<P extends IdPrefix>(prefix: P, seedTimeMs?: number): PrefixedId<P> {
  return `${prefix}_${nextUlid(seedTimeMs)}` as PrefixedId<P>;
}

/**
 * Mint `count` ids of one prefix, strictly increasing.
 *
 * The bracket adapter needs a `code -> id` map built BEFORE the batch, because
 * a match's `a_source_match_id` must already be a real ULID when the batch is
 * assembled. Doing that with a loop of `mintId` is identical; this exists so the
 * intent is visible at the call site and the count is bounded in one place.
 */
export function mintIds<P extends IdPrefix>(prefix: P, count: number): PrefixedId<P>[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`ids: count must be a non-negative integer, got ${count}`);
  }
  const out: PrefixedId<P>[] = new Array<PrefixedId<P>>(count);
  for (let i = 0; i < count; i += 1) out[i] = mintId(prefix);
  return out;
}

/**
 * The `request_id` in every error body and the `X-Request-Id` header. Prefixed
 * like everything else so a support message reading "req_01JB2K…" is
 * unambiguous about what it refers to.
 */
export function mintRequestId(): PrefixedId<'req'> {
  return mintId('req');
}

/* =====================================================================
 * Validate and parse
 * ===================================================================== */

/**
 * Is this a well-formed prefixed id, optionally of a specific type?
 *
 * Callers should ALWAYS pass the expected prefix. A route that accepts any
 * 30-character id and looks it up by primary key is how an entrant id ends up
 * in a `matches` lookup: the query returns nothing, the handler 404s, and the
 * real bug — a client sending the wrong field — is invisible. With the prefix
 * checked, it is a `400` that names the field.
 *
 * This is a shape check only. It says nothing about whether the row exists or
 * whether the caller may see it; the predicate check is always mandatory
 * (SECURITY.md §4).
 */
export function isId(value: unknown, prefix?: IdPrefix): value is PrefixedId {
  if (typeof value !== 'string' || value.length !== ID_LENGTH) return false;
  const match = ID_PATTERN.exec(value);
  if (match === null) return false;
  if (prefix !== undefined && match[1] !== prefix) return false;
  return true;
}

/** Is this a bare 26-character ULID (no prefix)? */
export function isUlid(value: unknown): value is string {
  return typeof value === 'string' && value.length === ULID_LENGTH && ULID_PATTERN.test(value);
}

export interface ParsedId {
  prefix: IdPrefix;
  /** The bare 26-character ULID half. */
  ulid: string;
  /** Epoch MILLISECONDS from the ULID's 48-bit timestamp. */
  timestampMs: number;
}

/**
 * Parse a prefixed id, or `null` if it is not one.
 *
 * Returns `null` rather than throwing because every caller is validating
 * untrusted input from a URL and wants a `400`/`404`, not an exception to
 * catch. An unregistered three-letter prefix is `null` too — a syntactically
 * valid id for a type that does not exist is a probe, not a typo.
 */
export function parseId(value: unknown): ParsedId | null {
  if (typeof value !== 'string' || value.length !== ID_LENGTH) return null;
  const match = ID_PATTERN.exec(value);
  if (match === null) return null;

  const prefix = match[1];
  const ulid = match[2];
  if (prefix === undefined || ulid === undefined) return null;
  if (!(prefix in ID_PREFIXES)) return null;

  return { prefix: prefix as IdPrefix, ulid, timestampMs: decodeTime(ulid) };
}

/**
 * Narrow an untrusted string to an id of a known type, or `null`.
 *
 * ```ts
 * const id = asId(params.id, 'trn');
 * if (id === null) throw new ApiError('not_found');
 * ```
 */
export function asId<P extends IdPrefix>(value: unknown, prefix: P): PrefixedId<P> | null {
  return isId(value, prefix) ? (value as PrefixedId<P>) : null;
}

/** The creation instant encoded in an id, in unix SECONDS to match every column. */
export function idCreatedAtSeconds(value: string): number | null {
  const parsed = parseId(value);
  return parsed === null ? null : Math.floor(parsed.timestampMs / 1000);
}

/**
 * `GET /api/v1/organizer/tournaments/:id` is THE ONE ROUTE whose `:id` is not
 * necessarily an id: it also accepts a slug, because IA.md addresses the whole
 * organiser page surface by slug (`/admin/t/<slug>/score/`) while every other
 * organiser endpoint is addressed by id. Disambiguated on the `trn_` prefix, and
 * nowhere else in the API.
 */
export function isTournamentIdOrSlug(value: string): 'id' | 'slug' {
  return isId(value, 'trn') ? 'id' : 'slug';
}
