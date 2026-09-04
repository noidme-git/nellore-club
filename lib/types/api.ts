/**
 * Every wire type in `docs/API.md`. This is the contract between the browser
 * half and the Worker half; ARCHITECTURE.md §4 rule 4 says they share nothing
 * else but HTTP.
 *
 * Two rules that these types encode and that no amount of care at a call site
 * can recover if they are broken:
 *
 *   - **Time on the wire is an RFC 3339 UTC string with a `Z`.** Never a local
 *     string, never a non-`Z` offset, never a bare epoch. The one exception is
 *     the `X-NC-Now` header, which carries server epoch SECONDS so the client
 *     can compute a clock skew — a mid-range Android clock is routinely minutes
 *     wrong, and a check-in countdown that lies is worse than no countdown.
 *   - **Money is an INTEGER of paise** and every field name ends `_paise`. The
 *     API never emits a formatted currency string; `lib/format/money.ts`
 *     formats with `Intl.NumberFormat('en-IN', …)`, which produces the Indian
 *     `₹1,00,000` grouping for free.
 *
 * `v1` is frozen once the club runs its first public tournament: fields may be
 * ADDED to a response, never removed and never retyped.
 */

import type {
  AnnouncementScope,
  AnnouncementSeverity,
  EntrantId,
  EntrantMemberId,
  EntrantMemberRole,
  EntrantStatus,
  GameCategory,
  LeaderboardPeriod,
  MatchId,
  MatchMethod,
  MatchSide,
  MatchStatus,
  Paise,
  ParticipantType,
  PaymentStatus,
  ScoringModel,
  SessionId,
  SessionScope,
  StageEntrantStatus,
  StageFormat,
  StageId,
  StageStatus,
  TournamentFormat,
  TournamentId,
  TournamentStatus,
  UserId,
  UserRole,
  VenueId,
} from './db';

/* =====================================================================
 * Primitives
 * ===================================================================== */

/**
 * RFC 3339 UTC with a `Z`: `"2026-11-08T13:30:00Z"`. API.md §0.8.
 * Rendered in IST at display time and only at display time — the server never
 * formats a date, except the `og:description` line, which is assembled
 * server-side because it is read inside WhatsApp where no JS runs.
 */
export type Rfc3339 = string;

/**
 * `base64url(JSON)` of `{ v, k, q }` (API.md §0.9). Opaque to the client. It is
 * NOT signed or encrypted and contains no secret — it is a public sort key, and
 * a user id or an offset must never be put in it.
 */
export type Cursor = string;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/* =====================================================================
 * Envelopes — API.md §0.4, §0.5
 * ===================================================================== */

/**
 * Every 2xx JSON response is an object with a `data` key. No endpoint ever
 * returns a bare array at the top level: that is a legacy JSON-hijacking
 * footgun and it makes client code inconsistent.
 */
export interface ApiSuccess<T> {
  data: T;
  /** Present only where an endpoint documents it. */
  meta?: JsonObject;
}

/**
 * Cursor pagination. `has_more` is the boolean form of `next_cursor !== null`;
 * both are provided because forgetting the null check is a classic
 * infinite-loop bug.
 */
export interface PageInfo {
  next_cursor: Cursor | null;
  has_more: boolean;
  limit: number;
}

/**
 * `page` is present on and only on collection responses. `meta.total` appears
 * only where the count is a denormalised column on a row already being read —
 * API.md §0.9 forbids `COUNT(*)` on a user-facing read path.
 */
export interface ApiCollection<T, M extends JsonObject = JsonObject> {
  data: T[];
  page: PageInfo;
  meta?: M;
}

/**
 * The closed error-code enum. Clients branch on `code`, never on `message`.
 *
 * These forty are API.md §0.6. The seven ceremony codes below them are defined
 * in AUTH.md and use the statuses stated there; `no_active_season` is API.md
 * §4.16. `worker/lib/errors.ts` holds the single code→status map, and a code
 * with no entry there is a build-time `never`.
 */
export type ErrorCode =
  // 400
  | 'bad_request'
  | 'malformed_json'
  | 'validation_failed'
  | 'invalid_cursor'
  // 401
  | 'unauthenticated'
  | 'session_expired'
  | 'guest_token_invalid'
  // 403
  | 'forbidden'
  | 'csrf_failed'
  | 'origin_not_allowed'
  | 'step_up_required'
  | 'uv_required'
  | 'recovery_scope_only'
  // 404
  | 'not_found'
  // 405
  | 'method_not_allowed'
  // 409
  | 'conflict'
  | 'slug_taken'
  | 'handle_taken'
  | 'already_registered'
  | 'stale_version'
  | 'idempotency_key_reuse'
  | 'idempotency_in_progress'
  | 'invalid_state_transition'
  | 'bracket_exists'
  | 'bracket_locked'
  | 'registration_closed'
  | 'tournament_full'
  | 'checkin_closed'
  | 'entrant_locked'
  | 'credential_exists'
  | 'bootstrap_closed'
  // 410
  | 'gone'
  // 413 / 415
  | 'payload_too_large'
  | 'unsupported_media_type'
  // 429
  | 'rate_limited'
  | 'recovery_locked'
  // 500 / 501 / 503
  | 'internal_error'
  | 'email_auth_disabled'
  | 'not_implemented'
  | 'database_unavailable'
  // Auth ceremony codes — AUTH.md
  | 'webauthn_challenge_expired'
  | 'webauthn_verification_failed'
  | 'no_credentials'
  | 'invalid_recovery_code'
  | 'signup_closed'
  | 'turnstile_failed'
  | 'invalid_join_code'
  // Publish path — API.md §4.16
  | 'no_active_season';

