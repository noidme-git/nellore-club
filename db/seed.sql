-- nellore.club — bootstrap seed.
--
--   npm run db:seed:local     (after npm run db:local)
--   npm run db:seed:remote
--
-- This file inserts exactly TWO rows: one season and one venue. That is not
-- minimalism for its own sake — it is the two rows that cannot be created
-- through the product before the product works.
--
--   * `tournaments.season_id` is what the cross-tournament leaderboard groups by,
--     and `ux_seasons_active` allows exactly one active season, so the very first
--     tournament created needs one to already exist.
--   * `tournaments.venue_id` is required by the create-tournament wizard's step 3.
--
-- Everything else has a proper writer and must not appear here:
--   * The 20 games come from `npm run seed:games` (scripts/seed-games.ts), which
--     re-asserts every db/schema.sql CHECK in JavaScript first, resolves the
--     `$preset` references in content/games.json, and is idempotent by content
--     hash. A hand-written INSERT here would be a second, silently diverging
--     copy of the catalogue (CONTENT.md §7).
--   * `schema_meta` and the five `version.*` `settings` rows are inserted by
--     db/schema.sql itself.
--   * The first admin user is minted by the auth bootstrap ceremony from
--     ADMIN_BOOTSTRAP_TOKEN and nowhere else (AUTH.md); a seeded admin row would
--     be an account with no credential that the bootstrap check then refuses to
--     replace.
--
-- Re-runnable: both statements are `ON CONFLICT(id) DO NOTHING` against a fixed
-- id, so applying the file twice is a no-op. Deliberately NOT `INSERT OR IGNORE`,
-- which would also swallow a CHECK violation and turn a broken seed into a
-- silently empty database.
--
-- Money is INTEGER paise and time is INTEGER unix SECONDS everywhere
-- (ARCHITECTURE.md §6.4, §6.5). The two literals below are IST midnight
-- boundaries: 1774981800 = 2026-04-01 00:00 IST, 1806517800 = 2027-04-01 00:00 IST.

-- ---------------------------------------------------------------------------
-- Season
--
-- April–March, matching the Indian financial year and the way local clubs
-- already talk about a season; the slug form `2026-27` is the one API.md §4.2
-- returns. `is_active = 1` and `ux_seasons_active` together mean this is THE
-- current season until an admin explicitly rolls it over.
--
-- `points_scheme_json` is the default award curve from the db/schema.sql comment:
-- the top eight placements score, everyone who plays scores 5, and an event with
-- fewer than 4 entrants awards nothing (which is what stops two friends farming
-- the leaderboard with a two-person "tournament").
-- ---------------------------------------------------------------------------
INSERT INTO seasons (
  id, slug, name, starts_at, ends_at, is_active, points_scheme_json, version, created_at, updated_at
) VALUES (
  'sea_01M1P52DG1D5YTMQ8H0MJD1YV8',
  '2026-27',
  'Season 2026-27',
  1774981800,
  1806517800,
  1,
  '{"placement":[100,70,50,35,25,20,15,10],"participation":5,"min_entrants":4}',
  1,
  unixepoch(),
  unixepoch()
)
ON CONFLICT(id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Venue
--
-- `Online` and not a physical address, deliberately. content/club.json records
-- `location.venues: []` and `venue_policy: "We do not own a ground. Each event
-- names its venue on the tournament page…"`, and `location.address_lines` is
-- null and flagged TODO_VERIFY. Seeding a plausible-looking street address here
-- is exactly the failure the TODO_VERIFY gate exists to prevent: it would be
-- screenshotted into a WhatsApp group and people would drive to it.
--
-- `is_online = 1` is also immediately useful rather than a stand-in — the BGMI
-- and Free Fire events in content/games.json genuinely have no venue, and
-- `venues.is_online` is what the schedule UI branches on. Physical venues are
-- created through /admin/ once their address has been verified.
-- ---------------------------------------------------------------------------
INSERT INTO venues (
  id, name, area, address, maps_url, is_online, capacity, is_active, sort_order, version, created_at, updated_at
) VALUES (
  'ven_01M1P52DG3HGHDE4EEBTGS6TZD',
  'Online',
  NULL,
  NULL,
  NULL,
  1,
  NULL,
  1,
  10,
  1,
  unixepoch(),
  unixepoch()
)
ON CONFLICT(id) DO NOTHING;
