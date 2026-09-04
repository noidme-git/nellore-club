# CONTENT.md — the game-agnostic content model

This document defines the **game definition format** that makes nellore.club serve BGMI, chess and
box cricket from one codebase, plus how club content and editorial voice work.

The claim this document has to hold up is narrow and testable:

> **Adding a game is adding a row. It is never a code change.**

If you ever find yourself writing `if (game.slug === 'bgmi')` in application code, the format has
failed and you should extend the format rather than the branch. The one legitimate `switch` in the
whole system is over `scoring.model`, which is a closed set of five engines — and even that has an
escape hatch (`manual`) so a genuinely novel game still ships as data.

Files owned here:

| File | What it is |
| --- | --- |
| `content/games.json` | Seed catalog. 20 games across 3 categories. Authoring source of truth. |
| `content/club.json` | Club identity, story, contact, FAQ, code of conduct, policies. |
| `docs/CONTENT.md` | This file. |
| `docs/OPERATIONS.md` | How the club actually runs an event. |

---

## 1. Where content lives, and which copy wins

There are two stores and they are not equals.

```
content/games.json  ──seed──▶  D1 `games` table  ──snapshot──▶  tournaments + stages rows
   (authoring SoT)              (runtime SoT)                    (immutable per tournament)
```

**`content/games.json` is the authoring source of truth.** It is in git, it is reviewable in a
diff, and it is where a human edits a game.

**The D1 `games` table is the runtime source of truth.** Nothing at request time reads the JSON
file. The Worker reads D1. This matters because a game must be editable without a redeploy — an
organizer bumping the default entry fee for badminton at 9 PM on a Friday should not need a build.