/** `details.fields` for `validation_failed`: a flat `{ field: reason_code }` map. */
export type FieldErrors = Record<string, string>;

/**
 * Endpoint-specific detail. The keys named here are the ones API.md guarantees
 * for a given code; anything else is documented at its own endpoint.
 */
export interface ApiErrorDetails {
  fields?: FieldErrors;
  /** Seconds. Always accompanied by a `Retry-After` header on 429 and 503. */
  retry_after?: number;
  /** `stale_version` carries both the number and the fresh object, so the client can render a compare sheet instead of silently overwriting. */
  current_version?: number;
  current?: JsonValue;
  /** `invalid_state_transition`. */
  from?: string;
  to?: string;
  allowed?: string[];
  /** `registration_closed`: `not_open` | `closed` | `full` | `deadline_passed`. Also the generic `conflict` reason. */
  reason?: string;
  /** `already_registered`. */
  entrant_id?: EntrantId;
  /** `checkin_closed`. */
  opens_at?: Rfc3339 | null;
  closes_at?: Rfc3339 | null;
  /** `conflict` with `reason: "too_many_matches"`. */
  match_count?: number;
  /** `conflict` with `reason: "handle_change_cooldown"`. */
  available_at?: Rfc3339;
  [key: string]: JsonValue | FieldErrors | undefined;
}

export interface ApiErrorBody {
  code: ErrorCode;
  /**
   * English, safe to show a player verbatim. Never a stack trace, a SQL
   * fragment, an internal id the caller cannot see, or a hostname.
   */
  message: string;
  details?: ApiErrorDetails;
  /**
   * ULID, also sent as `X-Request-Id` and written to the log line. This is what
   * a player quotes to an organiser when something breaks.
   */
  request_id: string;
}

/**
 * EVERY non-2xx response is this exact shape — including ones produced by the
 * routing layer, the rate limiter and the unhandled-exception catch. `304 Not
 * Modified` is the one non-2xx with no body, per HTTP.
 */
export interface ApiErrorEnvelope {
  error: ApiErrorBody;
}

/** What a raw `fetch` of any endpoint can produce, before the client unwraps it. */
export type ApiEnvelope<T> = ApiSuccess<T> | ApiErrorEnvelope;

/* =====================================================================
 * Custom registration fields — CONTENT.md §3 is authoritative for this
 * whole type: the FieldType union, the nested `validation` object,
 * `visibility`, `pii`, `options`, `visible_if`, every key name. API.md §3.3
 * owns ONLY the wire reason codes and the unknown-key rule.
 * ===================================================================== */

export type FieldType =
  | 'text'
  | 'textarea'
  | 'integer'
  | 'decimal'
  | 'tel'
  | 'email'
  | 'url'
  | 'date'
  | 'time'
  | 'select'
  | 'multiselect'
  | 'boolean'
  | 'color';

/**
 * `public` is on the bracket, `organizer` is stripped from every public
 * response, `private` is stripped from the organiser list too and appears only
 * in the single-registration detail view. Default when omitted is `organizer`:
 * fail closed. Stripping happens in ONE serializer driven by the snapshot
 * definition — a hand-maintained per-endpoint allowlist drifts, and the first
 * thing to leak is a phone number.
 */
export type FieldVisibility = 'public' | 'organizer' | 'private';

export interface FieldOption {
  value: string;
  label: string;
}

export interface FieldValidation {
  /** integer, decimal. */
  min?: number;
  max?: number;
  /** decimal. */
  step?: number;
  /** text, textarea. */
  min_length?: number;
  /** text, textarea, tel, url, email. */
  max_length?: number;
  /**
   * JS RegExp source, ANCHORED with `^…$`, no backreferences and no nested
   * unbounded quantifiers. ReDoS against a Worker CPU budget is a real denial
   * of service, not a theoretical one.
   */
  pattern?: string;
  /** Shown instead of a raw regex when `pattern` fails. Mandatory if `pattern` is set. */
  pattern_message?: string;
  /** boolean only — the field must be checked (consent gates). */
  must_be?: true;
  /** multiselect. */
  min_selected?: number;
  max_selected?: number;
}

