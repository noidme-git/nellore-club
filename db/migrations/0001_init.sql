-- =====================================================================
-- nellore.club — Cloudflare D1 schema (SQLite)
-- =====================================================================
--
-- AUTHORITATIVE SNAPSHOT of the database. This file is the single source of
-- truth for table names, column names, types and enum values. Where any
-- document in docs/ disagrees with this file about a NAME or a TYPE, this file
-- wins; docs/ARCHITECTURE.md §5 records every reconciliation that produced it.
--
-- HOW THIS FILE IS USED
--   * Fresh local / preview database:
--       wrangler d1 execute nellore-club --local  --file=db/schema.sql
--       wrangler d1 execute nellore-club --remote --file=db/schema.sql   (first deploy ONLY)
--   * After the first production deploy this file is NEVER applied to
--     production again. Production changes go through db/migrations/NNNN_*.sql
--     applied with `wrangler d1 migrations apply nellore-club --remote`.
--   * db/migrations/0001_init.sql is a byte-for-byte copy of this file at
--     launch. Every later change = a new numbered migration AND an edit here,
--     so this file always describes "what a brand new DB looks like".
--
-- CONVENTIONS (enforced, not aspirational)
--   IDs         Prefixed ULID stored as TEXT, EXACTLY 30 characters:
--                 <3-char prefix> '_' <26-char Crockford base32 ULID>
--               e.g. trn_01JB2KQ8ZT4R9V6M0X3H7C1N2P
--               Worker-generated, so a whole bracket — including its
--               cross-referencing source pointers — is written in ONE batch().
--               Enforced per table with CHECK (id GLOB '<prefix>_*' AND length(id) = 30).
--               Prefix registry: docs/ARCHITECTURE.md §6.3.
--   Timestamps  INTEGER, unix SECONDS, UTC. Column suffix `_at`. Never TEXT,
--               never milliseconds. IST (UTC+05:30, no DST) is applied at
--               render time only. The wire format is RFC 3339 `...Z`.
--   Money       INTEGER paise. 1 INR = 100 paise. Column suffix `_paise`.
--               No REAL anywhere in this file. Ever. Scores are INTEGER too:
--               chess half-points are 2/1/0 with stages.points_divisor = 2.
--   Booleans    INTEGER 0/1 with a CHECK. STRICT forbids a BOOLEAN type.
--   Enums       TEXT + CHECK(col IN (...)). SQLite has no native enum.
--   JSON        TEXT + CHECK(json_valid(...)). Column suffix `_json`.
--   STRICT      Every table. Rejects '12' into an INTEGER at write time.
--
-- D1 REALITIES BAKED IN
--   * Foreign keys ARE enforced by D1. The bracket generator emits matches in
--     topological order (every match after everything it references), so the
--     self-referencing source pointers need no deferral.
--   * No triggers anywhere — the Worker owns all derived state, in the same
--     batch as the mutation, so a rollback rolls back the derivation too.
--   * No stored procedures, no sequences. Per-tournament counters use
--     INSERT..SELECT MAX()+1 guarded by a UNIQUE index.
--   * Every FK that is joined or filtered on has an explicit index; SQLite
--     does not create them.
--   * No REAL columns, so no float-equality bug can reach a standings sort.
--
-- ---------------------------------------------------------------------

PRAGMA foreign_keys = ON;

-- =====================================================================
-- 0. Meta
-- =====================================================================

CREATE TABLE schema_meta (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
) STRICT;

INSERT INTO schema_meta (key, value) VALUES
  ('schema_version', '0001'),
  ('money_unit',     'INR paise (integer)'),
  ('time_unit',      'unix seconds UTC'),
  ('id_scheme',      'prefixed ULID, 30 chars: xxx_<26-char Crockford base32>');

-- Free-form runtime configuration and the cache-validator counters.
-- Lives here instead of in code so the owner can change the UPI VPA or the
-- WhatsApp number without a deploy, and so a new knob never costs a migration.
--   Config keys:  club.name, club.upi_vpa, club.upi_payee_name, club.whatsapp,
--                 club.contact_email, club.default_city, club.timezone,
--                 club.info_json,
--                 flags.registration_enabled, flags.leaderboard_public,
--                 flags.guest_entrants_enabled, points.default_scheme
--   Version keys (integers, bumped in the same batch as the mutation; they are
--   the ETag validators for resources that have no single owning row):
--                 version.games, version.listing, version.club,
--                 version.club_announcements, version.leaderboard
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value_json  TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT
) STRICT;

INSERT INTO settings (key, value_json, updated_at) VALUES
  ('version.games',               '1', unixepoch()),
  ('version.listing',             '1', unixepoch()),
  ('version.club',                '1', unixepoch()),
  ('version.club_announcements',  '1', unixepoch()),
  ('version.leaderboard',         '1', unixepoch());

-- =====================================================================
-- 1. Identity
-- =====================================================================
--
-- The table is `users` and the foreign key column is `user_id` everywhere.
-- ("player" is the domain word for a human in a roster — entrant_members —
-- and reusing it for the account table made three documents disagree.)
-- ---------------------------------------------------------------------

CREATE TABLE users (
  id                     TEXT PRIMARY KEY CHECK (id GLOB 'usr_*' AND length(id) = 30),

  -- Public URL segment: /p/<handle>. Lowercase-only so uniqueness is
  -- case-insensitive without a second normalised column.
  -- Wire regex (enforced in the Worker): ^[a-z0-9][a-z0-9_]{2,19}$
  handle                 TEXT NOT NULL UNIQUE
                           CHECK (handle = lower(handle) AND length(handle) BETWEEN 3 AND 20),
  handle_changed_at      INTEGER,
  display_name           TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 60),
  -- Deterministic identicon seed. There are no avatar uploads in v1.
  avatar_seed            TEXT,
  bio                    TEXT CHECK (bio IS NULL OR length(bio) <= 200),
  city                   TEXT NOT NULL DEFAULT 'Nellore',

  -- The WebAuthn user handle: base64url of 32 random bytes. Never the id, and
  -- never anything derived from the handle — it must not leak identity to a
  -- relying party that is not us.
  webauthn_user_id       TEXT NOT NULL UNIQUE,

  -- Both optional: the passkey flow needs neither. Present only when the user
  -- volunteers them (organiser contact, prize payout, optional email OTP).
  email                  TEXT CHECK (email IS NULL OR email = lower(email)),
  email_verified         INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0,1)),
  -- AES-GCM ciphertext under PII_KEY. The plaintext is NEVER a column.
  phone_enc              BLOB,
  -- HMAC(PHONE_INDEX_KEY, e164) — a blind index so "is this number already
  -- registered" is answerable without decrypting anything.
  phone_hash             TEXT,
  phone_last4            TEXT CHECK (phone_last4 IS NULL OR length(phone_last4) = 4),
  notify_whatsapp        INTEGER NOT NULL DEFAULT 1 CHECK (notify_whatsapp IN (0,1)),
  -- 18+ self-declaration. See SECURITY.md §10.5.
  is_adult               INTEGER NOT NULL DEFAULT 1 CHECK (is_adult IN (0,1)),

  -- Global role. Per-tournament grants live in tournament_organizers.
  role                   TEXT NOT NULL DEFAULT 'player'
                           CHECK (role IN ('player','organizer','admin')),

  status                 TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','suspended','banned','deleted')),
  suspended_until        INTEGER,
  moderation_reason      TEXT,
  profile_public         INTEGER NOT NULL DEFAULT 1 CHECK (profile_public IN (0,1)),
  -- ETag validator for /api/v1/players/:handle and the /p/ shell.
  profile_version        INTEGER NOT NULL DEFAULT 1,

  -- Mass session revocation. Every session row stores the epoch it was minted
  -- under; bumping this one integer invalidates all of them with no scan.
  session_epoch          INTEGER NOT NULL DEFAULT 1,
  recovery_fail_count    INTEGER NOT NULL DEFAULT 0,
  recovery_locked_until  INTEGER,

  -- Remembered answers keyed by FieldDef.profile_key (CONTENT.md §3.4), NOT by
  -- game slug: {"core.whatsapp":"••••• •4417","bgmi.player_id":"5123456789",
  --             "chess.rating":1612}
  -- This blob is sent to the CLIENT on every form render, so a `pii: true`
  -- `tel` value is stored MASKED here. The canonical number is phone_enc
  -- above; the Worker substitutes it server-side when the player submits the
  -- prefilled field unchanged. See SECURITY.md §10.2.1.
  -- Keying by profile_key is what lets chess-classical and chess-blitz share a
  -- rating and a badminton player answer "level" once for singles and doubles.
  profile_answers_json   TEXT CHECK (profile_answers_json IS NULL OR json_valid(profile_answers_json)),

  deletion_requested_at  INTEGER,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  last_seen_at           INTEGER,
  deleted_at             INTEGER
) STRICT;

CREATE UNIQUE INDEX ux_users_email      ON users(email)      WHERE email IS NOT NULL;
CREATE UNIQUE INDEX ux_users_phone_hash ON users(phone_hash) WHERE phone_hash IS NOT NULL;
-- Admin "list organisers", and the org-only nav gate.
CREATE INDEX ix_users_role     ON users(role) WHERE role <> 'player';
CREATE INDEX ix_users_created  ON users(created_at DESC);

-- A released handle is parked for 90 days so a rename cannot be used to
-- impersonate someone whose old links are still circulating on WhatsApp.
CREATE TABLE handle_reservations (
  handle      TEXT PRIMARY KEY CHECK (handle = lower(handle)),
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  reserved_at INTEGER NOT NULL,
  released_at INTEGER NOT NULL          -- reservation expires at this instant
) STRICT;

CREATE INDEX ix_handle_res_release ON handle_reservations(released_at);

-- ---------------------------------------------------------------------
-- WebAuthn passkeys. This is the ONLY credential type required to launch:
-- no email provider, no SMS provider, no password column anywhere.
-- ---------------------------------------------------------------------
CREATE TABLE webauthn_credentials (
  id                TEXT PRIMARY KEY CHECK (id GLOB 'crd_*' AND length(id) = 30),
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- base64url of the raw authenticator credential ID. Globally unique; this is
  -- what allowCredentials / the assertion response is matched against.
  credential_id     TEXT NOT NULL UNIQUE,
  -- Raw COSE_Key bytes. BLOB, not base64 TEXT: WebCrypto importKey wants an
  -- ArrayBuffer and D1 round-trips BLOBs natively.
  public_key        BLOB NOT NULL,
  -- COSE algorithm identifier. -7 = ES256 (what every phone produces),
  -- -257 = RS256 (Windows Hello / older TPMs).
  algorithm         INTEGER NOT NULL,

  -- Signature counter. Many phone authenticators always report 0; treat a
  -- DECREASE (not a non-increase) as the clone signal.
  counter           INTEGER NOT NULL DEFAULT 0,
  transports_json   TEXT CHECK (transports_json IS NULL OR json_valid(transports_json)),
  aaguid            TEXT,
  -- Authenticator data flags. backup_eligible=1 + backup_state=1 means the
  -- passkey is synced to iCloud/Google — losing the phone is NOT account loss,
  -- and the UI should say so instead of nagging about recovery codes.
  backup_eligible   INTEGER NOT NULL DEFAULT 0 CHECK (backup_eligible IN (0,1)),
  backup_state      INTEGER NOT NULL DEFAULT 0 CHECK (backup_state IN (0,1)),
  device_type       TEXT CHECK (device_type IS NULL OR device_type IN ('singleDevice','multiDevice')),
  is_discoverable   INTEGER NOT NULL DEFAULT 1 CHECK (is_discoverable IN (0,1)),

  label             TEXT NOT NULL DEFAULT 'Passkey',   -- "Redmi Note 13", user-editable
  created_at        INTEGER NOT NULL,
  last_used_at      INTEGER,
  revoked_at        INTEGER,
  revoked_reason    TEXT
) STRICT;

