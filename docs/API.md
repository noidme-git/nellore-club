# nellore.club — HTTP API contract

**Status: normative.** The Worker implements exactly this. The static frontend calls exactly this.
Where this document and any other document disagree about a route, a header, a status code, or a
JSON field name, **this document wins** — except for authentication mechanics, where
[`AUTH.md`](./AUTH.md) wins; threat controls, where [`SECURITY.md`](./SECURITY.md) wins; and
**database table/column names and enum values, where [`db/schema.sql`](../db/schema.sql) wins.**
[`ARCHITECTURE.md`](./ARCHITECTURE.md) §6 is the canonical vocabulary and settles anything this
ordering does not.

Read this alongside:

- [`AUTH.md`](./AUTH.md) — passkeys, sessions, roles, the authorization predicate for every mutating
  route below.
- [`SECURITY.md`](./SECURITY.md) — CSRF, CSP, rate limits, PII handling, the threat model.
- `BRACKET-ENGINE.md` — the match/bracket persistence model and the format engine.
- `IA.md` — the page structure and the SPA shells.
- `CONTENT.md` — the game-definition JSON that makes the platform game-agnostic.
- `db/schema.sql` — **the** D1 DDL. It is the single source of truth for every table name, column
  name, type and enum value. Appendix E of this document is a reader's index onto it, not a rival
  definition; where they differ, `db/schema.sql` wins.
- `ARCHITECTURE.md` — the canonical vocabulary and the tie-breaker for every cross-document dispute.

### Who owns which name (read this before resolving any disagreement)

Several documents were written in parallel and each is authoritative for a different slice. When two
disagree, use this table, not the order you happened to read them in.