**The tournament's copy is an immutable snapshot.** When a tournament is created, the resolved game
definition is copied out of `games` and into the tournament's own rows — `tournaments.
extra_fields_json` for registration fields, `stages.scoring_config_json` and `stages.
tiebreakers_json` and the `points_*` columns for scoring, `tournaments.leaderboard_weight_pct` for
the leaderboard. Every later read for that tournament — the registration form, the score-entry form,
standings, tiebreakers — uses the tournament's copy, never the live `games` row. `db/schema.sql`
states the same rule in its `games` header comment.

> **Rejected alternative:** having tournaments join to `games` at read time. It is one fewer copy
> and one fewer sync problem, and it is wrong. If somebody edits the BGMI placement-points table
> mid-series, every already-played match silently re-scores and the standings change under the
> players' feet. Worse, if somebody adds a required registration field after 40 squads registered,
> those 40 registrations become retroactively invalid. Snapshotting costs about 6 KB of TEXT per
> tournament and removes a whole class of bug. Take the 6 KB.

Conflict rule when the file and the table disagree: **the seed script overwrites the table.** If an
organizer edited a game through the admin UI and somebody then re-runs the seed, the edit is lost.
That is deliberate and the admin UI must warn about it. Admin edits are for same-day tweaks; git is
for anything you want to keep.

`content/club.json` is different: it is **build-time only**. It is imported directly by the Next.js
pages and baked into the static export. There is no `club` table. Changing club copy is a redeploy,
which is correct — the About page does not need to change at 9 PM on a Friday.

---

## 2. The game definition, field by field

A game is one object in the `games` array of `content/games.json`.

### 2.1 Identity

| Key | Type | Req | Notes |
| --- | --- | --- | --- |
| `slug` | string | ✅ | Stable primary key. `^[a-z0-9]+(-[a-z0-9]+)*$`. Appears in URLs (`/games/bgmi/`). **Never change a slug** once a tournament references it. |
| `name` | string | ✅ | Display name. ≤ 24 chars. `"BGMI"`, `"Box cricket"`. |
| `full_name` | string | ✅ | Formal name for headings and OG text. `"Battlegrounds Mobile India"`. |
| `short_name` | string | ✅ | ≤ 10 chars. Used in bracket cells on 360 px screens where the full name would wrap. |
| `category` | string | ✅ | `esport` \| `board` \| `outdoor`. Hard CHECK constraint on `games.category` — these three exact strings, singular, no others. |
| `status` | enum | ✅ | `active` \| `beta` \| `disabled` \| `archived`. Authoring-level nuance; D1 has only `games.is_active` (0/1). `active` and `beta` seed as 1, `disabled` and `archived` as 0. Only `active` and `beta` can have new tournaments created — that check reads the snapshot, not `is_active`. |
| `sort_order` | integer | ✅ | Ascending within a category. Leave gaps of 10 so a game can be inserted without renumbering. |
| `tagline` | string | ✅ | ≤ 60 chars, one line, sits under the name on the game card. |
| `description` | string | ✅ | 2–4 sentences. Shown on `/games/<slug>/` and used as the fallback meta description. |
| `search_terms` | string[] | ✅ | Aliases for the game picker. This is why typing "pubg" finds BGMI and "ping pong" finds table tennis. Lowercase. Include common misspellings — `"kabbadi"` is in there on purpose. |
| `icon` | object | ✅ | `{ emoji, sprite }`. Only `emoji` is rendered in v1; see §2.9. |
| `accent` | string | ✅ | Hex. Seeds `games.accent_hex`. See §2.9. |
| `subcategory` | string | ✅ | Free-text filter bucket: `battle_royale`, `fps`, `sports_sim`, `strategy`, `mind`, `tile`, `word`, `card`, `racket`, `team_sport`. Deliberately not an enum — a new sub-genre must never need a migration. |
| `primary_ingame_id_field` / `primary_ingame_id_label` | string \| null | ✅ | Names the one field that is *the* in-game identity for this game. Seeds `games.needs_ingame_id`, `ingame_id_label` and `ingame_id_pattern`, and populates `entrant_members.ingame_id`. `null` for games with no in-game ID (all outdoor sports, carrom, scrabble). |
| `rating` | object | ✅ | `{ has_rating, rating_kinds[] }`. Seeds `games.has_rating` / `rating_kinds_json` and drives the `player_ratings` table. Only chess sets `has_rating: true` today. |
| `age_min` | integer | ✅ | Minimum age for the game itself. A tournament may raise it, never lower it. |
| `equipment` | string[] | ✅ | What the player brings. Shown as a checklist on the tournament page. Can be `[]`. |
| `rules_summary` | string[] | ✅ | 4–6 lines. The rules that actually cause arguments, not a full rulebook. Rendered as a list on the tournament page and included in the printed bracket pack. |
| `rules_url` | string \| null | ✅ | Link to the full rulebook if one exists. `null` is fine and common. |

### 2.2 `compliance`

```json
"compliance": {
  "real_money_prizes_allowed": true,
  "review_required": false,
  "notes": "Skill-based esports with a fixed participation fee."
}
```

Not decoration. `real_money_prizes_allowed: false` **must** force `entry_fee_inr = 0` and block a
cash prize table at tournament creation, in the API, not just in the UI. `review_required: true`
means an organizer sees a blocking warning before the tournament can be published.

This exists because of one real case: `rummy-points` ships with `status: "disabled"` and
`review_required: true` because Andhra Pradesh restricts gaming for stakes and central law restricts
online money games. Encoding that as data means the next person who adds a card game inherits the
guard rail instead of rediscovering the problem.

### 2.3 `participant`

```json
"participant": {
  "type": "team",
  "team_size_min": 4,
  "team_size_max": 4,
  "substitutes_max": 1,
  "captain_required": true,
  "member_label": "Player",
  "roster_locked_at": "check_in",
  "allow_partial_roster": true,
  "free_agent_pool": true
}
```

| Key | Notes |
| --- | --- |
| `type` | `solo` \| `team`. Matches `games.default_participant_type`. |
| `supports_pairs` | Informational: does this game also have a legitimate doubles/pairs form? True for carrom, badminton and table tennis. Seeds `games.supports_pairs`. |
| `team_size_min` / `team_size_max` | Playing members, excluding substitutes. `solo` is always `1/1`. |
| `substitutes_max` | Additional roster members who may replace a player. `0` means none. |
| `captain_required` | If true, exactly one roster member must be flagged captain. Captain's contact is the one the organizer uses; captain's UPI ID receives team prize money. |
| `member_label` | Singular noun for a roster row: `"Player"`, `"Partner"`. Drives every string in the roster UI. |
| `roster_locked_at` | `registration` \| `check_in` \| `never`. After the lock point, roster edits require an organizer. |
| `allow_partial_roster` | If true, a team can register with fewer than `team_size_min` and complete the roster by the lock point. Essential in practice — captains register at midnight and chase IDs for two days. |
| `free_agent_pool` | If true, an individual can register without a team and be picked up. |

**Every registration is a team internally, including a solo one.** A chess entry is a team of one.
This is what removes `if (solo)` from the API, the bracket engine and the standings code — a match
is always between two `registration` rows, and a registration always has ≥ 1 member.

The difference is purely presentational and is driven by `type`:

- `solo` → render `member_fields` inline in the main form. No "Member 1" heading, no add/remove row.
- `team` with `team_size_min == team_size_max == 2` → two fixed member blocks labelled with
  `member_label` + ordinal ("Partner 1", "Partner 2"). No add/remove row.
- `team` → a repeater from `team_size_min` to `team_size_max + substitutes_max`, with rows past
  `team_size_max` marked "Substitute".

**Rejected alternative:** a separate `solo_registrations` table. It halves the JSON per chess entry
and doubles every query, every bracket function and every standings calculation in the system. No.

### 2.4 `registration_fields` and `member_fields` — the escape hatch

These are the two arrays that make the platform game-agnostic. Both are arrays of **FieldDef**
(§3).

- `registration_fields` — asked **once per entry**. Team name, captain's WhatsApp, jersey colour,
  preferred slot, category entered.
- `member_fields` — asked **once per roster member**. In-game name, BGMI player ID, jersey number,
  chess rating.

The split is the whole design. Get it wrong and you end up with `player1_ign`, `player2_ign`,
`player3_ign` hardcoded somewhere, which is exactly the failure this format exists to prevent.

Storage:

- `entrants.fields_json` — a JSON object keyed by FieldDef `key`, for `registration_fields`.
- `entrant_members.fields_json` — same, per roster member, for `member_fields`.

Both arrays are seeded into the single `games.registration_fields_json` column as one concatenated
array, each element tagged `"scope": "entrant"` or `"scope": "member"`. The split back into two
arrays happens at render time. See §6.2.

### 2.5 `tournament_defaults`

Prefills the "create tournament" form. An organizer can override every one of these. They are
defaults, not constraints — except `min_participants`, which the bracket engine enforces at publish.

```json
"tournament_defaults": {
  "format": "round_robin",
  "multi_stage": true,
  "seeding": "random",
  "third_place_match": true,
  "min_participants": 6,
  "max_participants": 24,
  "check_in_opens_minutes_before": 60,
  "check_in_closes_minutes_before": 15,
  "entry_fee_inr_default": 1200,
  "typical_duration_minutes": 600,
  "rounds": 7
}
```

`format` ∈ `single_elim` | `double_elim` | `round_robin` | `swiss` | `points_lobby` — exactly the five
in the `games.default_format` CHECK constraint.

`multi_stage` is a boolean hint, **not** a format. When true, the create-tournament form pre-builds
two `stages` rows — a `round_robin` group stage feeding a `single_elim` knockout — and the
tournament itself is stored with `format = 'multi_stage'`. Seven games set it: Valorant, EA FC, box
cricket, table tennis, volleyball, throwball and kabaddi. This is why the game-level enum stays at
five: a group-then-knockout event is two stages, not a sixth format, and `stages` is the authority.
`seeding` ∈ `random` | `rating` | `manual` | `registration` | `previous_stage` — exactly the
`stages.seed_source` CHECK. `rating` resolves to `player_ratings` when the game sets
`rating.has_rating: true` (chess only), and falls back to the player's current season leaderboard
position otherwise. That fallback is why EA FC can ask to be seeded on form without the platform
running an Elo for it.
`rounds` is only read when `format` is `swiss` or `points_lobby`; omit it otherwise.

`entry_fee_inr_default` is authored as an **integer number of rupees** — no paise, no decimals, in
the content file or in any player-facing string. D1 stores money in **paise** (`entry_fee_paise`,
`paid_amount_paise`, `prize_paise`), so the seed and the API multiply by 100 on the way in and divide
on the way out. Rupees is the authoring and display unit; paise is the storage unit; the boundary is
the API, and it is crossed in exactly two places. `typical_duration_minutes` is what the organizer needs to book a venue for, not what
one match takes.

### 2.6 `match_defaults`

```json
"match_defaults": {
  "best_of": 1,
  "duration_minutes": 30,
  "buffer_minutes": 10,
  "venue_kind": "online",
  "needs_lobby_code": true,
  "lobby_code_label": "Room ID",
  "lobby_password_label": "Room password",
  "time_control": "30+10"
}
```

`venue_kind` ∈ `online` | `onsite` | `hybrid`. Drives whether the tournament page shows a map pin
or a lobby panel.

`duration_minutes + buffer_minutes` is the slot the scheduler allocates per match. Buffer is real:
it is the time it takes twelve squads to actually get into a lobby.

`needs_lobby_code` is why the format does not need a "is this an esport?" flag anywhere. A LAN CS2
match needs a server string; a badminton match does not. `lobby_code_label` and
`lobby_password_label` supply the exact words the organizer sees, so BGMI says "Room ID" and CS2
says "Server connect string" with no code knowing either.

`time_control` is optional and free-form; chess uses it, nothing else does. Displayed verbatim.

### 2.7 `scoring`

```json
"scoring": {
  "model": "h2h_sets",
  "side_labels": ["Player A", "Player B"],
  "side_assignment": "coin_toss",
  "params": { ... },
  "match_fields": [ FieldDef, ... ]
}
```

`model` is one of exactly five — the `games.scoring_model` CHECK constraint. This is the only
closed set in the format that requires code:

| Model | What it computes | Used by |
| --- | --- | --- |
| `h2h_simple` | Two sides, one integer each. `supports_draw` allows draws; `higher_score_wins: false` inverts it. Chess's 1 / 0.5 / 0 is this model with draws on and `standings.match_points` supplying the halves. | EA FC, COD Mobile, Clash Royale, Scrabble, kabaddi, chess ×2 — **7 games** |
| `h2h_sets` | Sets / games / boards / maps, each entry in `matches.result_detail_json` (there is no `match_games` table). Point target, win-by, optional cap, different deciding set. | Badminton ×2, table tennis, volleyball, throwball, carrom ×2, Valorant, CS2 — **9 games** |
| `h2h_innings` | Two innings of runs / wickets / overs in `matches.result_detail_json`, net run rate, super over. | Box cricket |
| `br_points` | Placement points table + kill points, N entrants sharing one `matches` row via `match_participants`, aggregated across matches. Pairs with the `points_lobby` **format**. | BGMI, Free Fire |
| `manual` | The organizer declares the result, optionally with a number per entrant that the stage aggregates. Supports `lower_wins`, `aggregate` and `drop_worst`. | Rummy — **and any future game that fits nothing above** |

**`manual` is the guarantee.** A game the club invents next month — a gaming quiz, a
speedcubing ladder, a PES penalty shootout — is expressible as "each participant gets a number per
match, sum or average it, high or low wins". So the five-model set is not a ceiling on what games
can exist; it is a ceiling on how *well* the platform models them. Ship the new game on
`manual` immediately, and promote it to a purpose-built model later if it earns one.

`side_labels` names the two sides for display: `["White","Black"]`, `["CT","T"]`,
`["Batting first","Batting second"]`. Empty array for free-for-all models.

`side_assignment` ∈ `none` | `random` | `alternate` | `coin_toss` | `toss` | `knife_round` |
`home_away` | `higher_seed_picks`. Chess uses `alternate` because Swiss colour allocation must
alternate across rounds; cricket uses `toss` because the result of the toss is itself recorded data.

`params` is model-specific and documented per model in §5.

`match_fields` is **a FieldDef array again** — the same type as registration fields. This is what
makes score entry game-agnostic. The score form is not written per game; it is rendered from
`match_fields`. Cricket's form has toss, runs, wickets, overs and super over. Badminton's has one
text field for set scores. Neither exists in code.

Convention: score fields for the two sides are keyed `score_a` / `score_b` (and `pens_a` / `pens_b`,
`crowns_a` / `crowns_b`, etc.). `_a` is always the first-listed side, `_b` the second. The scoring
engines read these keys; keep the convention.

### 2.8 `standings` and `leaderboard`

```json
"standings": {
  "match_points": { "win": 2, "draw": 1, "loss": 0, "no_result": 1,
                    "walkover_win": 2, "forfeit_loss": 0, "points_divisor": 1 },
  "tiebreakers": ["points", "net_run_rate", "head_to_head", "wins", "random"]
}
```

```json
"match_points": { "win": 2, "draw": 1, "loss": 0, "no_result": 1,
                  "walkover_win": 2, "forfeit_loss": 0, "points_divisor": 2 }
