/**
 * Row types for every table in `db/schema.sql`, hand-derived and exact.
 *
 * `db/schema.sql` is the source of truth and it beats this file: it is the only
 * artifact with enforced constraints and the only one `wrangler d1 execute`
 * runs. These interfaces exist so that a `SELECT *` has a shape at compile time,
 * not so that anyone reads them instead of the DDL.
 *
 * Conventions carried over from the schema, all load bearing:
 *
 *   - Timestamps are `number`, **unix seconds, UTC**, column suffix `_at`.
 *     Never milliseconds; ARCHITECTURE.md §5.1 row 9 settled that. The wire
 *     format is RFC 3339 `…Z` (see `./api`), and conversion happens at exactly
 *     one boundary: the serializer.
 *   - Money is `number` **paise**, suffix `_paise`. 20000 is ₹200.
 *   - Booleans are `Bool` (`0 | 1`), because STRICT SQLite has no BOOLEAN type.
 *     Typing them `boolean` would compile and then write `'true'` into an
 *     INTEGER column, which STRICT rejects at runtime, inside a batch, rolling
 *     back a score write.
 *   - `_json` columns are the raw `string` as stored. Parsing is the caller's
 *     job precisely because the parsed shape differs per row (a game's
 *     `scoring_config_json` is not a stage's).
 *   - BLOB columns are `ArrayBuffer` — D1 round-trips them natively, and
 *     base64-in-TEXT would break `crypto.subtle.importKey`.
 *   - There are **no REAL columns anywhere**. Scores, points and rational
 *     tiebreaks are integers; chess half-points are 2/1/0 with
 *     `stages.points_divisor = 2`. Float equality in a standings sort is how
 *     "these two are tied" quietly becomes "not tied" on a projector.
 *
 * Nullability here mirrors the DDL exactly. A column that is `NOT NULL` in the
 * schema is non-optional here; everything else is `| null`. `undefined` never
 * appears: D1 returns `null`, not `undefined`, for a NULL column, and a type
 * that admits both makes every guard wrong somewhere.
 */

/* =====================================================================
 * Scalars
 * ===================================================================== */

/** INTEGER 0/1 with a CHECK. STRICT tables forbid a BOOLEAN type. */
export type Bool = 0 | 1;

/** INTEGER, unix seconds, UTC. */
export type UnixSeconds = number;

/** INTEGER paise. 1 INR = 100 paise. */
export type Paise = number;

/**
 * A prefixed ULID: `<3-char prefix>_<26-char Crockford base32>`, exactly 30
 * characters, enforced per table with `CHECK (id GLOB 'xxx_*' AND length(id) = 30)`.
 * The template type is a documentation aid, not a validator — `worker/lib/ids.ts`
 * is where a string actually becomes trustworthy.
 */
export type PrefixedId<P extends string = string> = `${P}_${string}`;

export type UserId = PrefixedId<'usr'>;
export type SessionId = PrefixedId<'ses'>;
export type CredentialId = PrefixedId<'crd'>;
export type RecoveryCodeId = PrefixedId<'rec'>;
export type EmailOtpId = PrefixedId<'otp'>;
export type GameId = PrefixedId<'gam'>;
export type SeasonId = PrefixedId<'sea'>;
export type VenueId = PrefixedId<'ven'>;
export type TournamentId = PrefixedId<'trn'>;
export type StageId = PrefixedId<'stg'>;
export type EntrantId = PrefixedId<'ent'>;
export type EntrantMemberId = PrefixedId<'mem'>;
export type MatchId = PrefixedId<'mat'>;
export type MatchAuditId = PrefixedId<'mad'>;
export type PointsLedgerId = PrefixedId<'led'>;
export type AuditLogId = PrefixedId<'aud'>;
export type AnnouncementId = PrefixedId<'ann'>;
export type InviteId = PrefixedId<'inv'>;

/* =====================================================================
 * Closed enums — ARCHITECTURE.md §6.6.
 *
 * Every one of these is a `TEXT + CHECK(col IN (...))` in the schema. Adding a
 * value here without adding it to the CHECK produces a runtime constraint
 * failure inside a batch; adding it to the CHECK without adding it here
 * produces a silent `never` branch. Change both, in the same commit.
 * ===================================================================== */

export type UserRole = 'player' | 'organizer' | 'admin';

/**
 * THE moderation gate. The session predicate `S` requires `status = 'active'`
 * (AUTH.md §7.2). `users.suspended_until` is only the auto-lift timestamp: NULL
 * means "never auto-lift", i.e. indefinite, and must NOT be read as
 * "not suspended".
 */
export type UserStatus = 'active' | 'suspended' | 'banned' | 'deleted';

/**
 * A `recovery` session may enrol a credential without `uv = 1` (AUTH.md
 * §7.3.1) — it is the redeemed code that authenticates. Everything else 403s
 * with `recovery_scope_only`.
 */
export type SessionScope = 'full' | 'recovery';

export type AuthMethod = 'passkey' | 'recovery' | 'email' | 'bootstrap';

export type SessionRevokedReason =
  | 'logout'
  | 'logout_all'
  | 'admin_revoke'
  | 'rotation'
  | 'recovery_used'
  | 'expired'
  | 'ban';

/**
 * Read by the predicates, not decorative. AUTH.md §7.2 defines `ORG_OF` (any
 * non-revoked staff row), `FULLORG_OF` (`owner`|`organizer` only — contact
 * lookups, contact CSV, payment fields, publish, reopen) and `OWNER_OF`. Every
 * one of them also requires `revoked_at IS NULL`.
 */
export type TournamentOrganizerRole = 'owner' | 'organizer' | 'scorer' | 'moderator';

export type WebauthnChallengePurpose = 'register' | 'login';

export type WebauthnChallengeIntent =
  | 'signup'
  | 'add_credential'
  | 'reauth'
  | 'bootstrap_admin'
  | 'recovery_enrol';

export type WebauthnDeviceType = 'singleDevice' | 'multiDevice';

export type EmailOtpPurpose = 'login' | 'verify_email' | 'recover';

export type GameCategory = 'esport' | 'board' | 'outdoor';

/**
 * The SCORING MODEL — a different axis from the tournament FORMAT. `br_points`
 * is a scoring model; `points_lobby` is a format. BGMI is both.
 */
export type ScoringModel = 'h2h_simple' | 'h2h_sets' | 'h2h_innings' | 'br_points' | 'manual';

/** `tournaments.format`. Headline shape for cards and filters; `stages` is the authority. */
export type TournamentFormat =
  | 'single_elim'
  | 'double_elim'
  | 'round_robin'
  | 'swiss'
  | 'points_lobby'
  | 'multi_stage';