/**
 * Conditional display without conditional code. `field` must reference a key in
 * the SAME array, so evaluation stays local and cheap. A hidden field is never
 * required, whatever `required` says, and its value is dropped on submit. No
 * nesting, no and/or — if you need boolean logic you need two fields.
 */
export type FieldCondition =
  | { field: string; equals: string | number | boolean }
  | { field: string; in: (string | number)[] }
  | { field: string; not_empty: true }
  | { field: string; lt: number }
  | { field: string; gt: number };

export interface FieldDef {
  /** `^[a-z][a-z0-9_]{0,39}$` — the JSON key in `fields_json`. Stable forever. */
  key: string;
  type: FieldType;
  /** Sentence case. What the player reads above the input. */
  label: string;
  /** One sentence under the input. Say where to find the value. */
  help?: string;
  /** A real example, never a repeat of the label. */
  placeholder?: string;
  required: boolean;
  visibility: FieldVisibility;
  /**
   * Personal data about an identifiable human under India's DPDP Act. NOT the
   * same axis as `visibility`: `bgmi_player_id` is `organizer` + `pii: false`
   * because it identifies a game account, not a person. Drives the 18-month
   * retention purge, and — for `type: 'tel'` — the encrypt-and-mask write path
   * of SECURITY.md §10.2.1.
   */
  pii: boolean;
  /**
   * Prefill from `users.profile_answers_json`, keyed by this rather than by
   * game slug — which is what lets chess-classical and chess-blitz share a
   * rating and a badminton player answer "level" once for singles and doubles.
   */
  profile_key?: string;
  default?: string | number | boolean | null;
  /** select / multiselect only, and required for them. */
  options?: FieldOption[];
  validation?: FieldValidation;
  visible_if?: FieldCondition;
}

/** A submitted or stored answer set, keyed by `FieldDef.key`. */
export type FieldValues = Record<string, JsonValue>;

/* =====================================================================
 * Rich text — API.md §9
 *
 * The client NEVER receives HTML and never calls dangerouslySetInnerHTML. The
 * Worker parses markdown at write time with `marked` (tokenizer only) into this
 * closed allowlist; React renders it through a `switch` into real elements,
 * which escape text by construction. Anything not in this union is dropped and
 * its text content kept as a paragraph.
 * ===================================================================== */

export interface RichTextDoc {
  type: 'doc';
  children: RichTextNode[];
}
export interface RichTextParagraph {
  type: 'paragraph';
  children: RichTextInline[];
}
export interface RichTextHeading {
  /** 2, 3, 4 only — `#` is demoted to `h2`. */
  type: 'heading';
  level: 2 | 3 | 4;
  children: RichTextInline[];
}
export interface RichTextText {
  type: 'text';
  value: string;
}
export interface RichTextStrong {
  type: 'strong';
  children: RichTextInline[];
}
export interface RichTextEm {
  type: 'em';
  children: RichTextInline[];
}
export interface RichTextDel {
  type: 'del';
  children: RichTextInline[];
}
export interface RichTextCodeInline {
  type: 'code_inline';
  value: string;
}
export interface RichTextLink {
  /**
   * `https:` or `http:` (upgraded to https), or a same-site path starting `/`.
   * `javascript:`, `data:`, `vbscript:`, `mailto:`, `tel:` and scheme-relative
   * `//host` are dropped and the link degrades to its text. Rendered links
   * always carry `rel="nofollow ugc noopener noreferrer"` and `target="_blank"`.
   */
  type: 'link';
  href: string;
  children: RichTextInline[];
}
export interface RichTextList {
  type: 'list';
  ordered: boolean;
  start: number | null;
  children: RichTextListItem[];
}
export interface RichTextListItem {
  type: 'list_item';
  children: RichTextNode[];
}
export interface RichTextBlockquote {
  type: 'blockquote';
  children: RichTextNode[];
}
export interface RichTextCodeBlock {
  type: 'code_block';
  value: string;
  /** `[a-z0-9-]{0,20}` or null. */
  lang: string | null;
}
export interface RichTextHr {
  type: 'hr';
}
export interface RichTextBr {
  type: 'br';
}

export type RichTextInline =
  | RichTextText
  | RichTextStrong
  | RichTextEm
  | RichTextDel
  | RichTextCodeInline
  | RichTextLink
  | RichTextBr;

export type RichTextNode =
  | RichTextDoc
  | RichTextParagraph
  | RichTextHeading
  | RichTextList
  | RichTextListItem
  | RichTextBlockquote
  | RichTextCodeBlock
  | RichTextHr
  | RichTextInline;

/** The stored/served root. `rules_ast`, `body_ast`, `description_ast`. */
export type RichText = RichTextDoc;

/* =====================================================================
 * Shared references
 * ===================================================================== */

/** The public identity of a person, as it appears attached to anything else. */
export interface PlayerRef {
  handle: string;
  display_name: string;
  /** Deterministic identicon seed; there are no avatar uploads in v1. */
  avatar_seed?: string | null;
}