```

**All values are integers.** Chess's 1 / 0.5 / 0 is stored as 2 / 1 / 0 with `points_divisor: 2` and
rendered by dividing. `db/schema.sql` has integer `points_win` / `points_draw` / `points_loss` /
`points_bye` columns plus `points_divisor` on `stages`, and no REAL column anywhere — for good
reason. Standings sorting compares points for equality on every tiebreak step, and float equality is
where "these two teams are tied" quietly becomes "these two teams are not tied" at the third decimal
place. Fourteen games use `points_divisor: 1`; chess, blitz chess and scrabble use 2.

Table points genuinely differ by sport: football-style formats use 3/1/0, cricket and carrom 2/1/0,
kabaddi 5/3/0. That is why it is data.

`no_result`, `walkover_win` and `forfeit_loss` have no `stages` columns; they ride in
`stages.scoring_config_json`.

`tiebreakers` is an ordered list of keys applied in sequence until one separates. It seeds
`games.default_tiebreakers_json`, which is a plain JSON array with no CHECK — so the token set is
extensible without a migration, but the standings engine only resolves what it implements.

Tokens in use, and what each means:

| Token | Meaning |
| --- | --- |
| `points` | Standings points from `standings.match_points`. Almost always first. |
| `wins` | Count of wins, ignoring draws. |
| `head_to_head` | Result of the match between the tied entrants. Undefined for 3+ way ties — put something after it. |
| `score_diff` | Points/goals/runs for minus against. |
| `score_for` | Points/goals/runs scored. |
| `kills` | `br_points` only. Total kills across the series. |
| `best_placement` | `br_points` only. Best single-match finish. |
| `buchholz`, `buchholz_cut1` | Swiss: sum of opponents' scores, cut1 dropping the lowest. Chess uses `buchholz_cut1` first. |
| `sonneborn_berger` | Swiss: sum of defeated opponents' scores plus half of drawn opponents'. |
| `set_ratio` | `h2h_sets` only. Sets won ÷ sets lost. Required for a correct badminton or volleyball group table. |
| `net_run_rate` | `h2h_innings` only. See §5. Required for a correct cricket group table. |
| `fewest_losses` | Fewer losses ranks higher. |
| `random` | Deterministic PRNG seeded on `tournament_id + entrant_ids`, so it is reproducible and auditable rather than a literal coin toss. |

`set_ratio`, `net_run_rate` and `buchholz_cut1` are **not** in the illustrative list in the schema
comment and the standings engine must implement them. They are not optional garnish: without
`net_run_rate` a 6-team cricket group with two teams on 4 points cannot be resolved correctly, and
without `set_ratio` neither can a badminton group.

**Always terminate the list with `random`.** A tiebreak chain that can return "still
tied" leaves the bracket engine with nowhere to go, and it will happen — two squads on 0 points and
0 kills is a normal Tuesday.

```json
"leaderboard": { "counts_toward_global": true, "default_weight_pct": 150 }
```

`default_weight_pct` is an **integer percent**, matching `tournaments.leaderboard_weight_pct`
(CHECK 0–500, default 100). It scales this game's contribution to the cross-game season leaderboard:
winning a day-long kabaddi tournament (150) is worth more than winning a two-hour Clash Royale
bracket (60). Set `counts_toward_global: false` — which seeds `0` — for exhibition or disabled
games. A tournament may override it; this is the default the create form offers.

### 2.9 `icon` and `accent`

```json
"icon": { "emoji": "🏏", "sprite": "game-box-cricket" },
"accent": "#1D4ED8"
```

**There is no sprite sheet in v1, and `games.icon_url` is seeded as `NULL`.** `DESIGN.md` §7
rejects `<use href="/icons.svg#x">` outright — it is one extra request with a 400 ms RTT penalty on
4G and it is render-blocking for above-the-fold icons — and that rejection wins, because twenty
pieces of per-game art is a launch-blocking art task in exchange for a 24 px glyph.

**What actually renders a game in v1**: the category glyph (`gamepad` / `pawn` / `ball`, three of
the 28 inline icons in `DESIGN.md` §7), tinted with `accent`, next to `short_name`. That is
zero bytes of new asset per game and it is why adding Chess960 is genuinely one JSON object.

`emoji` stays in the content file and stays mandatory: it is the lead glyph in the WhatsApp
announcement templates (§10.4) and in the printed pack, where an inline SVG is not available.
`sprite` stays as a forward-compatible id for whenever somebody does draw the set; nothing reads it
today.

`accent` must reach **4.5:1 contrast against white** because it is used for text, not only for
fills. Every accent currently in the file passes — the lowest is `#A16207` (CS2) at 4.92:1. Verify
a new one before committing:

```sh
node -e 'const h=process.argv[1].slice(1),c=[0,2,4].map(i=>parseInt(h.slice(i,i+2),16)/255).map(x=>x<=.03928?x/12.92:((x+.055)/1.055)**2.4),L=.2126*c[0]+.7152*c[1]+.0722*c[2];console.log((1.05/(L+.05)).toFixed(2))' "#1D4ED8"
```

Tints and shades are derived in CSS from the base. Do not add a second colour to the definition.

---

## 3. The FieldDef type

One type, used in three places: `registration_fields`, `member_fields`, `scoring.match_fields`.
Extending it extends all three at once.