/** `stages.format`. There is no `multi_stage` here — multi-stage IS two stages. */
export type StageFormat = 'single_elim' | 'double_elim' | 'round_robin' | 'swiss' | 'points_lobby';

export type ParticipantType = 'solo' | 'team';

export type VenueMode = 'online' | 'onsite' | 'hybrid';

export type TournamentStatus =
  | 'draft'
  | 'published'
  | 'registration_open'
  | 'registration_closed'
  | 'check_in'
  | 'live'
  | 'completed'
  | 'cancelled'
  | 'archived';

export type TournamentVisibility = 'public' | 'unlisted' | 'private';

/** `recomputing` exists for the chunked correction path (BRACKET-ENGINE.md §14.4). */
export type StageStatus =
  | 'pending'
  | 'seeding'
  | 'live'
  | 'recomputing'
  | 'completed'
  | 'cancelled';

/** The engine's `active` means "not `withdrawn` and not `disqualified`". */
export type EntrantStatus =
  | 'pending'
  | 'confirmed'
  | 'waitlisted'
  | 'checked_in'
  | 'withdrawn'
  | 'disqualified'
  | 'no_show';

export type PaymentStatus =
  | 'not_required'
  | 'pending'
  | 'submitted'
  | 'paid'
  | 'refunded'
  | 'waived';

export type PaymentMethod = 'upi' | 'cash' | 'waived';

export type PaymentMode = 'free' | 'upi_manual' | 'at_venue';

export type EntrantOrigin = 'self' | 'guest_self' | 'organizer';

export type EntrantMemberRole = 'captain' | 'player' | 'substitute' | 'coach' | 'manager';

export type EntrantMemberStatus = 'active' | 'removed';

export type StageEntrantStatus =
  | 'active'
  | 'eliminated'
  | 'advanced'
  | 'withdrawn'
  | 'disqualified';

/** Storage form. The wire projection is in `./api` (`winners`, `losers`, …). */
export type MatchBracket = 'W' | 'L' | 'GF' | 'RR' | 'SW' | 'BR';

/**
 * Exactly the six the resolve fold produces. `disputed` was dropped
 * (ARCHITECTURE.md §5.1 row 5): a seventh value the engine never emits would be
 * written by hand and immediately overwritten by the next recompute. A dispute
 * is an organiser act (reopen + a public `reason`), not a match state.
 */
export type MatchStatus = 'pending' | 'ready' | 'live' | 'complete' | 'bye' | 'void';

/**
 * What happened. Retirement is `forfeit` plus the score at retirement; a double
 * forfeit and an abandonment are both `no_contest`.
 */
export type MatchMethod = 'normal' | 'walkover' | 'forfeit' | 'dq' | 'no_contest';

/** Chess colours only. NULL for every other game. */
export type MatchSide = 'W' | 'B';

export type SlotSourceKind = 'entrant' | 'winner' | 'loser' | 'none';

export type MatchParticipantStatus = 'registered' | 'played' | 'no_show' | 'disqualified';

/** `tournaments.seeding_method`. `rating` is refused by the API in v1 (API.md §1.12.2). */
export type SeedingMethod = 'registration' | 'random' | 'manual' | 'rating';

/** `stages.seed_source` — the tournament set plus `previous_stage`. */
export type StageSeedSource = 'registration' | 'random' | 'manual' | 'rating' | 'previous_stage';

export type AnnouncementScope = 'club' | 'tournament';

export type AnnouncementSeverity = 'info' | 'important' | 'urgent';

export type PointsLedgerReason = 'placement' | 'participation' | 'bonus' | 'penalty' | 'adjustment';

export type MatchAuditKind =
  | 'result_set'
  | 'result_corrected'
  | 'result_cleared'
  | 'status_forced';

export type AuditEntityType =
  | 'tournament'
  | 'stage'
  | 'entrant'
  | 'entrant_member'
  | 'match'
  | 'match_participant'
  | 'standings'
  | 'user'
  | 'game'
  | 'venue'
  | 'session'
  | 'credential'
  | 'points_ledger'
  | 'announcement'
  | 'season'
  | 'invite'
  | 'setting';

/** `all_time` or `season:<season_slug>`. Nothing else in v1. */
export type LeaderboardPeriod = 'all_time' | `season:${string}`;

/**
 * The snake_case tokens `content/games.json` and `stages.tiebreakers_json`
 * author. The engine's camelCase `TiebreakKey` and the ONE map between them are
 * BRACKET-ENGINE.md §4.2. An unknown token is `E_INVALID_OPTIONS`, never a
 * silently dropped comparator — a dropped comparator produces a wrong table
 * that looks right and decides who qualifies.
 *
 * Every chain terminates in `seed`; the engine appends it unconditionally, so
 * nothing is ever decided by a coin flip.
 */
export type TiebreakToken =
  | 'points'
  | 'wins'
  | 'fewest_losses'
  | 'played'
  | 'head_to_head'
  | 'score_diff'
  | 'score_for'
  | 'set_ratio'
  | 'net_run_rate'
  | 'kills'
  | 'best_placement'
  | 'buchholz'
  | 'buchholz_cut1'
  | 'sonneborn_berger'
  | 'seed';

export type InviteKind = 'join' | 'roster';

export type InviteMode = 'single_use' | 'shared';

/* =====================================================================
 * 0. Meta
 * ===================================================================== */

export interface SchemaMetaRow {
  key: string;
  value: string;
  updated_at: UnixSeconds;
}

/**
 * Free-form runtime config plus the cache-validator counters. Lives in the
 * database so the owner can change the UPI VPA or the WhatsApp number without a
 * deploy, and so a new knob never costs a migration.
 *
 * Version keys (`version.games`, `version.listing`, `version.club`,
 * `version.club_announcements`, `version.leaderboard`) are integers bumped in
 * the same batch as the mutation; they are the ETag validators for resources
 * with no single owning row.
 */
export interface SettingRow {
  key: string;
  value_json: string;
  updated_at: UnixSeconds;
  updated_by: string | null;
}

/* =====================================================================
 * 1. Identity
 * ===================================================================== */