export interface GameRef {
  slug: string;
  name: string;
  category: GameCategory;
  /** Always `null` in v1: a game renders as its category glyph tinted with `accent` (DESIGN.md §7). */
  icon: string | null;
}

export interface VenueRef {
  id: VenueId;
  name: string;
  area: string | null;
  online: boolean;
}

export interface TournamentRef {
  slug: string;
  title: string;
}

/** `bracket.stages[]` and `standings.stages[]` — what drives the stage selector. */
export interface StageSummary {
  id: StageId;
  ordinal: number;
  name: string;
  format: StageFormat;
  status: StageStatus;
  /** Top N per group who qualify onward. `null` for a terminal stage. */
  advance_count?: number | null;
}

/* =====================================================================
 * §1.1 GET /config
 * ===================================================================== */

export interface ConfigResponse {
  site: {
    name: string;
    tagline: string;
    timezone: string;
    currency: 'INR';
  };
  features: {
    /** AUTH.md §6 — false unless `EMAIL_OTP_ENABLED`. */
    email_otp: boolean;
    signup_open: boolean;
    /** Whether any tournament may enable guest registration at all. */
    guest_registration: boolean;
    turnstile: boolean;
    /** Always false in v1: `/og/t/*` always 302s to the static category card. */
    dynamic_og: boolean;
  };
  /** Present iff `features.turnstile`. */
  turnstile_site_key?: string;
  limits: {
    max_team_size: number;
    max_entrants_per_tournament: number;
    max_matches_per_tournament: number;
  };
  /**
   * Feeds the nav tab badges (IA.md §3.1). The ONE place a `COUNT(*)` is
   * allowed on a public read path, and only because it is bounded by
   * `ix_tournaments_public` and served from a 60-second cache. Without it the
   * Play and Live badges have no source and silently never render.
   */
  counts: {
    registration_open: number;
    live: number;
  };
  build: { api_version: string };
}

/* =====================================================================
 * §1.2 GET /games
 * ===================================================================== */

/**
 * The `scoring` block is owned verbatim by CONTENT.md; the API passes it
 * through untouched and never branches on it. Only `model` is guaranteed.
 */
export interface GameScoring {
  model: ScoringModel;
  [key: string]: JsonValue;
}

export interface Game {
  id: string;
  slug: string;
  name: string;
  category: GameCategory;
  short_name: string;
  blurb: string | null;
  /** Always null in v1 (DESIGN.md §7 — no sprite, no per-game raster). */
  icon: string | null;
  /** One of the six static cards: `/og/cat-esport.png`, `cat-board`, `cat-outdoor`. */
  og_image: string;
  participant_type: ParticipantType;
  team_size_min: number;
  team_size_max: number;
  substitutes_max: number;
  scoring: GameScoring;
  default_formats: StageFormat[];
  /** Convenience mirror of `scoring`; the client should not re-derive it. */
  supports_draws: boolean;
  /** ALWAYS `false` on the wire in v1, whatever content/games.json says, so no UI offers a rating control (API.md §1.12.2). */
  rating_enabled: boolean;
  registration_schema: FieldDef[];
  /** Opaque to the API; the bracket engine validates `result.detail` against it. */
  score_schema: JsonObject | null;
  active: boolean;
  sort_order: number;
}

/* =====================================================================
 * §1.4 GET /tournaments — the card
 * ===================================================================== */

export interface TournamentCard {
  id: TournamentId;
  slug: string;
  title: string;
  status: TournamentStatus;
  game: GameRef;
  format: TournamentFormat;
  participant_type: ParticipantType;
  starts_at: Rfc3339;
  ends_at: Rfc3339 | null;
  registration_opens_at: Rfc3339 | null;
  registration_closes_at: Rfc3339 | null;
  entry_fee_paise: Paise;
  prize_pool_paise: Paise;
  venue: VenueRef | null;
  max_entrants: number | null;
  entrant_count: number;
  confirmed_count: number;
  waitlist_count: number;
  /** `null` when `max_entrants` is null. */
  spots_left: number | null;
  banner_image: string | null;
  is_featured: boolean;
  /** The ETag validator. Bumped by ANY mutation visible under `/api/v1/tournaments/<slug>/*`. */
  state_version: number;
}

export interface TournamentPrize {
  position: number;
  label: string;
  amount_paise: Paise;
  extra: string | null;
}

export interface TournamentOrganizerRef {
  handle: string;
  display_name: string;
  is_owner: boolean;
}

export interface TournamentContact {
  whatsapp_group_url: string | null;
  public_phone: string | null;
}

/* =====================================================================
 * §1.5 GET /tournaments/:slug — the card plus the detail
 * ===================================================================== */