```ts
type FieldType =
  | 'text' | 'textarea' | 'integer' | 'decimal' | 'tel' | 'email' | 'url'
  | 'date' | 'time' | 'select' | 'multiselect' | 'boolean' | 'color';

interface FieldDef {
  key: string;                  // ^[a-z][a-z0-9_]{0,39}$ — the JSON key in fields_json. Stable forever.
  type: FieldType;
  label: string;                // Sentence case. What the player reads above the input.
  help?: string;                // One sentence under the input. Say where to find the value.
  placeholder?: string;         // A real example, never a repeat of the label.
  required: boolean;
  visibility: 'public' | 'organizer' | 'private';
  pii: boolean;                 // Drives the DPDP retention purge. See §3.3.
  profile_key?: string;         // Prefill from the player's saved profile. See §3.4.
  default?: string | number | boolean | null;
  options?: { value: string; label: string }[];   // select / multiselect only. Required for them.
  validation?: Validation;
  visible_if?: Condition;       // Conditional display. See §3.5.
}

interface Validation {
  min?: number;                 // integer, decimal
  max?: number;                 // integer, decimal
  step?: number;                // decimal
  min_length?: number;          // text, textarea
  max_length?: number;          // text, textarea, tel, url, email
  pattern?: string;             // JS RegExp source, anchored. text, tel, url, email
  pattern_message?: string;     // Shown instead of a raw regex when pattern fails. Mandatory if pattern is set.
  must_be?: true;               // boolean only — the field must be checked (consent gates)
  min_selected?: number;        // multiselect
  max_selected?: number;        // multiselect
}

type Condition =
  | { field: string; equals: string | number | boolean }
  | { field: string; in: (string | number)[] }
  | { field: string; not_empty: true }
  | { field: string; lt: number }
  | { field: string; gt: number };
```

### 3.1 Validation must run on the server

The Worker re-validates every FieldDef against the **snapshot** definition before writing
`fields_json`. Client-side validation is a courtesy. `pattern` is compiled with `new RegExp(p)` —
patterns in this file are written anchored with `^…$` and must stay that way, and must not use
backreferences or nested unbounded quantifiers (ReDoS on a Worker CPU budget is a real denial of
service, not a theoretical one).

**Unknown keys: dropped on `PATCH`, rejected on `POST`.** One rule per method, and both halves
matter:

| Method | Unknown key | Why |
| --- | --- | --- |
| `POST .../register`, `.../guest-register`, `POST /organizer/tournaments/:id/entrants`, `POST /invites/:code/accept` | **rejected** — `400 validation_failed`, `details.fields[key] = "unknown_field"` | A first submission is authored against the schema the client just fetched. A key it does not recognise means a stale client or a probe, and there is no half-filled entry to protect. Silently dropping a field the organiser added yesterday is how a tournament ends up with half its entrants missing an in-game ID. |
| `PATCH /entrants/:id`, `PATCH /guest/entrant`, `PATCH /organizer/entrants/:id` | **dropped**, silently | A player who registered before a field was added must still be able to edit their entry. `PATCH .../entrants/:id` replaces `members` wholesale (API.md §3.6.1), so rejecting here would hard-block a legitimate edit on a key the player never sent. |

**Missing *required* keys are never dropped, on either method.** On `PATCH`, a `required` field
absent from both the stored `fields_json` and the patch is reported as `"required"` and the edit is
refused, so the form surfaces the newly added field. It is only *unknown* keys that vanish.

API.md §3.3 states the identical rule and owns the wire reason codes; this table and that one must
never diverge.

### 3.2 `visibility`

| Value | Public API (`/api/tournaments/*`, bracket, standings) | Organizer API | Export |
| --- | --- | --- | --- |
| `public` | included | included | included |
| `organizer` | **stripped** | included | included |
| `private` | **stripped** | **stripped** — only in the single-registration detail view | included |

Stripping happens in one serializer, driven by the snapshot definition. It is not a hand-maintained
allowlist per endpoint, because that allowlist will drift and the first thing to leak will be a
phone number.

Default when omitted: `organizer`. Fail closed.

### 3.3 `pii`

Marks a field whose value is personal data about an identifiable human under India's DPDP Act.
It is **not** the same as `visibility`:

- `player_name` is `visibility: "public"` (it is on the bracket) **and** `pii: true`.
- `jersey_colour` is `visibility: "public"` and `pii: false`.
- `bgmi_player_id` is `visibility: "organizer"` and `pii: false` — it identifies a game account, not
  a person, and it is exactly what a squad needs to be added to a lobby next season.

`pii: true` drives the retention purge job (`OPERATIONS.md` §13.3): 18 months after a player's last
event, every `pii: true` value in their `entrants.fields_json` / `entrant_members.fields_json` is
replaced with `null` and their display name becomes `Player #<id>`. Match results and scores
survive; the person does not.

Three fields are promoted out of the JSON blob into real columns by the API on write, because the
schema has typed homes for them and the purge jobs and the organizer screens need to find them
without parsing every blob:

| FieldDef | Promoted to | Blob keeps |
| --- | --- | --- |
| `player_name` (member scope) | `entrant_members.display_name` | the value |
| the primary in-game ID (member scope) | `entrant_members.ingame_id` | the value |
| any `type: "tel"` field, **entrant** scope | **`entrants.guest_phone_enc`** (AES-256-GCM, AAD = the entrant id) + `entrants.guest_phone_last4` | **the mask only** |
| any `type: "tel"` field, **member** scope | **`entrant_members.phone_enc`** (AAD = the member id) + `entrant_members.phone_last4` | **the mask only** |

Those are the real column names in `db/schema.sql`. Earlier drafts of this section named
`entrant_members.phone` and (§3.4) `players.phone`; **neither column exists** — the identity table
is `users`, and every phone is encrypted at rest under `PII_KEY` (SECURITY.md §10.2).

**A `tel` value is the one promotion where the blob does NOT keep the value.** `fields_json` gets
only `"+91 ••••• •4417"`. `content/games.json`'s `field_presets` ship four `tel`, `pii: true`
fields — `captain_whatsapp`, `alt_whatsapp`, `player_whatsapp`, `guardian_whatsapp` — on the default
form of every team game, and `GET /organizer/tournaments/:id/entrants` returns custom fields of
every visibility, paginated at 100 and un-audited. Storing the plaintext in the blob would hand out
up to 100 WhatsApp numbers per call and bypass the entire audited-single-lookup design
(SECURITY.md §10.2.1). Because the mask is what is *stored*, no serializer can leak the number by
forgetting a rule. The plaintext is reachable only through
`GET /api/v1/organizer/entrants/:id/contact`.

When two `tel` fields share a scope, the **first in schema order** owns the encrypted column and the
rest are stored masked-only.

For the other promotions the value lives in **both** places: the column is the queryable copy and
the blob is the record of what was asked. **Purging must null both** (`AUTH.md` §10.5, §10.6).

### 3.4 `profile_key` — the prefill escape hatch

A returning player should not retype a 10-digit BGMI ID on a 4G connection at 11 PM.

`profile_key` is a namespaced key into **`users.profile_answers_json`** — a flat JSON object
keyed by `profile_key`, not by game slug:

```json
{ "core.whatsapp": "••••• •4417", "bgmi.player_id": "5123456789",
  "bgmi.ign": "NLRxRahul", "chess.rating": "1450", "valorant.riot_id": "Rahul#NLR" }
```

Note `core.whatsapp` is stored **masked** here, like every other `pii: true` `tel` value. This blob
is sent to the client on every form render; it is a prefill cache, not a store of record. The
canonical number is `users.phone_enc`, and the Worker substitutes the real value server-side when
the player submits the prefilled field unchanged.

On form render the client fetches the signed-in player's saved values and prefills any field with a
matching key. On successful submit, the values are written back with a single JSON merge.

Namespacing convention:

- `core.*` — cross-game: `core.full_name`, `core.whatsapp`, `core.age`, `core.locality`,
  `core.device_model`, `core.discord`.
- `<game-family>.*` — game-specific: `bgmi.player_id`, `chess.rating`, `valorant.riot_id`.

Use the **family**, not the slug, so `chess-classical` and `chess-blitz` share `chess.rating`, and
`badminton-singles` and `badminton-doubles` share `badminton.level`. Keying by game slug instead
would give blitz chess its own rating and re-ask a badminton player for their playing level in the
doubles draw — which is the whole thing this field exists to avoid. The schema comment on that
column shows slug keys as an example; **the key is a `profile_key`, and the column is a free-form
JSON blob with no constraint, so this needs no DDL change.**

`core.whatsapp` is a special case: it also has a typed home in **`users.phone_enc`** (AES-256-GCM
ciphertext of the E.164 form, `+91…`), with `users.phone_hash` as the blind index and
`users.phone_last4` in the clear. There is no `players` table and no plaintext phone column
anywhere. `users.phone_enc` is the canonical contact; the `core.whatsapp` value stored in
`users.profile_answers_json` is the **masked** 10-digit form used to *label* a prefilled `tel` field
("use my saved number ••••• •4417"), not the number itself — `profile_answers_json` is returned to
the client on form render, so it must not carry a plaintext number either. Write both, derive one
from the other, never let them disagree, and purge both together.

Prefilled values are always editable and never silently submitted — the field shows its value with a
"from your profile" hint.

### 3.5 `visible_if`

Conditional fields without conditional code. Two live examples:

```json
{ "key": "guardian_whatsapp", "visible_if": { "field": "age", "lt": 18 } }
{ "key": "rating_source",     "visible_if": { "field": "rating", "not_empty": true } }
```

Rules:

- `field` must reference a key **in the same array** (a `member_fields` condition cannot look at a
  `registration_fields` answer). Keeps evaluation local and cheap.
- A hidden field is **never required**, whatever `required` says, and its value is dropped on submit.
- No nesting, no `and`/`or`. If you need boolean logic, you need two fields.

### 3.6 The three hard cases

The format was designed against these three and adjusted until none of them needed a special case.

**Case 1 — a BGMI squad: four players, each with an IGN and a numeric player ID, plus one
substitute.**
`participant.type = "team"`, `team_size_min = team_size_max = 4`, `substitutes_max = 1`.
`member_fields` = `[ign, bgmi_player_id, player_whatsapp?, device_model?]`. The UI renders 4 required
rows plus 1 optional substitute row. `roster_locked_at: "check_in"` with
`allow_partial_roster: true` means the captain registers alone at midnight and fills in IDs before
check-in.
→ No repeating-group field type needed. The roster **is** the repeat, and it is a first-class
platform concept because check-in, substitutions and player stats all need it. This is why rosters
are not modelled as a `roster` FieldDef.

**Case 2 — a chess player with a FIDE or Lichess rating.**
`participant.type = "solo"`, so `member_fields` is empty and everything sits in
`registration_fields`: `rating` (`integer`, 400–3200, `profile_key: "chess.rating"`),
`rating_source` (`select`, shown only when `rating` is filled), `fide_id` (`text`, pattern
`^[0-9]{6,10}$`), `online_handle`.
→ Rating is an ordinary optional integer with a range. `seeding: "rating"` in
`tournament_defaults` tells the bracket engine to sort by it — and the engine reads the field named
by `seeding`, it does not know the word "chess".

**Case 3 — a cricket team with a captain's phone number and a jersey colour.**
`registration_fields` = `[team_name, captain_name, captain_whatsapp (tel, pii, organizer-visible,
Indian mobile pattern), alt_whatsapp, jersey_colour (color, public), locality, preferred_slot,
home_ground, agree_rules]`. `member_fields` = `[player_name, jersey_number (integer 0–99), role
(select), player_whatsapp?]`.
→ `color` earns its place as a type: a hex value needs a swatch input, not a text box, and it needs
to be renderable as a dot next to the team name on the bracket. `tel` earns its place because it
needs `inputmode="numeric"`, `autocomplete="tel-national"` and a distinct pattern message.

None of the three required a new concept. That is the test passing.

---

## 4. `field_presets` — composition without code

Top of `content/games.json`:

```json
"field_presets": {
  "captain_whatsapp": { "key": "captain_whatsapp", "type": "tel", "label": "Captain's WhatsApp number", ... }
}
```

Used in a game as:

```json
{ "$preset": "captain_whatsapp" }
{ "$preset": "team_name", "label": "Pair name", "required": false, "help": "Optional." }
```

**Resolution:** shallow merge, sibling keys win, `$preset` itself removed.

```
resolved = { ...field_presets[obj.$preset], ...obj }   // then delete resolved.$preset
```

Shallow, so overriding one key of `validation` means restating the whole `validation` object. That
is on purpose — deep merge makes it impossible to *remove* a constraint, and "why is max_length
still 10" is a bad afternoon.

Resolution happens **once, in the seed script**. What lands in D1 is fully expanded. The Worker
never sees a `$preset` and needs no resolver. If a `$preset` names a key that does not exist, the
seed script exits non-zero and writes nothing.

There are 15 presets covering the fields that repeat across games: contact numbers, names, age,
guardian contact, Nellore locality, preferred slot, jersey colour and number, device model, Discord,
and the rules-consent checkbox.

> **Rejected alternative:** repeating the full field object in every game. It is simpler to read in
> isolation, and it means the Indian mobile-number regex is written eleven times. The eleventh copy
> will be wrong, and it will be wrong in the field that carries a phone number. Presets cost one
> function in a build script and remove that entire class of drift.

---

## 5. Scoring model parameters

Reference for the `scoring.params` object per model. The bracket/scoring engine implements exactly
these five readers.

**`h2h_simple`**
```
unit          string   noun for the score: "goals", "rounds", "points", "games"
target        int|null race-to value; null = play out a fixed period
win_by        int      1 unless the sport requires 2
overtime      string   free-form label: "win_by_2", "mr3", "penalties", "golden_raid", "crown_count", null
draw_allowed  bool     false in knockouts regardless; this is the league/group default
higher_wins   bool     true everywhere so far; false reserved for lowest-score-wins games
record_margin bool     if true, score difference feeds the score_diff tiebreaker
```

**`h2h_sets`**
```
set_label            string  "Set" | "Game" | "Board" — the noun shown in the UI
best_of              int     3 or 5
points_per_set       int     21, 25, 11, 25
win_by               int     2 for badminton/TT/volleyball, 1 for carrom
cap                  int|null hard ceiling (badminton 30); null = no cap
deciding_set_points  int     volleyball 15, badminton 21
record_set_scores    bool    if true, match_fields carries a set_scores text field
```
Set scores are entered as one text field (`"21-18, 19-21, 21-15"`) and parsed server-side against
`points_per_set` / `win_by` / `cap`. **One text input beats five number inputs on a phone**, and it
matches how a score is called out at a venue. Reject with a clear message on parse failure; store the
parsed array alongside the raw string.

Chess and blitz chess are `h2h_simple` with `supports_draw: true`. Their extra keys live in the
same `params` object and are read only by the chess pairing/standings path:
```
win_points, draw_points, loss_points, bye_points, half_bye_points   number (REAL — 0.5 is normal)
result_codes  [{ value, label }]  the exact set of enterable results, including forfeit variants
```