export interface UserRow {
  id: UserId;
  /** Public URL segment `/p/<handle>`. Wire regex `^[a-z0-9][a-z0-9_]{2,19}$`. */
  handle: string;
  handle_changed_at: UnixSeconds | null;
  display_name: string;
  /** Deterministic identicon seed. There are no avatar uploads in v1. */
  avatar_seed: string | null;
  bio: string | null;
  city: string;
  /**
   * base64url of 32 random bytes. Never the id and never derived from the
   * handle — it must not leak identity to a relying party that is not us.
   */
  webauthn_user_id: string;
  email: string | null;
  email_verified: Bool;
  /** AES-GCM ciphertext under PII_KEY, AAD = this row's id. */
  phone_enc: ArrayBuffer | null;
  /** HMAC(PHONE_INDEX_KEY, e164) — a blind index, so "already registered?" needs no decrypt. */
  phone_hash: string | null;
  phone_last4: string | null;
  notify_whatsapp: Bool;
  is_adult: Bool;
  role: UserRole;
  status: UserStatus;
  suspended_until: UnixSeconds | null;
  moderation_reason: string | null;
  profile_public: Bool;
  profile_version: number;
  /** Bumping this one integer invalidates every session with no scan. */
  session_epoch: number;
  recovery_fail_count: number;
  recovery_locked_until: UnixSeconds | null;
  /**
   * Remembered answers keyed by `FieldDef.profile_key`, NOT by game slug. Sent
   * to the CLIENT on every form render, so a `pii: true` `tel` value is stored
   * MASKED here; the canonical number is `phone_enc`.
   */
  profile_answers_json: string | null;
  deletion_requested_at: UnixSeconds | null;
  created_at: UnixSeconds;
  updated_at: UnixSeconds;
  last_seen_at: UnixSeconds | null;
  deleted_at: UnixSeconds | null;
}

/**
 * A released handle is parked for 90 days so a rename cannot be used to
 * impersonate someone whose old links are still circulating on WhatsApp.
 */
export interface HandleReservationRow {
  handle: string;
  user_id: UserId | null;
  reserved_at: UnixSeconds;
  released_at: UnixSeconds;
}

export interface WebauthnCredentialRow {
  id: CredentialId;
  user_id: UserId;
  /** base64url of the raw authenticator credential id. Globally unique. */
  credential_id: string;
  /** Raw COSE_Key bytes. BLOB because `importKey` wants an ArrayBuffer. */
  public_key: ArrayBuffer;
  /** COSE algorithm id. -7 = ES256 (every phone), -257 = RS256 (Windows Hello). */
  algorithm: number;
  /** Many phone authenticators always report 0; a DECREASE is the clone signal, not a non-increase. */
  counter: number;
  transports_json: string | null;
  aaguid: string | null;
  /**
   * `backup_eligible = 1 && backup_state = 1` means the passkey is synced to
   * iCloud/Google — losing the phone is NOT account loss, and the UI should say
   * so instead of nagging about recovery codes.
   */
  backup_eligible: Bool;
  backup_state: Bool;
  device_type: WebauthnDeviceType | null;
  is_discoverable: Bool;
  label: string;
  created_at: UnixSeconds;
  last_used_at: UnixSeconds | null;
  revoked_at: UnixSeconds | null;
  revoked_reason: string | null;
}

export interface RecoveryCodeRow {
  id: RecoveryCodeId;
  user_id: UserId;
  batch_id: string;
  /** hex HMAC-SHA256(RECOVERY_PEPPER, user_id || ':' || code). Deterministic, so verification is ONE indexed lookup. */
  code_hash: string;
  created_at: UnixSeconds;
  used_at: UnixSeconds | null;
  used_ip_hash: string | null;
  superseded_at: UnixSeconds | null;
}

export interface SessionRow {
  id: SessionId;
  user_id: UserId;
  /** hex HMAC-SHA256(SESSION_PEPPER, id || ':' || secret). A dumped D1 snapshot cannot be replayed as a login. */
  token_hash: string;
  /** Returned only by `GET /api/v1/auth/session`; deliberately NOT a cookie (AUTH.md §5.7). */
  csrf_token: string;
  /** Must equal `users.session_epoch` or the session is dead. */
  epoch: number;
  role_snapshot: UserRole;
  scope: SessionScope;
  /** Did the last ceremony perform user verification (biometric/PIN)? */
  uv: Bool;
  auth_method: AuthMethod;
  credential_id: CredentialId | null;
  created_at: UnixSeconds;
  /** Last completed authentication ceremony. Drives step-up; never touched by ordinary activity. */
  auth_at: UnixSeconds;
  last_seen_at: UnixSeconds;
  idle_expires_at: UnixSeconds;
  absolute_expires_at: UnixSeconds;
  revoked_at: UnixSeconds | null;
  revoked_reason: SessionRevokedReason | null;
  /** HMAC(IP_HASH_KEY, ip). The raw address is never stored. */
  ip_hash: string | null;
  ip_city: string | null;
  ua_summary: string | null;
}

/**
 * Server-side so single-use is actually enforceable:
 * `UPDATE … WHERE consumed_at IS NULL`, then check `meta.changes === 1`.
 */
export interface WebauthnChallengeRow {
  /** base64url, 32 random bytes. Not a ULID. */
  challenge: string;
  purpose: WebauthnChallengePurpose;
  intent: WebauthnChallengeIntent | null;
  /** NULL for usernameless login. */
  user_id: UserId | null;
  pending_handle: string | null;
  pending_display: string | null;
  webauthn_user_id: string | null;
  ip_hash: string;
  created_at: UnixSeconds;
  /** `created_at + 120`. */
  expires_at: UnixSeconds;
  consumed_at: UnixSeconds | null;
}

export interface EmailOtpRow {
  id: EmailOtpId;
  email: string;
  /** hex HMAC-SHA256(OTP_PEPPER, email || ':' || code). */
  code_hash: string;
  purpose: EmailOtpPurpose;
  user_id: UserId | null;
  attempts: number;
  max_attempts: number;
  ip_hash: string;
  created_at: UnixSeconds;
  expires_at: UnixSeconds;
  consumed_at: UnixSeconds | null;
}

/* =====================================================================
 * 2. The game catalogue
 * ===================================================================== */

/**
 * A TEMPLATE OF DEFAULTS, never the authority. Every `default_*` column is
 * copied into the tournament at creation and the tournament copy is what the
 * engine reads — which is what makes "carrom singles" and "carrom doubles" one
 * row, and what stops a catalogue edit in 2027 rewriting a 2026 tournament.
 */
export interface GameRow {
  id: GameId;
  slug: string;
  name: string;
  /** For bracket chips and mobile nav. */
  short_name: string;
  category: GameCategory;
  /** Free-text sub-bucket ('battle_royale', 'racket', …). Deliberately NOT a CHECK: a new sub-genre must not need a migration. */
  subcategory: string | null;