CREATE INDEX ix_cred_user ON webauthn_credentials(user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------
-- One-time recovery codes — the zero-cost answer to "I lost my phone".
-- Ten codes issued as a batch at signup; regenerating supersedes the batch.
-- HMAC-SHA256 with RECOVERY_PEPPER, not PBKDF2: Workers bill CPU, an honest
-- PBKDF2 iteration count is a cost-amplification vector, and each code already
-- carries ~48 bits. A D1 dump is worthless without the Worker secret.
-- Because the hash is deterministic, verification is ONE indexed lookup on
-- (user_id, code_hash) — no candidate scan, no per-code work.
-- ---------------------------------------------------------------------
CREATE TABLE recovery_codes (
  id            TEXT PRIMARY KEY CHECK (id GLOB 'rec_*' AND length(id) = 30),
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  batch_id      TEXT NOT NULL,
  code_hash     TEXT NOT NULL,        -- hex HMAC-SHA256(RECOVERY_PEPPER, user_id||':'||code)
  created_at    INTEGER NOT NULL,
  used_at       INTEGER,
  used_ip_hash  TEXT,
  superseded_at INTEGER
) STRICT;

CREATE UNIQUE INDEX ux_rc_user_hash  ON recovery_codes(user_id, code_hash);
CREATE INDEX ix_rc_user_unused ON recovery_codes(user_id)
  WHERE used_at IS NULL AND superseded_at IS NULL;
CREATE INDEX ix_rc_batch ON recovery_codes(batch_id);

-- ---------------------------------------------------------------------
-- Sessions. The cookie value is `<session_id>.<secret>`; the DB stores only
-- HMAC(SESSION_PEPPER, id||':'||secret). A dumped D1 snapshot therefore cannot
-- be replayed as a login. Lookup is by id (indexed), then a constant-time
-- comparison of the recomputed hash.
-- ---------------------------------------------------------------------
CREATE TABLE sessions (
  id                  TEXT PRIMARY KEY CHECK (id GLOB 'ses_*' AND length(id) = 30),
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash          TEXT NOT NULL,
  -- Returned only by GET /api/v1/auth/session, held in memory by the SPA.
  -- Deliberately NOT a cookie: see AUTH.md §5.7.
  csrf_token          TEXT NOT NULL,
  -- Must equal users.session_epoch or the session is dead.
  epoch               INTEGER NOT NULL,
  role_snapshot       TEXT NOT NULL CHECK (role_snapshot IN ('player','organizer','admin')),
  -- 'recovery' sessions may ONLY enrol a passkey. Everything else 403s.
  scope               TEXT NOT NULL DEFAULT 'full' CHECK (scope IN ('full','recovery')),
  -- Did the last ceremony perform user verification (biometric/PIN)?
  uv                  INTEGER NOT NULL DEFAULT 0 CHECK (uv IN (0,1)),
  auth_method         TEXT NOT NULL
                        CHECK (auth_method IN ('passkey','recovery','email','bootstrap')),
  credential_id       TEXT REFERENCES webauthn_credentials(id) ON DELETE SET NULL,

  created_at          INTEGER NOT NULL,
  -- Last completed authentication ceremony. Drives step-up; never touched by
  -- ordinary activity.
  auth_at             INTEGER NOT NULL,
  last_seen_at        INTEGER NOT NULL,
  idle_expires_at     INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  revoked_at          INTEGER,
  revoked_reason      TEXT CHECK (revoked_reason IS NULL OR revoked_reason IN
                        ('logout','logout_all','admin_revoke','rotation','recovery_used','expired','ban')),

  ip_hash             TEXT,   -- HMAC(IP_HASH_KEY, ip). The raw IP is never stored.
  ip_city             TEXT,   -- request.cf.city — coarse, for "where am I signed in"
  ua_summary          TEXT CHECK (ua_summary IS NULL OR length(ua_summary) <= 64)
) STRICT;

CREATE INDEX ix_sessions_user   ON sessions(user_id, created_at DESC) WHERE revoked_at IS NULL;
CREATE INDEX ix_sessions_expiry ON sessions(absolute_expires_at);

-- ---------------------------------------------------------------------
-- WebAuthn challenges. Server-side so single-use is actually enforceable
-- (UPDATE ... WHERE consumed_at IS NULL, then check meta.changes = 1).
-- GC: the nightly cron deletes rows past expires_at.
-- ---------------------------------------------------------------------
CREATE TABLE webauthn_challenges (
  challenge         TEXT PRIMARY KEY,          -- base64url, 32 random bytes
  purpose           TEXT NOT NULL CHECK (purpose IN ('register','login')),
  intent            TEXT CHECK (intent IS NULL OR intent IN
                      ('signup','add_credential','reauth','bootstrap_admin','recovery_enrol')),
  user_id           TEXT REFERENCES users(id) ON DELETE CASCADE,  -- NULL for usernameless login
  pending_handle    TEXT,
  pending_display   TEXT,
  webauthn_user_id  TEXT,
  ip_hash           TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,          -- created_at + 120
  consumed_at       INTEGER
) STRICT;

CREATE INDEX ix_wac_expires ON webauthn_challenges(expires_at);

-- ---------------------------------------------------------------------
-- OPTIONAL email OTP. The table ships unconditionally so that turning the
-- feature on later is an env var, not a migration. Routes that touch it return
-- 501 email_auth_disabled when EMAIL_OTP_ENABLED is unset.
-- ---------------------------------------------------------------------
CREATE TABLE email_otps (
  id            TEXT PRIMARY KEY CHECK (id GLOB 'otp_*' AND length(id) = 30),
  email         TEXT NOT NULL CHECK (email = lower(email)),
  code_hash     TEXT NOT NULL,                  -- hex HMAC-SHA256(OTP_PEPPER, email||':'||code)
  purpose       TEXT NOT NULL CHECK (purpose IN ('login','verify_email','recover')),
  user_id       TEXT REFERENCES users(id) ON DELETE CASCADE,
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 5,
  ip_hash       TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  consumed_at   INTEGER
) STRICT;

CREATE INDEX ix_otp_lookup ON email_otps(email, purpose, created_at DESC);
CREATE INDEX ix_otp_expiry ON email_otps(expires_at);

-- =====================================================================
-- 2. The game catalogue — the game-agnostic crux
-- =====================================================================
--
-- A `games` row is a TEMPLATE OF DEFAULTS, never the authority. Every default_*
-- column is copied into the tournament at creation time and the tournament copy
-- is what the engine reads. That single rule is what makes "carrom singles" and
-- "carrom doubles" one game row instead of two, and what stops a catalogue edit
-- in 2027 from silently rewriting the rules of a 2026 tournament.
--
-- Rows are generated from content/games.json by scripts/seed-games.ts. Adding a
-- new game is one INSERT. There is no code path anywhere that branches on a
-- game slug.
-- ---------------------------------------------------------------------
CREATE TABLE games (
  id                  TEXT PRIMARY KEY CHECK (id GLOB 'gam_*' AND length(id) = 30),
  slug                TEXT NOT NULL UNIQUE
                        CHECK (slug = lower(slug) AND length(slug) BETWEEN 2 AND 40),
  name                TEXT NOT NULL,
  short_name          TEXT NOT NULL,            -- for bracket chips / mobile nav
  category            TEXT NOT NULL CHECK (category IN ('esport','board','outdoor')),
  -- Free-text sub-bucket for filtering: 'battle_royale','fps','sports_sim',
  -- 'mind','tile','racket','team_sport'. Deliberately NOT a CHECK — new
  -- sub-genres must not need a migration.
  subcategory         TEXT,

  -- ---- participation defaults ----
  default_participant_type TEXT NOT NULL CHECK (default_participant_type IN ('solo','team')),
  default_team_size_min    INTEGER NOT NULL DEFAULT 1 CHECK (default_team_size_min >= 1),
  default_team_size_max    INTEGER NOT NULL DEFAULT 1 CHECK (default_team_size_max >= 1),
  default_substitutes_max  INTEGER NOT NULL DEFAULT 0 CHECK (default_substitutes_max >= 0),
  -- Does the game ALSO have a legitimate doubles/pairs form? Carrom, badminton,
  -- table tennis = 1. Purely informational for the organiser's create form.
  supports_pairs      INTEGER NOT NULL DEFAULT 0 CHECK (supports_pairs IN (0,1)),

  -- ---- scoring model: the only thing the score-entry UI branches on ----
  --   h2h_simple  one integer per side       chess, EA FC, kabaddi, scrabble
  --   h2h_sets    sets/games/boards/maps     badminton, volleyball, TT, carrom, CS2, Valorant
  --   h2h_innings innings detail             cricket
  --   br_points   N entrants per lobby, placement + kills   BGMI, Free Fire
  --   manual      organiser just declares the winner        anything odd
  -- NOTE: this is the SCORING MODEL, a different axis from the tournament
  -- FORMAT below. `br_points` is a scoring model; `points_lobby` is a format.
  scoring_model       TEXT NOT NULL
                        CHECK (scoring_model IN ('h2h_simple','h2h_sets','h2h_innings','br_points','manual')),
  -- Display noun for one unit inside a match: 'set','game','board','map','inning','round'.
  unit_label          TEXT NOT NULL DEFAULT 'game',
  -- Display noun for the match-level score: 'points','runs','goals','sets','maps'.
  score_label         TEXT NOT NULL DEFAULT 'points',
  supports_draw       INTEGER NOT NULL DEFAULT 0 CHECK (supports_draw IN (0,1)),
  -- A game won on the LOWEST score. Without this the engine would infer the
  -- wrong winner from score_a/score_b, and "add golf" would become a code change.
  higher_score_wins   INTEGER NOT NULL DEFAULT 1 CHECK (higher_score_wins IN (0,1)),

  default_format      TEXT NOT NULL
                        CHECK (default_format IN ('single_elim','double_elim','round_robin','swiss','points_lobby')),
  default_best_of     INTEGER NOT NULL DEFAULT 1 CHECK (default_best_of >= 1),
  -- 1 = the create-tournament wizard proposes TWO stages (group stage feeding a
  -- knockout) instead of one. Never a sixth format value: `stages` is the
  -- authority on shape.
  default_multi_stage INTEGER NOT NULL DEFAULT 0 CHECK (default_multi_stage IN (0,1)),

  -- ---- logistics ----
  default_venue_mode  TEXT NOT NULL DEFAULT 'onsite'
                        CHECK (default_venue_mode IN ('online','onsite','hybrid')),
  -- Battle-royale / custom-lobby titles need a room code + password pushed to
  -- checked-in entrants minutes before start.
  needs_room_code     INTEGER NOT NULL DEFAULT 0 CHECK (needs_room_code IN (0,1)),
  needs_ingame_id     INTEGER NOT NULL DEFAULT 0 CHECK (needs_ingame_id IN (0,1)),
  ingame_id_label     TEXT,                    -- 'BGMI player ID', 'Riot ID', 'FIDE ID'
  ingame_id_pattern   TEXT,                    -- JS-safe anchored regex, validated in the Worker
  default_lobby_size  INTEGER,                 -- points_lobby only: entrants per lobby (BGMI 16/25)

  -- ---- per-game custom registration fields ----
  -- JSON array of FieldDef (CONTENT.md §3), each tagged with a "scope":
  --   "entrant" -> entrants.fields_json      "member" -> entrant_members.fields_json
  -- The full FieldDef survives here: help, visibility, pii, profile_key,
  -- visible_if, validation. The public serializer strips by `visibility`; the
  -- DPDP purge job keys off `pii`.
  registration_fields_json TEXT
                        CHECK (registration_fields_json IS NULL OR json_valid(registration_fields_json)),

  -- ---- default scoring configuration + the content surplus bucket ----
  -- scoring.params plus every key the table has no column for (side_labels,
  -- side_assignment, match_fields, standings, leaderboard, compliance,
  -- multi_stage, rating, equipment, rules_summary, search_terms, tagline,
  -- full_name, icon, age_min, status, _content_hash, _version).
  -- Read by slug, one row at a time, through one typed accessor. Never in a
  -- WHERE clause, never with json_extract on a hot path.
  scoring_config_json TEXT CHECK (scoring_config_json IS NULL OR json_valid(scoring_config_json)),
  -- Ordered tiebreaker tokens the standings engine applies, most significant
  -- first. The closed token set is in docs/ARCHITECTURE.md §6.6. The list must
  -- terminate in a total order; the engine appends `seed` unconditionally.
  default_tiebreakers_json TEXT
                        CHECK (default_tiebreakers_json IS NULL OR json_valid(default_tiebreakers_json)),

  -- Chess/carrom keep an internal club rating; drives player_ratings.
  has_rating          INTEGER NOT NULL DEFAULT 0 CHECK (has_rating IN (0,1)),
  rating_kinds_json   TEXT CHECK (rating_kinds_json IS NULL OR json_valid(rating_kinds_json)),

  -- ---- presentation ----
  blurb               TEXT,
  -- v1 renders a category glyph + accent + short_name. There is no icon sprite
  -- sheet and no per-game raster (DESIGN.md §7, §8). Reserved for later.
  icon_url            TEXT,
  accent_hex          TEXT CHECK (accent_hex IS NULL OR (accent_hex LIKE '#%' AND length(accent_hex) = 7)),
  rules_url           TEXT,

  sort_order          INTEGER NOT NULL DEFAULT 100,
  is_active           INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  version             INTEGER NOT NULL DEFAULT 1,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,

  CHECK (default_team_size_max >= default_team_size_min),
  CHECK (default_participant_type <> 'solo' OR default_team_size_max = 1),
  CHECK (needs_ingame_id = 0 OR ingame_id_label IS NOT NULL),
  CHECK (default_format <> 'points_lobby' OR default_lobby_size IS NOT NULL)
) STRICT;

CREATE INDEX ix_games_category ON games(category, sort_order) WHERE is_active = 1;

-- =====================================================================
-- 3. Seasons
-- =====================================================================

CREATE TABLE seasons (
  id             TEXT PRIMARY KEY CHECK (id GLOB 'sea_*' AND length(id) = 30),
  slug           TEXT NOT NULL UNIQUE CHECK (slug = lower(slug)),
  name           TEXT NOT NULL,
  starts_at      INTEGER NOT NULL,
  ends_at        INTEGER NOT NULL,
  is_active      INTEGER NOT NULL DEFAULT 0 CHECK (is_active IN (0,1)),
  -- Default award curve for the cross-tournament leaderboard:
  -- {"placement":[100,70,50,35,25,20,15,10],"participation":5,"min_entrants":4}
  points_scheme_json TEXT NOT NULL CHECK (json_valid(points_scheme_json)),
  -- Optimistic lock for PATCH /api/v1/admin/seasons/:id (API.md §5.9).
  version        INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  CHECK (ends_at > starts_at)
) STRICT;

CREATE UNIQUE INDEX ux_seasons_active ON seasons(is_active) WHERE is_active = 1;

-- =====================================================================
-- 4. Venues
-- =====================================================================

CREATE TABLE venues (
  id          TEXT PRIMARY KEY CHECK (id GLOB 'ven_*' AND length(id) = 30),
  name        TEXT NOT NULL,
  area        TEXT,                       -- 'Trunk Road', 'Magunta Layout'
  address     TEXT,
  maps_url    TEXT,
  is_online   INTEGER NOT NULL DEFAULT 0 CHECK (is_online IN (0,1)),
  capacity    INTEGER,
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  sort_order  INTEGER NOT NULL DEFAULT 100,
  -- Optimistic lock for POST/PATCH /api/v1/admin/venues (API.md §5.8).
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX ix_venues_active ON venues(is_active, sort_order);

-- =====================================================================
-- 5. Tournaments
-- =====================================================================

CREATE TABLE tournaments (
  id                    TEXT PRIMARY KEY CHECK (id GLOB 'trn_*' AND length(id) = 30),
  -- Public URL: /t/<slug>. Immutable once published; renaming would break every
  -- WhatsApp link already forwarded. Wire regex: ^[a-z0-9][a-z0-9-]{1,40}$
  slug                  TEXT NOT NULL UNIQUE
                          CHECK (slug = lower(slug) AND length(slug) BETWEEN 2 AND 41),

  game_id               TEXT NOT NULL REFERENCES games(id) ON DELETE RESTRICT,
  season_id             TEXT REFERENCES seasons(id) ON DELETE SET NULL,
  owner_user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  title                 TEXT NOT NULL,
  subtitle              TEXT,
  -- <=200 chars, used verbatim as the og:description base shared into WhatsApp.
  summary               TEXT CHECK (summary IS NULL OR length(summary) <= 200),
  -- Markdown SOURCE, organiser-visible only. The public API serves the AST.
  rules_md              TEXT,
  rules_ast_json        TEXT CHECK (rules_ast_json IS NULL OR json_valid(rules_ast_json)),
  description_md        TEXT,
  description_ast_json  TEXT CHECK (description_ast_json IS NULL OR json_valid(description_ast_json)),
  -- 'Rapid 15+10', 'Doubles', 'T20', 'Erangel only'. Free text: the schema must
  -- not enumerate every variant of every game.
  variant_label         TEXT,

  -- Headline format for cards + filters. The AUTHORITY is `stages`; a
  -- single-stage tournament mirrors its one stage here, a multi-stage one says
  -- 'multi_stage'.
  format                TEXT NOT NULL
                          CHECK (format IN ('single_elim','double_elim','round_robin','swiss','points_lobby','multi_stage')),

  status                TEXT NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','published','registration_open','registration_closed',
                                            'check_in','live','completed','cancelled','archived')),
  visibility            TEXT NOT NULL DEFAULT 'public'
                          CHECK (visibility IN ('public','unlisted','private')),

  -- ---- participation (copied from games at creation, then authoritative) ----
  participant_type      TEXT NOT NULL CHECK (participant_type IN ('solo','team')),
  team_size_min         INTEGER NOT NULL DEFAULT 1 CHECK (team_size_min >= 1),
  team_size_max         INTEGER NOT NULL DEFAULT 1 CHECK (team_size_max >= 1),
  substitutes_max       INTEGER NOT NULL DEFAULT 0 CHECK (substitutes_max >= 0),
  max_entrants          INTEGER CHECK (max_entrants IS NULL OR max_entrants >= 2),
  min_entrants          INTEGER NOT NULL DEFAULT 2 CHECK (min_entrants >= 2),
  waitlist_enabled      INTEGER NOT NULL DEFAULT 1 CHECK (waitlist_enabled IN (0,1)),
  -- Does a self-service registration land in 'pending' or straight in 'confirmed'?
  requires_confirmation INTEGER NOT NULL DEFAULT 1 CHECK (requires_confirmation IN (0,1)),
  requires_phone        INTEGER NOT NULL DEFAULT 0 CHECK (requires_phone IN (0,1)),
  min_account_age_hours INTEGER NOT NULL DEFAULT 0 CHECK (min_account_age_hours >= 0),
  allow_guest_registration INTEGER NOT NULL DEFAULT 0 CHECK (allow_guest_registration IN (0,1)),
  requires_join_code    INTEGER NOT NULL DEFAULT 0 CHECK (requires_join_code IN (0,1)),
  -- Is the public entrant list published yet?
  entrants_public       INTEGER NOT NULL DEFAULT 1 CHECK (entrants_public IN (0,1)),
  minors_allowed        INTEGER NOT NULL DEFAULT 1 CHECK (minors_allowed IN (0,1)),

  -- ---- timing (all unix seconds UTC; the UI renders IST) ----
  registration_opens_at  INTEGER,
  registration_closes_at INTEGER,
  requires_checkin       INTEGER NOT NULL DEFAULT 1 CHECK (requires_checkin IN (0,1)),
  checkin_opens_at       INTEGER,
  checkin_closes_at      INTEGER,
  -- Cheap proof of physical presence: a 4-digit code written on a board at the
  -- desk. Never returned by a public endpoint.
  checkin_requires_code  INTEGER NOT NULL DEFAULT 0 CHECK (checkin_requires_code IN (0,1)),
  checkin_code           TEXT,
  starts_at              INTEGER NOT NULL,
  ends_at                INTEGER,

  -- ---- venue ----
  venue_mode            TEXT NOT NULL DEFAULT 'onsite'
                          CHECK (venue_mode IN ('online','onsite','hybrid')),
  venue_id              TEXT REFERENCES venues(id) ON DELETE SET NULL,
  -- Ad-hoc override when the event is not at a catalogued venue.
  venue_name            TEXT,
  venue_address         TEXT,
  venue_city            TEXT NOT NULL DEFAULT 'Nellore',
  venue_map_url         TEXT,
  online_platform       TEXT,      -- 'BGMI custom room', 'Discord', 'Lichess arena'

  -- ---- money: integer paise, always ----
  currency              TEXT NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  entry_fee_paise       INTEGER NOT NULL DEFAULT 0 CHECK (entry_fee_paise >= 0),
  prize_pool_paise      INTEGER NOT NULL DEFAULT 0 CHECK (prize_pool_paise >= 0),
  -- [{"position":1,"label":"Champion","amount_paise":800000,"extra":"Trophy"},
  --  {"position":2,"label":"Runner-up","amount_paise":400000,"extra":null}]
  prizes_json           TEXT CHECK (prizes_json IS NULL OR json_valid(prizes_json)),
  payment_mode          TEXT NOT NULL DEFAULT 'free'
                          CHECK (payment_mode IN ('free','upi_manual','at_venue')),
  -- Overrides settings['club.upi_vpa'] for this event's collections. The API
  -- MUST refuse entry_fee_paise > 0 while neither this nor the setting is set.
  upi_vpa               TEXT,
  payment_note          TEXT,

  -- ---- seeding + engine defaults (stages may override) ----
  seeding_method        TEXT NOT NULL DEFAULT 'registration'
                          CHECK (seeding_method IN ('registration','random','manual','rating')),
  rating_kind           TEXT,      -- which player_ratings.rating_kind seeds/updates
  -- uint32, written once at creation from crypto.getRandomValues, IMMUTABLE.
  -- Published after the draw so a randomised bracket is reproducible and the
  -- accusation "the draw was rigged" has a verifiable answer.
  bracket_seed          INTEGER NOT NULL,

  -- ---- presentation & sharing ----
  banner_image          TEXT,
  og_image_url          TEXT,
  -- WhatsApp caches OG images by URL, hard. Bump this and append ?v=<n> to the
  -- og:image URL to force a re-scrape after a cover change.
  og_image_version      INTEGER NOT NULL DEFAULT 1,
  is_featured           INTEGER NOT NULL DEFAULT 0 CHECK (is_featured IN (0,1)),
  -- {"whatsapp_group_url":"https://chat.whatsapp.com/...","public_phone":null}
  contact_json          TEXT CHECK (contact_json IS NULL OR json_valid(contact_json)),
  stream_url            TEXT,

  -- ---- per-tournament overrides of the game snapshot ----
  -- The whole effective FieldDef[] for this event: the game's fields at
  -- creation time plus anything the organiser added. Once written it is the
  -- authority; a later catalogue edit does not reach back.
  registration_schema_json TEXT
                          CHECK (registration_schema_json IS NULL OR json_valid(registration_schema_json)),
  format_config_json    TEXT CHECK (format_config_json IS NULL OR json_valid(format_config_json)),
  scoring_config_json   TEXT CHECK (scoring_config_json IS NULL OR json_valid(scoring_config_json)),
  -- The games row snapshot (_version + _content_hash + everything read at
  -- creation), so an organiser can be told "this ran on BGMI definition v3".
  game_snapshot_json    TEXT CHECK (game_snapshot_json IS NULL OR json_valid(game_snapshot_json)),

  -- ---- leaderboard weighting ----
  -- 100 = normal. A marquee event can be 150; a casual scrim 0 (no points).
  leaderboard_weight_pct INTEGER NOT NULL DEFAULT 100 CHECK (leaderboard_weight_pct BETWEEN 0 AND 500),

  -- ---- publication / room-code policy ----
  publish_room_codes         INTEGER NOT NULL DEFAULT 0 CHECK (publish_room_codes IN (0,1)),
  require_dual_confirm_final INTEGER NOT NULL DEFAULT 0 CHECK (require_dual_confirm_final IN (0,1)),

  -- ---- denormalised counters ----
  -- Maintained in the SAME batch as the mutation that changes them. They exist
  -- because the tournament list page would otherwise need one correlated
  -- subquery per card, and D1 charges CPU per request.
  entrant_count         INTEGER NOT NULL DEFAULT 0,
  confirmed_count       INTEGER NOT NULL DEFAULT 0,
  checked_in_count      INTEGER NOT NULL DEFAULT 0,
  waitlist_count        INTEGER NOT NULL DEFAULT 0,

  champion_entrant_id   TEXT,   -- set on completion; no FK, see ARCHITECTURE.md §6.5

  -- ---- concurrency + cache validators ----
  -- `version`        : optimistic lock for organiser edits of the tournament row.
  -- `state_version`  : bumped by ANY mutation visible under /api/v1/tournaments/<slug>/*
  --                    (the row, an entrant, a match, standings, an announcement).
  --                    It is the HTTP ETag validator. Over-invalidation is
  --                    accepted; under-invalidation puts a wrong score on a
  --                    projector.
  -- `bracket_version`: optimistic lock for the whole-bracket recompute. Every
  --                    bump of it MUST bump state_version in the same batch.
  version               INTEGER NOT NULL DEFAULT 1,
  state_version         INTEGER NOT NULL DEFAULT 1,
  bracket_version       INTEGER NOT NULL DEFAULT 0,

  bracket_generated_at  INTEGER,
  published_at          INTEGER,
  results_published_at  INTEGER,
  completed_at          INTEGER,
  cancelled_reason      TEXT,
  created_by            TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  deleted_at            INTEGER,

  CHECK (team_size_max >= team_size_min),
  CHECK (participant_type <> 'solo' OR team_size_max = 1),
  CHECK (registration_closes_at IS NULL OR registration_opens_at IS NULL
         OR registration_closes_at >= registration_opens_at),
  CHECK (checkin_closes_at IS NULL OR checkin_opens_at IS NULL
         OR checkin_closes_at >= checkin_opens_at),
  CHECK (ends_at IS NULL OR ends_at >= starts_at),
  CHECK (max_entrants IS NULL OR max_entrants >= min_entrants),
  CHECK (payment_mode <> 'free' OR entry_fee_paise = 0),
  CHECK (checkin_requires_code = 0 OR checkin_code IS NOT NULL)
) STRICT;

-- Home page + /tournaments/: upcoming public events, soonest first.
CREATE INDEX ix_tournaments_public ON tournaments(status, starts_at)
  WHERE visibility = 'public' AND deleted_at IS NULL;
-- /games/<game-slug> landing pages.
CREATE INDEX ix_tournaments_game   ON tournaments(game_id, starts_at DESC) WHERE deleted_at IS NULL;
-- "My events" for an organiser.
CREATE INDEX ix_tournaments_owner  ON tournaments(owner_user_id, starts_at DESC) WHERE deleted_at IS NULL;
-- Season rollup for the leaderboard recompute.
CREATE INDEX ix_tournaments_season ON tournaments(season_id, status) WHERE season_id IS NOT NULL;
-- Cron: "which events should auto-advance status right now".
CREATE INDEX ix_tournaments_clock  ON tournaments(starts_at) WHERE status IN ('published','registration_open','registration_closed','check_in');

-- ---------------------------------------------------------------------
-- Per-tournament staff grants. A volunteer who scores one carrom event must
-- not become a site-wide organiser. Granting SCOPE here is owner-controlled;
-- granting the organizer ROLE (users.role) is admin-only. Separating them is
-- what stops privilege escalation by an organiser inviting themselves upward.
-- ---------------------------------------------------------------------
CREATE TABLE tournament_organizers (
  tournament_id    TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role             TEXT NOT NULL CHECK (role IN ('owner','organizer','scorer','moderator')),
  added_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  added_at         INTEGER NOT NULL,
  revoked_at       INTEGER,
  PRIMARY KEY (tournament_id, user_id)
) STRICT;

CREATE INDEX ix_torg_user ON tournament_organizers(user_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------
-- Join codes (/j/<code>/) and roster invites (/i/<code>/).
-- Alphabet 23456789BCDFGHJKMNPQRSTVWXYZ (no 0/O/1/I/L, no vowels) because the
-- code is read aloud in a noisy hall. Stored as HMAC(INVITE_PEPPER, code) —
-- unrecoverable after the create response; a lost code is regenerated.
-- ---------------------------------------------------------------------
CREATE TABLE invites (
  id               TEXT PRIMARY KEY CHECK (id GLOB 'inv_*' AND length(id) = 30),
  tournament_id    TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('join','roster')),
  code_hash        TEXT NOT NULL UNIQUE,
  label            TEXT,
  mode             TEXT NOT NULL DEFAULT 'single_use' CHECK (mode IN ('single_use','shared')),
  max_uses         INTEGER NOT NULL DEFAULT 1 CHECK (max_uses >= 1),
  used_count       INTEGER NOT NULL DEFAULT 0,
  entrant_id       TEXT,                       -- roster invites: which entrant it fills
  expires_at       INTEGER,
  revoked_at       INTEGER,
  created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at       INTEGER NOT NULL
) STRICT;

CREATE INDEX ix_invites_tournament ON invites(tournament_id, created_at DESC);

-- 301s after a rename. The Worker looks the old slug up in step 9 of its
-- dispatch order, so an already-forwarded WhatsApp link never dies.
CREATE TABLE slug_redirects (
  from_slug   TEXT PRIMARY KEY CHECK (from_slug = lower(from_slug)),
  to_slug     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
) STRICT;

-- =====================================================================
-- 6. Stages — the reason a qualifier + a final are ONE tournament
-- =====================================================================
--
-- Every tournament has >= 1 stage. A plain 8-player single-elim has exactly one
-- and the organiser never sees the word "stage". Cricket groups -> semis -> final
-- is three. A BGMI event with Day-1 lobbies -> Grand Finals is two.
-- The bracket engine ONLY ever reads stages, never tournaments.format.
-- ---------------------------------------------------------------------
CREATE TABLE stages (
  id                 TEXT PRIMARY KEY CHECK (id GLOB 'stg_*' AND length(id) = 30),
  tournament_id      TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  ordinal            INTEGER NOT NULL CHECK (ordinal >= 1),   -- 1-based; stage 1 runs first
  name               TEXT NOT NULL,             -- 'Group Stage', 'Day 1 Lobbies', 'Playoffs'

  format             TEXT NOT NULL
                       CHECK (format IN ('single_elim','double_elim','round_robin','swiss','points_lobby')),
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','seeding','live','recomputing','completed','cancelled')),

  -- ---- shape ----
  group_count        INTEGER NOT NULL DEFAULT 1 CHECK (group_count >= 1),   -- round_robin groups
  lobby_count        INTEGER NOT NULL DEFAULT 0,                            -- points_lobby: parallel lobbies
  lobby_size         INTEGER,                                               -- points_lobby: entrants per lobby
  rounds_planned     INTEGER,   -- swiss: number of rounds; points_lobby: matches per lobby
  best_of            INTEGER NOT NULL DEFAULT 1 CHECK (best_of >= 1),
  final_best_of      INTEGER,   -- elim: longer final (Bo3 bracket, Bo5 final)
  third_place_match  INTEGER NOT NULL DEFAULT 0 CHECK (third_place_match IN (0,1)),
  -- Validated FormatOptions for the engine (validateOptions()). The engine
  -- reads THIS, not the columns above; the columns exist so the organiser UI
  -- and list queries do not have to parse JSON.
  options_json       TEXT CHECK (options_json IS NULL OR json_valid(options_json)),
  -- fnv1a of the canonical skeleton JSON. Guards against a schema/engine drift
  -- silently producing a different bracket on recompute. Checked ONLY on the
  -- generate path (BRACKET-ENGINE.md §5.3) — never on recompute, because the
  -- entrant list legitimately shrinks after a withdrawal and re-deriving would
  -- fire E_SKELETON_DRIFT on the normal flow.
  skeleton_hash      TEXT,
  -- The canonical Skeleton JSON exactly as generateBracket() returned it,
  -- including `seedList`. Written ONCE, in the generation batch, and never
  -- rewritten. resolveBracket LOADS this; it never regenerates
  -- (BRACKET-ENGINE.md §14.1). Without it the skeleton is unrecoverable after
  -- the first withdrawal, because normalizeEntrants() drops inactive entrants
  -- and would produce a smaller, different bracket.
  skeleton_json      TEXT CHECK (skeleton_json IS NULL OR json_valid(skeleton_json)),

  -- ---- how entrants get in ----
  seed_source        TEXT NOT NULL DEFAULT 'registration'
                       CHECK (seed_source IN ('registration','random','manual','rating','previous_stage')),
  source_stage_id    TEXT REFERENCES stages(id) ON DELETE SET NULL,
  -- Top N per group of the SOURCE stage qualify into this one.
  advance_count      INTEGER,

  -- ---- points (round_robin / swiss) ----
  -- Integers only. Chess's half-point convention is expressed as 2/1/0 with
  -- points_divisor = 2, and rendered as 1 / 0.5 / 0. No REAL columns, ever.
  points_win         INTEGER NOT NULL DEFAULT 3,
  points_draw        INTEGER NOT NULL DEFAULT 1,
  points_loss        INTEGER NOT NULL DEFAULT 0,
  points_bye         INTEGER NOT NULL DEFAULT 3,
  points_divisor     INTEGER NOT NULL DEFAULT 1 CHECK (points_divisor >= 1),

  -- points_lobby placement table / kill value; overrides games.scoring_config_json.
  scoring_config_json TEXT CHECK (scoring_config_json IS NULL OR json_valid(scoring_config_json)),
  -- Ordered tokens; defines what standings.tiebreak_1..5 mean for THIS stage.
  -- snake_case tokens from ARCHITECTURE.md §6.6; the engine maps them to its
  -- camelCase TiebreakKey via the table in BRACKET-ENGINE.md §4.2.
  tiebreakers_json    TEXT CHECK (tiebreakers_json IS NULL OR json_valid(tiebreakers_json)),

  entrant_count       INTEGER NOT NULL DEFAULT 0,
  rounds_completed    INTEGER NOT NULL DEFAULT 0,
  bracket_generated_at INTEGER,
  starts_at           INTEGER,
  completed_at        INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,

  UNIQUE (tournament_id, ordinal),
  CHECK (format <> 'points_lobby' OR (lobby_count >= 1 AND lobby_size >= 2)),
  CHECK (seed_source <> 'previous_stage' OR source_stage_id IS NOT NULL)
) STRICT;

CREATE INDEX ix_stages_tournament ON stages(tournament_id, ordinal);

-- =====================================================================
-- 7. Entrants
-- =====================================================================
--
-- ONE table for all three shapes, because the bracket, the standings and the
-- leaderboard must not care which it is:
--   solo w/ account : user_id set,  is_guest 0
--   team            : user_id = the captain's account (or NULL), roster in entrant_members
--   guest           : user_id NULL, is_guest 1, created by an organiser or via
--                     the guest-token path for a walk-in with no account
--
-- Every registration is internally a team, including a solo chess entry (a team
-- of one). A match is always between two entrant rows and an entrant always has
-- >= 1 member, so the engine, standings and leaderboard have zero solo/team
-- branches. The difference is purely presentational.
--
-- display_name is NOT NULL and always populated — the team name for a team, the
-- player's display name for a solo entry. It is a SNAPSHOT: the bracket renders
-- 40 names without joining users, and a profile rename mid-event cannot rewrite
-- a finished bracket. (The registration wire field `team_name` writes here.)
-- ---------------------------------------------------------------------
CREATE TABLE entrants (
  id               TEXT PRIMARY KEY CHECK (id GLOB 'ent_*' AND length(id) = 30),
  tournament_id    TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  -- Human reference printed on the bracket and shouted across a hall: "#7".
  entrant_no       INTEGER NOT NULL CHECK (entrant_no >= 1),

  display_name     TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 60),
  short_name       TEXT,                        -- <=12 chars for narrow bracket cells
  team_tag         TEXT CHECK (team_tag IS NULL OR length(team_tag) <= 6),
  user_id          TEXT REFERENCES users(id) ON DELETE SET NULL,
  is_guest         INTEGER NOT NULL DEFAULT 0 CHECK (is_guest IN (0,1)),
  -- How this row came to exist. Drives the abuse review queue.
  origin           TEXT NOT NULL DEFAULT 'self'
                     CHECK (origin IN ('self','guest_self','organizer')),

  -- Bearer capability for a guest: HMAC(GUEST_PEPPER, token). Scoped to exactly
  -- this entrant. Re-issuable by an organiser; invalidating the old one.
  guest_token_hash TEXT,
  guest_revoked_at INTEGER,
  guest_phone_enc  BLOB,
  guest_phone_last4 TEXT CHECK (guest_phone_last4 IS NULL OR length(guest_phone_last4) = 4),

  contact_email    TEXT,
  -- Custom field values with scope 'entrant' (squad tag, FIDE ID, club name),
  -- validated against tournaments.registration_schema_json. The public
  -- serializer emits only the keys whose FieldDef.visibility = 'public'.
  fields_json      TEXT CHECK (fields_json IS NULL OR json_valid(fields_json)),

  seed             INTEGER CHECK (seed IS NULL OR seed >= 1),
  seed_locked      INTEGER NOT NULL DEFAULT 0 CHECK (seed_locked IN (0,1)),
  -- SNAPSHOT of the club rating at registration time, for
  -- tournaments.seeding_method = 'rating'. Snapshotted, not joined, so a rating
  -- that moves mid-season cannot re-seed a live event. NULL for teams, guests
  -- and any game with rating.has_rating = 0. This is the engine's
  -- `Entrant.rating` (BRACKET-ENGINE.md §4).
  -- v1 NOTE: nothing writes club ratings yet (API.md §1.12), so this is NULL in
  -- practice and `seeding_method = 'rating'` is refused at the API. The column
  -- exists so enabling ratings is a feature flag, not a migration.
  rating           INTEGER,
  -- Optional organiser-forced round-robin group, 1-based. This is the engine's
  -- `Entrant.groupHint` (BRACKET-ENGINE.md §6.4) and it is an INPUT.
  -- stage_entrants.group_no is the OUTPUT of snake assignment and must NEVER be
  -- fed back in as a hint: every entrant would arrive with group_hint = 1 and a
  -- three-group cricket stage would generate one 24-team round robin.
  group_hint       INTEGER CHECK (group_hint IS NULL OR group_hint >= 1),

  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','confirmed','waitlisted','checked_in',
                                       'withdrawn','disqualified','no_show')),
  status_reason    TEXT,
  -- REQUIRED (non-null) whenever status is 'withdrawn', 'disqualified' or
  -- 'no_show': the engine needs the instant to decide which matches the entrant
  -- forfeits. `no_show` is in this list because the check-in-close cron writes
  -- it (AUTH.md §10) and BRACKET-ENGINE.md §13.3 maps it to `withdrawn`; a
  -- no_show row with a NULL timestamp would make `stored.recordedAt < null`
  -- evaluate false and retroactively forfeit an already-played match.
  status_changed_at INTEGER,
  dq_reason        TEXT,

  checked_in_at    INTEGER,
  checked_in_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  -- Offline guardian consent recorded by an organiser for a minor. See
  -- SECURITY.md §10.5.
  guardian_consent INTEGER NOT NULL DEFAULT 0 CHECK (guardian_consent IN (0,1)),

  payment_status   TEXT NOT NULL DEFAULT 'not_required'
                     CHECK (payment_status IN ('not_required','pending','submitted','paid','refunded','waived')),
  paid_amount_paise INTEGER NOT NULL DEFAULT 0 CHECK (paid_amount_paise >= 0),
  -- The 12-digit UPI UTR typed by the entrant. Globally unique: one screenshot
  -- pasted by four people is the commonest fraud at this scale.
  payment_ref      TEXT,
  payment_method   TEXT CHECK (payment_method IS NULL OR payment_method IN ('upi','cash','waived')),
  paid_at          INTEGER,
  payment_verified_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  payment_verified_at INTEGER,

  -- Final placement in the whole tournament, written when it completes.
  placement        INTEGER,
  prize_paise      INTEGER NOT NULL DEFAULT 0 CHECK (prize_paise >= 0),

  organizer_note   TEXT,                        -- never rendered publicly
  notes            TEXT,                        -- entrant's own note to the organiser
  registered_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  registered_at    INTEGER NOT NULL,
  version          INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,

  UNIQUE (tournament_id, entrant_no),
  CHECK (is_guest = 0 OR user_id IS NULL),
  CHECK (status NOT IN ('withdrawn','disqualified','no_show') OR status_changed_at IS NOT NULL),
  CHECK (status <> 'disqualified' OR dq_reason IS NOT NULL)
) STRICT;

-- One account = one live entry per tournament. Partial so a withdrawal or a DQ
-- frees the slot for a genuine re-registration.
CREATE UNIQUE INDEX ux_entrants_user ON entrants(tournament_id, user_id)
  WHERE user_id IS NOT NULL AND status NOT IN ('withdrawn','disqualified');
-- Seeds are unique within a tournament. Reseeding is therefore a two-statement
-- batch: NULL them all, then assign — never one UPDATE that transiently collides.
CREATE UNIQUE INDEX ux_entrants_seed ON entrants(tournament_id, seed) WHERE seed IS NOT NULL;
-- One UTR, one payment, club-wide.
CREATE UNIQUE INDEX ux_entrants_payment_ref ON entrants(payment_ref) WHERE payment_ref IS NOT NULL;
CREATE UNIQUE INDEX ux_entrants_guest_token ON entrants(guest_token_hash)
  WHERE guest_token_hash IS NOT NULL;
-- Entrant list / check-in screen, ordered as the organiser sees it.
CREATE INDEX ix_entrants_tournament ON entrants(tournament_id, status, entrant_no);
-- "My tournaments" on a player profile.
CREATE INDEX ix_entrants_user       ON entrants(user_id, registered_at DESC) WHERE user_id IS NOT NULL;
-- Organiser payment-verification queue.
CREATE INDEX ix_entrants_payment    ON entrants(tournament_id, payment_status)
  WHERE payment_status IN ('pending','submitted');

-- ---------------------------------------------------------------------
-- Team rosters. tournament_id is denormalised ONLY so that the partial unique
-- index below can exist: SQLite cannot express a cross-table constraint, and
-- "one human, one team, per tournament" is the single most abused rule in
-- amateur esports. Denormalising turns it from a code check into a DB guarantee.
-- The Worker must set entrant_members.tournament_id = entrants.tournament_id.
--
-- A solo entrant has exactly one member row. There are no persistent teams in
-- v1 (ARCHITECTURE.md §9 non-goals); a roster is typed per registration and
-- prefilled from users.profile_answers_json.
-- ---------------------------------------------------------------------
CREATE TABLE entrant_members (
  id            TEXT PRIMARY KEY CHECK (id GLOB 'mem_*' AND length(id) = 30),
  entrant_id    TEXT NOT NULL REFERENCES entrants(id) ON DELETE CASCADE,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,

  display_name  TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 60),
  ingame_id     TEXT,        -- '5123456789' (BGMI), 'Vyshu#IN1' (Riot)
  ingame_name   TEXT,        -- in-game nickname, may differ from display_name
  phone_enc     BLOB,
  phone_last4   TEXT CHECK (phone_last4 IS NULL OR length(phone_last4) = 4),
  slot_no       INTEGER NOT NULL CHECK (slot_no >= 1),
  role          TEXT NOT NULL DEFAULT 'player'
                  CHECK (role IN ('captain','player','substitute','coach','manager')),
  is_substitute INTEGER NOT NULL DEFAULT 0 CHECK (is_substitute IN (0,1)),
  -- Custom field values with scope 'member'.
  fields_json   TEXT CHECK (fields_json IS NULL OR json_valid(fields_json)),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,

  UNIQUE (entrant_id, slot_no)
) STRICT;

-- One human cannot be rostered on two teams in the same tournament.
-- Withdrawing an entrant MUST set its members to status='removed' to release them.
CREATE UNIQUE INDEX ux_member_one_team ON entrant_members(tournament_id, user_id)
  WHERE user_id IS NOT NULL AND status = 'active';
CREATE UNIQUE INDEX ux_member_captain  ON entrant_members(entrant_id)
  WHERE role = 'captain' AND status = 'active';
CREATE INDEX ix_members_entrant ON entrant_members(entrant_id, slot_no);
CREATE INDEX ix_members_user    ON entrant_members(user_id) WHERE user_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- Which entrants are in which stage. Stage 1 is a copy of the confirmed
-- entrants; stage 2+ is populated by seedNextStage(). Without this,
-- "standings of the group stage" and "standings of the playoffs" are the same
-- query and both are wrong.
-- ---------------------------------------------------------------------
CREATE TABLE stage_entrants (
  stage_id        TEXT NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  entrant_id      TEXT NOT NULL REFERENCES entrants(id) ON DELETE CASCADE,
  tournament_id   TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  -- THE CANONICAL SEED. Not the organiser's input seed (that is `entrants.seed`)
  -- but the dense 1..N order that normalizeEntrants() produced at generation
  -- time (BRACKET-ENGINE.md §6.1 step 5), copied from Skeleton.seedList.
  -- Written once, in the generation batch, and IMMUTABLE thereafter. Every
  -- tiebreak chain in the engine terminates in `seed`, so if this drifts the
  -- standings order stops being reproducible across two requests.
  seed            INTEGER CHECK (seed IS NULL OR seed >= 1),
  -- DERIVED OUTPUT of snake assignment. Never read back as `Entrant.groupHint`
  -- — that input lives on entrants.group_hint.
  group_no        INTEGER NOT NULL DEFAULT 1 CHECK (group_no >= 1),
  lobby_no        INTEGER,
  source_stage_id TEXT REFERENCES stages(id) ON DELETE SET NULL,
  source_rank     INTEGER,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','eliminated','advanced','withdrawn','disqualified')),
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (stage_id, entrant_id)
) STRICT;

CREATE UNIQUE INDEX ux_stage_entrants_seed ON stage_entrants(stage_id, seed) WHERE seed IS NOT NULL;
CREATE INDEX ix_stage_entrants_entrant ON stage_entrants(entrant_id);
CREATE INDEX ix_stage_entrants_group   ON stage_entrants(stage_id, group_no, seed);

-- =====================================================================
-- 8. Matches — the bracket node
-- =====================================================================
--
-- ONE table covers every format:
--   single_elim   bracket='W'  (+ 'GF'-free), sources point BACKWARDS
--   double_elim   bracket in ('W','L','GF'), `conditional` marks GF2
--   round_robin   bracket='RR', group_no set
--   swiss         bracket='SW'
--   points_lobby  bracket='BR', lobby_no set, slot_count = lobby size,
--                 participants live in match_participants,
--                 entrant_a_id/entrant_b_id are NULL
--
-- ---------------------------------------------------------------------
-- DIRECTION OF THE POINTERS. Slots reference their SOURCE
-- (`a_source_kind` + `a_source_match_id`), never their destination. This is
-- not cosmetic: the engine never advances a bracket incrementally, it
-- re-derives every participant by folding forwards over the skeleton in
-- topological order. A destination pointer (`winner_to_match_id`) only works
-- for a push-based advance, whose rollback path is the least-tested code in
-- every tournament product and the classic way a live bracket gets corrupted.
-- With source pointers, correcting a score two rounds back is the same code
-- path as entering it.
--
-- `entrant_a_id`, `entrant_b_id`, `status`, `winner_entrant_id`,
-- `loser_entrant_id` are DERIVED — a materialised view of the fold. Only the
-- recompute diff writes them. The source of truth is
-- (skeleton, entrants, recorded results).
-- ---------------------------------------------------------------------
CREATE TABLE matches (
  id                TEXT PRIMARY KEY CHECK (id GLOB 'mat_*' AND length(id) = 30),
  tournament_id     TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  stage_id          TEXT NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  -- Human reference: "Match 14". Unique per TOURNAMENT, printed on the sheet the
  -- scorer carries around the hall, and the /t/<slug>/m/<matchNo>/ segment.
  -- The engine's SkeletonMatch.number is stage-LOCAL (1..K per skeleton), so the
  -- persistence adapter must offset it:
  --   match_no = COALESCE((SELECT MAX(match_no) FROM matches
  --                         WHERE tournament_id = ?), 0) + skeletonMatch.number
  -- computed ONCE before the batch. Without the offset, stage 2 of a
  -- groups -> playoff tournament collides on (tournament_id, 1) and the whole
  -- second-stage generation fails after the group stage has been played.
  match_no          INTEGER NOT NULL CHECK (match_no >= 1),
  -- The engine's own MatchId: 'W2-3', 'L4-1', 'GF', 'GF2', 'G1R3-2', 'S4-7',
  -- 'P2-L3'. Unique within a stage. The persistence adapter maps code -> id
  -- before the batch, so every FK below is a real ULID.
  code              TEXT NOT NULL,
  -- Suggested chronological run order within the stage (§9.6 of BRACKET-ENGINE).
  play_order        INTEGER NOT NULL DEFAULT 0,

  bracket           TEXT NOT NULL CHECK (bracket IN ('W','L','GF','RR','SW','BR')),
  round             INTEGER NOT NULL CHECK (round >= 1),
  -- 0-based index within (stage_id, bracket, round) — STAGE-GLOBAL, not
  -- group-local. For a grouped round robin the generator emits groups in
  -- ascending group_no and, within a group, ascending match index, assigning
  -- position 0,1,2,… sequentially across the whole round
  -- (BRACKET-ENGINE.md §10.3). Group-local indices would collide on
  -- ux below for every multi-group stage. For bracket = 'BR',
  -- position = lobby_no - 1.
  position          INTEGER NOT NULL CHECK (position >= 0),
  round_label       TEXT,        -- 'Quarter-final', 'Round 3', 'Lobby 2 — Match 3' (ASCII English)
  round_label_key   TEXT,        -- stable i18n key for the same thing
  group_no          INTEGER,     -- round_robin
  lobby_no          INTEGER,     -- points_lobby
  slot_count        INTEGER NOT NULL DEFAULT 2 CHECK (slot_count >= 2),

  -- ---- slot sources: where each participant comes from ----
  -- NOTE ON THE SELF-FK ACTION. These are deliberately the SQLite default,
  -- ON DELETE NO ACTION (deferred to end-of-statement), and NOT `RESTRICT`.
  -- SQLite enforces RESTRICT *immediately, per row*, so a bulk
  -- `DELETE FROM matches WHERE tournament_id = ?` — which is exactly what
  -- DELETE .../bracket, POST .../bracket with force:true, and the orphan
  -- cleanup all run — aborts the instant it removes W1-1 while W2-1 (which
  -- sources it) is still present. Table-scan row order is arbitrary, so no
  -- delete ordering avoids it. NO ACTION checks at end of statement, by which
  -- time both rows are gone and the constraint is satisfied. The guard that
  -- actually matters ("refuse to delete a bracket that has completed matches")
  -- lives in the application, where it can return 409 with a reason.
  a_source_kind     TEXT NOT NULL DEFAULT 'none'
                      CHECK (a_source_kind IN ('entrant','winner','loser','none')),
  a_source_match_id TEXT REFERENCES matches(id) ON DELETE NO ACTION,
  a_source_entrant_id TEXT REFERENCES entrants(id) ON DELETE SET NULL,
  b_source_kind     TEXT NOT NULL DEFAULT 'none'
                      CHECK (b_source_kind IN ('entrant','winner','loser','none')),
  b_source_match_id TEXT REFERENCES matches(id) ON DELETE NO ACTION,
  b_source_entrant_id TEXT REFERENCES entrants(id) ON DELETE SET NULL,
  -- Swiss only: 1 when no legal non-rematch pairing existed for this board.
  -- Part of the canonical skeleton JSON that skeleton_hash is computed over, so
  -- it must round-trip through the database.
  had_rematch       INTEGER NOT NULL DEFAULT 0 CHECK (had_rematch IN (0,1)),

  -- ---- derived participants (written only by the recompute diff) ----
  entrant_a_id      TEXT REFERENCES entrants(id) ON DELETE SET NULL,
  entrant_b_id      TEXT REFERENCES entrants(id) ON DELETE SET NULL,
  -- Placeholder text shown before the feeder match resolves: 'Winner of #12'.
  -- Derived at generation time so the public bracket needs no reverse lookup.
  slot_a_label      TEXT,
  slot_b_label      TEXT,

  best_of           INTEGER NOT NULL DEFAULT 1 CHECK (best_of >= 1),
  -- 1 only for a double-elimination bracket reset (GF2), which may never be
  -- played. A conditional match resolves to 'void' when it is not needed.
  conditional       INTEGER NOT NULL DEFAULT 0 CHECK (conditional IN (0,1)),

  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','ready','live','complete','bye','void')),
  winner_entrant_id TEXT REFERENCES entrants(id) ON DELETE SET NULL,
  loser_entrant_id  TEXT REFERENCES entrants(id) ON DELETE SET NULL,
  is_draw           INTEGER NOT NULL DEFAULT 0 CHECK (is_draw IN (0,1)),

  -- The canonical comparable number for the game: runs, goals, maps won, sets
  -- won, points. INTEGER, always. Rich per-game detail goes in
  -- result_detail_json, which the engine never inspects — that contract is what
  -- keeps the engine game-agnostic.
  score_a           INTEGER,
  score_b           INTEGER,
  bonus_a           INTEGER,
  bonus_b           INTEGER,
  bonus_note        TEXT,
  side_a            TEXT CHECK (side_a IS NULL OR side_a IN ('W','B')),   -- chess colours

  -- THE PARTICIPANTS AS RECORDED. Written by the score endpoint at the instant
  -- the result is stored, from the entrant ids the organiser actually saw, and
  -- NEVER touched by the recompute diff. They are the only legitimate source of
  -- HeadToHeadResult.entrantAId / entrantBId (BRACKET-ENGINE.md §7.3 step 7).
  -- entrant_a_id / entrant_b_id must NOT be used for this: those are derived
  -- columns the diff rewrites, so comparing a stored result against them
  -- compares the recompute against its own previous output. §14.4 splits a
  -- large correction across several batches, so a failure between batches can
  -- leave a match carrying NEW participants and a STALE result; with these
  -- columns the next resolve detects the mismatch and invalidates, instead of
  -- silently crediting one pair's score to a different pair.
  -- Cleared to NULL whenever the result is cleared.
  result_entrant_a_id TEXT REFERENCES entrants(id) ON DELETE NO ACTION,
  result_entrant_b_id TEXT REFERENCES entrants(id) ON DELETE NO ACTION,
  method            TEXT CHECK (method IS NULL OR method IN
                      ('normal','walkover','forfeit','dq','no_contest')),
  --  cricket {"innings":[{"runs":164,"wickets":6,"overs":"20.0","batting":"a"}]}
  --  chess   {"opening":"C50","moves":41,"pgn_url":"..."}
  --  cs2     {"maps":[{"name":"Mirage","a":16,"b":12}]}
  --  badminton {"sets":[[21,19],[15,21],[21,17]]}
  result_detail_json TEXT CHECK (result_detail_json IS NULL OR json_valid(result_detail_json)),

  -- ---- logistics ----
  scheduled_at      INTEGER,
  started_at        INTEGER,
  completed_at      INTEGER,
  venue_id          TEXT REFERENCES venues(id) ON DELETE SET NULL,
  -- Generic, game-agnostic physical slot: 'Court 2', 'Board 5', 'Table 3'.
  station_label     TEXT,
  -- Custom-lobby credentials. The API returns these only to checked-in entrants
  -- of this match and to staff, and publicly only when the tournament sets
  -- publish_room_codes = 1 AND room_code_publish_at <= now.
  room_code         TEXT,
  room_password     TEXT,
  room_code_publish_at INTEGER,
  stream_url        TEXT,
  referee_note      TEXT,                        -- organiser-only

  -- ---- concurrency ----
  -- ONE counter for the whole row. Two organisers on two phones at the same
  -- table: UPDATE ... WHERE id = ? AND result_version = ?; meta.changes = 0
  -- -> 409 stale_version and the second scorer re-reads.
  result_version    INTEGER NOT NULL DEFAULT 0,
  -- Dual confirmation of a final: the first submitter's user id. A DIFFERENT
  -- organiser must then call .../confirm.
  pending_confirm_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  confirmed_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  recorded_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  recorded_at       INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,

  UNIQUE (tournament_id, match_no),
  UNIQUE (stage_id, code),
  UNIQUE (stage_id, bracket, round, position),
  CHECK (entrant_a_id IS NULL OR entrant_b_id IS NULL OR entrant_a_id <> entrant_b_id),
  -- Lobbies keep their participants in match_participants and have no slots.
  CHECK (bracket <> 'BR' OR (entrant_a_id IS NULL AND entrant_b_id IS NULL)),
  CHECK (bracket = 'BR' OR slot_count = 2),
  CHECK (a_source_kind <> 'entrant' OR a_source_entrant_id IS NOT NULL),
  CHECK (b_source_kind <> 'entrant' OR b_source_entrant_id IS NOT NULL),
  CHECK (a_source_kind NOT IN ('winner','loser') OR a_source_match_id IS NOT NULL),
  CHECK (b_source_kind NOT IN ('winner','loser') OR b_source_match_id IS NOT NULL),
  CHECK (a_source_match_id IS NULL OR a_source_match_id <> id),
  CHECK (b_source_match_id IS NULL OR b_source_match_id <> id)
) STRICT;

-- The public bracket render: every match of a stage in draw order, one query.
CREATE INDEX ix_matches_stage    ON matches(stage_id, bracket, round, position);
-- "What's on now" / organiser console for the whole event.
CREATE INDEX ix_matches_live     ON matches(tournament_id, status, scheduled_at);
-- A player's fixtures ("your next match is on Court 2").
CREATE INDEX ix_matches_entrant_a ON matches(entrant_a_id) WHERE entrant_a_id IS NOT NULL;
CREATE INDEX ix_matches_entrant_b ON matches(entrant_b_id) WHERE entrant_b_id IS NOT NULL;
-- Forward lookup used by the recompute diff to find the matches a result feeds.
CREATE INDEX ix_matches_src_a    ON matches(a_source_match_id) WHERE a_source_match_id IS NOT NULL;
CREATE INDEX ix_matches_src_b    ON matches(b_source_match_id) WHERE b_source_match_id IS NOT NULL;
-- Round-robin standings recompute reads a group at a time.
CREATE INDEX ix_matches_group    ON matches(stage_id, group_no, round) WHERE group_no IS NOT NULL;
-- Suggested run order for the scheduler and the "next unscored match" control.
CREATE INDEX ix_matches_order    ON matches(stage_id, play_order);

-- ---------------------------------------------------------------------
-- Battle-royale / points-lobby participants: N entrants share ONE matches row.
-- 24 rows for a 4-lobby, 6-round event instead of 600 pairwise rows; a lobby
-- result is therefore atomic and fits one small batch inside D1's result caps.
--
-- The computed point columns are PLAIN, not GENERATED, because the formula
-- lives in stages.scoring_config_json (tournament data) and a generated column
-- would freeze it into the DDL — changing a placement table would then need a
-- full table rebuild instead of an UPDATE. Points are recomputed server-side on
-- every write; the client never submits a total.
-- ---------------------------------------------------------------------
CREATE TABLE match_participants (
  match_id         TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  entrant_id       TEXT NOT NULL REFERENCES entrants(id) ON DELETE CASCADE,
  stage_id         TEXT NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  tournament_id    TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  slot_no          INTEGER NOT NULL CHECK (slot_no >= 1),

  placement        INTEGER CHECK (placement IS NULL OR placement >= 1),
  kills            INTEGER NOT NULL DEFAULT 0 CHECK (kills >= 0),
  placement_points INTEGER NOT NULL DEFAULT 0,
  kill_points      INTEGER NOT NULL DEFAULT 0,
  bonus_points     INTEGER NOT NULL DEFAULT 0,
  penalty_points   INTEGER NOT NULL DEFAULT 0,
  total_points     INTEGER NOT NULL DEFAULT 0,
  disqualified     INTEGER NOT NULL DEFAULT 0 CHECK (disqualified IN (0,1)),
  note             TEXT,

  damage           INTEGER,                 -- optional tiebreaker / bragging rights
  survival_time_s  INTEGER,
  status           TEXT NOT NULL DEFAULT 'registered'
                     CHECK (status IN ('registered','played','no_show','disqualified')),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,

  PRIMARY KEY (match_id, entrant_id),
  UNIQUE (match_id, slot_no)
) STRICT;

-- Live lobby scoreboard, ordered.
CREATE INDEX ix_mp_match   ON match_participants(match_id, total_points DESC);
-- Stage standings recompute: every lobby result for an entrant.
CREATE INDEX ix_mp_entrant ON match_participants(stage_id, entrant_id);

-- ---------------------------------------------------------------------
-- Append-only result history. Distinct from audit_log on purpose: this is the
-- evidence a score dispute is settled with at a live event, it is queried by
-- match, and it must never be pruned with the general audit trail.
-- A row is written for EVERY result write, correction and clear, in the SAME
-- batch as the mutation. Non-negotiable.
-- ---------------------------------------------------------------------
-- FK NOTE. match_id is deliberately NULLABLE with ON DELETE SET NULL, not
-- NOT NULL + CASCADE. There is a fully reachable path that would otherwise
-- destroy exactly the evidence this table exists for: an organiser enters a
-- wrong score (a `result_set` row is written), calls .../reopen (a
-- `result_cleared` row is written and the match un-completes), and the
-- tournament now has zero completed matches — which is precisely the
-- precondition DELETE .../bracket requires. That delete would cascade away the
-- whole dispute trail. `match_code` and `match_no` are denormalised so the
-- history stays readable after the matches row is gone. Only tournament_id
-- CASCADEs, and tournaments are soft-deleted.
CREATE TABLE match_audit (
  id            TEXT PRIMARY KEY CHECK (id GLOB 'mad_*' AND length(id) = 30),
  match_id      TEXT REFERENCES matches(id) ON DELETE SET NULL,
  match_code    TEXT NOT NULL,          -- 'W2-3', 'G1R3-2', 'P2-L3' — survives the delete
  match_no      INTEGER NOT NULL,       -- 'Match 14' — survives the delete
  stage_id      TEXT REFERENCES stages(id) ON DELETE SET NULL,
  tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  at            INTEGER NOT NULL,
  kind          TEXT NOT NULL
                  CHECK (kind IN ('result_set','result_corrected','result_cleared','status_forced')),
  before_json   TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json    TEXT CHECK (after_json  IS NULL OR json_valid(after_json)),
  -- Public on the bracket for 48h after a correction. Silent score edits are
  -- what destroy trust in a club's results.
  reason        TEXT
) STRICT;

CREATE INDEX ix_match_audit_match ON match_audit(match_id, at DESC) WHERE match_id IS NOT NULL;
CREATE INDEX ix_match_audit_code  ON match_audit(tournament_id, match_code, at DESC);
CREATE INDEX ix_match_audit_tour  ON match_audit(tournament_id, at DESC);

-- =====================================================================
-- 9. Standings — materialised, per stage
-- =====================================================================
--
-- Rejected: a SQL VIEW. Swiss tiebreakers (Buchholz, Sonneborn-Berger) are
-- recursive over opponents' scores and are not expressible as one cheap SQLite
-- query; and the standings page is the second-hottest public read, so paying
-- that cost on every request burns the Worker's per-request CPU budget.
-- Rejected: compute-in-Worker-on-read. Same cost, plus it makes the table
-- ordering non-deterministic between two concurrent readers mid-round.
--
-- Chosen: recompute the affected stage inside the SAME batch() as the score
-- write. A stage is bounded (tens to low hundreds of entrants), so the
-- recompute is a delete + bulk insert of a small set, and a rollback of the
-- score rolls back the standings with it.
-- ---------------------------------------------------------------------
CREATE TABLE standings (
  stage_id       TEXT NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  entrant_id     TEXT NOT NULL REFERENCES entrants(id) ON DELETE CASCADE,
  tournament_id  TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  group_no       INTEGER NOT NULL DEFAULT 1,

  rank           INTEGER NOT NULL,
  played         INTEGER NOT NULL DEFAULT 0,
  wins           INTEGER NOT NULL DEFAULT 0,
  draws          INTEGER NOT NULL DEFAULT 0,
  losses         INTEGER NOT NULL DEFAULT 0,
  walkovers      INTEGER NOT NULL DEFAULT 0,
  byes           INTEGER NOT NULL DEFAULT 0,

  -- Divide by stages.points_divisor for display (chess: 2/1/0 -> 1/0.5/0).
  points         INTEGER NOT NULL DEFAULT 0,
  score_for      INTEGER NOT NULL DEFAULT 0,   -- runs / goals / set points / kills
  score_against  INTEGER NOT NULL DEFAULT 0,
  score_diff     INTEGER NOT NULL DEFAULT 0,

  -- points_lobby only.
  kills          INTEGER NOT NULL DEFAULT 0,
  placement_points INTEGER NOT NULL DEFAULT 0,
  best_placement INTEGER,

  -- Generic tiebreak slots. What they hold is declared, in order, by
  -- stages.tiebreakers_json — so adding Sonneborn-Berger to chess is data.
  -- Rational tiebreaks (net_run_rate, set_ratio) are stored x1000 as integers,
  -- and MAY be negative (net run rate routinely is), which is why there is no
  -- >= 0 CHECK here.
  --
  -- FIVE slots, not three. Chess ships
  --   points, buchholz_cut1, buchholz, sonneborn_berger, head_to_head, wins, seed
  -- and round robin's default (BRACKET-ENGINE.md §10.5) has four tiebreaks past
  -- `points`. With three slots a chess or carrom standings row could not be
  -- reconstructed for the `columns` array of GET .../standings, and the
  -- engine's emitted chain would be silently truncated.
  --
  -- NORMATIVE: exactly the first FIVE comparators after `points` are persisted
  -- and emitted as columns. The engine's chain may be longer (it always appends
  -- `seed`); anything past slot 5 participates in the sort but is not stored and
  -- is not a column. `seed` is never stored in a slot — it is on stage_entrants.
  tiebreak_1     INTEGER NOT NULL DEFAULT 0,
  tiebreak_2     INTEGER NOT NULL DEFAULT 0,
  tiebreak_3     INTEGER NOT NULL DEFAULT 0,
  tiebreak_4     INTEGER NOT NULL DEFAULT 0,
  tiebreak_5     INTEGER NOT NULL DEFAULT 0,
  -- Human sentence for the row that explains why it sits where it does.
  tiebreak_note  TEXT,

  status         TEXT NOT NULL DEFAULT 'active'
                   CHECK (status IN ('active','eliminated','advanced','withdrawn','disqualified')),
  is_qualified   INTEGER NOT NULL DEFAULT 0 CHECK (is_qualified IN (0,1)),
  computed_at    INTEGER NOT NULL,

  PRIMARY KEY (stage_id, entrant_id)
) STRICT;

-- The standings table render: one group, in rank order.
CREATE INDEX ix_standings_stage   ON standings(stage_id, group_no, rank);
CREATE INDEX ix_standings_entrant ON standings(entrant_id);

-- =====================================================================
-- 10. Cross-tournament leaderboard
-- =====================================================================
--
-- Two objects, on purpose:
--   points_ledger       append-only, one row per award. The provenance, and the
--                       signed rows that make `unpublish` a delete + recompute
--                       rather than arithmetic guesswork.
--   leaderboard_entries materialised totals. Always re-derivable from the ledger.
-- Corrections are a NEW ledger row or a void — never an UPDATE of a total — so
-- "why do I have 85 points?" is always answerable.
--
-- Points are awarded to the USER, once, on the transition to `completed`
-- (POST .../publish). For a team entrant every linked roster member gets the
-- award; unlinked (guest) members get nothing, because there is no account to
-- credit. See ARCHITECTURE.md §6.7.
-- ---------------------------------------------------------------------
CREATE TABLE points_ledger (
  id             TEXT PRIMARY KEY CHECK (id GLOB 'led_*' AND length(id) = 30),
  season_id      TEXT NOT NULL REFERENCES seasons(id) ON DELETE RESTRICT,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id        TEXT NOT NULL REFERENCES games(id) ON DELETE RESTRICT,
  -- RESTRICT: the database refuses to let a hard delete destroy leaderboard
  -- provenance. Tournaments are soft-deleted, so this never fires in practice —
  -- it fires when someone runs a stray DELETE in the D1 console.
  tournament_id  TEXT REFERENCES tournaments(id) ON DELETE RESTRICT,
  entrant_id     TEXT REFERENCES entrants(id) ON DELETE SET NULL,

  reason         TEXT NOT NULL
                   CHECK (reason IN ('placement','participation','bonus','penalty','adjustment')),
  placement      INTEGER,
  points         INTEGER NOT NULL,        -- may be negative for penalty/adjustment
  note           TEXT,

  created_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at     INTEGER NOT NULL,
  voided_at      INTEGER,
  voided_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  void_reason    TEXT
) STRICT;

-- Recompute a season/game bucket, and render "how I earned these points".
CREATE INDEX ix_ledger_season_user ON points_ledger(season_id, user_id) WHERE voided_at IS NULL;
CREATE INDEX ix_ledger_tournament  ON points_ledger(tournament_id);
CREATE INDEX ix_ledger_user        ON points_ledger(user_id, created_at DESC);

CREATE TABLE leaderboard_entries (
  -- 'all_time' or 'season:<season_slug>'. Nothing else in v1: rolling windows
  -- need a rollup job nobody is building yet (ARCHITECTURE.md §9).
  period         TEXT NOT NULL,
  -- NULL = the overall, all-games board. Non-NULL = a per-game board.
  game_id        TEXT REFERENCES games(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  points         INTEGER NOT NULL DEFAULT 0,
  events_played  INTEGER NOT NULL DEFAULT 0,
  wins           INTEGER NOT NULL DEFAULT 0,     -- match wins
  titles         INTEGER NOT NULL DEFAULT 0,     -- 1st places
  podiums        INTEGER NOT NULL DEFAULT 0,     -- top 3
  best_finish    INTEGER,
  rating         INTEGER,                        -- mirrored from player_ratings when metric=rating
  rank           INTEGER NOT NULL DEFAULT 0,
  previous_rank  INTEGER,                        -- for the up/down arrow
  last_played_at INTEGER,
  computed_at    INTEGER NOT NULL
) STRICT;

-- SQLite treats NULLs as distinct in a UNIQUE index, so a single
-- UNIQUE(period, game_id, user_id) would silently allow duplicate rows on
-- the overall board. Two partial indexes are the correct fix.
CREATE UNIQUE INDEX ux_leaderboard_overall ON leaderboard_entries(period, user_id)
  WHERE game_id IS NULL;
CREATE UNIQUE INDEX ux_leaderboard_game    ON leaderboard_entries(period, game_id, user_id)
  WHERE game_id IS NOT NULL;
-- The board itself: top N of a period, overall or filtered by game.
CREATE INDEX ix_leaderboard_overall_rank ON leaderboard_entries(period, rank) WHERE game_id IS NULL;
CREATE INDEX ix_leaderboard_game_rank    ON leaderboard_entries(period, game_id, rank) WHERE game_id IS NOT NULL;
CREATE INDEX ix_leaderboard_user         ON leaderboard_entries(user_id);

-- ---------------------------------------------------------------------
-- Optional club ratings for games with has_rating = 1 (chess, carrom).
-- Glicko-style: rating + deviation, both INTEGER. Not required for launch; the
-- table exists so enabling it is a feature flag, not a migration.
-- ---------------------------------------------------------------------
CREATE TABLE player_ratings (
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_id       TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  rating_kind   TEXT NOT NULL,             -- 'classical' | 'rapid' | 'blitz' | 'standard'
  rating        INTEGER NOT NULL DEFAULT 1500,
  deviation     INTEGER NOT NULL DEFAULT 350,
  games_played  INTEGER NOT NULL DEFAULT 0,
  is_provisional INTEGER NOT NULL DEFAULT 1 CHECK (is_provisional IN (0,1)),
  peak_rating   INTEGER,
  last_played_at INTEGER,
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, game_id, rating_kind)
) STRICT;

CREATE INDEX ix_ratings_board ON player_ratings(game_id, rating_kind, rating DESC);

-- =====================================================================
-- 11. Content
-- =====================================================================

CREATE TABLE announcements (
  id            TEXT PRIMARY KEY CHECK (id GLOB 'ann_*' AND length(id) = 30),
  -- 'club' = site-wide banner. 'tournament' = pinned to that tournament page.
  scope         TEXT NOT NULL CHECK (scope IN ('club','tournament')),
  tournament_id TEXT REFERENCES tournaments(id) ON DELETE CASCADE,
  title         TEXT NOT NULL CHECK (length(title) <= 100),
  body_md       TEXT NOT NULL CHECK (length(body_md) <= 4000),
  -- Closed-allowlist AST compiled by the Worker at write time. The client never
  -- receives HTML and never calls dangerouslySetInnerHTML.
  body_ast_json TEXT CHECK (body_ast_json IS NULL OR json_valid(body_ast_json)),
  severity      TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','important','urgent')),
  is_pinned     INTEGER NOT NULL DEFAULT 0 CHECK (is_pinned IN (0,1)),
  promote_to_club INTEGER NOT NULL DEFAULT 0 CHECK (promote_to_club IN (0,1)),
  author_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  published_at  INTEGER,
  edited_at     INTEGER,
  expires_at    INTEGER,
  deleted_at    INTEGER,
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,

  CHECK (scope <> 'tournament' OR tournament_id IS NOT NULL)
) STRICT;

CREATE INDEX ix_announce_tournament ON announcements(tournament_id, published_at DESC)
  WHERE tournament_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX ix_announce_club       ON announcements(published_at DESC)
  WHERE scope = 'club' AND deleted_at IS NULL;

-- =====================================================================
-- 12. Audit log
-- =====================================================================
--
-- Every organiser and admin mutation. before_json/after_json hold ONLY the
-- changed keys, not full row snapshots: a 90-column tournament snapshotted on
-- every edit would become the largest table in the database within a season.
-- Result history lives in match_audit, not here.
-- ---------------------------------------------------------------------
CREATE TABLE audit_log (
  -- ULID: monotonic by creation time, so the PK index IS the chronological index.
  id               TEXT PRIMARY KEY CHECK (id GLOB 'aud_*' AND length(id) = 30),
  at               INTEGER NOT NULL,
  actor_user_id    TEXT REFERENCES users(id) ON DELETE SET NULL,  -- NULL = cron/system
  actor_role       TEXT,
  actor_session_id TEXT,
  actor_ip_hash    TEXT,      -- HMAC(IP_HASH_KEY, ip). Never the raw address.

  -- Dotted verb: tournament.publish, bracket.generate, match.score_set,
  -- match.reopen, entrant.check_in, entrant.disqualify, entrant.payment_verify,
  -- entrant.contact.view, entrants.export.contact, user.role, session.revoke,
  -- points.adjust, game.create, settings.update
  action           TEXT NOT NULL,
  entity_type      TEXT NOT NULL
                     CHECK (entity_type IN ('tournament','stage','entrant','entrant_member','match',
                                            'match_participant','standings','user','game','venue',
                                            'session','credential','points_ledger','announcement',
                                            'season','invite','setting')),
  entity_id        TEXT,
  -- Denormalised so an organiser can pull "everything that happened in my event"
  -- in one indexed query instead of a union across entity types.
  tournament_id    TEXT REFERENCES tournaments(id) ON DELETE SET NULL,

  before_json      TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json       TEXT CHECK (after_json  IS NULL OR json_valid(after_json)),
  summary          TEXT NOT NULL,   -- rendered directly in the activity feed
  request_id       TEXT,            -- the X-Request-Id the caller was given

  created_at       INTEGER NOT NULL
) STRICT;

CREATE INDEX ix_audit_tournament ON audit_log(tournament_id, at DESC) WHERE tournament_id IS NOT NULL;
CREATE INDEX ix_audit_entity     ON audit_log(entity_type, entity_id, at DESC);
CREATE INDEX ix_audit_actor      ON audit_log(actor_user_id, at DESC);

-- =====================================================================
-- 13. Idempotency and rate limiting
-- =====================================================================
--
-- "Did my POST go through?" on patchy 4G. A registration POST that times out
-- client-side has almost certainly reached the Worker; the retry must not
-- create a second entrant. The row is completed in the SAME batch as the
-- business mutation, so a stored "success" cannot exist without the mutation.
-- ---------------------------------------------------------------------
CREATE TABLE idempotency_keys (
  -- user id, or 'g:'||sha256(guest_token), or 'ip:'||ip_hash
  scope             TEXT NOT NULL,
  key               TEXT NOT NULL CHECK (length(key) <= 64),
  endpoint          TEXT NOT NULL,
  request_hash      TEXT NOT NULL,
  -- 0 = in flight; otherwise the HTTP status that was returned.
  status            INTEGER NOT NULL DEFAULT 0,
  response_body     TEXT,
  response_truncated INTEGER NOT NULL DEFAULT 0 CHECK (response_truncated IN (0,1)),
  created_at        INTEGER NOT NULL,
  completed_at      INTEGER,
  expires_at        INTEGER NOT NULL,
  PRIMARY KEY (scope, key)
) STRICT;

CREATE INDEX ix_idem_expiry ON idempotency_keys(expires_at);

-- Long-window (per-hour, per-day) counters that must be globally accurate.
-- Short windows (10 s / 60 s) use the Cloudflare Workers Rate Limiting binding
-- instead and never touch D1. One helper in the Worker owns both.
CREATE TABLE rate_counters (
  bucket       TEXT NOT NULL,
  key          TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  expires_at   INTEGER NOT NULL,
  PRIMARY KEY (bucket, key, window_start)
) STRICT;

CREATE INDEX ix_rate_counters_expiry ON rate_counters(expires_at);