export interface TournamentDetail extends TournamentCard {
  summary: string | null;
  rules_ast: RichText | null;
  prizes: TournamentPrize[];
  /** Per-tournament override of the game's scoring block. Opaque passthrough. */
  scoring_config: JsonObject | null;
  format_config: JsonObject | null;
  team_size_min: number;
  team_size_max: number;
  substitutes_max: number;
  checkin_opens_at: Rfc3339 | null;
  checkin_closes_at: Rfc3339 | null;
  requires_checkin: boolean;
  requires_phone: boolean;
  allow_guest_registration: boolean;
  requires_join_code: boolean;
  /** Game defaults, overridden per tournament. The snapshot, not the live catalogue. */
  registration_schema: FieldDef[];
  organizers: TournamentOrganizerRef[];
  contact: TournamentContact | null;
  stream_url: string | null;
  results_published_at: Rfc3339 | null;
  bracket_generated_at: Rfc3339 | null;
  cancelled_reason: string | null;
  created_at: Rfc3339;
  updated_at: Rfc3339;
}

/**
 * §1.5.1 — THE one call the tournament page makes on boot, so a phone on 4G
 * opening a WhatsApp link does one round-trip instead of five. Its `Poll-After`
 * is deliberately `0`: after boot the client polls the individual endpoints,
 * which have tighter ETags and much smaller 304s.
 */
export interface TournamentOverview {
  tournament: TournamentDetail;
  entrants: { data: PublicEntrant[]; page: PageInfo };
  /** `null` when no bracket exists. */
  bracket: BracketResponse | null;
  standings: StandingsResponse | null;
  /** Pinned plus the 5 most recent. */
  announcements: Announcement[];
}

/* =====================================================================
 * §1.6 Entrants
 * ===================================================================== */

export interface PublicEntrantMember {
  id: EntrantMemberId;
  display_name: string;
  handle: string | null;
  role: EntrantMemberRole;
  is_substitute: boolean;
  /** Only fields whose `FieldDef.visibility` is `public`. */
  public_fields: FieldValues;
}

/**
 * The public, redacted entrant list. Never contains a phone number, an email, a
 * payment note or an organiser note.
 *
 * When `tournaments.entrants_public = 0` the endpoint returns `200` with
 * `data: []` and `meta.hidden: true` rather than a 403 — the list is simply not
 * published yet, which is a different fact from "you may not see it".
 */
export interface PublicEntrant {
  id: EntrantId;
  /** Team name, or the player's display name for a solo entry. A snapshot. */
  display_name: string;
  seed: number | null;
  status: EntrantStatus;
  checked_in_at: Rfc3339 | null;
  /** `null` for a team entry or a guest entry. */
  player: PlayerRef | null;
  is_guest: boolean;
  /** Present only for team entries. */
  members: PublicEntrantMember[] | null;
  public_fields: FieldValues;
  registered_at: Rfc3339;
}

export interface EntrantsMeta extends JsonObject {
  /** `tournaments.entrant_count`. */
  total: number;
  /** True when `entrants_public = 0`; `data` is then empty. */
  hidden: boolean;
}

/**
 * `PublicEntrant` plus everything the entrant themselves (or an organiser) may
 * see. Every `pii: true` `tel` value is MASKED to `+91 ••••• •<last4>` — the
 * mask is what is stored in `fields_json`, so this is free rather than a rule a
 * serializer can forget (SECURITY.md §10.2.1).
 *
 * There is deliberately NO `checkin_code` here. The only such column is
 * `tournaments.checkin_code`, a 4-digit code written on a board at the desk,
 * returned by exactly one endpoint (`GET /organizer/tournaments/:id`). Putting
 * it here would hand the venue code to everyone who registers, from anywhere in
 * the world, which destroys the only thing `checkin_requires_code` exists for.
 */
export interface PrivateEntrant extends PublicEntrant {
  /** All fields regardless of visibility, with every `pii: true` `tel` value masked. */
  fields: FieldValues;
  notes: string | null;
  payment_status: PaymentStatus;
  /** OMITTED for non-organizers. */
  payment_ref?: string | null;
  /** OMITTED for non-organizers. */
  organizer_note?: string | null;
  guest_phone_masked: string | null;
  /** Optimistic-concurrency token for `PATCH /entrants/:id`. */
  version: number;
  updated_at: Rfc3339;
}

/* =====================================================================
 * §1.7 The bracket — the hot endpoint
 * ===================================================================== */

/**
 * The wire projection of `matches.bracket`:
 * `W`→winners, `L`→losers, `GF`→grand_final, `RR`→groups, `SW`→swiss, `BR`→series.
 */
export type WireBracket = 'winners' | 'losers' | 'grand_final' | 'groups' | 'swiss' | 'series';

/**
 * Where a slot's occupant comes from, for rendering the empty box before the
 * feeder resolves. `ref` is the feeder match id, or a group reference like
 * `"A#2"`.
 */
export type WireSlotSourceKind = 'seed' | 'winner_of' | 'loser_of' | 'group' | 'bye';