  default_participant_type: ParticipantType;
  default_team_size_min: number;
  default_team_size_max: number;
  default_substitutes_max: number;
  /** Does the game also have a legitimate doubles/pairs form? Informational only. */
  supports_pairs: Bool;

  scoring_model: ScoringModel;
  /** One unit inside a match: 'set', 'game', 'board', 'map', 'inning', 'round'. */
  unit_label: string;
  /** The match-level score: 'points', 'runs', 'goals', 'sets', 'maps'. */
  score_label: string;
  supports_draw: Bool;
  /** A game won on the LOWEST score (golf). Without it the engine infers the wrong winner. */
  higher_score_wins: Bool;

  default_format: StageFormat;
  default_best_of: number;
  /** 1 = the create wizard proposes TWO stages. Never a sixth format value. */
  default_multi_stage: Bool;

  default_venue_mode: VenueMode;
  needs_room_code: Bool;
  needs_ingame_id: Bool;
  ingame_id_label: string | null;
  /** JS-safe anchored regex, validated in the Worker before it is ever run. */
  ingame_id_pattern: string | null;
  /** points_lobby only: entrants per lobby (BGMI 16/25). */
  default_lobby_size: number | null;

  /** `FieldDef[]` (CONTENT.md §3), each tagged with a `scope` of 'entrant' or 'member'. */
  registration_fields_json: string | null;
  /** `scoring.params` plus every key this table has no column for. Read by slug, one row at a time; never in a WHERE clause. */
  scoring_config_json: string | null;
  /** Ordered `TiebreakToken[]`, most significant first. */
  default_tiebreakers_json: string | null;

  has_rating: Bool;
  rating_kinds_json: string | null;

  blurb: string | null;
  /** v1 renders a category glyph + accent + short_name. There is no icon sprite and no per-game raster (DESIGN.md §7). */
  icon_url: string | null;
  accent_hex: string | null;
  rules_url: string | null;

  sort_order: number;
  is_active: Bool;
  version: number;
  created_at: UnixSeconds;
  updated_at: UnixSeconds;
}

/* =====================================================================
 * 3. Seasons
 * ===================================================================== */

/**
 * Exactly one row has `is_active = 1` (`ux_seasons_active`), and it is the
 * NOT NULL parent of `points_ledger.season_id` — so `publish` refuses with
 * `409 no_active_season` if there is none.
 */
export interface SeasonRow {
  id: SeasonId;
  slug: string;
  name: string;
  starts_at: UnixSeconds;
  ends_at: UnixSeconds;
  is_active: Bool;
  /** `{"placement":[...],"participation":5,"min_entrants":4}` */
  points_scheme_json: string;
  version: number;
  created_at: UnixSeconds;
  updated_at: UnixSeconds;
}

/* =====================================================================
 * 4. Venues
 * ===================================================================== */

export interface VenueRow {
  id: VenueId;
  name: string;
  /** 'Trunk Road', 'Magunta Layout'. */
  area: string | null;
  address: string | null;
  maps_url: string | null;
  is_online: Bool;
  capacity: number | null;
  is_active: Bool;
  sort_order: number;
  version: number;
  created_at: UnixSeconds;
  updated_at: UnixSeconds;
}

/* =====================================================================
 * 5. Tournaments
 * ===================================================================== */

export interface TournamentRow {
  id: TournamentId;
  /** Public URL `/t/<slug>`. Immutable once published. Wire regex `^[a-z0-9][a-z0-9-]{1,40}$`. */
  slug: string;

  game_id: GameId;
  season_id: SeasonId | null;
  owner_user_id: UserId;

  title: string;
  subtitle: string | null;
  /** ≤ 200 chars, used verbatim as the `og:description` base shared into WhatsApp. */
  summary: string | null;
  /** Markdown SOURCE, organiser-visible only. The public API serves the AST. */
  rules_md: string | null;
  rules_ast_json: string | null;
  description_md: string | null;
  description_ast_json: string | null;
  /** 'Rapid 15+10', 'Doubles', 'T20', 'Erangel only'. Free text on purpose. */
  variant_label: string | null;

  /** Headline format for cards and filters. The AUTHORITY is `stages`. */
  format: TournamentFormat;
  status: TournamentStatus;
  visibility: TournamentVisibility;

  participant_type: ParticipantType;
  team_size_min: number;
  team_size_max: number;
  substitutes_max: number;
  max_entrants: number | null;
  min_entrants: number;
  waitlist_enabled: Bool;
  requires_confirmation: Bool;
  requires_phone: Bool;
  min_account_age_hours: number;
  allow_guest_registration: Bool;
  requires_join_code: Bool;
  entrants_public: Bool;
  minors_allowed: Bool;

  registration_opens_at: UnixSeconds | null;
  registration_closes_at: UnixSeconds | null;
  requires_checkin: Bool;
  checkin_opens_at: UnixSeconds | null;
  checkin_closes_at: UnixSeconds | null;
  checkin_requires_code: Bool;
  /**
   * A 4-digit code written on a board at the desk. Returned by EXACTLY one
   * endpoint, `GET /api/v1/organizer/tournaments/:id`, and no other — handing it
   * to every entrant at registration destroys the only thing it exists for.
   */
  checkin_code: string | null;
  starts_at: UnixSeconds;
  ends_at: UnixSeconds | null;

  venue_mode: VenueMode;
  venue_id: VenueId | null;
  venue_name: string | null;
  venue_address: string | null;
  venue_city: string;
  venue_map_url: string | null;
  online_platform: string | null;

  currency: 'INR';
  entry_fee_paise: Paise;
  prize_pool_paise: Paise;
  /** `[{"position":1,"label":"Champion","amount_paise":800000,"extra":"Trophy"}]` */
  prizes_json: string | null;
  payment_mode: PaymentMode;
  /**
   * Overrides `settings['club.upi_vpa']`. The API MUST refuse
   * `entry_fee_paise > 0` while neither this nor the setting is set — otherwise
   * a player's ₹200 goes to a stranger.
   */
  upi_vpa: string | null;
  payment_note: string | null;

  seeding_method: SeedingMethod;
  rating_kind: string | null;
  /**
   * uint32, written once at creation from `crypto.getRandomValues`, IMMUTABLE.
   * Published after the draw so a randomised bracket is reproducible and
   * "the draw was rigged" has a verifiable answer.
   */
  bracket_seed: number;

  banner_image: string | null;
  og_image_url: string | null;
  /** WhatsApp caches OG images by URL, hard. Bump this and append `?v=<n>` to force a re-scrape. */
  og_image_version: number;
  is_featured: Bool;
  /** `{"whatsapp_group_url":"…","public_phone":null}` */
  contact_json: string | null;
  stream_url: string | null;