**`br_points`**
```
teams_per_lobby      int
matches_per_round    int
kill_points          int
kills_cap_per_match  int|null
placement_points     int[]   index 0 = 1st place. Length MUST equal teams_per_lobby.
map_rotation         string[] advisory; the organizer picks the actual map per match
```
Total = `placement_points[placement - 1] + kills × kill_points`, summed across matches.

**`h2h_innings`**
```
overs, balls_per_over, wickets, players_on_field, max_overs_per_bowler   int
ball_type          "tennis" | "leather" | "rubber"
super_over         bool
net_run_rate       bool   if true, NRR is computed and available as a tiebreaker
lbw                bool
```
NRR = (runs scored / overs faced) − (runs conceded / overs bowled), across the group stage, with
overs in decimal-ball form (5.4 = 5 + 4/6). A team bowled out counts its full quota of overs, not
the overs actually faced — get this wrong and the group table is wrong.

**`manual`**
```
points_label    string  what the number means
lower_wins      bool
min_per_match, max_per_match  int
aggregate       "sum" | "average" | "best_n"
drop_worst      int     number of worst results discarded before aggregating
```

A judged event (weighted criteria scored by a panel) is also `manual`: the organizer computes the
panel average off-platform and enters one number per entrant. Adding a real `judged_score` engine
would be a platform change, not a content change, and no club event needs it yet.

---

## 6. Projecting `games.json` onto the D1 `games` table

`db/schema.sql` is authoritative and is owned by the schema agent. **`content/games.json` has
already been reconciled against it** — every value that lands in a `CHECK`-constrained column uses
the exact string the constraint allows. The content file carries strictly more than the table has
columns for (help text, `visibility`, `pii`, `profile_key`, `visible_if`, per-game `match_fields`,
`standings.match_points`, `leaderboard`, `compliance`), and that surplus is preserved rather than
dropped. §6.2 says where.

### 6.1 Column-by-column projection

The seed script computes every column from the content file. Nothing is hand-entered.

| `games` column | Source in `content/games.json` |
| --- | --- |
| `id` | ULID generated on first insert. Stable thereafter — **look up by `slug`, never regenerate.** |
| `slug`, `name`, `short_name` | Same keys. |
| `category` | `category` — already `esport` / `board` / `outdoor`. |
| `subcategory` | `subcategory`. |
| `default_participant_type` | `participant.type`. |
| `default_team_size_min` / `_max` | `participant.team_size_min` / `_max`. |
| `default_substitutes_max` | `participant.substitutes_max`. (There is no `default_roster_max` column; roster size is `team_size_max + substitutes_max`, computed where needed.) |
| `supports_pairs` | `participant.supports_pairs` → 0/1. |
| `scoring_model` | `scoring.model`. |
| `unit_label` | `scoring.params.set_label` when `h2h_sets`; else `scoring.params.unit`; else `'game'`. |
| `score_label` | `scoring.params.unit` (`'runs'` for `h2h_innings`, `'points'` for `br_points`). |
| `supports_draw` | `scoring.params.draw_allowed` → 0/1; 0 when absent. |
| `higher_score_wins` | `scoring.params.higher_wins`, else `NOT scoring.params.lower_wins`, else 1. |
| `default_format` | `tournament_defaults.format`. |
| `default_best_of` | `match_defaults.best_of`. |
| `default_venue_mode` | `match_defaults.venue_kind`. |
| `needs_room_code` | `match_defaults.needs_lobby_code` → 0/1. |
| `needs_ingame_id` | `primary_ingame_id_field != null` → 0/1. |
| `ingame_id_label` | `primary_ingame_id_label`. |
| `ingame_id_pattern` | `validation.pattern` of the FieldDef named by `primary_ingame_id_field`, after preset resolution. |
| `default_lobby_size` | `scoring.params.teams_per_lobby`. The CHECK requires it whenever `default_format = 'points_lobby'`. |
| `registration_fields_json` | `registration_fields` each tagged `"scope":"entrant"`, concatenated with `member_fields` each tagged `"scope":"member"`. Presets resolved. **The full FieldDef survives** — `help`, `visibility`, `pii`, `profile_key`, `visible_if` and all. |
| `scoring_config_json` | `scoring.params` **plus** `{ side_labels, side_assignment, match_fields, standings, leaderboard, compliance, multi_stage, rating, equipment, rules_summary, search_terms, tagline, full_name, icon, age_min, status }`. This is the surplus bucket — see §6.2. |
| `default_tiebreakers_json` | `standings.tiebreakers`. |
| `has_rating` / `rating_kinds_json` | `rating.has_rating` / `rating.rating_kinds`. |
| `blurb` | `description`. |
| `accent_hex` | `accent`. |
| `icon_url` | `NULL` in v1 — there is no sprite sheet (§2.9). The column exists for later. |
| `rules_url` | `rules_url`. |
| `sort_order` | `sort_order`. |
| `is_active` | `status ∈ {active, beta}` → 1, else 0. |
| `created_at` / `updated_at` | Unix seconds at seed time. |

`categories[]` in the content file does **not** get a table. There are exactly three, they are a
CHECK constraint, and their display name, description, accent and icon are read from
`content/games.json` at build time by the Next pages — the same treatment as `club.json`. Adding a
fourth category is the one content change that needs a migration, which is the correct amount of
friction for a decision that reshapes the whole site's navigation.

### 6.1b What the create-tournament form prefills

Creating a tournament reads the game and writes `tournaments` plus one or two `stages` rows. The
mapping, so the create form and the API agree on every default:

| Target | Source |
| --- | --- |
| `tournaments.format` | `tournament_defaults.multi_stage ? 'multi_stage' : tournament_defaults.format` |
| `games.default_multi_stage` | `tournament_defaults.multi_stage` → 0/1 |
| `tournaments.entry_fee_paise` | `tournament_defaults.entry_fee_inr_default × 100` |
| `tournaments.leaderboard_weight_pct` | `leaderboard.counts_toward_global ? leaderboard.default_weight_pct : 0` |
| `tournaments.check_in_opens_at` / `_closes_at` | `starts_at − check_in_opens_minutes_before × 60` / `− check_in_closes_minutes_before × 60` |
| `tournaments.extra_fields_json` | Organizer-added fields only. The game's own fields come from the snapshot. |
| `stages[0].format` | `tournament_defaults.format` |
| `stages[0].seed_source` | `tournament_defaults.seeding` |
| `stages[0].best_of` | `match_defaults.best_of` |
| `stages[0].third_place_match` | `tournament_defaults.third_place_match` → 0/1 |
| `stages[0].rounds_planned` | `tournament_defaults.rounds` (swiss) or `scoring.params.matches_per_round` (`points_lobby`) |
| `stages[0].lobby_size` | `scoring.params.teams_per_lobby` (`points_lobby`; the CHECK requires it ≥ 2) |
| `stages[0].lobby_count` | `ceil(entrant_count ÷ lobby_size)`, minimum 1 |
| `stages[*].points_win/draw/loss/bye`, `points_divisor` | `standings.match_points` |
| `stages[*].tiebreakers_json` | `standings.tiebreakers` |
| `stages[*].scoring_config_json` | `scoring.params` + the surplus keys of §6.2 |

**When `tournament_defaults.multi_stage` is true**, two stages are created instead of one:
`stage 1` = `round_robin`, `group_count = ceil(entrants ÷ 4)`, `seed_source` from the game;
`stage 2` = `single_elim`, `seed_source = 'previous_stage'`, `source_stage_id = stage 1`,
`advance_count = 2` (top two per group), `third_place_match` from the game. The organizer can change
all of it before publishing. Seven games ship with `multi_stage: true`: Valorant, EA FC, box cricket,
table tennis, volleyball, throwball and kabaddi.