export interface MatchSlotSource {
  kind: WireSlotSourceKind;
  ref: string | null;
}

/**
 * `slots[]` is a WIRE SHAPE, not a table. There is no `match_slots` table; do
 * not create one. It is projected so the frontend renders every format with one
 * component:
 *
 *   - head-to-head → exactly two slots, from the `_a` / `_b` columns.
 *   - points_lobby → one slot per `match_participants` row, ordered by
 *     `placement`, carrying `placement`, `kills` and the engine-computed
 *     `points` in place of `score`.
 */
export interface MatchSlot {
  position: number;
  /** `null` when the slot is not yet filled; `source` then says what to render. */
  entrant_id: EntrantId | null;
  score: number | null;
  bonus: number | null;
  is_winner: boolean;
  /** Chess colours. `slots[1].side` is the complement, computed by the Worker; there is no `side_b` column. */
  side: MatchSide | null;
  source: MatchSlotSource;
  /** points_lobby only. */
  placement?: number | null;
  kills?: number | null;
  points?: number | null;
}

export interface MatchUpdatedBy {
  handle: string;
  display_name: string;
}

export interface Match {
  id: MatchId;
  /** Stable human label, printable on a wall chart: 'W1M1', 'G1R3-2', 'GF2'. */
  code: string;
  round_index: number;
  /** Ordinal within the round; drives layout. */
  position: number;
  state: MatchStatus;
  best_of: number;
  /** True only for a double-elim GF2 that may never be played. */
  conditional: boolean;
  slots: MatchSlot[];
  winner_entrant_id: EntrantId | null;
  loser_entrant_id: EntrantId | null;
  is_draw: boolean;
  method: MatchMethod | null;
  /** `matches.result_detail_json`, opaque to the engine and to the API. */
  detail: JsonObject | null;
  scheduled_at: Rfc3339 | null;
  completed_at: Rfc3339 | null;
  venue: { id: VenueId; name: string } | null;
  /**
   * `null` on this route unless `publish_room_codes = 1` AND
   * `room_code_publish_at <= now`. A checked-in entrant gets the code from
   * `GET /me/registrations` instead — never from here, because a public
   * response must not vary by identity.
   */
  room_code: string | null;
  stream_url: string | null;
  /** The optimistic-concurrency token carried in a score submission. */
  result_version: number;
  updated_at: Rfc3339;
  /** Joined from `matches.recorded_by`. There is no `matches.updated_by_user_id` column and never was. */
  updated_by: MatchUpdatedBy | null;
}

/** A match as returned by the flat list (§1.8) and `/live` — entrants inlined. */
export interface MatchWithEntrants extends Match {
  entrants: BracketEntrant[];
}

/** Entrants are listed ONCE and referenced by id from slots; on a 128-player double-elim that halves the payload. */
export interface BracketEntrant {
  id: EntrantId;
  display_name: string;
  seed: number | null;
  handle: string | null;
  status: EntrantStatus;
  is_guest: boolean;
  eliminated: boolean;
  placement: number | null;
}

export interface BracketRound {
  index: number;
  name: string;
  stage_id: StageId;
  bracket: WireBracket;
  best_of: number;
  scheduled_at: Rfc3339 | null;
  matches: Match[];
}

/** Present for round_robin / points_lobby / a group stage. */
export interface BracketGroup {
  key: string;
  name: string;
  entrant_ids: EntrantId[];
  advance_count: number | null;
  match_ids: MatchId[];
}

export interface BracketTournamentHeader {
  id: TournamentId;
  slug: string;
  title: string;
  format: TournamentFormat;
  status: TournamentStatus;
  state_version: number;
  scoring_model: ScoringModel;
  supports_draws: boolean;
  results_published_at: Rfc3339 | null;
}

/**
 * A tournament with no bracket yet is `200` with `rounds: []` and
 * `generated_at: null` — NOT a 404. The tournament exists and the page must
 * render "Bracket not published yet"; a 404 would put the SPA in a
 * broken-page state.
 */
export interface BracketResponse {
  tournament: BracketTournamentHeader;
  entrants: BracketEntrant[];
  rounds: BracketRound[];
  groups: BracketGroup[] | null;
  /** Always present; length 1 for a single-stage tournament. */
  stages: StageSummary[];
  third_place_match: Match | null;
  final_match_id: MatchId | null;
  generated_at: Rfc3339 | null;
}

export interface BracketMeta extends JsonObject {
  /** True when the `LIMIT 1024` bit. The SPA then points at the paginated fixtures list rather than rendering a silently short bracket. */
  truncated: boolean;
}

/* =====================================================================
 * §1.9 Standings
 * ===================================================================== */

/**
 * `ratio_milli` values (`set_ratio`, `net_run_rate`) are stored ×1000 as
 * integers and MAY be negative; the client divides by 1000 for display. There
 * are no fractional numbers on this wire.
 */
export type StandingsColumnType = 'int' | 'entrant' | 'ratio_milli';