  /** The whole effective `FieldDef[]` for this event. Once written it is the authority. */
  registration_schema_json: string | null;
  format_config_json: string | null;
  scoring_config_json: string | null;
  /** The games row snapshot, so an organiser can be told "this ran on BGMI definition v3". */
  game_snapshot_json: string | null;

  /** 100 = normal. A marquee event can be 150; a casual scrim 0 (no points). */
  leaderboard_weight_pct: number;

  publish_room_codes: Bool;
  require_dual_confirm_final: Bool;

  /** Maintained in the SAME batch as the mutation that changes them. */
  entrant_count: number;
  confirmed_count: number;
  checked_in_count: number;
  waitlist_count: number;

  /** Set on completion. No FK by design. */
  champion_entrant_id: EntrantId | null;

  /** Optimistic lock for organiser edits of this row. */
  version: number;
  /**
   * Bumped by ANY mutation visible under `/api/v1/tournaments/<slug>/*` and used
   * as the HTTP ETag validator. Over-invalidation costs a wasted 15 KB;
   * under-invalidation puts a wrong score on a projector.
   */
  state_version: number;
  /** Optimistic lock for the whole-bracket recompute. Every bump also bumps `state_version`, in the same batch. */
  bracket_version: number;

  bracket_generated_at: UnixSeconds | null;
  published_at: UnixSeconds | null;
  results_published_at: UnixSeconds | null;
  completed_at: UnixSeconds | null;
  cancelled_reason: string | null;
  created_by: UserId | null;
  created_at: UnixSeconds;
  updated_at: UnixSeconds;
  deleted_at: UnixSeconds | null;
}

/**
 * Per-tournament staff grants. A volunteer who scores one carrom event must not
 * become a site-wide organiser: granting SCOPE here is owner-controlled,
 * granting the organizer ROLE (`users.role`) is admin-only.
 */
export interface TournamentOrganizerRow {
  tournament_id: TournamentId;
  user_id: UserId;
  role: TournamentOrganizerRole;
  added_by_user_id: UserId | null;
  added_at: UnixSeconds;
  revoked_at: UnixSeconds | null;
}

/**
 * Join codes (`/j/<code>/`) and roster invites (`/i/<code>/`). Alphabet
 * `23456789BCDFGHJKMNPQRSTVWXYZ` — no 0/O/1/I/L, no vowels — because the code is
 * read aloud in a noisy hall. `code_hash` is `HMAC(INVITE_PEPPER, code)` and the
 * UNIQUE on it is GLOBAL, so a lookup must always be scoped
 * `AND tournament_id = ?` or a code for one event opens another.
 */
export interface InviteRow {
  id: InviteId;
  tournament_id: TournamentId;
  kind: InviteKind;
  code_hash: string;
  label: string | null;
  mode: InviteMode;
  max_uses: number;
  used_count: number;
  /** Roster invites: which entrant it fills. */
  entrant_id: EntrantId | null;
  expires_at: UnixSeconds | null;
  revoked_at: UnixSeconds | null;
  created_by_user_id: UserId | null;
  created_at: UnixSeconds;
}

/** 301s after a rename, so an already-forwarded WhatsApp link never dies. */
export interface SlugRedirectRow {
  from_slug: string;
  to_slug: string;
  created_at: UnixSeconds;
}

/* =====================================================================
 * 6. Stages — the shape authority
 * ===================================================================== */

export interface StageRow {
  id: StageId;
  tournament_id: TournamentId;
  /** 1-based; stage 1 runs first. */
  ordinal: number;
  name: string;

  format: StageFormat;
  status: StageStatus;

  /** round_robin groups. */
  group_count: number;
  /** points_lobby: parallel lobbies. */
  lobby_count: number;
  /** points_lobby: entrants per lobby. */
  lobby_size: number | null;
  /** swiss: number of rounds; points_lobby: matches per lobby. */
  rounds_planned: number | null;
  best_of: number;
  /** elim: a longer final (Bo3 bracket, Bo5 final). */
  final_best_of: number | null;
  third_place_match: Bool;
  /** Validated `FormatOptions`. The engine reads THIS, not the columns above. */
  options_json: string | null;
  /** fnv1a of the canonical skeleton JSON. Checked ONLY on the generate path — never on recompute. */
  skeleton_hash: string | null;
  /**
   * The canonical Skeleton JSON exactly as `generateBracket()` returned it,
   * including `seedList`. Written ONCE and never rewritten; `resolveBracket`
   * LOADS it. Without it the skeleton is unrecoverable after the first
   * withdrawal, because `normalizeEntrants()` would produce a smaller bracket.
   */
  skeleton_json: string | null;

  seed_source: StageSeedSource;
  source_stage_id: StageId | null;
  /** Top N per group of the SOURCE stage qualify into this one. */
  advance_count: number | null;

  /** Integers only. Chess is 2/1/0 with `points_divisor = 2`, rendered 1/0.5/0. */
  points_win: number;
  points_draw: number;
  points_loss: number;
  points_bye: number;
  points_divisor: number;

  /** points_lobby placement table / kill value; overrides `games.scoring_config_json`. */
  scoring_config_json: string | null;
  /** Ordered `TiebreakToken[]`; defines what `standings.tiebreak_1..5` mean for THIS stage. */
  tiebreakers_json: string | null;

  entrant_count: number;
  rounds_completed: number;
  bracket_generated_at: UnixSeconds | null;
  starts_at: UnixSeconds | null;
  completed_at: UnixSeconds | null;
  created_at: UnixSeconds;
  updated_at: UnixSeconds;
}

/* =====================================================================
 * 7. Entrants
 * ===================================================================== */

/**
 * ONE table for all three shapes. Every registration is internally a team,
 * including a solo chess entry (a team of one), so the engine, standings and
 * leaderboard have zero solo/team branches. The difference is presentational.
 */
export interface EntrantRow {
  id: EntrantId;
  tournament_id: TournamentId;
  /** Human reference printed on the bracket and shouted across a hall: "#7". */
  entrant_no: number;

  /** A SNAPSHOT: the bracket renders 40 names without joining users, and a profile rename mid-event cannot rewrite a finished bracket. */
  display_name: string;
  /** ≤ 12 chars for narrow bracket cells. */
  short_name: string | null;
  team_tag: string | null;
  user_id: UserId | null;
  is_guest: Bool;
  origin: EntrantOrigin;