### 6.2 Where the surplus goes, and why not new columns

Everything the table has no column for is packed into `scoring_config_json` and copied wholesale
into the tournament snapshot at creation. It is read by slug, in one row, whenever a form or a
scoring engine needs it — never in a list query, never in a `WHERE` clause.

> **Rejected alternative:** adding ~12 columns to `games` for `pii`, `visibility`, `leaderboard
> weight`, `compliance`, `match_fields` and the rest. D1's `ALTER TABLE` support is thin and STRICT
> tables make column changes a rebuild-and-copy. More importantly none of it is ever filtered or
> sorted on, so a column buys nothing an index could use. The one thing to be strict about is that
> `scoring_config_json` is **not** a junk drawer that code reads ad hoc — it is copied into the
> tournament snapshot and read from there, through one typed accessor.

**Why the promoted columns exist at all.** `json_extract` in a `WHERE` clause cannot use an index in
SQLite. The game list page runs
`SELECT slug,name,short_name,category,accent_hex,icon_url FROM games WHERE is_active=1 ORDER BY category,sort_order`
against `ix_games_category` and must not deserialize twenty JSON blobs to render twenty cards.
Anything used for filtering, sorting or card rendering is a column; everything else is JSON.

### 6.3 Snapshot and versioning

`db/schema.sql` already states the rule this document depends on: the game definition **is copied
into the tournament at creation and the tournament copy is what the engine reads.** Both documents
agree, and §1 of this file explains why it is worth the duplicated bytes.

Two additions the seed script needs, neither requiring a DDL change:

- **`content_hash`** — `sha256(canonical_json(resolved_game))`, canonical meaning sorted keys and no
  insignificant whitespace so reordering the file is not a false change. Stored inside
  `scoring_config_json` as `_content_hash`. Seeding compares hashes and skips unchanged rows, turning
  a re-seed into 20 cheap reads instead of 20 writes, which is what makes it safe on every deploy.
- **`version`** — an integer inside `scoring_config_json` as `_version`, incremented whenever
  `_content_hash` changes. The tournament snapshot carries it, so an organizer looking at a
  six-month-old tournament can be told "this ran on BGMI definition v3; the current one is v7"
  instead of wondering why the numbers moved.

---

## 7. Seeding

```sh
npm run seed:games              # local D1
npm run seed:games -- --remote  # production D1
```

`scripts/seed-games.ts` (owned by the build/schema agent; this is its required behaviour):