export interface StandingsColumn {
  key: string;
  label: string;
  type: StandingsColumnType;
  /** The column the table sorts on and emphasises. */
  primary?: boolean;
  /** Present on `points` when `stages.points_divisor > 1` (chess: 2). The client renders `points / divisor`; the server never formats it. */
  divisor?: number;
}

export interface StandingsEntrantRef {
  id: EntrantId;
  display_name: string;
  handle: string | null;
  seed: number | null;
}

/**
 * The `columns` array is what keeps standings game-agnostic: the frontend
 * renders whatever the scoring engine emits, in order, and knows nothing about
 * kills or wickets. A new game ships new columns as data, so the shape of a row
 * is only knowable at runtime — hence the index signature.
 */
export interface StandingsRow {
  rank: number;
  entrant: StandingsEntrantRef;
  /** Human sentence explaining why this row sits where it does. */
  tiebreak_note: string | null;
  status: StageEntrantStatus;
  qualified: boolean;
  group: string | null;
  [column: string]:
    | number
    | string
    | boolean
    | null
    | StandingsEntrantRef
    | undefined;
}

export interface StandingsResponse {
  columns: StandingsColumn[];
  rows: StandingsRow[];
  /** `null` when the format has no groups. */
  groups: { key: string; name: string }[] | null;
  /** Always present; length 1 for a single-stage event. */
  stages: StageSummary[];
  is_final: boolean;
  computed_at: Rfc3339;
}

export interface StandingsMeta extends JsonObject {
  /** The stage this response actually answers for, after the default-stage resolution of §1.9. */
  stage: { id: StageId; ordinal: number; name: string; format: StageFormat };
}

/* =====================================================================
 * §1.10 / §1.11 Announcements
 * ===================================================================== */

export interface Announcement {
  id: string;
  scope: AnnouncementScope;
  /** `null` for club scope. */
  tournament: TournamentRef | null;
  title: string;
  body_ast: RichText;
  pinned: boolean;
  severity: AnnouncementSeverity;
  published_at: Rfc3339;
  author: PlayerRef | null;
}

/* =====================================================================
 * §1.12 Leaderboard
 * ===================================================================== */

/** `rating` returns `501 not_implemented` in v1 (API.md §1.12.2). */
export type LeaderboardMetric = 'points' | 'wins' | 'titles' | 'rating';

export interface LeaderboardRow {
  /** Dense-ranked; ties share a rank. */
  rank: number;
  player: PlayerRef;
  points: number;
  /** Always `null` in v1 — nothing writes `player_ratings`. */
  rating: number | null;
  tournaments_played: number;
  /** Match wins. */
  wins: number;
  titles: number;
  best_finish: number | null;
  last_played_at: Rfc3339 | null;
  /** Change in rank since the previous recompute (positive = moved up), or null if unknown. */
  trend: number | null;
}

export interface LeaderboardMeta extends JsonObject {
  game: string;
  period: LeaderboardPeriod;
  metric: LeaderboardMetric;
  computed_at: Rfc3339;
}

/* =====================================================================
 * §1.13 Player profile
 * ===================================================================== */

export interface PlayerGameStats {
  slug: string;
  name: string;
  tournaments_played: number;
  wins: number;
  titles: number;
  /** Always `null` in v1; the client omits the column rather than showing "1500 (provisional)" for everyone. */
  rating: number | null;
}

export interface PlayerResult {
  tournament: TournamentRef;
  placement: number | null;
  entrant_display_name: string;
  completed_at: Rfc3339 | null;
}

export interface PlayerLeaderboardEntry {
  game: string | null;
  period: LeaderboardPeriod;
  rank: number;
  points: number;
}

/**
 * Never contains a phone number, an email, a real name the user did not put in
 * `display_name`, or an entrant status in a non-public tournament. `404` for an
 * unknown handle, a deleted account, or `profile_public = 0`.
 */
export interface PlayerProfile {
  handle: string;
  display_name: string;
  /** Plain text, ≤ 200 chars, never markdown. */
  bio: string | null;
  avatar_seed: string | null;
  city: string;
  member_since: Rfc3339;
  games: PlayerGameStats[];
  recent_results: PlayerResult[];
  leaderboard: PlayerLeaderboardEntry[];
}

/* =====================================================================
 * §1.14 / §1.15 Club and venues
 * ===================================================================== */

/**
 * Club identity, contact, about text and socials, editable by an admin so the
 * owner does not need a deploy to change a phone number. The precise shape is
 * `content/club.json` and is owned by `lib/content/club.ts`; on the wire it is a
 * passthrough, which is why it is typed structurally rather than field by field.
 */
export type ClubResponse = JsonObject;

export interface Venue {
  id: VenueId;
  name: string;
  area: string | null;
  address: string | null;
  maps_url: string | null;
  online: boolean;
  capacity: number | null;
  active: boolean;
}