  /** HMAC(GUEST_PEPPER, token), scoped to exactly this entrant. */
  guest_token_hash: string | null;
  guest_revoked_at: UnixSeconds | null;
  guest_phone_enc: ArrayBuffer | null;
  guest_phone_last4: string | null;

  contact_email: string | null;
  /** Custom field values with scope 'entrant'. The public serializer emits only `visibility: 'public'` keys. */
  fields_json: string | null;

  /** The organiser's INPUT seed. The canonical dense 1..N is `stage_entrants.seed`. */
  seed: number | null;
  seed_locked: Bool;
  /** Snapshot of the club rating at registration. NULL in practice — nothing writes ratings in v1. */
  rating: number | null;
  /**
   * Optional organiser-forced round-robin group, 1-based. This is the engine's
   * `Entrant.groupHint` and it is an INPUT. `stage_entrants.group_no` is the
   * OUTPUT of snake assignment and must NEVER be fed back in as a hint.
   */
  group_hint: number | null;

  status: EntrantStatus;
  status_reason: string | null;
  /**
   * REQUIRED whenever status is 'withdrawn', 'disqualified' or 'no_show': the
   * engine needs the instant to decide which matches the entrant forfeits. A
   * no_show row with a NULL timestamp would make `stored.recordedAt < null`
   * evaluate false and retroactively forfeit an already-played match.
   */
  status_changed_at: UnixSeconds | null;
  dq_reason: string | null;

  checked_in_at: UnixSeconds | null;
  checked_in_by: UserId | null;
  guardian_consent: Bool;

  payment_status: PaymentStatus;
  paid_amount_paise: Paise;
  /** The 12-digit UPI UTR. Globally unique: one screenshot pasted by four people is the commonest fraud at this scale. */
  payment_ref: string | null;
  payment_method: PaymentMethod | null;
  paid_at: UnixSeconds | null;
  payment_verified_by: UserId | null;
  payment_verified_at: UnixSeconds | null;

  /** Final placement in the whole tournament, written when it completes. */
  placement: number | null;
  prize_paise: Paise;

  /** Never rendered publicly. */
  organizer_note: string | null;
  /** The entrant's own note to the organiser. */
  notes: string | null;
  registered_by: UserId | null;
  registered_at: UnixSeconds;
  version: number;
  created_at: UnixSeconds;
  updated_at: UnixSeconds;
}

/**
 * `tournament_id` is denormalised ONLY so the partial unique index
 * `ux_member_one_team` can exist — "one human, one team, per tournament" is the
 * single most abused rule in amateur esports, and denormalising turns it from a
 * code check into a database guarantee. The Worker must set it from
 * `entrants.tournament_id`.
 */
export interface EntrantMemberRow {
  id: EntrantMemberId;
  entrant_id: EntrantId;
  tournament_id: TournamentId;
  user_id: UserId | null;

  display_name: string;
  /** '5123456789' (BGMI), 'Vyshu#IN1' (Riot). */
  ingame_id: string | null;
  ingame_name: string | null;
  phone_enc: ArrayBuffer | null;
  phone_last4: string | null;
  slot_no: number;
  role: EntrantMemberRole;
  is_substitute: Bool;
  /** Custom field values with scope 'member'. */
  fields_json: string | null;
  status: EntrantMemberStatus;
  created_at: UnixSeconds;
  updated_at: UnixSeconds;
}

/**
 * Which entrants are in which stage. Without it, "standings of the group stage"
 * and "standings of the playoffs" are the same query and both are wrong.
 */
export interface StageEntrantRow {
  stage_id: StageId;
  entrant_id: EntrantId;
  tournament_id: TournamentId;
  /**
   * THE CANONICAL SEED: the dense 1..N order `normalizeEntrants()` produced at
   * generation time, copied from `Skeleton.seedList`. Written once and IMMUTABLE
   * — every tiebreak chain terminates in it, so drift makes standings order
   * irreproducible between two requests.
   */
  seed: number | null;
  /** DERIVED OUTPUT of snake assignment. Never read back as `Entrant.groupHint`. */
  group_no: number;
  lobby_no: number | null;
  source_stage_id: StageId | null;
  source_rank: number | null;
  status: StageEntrantStatus;
  created_at: UnixSeconds;
}

/* =====================================================================
 * 8. Matches
 * ===================================================================== */

/**
 * ONE table covers every format. Slots reference their SOURCE
 * (`a_source_kind` + `a_source_match_id`), never their destination: the engine
 * re-derives every participant by folding forwards over the skeleton, so
 * correcting a score two rounds back is the SAME code path as entering it.
 *
 * `entrant_a_id`, `entrant_b_id`, `status`, `winner_entrant_id` and
 * `loser_entrant_id` are DERIVED — a materialised view of the fold, written only
 * by the recompute diff.
 */
export interface MatchRow {
  id: MatchId;
  tournament_id: TournamentId;
  stage_id: StageId;
  /**
   * "Match 14". Unique per TOURNAMENT. The engine's `SkeletonMatch.number` is
   * stage-LOCAL, so the persistence adapter offsets it by the tournament's
   * current MAX — without that, stage 2 of a groups→playoff tournament collides
   * on `(tournament_id, 1)` after the group stage has already been played.
   */
  match_no: number;
  /** The engine's own MatchId: 'W2-3', 'L4-1', 'GF', 'GF2', 'G1R3-2', 'S4-7', 'P2-L3'. Unique within a stage. */
  code: string;
  /** Suggested chronological run order within the stage. */
  play_order: number;

  bracket: MatchBracket;
  round: number;
  /**
   * 0-based index within `(stage_id, bracket, round)` — STAGE-GLOBAL, not
   * group-local. For `bracket = 'BR'`, `position = lobby_no - 1`.
   */
  position: number;
  /** 'Quarter-final', 'Round 3', 'Lobby 2 — Match 3'. ASCII English. */
  round_label: string | null;
  round_label_key: string | null;
  group_no: number | null;
  lobby_no: number | null;
  slot_count: number;

  a_source_kind: SlotSourceKind;
  a_source_match_id: MatchId | null;
  a_source_entrant_id: EntrantId | null;
  b_source_kind: SlotSourceKind;
  b_source_match_id: MatchId | null;
  b_source_entrant_id: EntrantId | null;
  /** Swiss only: 1 when no legal non-rematch pairing existed for this board. Part of the hashed skeleton, so it must round-trip. */
  had_rematch: Bool;

  entrant_a_id: EntrantId | null;
  entrant_b_id: EntrantId | null;
  /** 'Winner of #12'. Derived at generation time so the public bracket needs no reverse lookup. */
  slot_a_label: string | null;
  slot_b_label: string | null;