1. Read and `JSON.parse` `content/games.json`. Any parse error → exit 1.
2. **Validate before touching the database.** Every CHECK constraint in `db/schema.sql` is
   re-asserted here in JavaScript, because a D1 constraint violation mid-batch is a much worse error
   message than a validation failure before the first statement. For every game:
   - `slug` matches `^[a-z0-9]+(-[a-z0-9]+)*$`, is lowercase, 2–40 chars, and is unique.
   - `category ∈ {esport, board, outdoor}`.
   - `scoring.model ∈ {h2h_simple, h2h_sets, h2h_innings, br_points, manual}`.
   - `tournament_defaults.format ∈ {single_elim, double_elim, round_robin, swiss, points_lobby}`.
   - `participant.type ∈ {solo, team}`; `team_size_max >= team_size_min`;
     `team_size_max + substitutes_max >= team_size_max`; `type != 'solo' || team_size_max == 1`.
   - `scoring.model != 'br_points' || params.teams_per_lobby` is set, and
     `params.placement_points.length === params.teams_per_lobby`.
   - `primary_ingame_id_field` is null, or names a real field **and** `primary_ingame_id_label` is
     non-null (the schema's `needs_ingame_id = 0 OR ingame_id_label IS NOT NULL` CHECK).
   - `accent` is `#` + 6 hex digits, and passes 4.5:1 against white.
   - `icon.emoji` is non-empty.
   - Every FieldDef `key` is unique within its array and matches `^[a-z][a-z0-9_]{0,39}$`.
   - Every `select` / `multiselect` has non-empty `options`.
   - Every `pattern` compiles under `new RegExp`, and every field with a `pattern` has a
     `pattern_message`.
   - Every `visible_if.field` names a field in the same array.
   - Every tiebreaker is a token the standings engine implements.

   **Collect all errors and print them together** — a seed script that fails on the first of nine
   typos wastes nine runs.
3. Resolve `$preset` references (§4). Unknown preset → error, nothing written.
4. Project every game onto the `games` columns per §6.1.
5. Compute `_content_hash` (§6.3). Compare against existing rows by `slug`. Skip matching hashes;
   for changed rows increment `_version`.
6. Write with `db.batch()` — one batch, `INSERT … ON CONFLICT(slug) DO UPDATE SET …`, preserving the
   existing `id` and `created_at` on conflict. D1 batches are a single transaction; a half-seeded
   catalog is not a state anyone should be able to reach. Twenty rows at roughly 8 KB each is well
   inside a single batch; if the catalog ever passes ~100 games, chunk it and accept that a chunk
   boundary is a transaction boundary.
7. **Never delete.** A game removed from the JSON is set to `is_active = 0`, not dropped —
   `tournaments.game_id` is `ON DELETE RESTRICT` and a delete would fail anyway, loudly, halfway
   through a batch.
8. Print a summary: `20 games — 2 updated, 18 unchanged, 0 deactivated`.

Run it after every deploy that touches `content/games.json`. It is idempotent, so running it when
nothing changed costs one read per game and writes nothing.

---

## 8. Adding a new game — the whole procedure

The club decides to run **Chess960** next month.

1. Open `content/games.json`.
2. Copy the `chess-classical` object.
3. Change `slug` to `chess960`, `name` to `"Chess960"`, `full_name` to `"Chess960 (Fischer
   Random)"`, `short_name` to `"C960"`, `sort_order` to `115`, `accent` to a fresh hex that passes
   4.5:1, `icon.emoji` to `"🎲"`.
4. Edit `description`, `tagline`, `search_terms` (`["chess960","fischer random","960","frc"]`) and
   `rules_summary`.
5. Add one field to `registration_fields` if you need it — say a `boolean` "I have played Chess960
   before".
6. Keep `scoring.model: "h2h_simple"` (with `supports_draw`) and `profile_key: "chess.rating"` so
   ratings carry over from the classical events. Keep `rating.has_rating: true`.
7. `npm run seed:games -- --remote`.

Elapsed: about ten minutes. Files changed: one. Lines of application code changed: **zero**. Deploy
required: **no** — `games` is read at request time from D1, and the game list page fetches it
client-side.

The same procedure covers a game that fits none of the models: set
`scoring.model: "manual"`, describe what the number means in `points_label`, and the
organizer types a number per participant per match. It is not elegant, but it is live tonight, and
that is the right trade for a club that decides its schedule a week in advance.

**What *would* require code:** a new `FieldType`, a new `scoring.model`, a new tournament `format`,
or a new tiebreaker token. Those are the four extension points, they are all small closed
enumerations, and adding to any of them is a deliberate platform change — not something a new game
should ever force.

---

## 9. `content/club.json`

Build-time only. Imported by Next pages, baked into the static export. Sections: `identity`,
`story`, `contact`, `location`, `faq`, `code_of_conduct`, `policies`, `seo`, `todo_verify`.

**Do not `import club from '@/content/club.json'` at the top of a client component.** A whole-file
import pulls all ~28 KB into the JS bundle for every page, including the `todo_verify` array, which
is an internal to-do list describing exactly which credentials are missing — not something to ship
to a phone. Import the specific section a page needs (`content/club.json` → destructured in a server
component, or a small `lib/club.ts` that re-exports named slices). `todo_verify` and `$doc` must
never reach the client bundle.

### The `TODO_VERIFY` discipline

Nothing invented ships silently. Every fact that a human must confirm — the phone number, the UPI
ID, the Instagram handle, the address, the grievance officer — is **`null` in the live field** and
has an entry in the `todo_verify` array whose `suggested` string contains the literal token
`TODO_VERIFY`.

```sh
grep -rn TODO_VERIFY content/          # pre-deploy gate, must be reviewed every time
```

Two rules the UI must follow:

1. **A contact channel whose value is `null` is not rendered.** No dead `tel:`, no `mailto:` to
   nowhere, no greyed-out icon. It is absent.
2. **A `todo_verify` entry with `"blocking": true` gates the feature it belongs to, not the build.**
   Five are blocking today: `contact.email`, `contact.phone`, `contact.whatsapp`,
   `policies.entry_fee.upi_id`, `policies.privacy_summary.grievance_officer`.

The UPI one is load-bearing and deserves stating plainly: **while `policies.entry_fee.upi_id` is
null, creating a tournament with `entry_fee_inr > 0` must be rejected by the API.** Rendering a UPI
deep link built from a null VPA is how a player's ₹200 goes to a stranger, irreversibly, with the
club's name on the page it came from.

> **Rejected alternative:** shipping plausible placeholder values like `+91 90000 00000` and a
> `TODO_VERIFY` comment beside them. Placeholders render. Placeholders get screenshotted into a
> WhatsApp group. `null` cannot be mistaken for real.

---

## 10. Editorial voice

### 10.1 The voice in one line

**Write like an organizer telling a player what to do next.** Short sentences. Concrete nouns. The
information the reader needs in the order they need it. No hype, because everybody in a tier-2 city
has read a hundred "EPIC BATTLE ROYALE SHOWDOWN 🔥🔥" posters and stopped seeing them.

### 10.2 Rules

- **Indian English, plain.** "Register", not "sign up for the opportunity to participate".
- **Sentence case for headings and buttons.** `Register now`, not `Register Now`.
- **Second person.** "You need four players." Not "Teams are required to consist of four players."
- **Money:** `₹500` — symbol, no space, no decimals, no `INR`. Thousands with Indian grouping:
  `₹1,20,000`. Free events say **"Free entry"**, never `₹0`.
- **Dates:** `Sun 21 Sep` in body text, `Sun 21 Sep 2026` when the year is not obvious.
- **Times:** always with the zone — `6:00 PM IST`. Ranges use an en dash with spaces:
  `6:00 PM – 9:30 PM IST`. Never 24-hour time in player-facing copy; nobody in a WhatsApp group
  reads "1800 hrs".
- **Numbers:** digits from zero. `4 players`, `6 overs`, `21 points`.
- **Never promise what the club cannot control.** Not "guaranteed prize money" — "prize money paid
  by UPI on the day".
- **Banned words:** *epic, ultimate, insane, revolutionary, seamless, cutting-edge, world-class,
  unleash, dominate, grind, showdown, mega, blockbuster*. Also no ALL CAPS beyond a two-letter
  acronym.
- **Emoji:** at most one, and only where it carries information — a game icon in a WhatsApp
  announcement. Zero in body copy on the site.
- **Telugu:** the site is English. WhatsApp announcements may be bilingual; if so, English block
  first, then Telugu, separated by a blank line. Never mix the two inside a sentence.

### 10.3 Tournament descriptions

Structure, in this order, because this is the order a player decides in:

1. **What and when** — one sentence. Game, format, date, time.
2. **What it costs and what you win** — entry fee, prize table.
3. **Where** — venue with a landmark, or "Online".
4. **Who can enter** — team size, age, any restriction.
5. **What to bring** — from the game's `equipment` list.

Good:

> Box cricket, 6-a-side, tennis ball. Sun 21 Sep, 8:00 AM – 6:00 PM IST.
> ₹1,200 per team. Winner ₹8,000, runner-up ₹4,000, best batter and best bowler ₹1,000 each.
> Turf ground near Magunta Layout — pin on the page.
> 16 teams, first come first served. 6 to 8 players per team, 12 and above.
> Bring sports shoes with no spikes. Bats and balls are provided.

Bad — this is what to avoid, in full:

> 🔥🔥 GET READY NELLORE 🔥🔥 The ULTIMATE box cricket SHOWDOWN is here!!! Massive prizes,
> unbelievable action, are you ready to DOMINATE?? Limited slots!! DM to register!!

It says nothing. Date, cost, venue, team size, prizes — all missing. A player cannot decide from it,
so they don't.

### 10.4 Announcement templates

Copy these. First line matters most: it is the WhatsApp notification preview and the link-preview
title, and it gets about 65 characters.

**Registration open**
```
Box cricket · Sun 21 Sep · ₹8,000 winner

6-a-side, tennis ball, 6 overs. 16 teams.
₹1,200 per team. Registration closes Fri 19 Sep, 9 PM.
Register: https://nellore.club/t/box-cricket-sep-21/
```

**Last call**
```
4 slots left — box cricket, Sunday

Registration closes tomorrow 9 PM. 12 teams in.
https://nellore.club/t/box-cricket-sep-21/
```

**Fixtures published**
```
Fixtures are out — box cricket, Sunday

First match 8:00 AM. Check your slot and reach 30 minutes early.
https://nellore.club/t/box-cricket-sep-21/#fixtures
```

**Room code (esports only — direct to captains, never in a public group)**
```
BGMI Match 2 — Room ID 8842190, password nlr21
Join now. Lobby closes in 5 minutes.
```

**Live result**
```
Nellore Warriors beat Trunk Road XI by 14 runs.
Warriors 96/4 (6), Trunk Road 82/5 (6).
Full bracket: https://nellore.club/t/box-cricket-sep-21/
```

**Results published**
```
Box cricket champions: Nellore Warriors 🏏

Runner-up Trunk Road XI. Best batter Sai Kiran (41*).
Prize money paid. Standings and every score:
https://nellore.club/t/box-cricket-sep-21/
```

**Cancellation**
```
Sunday's box cricket is postponed — rain

New date Sun 28 Sep, same venue, same time. Your entry carries over.
Want a refund instead? Reply here before Wednesday.
```

Note the shape of that last one: what happened, what it means for you, what you do next. Bad news
gets the same structure as good news and never gets buried.

### 10.5 Link previews

Anything shared on WhatsApp is judged on three lines of preview.

- **OG title ≤ 65 characters.** Front-load in this order: game, date, hook. `"Box cricket · Sun 21
  Sep · ₹8,000 winner"` — 42 characters, and all three facts survive the crop.
- **OG description ≤ 90 characters.** Entry fee, format, deadline.
- **OG image 1200×630**, and the important content inside the middle 1200×628 safe area because
  WhatsApp crops to roughly 1.91:1. Readable at 300 px wide — that is the actual size in a chat.
  The game name in the largest type on the card, then the date, then the prize.
- Every tournament page needs its own OG image. A generic club image in a group of forty people is
  a link nobody taps.

### 10.6 Player-facing error and empty states

Same voice. Say what happened, then what to do.

- Not: "Validation failed." → "That BGMI ID should be 8 to 12 digits. Check the number under your
  avatar in the profile screen."
- Not: "No data." → "No tournaments open right now. The next one goes up on Monday — join the
  WhatsApp group to hear first."
- Not: "Unauthorized." → "Your sign-in expired. Tap to sign in again with your fingerprint."

Never show a player a raw regex, a stack trace, an HTTP status or the word "null".