/* =====================================================================
 * §1.16 Live, §1.16.1 Search, §1.5.2 handle availability
 * ===================================================================== */

/** A live match carries its tournament, because the page spans all of them. */
export interface LiveMatch extends MatchWithEntrants {
  tournament: TournamentRef;
}

export interface LiveResponse {
  tournaments: TournamentCard[];
  /** Across ALL live tournaments, capped at 50. */
  matches: LiveMatch[];
}

export interface LiveMeta extends JsonObject {
  match_count: number;
  truncated: boolean;
}

export interface SearchTournamentHit {
  slug: string;
  title: string;
  status: TournamentStatus;
  game: { slug: string; name: string };
  starts_at: Rfc3339;
}

/**
 * Players are matched on a HANDLE PREFIX only, never on `display_name`, and only
 * where `profile_public = 1`. A substring search over display names is a
 * member-directory scrape with extra steps.
 */
export interface SearchResponse {
  tournaments: SearchTournamentHit[];
  players: PlayerRef[];
  games: { slug: string; name: string; category: GameCategory }[];
}

export type HandleUnavailableReason = 'taken' | 'reserved' | 'invalid' | 'held';

export interface HandleAvailability {
  handle: string;
  available: boolean;
  reason: HandleUnavailableReason | null;
}

/* =====================================================================
 * §2.1 Auth session
 * ===================================================================== */

export interface SessionUser {
  id: UserId;
  handle: string;
  display_name: string;
  role: UserRole;
  avatar_seed: string | null;
  has_phone: boolean;
  phone_last4: string | null;
  email_verified: boolean;
  profile_public: boolean;
  recovery_codes_remaining: number;
  credential_count: number;
}

export interface SessionInfo {
  id: SessionId;
  scope: SessionScope;
  uv: boolean;
  auth_at: Rfc3339;
  idle_expires_at: Rfc3339;
  absolute_expires_at: Rfc3339;
}

export interface AuthSessionAuthenticated {
  authenticated: true;
  /** Send as `X-CSRF-Token` on every mutation. Held in memory by the SPA; deliberately not a cookie. */
  csrf_token: string;
  user: SessionUser;
  session: SessionInfo;
  /** Tournament ids where this user is owner or co-organizer; `null` above 200, and the client then uses `/organizer/tournaments`. */
  organizer_of: TournamentId[] | null;
}

/**
 * Anonymous is a **200, not a 401**. A 401 here would make every page load log a
 * client-side error and would make "am I signed in?" indistinguishable from a
 * real failure.
 */
export interface AuthSessionAnonymous {
  authenticated: false;
  csrf_token: null;
  user: null;
  session: null;
}

export type AuthSession = AuthSessionAuthenticated | AuthSessionAnonymous;

/* =====================================================================
 * §3 Player API
 * ===================================================================== */

/** `GET /me`. The phone is MASKED; the plaintext is never sent back to a client. */
export interface MeProfile extends SessionUser {
  email: string | null;
  /** `+91 ••••• •4417`, or null. SECURITY.md §10.2. */
  phone_masked: string | null;
  city: string;
  bio: string | null;
  notify_whatsapp: boolean;
  created_at: Rfc3339;
}

export type MyRegistrationRole = 'owner' | 'captain' | 'member';

/**
 * `next_match` is the caller's next `ready` or `live` match, and it is the ONLY
 * place a room code reaches a squad (API.md §3.9.1): it carries `room_code` and
 * `room_password` iff the caller is a participant, the entrant is
 * `checked_in`, and `room_code_publish_at` has passed. Both fields are
 * present-but-null otherwise, so the client never branches on absence.
 */
export interface MyNextMatch extends Match {
  tournament: TournamentRef;
  room_password: string | null;
}

export interface MyRegistration {
  entrant: PrivateEntrant;
  tournament: TournamentCard;
  my_role: MyRegistrationRole;
  next_match: MyNextMatch | null;
}

/* =====================================================================
 * Polling — API.md §8.4
 * ===================================================================== */

/**
 * The server-supplied cadence, read from the `Poll-After` response header
 * (integer seconds). `components/data/usePoller.ts` jitters it by
 * [0.85, 1.15], multiplies by 1.5 on each consecutive 304 up to a 120 s cap,
 * floors at 5 s, gates on visibility, honours `Retry-After` on a 429 and stops
 * entirely on `saveData` or a 2g connection.
 *
 * `0` means "do not poll this endpoint" — `/overview` says it about itself.
 */
export type PollAfterSeconds = number;

/** Response headers the client reads on every request. API.md §0.10. */
export interface ApiResponseMeta {
  requestId: string | null;
  /** Server epoch SECONDS. `skew = nowSeconds - Date.now()/1000`; if `|skew| > 120` the UI says so. */
  ncNow: number | null;
  etag: string | null;
  pollAfter: PollAfterSeconds | null;
  /** True when the response was replayed from the idempotency store. */
  idempotentReplay: boolean;
}