  best_of: number;
  /** 1 only for a double-elimination bracket reset (GF2), which may never be played. */
  conditional: Bool;

  status: MatchStatus;
  winner_entrant_id: EntrantId | null;
  loser_entrant_id: EntrantId | null;
  is_draw: Bool;

  /** The canonical comparable number: runs, goals, maps won, sets won, points. Rich detail goes in `result_detail_json`. */
  score_a: number | null;
  score_b: number | null;
  bonus_a: number | null;
  bonus_b: number | null;
  bonus_note: string | null;
  side_a: MatchSide | null;

  /**
   * THE PARTICIPANTS AS RECORDED, written by the score endpoint at the instant
   * the result is stored and NEVER touched by the recompute diff. They are the
   * only legitimate source of `HeadToHeadResult.entrantAId`/`entrantBId`:
   * sourcing that from the derived columns would compare the recompute against
   * its own previous output. Cleared to NULL when the result is cleared.
   */
  result_entrant_a_id: EntrantId | null;
  result_entrant_b_id: EntrantId | null;
  method: MatchMethod | null;
  /** Opaque to the engine — that contract is what keeps one code path serving cricket, chess, Valorant and badminton. */
  result_detail_json: string | null;

  scheduled_at: UnixSeconds | null;
  started_at: UnixSeconds | null;
  completed_at: UnixSeconds | null;
  venue_id: VenueId | null;
  /** Game-agnostic physical slot: 'Court 2', 'Board 5', 'Table 3'. */
  station_label: string | null;
  /** Returned only to checked-in entrants of this match and to staff, and publicly only when `publish_room_codes = 1 AND room_code_publish_at <= now`. */
  room_code: string | null;
  room_password: string | null;
  room_code_publish_at: UnixSeconds | null;
  stream_url: string | null;
  /** Organiser-only. */
  referee_note: string | null;

  /** ONE counter for the whole row. `UPDATE … WHERE id = ? AND result_version = ?`; `meta.changes = 0` → 409 stale_version. */
  result_version: number;
  /** Dual confirmation of a final: the first submitter. A DIFFERENT organiser must then call `.../confirm`. */
  pending_confirm_by: UserId | null;
  confirmed_by: UserId | null;
  recorded_by: UserId | null;
  recorded_at: UnixSeconds | null;
  created_at: UnixSeconds;
  updated_at: UnixSeconds;
}

/**
 * Points-lobby participants: N entrants share ONE `matches` row. The computed
 * point columns are PLAIN, not GENERATED, because the formula lives in
 * `stages.scoring_config_json` — a generated column would freeze it into the
 * DDL and changing a placement table would need a full table rebuild.
 */
export interface MatchParticipantRow {
  match_id: MatchId;
  entrant_id: EntrantId;
  stage_id: StageId;
  tournament_id: TournamentId;
  slot_no: number;

  placement: number | null;
  kills: number;
  placement_points: number;
  kill_points: number;
  bonus_points: number;
  penalty_points: number;
  total_points: number;
  disqualified: Bool;
  note: string | null;

  damage: number | null;
  survival_time_s: number | null;
  status: MatchParticipantStatus;
  created_at: UnixSeconds;
  updated_at: UnixSeconds;
}

/**
 * Append-only result history, distinct from `audit_log` on purpose: this is the
 * evidence a score dispute is settled with at a live event. A row is written for
 * EVERY result write, correction and clear, in the SAME batch as the mutation.
 *
 * `match_id` is nullable with ON DELETE SET NULL, not NOT NULL + CASCADE, and
 * `match_code`/`match_no` are denormalised: an organiser can enter a wrong
 * score, reopen it, and thereby satisfy the "zero completed matches"
 * precondition of `DELETE .../bracket` — which would otherwise cascade away
 * exactly the trail this table exists for.
 */
export interface MatchAuditRow {
  id: MatchAuditId;
  match_id: MatchId | null;
  match_code: string;
  match_no: number;
  stage_id: StageId | null;
  tournament_id: TournamentId;
  actor_user_id: UserId | null;
  at: UnixSeconds;
  kind: MatchAuditKind;
  before_json: string | null;
  after_json: string | null;
  /** Public on the bracket for 48h after a correction. Silent score edits destroy trust in a club's results. */
  reason: string | null;
}

/* =====================================================================
 * 9. Standings — materialised, per stage
 * ===================================================================== */

export interface StandingRow {
  stage_id: StageId;
  entrant_id: EntrantId;
  tournament_id: TournamentId;
  group_no: number;

  rank: number;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  walkovers: number;
  byes: number;

  /** Divide by `stages.points_divisor` for display (chess 2/1/0 → 1/0.5/0). */
  points: number;
  /** runs / goals / set points / kills. */
  score_for: number;
  score_against: number;
  score_diff: number;

  /** points_lobby only. */
  kills: number;
  placement_points: number;
  best_placement: number | null;

  /**
   * Generic slots. What they hold is declared, in order, by
   * `stages.tiebreakers_json`. Rational tiebreaks (`net_run_rate`, `set_ratio`)
   * are stored ×1000 as integers and MAY be negative.
   *
   * FIVE slots, not three: chess ships four tiebreaks past `points` and round
   * robin's default has four, so three could not reconstruct a chess standings
   * row for the `columns` array. Normatively, exactly the first five comparators
   * after `points` are persisted; a longer chain still sorts, but the surplus is
   * not stored and `W_TIEBREAKS_TRUNCATED` is emitted. `seed` is never stored in
   * a slot — it lives on `stage_entrants`.
   */
  tiebreak_1: number;
  tiebreak_2: number;
  tiebreak_3: number;
  tiebreak_4: number;
  tiebreak_5: number;
  /** Human sentence explaining why this row sits where it does. */
  tiebreak_note: string | null;

  status: StageEntrantStatus;
  is_qualified: Bool;
  computed_at: UnixSeconds;
}

/* =====================================================================
 * 10. Cross-tournament leaderboard
 * ===================================================================== */

/**
 * Append-only provenance. Corrections are a NEW row or a void — never an UPDATE
 * of a total — so "why do I have 85 points?" is always answerable. One row per
 * LINKED roster member, each for the FULL award, not a split: four squadmates
 * who won a BGMI cup all won a BGMI cup.
 */
export interface PointsLedgerRow {
  id: PointsLedgerId;
  season_id: SeasonId;
  user_id: UserId;
  game_id: GameId;
  tournament_id: TournamentId | null;
  entrant_id: EntrantId | null;

  reason: PointsLedgerReason;
  placement: number | null;
  /** May be negative for `penalty` / `adjustment`. */
  points: number;
  note: string | null;