| Concern | Authoritative document | This document's role |
| --- | --- | --- |
| Format enum, `status` and `method` semantics, `result_version` / `bracket_version` semantics, seeding, advancement, standings computation | **`BRACKET-ENGINE.md`** (algorithms) + **`db/schema.sql`** (the actual column names) | Projects them onto the wire (§1.7) and defines the request shape that drives them (§4.13, §4.15.1). |
| Page URLs, the SPA shell assets, the boot-injection contract, navigation | **`IA.md`** | Turns them into the Worker dispatch table (Appendix A). |
| Game definitions: `registration_schema` field defs, `match_fields`, scoring blocks, tiebreakers, `multi_stage`, per-game copy | **`CONTENT.md`** | **`CONTENT.md` §3 owns `FieldDef` outright** — the `FieldType` union, the nested `Validation` object, `Condition`, `visibility`, `pii`, `profile_key`, `options`, `default`, `visible_if`, and every key name. This document reproduces **none** of it and defines no rival version (§3.3). What §3.3 owns is only the *wire* layer: the reason codes in `details.fields`, and the unknown-key rule (**reject on `POST`, drop on `PATCH`** — stated identically in CONTENT.md §3.1). `Game` (§1.2) passes the blocks through untouched. |
| Tiebreak token vocabulary | **`ARCHITECTURE.md` §6.6** (the snake_case tokens) + **`BRACKET-ENGINE.md` §4.2** (the camelCase `TiebreakKey` and the map between them) | Projects the resulting values onto `standings.tiebreak_1..5` and the `columns` array (§1.9). |
| Auth mechanics, session and cookie shape, the authorization predicate for every mutation | **`AUTH.md`** (the auth tables' DDL now lives in `db/schema.sql`) | Lists the auth endpoints' wire contract (§2). |
| Threat controls, headers, CSP, rate-limit policy, PII rules | **`SECURITY.md`** | Points at them from the endpoints they constrain. |
| **Everything else on the wire**: URL paths under `/api/v1`, HTTP methods, status codes, the error envelope, pagination, idempotency, caching and ETags, the OG-injection field list | **this document** | — |

Three consequences worth stating explicitly, because they look like conflicts and are not:

1. **`/api/v1/organizer/*` and `/api/v1/admin/*` are separate namespaces even though `IA.md` puts
   both behind one `/admin/**` page surface.** The URL namespace encodes *privilege*; the page
   namespace encodes *navigation*. One authenticated SPA shell calls both.
2. **Storage units are not wire units.** **Storage is unix seconds and integer paise/points; the
   wire format is always an RFC 3339 UTC string and an integer** (§0.8). BRACKET-ENGINE.md has been
   corrected to seconds and integers throughout — including its point arithmetic, which is now
   integral end to end with `pointsDivisor` (`BRACKET-ENGINE.md` §4.3). There is no millisecond, no
   `REAL` and no fractional score anywhere in this system.
3. **`/api/v1/organizer/tournaments/:id` is the one route whose `:id` also accepts a slug** (§4.2b),
   because the organiser page surface is addressed by slug and every organiser endpoint is addressed
   by id. It is disambiguated on the `trn_` prefix. No other route does this.

---

## 0. Ground rules

### 0.1 The shape of the system

The site is a **Next.js 15 static export**. Every page under `./out` is prerendered HTML with no
server component that runs at request time. There is no SSR, no Node runtime, no `getServerSideProps`
equivalent. **All dynamic data is fetched by the browser from this API, after hydration.**

`worker/index.ts` runs in front of Workers Static Assets with `run_worker_first: true`. It owns three
jobs and nothing else:

1. Serve `/api/*` from D1.
2. Rewrite clean dynamic URLs (`/t/<slug>`, `/p/<handle>`, `/admin/*`, `/organizer/*`) to a
   prerendered SPA shell asset, and inject per-tournament `<meta>` tags into that shell with
   `HTMLRewriter` so WhatsApp link previews work.
3. Attach cache and security headers to everything.

### 0.2 Base URL and versioning

```
https://nellore.club/api/v1
```

The version is in the path. `v1` is frozen once the club runs its first public tournament: fields may
be **added** to responses, never removed or retyped. A breaking change means `/api/v2` served
alongside `v1` for at least 90 days.

`www.nellore.club` 301-redirects to the apex before any routing happens (Appendix A, step 2). Clients
must use apex-relative URLs (`fetch('/api/v1/...')`), never an absolute origin.

### 0.3 Media types

| Direction | Rule |
| --- | --- |
| Request body | `Content-Type: application/json; charset=utf-8` is **required** on every `POST`/`PUT`/`PATCH` that has a body. Any other content type → `415 unsupported_media_type`. This is a CSRF control, not a nicety: it forces a preflight on cross-origin attempts. See SECURITY.md §5. |
| Request body size | Hard cap **64 KiB** for JSON endpoints (`413 payload_too_large`). The only exceptions: `POST /api/v1/organizer/matches/:id/lobby-results` and the reseed endpoint, capped at **256 KiB**. |
| Response body | `application/json; charset=utf-8`, except the CSV export (`text/csv`), the OG image (`image/png`), and `/healthz` (`text/plain`). |
| Encoding | UTF-8 everywhere. Reject any request body that is not valid UTF-8 (`400 malformed_json`). |

### 0.4 Success envelope

**Every** 2xx JSON response is an object with a `data` key. No endpoint ever returns a bare array at
the top level (that is a legacy JSON-hijacking footgun and it makes client code inconsistent).

```jsonc
// Singleton
{ "data": { "id": "trn_01JB2K...", "slug": "bgmi-diwali-2026", "...": "..." } }

// Collection
{
  "data": [ { "...": "..." }, { "...": "..." } ],
  "page": { "next_cursor": "eyJrIjoi...", "has_more": true, "limit": 20 }
}

// Collection with an extra cheap counter (only where the count is denormalised on a row)
{
  "data": [ /* ... */ ],
  "page": { "next_cursor": null, "has_more": false, "limit": 20 },
  "meta": { "total": 47 }
}
```

`meta` is optional and only present where noted. `page` is present on and only on collection
responses.

A `204 No Content` has no body at all.

### 0.5 Error envelope

**Every** non-2xx response — including ones produced by the routing layer, the rate limiter, and the
unhandled-exception catch — is this exact shape:

```jsonc
{
  "error": {
    "code": "validation_failed",
    "message": "Team name must be 2-40 characters.",
    "details": {
      "fields": {
        "team_name": "too_short"
      }
    },
    "request_id": "req_01JB2KQ8ZT4R9V6M0X3H7C1N2P"
  }
}
```

| Field | Type | Notes |
| --- | --- | --- |
| `code` | string | Machine-readable, from the closed enum in §0.6. Clients branch on this, never on `message`. |
| `message` | string | Human-readable, English, safe to show to a player verbatim. Never contains a stack trace, a SQL fragment, an internal ID the caller cannot see, or a hostname. |
| `details` | object \| absent | Endpoint-specific. `details.fields` is a flat `{ field_name: reason_code }` map for `validation_failed`. `details.retry_after` (seconds) on `rate_limited`. `details.current_version` on `stale_version`. |
| `request_id` | string | ULID, also sent as the `X-Request-Id` response header and written to the audit/log line. This is what a player quotes to an organizer when something breaks. |

`304 Not Modified` is the one non-2xx with no body (per HTTP).

### 0.6 Error code enum (closed set)

| HTTP | `code` | When |
| --- | --- | --- |
| 400 | `bad_request` | Generic malformed request the other codes do not cover. |
| 400 | `malformed_json` | Body is not parseable JSON / not valid UTF-8. |
| 400 | `validation_failed` | Body parsed, one or more fields invalid. `details.fields` is populated. |
| 400 | `invalid_cursor` | Pagination cursor is not decodable or does not match the query it was minted for. |
| 401 | `unauthenticated` | No session cookie, or the cookie does not resolve to a live session. |
| 401 | `session_expired` | Session existed but hit idle or absolute expiry. Client should clear local state and show the sign-in sheet. |
| 401 | `guest_token_invalid` | `X-Guest-Token` absent, unknown, or revoked. |
| 403 | `forbidden` | Authenticated, but the authorization predicate failed and the object is publicly visible (so hiding it is pointless). |
| 403 | `csrf_failed` | `X-CSRF-Token` missing or does not match the session. |
| 403 | `origin_not_allowed` | `Origin`/`Referer` on a mutating request is absent or not in the allowlist. |
| 403 | `step_up_required` | Session is valid but `auth_at` is older than the endpoint's step-up window. Client must re-run the passkey ceremony. |
| 403 | `uv_required` | Session's last authentication did not perform user verification, and this endpoint requires it. |
| 403 | `recovery_scope_only` | Session was minted by a recovery-code login and may only enrol a new passkey. |
| 404 | `not_found` | The object does not exist, **or** it exists and is not publicly visible and the caller failed the predicate. See SECURITY.md §4 for why this is deliberately ambiguous. |
| 405 | `method_not_allowed` | Response carries an `Allow` header. |
| 409 | `conflict` | Generic state conflict. |
| 409 | `slug_taken` / `handle_taken` | Uniqueness collision on a user-chosen identifier. |
| 409 | `already_registered` | This user/guest already has a live entrant in this tournament. `details.entrant_id` is returned. |
| 409 | `stale_version` | Optimistic-concurrency failure. `details.current_version` and `details.current` (the fresh object) are returned. |
| 409 | `idempotency_key_reuse` | Same `Idempotency-Key`, different request body. |
| 409 | `idempotency_in_progress` | Same key, first attempt still running. Client retries after 1 s. |
| 409 | `invalid_state_transition` | e.g. `live` → `draft`. `details.from`, `details.to`, `details.allowed[]`. |
| 409 | `bracket_exists` | Bracket already generated; pass `force: true` or clear it first. |
| 409 | `bracket_locked` | Results are published; unpublish before editing. |
| 409 | `registration_closed` | Tournament is not accepting entries right now. `details.reason` ∈ `not_open`, `closed`, `full`, `deadline_passed`. |
| 409 | `tournament_full` | `max_entrants` reached and waitlist is off or also full. |
| 409 | `checkin_closed` | Outside the check-in window. `details.opens_at`, `details.closes_at`. |
| 409 | `entrant_locked` | Entrant is `disqualified` / already in a played match; the requested edit is not allowed. |
| 409 | `credential_exists` | This authenticator is already enrolled. |
| 409 | `bootstrap_closed` | An admin already exists. |
| 410 | `gone` | Tournament was cancelled or an invite/join code was consumed. |
| 413 | `payload_too_large` | Body exceeded the cap in §0.3. |
| 415 | `unsupported_media_type` | Wrong or missing `Content-Type` on a body-bearing mutation. |
| 429 | `rate_limited` | See §7. `Retry-After` header is always set. |
| 429 | `recovery_locked` | Too many bad recovery codes for this account. `details.retry_after`. |
| 500 | `internal_error` | Unhandled. The `request_id` is the only diagnostic the caller gets. |
| 501 | `email_auth_disabled` | Email OTP path called while `EMAIL_OTP_ENABLED` is unset. |
| 501 | `not_implemented` | Endpoint exists in the contract but is off in this deployment. |
| 503 | `database_unavailable` | D1 threw. `Retry-After: 5`. |

Additional auth-ceremony codes (`webauthn_challenge_expired`, `webauthn_verification_failed`,
`no_credentials`, `invalid_recovery_code`, `signup_closed`, `turnstile_failed`, `invalid_join_code`)
are defined in AUTH.md and use the HTTP statuses stated there.

### 0.7 Identifiers

All primary keys are **prefixed ULIDs**: a 3–4 char type prefix, an underscore, then a
26-character Crockford base32 ULID (48 bits of millisecond timestamp + 80 bits of CSPRNG).

```
trn_01JB2KQ8ZT4R9V6M0X3H7C1N2P
```

| Prefix | Entity |
| --- | --- |
| `usr_` | user |
| `trn_` | tournament |
| `ent_` | entrant |
| `mem_` | entrant member (a player inside a team) |
| `mat_` | match |
| `gam_` | game |
| `ann_` | announcement |
| `ses_` | session |
| `crd_` | WebAuthn credential |
| `inv_` | guest invite / join code record |
| `aud_` | audit log row |
| `ven_` | venue |

**Why ULID and not an integer.** 80 bits of randomness makes enumeration of tournaments and entrants
infeasible, which is half of the IDOR defence (the other half is the predicate check, which is
mandatory anyway — see SECURITY.md §4). The timestamp prefix keeps them lexicographically sortable,
which makes cursor pagination a plain `WHERE id < ?` with no extra index.

**Rejected:** UUIDv4 (not sortable, so every paginated query needs a composite index and a tiebreak
column) and sequential integers (free enumeration oracle: "how many entrants does the rival club's
tournament have" is answerable by probing).

Tournaments are addressed **publicly by `slug`** and **privately by `id`**. That is deliberate:
public URLs must be pretty and shareable on WhatsApp; organizer URLs must be stable across a rename.

### 0.8 Timestamps, money, timezone

- D1 stores timestamps as `INTEGER` Unix **seconds** UTC.
- The API emits and accepts **RFC 3339 UTC strings with a `Z`**: `"2026-11-08T13:30:00Z"`. Never a
  local-time string, never an offset other than `Z`, never a bare epoch integer.
- The client renders IST with `Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata' })`. The
  server never formats a date for display.
- Money is **`INTEGER` paise**, field names always end in `_paise`: `entry_fee_paise: 20000` is ₹200.
  The API never emits a formatted currency string; the client formats with
  `Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })`.

**Why paise and not whole rupees.** Every fee the club charges today is a whole rupee, so rupees
would work. But D1's `ALTER TABLE` support is a thin subset of SQLite's — changing a money column's
meaning later means a table rebuild with a data migration on a live database. A ₹49.50 early-bird fee
or a payment-gateway integration would force exactly that. Paise costs one multiplication today and
removes a migration forever.

### 0.9 Pagination

Cursor-based, forward-only.

**Request:** `?limit=<1..100>&cursor=<opaque>`. `limit` defaults to **20**, caps at **100**
(a value above 100 is clamped, not rejected). `cursor` is omitted for the first page.

**Response:** `page.next_cursor` is a string when there are more rows and `null` when there are not.
`page.has_more` is the boolean form of the same fact (clients that only check truthiness of the
cursor still work; both are provided because forgetting the `null` check is a classic infinite-loop
bug).

**Cursor format:** `base64url(JSON)` of `{ "v": 1, "k": "<last row sort key>", "q": "<8-char query fingerprint>" }`.

- `k` is the last row's ULID for ULID-ordered lists, or `"<sortvalue>|<ulid>"` for lists ordered by
  something else (leaderboard: `"1450|usr_01JB..."`).
- `q` is the first 8 chars of the base64url SHA-256 of the canonicalised filter set. If the client
  changes a filter but reuses the cursor, `q` will not match and the server returns
  `400 invalid_cursor` instead of silently returning nonsense.

The cursor is **not** signed or encrypted. It contains no secret — it is a public sort key. Do not
put a user ID or an offset into it.

**No total counts on paginated lists.** `SELECT COUNT(*)` over a filtered tournament or leaderboard
scan is the query most likely to hit D1's row-scan and CPU budget on the day it matters. Totals are
only exposed where they are a denormalised counter on a row already being read
(`tournaments.entrant_count`, `tournaments.confirmed_count`) and are surfaced as `meta.total`.

**Rejected:** offset/limit pagination. On a table that is being written to during a live event,
offsets skip and duplicate rows, and `OFFSET 4000` makes D1 walk 4000 rows to throw them away.

### 0.10 Standard headers

**Request headers the API reads**

| Header | Where | Meaning |
| --- | --- | --- |
| `Cookie: __Host-nc_session=...` | any | Session. `nc_session_dev` when `ENVIRONMENT != "production"`. See AUTH.md §5.1. |
| `X-CSRF-Token` | every mutation | Session-bound CSRF token from `GET /api/v1/auth/session`. See SECURITY.md §5. |
| `Origin` (or `Referer`) | every mutation | Must be `https://nellore.club` (plus `http://localhost:8787` when `ENVIRONMENT != "production"`). |
| `Idempotency-Key` | see §6 | Client-generated UUIDv4 or ULID, ≤ 64 chars. |
| `X-Guest-Token` | guest routes | Opaque 43-char base64url capability token. |
| `If-None-Match` | public GETs | Conditional request. See §5. |

**Response headers the API always sets**

| Header | Value |
| --- | --- |
| `X-Request-Id` | The ULID `request_id`. On every response, success or failure. |
| `X-NC-Now` | Server epoch **seconds**. On every response. The client computes `skew = X-NC-Now - Date.now()/1000` once and renders every countdown against it, because a mid-range Android phone's clock is routinely minutes wrong and a check-in countdown that lies is worse than no countdown. Cheap enough to be unconditional; it is not part of the cache key and does not vary the ETag. |
| `Cache-Control` | Per §5. Never absent. |
| `Vary` | `Accept-Encoding` on public GETs. Authenticated responses are `no-store`, so no `Vary: Cookie` is needed — see §5.1. |

**Response headers set conditionally**

| Header | When |
| --- | --- |
| `ETag` | Cacheable public GETs (§5.2). Strong, quoted, e.g. `"41.b"`. |
| `Poll-After` | Live-pollable GETs. Integer seconds the client should wait before the next poll (§5.3). |
| `Idempotent-Replay: true` | The response was replayed from the idempotency store (§6). |
| `RateLimit-Limit` / `RateLimit-Remaining` / `RateLimit-Reset` | Rate-limited endpoints (§7). |
| `Retry-After` | Every 429 and 503. |
| `Allow` | Every 405. |

---

## 1. Public read API

**Invariant, and it is load-bearing: a public endpoint's response never varies by identity.** If a
signed-in admin and an anonymous phone request `/api/v1/tournaments/bgmi-diwali-2026/bracket`, they
get byte-identical JSON. That is what makes these responses safe to cache at the Cloudflare edge with
a cookie-free cache key, which is what stops 400 phones in a hall from melting D1 (§5.4).

Anything identity-dependent lives under `/me/*`, `/organizer/*`, or `/admin/*` and is `no-store`.

All endpoints in this section are `GET`, need no auth, and require no CSRF token.

### 1.1 `GET /api/v1/config`

Public runtime configuration, so the SPA does not have to hardcode feature flags at build time.

**200**
```jsonc
{
  "data": {
    "site": { "name": "Nellore Club", "tagline": "Tournaments in Nellore.", "timezone": "Asia/Kolkata", "currency": "INR" },
    "features": {
      "email_otp": false,          // AUTH.md §6 — false unless EMAIL_OTP_ENABLED
      "signup_open": true,         // SIGNUP_OPEN
      "guest_registration": true,  // whether any tournament may enable it
      "turnstile": true,           // TURNSTILE_SITE_KEY is set
      "dynamic_og": false          // OG_DYNAMIC — see §8.3
    },
    "turnstile_site_key": "0x4AAA...", // present iff features.turnstile
    "limits": { "max_team_size": 8, "max_entrants_per_tournament": 256, "max_matches_per_tournament": 1024 },
    "counts": {                  // feeds the nav tab badges in IA.md §3.1. Two denormalised
      "registration_open": 3,    // COUNTs over an indexed status column, cached 60/300 with the
      "live": 1                  // rest of this payload. Nothing else in the API exposes them,
    },                           // because §0.9 forbids totals on paginated lists.
    "build": { "api_version": "v1" }
  }
}
```

`Cache-Control: public, max-age=60, s-maxage=300, stale-while-revalidate=3600`. No ETag needed.

`counts` is the one place a `COUNT(*)` is allowed on a public read path, and only because it is
bounded by `ix_tournaments_public` (`status`, `starts_at`) and served from a 60-second cache. It
exists so the Play and Live tab badges have a source; without it they silently never render.

### 1.2 `GET /api/v1/games`

**Query:** `active` (`true`|`false`|`all`, default `true`), `category`
(`esport`|`board`|`outdoor`|`all`, default `all`), `limit`, `cursor`.

**200** — collection of `Game`:

```jsonc
{
  "id": "gam_01JB2K...",
  "slug": "bgmi",
  "name": "BGMI",
  "category": "esport",
  "short_name": "BGMI",
  "blurb": "Battlegrounds Mobile India — squad battle royale.",
  "icon": null,                            // v1 renders a category glyph + accent, DESIGN.md §7
  "og_image": "/og/cat-esport.png",
  "participant_type": "team",               // "solo" | "team"
  "team_size_min": 4,
  "team_size_max": 4,
  "substitutes_max": 1,
  "scoring": { "model": "br_points", "...": "..." },        // CONTENT.md owns this block verbatim; the API
                                            // passes it through untouched and never branches on it
  "default_formats": ["points_lobby", "single_elim"],
  "supports_draws": false,                  // derived from definition_json.scoring; convenience mirror
  "rating_enabled": false,                 // chess/carrom set this true
  "registration_schema": [ /* FieldDef[] — see §3.3 */ ],
  "score_schema": { /* opaque to the API; the bracket engine validates result.detail against it */ },
  "active": true,
  "sort_order": 10
}
```

`Cache-Control: public, max-age=300, s-maxage=3600, stale-while-revalidate=86400`.
`ETag: "g.<games_version>"` where `games_version` is a counter in the `settings` table bumped by any
admin game mutation.

### 1.3 `GET /api/v1/games/:slug`

**200** — a single `Game`. **404** `not_found`. Same cache policy as §1.2.

### 1.4 `GET /api/v1/tournaments`

The public tournament list. This is the home page and the `/tournaments/` page.

**Query**

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `game` | game slug, or comma-separated slugs (max 10) | all | |
| `category` | `esport`\|`board`\|`outdoor` | all | |
| `status` | comma-separated from `published`, `registration_open`, `registration_closed`, `check_in`, `live`, `completed`, `cancelled` | `published,registration_open,registration_closed,check_in,live` | `draft` and `archived` are **never** returned here regardless of what is asked. |
| `format` | tournament format enum (§2.1) | all | |
| `fee` | `free`\|`paid` | all | `free` means `entry_fee_paise = 0`. |
| `from` / `to` | RFC 3339 UTC | none | Filters on `starts_at`. |
| `q` | string, ≤ 60 chars | none | Case-insensitive substring on title. `%`, `_` and `\` are escaped and the query uses `ESCAPE '\'`. |
| `sort` | `starts_at_asc` \| `starts_at_desc` \| `newest` | `starts_at_asc` for upcoming, `starts_at_desc` when `status` includes only `completed` | |
| `limit`, `cursor` | §0.9 | | |

**200** — collection of `TournamentCard`:

```jsonc
{
  "id": "trn_01JB2K...",
  "slug": "bgmi-diwali-2026",
  "title": "BGMI Diwali Cup 2026",
  "status": "registration_open",
  "game": { "slug": "bgmi", "name": "BGMI", "category": "esport", "icon": null },
  "format": "points_lobby",
  "participant_type": "team",
  "starts_at": "2026-11-08T13:30:00Z",
  "ends_at": "2026-11-08T18:00:00Z",
  "registration_opens_at": "2026-10-20T04:30:00Z",
  "registration_closes_at": "2026-11-07T18:30:00Z",
  "entry_fee_paise": 20000,
  "prize_pool_paise": 1500000,
  "venue": { "id": "ven_01JB...", "name": "Online — custom rooms", "area": null, "online": true },
  "max_entrants": 100,
  "entrant_count": 62,
  "confirmed_count": 58,
  "waitlist_count": 0,
  "spots_left": 38,          // null when max_entrants is null
  "banner_image": null,
  "is_featured": true,
  "state_version": 41
}
```

`Cache-Control: public, max-age=30, s-maxage=60, stale-while-revalidate=300`.
`ETag: "L.<listing_version>.<query fingerprint>"`, where `listing_version` is a single counter in
`settings` bumped whenever any tournament's card-visible fields change. Over-invalidating a list is
cheap; under-invalidating it makes a newly opened tournament invisible for a minute, which is the
failure the club will actually notice.

### 1.5 `GET /api/v1/tournaments/:slug`

Full public detail for one tournament.

**200** — `TournamentCard` plus:

```jsonc
{
  "summary": "Squad BR, 4 matches, Erangel + Miramar.",
  "rules_ast": { "type": "doc", "children": [ /* see §9 */ ] },
  "prizes": [
    { "position": 1, "label": "Winner",   "amount_paise": 800000, "extra": "Trophy" },
    { "position": 2, "label": "Runner-up","amount_paise": 400000, "extra": null },
    { "position": 3, "label": "Third",    "amount_paise": 300000, "extra": null }
  ],
  "scoring_config": {                       // per-tournament override of game.definition_json.scoring; opaque passthrough
    "placement_points": [10,6,5,4,3,2,1,1,1,1,0,0,0,0,0,0,0,0,0,0],
    "kill_points": 1,
    "matches_count": 4
  },
  "format_config": { "best_of": 1, "third_place_match": true, "group_size": 20, "advance_per_group": 4 },
  "team_size_min": 4,
  "team_size_max": 4,
  "substitutes_max": 1,
  "checkin_opens_at": "2026-11-08T12:00:00Z",
  "checkin_closes_at": "2026-11-08T13:15:00Z",
  "requires_checkin": true,
  "requires_phone": true,
  "allow_guest_registration": true,
  "requires_join_code": true,
  "registration_schema": [ /* FieldDef[] — game defaults, overridden per tournament */ ],
  "organizers": [ { "handle": "sudheer", "display_name": "Sudheer", "is_owner": true } ],
  "contact": { "whatsapp_group_url": "https://chat.whatsapp.com/...", "public_phone": null },
  "stream_url": null,
  "results_published_at": null,
  "bracket_generated_at": null,
  "cancelled_reason": null,
  "created_at": "2026-10-01T05:00:00Z",
  "updated_at": "2026-10-28T09:12:00Z"
}
```

`Cache-Control: public, max-age=15, s-maxage=30, stale-while-revalidate=300`.
`ETag: "<state_version>.t"`. `Poll-After` per §5.3.

**404** `not_found` for an unknown slug, and also for a `draft` or `archived` tournament — a draft is
not publicly visible and must not be distinguishable from a nonexistent one, or a competitor learns
the club's unannounced schedule by probing slugs.

**410** `gone` for `status = "cancelled"` — with the full body still present, plus
`cancelled_reason`. Cancelled tournaments stay readable because their WhatsApp links are already out
there; the 410 is what tells the SPA to render the cancelled banner instead of a live page.

### 1.5.1 `GET /api/v1/tournaments/:slug/overview`

**The one call the tournament page makes on boot.** Returns §1.5 plus the first page of entrants, the
bracket, the standings and the pinned announcements in a single response, so a phone on 4G opening a
WhatsApp link does **one** round-trip instead of five.

```jsonc
{
  "data": {
    "tournament": { /* §1.5 */ },
    "entrants":   { "data": [ /* §1.6, first 50 */ ], "page": { "next_cursor": null, "has_more": false, "limit": 50 } },
    "bracket":    { /* §1.7 data, or null when no bracket exists */ },
    "standings":  { /* §1.9 data, or null */ },
    "announcements": [ /* §1.10, pinned + 5 most recent */ ]
  }
}
```

Budget: **2 subrequests** — one `SELECT` for the tournament row, then one `.batch()` for entrants +
matches (`LIMIT 1024`) + standings + announcements + `match_participants` (the last only when some
stage is `points_lobby`), and nothing else (Appendix D rule 3). Omit sub-resources the tournament
does not have rather than issuing extra queries for them.

After boot the client polls the **individual** endpoints (§1.7/§1.9), not this one — they have
tighter, resource-specific ETags and much smaller 304 responses. `overview` is a cold-start
optimisation, not a polling endpoint, and its `Poll-After` is deliberately `0` to say so.

`Cache-Control`, `ETag: "<state_version>.o"` and status codes are exactly as §1.5, including the
`404` for drafts and the `410` for cancelled.

### 1.5.2 `GET /api/v1/handle-available`

**Query:** `handle` (required). **200** `{ "data": { "handle": "arjun_n", "available": true, "reason": null } }`.
`reason` ∈ `taken`, `reserved`, `invalid`, `held` (in the 90-day post-rename reservation window).

Used by the signup form for inline validation. It is a deliberate, bounded enumeration oracle — a
handle's existence is already public at `/p/<handle>/`, so this leaks nothing new. Rate-limited under
`rl_read` and additionally 30/60 s per IP hash. `Cache-Control: private, no-store` (a cached "available"
that has since been taken is worse than a round-trip).

### 1.5.3 Persistent teams — cut from v1

There is **no** `GET /api/v1/teams/:slug`, no `teams` table, no `team_members` table and no
`/team/<slug>/` page. A squad is typed at registration and lives in `entrants` +
`entrant_members`; the captain's inputs are prefilled from `users.profile_answers_json` so typing it
again next month is three taps, not a data model. Persistent teams buy a profile page and a
"my teams" list; they cost two tables, a fourth SPA shell, a membership/invite handshake and a
rename/disband policy. Revisit when a squad has actually played four events together.

### 1.6 `GET /api/v1/tournaments/:slug/entrants`

The **public, redacted** entrant list. Never contains a phone number, an email, a payment note, or an
organizer note. See SECURITY.md §10.

**Query:** `status` (comma-separated from `confirmed`, `checked_in`, `waitlisted`, `withdrawn`,
`disqualified`; default `confirmed,checked_in`), `limit`, `cursor`.

Whether this endpoint returns anything at all is controlled by `tournaments.entrants_public`
(default `true`). When it is `false`, the endpoint returns `200` with `data: []` and
`meta.hidden: true` rather than a 403 — the list is simply not published yet.

**200** — collection of `PublicEntrant`:

```jsonc
{
  "id": "ent_01JB2K...",
  "display_name": "Team Falcon",         // team name, or the player's display name for solo
  "seed": 3,
  "status": "checked_in",
  "checked_in_at": "2026-11-08T12:04:00Z",
  "player": { "handle": "arjun_n", "display_name": "Arjun" },  // null for a team or a guest entry
  "is_guest": false,
  "members": [                            // present only for team entries
    { "id": "mem_01JB...", "display_name": "Arjun", "handle": "arjun_n", "role": "captain", "is_substitute": false,
      "public_fields": { "bgmi_ign": "FALCON•Arjun" } }
  ],
  "public_fields": { "bgmi_team_tag": "FLCN" },   // only fields whose FieldDef has visibility:"public"
  "registered_at": "2026-10-22T11:41:00Z"
}
```

`Cache-Control: public, max-age=15, s-maxage=30, stale-while-revalidate=300`.
`ETag: "<state_version>.e"`. `meta.total` = `tournaments.entrant_count`.

### 1.7 `GET /api/v1/tournaments/:slug/bracket`

**This is the hot endpoint.** During a live final, every phone in the hall polls it. §5.4 exists
because of this route.

Returns the full bracket in one response — the SPA renders the whole thing and does not make N
follow-up calls per match. On a knockout of 128 entrants this is roughly 60 KB of JSON before
compression; that is acceptable and it is one round-trip on 4G instead of 127.

**Payload worst case is a league, not a knockout.** A 128-entrant knockout is 127 matches. A
256-entrant round robin in 8 groups of 32 is `8 × 496 = 3,968` matches — at ~180 bytes each that is
~715 KB on a query-free endpoint every phone in the hall polls, and it would blow §6.1's 32 KiB
idempotency-response cap and D1's per-query response ceiling. So:

- `MAX_MATCHES_PER_TOURNAMENT = 1024` (ARCHITECTURE.md §9.18). It is validated at
  `POST /organizer/tournaments/:id/bracket` and at `POST /organizer/stages/:id/rounds`, which refuse
  with `409 conflict`, `details.reason: "too_many_matches"`, `details.match_count`. A bracket that
  cannot be rendered must not be creatable.
- The matches `SELECT` in this handler carries `LIMIT 1024` (Appendix D rule 3). If the limit is
  ever reached the response carries `meta.truncated: true` and the SPA renders a banner pointing at
  the fixtures list rather than a silently short bracket.
- For a large league the correct view is `GET /tournaments/:slug/matches` (§1.8), which is paginated.
  The round-robin panel in `IA.md` §6.3 uses that, not this.

**Query:** none. (Deliberately: a query-free URL is a single edge cache key.)

**200**

```jsonc
{
  "data": {
    "tournament": {
      "id": "trn_01JB2K...", "slug": "carrom-open-2026", "title": "Carrom Open 2026",
      "format": "single_elim", "status": "live", "state_version": 118,
      "scoring_model": "h2h_sets", "supports_draws": false,   // echoed from game.definition_json.scoring.model
      "results_published_at": null
    },
    "entrants": [                      // every entrant referenced below, once, by id
      { "id": "ent_01JB...", "display_name": "Ravi K", "seed": 1, "handle": "ravik",
        "status": "checked_in", "is_guest": false, "eliminated": false, "placement": null }
    ],
    "rounds": [
      {
        "index": 1,
        "name": "Round of 16",
        "stage_id": "stg_01JB...",
        "bracket": "winners",           // wire word, projected from matches.bracket:
                                        //   W -> "winners"  L -> "losers"  GF -> "grand_final"
                                        //   RR -> "groups"  SW -> "swiss"  BR -> "series"
        "best_of": 3,
        "scheduled_at": "2026-11-08T13:30:00Z",
        "matches": [
          {
            "id": "mat_01JB...",
            "code": "W1M1",              // stable human label, printable on a wall chart
            "round_index": 1,
            "position": 0,               // ordinal within the round; drives layout
            "state": "complete",         // "pending"|"ready"|"live"|"complete"|"bye"|"void"  (= matches.status)
            "best_of": 3,
            "conditional": false,        // true only for a double-elim GF2 that may not be played
            "slots": [
              { "position": 0, "entrant_id": "ent_01JB...", "score": 2, "bonus": 0, "is_winner": true,
                "side": "W", "source": { "kind": "seed", "ref": null } },
              { "position": 1, "entrant_id": "ent_01JC...", "score": 1, "bonus": 0, "is_winner": false,
                "side": "B", "source": { "kind": "seed", "ref": null } }
            ],
            "winner_entrant_id": "ent_01JB...",
            "loser_entrant_id": "ent_01JC...",
            "is_draw": false,
            "method": "normal",           // "normal"|"walkover"|"forfeit"|"dq"|"no_contest"  (= matches.method)
            "detail": { "sets": [[29,12],[15,21],[25,18]] },   // = matches.result_detail_json, opaque to the engine
            "scheduled_at": "2026-11-08T13:30:00Z",
            "completed_at": "2026-11-08T14:02:00Z",
            "venue": { "id": "ven_01JB...", "name": "Hall A, Table 3" },
            "room_code": null,            // esports lobby/room code — only present when the tournament publishes it
            "stream_url": null,
            "result_version": 4,          // = matches.result_version; the optimistic-concurrency token
            "updated_at": "2026-11-08T14:02:11Z",
            "updated_by": { "handle": "sudheer", "display_name": "Sudheer" }
          }
        ]
      }
    ],
    "groups": [                          // present for round_robin / points_lobby / a group stage
      { "key": "A", "name": "Group A", "entrant_ids": ["ent_...", "ent_..."],
        "advance_count": 4, "match_ids": ["mat_..."] }
    ],
    "stages": [                          // always present; length 1 for a single-stage tournament
      { "id": "stg_01JB...", "ordinal": 1, "name": "Group Stage", "format": "round_robin",
        "status": "completed", "advance_count": 2 },
      { "id": "stg_01JC...", "ordinal": 2, "name": "Playoffs", "format": "single_elim",
        "status": "live", "advance_count": null }
    ],
    "third_place_match": { /* a match object, or null */ },
    "final_match_id": "mat_01JB...",
    "generated_at": "2026-11-07T19:00:00Z"
  }
}
```

Notes for the implementer:

- **`slots[]` is a wire shape, not a table.** It is projected from the engine's storage
  (`BRACKET-ENGINE.md` §3.1) so that the frontend renders every format with one component:
  - head-to-head formats → `slots[0]` = `(entrant_a_id, score_a, bonus_a, a_source_kind,
    a_source_match_id, side_a)`, `slots[1]` = the `_b` equivalents. Exactly two slots.
  - `points_lobby` → one slot per row of `match_participants`, ordered by `placement`, carrying
    `placement`, `kills` and the engine-computed `points` in place of `score`.
  There is no `match_slots` table. Do not create one.
- `slots[].entrant_id` is `null` when the slot is not yet filled; `source` then tells the UI what to
  render in the empty box. `source.kind` is the engine's `a_source_kind` / `b_source_kind` value —
  `seed`, `winner_of`, `loser_of`, `group`, `bye` — and `source.ref` is `a_source_match_id` /
  `b_source_match_id`, or a group reference like `"A#2"`.
- `side` mirrors `matches.side_a` (`"W"`/`"B"` for chess, `null` for everything else). `slots[1].side`
  is the complement, computed by the Worker; there is no `side_b` column.
- Entrant objects are **not** inlined into slots. They are listed once in `entrants` and referenced by
  id. On a 128-player double-elim this halves the payload.
- `room_code` is `null` in the public response unless `tournaments.publish_room_codes = 1` **and**
  `matches.room_code_publish_at <= now`. Otherwise it is organizer-only. A leaked BGMI room code
  before the match starts means strangers flood the lobby. **A checked-in entrant of the match gets
  the code from `GET /api/v1/me/registrations` or `GET /api/v1/guest/entrant` instead (§3.9) — never
  from this route**, because a public response must not vary by identity (§1's invariant).
- `updated_by` is joined from `matches.recorded_by` → `users`; `updated_at` is `matches.updated_at`.
  There is no `matches.updated_by_user_id` column and never was.
- **D1 budget:** one `SELECT` for the tournament row, then **one `.batch()`** containing the
  entrants, the matches (`LEFT JOIN venues`, `LEFT JOIN users AS recorded_by`) and — only when some
  stage of this tournament has `format = 'points_lobby'` — `match_participants`. That is **2
  subrequests, 3 or 4 statements**, and the tree is assembled in JavaScript. `match_participants` is
  not optional for BGMI/Free Fire: `slots[]` for a lobby row *is* `match_participants`, so omitting
  it renders a BGMI results page with empty slots. Head-to-head brackets skip it and keep the
  cheaper shape. See Appendix D rule 3.

`Cache-Control: public, max-age=5, s-maxage=5, stale-while-revalidate=25` while `status = "live"`;
`public, max-age=60, s-maxage=120, stale-while-revalidate=600` otherwise.
`ETag: "<state_version>.b"`. `Poll-After` per §5.3.

**404** if no bracket has been generated yet — no. **200 with `rounds: []` and `generated_at: null`.**
The tournament exists and the page must render "Bracket not published yet"; a 404 would make the SPA
show a broken-page state.

### 1.8 `GET /api/v1/tournaments/:slug/matches`

A flat, filterable match list for the fixtures/schedule view (cricket and badminton organizers live
in this view; a bracket diagram is the wrong shape for a league).

**Query:** `stage` (a `stg_` id **or** a stage ordinal `1`, `2`, …; default = the live stage, §1.9),
`round` (int), `state` (comma-separated), `entrant` (entrant id), `group` (group key),
`from`, `to`, `sort` (`scheduled_asc` default, `round_asc`), `limit`, `cursor`.

**200** — collection of the same match object as §1.7, but with `entrant` objects inlined into slots
(this list is short and is rendered without the bracket's entrant index). `meta.stage` echoes the
resolved `{ id, ordinal, name, format }`.

Same cache policy and ETag suffix `.m` as the bracket, **plus the query fingerprint** (§8.3), so
`?stage=1` and `?stage=2` do not share a cache entry.

### 1.9 `GET /api/v1/tournaments/:slug/standings`

Works for every format. For knockouts it is the elimination order; for round-robin and points-series
it is the live table.

**Query:** `stage` — a `stg_` id **or** a stage ordinal (`1`, `2`, …). `standings` has primary key
`(stage_id, entrant_id)` precisely because "standings of the group stage" and "standings of the
playoffs" are different questions, so this endpoint answers one stage at a time and never merges
them.

**Default when `stage` is absent:** the **live stage** — the lowest-`ordinal` stage whose `status`
is `live` or `recomputing`; if none, the highest-`ordinal` stage with `bracket_generated_at IS NOT
NULL`; if none, stage 1. The resolved stage is echoed in `meta.stage`, and `data.stages[]` lists
every stage so the selector in `IA.md` §6.3 can render (that selector is driven by this array and
by §1.7's `bracket.stages[]`).

An unknown `stage` value is `404 not_found`. A `stage` that belongs to another tournament is
`404 not_found`, never `403` — it is not the caller's business that it exists.

**The tournament's overall final placement list** (which is a different question again — it spans
stages) is `entrants[].placement`, written at publish time by the procedure in
`BRACKET-ENGINE.md` §15.7, and is returned by §1.6 and §1.7, not here.

**200**

```jsonc
{
  "data": {
    "columns": [                              // drives the table header; game-agnostic by construction
      { "key": "rank",   "label": "#",      "type": "int" },
      { "key": "entrant","label": "Team",   "type": "entrant" },
      { "key": "played", "label": "M",      "type": "int" },
      { "key": "wins",   "label": "W",      "type": "int" },
      { "key": "losses", "label": "L",      "type": "int" },
      { "key": "placement_points", "label": "Place", "type": "int" },
      { "key": "kill_points",      "label": "Kills", "type": "int" },
      { "key": "points", "label": "Pts",    "type": "int", "primary": true }
    ],
    "rows": [
      { "rank": 1, "entrant": { "id": "ent_...", "display_name": "Team Falcon", "handle": null, "seed": 3 },
        "played": 4, "wins": 2, "losses": 2, "placement_points": 27, "kill_points": 31, "points": 58,
        "tiebreak_note": "Higher kill points", "status": "active", "qualified": true, "group": "A" }
    ],
    "groups": [ { "key": "A", "name": "Group A" } ],   // null when the format has no groups
    "stages": [                                        // always present; length 1 for a single-stage event
      { "id": "stg_01JB...", "ordinal": 1, "name": "Group Stage", "format": "round_robin", "status": "completed" },
      { "id": "stg_01JC...", "ordinal": 2, "name": "Playoffs",    "format": "single_elim", "status": "live" }
    ],
    "is_final": false,
    "computed_at": "2026-11-08T15:22:03Z"
  },
  "meta": { "stage": { "id": "stg_01JC...", "ordinal": 2, "name": "Playoffs", "format": "single_elim" } }
}
```

The `columns` array is what keeps standings game-agnostic: the frontend renders whatever columns the
scoring engine emits, in order, and knows nothing about kills or wickets. A new game ships new
columns as data.

**What backs each column.** `rank`, `played`, `wins`, `draws`, `losses`, `points`, `score_for`,
`score_against`, `score_diff`, `kills`, `placement_points`, `best_placement` are the columns of the
same name on `standings`. Everything else comes from `standings.tiebreak_1..5`, in the order
declared by `stages.tiebreakers_json`, labelled from the token map in `BRACKET-ENGINE.md` §4.2.
**Exactly five tiebreak columns are available**, because exactly five are persisted (§4.2.3); a
chain longer than that sorts correctly but the surplus comparators are not columns. Rational
tiebreaks (`set_ratio`, `net_run_rate`) are stored ×1000 and are emitted as
`{ "type": "ratio_milli" }` so the client divides by 1000 for display — `net_run_rate` may be
negative.

`points` is the raw integer from `standings.points`. When `stages.points_divisor > 1` (chess) the
column carries `"divisor": 2` and the client renders `points / divisor` — the server never formats
it. There are no fractional numbers on this wire.

`Cache-Control` and `Poll-After` identical to the bracket. `ETag: "<state_version>.s.<stage ordinal>"`.

### 1.10 `GET /api/v1/tournaments/:slug/announcements`

**Query:** `limit` (default 20), `cursor`.

**200** — collection of `Announcement`:

```jsonc
{
  "id": "ann_01JB...",
  "scope": "tournament",                 // "tournament" | "club"
  "tournament": { "slug": "bgmi-diwali-2026", "title": "BGMI Diwali Cup 2026" },  // null for club scope
  "title": "Round 2 rooms are up",
  "body_ast": { "type": "doc", "children": [ /* §9 */ ] },
  "pinned": true,
  "severity": "info",                    // "info" | "important" | "urgent"
  "published_at": "2026-11-08T14:10:00Z",
  "author": { "handle": "sudheer", "display_name": "Sudheer" }
}
```

`Cache-Control: public, max-age=15, s-maxage=30, stale-while-revalidate=300`.
`ETag: "<state_version>.a"`.

### 1.11 `GET /api/v1/announcements`

Club-wide announcements (`scope = "club"`), newest first, plus any tournament announcement whose
`promote_to_club` flag is set. Same object as §1.10.

`Cache-Control: public, max-age=60, s-maxage=300, stale-while-revalidate=3600`.
`ETag: "c.<club_announcements_version>"`.

### 1.12 `GET /api/v1/leaderboard`

Cross-tournament ranking. **Served from a materialised table** (`leaderboard_entries`), never
computed live — see §1.12.1.

**Query**

| Param | Default | Notes |
| --- | --- | --- |
| `game` | `all` | A game slug, or `all` for the club-wide board. |
| `category` | `all` | Mutually exclusive with `game`; if both are given, `game` wins. |
| `period` | `all_time` | `all_time` \| `season:<season_slug>`. Nothing else in v1 — a rolling window needs a rollup job that does not exist, and `year:` is a season by another name. |
| `metric` | `points` | `points` \| `wins` \| `titles`. **`rating` returns `501 not_implemented`** — see §1.12.2. |
| `limit`, `cursor` | | Max 100. |

**200**

```jsonc
{
  "data": [
    { "rank": 1, "player": { "handle": "ravik", "display_name": "Ravi K", "avatar_seed": "ravik" },
      "points": 1450, "rating": null, "tournaments_played": 9, "wins": 31, "titles": 3,
      "best_finish": 1, "last_played_at": "2026-11-08T18:00:00Z", "trend": 2 }
  ],
  "page": { "next_cursor": "eyJ2IjoxLC...", "has_more": true, "limit": 20 },
  "meta": { "game": "carrom", "period": "all_time", "metric": "points", "computed_at": "2026-11-08T18:04:00Z" }
}
```

`rank` is dense-ranked with ties sharing a rank. `trend` is the change in rank since the previous
recompute (positive = moved up), or `null` if unknown.

`Cache-Control: public, max-age=300, s-maxage=900, stale-while-revalidate=86400`.
`ETag: "lb.<leaderboard_version>.<query fingerprint>"`.

#### 1.12.1 Why the leaderboard is materialised

A live cross-tournament leaderboard is a join across `matches`, `entrants`, `entrant_members` and
`tournaments`, aggregated per user, over the whole history of the club. On D1 that is exactly the
query that will one day exceed the row-scan budget and start returning `database_unavailable` — and
it would do so on the leaderboard page, which is the page people link to.

So: `leaderboard_entries` is written by `POST /api/v1/organizer/tournaments/:id/publish` (§4.16) and
by `POST /api/v1/admin/leaderboard/rebuild` (§5 of the admin section). Reads are a single indexed
`SELECT ... ORDER BY points DESC, user_id LIMIT ?`. A tournament that has not been published does not
affect the leaderboard, which is also the correct product behaviour — provisional scores from a match
that is still being disputed must not move a season ranking.

**Rejected:** computing it live with a 15-minute edge cache. The cache would hide the cost right up
until a cold cache coincided with a busy evening.

#### 1.12.2 Club ratings are NOT implemented in v1 — and they fail loudly, not quietly

`db/schema.sql` ships `player_ratings` so that enabling ratings later is a feature flag rather than
a migration. **Nothing writes a row into it in v1**: no endpoint, no publish effect, no cron job,
and no engine function. `BRACKET-ENGINE.md` does not mention ratings at all.

So, normatively, everywhere a rating is reachable:

| Surface | v1 behaviour |
| --- | --- |
| `GET /api/v1/leaderboard?metric=rating` | **`501 not_implemented`**, `message: "Club ratings are not enabled yet."` |
| `GET /api/v1/players/:handle` → `games[].rating` | Always `null`. The client omits the column rather than rendering "1500 (provisional)" for everyone. |
| `Game.rating_enabled` (§1.2) | Always `false` on the wire in v1, whatever `content/games.json` says, so no UI offers a rating control. |
| `POST /organizer/tournaments` / `PATCH` with `seeding_method: "rating"` | **`400 validation_failed`**, `details.fields["seeding_method"] = "rating_not_implemented"` |
| `POST .../entrants/reseed` with `{"method": "rating"}` (§4.11) | **`400 validation_failed`**, same reason code |
| `stages.seed_source = 'rating'` | Refused at stage create/patch (§4.23), same reason code |
| `leaderboard_entries.rating` | Stays `NULL`. |

**Why a hard error and not a fallback.** "Seed by club rating" silently degrading to registration
order produces a *wrong bracket that looks right*, which is the worst possible failure mode for a
seeding control — nobody discovers it until the draw is already on WhatsApp. `entrants.rating` is
`NULL` for every row (nothing populates it), so the fallback would be total, not partial.

Turning it on later is a bounded piece of work and it is deliberately **not** specified here: it
needs the exact integer Glicko-style update (no `Math.pow`, per `BRACKET-ENGINE.md` §16.2's
reasoning), a decision on which stage statuses trigger it, and a home in the publish batch beside
`points_ledger`. Specify it then; do not half-build it now.

### 1.13 `GET /api/v1/players/:handle`

Public player profile.

**200**

```jsonc
{
  "data": {
    "handle": "ravik",
    "display_name": "Ravi K",
    "bio": "Carrom, mostly.",              // plain text, ≤ 200 chars, never markdown
    "avatar_seed": "ravik",                 // deterministic seed for a generated identicon; no uploads in v1
    "city": "Nellore",
    "member_since": "2026-06-14T00:00:00Z",
    "games": [ { "slug": "carrom", "name": "Carrom", "tournaments_played": 9, "wins": 31, "titles": 3, "rating": 1612 } ],
    "recent_results": [
      { "tournament": { "slug": "carrom-open-2026", "title": "Carrom Open 2026" },
        "placement": 1, "entrant_display_name": "Ravi K", "completed_at": "2026-11-08T18:00:00Z" }
    ],
    "leaderboard": [ { "game": "carrom", "period": "all_time", "rank": 1, "points": 1450 } ]
  }
}
```

Never contains a phone number, an email, a real name the user did not put in `display_name`, or an
entrant status in a non-public tournament.

**404** for an unknown handle, a deleted account, or a user with `profile_public = 0`.

`Cache-Control: public, max-age=120, s-maxage=600, stale-while-revalidate=86400`.
`ETag: "p.<users.profile_version>"`.

### 1.14 `GET /api/v1/club`

Static-ish club info that the frontend would otherwise have to hardcode: address, contact, about
text, the office-bearers list, socials. Editable by admin (§5.6) so the owner does not need a deploy
to change a phone number.

`Cache-Control: public, max-age=300, s-maxage=3600, stale-while-revalidate=86400`.
`ETag: "club.<club_version>"`.

### 1.15 `GET /api/v1/venues`

**200** — collection of `{ id, name, area, address, maps_url, online, capacity, active }`.
`Cache-Control: public, max-age=300, s-maxage=3600, stale-while-revalidate=86400`.

### 1.16 `GET /api/v1/live`

Backs `/live/` — "every live tournament **+ every live match**", which `IA.md` §2.1 calls the best
WhatsApp share during an event. Without it that page is an N+1: fetch `/tournaments?status=live`,
then one `/bracket` per live tournament, on 4G, in a hall.

**Query:** none. (Query-free = one edge cache key, exactly like §1.7.)

**200**
```jsonc
{
  "data": {
    "tournaments": [ /* TournamentCard, §1.4, every tournament with status = 'live' */ ],
    "matches": [                       // across ALL live tournaments, capped at 50
      { /* the §1.8 match shape, with entrants inlined, plus: */
        "tournament": { "slug": "carrom-open-2026", "title": "Carrom Open 2026" } }
    ]
  },
  "meta": { "match_count": 12, "truncated": false }
}
```

Selection: `matches.status IN ('live','ready')` for tournaments in `status = 'live'`, ordered
`status = 'live'` first then `scheduled_at ASC, match_no ASC`, `LIMIT 50`. `meta.truncated` is true
when the cap bites.

**D1 budget: ≤ 2 statements** — one for the tournaments, one for the matches (a join on the live
tournament ids). `ETag: "live.<listing_version>"`, `Poll-After: 20`,
`Cache-Control: public, max-age=10, s-maxage=10, stale-while-revalidate=60`.

`listing_version` is bumped by any status transition (§4.4), so a tournament going live invalidates
this within one poll. It is deliberately **not** keyed on any single `state_version` — a score in
one tournament must not invalidate the whole club's live page.

### 1.16.1 `GET /api/v1/search`

Backs `/search/`. Deliberately small: a bounded merged result, not a search engine.

**Query:** `q` (≤ 60 chars; `%`, `_` and `\` escaped, `ESCAPE '\'`), `type` (comma-separated from
`tournaments`, `players`, `games`; default all three), `limit` (≤ 20 per type, default 5).

**200**
```jsonc
{
  "data": {
    "tournaments": [ { "slug": "...", "title": "...", "status": "live", "game": { "slug": "bgmi", "name": "BGMI" }, "starts_at": "..." } ],
    "players":     [ { "handle": "ravik", "display_name": "Ravi K", "avatar_seed": "ravik" } ],
    "games":       [ { "slug": "carrom", "name": "Carrom", "category": "board" } ]
  },
  "meta": { "q": "car" }
}
```

- `q` empty or absent → tournaments = the next 5 upcoming plus any live; players = `[]`; games = the
  top 5 by `sort_order`. This is the "recent + popular" state `IA.md` §2.1 specifies.
- Players are matched on a **`handle` prefix only** (`handle LIKE ? || '%'`), never on
  `display_name`, and only where `profile_public = 1`. A substring search over display names is a
  member-directory scrape with extra steps, and §1.5.2 already accepts handle existence as public.
- Tournaments are matched on a title substring, with `status NOT IN ('draft','archived')` **in the
  SQL** (SECURITY.md §4 Rule 5).
- Games are matched in the Worker against the `games` list it already has cached; no D1 read.

**D1 budget: ≤ 2 statements.** `Cache-Control: private, no-store` (a query-varying public cache key
is unbounded cardinality), rate-limited under `rl_read`.

### 1.17 `GET /healthz`

Not under `/api`. Returns `200 text/plain` `ok` if a `SELECT 1` against D1 succeeds within 2 s, else
`503` `db`. `Cache-Control: no-store`. No auth, no rate limit, no body detail — it is for uptime
monitoring, not diagnostics.

---

## 2. Auth API

Full ceremony semantics are in [`AUTH.md`](./AUTH.md). This section fixes the **wire contract** only.
All of these are `POST` unless noted, all are rate-limited (§7), all mutations require the
`Origin` check, and — the one exception in the whole API — the ceremony endpoints
(`/auth/passkey/*`, `/auth/recovery/login`, `/auth/email/*`) do **not** require `X-CSRF-Token`,
because a caller who has no session yet has no CSRF token. They are protected by the `Origin`
allowlist, the JSON `Content-Type` requirement, and the fact that a forged cross-site call cannot
read the response. See SECURITY.md §5.3.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/v1/auth/config` | none | `{ passkey: true, email_otp: bool, recovery: true, signup_open: bool, rp_id: "nellore.club", bootstrap_available: bool }`. `Cache-Control: no-store`. |
| `GET` | `/api/v1/auth/session` | optional | The current session + **the CSRF token**. See §2.1. |
| `POST` | `/api/v1/auth/passkey/register/options` | none or session | Begin registration ceremony. |
| `POST` | `/api/v1/auth/passkey/register/verify` | none or session | Finish it; on success sets `__Host-nc_session`. |
| `POST` | `/api/v1/auth/passkey/login/options` | none | Begin authentication ceremony. |
| `POST` | `/api/v1/auth/passkey/login/verify` | none | Finish it; sets `__Host-nc_session`. |
| `POST` | `/api/v1/auth/recovery/login` | none | Recovery-code sign-in → recovery-scoped session. |
| `GET` | `/api/v1/auth/recovery/status` | session | `{ remaining: 7, generated_at, batch_id }`. |
| `POST` | `/api/v1/auth/recovery/codes` | session + step-up + UV | Regenerate the batch. Returns the 10 plaintext codes **once**. |
| `POST` | `/api/v1/auth/email/start` | none | Optional. `501 email_auth_disabled` when off. |
| `POST` | `/api/v1/auth/email/verify` | none | Optional. |
| `POST` | `/api/v1/auth/logout` | session | Revokes the current session, clears the cookie. `204`. |
| `GET` | `/api/v1/auth/bootstrap/status` | none | `{ available: bool }` — `true` only if `ADMIN_BOOTSTRAP_TOKEN` is configured and no admin exists. |

### 2.1 `GET /api/v1/auth/session`

The SPA calls this once on boot, before rendering anything that needs identity, and again after any
sign-in.

**200 (signed in)**
```jsonc
{
  "data": {
    "authenticated": true,
    "csrf_token": "8Jq2f1s...43 chars...",     // send as X-CSRF-Token on every mutation
    "user": {
      "id": "usr_01JB...", "handle": "sudheer", "display_name": "Sudheer",
      "role": "organizer", "avatar_seed": "sudheer",
      "has_phone": true, "phone_last4": "4417",
      "email_verified": false, "profile_public": true,
      "recovery_codes_remaining": 8, "credential_count": 2
    },
    "session": {
      "id": "ses_01JB...", "scope": "full",     // "full" | "recovery"
      "uv": true,
      "auth_at": "2026-11-08T09:10:00Z",
      "idle_expires_at": "2027-01-07T09:10:00Z",
      "absolute_expires_at": "2027-05-07T09:10:00Z"
    },
    "organizer_of": ["trn_01JB...", "trn_01JC..."]   // tournament ids where this user is owner or co-organizer; ≤ 200, else null and the client uses /organizer/tournaments
  }
}
```

**200 (anonymous)**
```jsonc
{ "data": { "authenticated": false, "csrf_token": null, "user": null, "session": null } }
```

Anonymous is a **200, not a 401.** A 401 here would make every page load log a client-side error and
would make the "am I signed in?" check indistinguishable from a real failure.

`Cache-Control: private, no-store`. Never an ETag. Never edge-cached.

---

## 3. Player API

Every endpoint here needs a live session (`401 unauthenticated` otherwise) and every mutation needs
`X-CSRF-Token` + a valid `Origin`. Responses are `Cache-Control: private, no-store`.

### 3.1 `GET /api/v1/me`

**200** — the full private profile: everything in `session.user` above, plus `email` (if set),
`phone_e164` **masked** to `+91 ••••• •4417` (the full number is never sent back to the client —
SECURITY.md §10.2), `city`, `bio`, `created_at`, `notify_whatsapp` preference.

### 3.2 `PATCH /api/v1/me`

**Body** (all optional, at least one required)
```jsonc
{
  "display_name": "Sudheer K",   // 2..60 chars after NFC normalisation; see SECURITY.md §7.2 charset rule
  "handle": "sudheer_k",         // ^[a-z0-9][a-z0-9_]{2,19}$ ; changeable at most once per 30 days
  "bio": "Runs the Sunday carrom nights.",   // ≤ 200 chars, plain text, newlines stripped
  "city": "Nellore",             // ≤ 60 chars
  "phone_e164": "+919876504417", // E.164, must start +91 unless ALLOW_INTL_PHONE=1; "" clears it
  "profile_public": true,
  "notify_whatsapp": true
}
```

**200** — the updated `/me` body.
**409** `handle_taken`, or `conflict` with `details.reason: "handle_change_cooldown"` and
`details.available_at`.
**400** `validation_failed`.

Changing `handle` bumps `users.profile_version` (invalidates `/players/:handle`) and writes an audit
row. The old handle is **reserved for 90 days** and 404s rather than being immediately reusable, so a
handle swap cannot be used to impersonate someone whose old links are still circulating on WhatsApp.

### 3.3 `POST /api/v1/tournaments/:slug/register`

The single registration endpoint for solo and team, every game.

**Auth:** session. **Idempotency:** required (`Idempotency-Key`). **Rate limit:** `register` bucket.

**Body**
```jsonc
{
  "participant_type": "team",            // must equal the tournament's participant_type
  "team_name": "Team Falcon",           // required for team; 2..40 chars; SECURITY.md §7.2 charset
  "team_tag": "FLCN",                   // optional, ≤ 6 chars, [A-Za-z0-9]
  "members": [                          // team only. Length within [team_size_min, team_size_max + substitutes_max]
    { "handle": "arjun_n",  "role": "captain", "is_substitute": false, "fields": { "bgmi_ign": "FALCON•Arjun", "bgmi_player_id": "5123456789" } },
    { "display_name": "Kiran", "role": "player", "is_substitute": false, "fields": { "bgmi_ign": "FALCON•Kiran", "bgmi_player_id": "5987654321" } }
  ],
  "fields": { "bgmi_team_tag": "FLCN", "preferred_slot": "evening" },   // entrant-level custom fields
  "phone_e164": "+919876504417",        // required iff tournament.requires_phone and the user has none on file
  "notes": "We need the 7pm slot.",     // ≤ 300 chars, plain text, organizer-visible only
  "agree_rules": true,                  // must be true
  "join_code": "K7QP2M"                 // required iff tournament.requires_join_code
}
```

**Member identification.** A member is either a **linked account** (`handle` given — the user must
exist and have `profile_public` or have accepted; see below) or an **unlinked name**
(`display_name` given, no account). The requesting user is always implicitly the captain unless a
member entry with their own handle says otherwise; if their handle is absent from `members`, the
server prepends them as captain.

Linking another player's handle to your team does **not** grant them anything and does **not** expose
their data; it records `entrant_members.user_id` so their leaderboard credit and their
`/me/registrations` list are correct. It is a claim, not an invitation, and the linked player can
sever it with `POST /api/v1/me/registrations/:entrant_id/leave` (§3.9). Rationale: an invitation
handshake is the "right" design and it is also the design that makes a 4-man BGMI squad take four
sign-ins to register at 11 pm before a deadline. The abuse ceiling here is low (being falsely listed
on a roster) and the escape hatch is one tap.

**Custom fields.** `fields` and `members[].fields` are validated against the effective
`registration_schema` — the tournament's if set, otherwise the game's.

> **`FieldDef` is defined by [`CONTENT.md` §3](./CONTENT.md), verbatim and in full.** That includes
> `FieldType`, the nested `Validation` object, `Condition`, `visibility`, `pii`, `profile_key`,
> `options: {value,label}[]`, `default` and `visible_if`. **This document reproduces none of it and
> defines no rival version.** An earlier draft of this section carried its own flat type list
> (`"number"`, `"bool"`, `"phone"`, `"ingame_id"`, flat `max_len`/`min`/`max`, and a
> `visibility: "entrants"` value) — and a scan of all 20 games plus `field_presets` in
> `content/games.json` shows **not one field uses a type that list permitted**. An implementer who
> wrote a validator from it would 400 every BGMI, carrom and cricket registration in the catalogue.
> `worker/lib/fields.ts` is written from CONTENT.md §3 and from nothing else.

For orientation only, a real field from the catalogue:

```jsonc
{
  "key": "bgmi_player_id",
  "type": "text",
  "label": "BGMI player ID",
  "help": "In BGMI: profile → the numeric ID under your name.",
  "placeholder": "5123456789",
  "required": true,
  "visibility": "organizer",
  "pii": false,
  "profile_key": "bgmi.player_id",
  "validation": { "pattern": "^[0-9]{8,12}$", "pattern_message": "8–12 digits.", "max_length": 12 }
}
```

`scope` is not a `FieldDef` property: it is positional. Fields in `registration_fields` are
entrant-scoped and validated against `fields`; fields in `member_fields` are member-scoped and
validated against `members[].fields`.

**What this document *does* own: the wire error mapping.** Reason codes in `details.fields[key]`,
checked in this order:

| Reason code | Fires when |
| --- | --- |
| `unknown_field` | The key is not in the effective schema (`POST .../register` only — see below) |
| `required` | `required: true` and the value is absent, `null`, `""`, or an empty array |
| `type` | The value's JSON type does not match `FieldType` (`integer` given `"3.5"`, `boolean` given `"yes"`, …) |
| `too_short` / `too_long` | `validation.min_length` / `validation.max_length` |
| `out_of_range` | `validation.min` / `validation.max` |
| `step` | `validation.step` — the value is not `min + k × step` for an integer `k` |
| `pattern` | `validation.pattern` fails. `message` is `validation.pattern_message`, never the raw regex |
| `invalid_option` | Not a member of `options[].value` |
| `too_few_selected` / `too_many_selected` | `validation.min_selected` / `max_selected` on a `multiselect` |
| `must_be_true` | `validation.must_be: true` on a `boolean` (consent gates) and the value is not `true` |
| `conditional_not_visible` | A value was submitted for a field whose `visible_if` is not satisfied by the rest of the payload |

**The unknown-key rule — one rule per method, stated in both files.**

| Endpoint | Unknown key | Why |
| --- | --- | --- |
| `POST /tournaments/:slug/register`, `POST .../guest-register`, `POST /organizer/tournaments/:id/entrants` | **rejected** — `400 validation_failed`, `details.fields[key] = "unknown_field"` | A first submission is authored against the schema the client just fetched. A key it does not recognise means the client is stale or someone is probing; failing loudly is right, and there is no half-filled entry to protect. |
| `PATCH /entrants/:id`, `PATCH /guest/entrant`, `PATCH /organizer/entrants/:id` | **dropped**, silently | A player editing an entry made before the organiser added a field must not be hard-blocked by a key they never sent. This is CONTENT.md §3.1's rule and it is correct for the edit path. |

Both halves matter. Rejecting on `PATCH` blocks a legitimate edit; dropping on `POST` is how a
tournament ends up with half its entrants missing an in-game ID.

**A field added after a player registered** is the case both rules are shaped around, and it needs
one more clause so nothing is silently lost: on `PATCH`, a `required` field that is **absent from
the stored `fields_json` and absent from the patch** is reported as `required` — the edit is refused
and the form shows the new field. It is only *unknown* keys that are dropped, never *missing
required* ones.

**201**
```jsonc
{ "data": { "entrant": { /* PrivateEntrant — §3.6.1 */ }, "position": "confirmed", "waitlist_position": null } }
```
`position` ∈ `"pending"` (needs organizer confirmation), `"confirmed"`, `"waitlisted"`.

**Errors:** `409 already_registered` (with `details.entrant_id`), `409 registration_closed`,
`409 tournament_full`, `403 invalid_join_code`, `400 validation_failed`, `429 rate_limited`.

**Concurrency.** Two independent guards, both in the database, both inside one `.batch()`.

*Duplicate entry* is the partial unique index `ux_entrants_user` on `(tournament_id, user_id)` for
live statuses. If the batch fails that constraint the handler returns `409 already_registered` — it
never retries.

*Capacity* is **a conditional write, not a check-then-insert.** A `SELECT` inside a `.batch()`
cannot gate a sibling `INSERT`: D1's batch is all-or-nothing **only on error**, and a statement that
matches zero rows is a *successful* statement, so the batch still commits (§6.2, Appendix D rule
10). Re-reading `entrant_count` in the batch and "comparing" it is not a thing that can happen —
there is no procedural logic in a batch. The guard has to be carried by the writes themselves:

```sql
-- 1. the insert, gated on capacity
INSERT INTO entrants (id, tournament_id, entrant_no, display_name, /* … */ registered_at, created_at, updated_at)
SELECT ?1, ?2, (SELECT COALESCE(MAX(entrant_no), 0) + 1 FROM entrants WHERE tournament_id = ?2),
       ?3, /* … */ ?9, ?9, ?9
 WHERE (SELECT entrant_count FROM tournaments WHERE id = ?2)
       < COALESCE((SELECT max_entrants FROM tournaments WHERE id = ?2), 1000000000);

-- 2. the counter bump, gated identically
UPDATE tournaments
   SET entrant_count = entrant_count + 1, state_version = state_version + 1, updated_at = ?9
 WHERE id = ?2
   AND (max_entrants IS NULL OR entrant_count < max_entrants);
```

Then read `results[0].meta.changes` and `results[1].meta.changes`. **Both must be `1`.** Either
being `0` is `409 tournament_full` (or `409 registration_closed` with `details.reason: "full"` when
the waitlist is off). Because the condition is inside both statements, two simultaneous
registrations for slot 64 cannot both commit — SQLite serialises the two batches and the second one
sees the incremented `entrant_count`.

Every other statement in the same batch (`entrant_members` inserts, the `audit_log` row, the
`idempotency_keys` completion) carries the same `WHERE (SELECT entrant_count …) < …` guard, written
as `INSERT … SELECT … WHERE …`. Otherwise the losing registration would return `409` to the player
while having written a roster and an audit row for an entrant that does not exist.

**Waitlist.** When `waitlist_enabled = 1` and the capacity guard would fail, the handler runs a
*second*, different batch that inserts with `status = 'waitlisted'` and bumps `waitlist_count`
instead — it does not try to express both outcomes in one batch. See SECURITY.md §3.

### 3.4 `POST /api/v1/tournaments/:slug/guest-register`

Walk-in registration with **no account**. See AUTH.md §8 for the abuse model.

**Auth:** none. **Requires:** `join_code` when `tournaments.requires_join_code`, and a Turnstile token
when `TURNSTILE_SECRET_KEY` is configured. **Idempotency:** required.

**Body:** identical to §3.3 minus anything account-shaped, plus:
```jsonc
{ "display_name": "Kiran M", "phone_e164": "+91...", "turnstile_token": "0.abc...", "join_code": "K7QP2M" }
```

**201**
```jsonc
{ "data": { "entrant": { /* PrivateEntrant */ }, "guest_token": "kZ9...43 chars...", "position": "pending" } }
```

The `guest_token` is shown to the guest **once** with "save this link to check in" and is embedded in
a URL the SPA puts in a WhatsApp-shareable message:
`https://nellore.club/t/<slug>/entry/?g=<guest_token>`. It is a bearer capability scoped to exactly
one entrant. Losing it means asking the organizer, who can re-issue from §4.9.

**Errors:** `403 turnstile_failed`, `403 invalid_join_code`, `410 gone` (single-use invite already
used), `409 registration_closed`, `409 tournament_full`, `429 rate_limited`.

Guest entrants are always created with `status = "pending"` and require organizer confirmation,
regardless of the tournament's `requires_confirmation` setting.

**The join code is scoped to THIS tournament, and consumed atomically.** `invites.code_hash` is
`HMAC(INVITE_PEPPER, code)` over the code alone and carries a **global** `UNIQUE`, so the naive
lookup `WHERE code_hash = ?` returns a row from *any* tournament — a code printed at the desk for
the free carrom draw would open the paid BGMI cup's guest registration. Per-event scoping is the
entire value of the control. The lookup is therefore:

```sql
SELECT id FROM invites
 WHERE code_hash = ?1
   AND tournament_id = ?2            -- ← the tournament resolved from :slug, never from the body
   AND kind = 'join'
   AND revoked_at IS NULL
   AND (expires_at IS NULL OR expires_at > ?3)
   AND used_count < max_uses
 LIMIT 1;
```

and the consume is a conditional `UPDATE` inside the registration batch, never a read-then-write:

```sql
UPDATE invites SET used_count = used_count + 1 WHERE id = ?1 AND used_count < max_uses;
```

with `meta.changes === 1` required. A read-then-write lets a `single_use` code be redeemed N times
concurrently — the same race the design already solves correctly for WebAuthn challenges (AUTH.md
§3.6) and recovery codes (AUTH.md §4.3). A miss on the `SELECT` is `403 invalid_join_code`; a hit
whose `used_count` has since been exhausted is `410 gone`.

### 3.5 Guest self-service (header `X-Guest-Token`)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/guest/entrant` | The guest's own entrant (`PrivateEntrant`) **plus `next_match`, on the same terms as §3.9.1** — including `room_code` / `room_password` when the entrant is `checked_in`, is a participant of that match, and `room_code_publish_at` has passed. A guest squad needs the BGMI lobby code exactly as much as an account-holding one. |
| `POST` | `/api/v1/guest/entrant/checkin` | Same semantics as §3.7. |
| `POST` | `/api/v1/guest/entrant/withdraw` | Same semantics as §3.8. |
| `PATCH` | `/api/v1/guest/entrant` | Same body and rules as §3.6.1. |

No session cookie is involved, so no CSRF token is needed — a bearer token in a custom header cannot
be sent by a cross-site form, and a cross-site `fetch` with a custom header is preflighted and
blocked. `401 guest_token_invalid` on a bad token. Rate limited under the `guest` bucket keyed by
the token hash.

### 3.6 `GET /api/v1/entrants/:id`

Read one entrant in full.

**Predicate (normative, and it is NOT bare `S`):**
`MINE(e) ∨ ROSTERED(e) ∨ ORG_OF(entrant.tournament)`; **`404 not_found` otherwise.** See AUTH.md
§7.3, which now covers this read as well as the mutations.

This needs saying because the obvious reading — "any session" — is the cheapest attack in the
design. Entrant ids are not secret: `PublicEntrant.id` is returned by the unauthenticated
`GET /tournaments/:slug/entrants` (§1.6) and by the bracket (§1.7). Signup is open and free. So a
bare-session predicate lets any account walk the public entrant list of every tournament and then
`GET` each id, harvesting every organizer-visibility custom field — BGMI player IDs, `phone_last4`,
entrant notes, payment references — for the whole club, in one request loop. That defeats
SECURITY.md §4 Rule 7 and §10.2 in a single script, and SECURITY.md §4 Rule 1 already says "an id is
not a secret and must never be treated as one".

`ROSTERED(e)` — `EXISTS(entrant_members m WHERE m.entrant_id = e.id AND m.user_id = u.id AND
m.status = 'active')` — is **read-only**. `MINE(e)` as defined in AUTH.md §7.2 admits only the
entrant owner and the captain, so without `ROSTERED` a squad player could not see the entry they are
on. They still cannot edit it: §3.6.1 requires `MINE(e)`.

**200** — `PrivateEntrant`. `Cache-Control: private, no-store`.

### 3.6.1 `PATCH /api/v1/entrants/:id`

Edit **your own** registration.

**Predicate:** `MINE(e)` — `entrant.user_id = session.user_id` OR the caller is a member of the
entrant with `role = "captain"`. A non-captain roster member may read (§3.6) but not write. (See
AUTH.md §7.3 for the full table.)

**Allowed while:** the tournament is in `registration_open` **and** the entrant status is `pending`,
`confirmed`, or `waitlisted`, **and** `bracket_generated_at IS NULL`. Once the bracket exists a team
name change would desync every screenshot already in the WhatsApp group, so it is organizer-only from
that point (`409 entrant_locked`).

**Body:** `team_name`, `team_tag`, `members`, `fields`, `notes`, `phone_e164`. Same validation as §3.3.
`members` is a **full replacement** of the roster, not a patch — partial roster merging is the kind of
ambiguity that produces duplicated players.

**200** — `PrivateEntrant`. **409** `entrant_locked`, `registration_closed`. **404** if the predicate
fails and the entrant is not the caller's.

`PrivateEntrant` is `PublicEntrant` plus: all `fields` regardless of visibility **with every
`pii: true` `tel` value masked to `+91 ••••• •<last4>`** (SECURITY.md §10.2), `notes`,
`payment_status` (`not_required` | `pending` | `submitted` | `paid` | `refunded` | `waived`),
`payment_ref` (**omitted** for non-organizers), `organizer_note` (**omitted** for non-organizers),
`guest_phone_masked`, `version`, `updated_at`.

**There is no `checkin_code` on this object.** An earlier draft listed one, with no source column
and no visibility rule. There is no `entrants.checkin_code` in `db/schema.sql`; the only such column
is `tournaments.checkin_code`, a 4-digit code written on a board at the desk. The obvious way to
satisfy the field would have been to read that — handing the venue code to every entrant, and to
anyone holding a guest token, the moment they register, from anywhere in the world, which destroys
the only thing `checkin_requires_code` exists for. **`tournaments.checkin_code` is returned by
exactly one endpoint, `GET /api/v1/organizer/tournaments/:id` (§4.2b), and by no other.** If a
per-entrant code is ever genuinely wanted, add an `entrants.checkin_code` column in the schema
first.

### 3.7 `POST /api/v1/entrants/:id/checkin`

**Predicate:** `MINE(e)`, as §3.6.1.
**Window:** `tournaments.checkin_opens_at <= now <= tournaments.checkin_closes_at`. Outside it,
`409 checkin_closed` with `details.opens_at` / `details.closes_at`.
**Body:** `{}` or `{ "checkin_code": "4821" }` when `tournaments.checkin_requires_code` — the code is
read off a board at the venue, which is a cheap proof of physical presence for offline events.
**200** — `PrivateEntrant` with `status: "checked_in"`. Idempotent: checking in twice is a `200`, not
a `409`.

### 3.8 `POST /api/v1/entrants/:id/withdraw`

**Predicate:** `MINE(e)`, as §3.6.1.
**Body:** `{ "reason": "Can't make it" }` (optional, ≤ 200 chars).
**200** — status becomes `withdrawn`, `entrant_count` decrements, and **the first waitlisted entrant
is promoted to `pending` in the same batch** (or to `confirmed` if `requires_confirmation = 0`), with
an audit row for the promotion.
**409** `entrant_locked` if the bracket is generated and the entrant has a completed match — the
organizer must handle that as a forfeit (§4.13), because silently removing a player from a live
bracket corrupts it.

### 3.9 `GET /api/v1/me/registrations`

**Query:** `status` (comma-separated entrant statuses), `when` (`upcoming` | `past` | `all`, default
`upcoming`), `limit`, `cursor`.

**200** — collection of `{ entrant: PrivateEntrant, tournament: TournamentCard, my_role: "owner"|"captain"|"member", next_match: Match|null }`.

`next_match` is the caller's next `ready` or `live` match, or `null`. It is what the SPA puts
on the home screen during an event, and it saves a second round-trip.

#### 3.9.1 Room codes reach the squad here, and only here

`db/schema.sql` says of `matches.room_code` / `room_password`: *"returned only to checked-in
entrants of this match and to staff"*. This is that endpoint. Without it BGMI and Free Fire — the
headline esports use case, and the reason `games.needs_room_code` exists — have no in-product way to
deliver a lobby code, and the organiser's only option is `publish_room_codes = 1`, which is exactly
the outcome §1.7 warns about.

`next_match` carries `room_code` and `room_password` **iff all three hold**:

1. the caller satisfies `MINE(e)` or `ROSTERED(e)` (or `GUEST(e)` on `GET /api/v1/guest/entrant`)
   for an entrant that is a participant of that match — a slot on it, or a `match_participants` row
   for a lobby;
2. `entrant.status = 'checked_in'` — a registered-but-absent squad does not get the code;
3. `matches.room_code_publish_at IS NULL OR matches.room_code_publish_at <= now`.

Otherwise both fields are `null` (present-but-null, so the client never has to branch on absence).

This response is `private, no-store` and is never edge-cached. **These two fields must never appear
on any `/api/v1/tournaments/:slug/*` route** — a public response that varies by identity is exactly
what §1's invariant forbids, and it would be an unbounded leak the moment one is cached.

**`POST /api/v1/me/registrations/:entrant_id/leave`** — removes the caller from another person's
roster (the escape hatch from §3.3). `204`. Fails `409 entrant_locked` once the bracket exists.

**`POST /api/v1/me/registrations/claim`** — body `{ "guest_token": "..." }`. A player who entered as a
guest and later created an account attaches that entry to it: sets `entrants.user_id`, clears
`guest_token_hash`. Allowed **only** while the tournament is not yet `completed` (`409 conflict`,
`details.reason: "tournament_completed"`, otherwise) — a completed tournament's winning entry must not
be claimable by whoever gets hold of the token, because claiming it would inherit its leaderboard
points. Audited. **200** with the `PrivateEntrant`. See AUTH.md §8.3.

### 3.10 Credentials and sessions (self-service)

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/v1/me/credentials` | `[{ id, label, created_at, last_used_at, backed_up, device_type, aaguid_name }]` |
| `POST` | `/api/v1/me/credentials/options` | Add another passkey. Session + UV. |
| `POST` | `/api/v1/me/credentials/verify` | Completes it. `201`. |
| `PATCH` | `/api/v1/me/credentials/:id` | `{ "label": "Redmi Note 13" }`, ≤ 40 chars. |
| `DELETE` | `/api/v1/me/credentials/:id` | Step-up. **409 `conflict`** with `details.reason: "last_credential"` if it is the only one and no unused recovery codes remain — never let a user lock themselves out. |
| `GET` | `/api/v1/me/sessions` | `[{ id, current: bool, created_at, last_seen_at, ip_city, ua_summary, uv }]`. `ip_city` comes from `request.cf.city`; the raw IP is never stored or returned (SECURITY.md §10.3). |
| `DELETE` | `/api/v1/me/sessions/:id` | Revoke one. `204`. |
| `DELETE` | `/api/v1/me/sessions` | Revoke **all others**, keep the current one. Step-up. `204`. |

### 3.11 DPDP rights endpoints

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/v1/me/export` | `200 application/json` attachment: every row about this user — profile, entrants, members, matches played, audit rows where they are the actor. Rate-limited to 1/hour. Satisfies the DPDP right to access. |
| `DELETE` | `/api/v1/me` | Step-up + UV. Body `{ "confirm_handle": "sudheer" }` must match. Schedules erasure: sets `users.deletion_requested_at`, revokes all sessions, hides the profile immediately. A cron finalises after **30 days**: PII is nulled, `handle` becomes `deleted_<short id>`, and entrant rows are retained but anonymised so historical brackets and other players' records stay intact. `202` with `{ "finalises_at": "..." }`. |
| `POST` | `/api/v1/me/undelete` | Within the 30-day window, cancels the request. `200`. |

Retaining anonymised entrant rows is a legitimate-purpose retention under DPDP §4 — a published
bracket is a record of a competition that other participants also have an interest in. This is stated
on the privacy page. See SECURITY.md §10.

### 3.12 Roster invites — `/i/<code>/`

`IA.md` Journey 2 step 5 makes invite links the **default** squad sub-mode: three "Invite player"
rows, each generating `/i/<code>/`, shared to WhatsApp, because *"nobody types four BGMI IDs on one
phone"*. `db/schema.sql` ships `invites.kind = 'roster'` and `invites.entrant_id` for it. These are
the three endpoints behind it. Without them that column pair is dead, the documented happy path of
the flagship BGMI scenario has no server, and the only way out would be deleting a feature from
`IA.md`, which no implementer is authorised to do.

The manual fallback (`members[].display_name` in §3.3) always remains available and is one toggle
away in the UI.

#### 3.12.1 `POST /api/v1/entrants/:id/roster-invites`

**Predicate:** `MINE(e)` — the captain or the entrant owner, nobody else. Not `ROSTERED`: a squad
member cannot mint invitations to the squad they were added to.

**Also required:** `t.status = 'registration_open'` and `t.bracket_generated_at IS NULL`, else
`409 entrant_locked`. And `e.status ∈ {pending, confirmed, waitlisted}`.

**Body:** `{ "count": 3, "expires_at": "2026-11-07T18:30:00Z" }` — `count` ≤ `team_size_max +
substitutes_max` minus the current active member count (else `400 validation_failed`,
`details.fields["count"] = "out_of_range"`); `expires_at` optional, defaults to
`tournaments.registration_closes_at`, capped at it.

Creates `count` rows in `invites` with `kind = 'roster'`, `tournament_id = e.tournament_id`,
`entrant_id = :id`, `mode = 'single_use'`, `max_uses = 1`, `code_hash = HMAC(INVITE_PEPPER, code)`.
Same 6-character alphabet as §4.18.

**201** `{ "data": { "codes": ["K7QP2M", "R3XB9T", "W4NDF8"], "expires_at": "...", "urls": ["https://nellore.club/i/K7QP2M/", ...] } }`
— the plaintext codes are returned **once** and are unrecoverable afterwards. Audited.
Rate-limited under `rl_write`.

#### 3.12.2 `GET /api/v1/invites/:code`

**Public, no auth.** The landing read for `/t/<slug>/register/?invite=<code>` — the invitee has not
signed in yet and must be told what they are joining before being asked to create a passkey.

**200** — and this is the **complete** response body; nothing else is ever added to it:

```jsonc
{ "data": {
    "valid": true,
    "kind": "roster",
    "tournament": { "slug": "bgmi-diwali-2026", "title": "BGMI Diwali Cup 2026",
                    "game": { "slug": "bgmi", "name": "BGMI" }, "starts_at": "2026-11-08T13:30:00Z" },
    "entrant_display_name": "Team Falcon",
    "slot_no": 3,
    "expires_at": "2026-11-07T18:30:00Z"
} }
```

No entrant id, no member list, no phone numbers, no organiser fields. The code is a bearer token
shared over WhatsApp and will end up in screenshots; it buys exactly enough to render the accept
screen. An unknown, revoked, expired or consumed code is `404 not_found` with
`{ "data": { "valid": false } }` — deliberately *not* `410`, because distinguishing "consumed" from
"never existed" turns the endpoint into an oracle for guessed codes.

`Cache-Control: private, no-store`. Rate-limited under `rl_read` **and** `rl_guest` (5/60 s per IP
hash) — this is a code-guessing surface with the same ~28.5 bits as a join code.

#### 3.12.3 `POST /api/v1/invites/:code/accept`

**Session required** (`FULL`). The invitee signs up or signs in first; the client holds the code
across the passkey ceremony.

**Body:** `{ "display_name": "Kiran M", "fields": { "bgmi_ign": "FALCON•Kiran", "bgmi_player_id": "5987654321" } }`
— `fields` validated against the effective schema's **`member_fields`**, unknown keys **rejected**
(it is a `POST`, §3.3).

Effects, in one `.batch()`, every statement guarded on the same conditional consume:

```sql
UPDATE invites SET used_count = used_count + 1
 WHERE id = ?1 AND kind = 'roster' AND revoked_at IS NULL
   AND (expires_at IS NULL OR expires_at > ?now) AND used_count < max_uses;
```

`meta.changes === 1` is required. Then one `entrant_members` row with `user_id = session.user_id`,
`entrant_id = invites.entrant_id`, `tournament_id`, the next free `slot_no`, `role = 'player'`,
`status = 'active'`; plus the entrant's `updated_at`/`version` bump, the tournament's
`state_version` bump, and the `audit_log` row.

**Errors**

| Status | Code | When |
| --- | --- | --- |
| `410` | `gone` | Consumed, revoked or expired code (`meta.changes === 0`). The invitee *has* a session here, so the ambiguity of §3.12.2 buys nothing and a clear message is better. |
| `409` | `conflict`, `details.reason: "already_on_a_team"` | `ux_member_one_team` fires — one human, one team, per tournament. |
| `409` | `conflict`, `details.reason: "roster_full"` | Active member count already at `team_size_max + substitutes_max`. |
| `409` | `registration_closed` | The tournament left `registration_open`. **A roster invite is not honoured after registration closes**, even if the code is still inside its `expires_at`: a squad's roster is what the organiser confirmed. The captain must ask the organiser to add the player (§4.8). |
| `409` | `entrant_locked` | `bracket_generated_at IS NOT NULL`. |
| `404` | `not_found` | Unknown code. |

**200** — the `PrivateEntrant` the caller has just joined, which is now readable by them under
`ROSTERED(e)` (§3.6).

The predicate rows for all three endpoints are in AUTH.md §7.3. Note what
`POST /invites/:code/accept` is: **the one endpoint in the product that writes a row belonging to an
object the caller does not own.** It is safe only because the write is a single, shaped, fully
specified insert — one `entrant_members` row, for the caller's own `user_id`, into the entrant the
*code* names — and because the code is single-use and consumed atomically in the same batch. It
takes no entrant id from the caller.

---

## 4. Organizer API

**Predicate for everything in this section:** `session.user.role IN ('organizer','admin')` **AND**
(`role = 'admin'` OR the caller is the tournament's `owner_user_id` OR has a **non-revoked** row in
`tournament_organizers`). **`tournament_organizers.role` is enforced, not decorative**: `scorer` and
`moderator` are strictly narrower than `organizer` (AUTH.md §7.2 defines `SCORER_OF(t)`,
`ORG_OF(t)` and `OWNER_OF(t)`). The exact per-endpoint predicate is tabulated in AUTH.md §7.3 and
that table is normative.

All responses `Cache-Control: private, no-store`. All mutations require `X-CSRF-Token` and `Origin`.
Every mutation writes an `audit_log` row **inside the same `.batch()` as the mutation itself** — see
SECURITY.md §2.3.

Tournaments are addressed by **`:id`** here, not slug, so a rename does not break an organizer's open
tab.

### 4.1 `GET /api/v1/organizer/tournaments`

**Query:** `status` (any, including `draft` and `archived`), `game`, `q`, `mine` (`true` default;
`false` is admin-only and returns all), `limit`, `cursor`.
**200** — collection of `TournamentCard` + `{ draft: bool, my_role: "owner"|"co_organizer"|"admin", unconfirmed_count, pending_scores_count }`.

### 4.2 `POST /api/v1/organizer/tournaments`

**Idempotency:** required.

**Body**
```jsonc
{
  "title": "BGMI Diwali Cup 2026",
  "slug": "bgmi-diwali-2026",            // optional; derived from title if absent
  "game_slug": "bgmi",
  "season_slug": null,                   // optional; null = the row with is_active = 1. §4.2.0
  "format": "points_lobby",               // §4.2.1
  "participant_type": "team",
  "summary": "Squad BR, 4 matches.",     // ≤ 200 chars plain text
  "rules_md": "## Rules\n\n- No emulators.\n", // markdown source, ≤ 20000 chars — server compiles to rules_ast (§9)
  "starts_at": "2026-11-08T13:30:00Z",
  "ends_at": "2026-11-08T18:00:00Z",
  "registration_opens_at": "2026-10-20T04:30:00Z",
  "registration_closes_at": "2026-11-07T18:30:00Z",
  "checkin_opens_at": "2026-11-08T12:00:00Z",
  "checkin_closes_at": "2026-11-08T13:15:00Z",
  "requires_checkin": true,
  "checkin_requires_code": false,
  "venue_id": null,
  "venue_mode": "online",                 // "online" | "onsite" | "hybrid"
  "entry_fee_paise": 20000,
  "prize_pool_paise": 1500000,
  "prizes": [ { "position": 1, "label": "Winner", "amount_paise": 800000, "extra": "Trophy" } ],
  "max_entrants": 100,
  "waitlist_enabled": true,
  "requires_confirmation": true,
  "requires_phone": true,
  "min_account_age_hours": 0,
  "allow_guest_registration": true,
  "requires_join_code": true,
  "entrants_public": true,
  "publish_room_codes": false,
  "require_dual_confirm_final": false,
  "team_size_min": 4, "team_size_max": 4, "substitutes_max": 1,
  "format_config": { "best_of": 1, "third_place_match": true },
  "scoring_config": { "placement_points": [10,6,5,4,3,2,1,1,1,1], "kill_points": 1, "matches_count": 4 },
  "registration_schema": null,           // null = inherit the game's
  "contact": { "whatsapp_group_url": "https://chat.whatsapp.com/ABC", "public_phone": null },
  "leaderboard_weight_pct": 100,         // integer percent applied to points at publish; 0 = does not count
  "stages": [ /* optional; see §4.2.1. Absent = one implicit stage from `format`. */ ]
}
```

**Slug rules.** Lowercase, `^[a-z0-9][a-z0-9-]{1,40}$`, must not end in a hyphen, no consecutive hyphens, and not in
the reserved list (Appendix B). Collision → the server appends `-2`, `-3`, … when the slug was
derived, and returns `409 slug_taken` when it was explicitly supplied.

**201** — full tournament object with `status: "draft"`.

#### 4.2.0 `season_slug` and the active season

`points_ledger.season_id` is `NOT NULL REFERENCES seasons(id) ON DELETE RESTRICT`, while
`tournaments.season_id` is nullable with no default. Nothing else in this document ever set it, so
**every tournament would have been created with `season_id = NULL` and the first
`POST .../publish` would have violated a NOT NULL constraint inside the publish batch** — failing
the single most important organiser action, at the end of the event, in front of the room. So:

- `POST /organizer/tournaments` accepts an optional `season_slug`. When absent (the normal case, and
  what the create form sends), the server resolves `SELECT id FROM seasons WHERE is_active = 1` and
  writes it to `tournaments.season_id`.
- An unknown `season_slug` → `400 validation_failed`, `details.fields["season_slug"] = "not_found"`.
- If neither a `season_slug` nor an active season exists → `409 conflict`,
  `details.reason: "no_active_season"`. `db/seed.sql` creates one `seasons` row with `is_active = 1`,
  so this only fires after a season ends and none has been started.
- `season_id` is editable via `PATCH` while `status = 'draft'` and locked from `published` onward
  (add it to the §4.3 table's `draft`-only row). Moving a published tournament between seasons would
  silently re-bucket its `points_ledger` rows.
- `POST .../publish` resolves `season_id = tournaments.season_id ?? (SELECT id FROM seasons WHERE
  is_active = 1)` and refuses with the same `409 no_active_season` when neither exists (§4.16).

Seasons themselves are managed at `GET/POST/PATCH /api/v1/admin/seasons` (§5.9). Before that
endpoint existed, `seasons` was the one table in the schema with no write path at all — when the
seeded season ended there was no way to start a new one short of `wrangler d1 execute` against
production.

#### 4.2.1 Format enum

```
single_elim | double_elim | round_robin | swiss | points_lobby
```

**This enum is owned by `BRACKET-ENGINE.md` and reproduced here.** Do not add a value to it in this
document. `br_points` is the **scoring model** (`games.scoring_model`); `points_lobby` is the
**format** (`stages.format`). They are different axes and both strings now appear in exactly one
place each. `IA.md`'s old `br_points_series` has been removed. In particular there
is no `groups_knockout` format: group-stage-then-knockout is expressed
as a **multi-stage** tournament (a `round_robin` or `points_lobby` stage feeding a `single_elim`
stage), per `BRACKET-ENGINE.md` §10.6 and the `multi_stage` flag in the game definition.

**Stages on the wire: `body.stages`, a top-level array — NOT `format_config.stages`.** An earlier
draft claimed "the API surfaces stages through `format_config.stages`", and `format_config.stages`
was defined nowhere in any document. It does not exist. `format_config` remains what it always was:
the free-form per-tournament option blob for the **implicit single stage**.

`POST /organizer/tournaments` accepts an optional top-level `stages` array. Each element is exactly
the `POST /organizer/tournaments/:id/stages` body of §4.23.2:

```jsonc
"stages": [
  { "ordinal": 1, "name": "Group Stage", "format": "round_robin",
    "group_count": 4, "best_of": 1, "advance_count": 2,
    "seed_source": "registration",
    "points_win": 3, "points_draw": 1, "points_loss": 0, "points_bye": 0, "points_divisor": 1,
    "tiebreakers": ["points", "net_run_rate", "head_to_head", "wins", "seed"] },
  { "ordinal": 2, "name": "Playoffs", "format": "single_elim",
    "best_of": 1, "final_best_of": 1, "third_place_match": true,
    "seed_source": "previous_stage", "source_stage_ordinal": 1 }
]
```

Inside a create body, a later stage refers to an earlier one by **`source_stage_ordinal`**, because
no stage id exists yet; the server resolves it to `source_stage_id` as it inserts. Everywhere else
(§4.23) the field is `source_stage_id`.

Rules: `ordinal` must be `1..n` with no gaps and no duplicates (`400 validation_failed`); at most
**4** stages (`details.fields["stages"] = "too_many"`); `seed_source: "previous_stage"` is illegal
on ordinal 1; `advance_count` is required on any stage that another stage sources from.

**When `stages` is absent** — which is what the simple create form sends and what every
single-stage tournament does — the server creates **exactly one** stage with `ordinal: 1`,
`format = body.format`, `name = "Main"`, `seed_source` from `tournaments.seeding_method`, and its
shape columns projected from `format_config` + `scoring_config`. The organiser never sees the word
"stage" and nothing in the UI changes.

Stages can also be created, edited and deleted after the fact (§4.23) while the tournament is in
`draft`, `published` or `registration_open` and the stage has no bracket. `body.stages` is a
convenience for the create wizard, not the only path.

The `groups` array in the bracket response (§1.7) is a *within-stage* grouping and is a different
axis entirely; do not conflate the two.

The API's only validation rule: `format` is checked against the game's declared formats and a
mismatch produces a **warning in the response**, never a rejection. A club that wants a Swiss carrom
event must not be blocked by a data row.

### 4.2b `GET /api/v1/organizer/tournaments/:id`

The organiser's read of one tournament. Appendix C has always listed this route and §9 makes it the
**only** place `rules_md` (the markdown source, as opposed to the compiled `rules_ast`) is returned;
it simply had no section.

**`:id` accepts EITHER a `trn_` id OR a slug.** The router disambiguates on the `trn_` prefix:
`^trn_[0-9A-HJKMNP-TV-Z]{26}$` → id, anything else → slug. This is not a convenience — it is load
bearing. `IA.md` §1.1 addresses the entire organiser surface by slug (`/admin/t/<slug>/score/`,
`/seeding/`, `/registrations/`, …) while every other organiser endpoint takes `:id`. On a cold load
of `/admin/t/<slug>/score/` the admin shell has a slug and no id, and its only alternatives would be
to scan its own tournament list or to call the public `GET /api/v1/tournaments/:slug` — which 404s
for a draft (§1.5). Scenario 2 runs entirely on that URL.

Once resolved, every subsequent organiser call in that session uses the returned `id`.

**Predicate:** `ORG_OF(t)`. `404 not_found` otherwise — including for a tournament that exists and
belongs to someone else, because confirming an unannounced rival event by slug is exactly what §1.5
refuses to do.

**200** — the §1.5 body (including `draft` and `archived`, which §1.5 hides) plus the
organiser-only fields:

```jsonc
{ "data": {
    /* …everything from §1.5… */
    "rules_md": "## Rules\n\n- No emulators.\n",   // the markdown SOURCE, for the editor
    "description_md": null,
    "checkin_code": "4821",          // tournaments.checkin_code — returned by THIS ENDPOINT ONLY
    "seeding_method": "registration",
    "bracket_seed": 2874118342,
    "season": { "slug": "2026-27", "name": "Season 2026-27" },
    "stages": [ /* §4.23.1 */ ],
    "version": 12, "state_version": 41, "bracket_version": 7,
    "counts": { "entrant": 62, "confirmed": 58, "checked_in": 0, "waitlist": 0,
                "pending_scores": 3, "unconfirmed": 4 },
    "organizers": [ { "handle": "kiran", "display_name": "Kiran", "role": "scorer",
                      "added_at": "...", "added_by": "sudheer" } ]
} }
```

`Cache-Control: private, no-store`.

### 4.3 `PATCH /api/v1/organizer/tournaments/:id`

Same body as §4.2, all fields optional, plus `version` for optimistic concurrency (see §6.2).
`:id` here is a `trn_` id only — §4.2b is the one endpoint that also takes a slug.

**Field mutability by status** — enforced server-side, not just in the UI:

| Status | Freely editable | Locked (409 `invalid_state_transition` with `details.field`) |
| --- | --- | --- |
| `draft` | everything, including `season_slug` and `stages` | — |
| `published`, `registration_open` | title, summary, rules, times, prizes, contact, venue, `max_entrants` (only upward once entries exist), schema **additions**; stages that have no bracket (§4.23.3) | `game_slug`, `format`, `participant_type`, `team_size_*`, **`season_slug`**, removing or retyping an existing `registration_schema` field |
| `registration_closed`, `live` | title, summary, rules, contact, venue, times, prizes, `publish_room_codes` | everything structural, plus `scoring_config` once any score exists |
| `completed` | summary, rules, contact | everything else |
| `archived`, `cancelled` | nothing | everything (`409 conflict`) |

Changing `slug` is allowed until `published` and never after — a published slug is already in WhatsApp
messages. To rename after publish, the organizer creates a redirect via admin (§5.7).

### 4.4 `POST /api/v1/organizer/tournaments/:id/status`

**Body:** `{ "to": "registration_open", "version": 12, "reason": "..." }` (`reason` required for
`cancelled`).

**Legal transitions**

```
draft ──► published ──► registration_open ──► registration_closed ──► check_in ──► live ──► completed ──► archived
  │            │                  │                      │                 │           │          │
  └─(delete)   └────────────► cancelled ◄─────────────────┴─────────────────┴───────────┘          │

`check_in` is optional: when tournaments.require_check_in = 0 the organizer goes
registration_closed ──► live directly. `registration_closed ──► check_in ──► live` is the
default path for an onsite event.                                                                   │
                                                                                                     │
completed ──► live   (admin only, "unpublish/reopen" — see §4.16)  ◄─────────────────────────────────┘
```

Everything not drawn is `409 invalid_state_transition` with `details.allowed`.

Extra guards:
- `registration_open` requires `registration_opens_at`, `registration_closes_at`, and either
  `max_entrants` or `waitlist_enabled = false`.
- `check_in` requires `check_in_opens_at` and `check_in_closes_at`.
- `live` requires `bracket_generated_at IS NOT NULL` for bracketed formats, or at least 2 confirmed
  entrants for `points_lobby`.
- `completed` is reached through `POST /publish` (§4.16), not through this endpoint.
- `cancelled` from any pre-`completed` state; sets `cancelled_reason`, makes §1.5 return `410`, and
  posts an automatic `urgent` announcement.

**200** — the updated tournament. Bumps `state_version` and `listing_version`.

### 4.5 `DELETE /api/v1/organizer/tournaments/:id`

Only when `status = "draft"` **and** `entrant_count = 0`. Otherwise `409 conflict` with
`details.reason: "use_archive"` — real tournaments are archived, never deleted, because their matches
feed the leaderboard. `204`.

### 4.6 `GET /api/v1/organizer/tournaments/:id/entrants`

The **unredacted** list: organizer notes, payment status, and custom fields of every visibility
**with every `pii: true` `tel` value masked to `phone_last4`** — plus `phone_masked`. The **full
phone is not in this response, in any field** — see §4.10 and SECURITY.md §10.2.

That qualifier is not pedantry. `content/games.json`'s `field_presets` ship four `type: "tel"`,
`pii: true` fields — `captain_whatsapp`, `alt_whatsapp`, `player_whatsapp`, `guardian_whatsapp` —
which are on the default registration form of every team game in the catalogue. Returning them raw
would make this paginated, un-audited endpoint hand out up to 100 plaintext WhatsApp numbers per
call, bypassing the entire audited-single-lookup design. Per SECURITY.md §10.2 the Worker encrypts
`tel` values on write and stores only the mask in `fields_json`, so the mask is what a correct
implementation naturally returns; this line says so explicitly so nobody "fixes" it back.

**Query:** `status`, `q` (matches team name, member display name, handle, or in-game ID),
`checked_in` (`true`/`false`), `payment` (`not_required`/`pending`/`submitted`/`paid`/`refunded`/`waived`), `sort`
(`seed_asc` | `registered_asc` | `name_asc`), `limit` (default 50, max 100), `cursor`.

**200** — collection of `PrivateEntrant` + `meta.counts`:
`{ total, pending, confirmed, waitlisted, checked_in, withdrawn, disqualified }`.

### 4.7 `POST /api/v1/organizer/tournaments/:id/entrants`

Add a walk-in by hand (the common case at an offline event: someone shows up at the desk).

**Idempotency:** required.
**Body:** same as §3.4, minus `turnstile_token` and `join_code`, plus
`{ "user_handle": "arjun_n" }` to link an existing account instead of creating a guest, and
`{ "status": "confirmed" }` to skip the pending state (default `confirmed` — an organizer typing it
in *is* the confirmation), and `{ "payment_status": "paid" }`.

**201** — `PrivateEntrant`. `409 tournament_full` unless `{ "override_capacity": true }` is sent, which
is allowed for organizers and audited.

### 4.8 `PATCH /api/v1/organizer/entrants/:id`

The organizer's entrant control surface.

**Body** (all optional, `version` required)
```jsonc
{
  "version": 3,
  "status": "confirmed",        // pending|confirmed|waitlisted|checked_in|withdrawn|disqualified
  "seed": 1,
  "team_name": "Team Falcon",
  "team_tag": "FLCN",
  "members": [ /* full replacement */ ],
  "fields": { },
  "payment_status": "paid",
  "payment_ref": "UPI 4417/882",   // ≤ 60 chars; free text; NOT a payment integration
  "organizer_note": "Paid cash at desk.",  // ≤ 500 chars, never public
  "dq_reason": "Used an emulator."  // required when status → disqualified
}
```

**Status transition side effects**
- → `confirmed` from `pending`/`waitlisted`: increments `confirmed_count`, checks capacity unless
  `override_capacity`.
- → `waitlisted`: decrements `confirmed_count`.
- → `withdrawn` / `disqualified` after the bracket exists: **does not** rewrite the bracket. It marks
  the entrant, and every `ready`/`pending` match containing them becomes eligible for a walkover,
  which the organizer applies explicitly via §4.13 with `outcome: "walkover"`. Automatic cascading
  would silently rewrite results; a disqualification is a judgement call and every downstream effect
  must be an explicit, audited act.
- → `disqualified` requires `dq_reason` and writes an audit row with it.

**200** — `PrivateEntrant`. **409 `stale_version`** on a version mismatch, with `details.current`.

`status` also accepts **`no_show`**, which the check-in-close cron writes (AUTH.md §10.7) and an
organiser can set or clear by hand for the player who walked in at 8:10. Setting it requires
`status_changed_at` to be written in the same statement — the schema CHECK enforces it, and
`BRACKET-ENGINE.md` §13.3 forfeits from that instant, never retroactively.

**Payment fields are role-gated.** `payment_status`, `payment_ref` and `paid_amount_paise` require
`role IN ('owner','organizer')` on `tournament_organizers` (or `users.role = 'admin'`); a `scorer`
sending them gets `403 forbidden` with `details.fields` naming them, and the rest of the patch is
**not** applied. See AUTH.md §7.2.

### 4.8b `DELETE /api/v1/organizer/entrants/:id`

**Predicate:** `ORG_OF(t) ∧ ¬(entrant has a completed match)` (AUTH.md §7.3).

Hard-deletes a registration and cascades `entrant_members`, `stage_entrants` and any
`match_participants` rows. This is the "someone typed the same walk-in twice at the desk" button,
not the withdrawal button — withdrawal is `PATCH .../status = 'withdrawn'` (§4.8), which preserves
the record and lets the bracket handle it as a walkover.

**Preconditions**, all `409 conflict` with `details.reason`:
- `entrant_has_results` — the entrant is in any match with `status = 'complete'`;
- `bracket_locked` — `t.results_published_at IS NOT NULL`.

Deleting an entrant that is *in* a generated bracket but has no completed match is allowed and
leaves the skeleton intact: the entrant simply resolves to absent and every match containing them
becomes a walkover for the opponent (`BRACKET-ENGINE.md` §13.1). Prefer `withdrawn` for that; this
is for junk rows.

Effects, in one `.batch()`: the delete, decrement `entrant_count` (and `confirmed_count` /
`checked_in_count` / `waitlist_count` as applicable), promote the first waitlisted entrant if the
deleted row was confirmed, bump `state_version` and `listing_version`, write the `audit_log` row
(which carries the full deleted row in `before_json`, PII redacted).

**204.**

### 4.9 `POST /api/v1/organizer/entrants/:id/guest-token`

Re-issues a guest entrant's capability token (the walk-in lost their link). Invalidates the old one.
**200** `{ "data": { "guest_token": "...", "url": "https://nellore.club/t/<slug>/entry/?g=..." } }`.
Audited. Only valid when `entrant.user_id IS NULL`.

### 4.10 `GET /api/v1/organizer/entrants/:id/contact`

The **only** endpoint that returns a full phone number, and it exists so that the general entrant
list does not.

**200** `{ "data": { "phone_e164": "+919876504417", "whatsapp_url": "https://wa.me/919876504417", "email": null } }`
**Every call writes an `audit_log` row** with `action: "entrant.contact.view"`. Rate-limited to 60/hour
per organizer. See SECURITY.md §10.2.

### 4.11 `POST /api/v1/organizer/tournaments/:id/entrants/reseed`

**Body**
```jsonc
{ "version": 12, "method": "random", "seed_value": 8172 }   // "random" | "registration_order" | "manual"
// or
{ "version": 12, "method": "manual", "seeds": [ { "entrant_id": "ent_...", "seed": 1 }, { "entrant_id": "ent_...", "seed": 2 } ] }
```

`"method": "rating"` returns **`400 validation_failed`**,
`details.fields["method"] = "rating_not_implemented"` — club ratings are not implemented in v1
(§1.12.2), `entrants.rating` is `NULL` for every row, and a silent fallback to registration order
would produce a wrong draw that looks right. `IA.md` 4d's "By club rating" preset is hidden while
`config.features.rating` is false, which it always is in v1.
`random` requires `{ "seed_value": 8172 }` or generates and returns one, so a draw can be re-run and
audited as fair. Rejected if `bracket_generated_at IS NOT NULL` unless `force: true` (which also
requires no completed matches, else `409 bracket_locked`).

**200** `{ "data": { "seeded": 64, "method": "rating", "seed_value": null } }`. Executed as one
`.batch()`, chunked at 200 statements (Appendix D).

### 4.12 `POST /api/v1/organizer/tournaments/:id/bracket`

Generate the bracket/fixtures **for stage 1**. For a multi-stage tournament, stage 2 onward is
`POST /organizer/stages/:id/seed` followed by this endpoint scoped to that stage — see §4.23.

**Idempotency:** required.
**Body:** `{ "version": 12, "stage_id": null, "force": false, "options": { /* format-specific, passed to the bracket engine */ } }`.
`stage_id` defaults to the lowest-`ordinal` stage with `bracket_generated_at IS NULL`.

**201** — the same body as §1.7, from the organizer's view (room codes included).
**409 `bracket_exists`** unless `force: true`; `force` additionally requires zero completed matches
(else `409 bracket_locked` with `details.completed_matches`).
**409 `conflict`** with `details.reason: "not_enough_entrants"` and `details.confirmed_count`.
**409 `conflict`** with `details.reason: "too_many_matches"`, `details.match_count` when the
generated skeleton would take the tournament past `MAX_MATCHES_PER_TOURNAMENT = 1024` (§1.7). This
is checked against the returned `Skeleton` **before** the first insert statement, so nothing is
written.
**409 `conflict`** with `details.reason: "stage_not_seeded"` when the target stage has
`seed_source = 'previous_stage'` and no `stage_entrants` rows (call §4.23.4 first).

Which entrants go in — for stage 1: `status IN ('confirmed','checked_in')`, or, when
`requires_checkin = 1` and the check-in window has closed, `status = 'checked_in'` only. Body may
override with `{ "include_statuses": ["confirmed","checked_in"] }`. For stage 2+: exactly the
`stage_entrants` rows written by §4.23.4, and `include_statuses` is ignored.

**What is written**, per stage, in one `.batch()` per 200 statements:
`stage_entrants` (with the canonical dense seed from `Skeleton.seedList` — immutable thereafter),
`matches` (with `match_no = MAX(match_no) + skeletonMatch.number`, computed once before the batch —
`BRACKET-ENGINE.md` §9.6), `match_participants` for lobby rows, and `stages.skeleton_json` +
`skeleton_hash`. `stages.bracket_generated_at` and `tournaments.bracket_generated_at` are set in the
**final** batch, so a partial failure leaves them null and the operation is safely retryable. If a
retry finds orphaned matches from a failed run (matches exist, `bracket_generated_at IS NULL`), it
deletes them first in the same operation — which is a bulk `DELETE FROM matches WHERE stage_id = ?`
and works only because the self-FKs are `ON DELETE NO ACTION`, not `RESTRICT` (see the note in
`db/schema.sql`). See Appendix D.

### 4.12b `DELETE /api/v1/organizer/tournaments/:id/bracket`

Clear a bracket so it can be regenerated. Required by `IA.md` 4d ("to reseed you must reset the
bracket, which clears all results") and by the reseed flow in §4.11. Regenerating a draw after a
late entrant is the single most common organiser action before an event goes live.

**Predicate:** `ORG_OF(t)`. **`version` required.**
**Query:** `stage_id` (optional; default = every stage of the tournament).

**Preconditions**, both `409 conflict` with `details.reason`:
- `has_completed_matches` — any match in scope has `status = 'complete'`. `details.completed_matches`
  lists their ids. (`POST .../reopen` first, if that is really what you mean.)
- `bracket_locked` — `results_published_at IS NOT NULL`.

**Effects, in one `.batch()` per 200 statements**, in this order:

1. `DELETE FROM match_participants WHERE stage_id IN (…)`
2. `DELETE FROM standings WHERE stage_id IN (…)`
3. `DELETE FROM matches WHERE stage_id IN (…)` — one bulk statement. `match_audit` rows **survive**:
   their `match_id` FK is `ON DELETE SET NULL` and they carry `match_code` / `match_no`
   (`db/schema.sql`), so the record of who entered and who cleared a disputed score is not destroyed
   by a bracket reset.
4. `DELETE FROM stage_entrants WHERE stage_id IN (…)` — for stages with `ordinal >= 2` **only**.
   Stage 1's `stage_entrants` are regenerated from `entrants`; stage 2+'s came from
   `seedNextStage` over a source stage whose standings have just been deleted, so they must go too
   and be re-seeded via §4.23.4.
5. `UPDATE stages SET skeleton_json = NULL, skeleton_hash = NULL, bracket_generated_at = NULL,
   rounds_completed = 0, status = 'pending' WHERE …`
6. `UPDATE tournaments SET bracket_generated_at = NULL, bracket_version = bracket_version + 1,
   state_version = state_version + 1, version = version + 1 WHERE id = ?1 AND version = ?2`
7. the `audit_log` row.

Statement 6 carries the `version` guard, and — per §6.2 — **every other statement in the batch
carries it too**, as `AND (SELECT version FROM tournaments WHERE id = ?1) = ?2`. Otherwise a stale
`version` returns `409` to the client having already deleted the bracket.

**204.** Idempotent: deleting a bracket that does not exist is also `204`.

### 4.13 `PUT /api/v1/organizer/matches/:id/score`

The single most security-sensitive endpoint in the product. See SECURITY.md §2.

**Idempotency:** required. **Concurrency:** `version` required.

**Body**
```jsonc
{
  "result_version": 3,              // matches.result_version as last read; see §6.2
  "method": "normal",               // "normal"|"walkover"|"forfeit"|"dq"|"no_contest"
  "is_draw": false,
  "scores": [
    { "entrant_id": "ent_A", "score": 2, "bonus": 0 },
    { "entrant_id": "ent_B", "score": 1, "bonus": 0 }
  ],
  "winner_entrant_id": "ent_A",     // required unless is_draw, or method is no_contest
  "detail": { "sets": [[21,19],[15,21],[21,17]] },   // → matches.result_detail_json
  "state": "complete",              // "live" | "complete"
  "note": "Third set played after a 10-min delay."   // ≤ 300 chars, lands in match_audit.reason
}
```

**Server-side validation, in this order:**
1. Predicate check (organizer of *this* tournament, or admin).
2. `409 bracket_locked` if `results_published_at IS NOT NULL`. Publishing freezes scores; an admin
   must unpublish first (§4.16).
3. `409 stale_version`.
4. Every `entrant_id` in `scores` must be a slot of **this** match. A foreign entrant id → `400 validation_failed`
   (`details.fields["scores"] = "entrant_not_in_match"`). This is the check that stops "set the winner
   to a team that is not even in this match".
5. `scores` must cover exactly the match's filled slots, once each.
6. Score values: **integers** `0..9999`. There are no fractional scores anywhere: chess's half-point
   convention is `stages.points_divisor = 2` with 2/1/0 stored, rendered as 1 / 0.5 / 0. A float
   score would put float equality inside a standings tiebreak comparison, which is where "these two
   are tied" quietly becomes "not tied" at the third decimal.
   `bonus` is an integer `-100..100`, and a non-zero `bonus` requires a `note`. `detail` validated against the
   game definition's `match_fields` (see `CONTENT.md`).
7. **The server recomputes the winner from `scores`** when `method = "normal"` and rejects a
   `winner_entrant_id` that contradicts them (`400 validation_failed`, `details.fields["winner_entrant_id"] = "contradicts_scores"`).
   The client's opinion about who won is never authoritative.
8. `is_draw: true` when the game definition does not allow draws → `400`.
9. `best_of` sanity: for a head-to-head format with `best_of = N`, the winner's score must be
   `ceil((N+1)/2)` and the total must be `≤ N`. Violations are a `400` unless `method != "normal"`.
10. Dual confirmation: if `tournaments.require_dual_confirm_final = 1` and this is the final, the
    first submission sets `state = "live"` and `pending_confirm_by`, and returns `202` with
    `{ "data": { "match": {...}, "awaiting_confirmation": true } }`. A **different** organizer then
    calls `POST /api/v1/organizer/matches/:id/confirm`.

**On success (`state: "complete"`), in one `.batch()`:**
- update the match, `result_version + 1`, `recorded_at`, `recorded_by`, **and
  `result_entrant_a_id` / `result_entrant_b_id` set to the two entrant ids in `scores`** — the
  participants *as recorded*. These two columns are written here and nowhere else, are never touched
  by the recompute diff, and are the sole source of `HeadToHeadResult.entrantAId`/`entrantBId`
  (`BRACKET-ENGINE.md` §7.4). Clearing a result NULLs them;
- insert a `match_audit` row with `kind: "result_set"` (or `"result_corrected"`), carrying
  `match_code` and `match_no` alongside `match_id` so the row survives a later bracket reset —
  append-only history; the previous score is never overwritten in place;
- run the engine's `resolveBracket` diff, which propagates the winner (and, for double elim, the
  loser) into the downstream `entrant_a_id`/`entrant_b_id` and flips those matches to `ready`;
- delete and re-insert the affected stage's `standings` rows;
- bump `tournaments.bracket_version` **and** `tournaments.state_version`;
- insert the `audit_log` row.

**Every statement in that batch carries the `result_version` guard, not just the first one.** D1's
`.batch()` is all-or-nothing **only on error**: a statement matching zero rows is a *successful*
statement and the batch still commits. So a batch whose guarded `UPDATE matches` matches nothing,
but whose audit insert, downstream slot writes and `state_version` bump are unguarded, **returns
`409 stale_version` to the client having already advanced the live bracket with the wrong entrant.**
Two organisers on two phones at the scorer's table is the normal case (§6.2), so this is not an edge
path. Concretely:

```sql
-- 1. the guarded UPDATE, first in the batch
UPDATE matches
   SET winner_entrant_id = ?, score_a = ?, score_b = ?, method = ?,
       result_entrant_a_id = ?, result_entrant_b_id = ?,
       recorded_by = ?, recorded_at = ?, updated_at = ?,
       result_version = result_version + 1
 WHERE id = ?1 AND result_version = ?2;

-- 2..n. every other statement repeats the condition
UPDATE matches SET entrant_a_id = ?, status = ?, updated_at = ?
 WHERE id = ?dst AND (SELECT result_version FROM matches WHERE id = ?1) = ?2;

INSERT INTO match_audit (id, match_id, match_code, match_no, stage_id, tournament_id, actor_user_id, at, kind, before_json, after_json, reason)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
 WHERE (SELECT result_version FROM matches WHERE id = ?1) = ?2;

UPDATE tournaments SET bracket_version = bracket_version + 1, state_version = state_version + 1
 WHERE id = ?tid AND (SELECT result_version FROM matches WHERE id = ?1) = ?2;
```

Then read `results[0].meta.changes`. `0` → `409 stale_version`, **with the guarantee that zero rows
were written anywhere in the batch**. `1` → success. The subquery re-reads the pre-update value
inside the same transaction for statements 2..n only because statement 1 has already incremented it
— so bind `?2 + 1` there, or (clearer, and what the implementer should write) bind the **new**
version to statements 2..n and the old one to statement 1. Either form is correct as long as every
statement is conditional on the same fact.

**Rejected: check the version in a pre-read, then write an unguarded batch.** There is a window
between the read and the batch, and the whole point of the counter is to close it. Appendix D rule
10 is about *errors*; it is not a licence to leave siblings unguarded.

**200** `{ "data": { "match": { /* §1.7 match */ }, "advanced": [ { "match_id": "mat_...", "slot": 0, "entrant_id": "ent_A" } ], "standings_dirty": true } }`.

`state: "live"` records a partial score without advancing anything — this is how an organizer puts a
live cricket score on the public page mid-innings. It bumps `state_version` and `result_version`, and
does not touch downstream matches.

**Cricket overs, for net run rate.** When the game's `match_fields` include innings overs (a
`decimal` field, `CONTENT.md` §5), the handler parses them into
`oversFacedMilliA` / `oversFacedMilliB` — integer thousandths, where `19.4` overs means 19 + 4/6 =
`19667` — and passes them to the engine on the result. The engine never reads
`result_detail_json`; this is the parse boundary (`BRACKET-ENGINE.md` §4.2.2). Without it,
`net_run_rate` cannot be computed and a six-team cricket group with two teams on 4 points cannot be
resolved.

### 4.13b `POST /api/v1/organizer/matches/:id/confirm`

The second half of `require_dual_confirm_final`. §4.13 step 10 puts a final's first submission into
`state = "live"` with `pending_confirm_by` set and returns `202`; this is what completes it. It is
the club's dispute control on the one match with the prize money attached, so it needs a body, a
predicate and error semantics rather than a sentence.

**Predicate:** `ORG_OF(t) ∧ match.pending_confirm_by IS NOT NULL ∧ u.id ≠ match.pending_confirm_by`.

That middle clause matters. AUTH.md previously wrote the predicate against
`match.updated_by_user_id`, **a column that does not exist** — `db/schema.sql`'s `matches` has
`recorded_by`, `pending_confirm_by` and `confirmed_by` only. The obvious repair, comparing against
`pending_confirm_by` *without* the `IS NOT NULL` clause, silently passes on a match nobody has
submitted (`NULL ≠ u.id`), which makes the whole feature decorative.

**Body:** `{ "result_version": 5 }`. Idempotency not required (the `result_version` guard is
sufficient and the operation is not retried blind).

**Effects, in one `.batch()`** with the §4.13 guard on every statement: set `status = 'complete'`,
`confirmed_by = u.id`, `pending_confirm_by = NULL`, `result_version + 1`; then the same downstream
propagation, standings recompute, `bracket_version` + `state_version` bumps and `match_audit`
(`kind: 'result_set'`) as §4.13.

| Status | Code | When |
| --- | --- | --- |
| `403` | `forbidden`, `details.reason: "same_organizer"` | `u.id = match.pending_confirm_by`. A different organiser must confirm; that is the entire control. |
| `409` | `conflict`, `details.reason: "not_awaiting_confirmation"` | `pending_confirm_by IS NULL`. |
| `409` | `stale_version` | as §6.2. |
| `409` | `bracket_locked` | `results_published_at IS NOT NULL`. |

**200** — the same body as §4.13.

### 4.14 `POST /api/v1/organizer/matches/:id/reopen`

Undo a completed match.

**Body:** `{ "result_version": 4, "reason": "Wrong team entered.", "cascade": "reset" }` — `reason` required,
≥ 10 chars, and it is public (it appears on the bracket as a correction note; silent score edits are
the thing that destroys trust in a club's results).

**`cascade`** ∈ `"reset"` (default) | `"strict"`:
- `reset` — the winner is pulled out of the downstream slot; every **transitively** downstream match
  that has not been completed goes back to `pending`; downstream matches that **have** been completed
  are set to `void` and archived to `match_audit` (`kind: "result_cleared"`), and their own downstream
  effects are reset the same way. The response lists everything it touched. This is the engine's
  recompute path (`BRACKET-ENGINE.md` §14.4), not hand-written cascade code.
- `strict` — refuses with `409 conflict` and `details.blocking_matches` if any downstream match is
  already complete. Use this when you only meant to fix a typo.

**409 `bracket_locked`** if results are published — unpublish first.
**200** `{ "data": { "match": {...}, "reset": ["mat_...", "mat_..."], "voided": ["mat_..."] } }`.

Reopening is `organizer`-allowed while `live`, and `admin`-only once `status = "completed"`.

### 4.14.1 `GET /api/v1/organizer/matches/:id/impact`

The **dry run** behind the correction sheet in `IA.md` Journey 5. Runs the engine's
`resolveBracket` fold against a hypothetical result and returns what would be invalidated, without
writing anything.

**Query:** `winner_entrant_id` (optional — omit to ask "what if I clear this result?"),
`is_draw` (optional bool).

**200**
```jsonc
{
  "data": {
    "match": { /* §1.7 match */ },
    "changes_winner": true,
    "invalidated": [
      { "match_id": "mat_...", "code": "W3-2", "match_no": 29, "round_label": "Semi-final",
        "state": "complete", "reason": "participants_changed",
        "current": { "a": "ent_...", "b": "ent_...", "score_a": 2, "score_b": 0 } }
    ],
    "reset": ["mat_..."],
    "standings_dirty": true,
    "live_matches_affected": ["mat_..."]
  }
}
```

`invalidated` is exactly the engine's `invalidatedResults`: a stored result is accepted iff the
recomputed participant **set** equals the recorded one, so a scoreline-only fix returns an empty
array and is non-destructive, while a winner change cascades. `Cache-Control: private, no-store`.
Read-only, no `version` required, no audit row.

The write that follows it is `PUT .../score` with `?confirm=1` (§4.13), which re-runs the same
dry run server-side and refuses with `409 conflict` + `details.invalidated` if the caller did not
confirm. Never trust the client to have called `/impact`.

### 4.14.2 `POST /api/v1/organizer/tournaments/:id/bracket/preview`

The seeding screen's live preview (`IA.md` Journey 4d). Runs `previewBracket()` on the current
confirmed entrants and the supplied options and returns the same shape as §1.7 **without writing a
single row**.

**Body:** `{ "options": { /* format options */ }, "seeds": [ /* optional manual order */ ], "seed_value": 8172 }`.
**200** — a §1.7 bracket body with `generated_at: null` plus
`{ "meta": { "bye_count": 11, "bracket_size": 32, "playable_matches": 21, "warnings": [] } }`.

No `Idempotency-Key`, no `version`, no audit row, `Cache-Control: private, no-store`. It exists so
the preview and the real generation are provably the same pure function; a preview that can disagree
with the bracket it previews is worse than no preview.

### 4.15 `PATCH /api/v1/organizer/matches/:id`

Scheduling and logistics only, never scores.
**Body:** `{ "version": 3, "scheduled_at": "...", "venue_id": "ven_...", "room_code": "12345", "room_password": "nlr", "room_code_publish_at": "...", "stream_url": "https://...", "station_label": "Court 2", "referee_note": "..." }`.
`stream_url` must be `https:` and in the host allowlist `youtube.com`, `youtu.be`, `twitch.tv`,
`fb.gg`, `facebook.com`, `instagram.com` — an arbitrary URL rendered as a link is a phishing vector on
a page the club's audience trusts.
**200** — the match.

### 4.15.1 `POST /api/v1/organizer/matches/:id/lobby-results`

Bulk result entry for a **`points_lobby` match** — one BGMI/Free Fire lobby of up to 25 squads. In
the engine's model a lobby *is* a match, and its rows live in `match_participants`
(`BRACKET-ENGINE.md` §12.2). This endpoint is what an organizer fills in when a BR match ends. It is
the `points_lobby` counterpart of `PUT .../score`; the two are never used on the same match.

`:id` is the **match (lobby) id**, not a round number. The client gets it from the bracket response
(`rounds[i].matches[j].id` where `bracket: "series"`).

**Idempotency:** required. **Body cap:** 256 KiB.

```jsonc
{
  "result_version": 21,
  "state": "complete",                   // "live" | "complete" — "live" lets a score go up mid-lobby
  "allow_partial": false,                // true = some squads have not finished yet
  "entries": [
    { "entrant_id": "ent_...", "placement": 1, "kills": 8, "bonus": 0, "disqualified": false, "note": null },
    { "entrant_id": "ent_...", "placement": 2, "kills": 5, "bonus": 0, "disqualified": false, "note": null }
  ]
}
```

Validation:
- every `entrant_id` must already have a `match_participants` row for **this** match (the lobby
  assignment is made by the engine's `assignLobbies()`, never by this endpoint) — a foreign entrant is
  `400 validation_failed`, `details.fields["entries"] = "entrant_not_in_lobby"`;
- `placement` is a permutation of `1..n` over the submitted entrants; gaps are rejected unless
  `allow_partial: true`;
- `kills` `0..200`; `bonus` `-100..100`, and a non-zero `bonus` requires a `note`;
- `disqualified: true` forces `placement` to last and zeroes the points, and requires a `note`.

**Points are computed entirely server-side** from the game definition's scoring block and the
tournament's `scoring_config` override:
`points = placement_points[placement - 1] + kills * kill_points + bonus`. The client never submits a
total, so a tampered total is not a representable request (SECURITY.md §2.2).

**200** returns the recomputed lobby table and the updated overall standings. Bumps
`result_version`, `bracket_version` and `state_version`, and writes a `match_audit` row.

### 4.16 `POST /api/v1/organizer/tournaments/:id/publish`

Freeze the results and push points to the leaderboard.

**Idempotency:** required. **Body:** `{ "version": 30, "force": false }`.

Preconditions (all `409 conflict` with `details.reason`):
- `matches_incomplete` — some non-`void`, non-`bye` match is not `complete` (or `force: true`,
  which is admin-only and audited);
- `no_podium` — final placements are not computable for at least the podium;
- `no_active_season` — `tournaments.season_id IS NULL` **and** no `seasons` row has `is_active = 1`.

**Season resolution.** `season_id = tournaments.season_id ?? (SELECT id FROM seasons WHERE
is_active = 1)`. `points_ledger.season_id` is `NOT NULL REFERENCES seasons(id) ON DELETE RESTRICT`,
so publishing with neither would abort the batch inside SQLite with an opaque constraint error at
the end of the event; the `409` above is that failure, made legible and made early. See §4.2.0.

**Effects, in one `.batch()` per 200 statements** (last chunk sets the done flag, Appendix D rule 5):

1. Compute the tournament-wide final placement list by the cross-stage procedure in
   `BRACKET-ENGINE.md` §15.7 — last stage's standings first, then earlier stages' non-advancers in
   reverse ordinal order, ties preserved. Write it to `entrants.placement` and `entrants.prize_paise`.
2. Call `leaderboardPointsFor()` (`BRACKET-ENGINE.md` §16) over that list, weighted by
   `leaderboard_weight_pct`, with the walkover cap of §16.3 applied.
3. **Write `points_ledger` rows — this is the write of record.** One row **per linked roster member**
   per awarded entrant (`entrant_members.user_id IS NOT NULL AND status = 'active'`), each carrying
   the **full** award, not a split (ARCHITECTURE.md §6.7). Columns:
   `(id, season_id, user_id, game_id, tournament_id, entrant_id, reason, placement, points,
   created_by, created_at)` with `reason = 'placement'`, or `'participation'` for the §16.1 floor.
   Unlinked guest members get nothing — there is no account to credit.
4. **Then derive `leaderboard_entries`** for the affected `(period, game_id, user_id)` buckets by
   upserting `SUM(points)` over `points_ledger WHERE voided_at IS NULL`, for both
   `period = 'all_time'` and `period = 'season:<slug>'`, and for both `game_id = <the game>` and
   `game_id = NULL` (the overall board). `leaderboard_entries` is a materialised view of the ledger
   and is never written from the award list directly — that is what makes `unpublish` a void plus a
   recompute rather than arithmetic guesswork.
5. Set `status = "completed"`, `results_published_at`, `completed_at`, `champion_entrant_id`.
6. Bump `leaderboard_version`, `state_version`, `listing_version`, `version`.
7. Post an automatic announcement; write the `audit_log` row.

Every statement carries the `version` guard, per §6.2.

**200** `{ "data": { "tournament": {...}, "podium": [...], "leaderboard_rows_written": 47 } }`.

**`POST /api/v1/organizer/tournaments/:id/unpublish`** — **admin only**, step-up required. Reverses
the leaderboard deltas (they are stored as signed rows keyed by tournament, so reversal is a delete
plus a recompute, not arithmetic guesswork), sets `status` back to `live`, clears
`results_published_at`. Body `{ "version": 31, "reason": "Protest upheld in the U-16 final." }`,
`reason` ≥ 10 chars and public.

### 4.17 Announcements

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/v1/organizer/tournaments/:id/announcements` | Body `{ title (≤ 100), body_md (≤ 4000), severity, pinned, promote_to_club }`. `body_md` is compiled to `body_ast` server-side (§9). `201`. |
| `PATCH` | `/api/v1/organizer/announcements/:id` | Same fields + `version`. Edits within 15 min are silent; after that the response and the public object carry `edited_at`. |
| `DELETE` | `/api/v1/organizer/announcements/:id` | Soft delete. `204`. |

Posting bumps `state_version`, which is exactly why a bracket poller will get a `200` after an
announcement (§5.2) — accepted over-invalidation.

### 4.18 `POST /api/v1/organizer/tournaments/:id/invites`

Generate join codes for the guest path.

**Body:** `{ "count": 20, "mode": "single_use", "max_uses": 1, "expires_at": "...", "label": "Desk batch 1" }`
— `mode` ∈ `"single_use"` | `"shared"`. `count` ≤ 200. `shared` produces exactly one code that many
people may use, bounded by `max_uses`.

These are **`kind = 'join'`** invites: they gate `POST .../guest-register` for this tournament and
nothing else. `entrant_id` is `NULL` on every row this endpoint writes.
**`kind = 'roster'` invites are a different object with a different owner** — a captain, not an
organiser — and are minted by `POST /api/v1/entrants/:id/roster-invites` (§3.12.1). This endpoint
never creates one, and an organiser has no reason to.

**201** `{ "data": { "codes": ["K7QP2M", "R3XB9T"], "expires_at": "...", "mode": "single_use" } }`.
Codes are 6 characters from Crockford base32 minus vowels and ambiguous glyphs
(`0/O`, `1/I/L`) → alphabet `23456789BCDFGHJKMNPQRSTVWXYZ`, ~28.5 bits. They are stored hashed
(HMAC with `INVITE_PEPPER`) and are unrecoverable after this response; a lost code is regenerated.
Rate-limited and audited.

**`GET /api/v1/organizer/tournaments/:id/invites`** lists metadata only (`label`, `mode`, `used_count`,
`max_uses`, `expires_at`, `revoked`), never the codes.
**`DELETE /api/v1/organizer/invites/:id`** revokes. `204`.

### 4.19 `GET /api/v1/organizer/tournaments/:id/entrants.csv`

**Query:** `include_contact` (`true`/`false`, default `false`), `status` (as §4.6).

**200** `text/csv; charset=utf-8` with `Content-Disposition: attachment; filename="<slug>-entrants-<yyyymmdd>.csv"`.
The body starts with a UTF-8 BOM (`EF BB BF`) so Excel on a Windows desk machine does not mangle
Telugu names.

**Predicate:** `ORG_OF(t)` for the plain export; **`include_contact=true` additionally requires
`role IN ('owner','organizer')`** on `tournament_organizers`, or `users.role = 'admin'` (AUTH.md
§7.2). A `scorer` requesting it gets `403 forbidden`, `details.reason: "role_insufficient"`.

Columns: `entrant_id, status, seed, team_name, team_tag, member_display_name, member_handle,
member_is_substitute, member_role, payment_status, payment_ref, checked_in_at, registered_at,
<one column per registration_schema field key>, organizer_note`.

**Every `pii: true`, `type: "tel"` schema column is emitted masked (`+91 ••••• •4417`) regardless of
`include_contact`** — the flag adds one dedicated `phone_e164` column carrying the entrant's primary
number, and nothing else. Emitting the raw WhatsApp presets (`captain_whatsapp`, `alt_whatsapp`,
`player_whatsapp`, `guardian_whatsapp`) as ordinary schema columns would route four plaintext
numbers per squad around the `include_contact` gate entirely. See SECURITY.md §10.2.

`include_contact=true` writes an audit row (`action: "entrants.export.contact"`) and adds a final
row `# exported by @<handle> at <ISO> — contains personal data, do not forward`.

**CSV injection:** every cell whose first character is one of `= + - @`, TAB, or CR is prefixed with a
single quote before quoting. See SECURITY.md §7.4.

Rate-limited to 10/hour per organizer; 30/day with contact.

### 4.20 Co-organizers

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/v1/organizer/tournaments/:id/organizers` | `[{ handle, display_name, role, is_owner, added_at, added_by }]`. Revoked rows are omitted. |
| `POST` | `/api/v1/organizer/tournaments/:id/organizers` | Owner or admin only. Body `{ "handle": "kiran", "role": "scorer" }`, `role` ∈ `organizer`\|`scorer`\|`moderator` (never `owner`). The target must already have `users.role IN ('organizer','admin')` — this endpoint grants **scope**, never **role**. Role grants are admin-only (§5.3). Re-adding a previously revoked user clears `revoked_at`. `201`. |
| `DELETE` | `/api/v1/organizer/tournaments/:id/organizers/:handle` | Owner or admin. Cannot remove the owner (`409 conflict`, `details.reason: "cannot_remove_owner"`). **Sets `tournament_organizers.revoked_at = now`** — a soft revoke, because `PRIMARY KEY (tournament_id, user_id)` plus the `ix_torg_user … WHERE revoked_at IS NULL` index are built for exactly that, and because who held scope and when is part of the dispute record. Bumps nothing else: no `state_version`, no `version`. Writes an `audit_log` row. `204`. |

Separating "is an organizer at all" (admin-granted, §5.3) from "organizes this tournament"
(owner-granted) is what stops privilege escalation by an organizer inviting themselves upward.

**A revoked co-organizer loses authority immediately**, because `ORG_OF(t)` and `SCORER_OF(t)`
require `revoked_at IS NULL` (AUTH.md §7.2). Before that clause existed, this DELETE silently did
nothing: a volunteer scorer removed after a dispute — precisely the rival-adjacent insider in
SECURITY.md's threat model — kept `PUT .../score`, `POST .../reopen`, `POST .../publish` and
`GET /organizer/entrants/:id/contact`. Their **sessions are not revoked**; the predicate is
evaluated per request against the loaded row, which is the correct and cheaper control.

**`role` is enforced, not decorative.** See AUTH.md §7.2: `scorer` can enter scores and lobby
results and nothing else — no contact lookups, no CSV with contact, no payment fields, no publish.
`moderator` can post announcements and manage entrant statuses but not scores. OPERATIONS.md §0
tells the operator to hand a volunteer `scorer` rather than `organizer` precisely so that "a scorer
handing their phone to a friend should not be able to leak forty phone numbers"; that promise is now
implemented.

### 4.21 `GET /api/v1/organizer/tournaments/:id/audit`

The tournament's audit trail, so an organizer can answer "who changed that score" without an admin.
**Query:** `action`, `actor`, `from`, `to`, `limit` (max 100), `cursor`.
**200** — collection of `{ id, at, actor: { handle, display_name, role }, action, entity_type, entity_id, summary, before, after, request_id }`.
`before`/`after` are redacted of PII for non-admins (phone numbers appear as `"[redacted]"`).

### 4.22 `GET /api/v1/organizer/tournaments/:id/bracket`

Organizer view of the bracket: identical to §1.7 plus `room_code`, `room_password`, `referee_note`,
`pending_confirm_by`, and unpublished matches.

**Query:** `stage_id` (optional; default = every stage).

Two extra top-level fields, both of which the organiser UI needs and neither of which the public
response carries:

```jsonc
{ "data": { /* …§1.7… */
    "stale_rounds": [3],       // progressive formats only; [] otherwise
    "recomputing": false       // true while stages.status = 'recomputing'
} }
```

`stale_rounds` is `validateProgressive()`'s `W_STALE_PAIRINGS` warnings, flattened to round numbers
(`BRACKET-ENGINE.md` §11.4, §12.7). It is the organiser's explicit keep-or-re-pair decision — "Round
3's pairings no longer match the corrected results" — and without it surfaced somewhere, the engine
function that produces it has no caller. The UI renders a banner offering
`DELETE /organizer/stages/:id/rounds/3` (§4.23.6) or "keep them as played".

`recomputing: true` means §14.4's chunked correction is mid-flight; the UI shows a spinner rather
than a possibly-inconsistent bracket. If the stage has been `recomputing` for more than 60 seconds
this endpoint kicks off the idempotent full recompute in `ctx.waitUntil` before responding
(`BRACKET-ENGINE.md` §14.4, "Recovery from a failed chunk").

`Cache-Control: private, no-store`.

### 4.23 Stages

**`stages` is the shape authority.** `db/schema.sql` says it plainly: *"The bracket engine ONLY ever
reads stages, never `tournaments.format`."* Every tournament has at least one; a plain 8-player
knockout has exactly one and the organiser never sees the word. `content/games.json` ships
`box-cricket` with `"multi_stage": true` and `"max_participants": 24`, and the flagship BGMI
configuration is Day-1 lobbies → Grand Final, so **multi-stage is not an advanced feature, it is two
of the three shipped scenarios**. These endpoints are what make `stages` beyond the implicit stage-1
row, `stage_entrants` beyond generation, `seed_source = 'previous_stage'`, `source_stage_id` and
`advance_count` reachable at all.

All of these are `ORG_OF(t)` where `t` is the stage's tournament, `Cache-Control: private,
no-store`, and CSRF + `Origin` as everything else in §4.

#### 4.23.1 `GET /api/v1/organizer/tournaments/:id/stages`

**200** — collection of `Stage`, `ORDER BY ordinal`:

```jsonc
{
  "id": "stg_01JB...", "ordinal": 1, "name": "Group Stage",
  "format": "round_robin", "status": "completed",
  "group_count": 4, "lobby_count": 0, "lobby_size": null,
  "rounds_planned": null, "rounds_completed": 3,
  "best_of": 1, "final_best_of": null, "third_place_match": false,
  "seed_source": "registration", "source_stage_id": null, "advance_count": 2,
  "points_win": 3, "points_draw": 1, "points_loss": 0, "points_bye": 0, "points_divisor": 1,
  "tiebreakers": ["points", "net_run_rate", "head_to_head", "wins", "seed"],
  "options": { /* the validated FormatOptions blob, stages.options_json */ },
  "scoring_config": { /* stages.scoring_config_json, or null to inherit */ },
  "entrant_count": 24,
  "bracket_generated_at": "2026-11-07T19:00:00Z",
  "locked": true,                       // bracket_generated_at IS NOT NULL
  "starts_at": null, "completed_at": "2026-11-08T15:00:00Z"
}
```

#### 4.23.2 `POST /api/v1/organizer/tournaments/:id/stages`

**Body** — this is also the element shape of `body.stages` in §4.2.1:

| Field | Type | Notes |
| --- | --- | --- |
| `ordinal` | int ≥ 1 | Required. Must be `max(existing) + 1`; inserting in the middle is `409 conflict`, `details.reason: "ordinal_gap"`. |
| `name` | string ≤ 60 | Required. `"Group Stage"`, `"Day 1 Lobbies"`, `"Playoffs"`. |
| `format` | format enum (§4.2.1) | Required. |
| `seed_source` | `registration`\|`random`\|`manual`\|`previous_stage` | Default `registration` on ordinal 1, `previous_stage` otherwise. `rating` → `400` (§1.12.2). |
| `source_stage_id` | `stg_` id \| null | **Required** when `seed_source = 'previous_stage'`; must be a stage of this tournament with a lower `ordinal`. |
| `advance_count` | int ≥ 1 \| null | How many qualify **out of this stage**. Required on any stage another stage sources from. For a grouped round robin this is **per group**; for `swiss` / `points_lobby` it is a flat total. |
| `group_count` | int ≥ 1 | `round_robin` only. Default 1. |
| `lobby_count`, `lobby_size` | int | `points_lobby` only. `lobby_count ≥ 1 ∧ lobby_size ≥ 2` (schema CHECK). |
| `rounds_planned` | int \| null | `swiss`: number of rounds. `points_lobby`: matches per lobby. Defaults from `recommendedSwissRounds(N)` / the game's `matches_per_round`. |
| `best_of` | odd int ≥ 1 | Default 1. |
| `final_best_of` | odd int \| null | Elimination: a longer final. |
| `third_place_match` | bool | Elimination only. Default false. |
| `points_win`, `points_draw`, `points_loss`, `points_bye`, `points_divisor` | int | `round_robin` / `swiss`. **Integers only** — chess is 2/1/0 with `points_divisor: 2` (`BRACKET-ENGINE.md` §4.3). `points_divisor` must equal `options.pointsDivisor`. |
| `tiebreakers` | string[] | Ordered snake_case tokens from the map in `BRACKET-ENGINE.md` §4.2. An unknown token is `400 validation_failed`, never a silently dropped comparator. `seed` is appended by the engine whether or not it is listed. |
| `options` | object | Optional raw `FormatOptions`; validated by `validateOptions()`. When absent it is composed from the columns above plus the game's defaults. |
| `scoring_config` | object \| null | `points_lobby` placement table / kill value, and the `walkover_win` / `forfeit_loss` / `no_result` match points. Null inherits the game's. |

**Allowed while** `t.status ∈ {draft, published, registration_open}`. At most **4** stages per
tournament. `201` — the `Stage`.

**409 `conflict`**, `details.reason`: `too_many_stages`, `ordinal_gap`, `tournament_locked`
(status past `registration_open`), `source_stage_not_found`, `source_stage_after` (source has a
higher ordinal).

#### 4.23.3 `PATCH` / `DELETE /api/v1/organizer/stages/:id`

`PATCH` takes any subset of the §4.23.2 body plus `version` — which for a stage is the **parent
tournament's** `version`, because `stages` has no version column of its own; the guard is
`WHERE tournament_id = ?1 AND (SELECT version FROM tournaments WHERE id = ?1) = ?2`.

**Both are refused with `409 conflict`, `details.reason: "stage_locked"`, once
`stages.bracket_generated_at IS NOT NULL`.** Editing the shape of a stage whose bracket is drawn is
how a live event silently re-draws itself. To change it: `DELETE .../bracket` for that stage
(§4.12b), then `PATCH`, then regenerate.

`ordinal` is not patchable. Reordering stages mid-tournament has no correct meaning; delete and
recreate while in `draft`.

`DELETE` additionally refuses with `details.reason: "has_dependent_stage"` when another stage's
`source_stage_id` points at it, and `details.reason: "last_stage"` when it is the only one — a
tournament with zero stages cannot generate anything. `204`.

#### 4.23.4 `POST /api/v1/organizer/stages/:id/seed`

**The endpoint that makes stage 2 exist.** It calls the engine's `seedNextStage()`
(`BRACKET-ENGINE.md` §10.6, §12.6) over the source stage's standings and writes `stage_entrants`.
Without it, scenario 3 (24-team box cricket, round robin → knockouts) and scenario 1 (BGMI Day-1
lobbies → Grand Final) are both impossible, and `IA.md` §6.3's stage selector renders a control that
can never have more than one entry.

**Preconditions**, all `409 conflict` with `details.reason`:
- `not_previous_stage` — this stage's `seed_source` is not `previous_stage`;
- `source_incomplete` — the source stage has any match not in `{complete, bye, void}`;
- `already_seeded` — `stage_entrants` rows already exist for this stage and `force` is not set;
- `stage_locked` — this stage already has a bracket.

**Body:** `{ "version": 12, "force": false }`.

**What it does, in one `.batch()`:**

1. Read the source stage's `standings`, `ORDER BY group_no, rank`.
2. Call `seedNextStage({ prevStandings, groupCount, advancePerGroup, advanceCount, entrants })`.
   For a grouped round robin it builds the playoff seed list in **place-major, group-minor** order
   (`seedIndex(place p, group g) = (p − 1) × G + g`) and then runs the **same-group repair pass** of
   `BRACKET-ENGINE.md` §10.6 — the deterministic swap that stops group 2's winner meeting group 2's
   runner-up in the first knockout match. If no legal swap exists the engine emits
   `W_SAME_GROUP_R1`, which is returned in `meta.warnings` and shown to the organiser; it is a
   warning, never a refusal.
3. Insert one `stage_entrants` row per returned `SeededNextEntrant`:
   `(stage_id = :id, entrant_id, tournament_id, seed = the playoff seed, group_no = 1,
   source_stage_id, source_rank, status = 'active')`.
4. In the **source** stage, set `stage_entrants.status = 'advanced'` for the qualifiers and
   `'eliminated'` for everyone else, and set `standings.is_qualified = 1` for the qualifiers.
5. Set the **source stage** to `status = 'completed'`, `completed_at = now`, and this stage to
   `status = 'seeding'`.
6. Bump `tournaments.version`, `state_version`, `bracket_version`; write the `audit_log` row.

Every statement carries the `version` guard (§6.2).

**200**
```jsonc
{ "data": {
    "stage": { /* §4.23.1 */ },
    "seeded": [ { "entrant_id": "ent_...", "display_name": "Team Falcon", "seed": 1,
                  "source_rank": 1, "source_group_no": 1 } ]
  },
  "meta": { "count": 8, "warnings": ["W_SAME_GROUP_R1"] } }
```

Then call `POST .../bracket` with `{ "stage_id": ":id" }` (§4.12) to generate the playoff draw.
Seeding and generation are two calls on purpose: the organiser gets to look at the qualifier list —
and fix a group-stage score they only now notice is wrong — before the draw is fixed and shared.

`force: true` re-seeds a stage that already has `stage_entrants` but no bracket; it deletes the
existing rows first, in the same batch.

#### 4.23.5 `POST /api/v1/organizer/stages/:id/rounds`

**The endpoint that makes round 2 of a Swiss or a BGMI event exist.** `swiss` and `points_lobby` are
**progressive** (`BRACKET-ENGINE.md` §1.3): round *k*'s pairings are a pure function of rounds
1..*k*−1's results and cannot be emitted at generation time. §4.12 is a single call whose body is
`{version, force, options}` and there was no second call anywhere.

The consequence without it is total, not marginal: `content/games.json` sets
`bgmi.scoring.params.matches_per_round: 4`, so the shipped default is a **four-round** event that
dies at the end of Match 1 with no way to create Match 2's lobbies. `BUILD-PLAN.md` I1's acceptance
criterion names a "20-squad BGMI points-lobby event" run end to end. Swiss chess — the natural
format for the club's adjacent chess audience — is equally unrunnable past round 1.

**Idempotency:** required. **Body:** `{ "version": 12, "round": 2, "force": false }`.

**Behaviour**

1. **Refuse** with `409 conflict`, `details.reason: "round_not_complete"`, `details.blocking_matches`
   when rounds `1..round−1` are not **all** in `{complete, bye, void}`. This is the engine's
   `E_ROUND_NOT_COMPLETE` (`BRACKET-ENGINE.md` §11.4) on the wire.
   Also refuse: `round_exists` (that round is already materialised and `force` is false),
   `round_gap` (`round > rounds_completed + 1`), `rounds_exhausted`
   (`round > stages.rounds_planned`), `stage_not_progressive`.
2. Compute cumulative standings over the completed rounds, then call:
   - `swiss` → `pairSwissRound({ round, entrants: active only, history, options })`;
   - `points_lobby` → `assignLobbies({ round, entrants: active only, options, standings })`,
     where `standings` is the cumulative table **before this round** and is `null` for round 1.
     With the default `lobbyRotation: 'snake_by_standings'` this is exactly why the round could not
     have been emitted earlier.
3. Persist the returned `SkeletonMatch[]` in one chunked `.batch()` (200 statements): `matches` rows
   with `match_no = MAX(match_no) + number` (`BRACKET-ENGINE.md` §9.6), plus one
   `match_participants` row per squad per lobby for `points_lobby`. Append the new round's matches
   to `stages.skeleton_json` and recompute `skeleton_hash` (§11.4: a progressive skeleton only ever
   grows).
4. Bump `stages.rounds_completed = round − 1` is **not** what this does — it sets
   `stages.rounds_completed = max(rounds_completed, round − 1)` and leaves `round` itself to be
   completed by scoring. It bumps `tournaments.bracket_version` **and** `state_version`, and
   `tournaments.version`.
5. Refuse with `409 conflict`, `details.reason: "too_many_matches"` if the new round would take the
   tournament past `MAX_MATCHES_PER_TOURNAMENT` (§1.7), checked before the first insert.

Every statement carries the `version` guard (§6.2).

**201** — the new round in the §1.7 shape:

```jsonc
{ "data": {
    "round": { "index": 2, "name": "Round 2", "stage_id": "stg_...", "bracket": "swiss",
               "best_of": 1, "matches": [ /* §1.7 match objects */ ] }
  },
  "meta": { "bye_entrant_id": "ent_...", "warnings": ["W_FORCED_REMATCH"] } }
```

`meta.warnings` carries `W_FORCED_REMATCH`, `W_COLOUR_VIOLATION`, `W_ODD_LOBBY_SIZES` verbatim from
the engine. They are shown to the organiser and never block.

#### 4.23.6 `DELETE /api/v1/organizer/stages/:id/rounds/:round`

Un-pair a progressive round so it can be re-paired. This is the "keep or re-pair" choice
`validateProgressive` forces on the organiser (§4.22's `stale_rounds`), and it implements
`BRACKET-ENGINE.md` §11.4's carry-over rule.

**Body:** `{ "version": 12, "reason": "Round 1 result corrected." }` — `reason` ≥ 10 chars, public,
same rule as `POST .../reopen`.

**Deletes round `:round` and every round after it.** Re-pairing round 3 while round 4 exists would
leave round 4 built on pairings that no longer exist; there is no partial version of this.
`details.deleted_rounds` lists them.

**Carry-over (normative).** Before deleting, the handler snapshots every result in the deleted range
as `{ unordered participant pair → result }`. It returns them in
`meta.carry_over: [{ "entrants": ["ent_A","ent_B"], "score_a": 2, "score_b": 1, "winner_entrant_id": "ent_A" }]`.
The **next** `POST .../rounds` for that round re-attaches any snapshot whose unordered pair exists in
the new pairing to the new match id — same scores, same winner, `result_version` bumped, one
`match_audit` row of `kind: 'result_set'` each with the `reason` from this call. Pairs that no
longer exist are discarded. That is what makes fixing a round-1 typo usually preserve most of
round 2's already-played games instead of nuking them. The client passes the snapshot back as
`{ "carry_over": [...] }` on the re-pair; the server re-validates every entry against the new
pairing and ignores anything that does not match, so a tampered snapshot cannot inject a result.

**409 `bracket_locked`** if `results_published_at IS NOT NULL`.
**200** `{ "data": { "deleted_rounds": [3, 4], "deleted_matches": 12 }, "meta": { "carry_over": [ ... ] } }`.

---

## 5. Admin API

**Predicate:** `session.user.role = 'admin'` for everything. Endpoints marked ⚡ additionally require
step-up re-authentication within 900 s and `session.uv = true` (AUTH.md §5.5).

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/v1/admin/games` | Includes inactive. |
| `POST` | `/api/v1/admin/games` | Body = the `Game` object minus `id`. `registration_schema` and `score_schema` are validated for structure (§3.3 `FieldDef`) and for regex safety. `201`. **This is how a new game is added — a row, not a deploy.** |
| `PATCH` | `/api/v1/admin/games/:id` | `version` required. Changing `slug` is refused once any tournament references the game (`409 conflict`). Removing a `registration_schema` field is refused if any live tournament uses it. |
| `DELETE` | `/api/v1/admin/games/:id` | Soft delete → `active: false`. Hard delete refused if referenced. `204`. |
| `GET` | `/api/v1/admin/users` | Query `q` (handle/display name prefix), `role`, `state` (`active`\|`deletion_pending`\|`suspended`), `limit`, `cursor`. Returns `{ id, handle, display_name, role, created_at, last_seen_at, credential_count, has_phone, tournaments_played, suspended_until }`. **No phone numbers.** |
| `GET` | `/api/v1/admin/users/:id` | The above + `phone_masked`, `email`, session count, recovery status. Full phone requires `GET /api/v1/admin/users/:id/contact` ⚡, which is audited. |
| `POST` | `/api/v1/admin/users/:id/role` ⚡ | Body `{ "role": "organizer", "reason": "Runs the Sunday carrom nights." }`. `role` ∈ `player`\|`organizer`\|`admin`. **Side effect: bumps `users.session_epoch`, which invalidates every existing session of that user** (AUTH.md §5.4) — a role change must never be usable from a session that predates it. Refuses to demote the last remaining admin (`409 conflict`, `details.reason: "last_admin"`). Audited with `reason`. |
| `POST` | `/api/v1/admin/users/:id/suspend` ⚡ | Body `{ "until": "2027-01-01T00:00:00Z" \| null, "reason": "..." }`. **Sets `users.status = 'suspended'` — that is the authoritative gate — and `users.suspended_until` to the timestamp or `NULL`.** `null` = indefinite, and it works, because the session predicate reads `status`, not the timestamp (AUTH.md §7.2). Bumps `session_epoch`, which kills existing sessions. Leaves entrants and results intact. |
| `DELETE` | `/api/v1/admin/users/:id/suspend` | Lifts a suspension: `status = 'active'`, `suspended_until = NULL`, `moderation_reason` preserved. `204`. |
| `DELETE` | `/api/v1/admin/users/:id/sessions` ⚡ | Revoke every session for a user (epoch bump). `204`. |
| `GET` | `/api/v1/admin/sessions` | Query `user_id`, `active` (default `true`), `limit`, `cursor`. `{ id, user: {handle}, created_at, last_seen_at, ip_city, ua_summary, uv, scope, revoked_at }`. |
| `DELETE` | `/api/v1/admin/sessions/:id` | Revoke one session. `204`. |
| `GET` | `/api/v1/admin/audit` | Query `actor` (handle or user id), `action` (prefix match, e.g. `match.`), `entity_type`, `entity_id`, `tournament_id`, `from`, `to`, `limit` (max 100), `cursor`. Unredacted. |
| `PATCH` | `/api/v1/admin/club` | Club info (§1.14). `version` required. Bumps `club_version`. |
| `POST` | `/api/v1/admin/announcements` | Club-scope announcement. Same body as §4.17. |
| `GET` | `/api/v1/admin/stats` | `{ users, users_30d, tournaments_by_status, entrants_30d, matches_30d, sessions_active, d1: { size_bytes, rows_read_24h } }`. Every number comes from a denormalised counter or a bounded query. `Cache-Control: private, max-age=60`. |
| `POST` | `/api/v1/admin/leaderboard/rebuild` ⚡ | Body `{ "game": "carrom" \| null, "period": "all_time", "dry_run": false }`. Recomputes `leaderboard_entries` from published tournaments. Chunked; returns `{ processed, written, took_ms, truncated: bool }`. If `truncated` is `true` the caller re-invokes with the returned `resume_cursor` — a full rebuild must never be a single request that dies on the CPU limit. |
| `POST` | `/api/v1/admin/redirects` | Body `{ "from": "old-slug", "to": "new-slug" }` → the Worker 301s `/t/old-slug/` (§4.3, §Appendix A step 6). `201`. |
| `POST` | `/api/v1/admin/cache/purge` ⚡ | Body `{ "scope": "tournament", "id": "trn_..." }` or `{ "scope": "all" }`. Bumps the relevant version counter, which invalidates ETags and edge entries by changing the URL-independent validator. Does **not** call the Cloudflare purge API (no API token in the Worker — SECURITY.md §9). |

### 5.8 Venues

`GET /api/v1/venues` (§1.15) was the only endpoint touching the `venues` table, while `venue_id` is
an accepted field on `POST /organizer/tournaments` and `PATCH /organizer/matches/:id`, `venues`
carries `is_active` / `sort_order` / `capacity`, `IA.md` §1.1 ships `/admin/t/<slug>/schedule/` for
"assign venues/courts/time slots", and `db/seed.sql` provides exactly **one** row. Scenario 3 is a
24-team box-cricket league across multiple grounds and days; without these the club is locked to the
single seeded venue forever or must run `wrangler d1 execute` against production to add a ground.
(`matches.station_label` covers courts, boards and tables ad hoc — it does not cover a second
ground.)

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/api/v1/admin/venues` | Body `{ name (≤ 80, required), area (≤ 60), address (≤ 200), maps_url, is_online, capacity, sort_order }`. `maps_url` must be `https:` on `google.com`, `goo.gl`, `maps.app.goo.gl` or `openstreetmap.org` — an arbitrary URL rendered as a link on a page this audience trusts is a phishing vector (same rule as `stream_url`, §4.15). `201`. |
| `PATCH` | `/api/v1/admin/venues/:id` | Same fields, all optional, **`version` required**. `venues.version` exists for exactly this (`db/schema.sql`); venue edits are not last-write-wins. `200`. |
| `DELETE` | `/api/v1/admin/venues/:id` | **Soft delete → `is_active = 0`.** Refused with `409 conflict`, `details.reason: "venue_in_use"`, `details.tournament_count` when any non-`archived`, non-`cancelled` tournament or any future match references it. A soft-deleted venue keeps rendering on historical brackets and drops out of the create form. `204`. |

All three are `ADMIN`, audited, and bump `club_version` (which is what `GET /api/v1/venues` is
cached against).

### 5.9 Seasons

`seasons` was the one table in the schema with **no write path at all**. `db/seed.sql` creates a
single row with `is_active = 1`; when it ends there was no way to start the next one.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/v1/admin/seasons` | `[{ id, slug, name, starts_at, ends_at, is_active, tournament_count, version }]`, newest first. |
| `POST` | `/api/v1/admin/seasons` | Body `{ slug, name, starts_at, ends_at, is_active }`. `slug` follows the tournament slug regex and is immutable once created. |
| `PATCH` | `/api/v1/admin/seasons/:id` | Same fields, **`version` required**. |

**Only one season may be active.** `db/schema.sql` enforces it with the partial unique index
`ux_seasons_active`, which would otherwise surface as an opaque `UNIQUE constraint failed` at the
worst moment. So: setting `is_active: true` on one season **clears it on every other season in the
same `.batch()`**, and the response says which one was deactivated
(`meta.deactivated: { slug, name }`). Setting `is_active: false` on the only active season is
refused with `409 conflict`, `details.reason: "no_active_season_would_remain"` — publishing needs
one (§4.16).

Changing a season's `is_active` never moves an existing tournament: `tournaments.season_id` is
resolved and frozen at creation (§4.2.0). Starting a new season affects only tournaments created
after it.

Admin only, audited, bumps `leaderboard_version` (the `period` dimension changed).

---

There is no admin endpoint that reads or writes a password, a session secret, a recovery code, or a
credential public key. Admins can revoke; they cannot impersonate. There is deliberately **no
"log in as user"** feature — see SECURITY.md §2.4.

---

## 6. Idempotency and concurrency

Two different problems, two different mechanisms, and conflating them is a bug.

### 6.1 Idempotency-Key — "did my POST go through?"

The audience is on patchy 4G. A registration `POST` that times out client-side has almost certainly
reached the Worker. The retry must not create a second entrant.

**Required on:** `POST /tournaments/:slug/register`, `POST /tournaments/:slug/guest-register`,
`POST /organizer/tournaments`, `POST /organizer/tournaments/:id/entrants`,
`POST /organizer/tournaments/:id/bracket`, `PUT /organizer/matches/:id/score`,
`POST /organizer/matches/:id/lobby-results`, `POST /organizer/tournaments/:id/publish`,
`POST /organizer/tournaments/:id/invites`, `POST /auth/recovery/codes`.

Missing on a required endpoint → `400 bad_request` with `details.reason: "idempotency_key_required"`.

**Protocol**

1. Client generates a UUIDv4 (or ULID) per logical attempt — **not** per retry. It reuses the same key
   for every retry of that attempt.
2. Server computes `scope = session.user_id ?? sha256(guest_token) ?? "ip:" + ip_hash`, and
   `request_hash = sha256(method + "\n" + path + "\n" + canonical_json(body))`.
3. `INSERT INTO idempotency_keys (scope, key, endpoint, request_hash, status, created_at, expires_at)
   VALUES (?,?,?,?,0,?,?)` with `PRIMARY KEY (scope, key)`.
   - Insert succeeds → this is the first attempt. Proceed.
   - Insert fails on the PK →
     - stored `request_hash` differs → `409 idempotency_key_reuse`;
     - stored `status = 0` (in flight) and `created_at` within 30 s → `409 idempotency_in_progress`,
       `Retry-After: 1`;
     - stored `status = 0` and older than 30 s → treat as abandoned, take it over
       (`UPDATE ... SET created_at = ? WHERE scope = ? AND key = ? AND status = 0`);
     - stored `status > 0` → replay: return the stored status and body with
       `Idempotent-Replay: true`.
4. On completion, `UPDATE idempotency_keys SET status = ?, response_body = ?, completed_at = ?` — in
   the **same `.batch()`** as the business mutation, so a stored "success" can never exist without the
   mutation having happened.
5. Rows expire after **24 hours**; a cron trigger deletes expired rows nightly. Responses larger than
   32 KiB are stored as `status` only with a `response_truncated` flag; a replay of one of those
   returns `200` with `{ "data": null, "meta": { "replayed": true, "body_unavailable": true } }` and
   the client refetches. (Only the bracket-generation response can be that big.)

**Rejected:** relying purely on unique indexes. They give correctness (no duplicate entrant) but the
client sees `409 already_registered` on a retry of its *own* successful request, which reads as an
error to the player. The unique index stays as the last line of defence; the idempotency store is
what makes the retry look like a success.

### 6.2 `version` — "did someone else change this while I was typing?"

Two organizers on two phones at the scorer's table is the normal case, not the edge case.

Every mutable object the organizer edits carries an integer version counter, starting at 1 and
incremented on every write. Mutating endpoints compare it in the `WHERE` clause:

```sql
-- matches: the counter is `result_version` (owned by BRACKET-ENGINE.md)
UPDATE matches SET ..., result_version = result_version + 1 WHERE id = ?1 AND result_version = ?2

-- everything else: the counter is `version`
UPDATE tournaments SET ..., version = version + 1 WHERE id = ?1 AND version = ?2
```

`meta.changes === 0` → `409 stale_version` with `details.current_version` and `details.current` (the
freshly read object, so the client can render a diff and let the organizer decide).

### 6.2.1 The guard must be carried by EVERY statement in the batch

This is the most important paragraph in §6, and getting it wrong is silent.

**D1's `.batch()` is all-or-nothing only on *error*.** A statement that matches zero rows is a
*successful* statement. The batch commits. There is no procedural logic inside a batch: a `SELECT`
cannot gate a sibling `INSERT`, and a guarded `UPDATE` matching nothing does not stop its siblings.

So a batch shaped like "one guarded `UPDATE` + several unguarded writes" does the worst possible
thing on a lost race: it **returns `409 stale_version` to the client while having already committed
everything else** — the audit row, the downstream `entrant_a_id`/`entrant_b_id` writes computed from
stale data, the `state_version` bump. A wrong name in a semi-final slot on the venue projector is
precisely the failure the `result_version` / `match_audit` design exists to prevent, and "two
organizers on two phones at the scorer's table is the normal case".

**The rule.** Every statement in the batch repeats the same condition:

- `UPDATE` / `DELETE`: append `AND (SELECT <col> FROM <table> WHERE id = ?k) = ?v` to the `WHERE`.
- `INSERT`: rewrite as `INSERT INTO t (…) SELECT ?, ?, … WHERE (SELECT <col> FROM <table> WHERE id = ?k) = ?v`.

Then read `meta.changes` on the **guarded counter UPDATE** (make it statement 0 so its index is
fixed) and return `409` when it is `0` — **with the guarantee that zero rows were written
anywhere**.

Where the guard column is itself incremented by statement 0, bind the *post-increment* value to
statements 1..n, or guard them on a column that does not move (`tournaments.id` plus the row's
`version` read in the same batch). Either is fine; what is not fine is leaving them unconditional.

**Rejected: pre-read the version, then run an unguarded batch, then verify and compensate.** There
is a window between the read and the batch — that window is the entire reason the counter exists —
and a compensating batch can itself fail. The conditional form has no window.

**The same rule applies to capacity, not just to versions.** §3.3's registration and §4.7's walk-in
both express `max_entrants` as a condition inside the `INSERT` and the counter `UPDATE`, never as a
`SELECT` "inside the batch".

**The request field is named after the column**, so there is no translation layer to get wrong:

| Field | Required on |
| --- | --- |
| `result_version` | `PUT /organizer/matches/:id/score`, `POST /organizer/matches/:id/reopen`, `POST /organizer/matches/:id/confirm`, `PATCH /organizer/matches/:id`, `POST /organizer/matches/:id/lobby-results` |
| `version` | `PATCH /organizer/tournaments/:id`, `POST .../status`, `PATCH /organizer/entrants/:id`, `.../publish`, `.../unpublish`, `.../reseed`, `POST .../bracket`, `DELETE .../bracket`, `PATCH /admin/games/:id`, `PATCH /admin/club`, `PATCH /organizer/announcements/:id`, `PATCH /guest/entrant` |

`Idempotency-Key` and `result_version` are both required on the score endpoint and they are not
redundant: a
retry of the *same* attempt replays (idempotency), a *different* attempt built on stale data is
rejected (version).

---

## 7. Rate limiting

Primitive: the Cloudflare **Workers Rate Limiting binding** — the **`ratelimits`** array in
`wrangler.jsonc` (plural; the per-entry key is **`name`**, not `binding`; see ARCHITECTURE.md §7),
one namespace per bucket. It is free, needs no extra service, and is the only option that costs zero
D1 writes on the hot path.

Its honest limitation: it is a fixed window of **10 s or 60 s only**, and it is enforced
approximately and per-colo, not globally. That is fine for the buckets below — they exist to stop
scripted abuse, not to meter a paid API. Long-window limits (per-day) that genuinely need to be
global use a D1 counter table instead, and those endpoints are all low-frequency.

| Bucket | Key | Limit | Window | Endpoints |
| --- | --- | --- | --- | --- |
| `rl_read` | `ip_hash` | 300 | 60 s | All public GETs (a very high ceiling; it exists only to stop a scraper, and edge caching means most polls never reach it) |
| `rl_auth_begin` | `ip_hash` | 20 | 60 s | `/auth/passkey/*/options`, `/auth/email/start` |
| `rl_auth_verify` | `ip_hash` | 10 | 60 s | `/auth/passkey/*/verify`, `/auth/email/verify` |
| `rl_recovery` | `ip_hash` | 5 | 60 s | `/auth/recovery/login` |
| `rl_recovery_user` | `user_id` (D1 counter) | 10 | 24 h | `/auth/recovery/login` — plus account lock, AUTH.md §4.3 |
| `rl_register` | `user_id` | 5 | 60 s | `POST .../register` |
| `rl_register_ip` | `ip_hash` (D1 counter) | 15 | 24 h | `POST .../register`, `.../guest-register` |
| `rl_guest` | `ip_hash` | 5 | 60 s | `POST .../guest-register` |
| `rl_guest_token` | `sha256(guest_token)` | 30 | 60 s | `/api/v1/guest/*` |
| `rl_auth_read` | `user_id` | 120 | 60 s | **Every authenticated GET** under `/me/*`, `/organizer/*`, `/admin/*`, `/guest/*`. All of these are `no-store`, so the edge-cache defence of §12.4 does not apply to them and signup is free and open — a single account could otherwise hold `/organizer/tournaments/:id/entrants`, `/organizer/.../audit`, `/admin/users` and `/admin/audit` open at full speed against D1 and the CPU budget. That is exactly the cost-amplification attack SECURITY.md §12.4 exists to prevent. |
| `rl_engine` | `user_id` | 20 | 60 s | `GET /organizer/matches/:id/impact` (runs the full `resolveBracket` fold) and `POST /organizer/tournaments/:id/bracket/preview` (runs `previewBracket()` over up to 256 entrants). Applied **in addition** to `rl_auth_read` / `rl_write`. These are the two endpoints where one request costs milliseconds of CPU rather than microseconds. |
| `rl_write` | `user_id` | 60 | 60 s | Every other authenticated mutation |
| `rl_score` | `user_id` | 30 | 10 s | `PUT .../score``PUT .../score`, `.../lobby-results` — deliberately generous; a scorer entering a fast badminton round is not an attacker |
| `rl_export` | `user_id` (D1 counter) | 10 / 30 | 1 h / 24 h | `entrants.csv` (30/day only with `include_contact`) |
| `rl_contact` | `user_id` (D1 counter) | 60 | 1 h | `GET /organizer/entrants/:id/contact` |
| `rl_me_export` | `user_id` (D1 counter) | 1 | 1 h | `GET /me/export` |

`ip_hash` is `base64url(HMAC-SHA256(IP_HASH_KEY, cf_connecting_ip))[0:16]`. The raw IP is never
stored. `IP_HASH_KEY` is a Worker secret rotated yearly (rotation resets the counters, which is
acceptable). See SECURITY.md §10.3.

**429 response:** the standard error envelope with `code: "rate_limited"`,
`details.retry_after` in seconds, plus `Retry-After` and the `RateLimit-*` headers. The `message` is
generic ("Too many requests. Try again in 30 seconds.") and never says which bucket tripped — that
would tell an attacker which knob to tune.

A 429 on `rl_read` is served **without** touching D1.

---

## 8. Worker routing, caching, and link previews

### 8.1 The routing table

See **Appendix A** for the dispatch order, which is normative and must be implemented in exactly that
order.

### 8.2 Cache-Control matrix

| Class | `Cache-Control` | ETag | Edge-cached |
| --- | --- | --- | --- |
| Hashed assets `/_next/static/**`, `*.woff2` | `public, max-age=31536000, immutable` | asset's own | yes |
| Images, icons, `/og/**` static PNG | `public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800` | asset's own | yes |
| `robots.txt`, `sitemap.xml`, `*.webmanifest` | `public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800` | asset's own | yes |
| Prerendered HTML (static pages) | `public, max-age=0, must-revalidate, s-maxage=3600, stale-while-revalidate=86400` | asset's own | yes |
| SPA shell HTML for `/t/<slug>/**` (`/shell/tournament/index.html`, OG-injected) | `public, max-age=0, must-revalidate, s-maxage=60, stale-while-revalidate=600` | `"shell.<state_version>"` | yes, keyed by the full path |
| SPA shell HTML for `/p/<handle>/` (`/shell/player`) | same, `s-maxage=300` | `"shell.p.<profile_version>"` | yes |
| SPA shell HTML for `/admin/**` (`/shell/admin/index.html`) | `private, no-store` | none | **no** |
| Public API GET, live tournament | `public, max-age=5, s-maxage=5, stale-while-revalidate=25` | `"<state_version>.<code>"` | yes |
| Public API GET, non-live tournament | `public, max-age=60, s-maxage=120, stale-while-revalidate=600` | same | yes |
| Public API GET, slow-moving (games, club, venues, leaderboard) | as stated per endpoint | version counter | yes |
| **Any** authenticated response (`/me/*`, `/organizer/*`, `/admin/*`, `/auth/*`, `/guest/*`) | `private, no-store` | **never** | **no** |
| Any mutation response | `private, no-store` | never | no |
| **Any non-200 status** | `public, max-age=0, must-revalidate, s-maxage=0` | never | no |

**That last row is not a detail.** On optoads.com the header policy keyed purely off the file
extension, a request for `/og.png` arrived seconds before that asset shipped, the 404 was stamped
`s-maxage=86400`, and Cloudflare served the miss for a day — after the asset had deployed. A
WhatsApp unfurler hitting a tournament URL in the ninety seconds before publish would do exactly the
same thing here. Compute the cache policy from **(path class, status)**, never from path alone.

### 8.3 ETag and conditional requests

**Validator source.** `tournaments.state_version` is an `INTEGER NOT NULL DEFAULT 1` incremented in
the same `.batch()` as **any** mutation that changes anything visible under
`/api/v1/tournaments/<slug>/*`: the tournament row, an entrant, a match, a standings row, an
announcement.

ETag = `"<state_version>.<resource code>"` where the code is:

| Code | Resource |
| --- | --- |
| `t` | `/tournaments/:slug` |
| `e` | `/tournaments/:slug/entrants` |
| `b` | `/tournaments/:slug/bracket` |
| `m` | `/tournaments/:slug/matches` (plus a query fingerprint) |
| `s` | `/tournaments/:slug/standings` |
| `a` | `/tournaments/:slug/announcements` |

**The 304 fast path — this is the melt-proofing.** On a request carrying `If-None-Match`:

1. `SELECT state_version, status FROM tournaments WHERE slug = ?1` — **one indexed row read.**
2. Build the candidate ETag. If it matches any value in `If-None-Match`, return **`304`** with
   `ETag`, `Cache-Control`, and `Poll-After`, and **stop**. No entrant query, no match query, no JSON
   assembly, no serialisation.
3. Only on a miss do the remaining 1–2 statements run.

So the steady state during a live event — nothing has changed since the last poll — costs one primary
key lookup and returns roughly 200 bytes.

`If-None-Match: *` is treated as a wildcard match only for `GET` (per RFC 9110) — in practice the
client always sends the exact value it received.

A single tournament has one `state_version`, so an announcement bumps the bracket's ETag too. That
over-invalidates. It is accepted: the alternative is six independent version columns, six places to
remember to bump, and one day a bracket that does not update because someone forgot one of them.
Over-invalidation shows up as a wasted 15 KB; under-invalidation shows up as a wrong score on the
projector.

### 8.4 The polling contract

The public bracket, matches, and standings responses carry:

```
Poll-After: 10
```

**Server-side value:**

| Tournament status | `Poll-After` |
| --- | --- |
| `live` | `10` |
| `registration_open`, `registration_closed` | `60` |
| `completed`, `cancelled`, `archived` | `900` |
| anything else | `120` |

**Client rules (normative — the frontend implements exactly this):**

1. Poll only while the tab is visible. On `visibilitychange` to hidden, stop; on visible, poll once
   immediately (with `If-None-Match`) and resume.
2. Wait `Poll-After` seconds × a random jitter in `[0.85, 1.15]`. The jitter matters: 400 phones that
   loaded the page from the same WhatsApp message at the same second will otherwise poll in lockstep
   forever.
3. Always send `If-None-Match` with the last ETag.
4. **Adaptive backoff:** after each consecutive `304`, multiply the interval by `1.5`, capped at
   `120` s. Reset to `Poll-After` on any `200`.
5. On `429`, honour `Retry-After` exactly and do not multiply.
6. On a network error, exponential backoff from 5 s to 120 s with jitter; do not count these toward
   the 304 streak.
7. Never poll faster than 5 s regardless of what the server says.
8. Use a single poller per tab shared across the bracket/standings/entrants views, keyed by slug —
   three components on one page must not each open their own timer.

**Load arithmetic, stated in the unit that is actually billed: Worker invocations.**

`run_worker_first` means **the Worker runs in front of Cloudflare's cache, not behind it.** A
`Response` constructed inside a Worker is *not* stored in the zone cache; `s-maxage` on it is
honoured by the browser and by downstream caches, but it does not by itself collapse anything at the
edge. **The collapse exists only because §8.5 makes `caches.default` mandatory on public GETs** —
and even then, the Worker is still *invoked* for every poll. What `caches.default` saves is the D1
read and the JSON assembly, not the invocation.

So the honest numbers:

| | per poll |
| --- | --- |
| Worker invocations | **1** (always) |
| D1 statements, `If-None-Match` hit | 1 indexed row read |
| D1 statements, cache hit in `caches.default` | **0** |
| D1 statements, full miss | 3–4 (§1.7) |

400 phones on one live tournament at `Poll-After: 10` with ×1.5 backoff average roughly 5–7
invocations per second; a 3-hour event is on the order of 60,000–70,000 invocations. That is
comfortable on the **Workers Paid** plan this project deploys on (ARCHITECTURE.md §2: 10 M included
requests/month, 30 s CPU) and would be most of a day's budget on the free tier — which is one of the
two reasons the plan is not optional.

The other reason is CPU: `generateBracket + resolveBracket` is budgeted at 15 ms for 256 entrants
(ARCHITECTURE.md §9.15). The free plan's 10 ms cap cannot complete the single most important
organiser action in the product.

`run_worker_first` is also narrowed to an **array** of prefixes rather than `true`
(ARCHITECTURE.md §7), so `/_next/static/**`, fonts and the OG PNGs are served by the asset worker
and do not each cost a Worker invocation. Left as `true`, one cold page view costs 15–20 invocations
instead of 1.

Of the requests that do reach the Worker, the ones where nothing changed cost one indexed row read
(§8.3). A 32-team knockout final therefore stays under ~15 **D1 queries** per minute at any audience
size — which is the claim that was always true; it was the *request* count that was overstated.

**Rejected: SSE and WebSockets.** SSE holds a Worker invocation open for the duration and still has to
poll D1 internally, so it converts a cacheable request into a billable long-lived one and removes the
edge collapse. WebSockets done properly means a Durable Object per tournament — genuinely the right
architecture at 10,000 concurrent viewers, and overkill at 400. The upgrade path is clean: a DO would
sit behind the same URLs, push `state_version` changes, and the client would fall back to this
polling contract when the socket drops. Do not build it until a real event proves it is needed.

### 8.5 Edge caching inside the Worker

For **every** public API GET listed in §1 the Worker **must** use `caches.default`. Not "may": with
`run_worker_first`, a Worker-constructed response is never written to the zone cache, so this is the
only cache between 400 phones and D1 (§8.4). The read happens as an explicit step in the dispatch
order — Appendix A step 5c, *after* the `If-None-Match` fast path so a conditional hit still costs
one row read and returns ~200 bytes, and *before* the D1 read.

Three absolute rules:

1. **Build the cache key without cookies.** `const key = new Request(url.toString(), { method: 'GET' })`.
   Never pass the original `Request` as the key — it carries `Cookie`, and a cached entry keyed on one
   player's cookie is both a miss for everyone else and a hazard.
2. **Never `clone()` a stream you are also returning.** Build the JSON body as a **string**, then
   construct two independent `Response`s from that same string — one to `cache.put`, one to return.

   ```ts
   const body = JSON.stringify(payload);
   ctx.waitUntil(cache.put(key, new Response(body, { headers: cacheHeaders })));
   return new Response(body, { headers: responseHeaders });
   ```

Rule 2 is written this bluntly because the exact opposite pattern (`cache.put(key, response.clone())`)
shipped on optoads.com and silently truncated `webpack-*.js` to 0 bytes: `clone()` tees the body
between two consumers that drain at different rates, the larger chunk loses the race, React never
hydrated, and **not one console error was produced**. Small responses came through fine, which is what
made it look like it worked. API bodies here are strings in memory, so the safe form costs nothing.

3. **Strip `X-NC-Now` before `cache.put`, and re-stamp it on the way out.** `X-NC-Now` is the
   server clock the client's countdowns are computed against (§0.10). §8.2 gives cached public GETs
   `max-age` up to 300 s and `stale-while-revalidate` up to 3600 s, so a stored `X-NC-Now` is
   minutes to an hour stale by the time it is served — and the first API call on a WhatsApp landing
   *is* a heavily cached public GET. A stale value produces a confidently wrong check-in countdown
   and fires the `|skew| > 120` warning on a phone whose clock is **correct**, which is a
   correctness bug living inside the mechanism that was supposed to prevent one.

   So: `cacheHeaders` never contains `X-NC-Now`, and Appendix A step 13 sets it fresh on **every**
   outbound response including cache hits and `304`s.

   **Client rule (normative):** seed `skew` **only** from a response with `Cache-Control:
   private, no-store`. `GET /api/v1/auth/session` is called on every boot and is exactly that.
   Re-seed from any later no-store response. **Ignore `X-NC-Now` on any response carrying an
   `ETag`** — that is the "this may have come from a cache" signal, and it costs nothing to obey.

Authenticated responses are never written to `caches.default`. Enforce it structurally: the cache
helper takes the response class as an argument and refuses anything not marked `public`.

**A note on `stale-while-revalidate`.** Cloudflare's Cache API does **not** honour `s-maxage` or
`stale-while-revalidate` semantics the way the zone cache does — a `cache.match` either hits or
misses on the stored entry's own freshness. So `IA.md` §4's promise that "the 401st person is served
instantly from a stale copy" holds in the **browser** cache and in the SPA's `localStorage` layer,
not in `caches.default`. Do not build a UX guarantee on the Worker-side SWR; the browser and the
client cache already deliver it.

### 8.6 OG images and WhatsApp link previews

**The problem.** `/t/bgmi-diwali-2026/` and `/t/carrom-open-2026/` are served from the *same*
prerendered asset (`/shell/tournament/index.html`), because a static export cannot generate a page
per tournament.
WhatsApp's crawler does not execute JavaScript. Left alone, every tournament link shared in a WhatsApp
group would preview as the identical generic shell — which for a club whose entire distribution is
WhatsApp is close to a product-level failure.

**The fix: `HTMLRewriter` on the shell.** For any `/t/<slug>/**` HTML request, the Worker fetches the
shell asset, does one D1 read for the tournament's preview fields, and streams the asset through
`HTMLRewriter`, rewriting `<head>`:

| Element | Value |
| --- | --- |
| `<title>` | `<title> — Nellore Club` |
| `meta[name=description]` | `summary`, truncated to 155 chars on a word boundary |
| `meta[property=og:title]` | `title` |
| `meta[property=og:description]` | `"<Game> · <8 Nov, 7:00 PM IST> · Entry ₹200 · Prize ₹15,000"` — assembled server-side, in IST, because this line is what people actually read in a WhatsApp preview |
| `meta[property=og:url]` | `https://nellore.club/t/<slug>/` |
| `meta[property=og:type]` | `website` |
| `meta[property=og:site_name]` | `Nellore Club` |
| `meta[property=og:locale]` | `en_IN` |
| `meta[property=og:image]` | absolute https URL, §8.6.1 |
| `meta[property=og:image:width]` / `:height` | `1200` / `630` |
| `meta[property=og:image:alt]` | `title` |
| `meta[name=twitter:card]` | `summary_large_image` |
| `link[rel=canonical]` | `https://nellore.club/t/<slug>/` |
| `script[type=application/ld+json]` (id `nc-jsonld`) | a `SportsEvent` JSON-LD block (name, startDate, endDate, location, offers with `priceCurrency: "INR"`, organizer). **See the CSP note below — this one needs a per-request hash.** |

Implementation notes that will otherwise be got wrong:

- Do this for **every** request to `/t/<slug>/`, not just ones with a crawler user-agent. UA sniffing
  is cloaking-adjacent, breaks whenever WhatsApp changes its UA string, and produces a bug class
  ("works when I test it, not when I share it") that is miserable to diagnose.
- Every injected value is **HTML-attribute-escaped** (`&`, `<`, `>`, `"`, `'`). A tournament titled
  `"><script>` must not become a stored XSS on every share. See SECURITY.md §7.3.
- **The JSON-LD block needs its hash computed at injection time.** CSP `script-src` governs
  `<script type="application/ld+json">` exactly as it governs an executable script, so rewriting its
  contents invalidates the build-time `sha256` in `worker/csp-hashes.json`. Under `CSP_MODE=enforce`
  the block would be refused by the browser on **every** tournament page: the structured data never
  ships, and every `/t/<slug>/` view fires a CSP violation into the sampled report endpoint —
  poisoning the exact signal SECURITY.md §8.1's report-only rollout depends on.

  The fix, and it is cheap: the Worker builds the JSON-LD **string** first, computes
  `sha256` of those exact bytes with `crypto.subtle.digest`, appends `'sha256-<base64>'` to the
  `script-src` it emits **for that response**, and then injects the string. One extra hash per
  request, deterministic for a given tournament state, and the header is cached alongside the body
  under the existing `s-maxage=60` keyed by path — so it is computed roughly once per minute per
  tournament, not once per viewer. SECURITY.md §8.1 point 4 is corrected to match: the rewriter
  *does* touch one `<script>`, and that one has a request-time hash.

  If the D1 read fails or the slug is unknown, the rewriter injects **no** JSON-LD at all and the
  shell's placeholder block (which is already build-time hashed) is left alone.
- Replace the *content attribute* of existing tags rather than appending new ones — the static shell
  already ships default `og:*` tags, and a duplicate `og:title` gives crawlers a coin flip. The shell
  must therefore ship a complete set of placeholder tags for the rewriter to overwrite. Anything the
  rewriter cannot resolve (unknown slug) is left at the shell defaults, and the response is still
  `200` — the SPA renders its own "not found" state.
- The rewritten HTML is cached at the edge for `s-maxage=60` keyed by the full path, so a viral
  WhatsApp link costs one D1 read per minute, not one per recipient.
- `/p/<handle>/` gets the same treatment with profile fields.
- WhatsApp caches previews aggressively (days to weeks) and there is no purge API for it. So: the
  preview text must be right at **publish** time. The `publish`/`status` transition to `published`
  is the moment the club should share the link, and the UI says so.

#### 8.6.1 The image itself

**v1, and the only thing implemented: a static per-CATEGORY PNG.**
`og:image` = `tournaments.og_image_url` when the organizer supplied one, else
`https://nellore.club/og/cat-<category>.png` where category ∈ `esport`|`board`|`outdoor`, else
`https://nellore.club/og/default.png`. The full set is exactly six files —
`default.png`, `cat-esport.png`, `cat-board.png`, `cat-outdoor.png`, `player.png`,
`leaderboard.png` — specified in DESIGN.md §10, 1200×630, ≈ 28–40 KB each as flat-colour PNG-8,
checked into `public/og/`, served with a one-day edge cache. There is deliberately **no** per-game
PNG: twenty more pieces of art for a thumbnail that WhatsApp renders at 80 px next to the text that
actually does the work. WhatsApp shows a small thumbnail next to a large block of
title+description text — the text does the work, and the text is already per-tournament.

**Reserved, NOT implemented in v1 (`OG_DYNAMIC`): a rendered PNG per tournament.**
The env var exists and is documented so the upgrade is a flag flip plus one module, but v1 ships
with the route always taking the 302 branch. DESIGN.md §10 rejects it for v1 on bundle and CPU
grounds and that rejection stands.

`GET /og/t/:slug/:v.png` where `:v` is the tournament's `state_version`. Rendered with
`workers-og` (satori + resvg-wasm, both WebAssembly, both Workers-compatible) into a 1200×630 card
carrying the title, game, date/time in IST, entry fee and prize pool. Because the URL contains the
version, the response is `public, max-age=31536000, immutable` and each version renders at most once
before the edge takes over. A version the tournament no longer has still renders (it is just a cache
key), and an unknown slug returns a 302 to the static default.

**Why the default is the static image.** `workers-og` adds roughly 1.4 MB to the Worker bundle and
100–300 ms of CPU per cold render — real money against the Worker size limit and the CPU budget, in
exchange for a thumbnail. Ship the cheap thing that always works; turn on the expensive thing when the
owner wants prize money visible in the image.

**Rejected:** Cloudflare Browser Rendering (paid, seconds per render, absurd for this), and SVG
`og:image` (WhatsApp, Telegram and Slack all refuse to render SVG previews — this silently produces
*no* image, which is worse than a generic one).

---

## 9. Rich text: the markdown contract

Tournament rules and announcements need formatting. They are also the highest-value stored-XSS
target in the product — rules text is rendered on a page that every entrant opens.

**The contract:** the client **never** receives HTML and **never** calls `dangerouslySetInnerHTML`.

1. The organizer submits `rules_md` / `body_md` — markdown **source**, ≤ 20000 / 4000 chars.
2. The **Worker** parses it at write time with `marked` (tokenizer only; its renderer is not used) and
   walks the token stream into a restricted **AST**, stored as `rules_ast_json` / `body_ast_json`.
3. The API serves the AST. The React client renders it with a `switch` over node types into real
   React elements, which escape text by construction.

**Permitted node types — a closed allowlist. Anything else is dropped, and its text content is kept as a paragraph.**

| Node | Fields |
| --- | --- |
| `doc` | `children` |
| `paragraph` | `children` |
| `heading` | `level` (2, 3, 4 only — `#` is demoted to `h2`), `children` |
| `text` | `value` |
| `strong`, `em`, `del`, `code_inline` | `children` / `value` |
| `link` | `href`, `children` |
| `list` | `ordered` (bool), `start`, `children` (`list_item[]`) |
| `list_item` | `children` |
| `blockquote` | `children` |
| `code_block` | `value`, `lang` (`[a-z0-9-]{0,20}` or null) |
| `hr` | — |
| `br` | — |

**Not permitted, at all:** raw HTML (`marked`'s `html` token is dropped entirely, not escaped-and-kept
— an organizer has no legitimate need for it), images, tables, footnotes, autolinked emails,
`iframe`, anything else.

**Link rules:** `href` must parse as a URL with scheme `https:` or `http:` (upgraded to `https:`), or
be a same-site path starting `/`. `javascript:`, `data:`, `vbscript:`, `mailto:`, `tel:` and
scheme-relative `//host` are dropped and the link degrades to its text. Rendered links always carry
`rel="nofollow ugc noopener noreferrer"` and `target="_blank"`.

**Depth and size caps:** nesting depth ≤ 6, node count ≤ 2000, total serialised AST ≤ 64 KiB. Exceeding
any of these is `400 validation_failed` (`details.fields["rules_md"] = "too_complex"`) — an unbounded
AST is a client-side denial of service on a mid-range Android phone.

`rules_md` is also stored raw so the organizer can edit it. It is returned **only** to organizers, in
`GET /api/v1/organizer/tournaments/:id`, never in the public response.

**Why an AST and not sanitised HTML.** Sanitising HTML means trusting a sanitiser against mutation-XSS
and namespace-confusion bugs; one bypass is stored XSS on every viewer of that tournament. Rendering
a closed-allowlist AST through React means there is no code path in the entire application that turns
user input into markup. Client-side DOMPurify was also rejected: ~20 KB gzipped on a bundle budget
that matters on 4G, and it moves the trust boundary to the device.

---

## 10. Full endpoint index

| # | Method | Path | Auth | Idem | Ver | Cache |
| --- | --- | --- | --- | --- | --- | --- |
| 1.1 | GET | `/api/v1/config` | — | | | 60/300 |
| 1.2 | GET | `/api/v1/games` | — | | | 300/3600 |
| 1.3 | GET | `/api/v1/games/:slug` | — | | | 300/3600 |
| 1.4 | GET | `/api/v1/tournaments` | — | | | 30/60 |
| 1.5 | GET | `/api/v1/tournaments/:slug` | — | | | 15/30 |
| 1.5.1 | GET | `/api/v1/tournaments/:slug/overview` | — | | | 15/30 |
| 1.5.2 | GET | `/api/v1/handle-available` | — | | | no-store |
| 1.6 | GET | `/api/v1/tournaments/:slug/entrants` | — | | | 15/30 |
| 1.7 | GET | `/api/v1/tournaments/:slug/bracket` | — | | | 5/5 live |
| 1.8 | GET | `/api/v1/tournaments/:slug/matches` | — | | | 5/5 live |
| 1.9 | GET | `/api/v1/tournaments/:slug/standings` | — | | | 5/5 live |
| 1.10 | GET | `/api/v1/tournaments/:slug/announcements` | — | | | 15/30 |
| 1.11 | GET | `/api/v1/announcements` | — | | | 60/300 |
| 1.12 | GET | `/api/v1/leaderboard` | — | | | 300/900 |
| 1.13 | GET | `/api/v1/players/:handle` | — | | | 120/600 |
| 1.14 | GET | `/api/v1/club` | — | | | 300/3600 |
| 1.15 | GET | `/api/v1/venues` | — | | | 300/3600 |
| 1.16 | GET | `/api/v1/live` | — | | | 10/10 |
| 1.16.1 | GET | `/api/v1/search` | — | | | no-store |
| 1.17 | GET | `/healthz` | — | | | no-store |
| 2 | GET | `/api/v1/auth/config` | — | | | no-store |
| 2.1 | GET | `/api/v1/auth/session` | opt | | | no-store |
| 2 | POST | `/api/v1/auth/passkey/register/options` | opt | | | no-store |
| 2 | POST | `/api/v1/auth/passkey/register/verify` | opt | | | no-store |
| 2 | POST | `/api/v1/auth/passkey/login/options` | — | | | no-store |
| 2 | POST | `/api/v1/auth/passkey/login/verify` | — | | | no-store |
| 2 | POST | `/api/v1/auth/recovery/login` | — | | | no-store |
| 2 | GET | `/api/v1/auth/recovery/status` | S | | | no-store |
| 2 | POST | `/api/v1/auth/recovery/codes` | S+↑+UV | ✓ | | no-store |
| 2 | POST | `/api/v1/auth/email/start` | — | | | no-store |
| 2 | POST | `/api/v1/auth/email/verify` | — | | | no-store |
| 2 | POST | `/api/v1/auth/logout` | S | | | no-store |
| 2 | GET | `/api/v1/auth/bootstrap/status` | — | | | no-store |
| 3.1 | GET | `/api/v1/me` | S | | | no-store |
| 3.2 | PATCH | `/api/v1/me` | S | | | no-store |
| 3.3 | POST | `/api/v1/tournaments/:slug/register` | S | ✓ | | no-store |
| 3.4 | POST | `/api/v1/tournaments/:slug/guest-register` | — | ✓ | | no-store |
| 3.5 | GET | `/api/v1/guest/entrant` | G | | | no-store |
| 3.5 | PATCH | `/api/v1/guest/entrant` | G | | ✓ | no-store |
| 3.5 | POST | `/api/v1/guest/entrant/checkin` | G | | | no-store |
| 3.5 | POST | `/api/v1/guest/entrant/withdraw` | G | | | no-store |
| 3.6 | GET | `/api/v1/entrants/:id` | MINE/ROSTER/O(t) | | | no-store |
| 3.6.1 | PATCH | `/api/v1/entrants/:id` | MINE(e) | | ✓ | no-store |
| 3.7 | POST | `/api/v1/entrants/:id/checkin` | MINE(e) | | | no-store |
| 3.8 | POST | `/api/v1/entrants/:id/withdraw` | MINE(e) | | | no-store |
| 3.12.1 | POST | `/api/v1/entrants/:id/roster-invites` | MINE(e) | | | no-store |
| 3.12.2 | GET | `/api/v1/invites/:code` | — | | | no-store |
| 3.12.3 | POST | `/api/v1/invites/:code/accept` | S | | | no-store |
| 3.9 | GET | `/api/v1/me/registrations` | S | | | no-store |
| 3.9 | POST | `/api/v1/me/registrations/:id/leave` | S | | | no-store |
| 3.9 | POST | `/api/v1/me/registrations/claim` | S | | | no-store |
| 3.10 | GET | `/api/v1/me/credentials` | S | | | no-store |
| 3.10 | POST | `/api/v1/me/credentials/options` | S+UV | | | no-store |
| 3.10 | POST | `/api/v1/me/credentials/verify` | S+UV | | | no-store |
| 3.10 | PATCH | `/api/v1/me/credentials/:id` | S | | | no-store |
| 3.10 | DELETE | `/api/v1/me/credentials/:id` | S+↑ | | | no-store |
| 3.10 | GET | `/api/v1/me/sessions` | S | | | no-store |
| 3.10 | DELETE | `/api/v1/me/sessions/:id` | S | | | no-store |
| 3.10 | DELETE | `/api/v1/me/sessions` | S+↑ | | | no-store |
| 3.11 | GET | `/api/v1/me/export` | S | | | no-store |
| 3.11 | DELETE | `/api/v1/me` | S+↑+UV | | | no-store |
| 3.11 | POST | `/api/v1/me/undelete` | S | | | no-store |
| 4.1 | GET | `/api/v1/organizer/tournaments` | O | | | no-store |
| 4.2 | POST | `/api/v1/organizer/tournaments` | O | ✓ | | no-store |
| 4.2b | GET | `/api/v1/organizer/tournaments/:id` (id **or** slug) | O(t) | | | no-store |
| 4.3 | PATCH | `/api/v1/organizer/tournaments/:id` | O(t) | | ✓ | no-store |
| 4.4 | POST | `/api/v1/organizer/tournaments/:id/status` | O(t) | | ✓ | no-store |
| 4.5 | DELETE | `/api/v1/organizer/tournaments/:id` | O(t) | | | no-store |
| 4.6 | GET | `/api/v1/organizer/tournaments/:id/entrants` | O(t) | | | no-store |
| 4.7 | POST | `/api/v1/organizer/tournaments/:id/entrants` | O(t) | ✓ | | no-store |
| 4.8 | PATCH | `/api/v1/organizer/entrants/:id` | O(t); payment fields **Own/Org** | | ✓ | no-store |
| 4.8b | DELETE | `/api/v1/organizer/entrants/:id` | O(t) | | | no-store |
| 4.9 | POST | `/api/v1/organizer/entrants/:id/guest-token` | O(t) | | | no-store |
| 4.10 | GET | `/api/v1/organizer/entrants/:id/contact` | **Own/Org** | | | no-store |
| 4.11 | POST | `/api/v1/organizer/tournaments/:id/entrants/reseed` | O(t) | | ✓ | no-store |
| 4.12 | POST | `/api/v1/organizer/tournaments/:id/bracket` | O(t) | ✓ | ✓ | no-store |
| 4.12b | DELETE | `/api/v1/organizer/tournaments/:id/bracket` | O(t) | | ✓ | no-store |
| 4.13 | PUT | `/api/v1/organizer/matches/:id/score` | O(t) **or Scorer** | ✓ | ✓ | no-store |
| 4.13b | POST | `/api/v1/organizer/matches/:id/confirm` | O(t) ∧ ≠ `pending_confirm_by` | | ✓ | no-store |
| 4.14 | POST | `/api/v1/organizer/matches/:id/reopen` | **Own/Org** while `live`; **A** once `completed` | | ✓ | no-store |
| 4.14.1 | GET | `/api/v1/organizer/matches/:id/impact` | O(t) | | | no-store |
| 4.14.2 | POST | `/api/v1/organizer/tournaments/:id/bracket/preview` | O(t) | | | no-store |
| 4.15 | PATCH | `/api/v1/organizer/matches/:id` | O(t) | | ✓ | no-store |
| 4.15.1 | POST | `/api/v1/organizer/matches/:id/lobby-results` | O(t) **or Scorer** | ✓ | ✓ | no-store |
| 4.16 | POST | `/api/v1/organizer/tournaments/:id/publish` | **Own/Org** | ✓ | ✓ | no-store |
| 4.16 | POST | `/api/v1/organizer/tournaments/:id/unpublish` | A+↑ | | ✓ | no-store |
| 4.17 | POST | `/api/v1/organizer/tournaments/:id/announcements` | O(t) | | | no-store |
| 4.17 | PATCH | `/api/v1/organizer/announcements/:id` | O(t) | | ✓ | no-store |
| 4.17 | DELETE | `/api/v1/organizer/announcements/:id` | O(t) | | | no-store |
| 4.18 | POST | `/api/v1/organizer/tournaments/:id/invites` | O(t) | ✓ | | no-store |
| 4.18 | GET | `/api/v1/organizer/tournaments/:id/invites` | O(t) | | | no-store |
| 4.18 | DELETE | `/api/v1/organizer/invites/:id` | O(t) | | | no-store |
| 4.19 | GET | `/api/v1/organizer/tournaments/:id/entrants.csv` | O(t); `include_contact` **Own/Org** | | | no-store |
| 4.20 | GET | `/api/v1/organizer/tournaments/:id/organizers` | O(t) | | | no-store |
| 4.20 | POST | `/api/v1/organizer/tournaments/:id/organizers` | Own/A | | | no-store |
| 4.20 | DELETE | `/api/v1/organizer/tournaments/:id/organizers/:handle` | Own/A | | | no-store |
| 4.21 | GET | `/api/v1/organizer/tournaments/:id/audit` | O(t) | | | no-store |
| 4.22 | GET | `/api/v1/organizer/tournaments/:id/bracket` | O(t) | | | no-store |
| 4.23.1 | GET | `/api/v1/organizer/tournaments/:id/stages` | O(t) | | | no-store |
| 4.23.2 | POST | `/api/v1/organizer/tournaments/:id/stages` | O(t) | | ✓ | no-store |
| 4.23.3 | PATCH | `/api/v1/organizer/stages/:id` | O(t) | | ✓ | no-store |
| 4.23.3 | DELETE | `/api/v1/organizer/stages/:id` | O(t) | | ✓ | no-store |
| 4.23.4 | POST | `/api/v1/organizer/stages/:id/seed` | O(t) | | ✓ | no-store |
| 4.23.5 | POST | `/api/v1/organizer/stages/:id/rounds` | O(t) **or Scorer** | ✓ | ✓ | no-store |
| 4.23.6 | DELETE | `/api/v1/organizer/stages/:id/rounds/:round` | O(t) | | ✓ | no-store |
| 5 | GET | `/api/v1/admin/games` | A | | | no-store |
| 5 | POST | `/api/v1/admin/games` | A | | | no-store |
| 5 | PATCH | `/api/v1/admin/games/:id` | A | | ✓ | no-store |
| 5 | DELETE | `/api/v1/admin/games/:id` | A | | | no-store |
| 5 | GET | `/api/v1/admin/users` | A | | | no-store |
| 5 | GET | `/api/v1/admin/users/:id` | A | | | no-store |
| 5 | GET | `/api/v1/admin/users/:id/contact` | A+↑ | | | no-store |
| 5 | POST | `/api/v1/admin/users/:id/role` | A+↑ | | | no-store |
| 5 | POST | `/api/v1/admin/users/:id/suspend` | A+↑ | | | no-store |
| 5 | DELETE | `/api/v1/admin/users/:id/suspend` | A | | | no-store |
| 5 | DELETE | `/api/v1/admin/users/:id/sessions` | A+↑ | | | no-store |
| 5 | GET | `/api/v1/admin/sessions` | A | | | no-store |
| 5 | DELETE | `/api/v1/admin/sessions/:id` | A | | | no-store |
| 5 | GET | `/api/v1/admin/audit` | A | | | no-store |
| 5 | PATCH | `/api/v1/admin/club` | A | | ✓ | no-store |
| 5 | POST | `/api/v1/admin/announcements` | A | | | no-store |
| 5.8 | POST | `/api/v1/admin/venues` | A | | | no-store |
| 5.8 | PATCH | `/api/v1/admin/venues/:id` | A | | ✓ | no-store |
| 5.8 | DELETE | `/api/v1/admin/venues/:id` | A | | | no-store |
| 5.9 | GET | `/api/v1/admin/seasons` | A | | | no-store |
| 5.9 | POST | `/api/v1/admin/seasons` | A | | | no-store |
| 5.9 | PATCH | `/api/v1/admin/seasons/:id` | A | | ✓ | no-store |
| 5 | GET | `/api/v1/admin/stats` | A | | | private 60 |
| 5 | POST | `/api/v1/admin/leaderboard/rebuild` | A+↑ | | | no-store |
| 5 | POST | `/api/v1/admin/redirects` | A | | | no-store |
| 5 | POST | `/api/v1/admin/cache/purge` | A+↑ | | | no-store |
| 8.6 | GET | `/og/t/:slug/:v.png` | — | | | immutable |
| — | POST | `/api/v1/csp-report` | — | | | no-store |

Legend: **S** = session · **G** = guest token · **O** = organizer role · **O(t)** = organizer of
*this* tournament with `revoked_at IS NULL`, any `tournament_organizers.role`, or admin ·
**Own/Org** = `tournament_organizers.role IN ('owner','organizer')`, the tournament owner, or admin
(AUTH.md §7.2) · **Scorer** = `SCORER_OF(t)`, i.e. `role = 'scorer'`, which grants score entry and
nothing else · **MINE(e)** / **ROSTER** = entrant owner or captain / any active roster member,
read-only · **Own** = tournament owner · **A** = admin · **↑** = step-up re-auth ·
**UV** = user-verified session · **Idem** = `Idempotency-Key` required · **Ver** = `version` required.
Cache column shows `max-age/s-maxage`.

Where a row says "**or Scorer**", the endpoint is reachable by `ORG_OF(t)` **and** by
`SCORER_OF(t)`. Where it says "**Own/Org**", a `scorer` is refused with `403 forbidden`,
`details.reason: "role_insufficient"`.

---

## Appendix A — Worker dispatch order (normative)

Implement `worker/index.ts` in **exactly** this order. Earlier rules win. The implementer writes this
verbatim.

```
 0. Generate request_id (ULID). Attach to the log line and to every response as X-Request-Id.

 1. if (url.protocol === 'http:')
        → 301 to the https: equivalent, preserving path + query.
          Include Strict-Transport-Security on the redirect itself.

 2. if (url.hostname === 'www.nellore.club')
        → 301 to https://nellore.club + pathname + search.
      (Any other hostname reaching the Worker: serve normally. wrangler routes
       only bind these two.)

 3. if (pathname === '/healthz')
        → health handler. text/plain. no-store. Return.

 4. if (pathname === '/api/v1/csp-report' && method === 'POST')
        → sample 1%, log, 204. Never touches D1. Return.

 5. if (pathname.startsWith('/api/'))
        → API router (Appendix C). NEVER falls through to ASSETS.
          Unknown /api path → 404 not_found in the JSON error envelope.
          method not in the route's set → 405 with Allow.
        Return.

    Inside the router, for a PUBLIC GET (§1), in this exact order:
      5a. rate limit (rl_read). A 429 here never touches D1 or the cache.
      5b. If-None-Match fast path: ONE indexed read of
          (state_version, status) and, on a match, 304 + ETag +
          Cache-Control + Poll-After. STOP. (~200 bytes, 1 statement.)
      5c. caches.default lookup with a COOKIE-FREE key
          (new Request(url.toString(), { method: 'GET' })).
          Hit → serve it, after re-stamping X-NC-Now (step 13). ZERO D1.
      5d. Miss → the D1 reads, assemble the JSON as a STRING, and
          ctx.waitUntil(cache.put(key, new Response(body, cacheHeaders)))
          where cacheHeaders does NOT contain X-NC-Now.
    5c is not optional. With run_worker_first the Worker sits in FRONT of
    Cloudflare's cache, so a Response it constructs is never stored in the
    zone cache; caches.default is the only thing between 400 phones and D1.

 6. if (pathname.startsWith('/og/t/'))
        → if (env.OG_DYNAMIC === '1') dynamic OG renderer (§8.6.1). Return.
          else 302 → /og/cat-<category>.png, or /og/default.png when the
          slug is unknown. In v1 OG_DYNAMIC is never set, so this branch is
          the only branch. Return.
      (Note: /og/*.png are plain static assets and fall through to step 12.)

 7. if (pathname starts with '/shell/')
        → 404 (the prerendered 404 page). Shells are never directly reachable,
          never linked, and must never be indexed or shared.
        Return.

 8. Method guard: for every path from here on, only GET and HEAD are allowed.
        → otherwise 405, Allow: GET, HEAD.

 9. Short-link redirects (one indexed D1 read each, edge-cached 300s;
    SKIP THE D1 READ if <code> fails its regex — an unfiltered lookup is a free
    DoS on the subrequest budget):

      /j/<code>/   <code> = ^[23456789BCDFGHJKMNPQRSTVWXYZ]{6}$
            → look up invites WHERE code_hash = HMAC(INVITE_PEPPER, code)
              AND kind = 'join' → 302 → /t/<slug>/register/
      /i/<code>/   same alphabet
            → look up invites WHERE code_hash = HMAC(INVITE_PEPPER, code)
              AND kind = 'roster' → 302 → /t/<slug>/register/?invite=<code>
              The SPA then calls GET /api/v1/invites/<code> (§3.12.2) to render
              the accept screen, and POST /api/v1/invites/<code>/accept
              (§3.12.3) once the invitee has a session.
      Either lookup missing/expired/revoked → 302 → /t/ (which itself 301s to
      /tournaments/). Never a 404 with a distinguishing body: that would make
      this a code-guessing oracle.
      /t/<slug>/** where <slug> has a row in `slug_redirects`
            → 301 → /t/<new slug>/ + remaining path + query

10. SPA shell rewrites. Patterns are checked BEFORE any D1 lookup; anything
    failing its regex falls through to step 12 and the 404 page.
      <slug>    = ^[a-z0-9][a-z0-9-]{1,40}$
      <handle>  = ^[a-z0-9][a-z0-9_]{2,19}$
      <matchNo> = ^[0-9]{1,4}$
      <tab>     ∈ { bracket, standings, teams, schedule, rules, register, checkin, entry }

      /t/<slug>/                     → asset /shell/tournament/index.html  + inject
      /t/<slug>/<tab>/               → asset /shell/tournament/index.html  + inject
      /t/<slug>/m/<matchNo>/         → asset /shell/tournament/index.html  + inject
            → Cache-Control: public, max-age=0, must-revalidate,
                             s-maxage=60, stale-while-revalidate=600
            → ETag: "shell.<state_version>"

      /p/<handle>/                   → asset /shell/player/index.html      + inject
            → s-maxage=300 ; ETag: "shell.p.<profile_version>"

      /admin/**  (any depth, incl. /admin/)
                                     → asset /shell/admin/index.html       NO inject
            → Cache-Control: private, no-store
            → X-Robots-Tag: noindex

      /t/  or /t                     → 301 → /tournaments/
      /p/  or /p                     → 301 → /leaderboard/

    "inject" = the OG/meta HTMLRewriter pass of §8.6.

    Rewrites are INTERNAL:
      env.ASSETS.fetch(new Request(new URL('/shell/tournament/index.html', url),
                                   { method: 'GET' }))
    returned with status 200 under the ORIGINAL URL. Never redirect the browser
    to the shell path — the client router reads the real slug from
    window.location.pathname and the address bar must keep it.

    NOTE: there is no separate /organizer/** shell. Organizer and admin share the
    one authenticated surface at /admin/**, per IA.md §2.1; the API keeps
    /api/v1/organizer/* and /api/v1/admin/* separate because those namespaces
    encode PRIVILEGE, not navigation.

11. Reserved-path guard: if the slug captured in step 10 is in the reserved list
    (Appendix B) the rewrite still happens; the SPA renders "not found". The
    reserved list is enforced at CREATE time (§4.2), not at read time.

12. Everything else → env.ASSETS.fetch(request).

13. On the way out, for EVERY response the Worker returns — steps 3, 5, 6, 9,
    10 and 12, cache hits and 304s included:
      • set the security headers (SECURITY.md §8), including the per-page CSP
        script hashes for HTML responses. The hash lookup key is the ASSET path
        (/shell/tournament/index.html), NOT the request path, because step 10
        rewrites the URL. For a response carrying an injected JSON-LD block,
        append that block's request-time sha256 to script-src (§8.6);
      • set Cache-Control from cachePolicyFor(pathClass, status) — status is a
        REQUIRED argument (§8.2);
      • delete any Set-Cookie the assets layer might have produced;
      • set X-Request-Id;
      • set X-NC-Now FRESH, from the clock, unconditionally. It is never read
        from a cached response and is never part of a cache key or an ETag
        (§0.10, §8.5 rule 3).
```

Notes:

- `run_worker_first: true` in `wrangler.jsonc` means step 12 is the only path that touches the assets
  layer, and it is a subrequest, not a redirect.
- `html_handling: "auto-trailing-slash"` plus `trailingSlash: true` in `next.config.mjs` means
  `/tournaments` resolves to `/tournaments/index.html` without a rewrite table. Step 10 exists only
  for the routes a static export **cannot** generate.
- `not_found_handling: "404-page"` serves the prerendered 404 for genuine misses in step 12.
- The shells are **ordinary static pages** at `app/shell/tournament/page.tsx`,
  `app/shell/player/page.tsx`, `app/shell/admin/page.tsx`. No dynamic
  segment, no `generateStaticParams` sentinel, and three separate route entry points so Next
  code-splits the admin bundle away from the public tournament bundle (IA.md §2.3). They are
  unreachable directly because of step 7, and `robots.txt` disallows `/shell/`.
- The shell component reads the real slug from `window.location.pathname`. There is no Next dynamic
  param to read.

## Appendix B — Reserved slugs and handles

Rejected at creation time with `409 slug_taken` / `409 handle_taken`:

```
_  __  -  admin  administrator  api  app  assets  auth  bracket  brackets  club
contact  css  dashboard  default  delete  docs  edit  entrant  entrants  faq
favicon  games  guest  healthz  help  home  images  img  index  js  leaderboard
legal  login  logout  manifest  me  new  next  null  og  organizer  organizers
p  player  players  privacy  profile  public  register  robots  rules  schedule
search  security  session  settings  shell  signin  signout  signup  sitemap
standings  static  status  support  t  terms  test  tournament  tournaments
undefined  user  users  venue  venues  www  _next
```

Plus: anything matching `^(sitemap|robots|favicon)`, anything that is entirely digits (so
`/t/12345/` can never be confused with an id-based route), and any string containing a character
outside `[a-z0-9-]` for slugs or `[a-z0-9_-]` for handles.

## Appendix C — API route table (matching order)

Match `/api/v1/...` in this order; first match wins. `:param` is one path segment, no slashes.

```
GET    /api/v1/config
GET    /api/v1/auth/config
GET    /api/v1/auth/session
GET    /api/v1/auth/bootstrap/status
GET    /api/v1/auth/recovery/status
POST   /api/v1/auth/passkey/register/options
POST   /api/v1/auth/passkey/register/verify
POST   /api/v1/auth/passkey/login/options
POST   /api/v1/auth/passkey/login/verify
POST   /api/v1/auth/recovery/login
POST   /api/v1/auth/recovery/codes
POST   /api/v1/auth/email/start
POST   /api/v1/auth/email/verify
POST   /api/v1/auth/logout

GET    /api/v1/games
GET    /api/v1/games/:slug
GET    /api/v1/venues
GET    /api/v1/club
GET    /api/v1/announcements
GET    /api/v1/leaderboard
GET    /api/v1/players/:handle
GET    /api/v1/live
GET    /api/v1/search

GET    /api/v1/invites/:code               ← public; before any /invites/:id route
POST   /api/v1/invites/:code/accept

GET    /api/v1/tournaments
GET    /api/v1/handle-available
POST   /api/v1/tournaments/:slug/register          ← before the bare :slug GET
POST   /api/v1/tournaments/:slug/guest-register
GET    /api/v1/tournaments/:slug/entrants
GET    /api/v1/tournaments/:slug/bracket
GET    /api/v1/tournaments/:slug/matches
GET    /api/v1/tournaments/:slug/standings
GET    /api/v1/tournaments/:slug/announcements
GET    /api/v1/tournaments/:slug/overview
GET    /api/v1/tournaments/:slug

GET    /api/v1/guest/entrant
PATCH  /api/v1/guest/entrant
POST   /api/v1/guest/entrant/checkin
POST   /api/v1/guest/entrant/withdraw

GET    /api/v1/me
PATCH  /api/v1/me
DELETE /api/v1/me
POST   /api/v1/me/undelete
GET    /api/v1/me/export
GET    /api/v1/me/registrations
POST   /api/v1/me/registrations/claim      ← before the :id route
POST   /api/v1/me/registrations/:id/leave
GET    /api/v1/me/credentials
POST   /api/v1/me/credentials/options
POST   /api/v1/me/credentials/verify
PATCH  /api/v1/me/credentials/:id
DELETE /api/v1/me/credentials/:id
GET    /api/v1/me/sessions
DELETE /api/v1/me/sessions
DELETE /api/v1/me/sessions/:id

GET    /api/v1/entrants/:id
PATCH  /api/v1/entrants/:id
POST   /api/v1/entrants/:id/checkin
POST   /api/v1/entrants/:id/withdraw
POST   /api/v1/entrants/:id/roster-invites

GET    /api/v1/organizer/tournaments
POST   /api/v1/organizer/tournaments
GET    /api/v1/organizer/tournaments/:id      ← :id may be a trn_ id OR a slug (§4.2b)
PATCH  /api/v1/organizer/tournaments/:id
DELETE /api/v1/organizer/tournaments/:id
POST   /api/v1/organizer/tournaments/:id/status
GET    /api/v1/organizer/tournaments/:id/entrants
POST   /api/v1/organizer/tournaments/:id/entrants
GET    /api/v1/organizer/tournaments/:id/entrants.csv
POST   /api/v1/organizer/tournaments/:id/entrants/reseed
GET    /api/v1/organizer/tournaments/:id/bracket
POST   /api/v1/organizer/tournaments/:id/bracket/preview   ← before .../bracket
POST   /api/v1/organizer/tournaments/:id/bracket
DELETE /api/v1/organizer/tournaments/:id/bracket
GET    /api/v1/organizer/tournaments/:id/stages
POST   /api/v1/organizer/tournaments/:id/stages
PATCH  /api/v1/organizer/stages/:id
DELETE /api/v1/organizer/stages/:id
POST   /api/v1/organizer/stages/:id/seed
POST   /api/v1/organizer/stages/:id/rounds
DELETE /api/v1/organizer/stages/:id/rounds/:round
POST   /api/v1/organizer/matches/:id/lobby-results
POST   /api/v1/organizer/tournaments/:id/publish
POST   /api/v1/organizer/tournaments/:id/unpublish
POST   /api/v1/organizer/tournaments/:id/announcements
POST   /api/v1/organizer/tournaments/:id/invites
GET    /api/v1/organizer/tournaments/:id/invites
GET    /api/v1/organizer/tournaments/:id/organizers
POST   /api/v1/organizer/tournaments/:id/organizers
DELETE /api/v1/organizer/tournaments/:id/organizers/:handle
GET    /api/v1/organizer/tournaments/:id/audit
PATCH  /api/v1/organizer/entrants/:id
DELETE /api/v1/organizer/entrants/:id
POST   /api/v1/organizer/entrants/:id/guest-token
GET    /api/v1/organizer/entrants/:id/contact
PATCH  /api/v1/organizer/matches/:id
PUT    /api/v1/organizer/matches/:id/score
POST   /api/v1/organizer/matches/:id/confirm
POST   /api/v1/organizer/matches/:id/reopen
GET    /api/v1/organizer/matches/:id/impact
PATCH  /api/v1/organizer/announcements/:id
DELETE /api/v1/organizer/announcements/:id
DELETE /api/v1/organizer/invites/:id

GET    /api/v1/admin/games
POST   /api/v1/admin/games
PATCH  /api/v1/admin/games/:id
DELETE /api/v1/admin/games/:id
GET    /api/v1/admin/users
GET    /api/v1/admin/users/:id
GET    /api/v1/admin/users/:id/contact
POST   /api/v1/admin/users/:id/role
POST   /api/v1/admin/users/:id/suspend
DELETE /api/v1/admin/users/:id/suspend
DELETE /api/v1/admin/users/:id/sessions
GET    /api/v1/admin/sessions
DELETE /api/v1/admin/sessions/:id
GET    /api/v1/admin/audit
PATCH  /api/v1/admin/club
POST   /api/v1/admin/announcements
POST   /api/v1/admin/venues
PATCH  /api/v1/admin/venues/:id
DELETE /api/v1/admin/venues/:id
GET    /api/v1/admin/seasons
POST   /api/v1/admin/seasons
PATCH  /api/v1/admin/seasons/:id
GET    /api/v1/admin/stats
POST   /api/v1/admin/leaderboard/rebuild
POST   /api/v1/admin/redirects
POST   /api/v1/admin/cache/purge
```

Ordering hazard, called out because it is the classic bug: `/api/v1/tournaments/:slug/register`
must be tested **before** `/api/v1/tournaments/:slug`, and `/api/v1/me/sessions` (DELETE all) before
`/api/v1/me/sessions/:id`. Use a router that matches on `(method, segment count, literal segments)`
rather than a chain of regexes, or write the table in this order and take the first hit.

Second hazard, new with stages: `POST /api/v1/organizer/stages/:id/seed` and
`POST /api/v1/organizer/stages/:id/rounds` are four-segment siblings and must both be tested before
any three-segment `/api/v1/organizer/stages/:id` route. `DELETE .../stages/:id/rounds/:round` is
five segments and cannot collide.

Third: `GET /api/v1/invites/:code` is **public** while `DELETE /api/v1/organizer/invites/:id` is
organizer-scoped. They are different paths, not a shared prefix — do not be tempted to unify them.

## Appendix D — D1 budget rules (normative)

Cloudflare's per-request subrequest budget and D1's own limits are hard walls, not guidelines. Every
handler must satisfy all of:

1. **≤ 8 D1 statements per request.** A `.batch()` counts as **one** subrequest regardless of how many
   statements it contains. Any handler that would exceed 8 must be restructured into a batch or a
   different query.
2. **The 304 path is 1 statement.** No exceptions. See §8.3.
3. **`GET /tournaments/:slug/bracket` is one `SELECT` plus one `.batch()`** — **2 subrequests, 3 or
   4 statements** — and assembles the tree in JS. Never one query per round or per match.
   - statement 1 (standalone): the tournament row.
   - the batch: entrants; matches (`LEFT JOIN venues`, `LEFT JOIN users AS recorded_by`,
     `LIMIT 1024`); and `match_participants` **only when some stage of this tournament has
     `format = 'points_lobby'`**.
   `match_participants` is not optional for BGMI/Free Fire — a lobby's `slots[]` *is*
   `match_participants` (`BRACKET-ENGINE.md` §12.2, `matches.entrant_a_id`/`b_id` are NULL), so
   omitting it renders the flagship esports results page with empty slots. Head-to-head brackets
   skip it and keep the 3-statement shape. The venue and `recorded_by` joins are part of the same
   statement, not extra ones.
4. **Every multi-row write is a `.batch()`**, which D1 executes as an implicit transaction — this is
   the only atomicity primitive available. There are no `BEGIN`/`COMMIT`, no savepoints, no stored
   procedures.
5. **Chunk large batches at 200 statements.** Bracket generation, reseeding, publishing and
   leaderboard rebuild all chunk. Each chunk must be independently safe to re-run, and the operation's
   "done" flag (`bracket_generated_at`, `results_published_at`) is written in the **last** chunk, so a
   partial failure leaves the operation retryable rather than half-committed-and-marked-done.
6. **Every statement is `prepare(...).bind(...)`.** String-interpolated SQL is forbidden anywhere in
   the codebase, including in admin tooling and migrations. See SECURITY.md §6.
7. **Bound every read.** Every `SELECT` that can return more than one row has a `LIMIT`. There is no
   unbounded `SELECT *` on `entrants`, `matches`, `audit_log`, or `leaderboard_entries` anywhere.
   The **stated values** for the un-paginated reads, so nobody has to invent one:

   | Query | `LIMIT` | Overflow behaviour |
   | --- | --- | --- |
   | `matches` for one tournament (§1.7, §4.22) | **1024** = `MAX_MATCHES_PER_TOURNAMENT` | `meta.truncated: true`. Cannot be reached in practice because bracket generation refuses to exceed it (§4.12). |
   | `match_participants` for one tournament | **2048** | as above |
   | `entrants` for one tournament (§1.7) | **256** = `MAX_ENTRANTS` | as above |
   | `standings` for one stage (§1.9) | **256** | as above |
   | `stages` for one tournament | **4** | hard cap at create (§4.23.2) |
   | announcements on `/overview` | **6** (pinned + 5) | — |
   | live matches (§1.16) | **50** | `meta.truncated: true` |

   Picking a `LIMIT` lower than the creation cap is how a legal 8-group league renders a truncated
   bracket with no error, the standings table and the bracket disagree, and nobody can tell why. The
   `LIMIT` and the creation cap are the same number on purpose.
8. **No `SELECT COUNT(*)` on a user-facing read path.** Counts come from denormalised columns
   maintained in the same batch as the write.
9. **Long-running admin operations are resumable.** `/admin/leaderboard/rebuild` returns
   `truncated: true` and a `resume_cursor` rather than risking the CPU limit.
10. **`.batch()` is all-or-nothing ON ERROR — and only on error.** Both halves matter and the second
    half is the one that bites:
    - If any statement *throws* (constraint violation, syntax error, type error), nothing commits.
      Do not write partial-success handling that assumes otherwise, and never inspect `results[i]`
      for success while ignoring the batch's own rejection.
    - **A statement that matches zero rows is a SUCCESSFUL statement.** The batch commits. There is
      no procedural logic inside a batch: a `SELECT` cannot gate a sibling `INSERT`, and a guarded
      `UPDATE ... WHERE version = ?` matching nothing does not stop its unguarded siblings from
      writing.

    Therefore **every statement in a conditional batch repeats the condition** — `UPDATE`/`DELETE`
    in the `WHERE`, `INSERT` as `INSERT ... SELECT ... WHERE ...` — and the handler reads
    `meta.changes` on the guard statement. §6.2.1 is normative on this and gives the exact SQL.
    §3.3 (capacity) and §4.13 (score) are the two places it is load-bearing.

11. **Every mutation that changes anything visible under `/api/v1/tournaments/<slug>/*` bumps
    `state_version` in the same batch**, and every `bracket_version` bump is accompanied by a
    `state_version` bump (`db/schema.sql`, ARCHITECTURE.md §6.7). Under-invalidation puts a wrong
    score on a projector; over-invalidation costs a wasted 15 KB.

## Appendix E — Schema contract

**`db/schema.sql` is the schema.** It is the only file with enforced constraints, it is what
`wrangler d1 execute` runs, and it wins over every table listed anywhere in `docs/`. This appendix
is a reader's index: which tables this API touches and what it uses them for. If a column you need
is not in `db/schema.sql`, the fix is a migration, not a paragraph here.

| Table | What this API uses it for |
| --- | --- |
| `users` | Identity. `handle`, `display_name`, `role`, `profile_public`, `profile_version` (ETag for `/players/:handle`), `session_epoch`, `suspended_until`, `deletion_requested_at`, `phone_enc`/`phone_hash`/`phone_last4`, `profile_answers_json` (registration prefill, keyed by `FieldDef.profile_key`). **The table is `users` and the FK column is `user_id` everywhere.** |
| `handle_reservations` | The 90-day squat guard behind §3.2. |
| `webauthn_credentials`, `webauthn_challenges`, `recovery_codes`, `sessions`, `email_otps` | AUTH.md §3–§9. `sessions.csrf_token`, `.epoch`, `.scope`, `.uv`, `.auth_at`, `.idle_expires_at`, `.absolute_expires_at` are the columns every predicate in AUTH.md §7.3 reads. |
| `games` | §1.2/§1.3 and the create-tournament defaults. Promoted columns are the ones this API filters or sorts on (`slug`, `category`, `is_active`, `sort_order`); everything else lives in `registration_fields_json` / `scoring_config_json` and is passed through opaquely. Seeded from `content/games.json`; see CONTENT.md §6. |
| `venues` | §1.15 read, §5.8 write, `tournaments.venue_id`, `matches.venue_id`. `version` is the optimistic lock; `DELETE` is a soft delete to `is_active = 0`, refused while a live tournament references it. |
| `tournaments` | Everything under §1.4–§1.11 and §4. The three counters that matter: `version` (organizer optimistic lock), `state_version` (the HTTP ETag validator, bumped by ANY visible mutation) and `bracket_version` (the recompute lock). A bump of `bracket_version` MUST bump `state_version` in the same batch. `bracket_seed` is immutable. Denormalised `entrant_count` / `confirmed_count` / `checked_in_count` / `waitlist_count` are what let §0.9 forbid `COUNT(*)`. |
| `tournament_organizers` | The `ORG_OF(t)` / `SCORER_OF(t)` / `OWNER_OF(t)` predicates. `role` ∈ `owner`\|`organizer`\|`scorer`\|`moderator` and **every predicate reads it**; `revoked_at IS NULL` is part of all three, so `DELETE .../organizers/:handle` (a soft revoke) actually removes authority. Granting scope here is owner-controlled; granting `users.role` is admin-only. |
| `invites` | **Two kinds.** `kind = 'join'` (§4.18): organiser-minted, `entrant_id IS NULL`, gates guest registration for one tournament — the lookup is always `code_hash = ? AND tournament_id = ?`, never `code_hash` alone, because the `UNIQUE` on `code_hash` is global. `kind = 'roster'` (§3.12): captain-minted, `entrant_id` set, redeemed by `POST /invites/:code/accept` to append one `entrant_members` row. Both are `code_hash = HMAC(INVITE_PEPPER, code)` and both are consumed by a conditional `UPDATE ... WHERE used_count < max_uses` with `meta.changes === 1` required. |
| `slug_redirects` | Worker dispatch step 9, the 301 after a rename. |
| `seasons` | The `period` dimension of the leaderboard (`season:<slug>`) and the `NOT NULL` parent of `points_ledger.season_id`. Managed at §5.9; exactly one `is_active = 1`, enforced by `ux_seasons_active`. `tournaments.season_id` is resolved from it at creation (§4.2.0) and frozen at publish. |
| `stages` | The shape authority, and it is **written by §4.23**, not only implied. A single-stage tournament has exactly one row and the organizer never sees the word; groups → playoffs is two. `options_json` is the engine's validated `FormatOptions`; `skeleton_json` is the stored `Skeleton` the recompute **loads** (never regenerates); `skeleton_hash` guards the generate path only. `points_divisor` must equal `options.pointsDivisor`; `tiebreakers_json` declares, in order, what `standings.tiebreak_1..5` hold. |
| `entrants` | §1.6, §3.3–§3.9, §4.6–§4.11. `display_name` is the snapshot the bracket renders (the `team_name` request field writes here). `status_changed_at` is REQUIRED on `withdrawn`/`disqualified` — the engine cannot decide forfeits without it. Partial unique index on `(tournament_id, user_id)` for live statuses is the last line of defence behind `409 already_registered`; `payment_ref` is globally unique so one UTR cannot pay for four entries. |
| `entrant_members` | The roster. `ux_member_one_team` makes "one human, one team, per tournament" a database guarantee. |
| `stage_entrants` | Which entrants are in which stage. `seed` is the **canonical dense 1..N seed** from `Skeleton.seedList`, written at generation and immutable — every tiebreak chain ends in it. `group_no` is the derived output of snake assignment and is never fed back as `Entrant.groupHint` (that input is `entrants.group_hint`). Stage 2+ rows are written by `POST /organizer/stages/:id/seed` (§4.23.4) with `source_stage_id` and `source_rank`. |
| `matches` | §1.7, §1.8, §4.13–§4.15. **Slots reference their SOURCE** (`a_source_kind` + `a_source_match_id`), never their destination, and both self-FKs are `ON DELETE NO ACTION` (not `RESTRICT`) so a bulk `DELETE FROM matches WHERE stage_id = ?` succeeds. `entrant_a_id`/`entrant_b_id`/`status`/`winner_entrant_id`/`loser_entrant_id` are derived columns written only by the recompute diff; **`result_entrant_a_id`/`result_entrant_b_id` are NOT** — the score endpoint writes them once and the diff never touches them, and they are the sole source of the invalidation check. `code` is the engine's `MatchId` (`W2-3`), unique per stage; `match_no` is unique per **tournament** and is `MAX(match_no) + skeletonMatch.number`; `position` is stage-global within `(bracket, round)`, and `lobby_no − 1` for `BR`. `recorded_by` is what §1.7 emits as `updated_by`; there is no `updated_by_user_id` column. `result_version` is the single optimistic-concurrency counter for the whole row. Scores and bonuses are `INTEGER`. |
| `match_participants` | The `points_lobby` rows (§4.15.1). Points are recomputed server-side on every write; the client never submits a total. |
| `match_audit` | Append-only result history, written in the same batch as every score write. Distinct from `audit_log` because it is queried by match and must never be pruned with the general trail. `match_id` is nullable `ON DELETE SET NULL` and the row carries denormalised `match_code` + `match_no`, so a bracket reset (§4.12b) — which is reachable right after a `reopen` — cannot destroy the record of who entered and who cleared a disputed score. |
| `standings` | §1.9, and it is per **stage**: PK `(stage_id, entrant_id)`, because "standings of the group stage" and "standings of the playoffs" are different questions — which is why §1.9 takes a `?stage=`. `tiebreak_1..5` hold, in order, the first five comparators after `points`, as declared by `stages.tiebreakers_json`. Rational tiebreaks (`net_run_rate`, `set_ratio`) are stored ×1000 as integers and may be negative. `points` is an integer; chess halves are `points_divisor = 2`. |
| `points_ledger` | Append-only, signed award rows. **Written by `POST .../publish`, one row per linked roster member per awarded entrant** (§4.16 step 3); `leaderboard_entries` is derived from it, never written from the award list directly. `season_id` is `NOT NULL`, resolved from `tournaments.season_id ?? the active season`. `unpublish` is a void + recompute, never arithmetic on a total. |
| `leaderboard_entries` | §1.12, materialised. PK is effectively `(period, game_id, user_id)` via two partial unique indexes, because SQLite treats NULLs as distinct. |
| `player_ratings` | **Not populated in v1** (§1.12.2). Nothing writes it; `metric=rating` returns `501`, `seeding_method='rating'` returns `400`, `games[].rating` is always `null`. The table exists so enabling ratings later is a feature flag rather than a migration. |
| `announcements` | §1.10, §1.11, §4.17. `body_ast_json` is the closed-allowlist AST (§9); the client never receives HTML. |
| `audit_log` | §4.21, §5. `actor_ip_hash`, never a raw IP. Carries `request_id` so a player quoting an `X-Request-Id` is traceable. |
| `idempotency_keys` | §6.1. PK `(scope, key)`; completed in the same batch as the mutation. |
| `rate_counters` | The D1 side of §7 — long windows only. Short windows use the Workers Rate Limiting binding and never touch D1. |
| `settings` | `value_json`, holding the club config the owner edits without a deploy plus the five version counters `version.games`, `version.listing`, `version.club`, `version.club_announcements`, `version.leaderboard`. |

Boolean columns are `INTEGER NOT NULL DEFAULT 0/1`. JSON columns are `TEXT` holding a JSON document
and are **never** queried with `json_extract` on a hot path — if a field needs filtering, it gets its
own column. There are **no `REAL` columns anywhere**.