  created_by: UserId | null;
  created_at: UnixSeconds;
  voided_at: UnixSeconds | null;
  voided_by: UserId | null;
  void_reason: string | null;
}

/**
 * Materialised totals, always re-derivable from the ledger as
 * `SUM(points) WHERE voided_at IS NULL` — never written from an award list
 * directly.
 */
export interface LeaderboardEntryRow {
  period: LeaderboardPeriod;
  /** NULL = the overall, all-games board. Non-NULL = a per-game board. */
  game_id: GameId | null;
  user_id: UserId;

  points: number;
  events_played: number;
  /** Match wins. */
  wins: number;
  /** 1st places. */
  titles: number;
  /** Top 3. */
  podiums: number;
  best_finish: number | null;
  /** Mirrored from `player_ratings` when `metric=rating`. Always NULL in v1. */
  rating: number | null;
  rank: number;
  /** For the up/down arrow. */
  previous_rank: number | null;
  last_played_at: UnixSeconds | null;
  computed_at: UnixSeconds;
}

/**
 * Optional club ratings for games with `has_rating = 1`. NOTHING WRITES THIS IN
 * v1 (API.md §1.12.2): no endpoint, no publish effect, no cron, no engine
 * function. The table exists so enabling ratings is a feature flag rather than a
 * migration.
 */
export interface PlayerRatingRow {
  user_id: UserId;
  game_id: GameId;
  /** 'classical' | 'rapid' | 'blitz' | 'standard'. Free text: a new time control must not need a migration. */
  rating_kind: string;
  rating: number;
  deviation: number;
  games_played: number;
  is_provisional: Bool;
  peak_rating: number | null;
  last_played_at: UnixSeconds | null;
  updated_at: UnixSeconds;
}

/* =====================================================================
 * 11. Content
 * ===================================================================== */

export interface AnnouncementRow {
  id: AnnouncementId;
  scope: AnnouncementScope;
  tournament_id: TournamentId | null;
  title: string;
  body_md: string;
  /** Closed-allowlist AST compiled by the Worker at write time. The client never receives HTML. */
  body_ast_json: string | null;
  severity: AnnouncementSeverity;
  is_pinned: Bool;
  promote_to_club: Bool;
  author_user_id: UserId | null;
  published_at: UnixSeconds | null;
  edited_at: UnixSeconds | null;
  expires_at: UnixSeconds | null;
  deleted_at: UnixSeconds | null;
  version: number;
  created_at: UnixSeconds;
  updated_at: UnixSeconds;
}

/* =====================================================================
 * 12. Audit log
 * ===================================================================== */

/**
 * Every organiser and admin mutation. `before_json`/`after_json` hold ONLY the
 * changed keys, not full row snapshots — a 90-column tournament snapshotted on
 * every edit would become the largest table in the database within a season.
 * Result history lives in `match_audit`, not here.
 */
export interface AuditLogRow {
  /** ULID: monotonic by creation time, so the PK index IS the chronological index. */
  id: AuditLogId;
  at: UnixSeconds;
  /** NULL = cron/system. */
  actor_user_id: UserId | null;
  actor_role: string | null;
  actor_session_id: string | null;
  /** HMAC(IP_HASH_KEY, ip). Never the raw address. */
  actor_ip_hash: string | null;

  /** Dotted verb: `tournament.publish`, `match.score_set`, `entrant.contact.view`, `session.revoke`. */
  action: string;
  entity_type: AuditEntityType;
  entity_id: string | null;
  /** Denormalised so "everything that happened in my event" is one indexed query. */
  tournament_id: TournamentId | null;

  before_json: string | null;
  after_json: string | null;
  /** Rendered directly in the activity feed. */
  summary: string;
  /** The `X-Request-Id` the caller was given. */
  request_id: string | null;

  created_at: UnixSeconds;
}

/* =====================================================================
 * 13. Idempotency and rate limiting
 * ===================================================================== */

/**
 * "Did my POST go through?" on patchy 4G. The row is completed in the SAME batch
 * as the business mutation, so a stored "success" cannot exist without the
 * mutation having committed.
 */
export interface IdempotencyKeyRow {
  /** A user id, or `'g:' || sha256(guest_token)`, or `'ip:' || ip_hash`. */
  scope: string;
  key: string;
  endpoint: string;
  request_hash: string;
  /** 0 = in flight; otherwise the HTTP status that was returned. */
  status: number;
  response_body: string | null;
  response_truncated: Bool;
  created_at: UnixSeconds;
  completed_at: UnixSeconds | null;
  expires_at: UnixSeconds;
}

/**
 * Long-window (per-hour, per-day) counters that must be globally accurate.
 * Short windows (10 s / 60 s) use the Workers Rate Limiting binding and never
 * touch D1; one helper in `worker/lib/ratelimit.ts` owns both paths.
 */
export interface RateCounterRow {
  bucket: string;
  key: string;
  window_start: UnixSeconds;
  count: number;
  expires_at: UnixSeconds;
}

/* =====================================================================
 * Table registry
 *
 * Keyed by the literal table name, so a query helper can be generic over
 * `keyof DbTables` and a typo in a table name is a compile error rather than a
 * D1 "no such table" at 7 p.m.
 * ===================================================================== */

export interface DbTables {
  schema_meta: SchemaMetaRow;
  settings: SettingRow;
  users: UserRow;
  handle_reservations: HandleReservationRow;
  webauthn_credentials: WebauthnCredentialRow;
  recovery_codes: RecoveryCodeRow;
  sessions: SessionRow;
  webauthn_challenges: WebauthnChallengeRow;
  email_otps: EmailOtpRow;
  games: GameRow;
  seasons: SeasonRow;
  venues: VenueRow;
  tournaments: TournamentRow;
  tournament_organizers: TournamentOrganizerRow;
  invites: InviteRow;
  slug_redirects: SlugRedirectRow;
  stages: StageRow;
  entrants: EntrantRow;
  entrant_members: EntrantMemberRow;
  stage_entrants: StageEntrantRow;
  matches: MatchRow;
  match_participants: MatchParticipantRow;
  match_audit: MatchAuditRow;
  standings: StandingRow;
  points_ledger: PointsLedgerRow;
  leaderboard_entries: LeaderboardEntryRow;
  player_ratings: PlayerRatingRow;
  announcements: AnnouncementRow;
  audit_log: AuditLogRow;
  idempotency_keys: IdempotencyKeyRow;
  rate_counters: RateCounterRow;
}

export type TableName = keyof DbTables;
