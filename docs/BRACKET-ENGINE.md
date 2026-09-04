# nellore.club — Tournament / Bracket Engine Specification

**Status:** design, authoritative. **Owner file:** `docs/BRACKET-ENGINE.md`
**Implements:** `lib/bracket/**` (pure TypeScript, no I/O)
**Audience:** the implementer who writes `lib/bracket/`, and the test author who writes its suite.

Everything numeric in this document was verified by executing the algorithm before it was
written down. The oracle tables in §18 are machine-generated, not hand-derived. If your
implementation disagrees with a table in §18, your implementation is wrong.

---

## Table of contents

1. [Scope and design principles](#1-scope-and-design-principles)
2. [File layout](#2-file-layout)
3. [Contract with the rest of the system](#3-contract-with-the-rest-of-the-system)
4. [Core types](#4-core-types)
5. [Determinism](#5-determinism)
6. [Canonical entrant ordering and seeding](#6-canonical-entrant-ordering-and-seeding)
7. [The resolve pipeline (shared by all static formats)](#7-the-resolve-pipeline)
8. [Single elimination](#8-single-elimination)
9. [Double elimination](#9-double-elimination)
10. [Round robin](#10-round-robin)
11. [Swiss](#11-swiss)
12. [Battle royale / points lobbies](#12-battle-royale--points-lobbies)
13. [Withdrawal, walkover, forfeit, disqualification](#13-withdrawal-walkover-forfeit-disqualification)
14. [Score correction](#14-score-correction)
15. [Standings](#15-standings)
16. [Cross-tournament leaderboard points](#16-cross-tournament-leaderboard-points)
17. [Errors, warnings, performance budget](#17-errors-warnings-performance-budget)
18. [Test plan and oracles](#18-test-plan-and-oracles)

---

## 1. Scope and design principles

### 1.1 What the engine is

`lib/bracket/` is a **pure, dependency-free TypeScript module**. It has:

- **no** database access
- **no** `fetch`, no `crypto`, no `Date.now()`, no `Math.random()`
- **no** imports outside itself and `type`-only imports
- **no** mutation of its inputs

It takes plain JSON-serialisable data in and returns plain JSON-serialisable data out. It
therefore runs byte-identically in the Cloudflare Worker (for authoritative writes) and in the
browser (for the "preview your bracket before you publish it" screen and for optimistic UI).
That dual-runtime requirement is not cosmetic: the organiser on a mid-range Android phone must
be able to drag seeds around and see the bracket redraw with zero network round-trips.

The engine is also the reason the platform can stay **game-agnostic**. It never sees a game
name. It sees entrants, options, and numbers. Adding BGMI, or carrom, or kabaddi, is adding a
row to the `games` table plus a `format` + `options_json` preset — never a code change here.

### 1.2 The single most important architectural decision

> **The engine never mutates a bracket incrementally. It recomputes it from scratch.**

There are two functions:

- `generateBracket(input) -> Skeleton` — produces the **structure**: match ids, rounds,
  and the winner/loser *pointers* between matches. It does **not** know any results.
- `resolveBracket(skeleton, ctx) -> ResolvedBracket` — a **pure fold** over the skeleton in
  topological order that fills in who is actually in each match, what the status is, who won,
  and what the standings are. It is a total function of `(skeleton, entrants, results)`.

"Advance the bracket after a match" is therefore not a distinct algorithm. It is:
`resolveBracket(skeleton, {…, results: results + newResult})`, then diff against what is in
the database, then write the diff.

**Why this matters:** the classic bracket bug is an incremental `advance()` that walks forward
writing `entrant_a_id` into the next match — and then a score correction three rounds later has
no way to walk *backwards* and unwind. Every shipped bracket product has had this bug. By
making the resolved state a pure function of the results set, **score correction is not a
special case at all** (§14): you edit one row in the results set and re-run the same fold. There
is no rollback code to get wrong, because there is nothing to roll back.

**Rejected alternative:** incremental `advance(match, result)` mutating downstream rows, with a
separate `rollback(match)` walking the reverse edges. Rejected because the rollback path is
executed rarely (only on corrections), is therefore the least-tested code in the product, and
is exactly the code whose failure corrupts a live event in front of an audience. Recompute is
O(matches) with tiny constants — a 256-entrant double-elimination bracket is 511 matches and
resolves in well under 5 ms. There is no performance reason to be clever.

### 1.3 Static vs progressive formats

| Family | Formats | Structure depends on results? |
|---|---|---|
| **Static** | `single_elim`, `double_elim`, `round_robin` | No. Full skeleton is generated once. |
| **Progressive** | `swiss`, `points_lobby` | Yes. Round *k*'s pairings depend on rounds 1..*k*−1. |

Static formats use `generateBracket` + `resolveBracket` as described.

Progressive formats generate **one round at a time** via an explicit organiser action
(`pairSwissRound`, `assignLobbies`). Those functions are still pure — round *k* is a pure
function of the completed results of rounds 1..*k*−1 — but the output is **materialised and
persisted once**, and is *not* silently re-derived when an earlier result changes.

**Rejected alternative:** auto-re-pairing Swiss round 3 when a round-1 result is corrected.
Rejected because it silently destroys already-played games. A corrected round-1 result can
change every subsequent pairing; players who already sat down and played round 3 would find
their game deleted. Instead the engine exposes `validateProgressive()`, which reports that
later rounds are *stale*, and the organiser must explicitly choose to re-pair (which discards
later rounds, loudly, with a confirmation). This mirrors what a real chess arbiter does.

### 1.4 The engine is score-blind

The engine consumes exactly two numbers per head-to-head result: `scoreA` and `scoreB`. It has
no opinion about what they mean. The score-entry UI is responsible for putting the **canonical
comparable number** for that game into those fields:

| Game | `scoreA` / `scoreB` mean |
|---|---|
| Valorant / CS2 (Bo3) | maps won |
| BGMI head-to-head (TDM) | rounds won |
| Chess | 1 / 0.5 / 0 is *not* used — see below |
| Carrom | points |
| Badminton | sets won |
| Cricket | runs |
| Volleyball | sets won |
| EA FC | goals |

Rich game-specific detail (per-set scores, wickets, per-map rounds) lives in
`matches.result_detail_json`, which the engine receives as `detail: unknown` and **never
inspects**. The UI renders it. This is what keeps the engine game-agnostic.

**The one exception, and it is an input, not a read.** Net run rate needs overs, which are not
`scoreA`/`scoreB`. Rather than let the engine open `result_detail_json`, `HeadToHeadResult` carries
two extra optional integers, `oversFacedMilliA` / `oversFacedMilliB`, which the **API layer** parses
out of the innings fields and passes in (§4.2.2). Everything else — `setRatio`, `scoreDiff`,
`scoreFor` — is computed from `scoreA`/`scoreB` alone.

For chess, `bestOf` is 1, `allowDraws` is true, and the *result* is carried by
`winnerEntrantId` (`null` = draw); `scoreA`/`scoreB` are both 0 and unused. Points come from
`options.points`.

---

## 2. File layout

```
lib/bracket/
  index.ts              # public API surface — the ONLY module anything outside imports
  types.ts              # every shared type. Zero logic, zero imports.
  errors.ts             # EngineError, EngineWarning, all codes
  rng.ts                # mulberry32, seededShuffle, fnv1a
  seeding.ts            # normalizeEntrants, seedOrder, snakeAssign, buildPlayoffSeedList
  graph.ts              # topological invariant assertion, matchDepth, playOrder
  resolve.ts            # the shared resolve fold (§7)
  validate.ts           # validateResult, validateOptions
  tiebreak.ts           # comparator builders: points, h2h, buchholz, SB, BR chain
  standings.ts          # per-format standings + placement bands
  leaderboard.ts        # PLACE_TABLE literal + leaderboardPointsFor
  stages.ts             # seedNextStage (group stage -> playoff, qualifier -> finals)
  formats/
    index.ts            # registry: Format -> FormatModule
    singleElim.ts
    doubleElim.ts
    roundRobin.ts
    swiss.ts
    pointsLobby.ts
  __tests__/
    seeding.test.ts
    singleElim.test.ts
    doubleElim.test.ts
    roundRobin.test.ts
    swiss.test.ts
    pointsLobby.test.ts
    correction.test.ts
    withdrawal.test.ts
    standings.test.ts
    leaderboard.test.ts
    determinism.test.ts
    perf.test.ts
```

Rules:

- `types.ts` and `errors.ts` import nothing.
- No file in `lib/bracket/` may import from `app/`, `worker/`, `lib/db/`, or any npm package.
  Enforce with an ESLint `no-restricted-imports` rule scoped to this directory.
- Every export from `index.ts` is a pure function or a type. No classes, no singletons, no
  module-level mutable state.

---

## 3. Contract with the rest of the system

The engine does not touch the database, but the persistence layer must be able to store
everything the engine emits and reconstruct everything it consumes.

**This section has been reconciled against `db/schema.sql`, which is now authoritative for every
name and type.** Four things this doc originally asked for were changed, and the changes are load
bearing — do not re-introduce them:

1. **Timestamps are unix SECONDS, not milliseconds.** Every other component stores and emits
   seconds; two time units in one system is a bug generator with no upside. `registeredAt`,
   `statusChangedAt`, `recordedAt` and `scheduledAt` are all seconds.
2. **Scores, bonuses and ratings are `INTEGER`, not `REAL`.** Chess's half-point convention is
   `stages.points_divisor = 2` with 2/1/0 stored. A `REAL` score puts float equality inside a
   standings tiebreak comparator, which is exactly where "these two are tied" quietly becomes
   "not tied" at the third decimal.
3. **`matches.id` is a ULID (`mat_…`); the engine's `MatchId` (`W2-3`) is stored in `matches.code`,
   unique per stage.** The adapter builds the `code → id` map before the batch, so every foreign key
   is a real ULID and D1's FK enforcement actually protects the graph.
4. **`stages.ordinal`** (not `stage_no`), and stage status is
   `pending|seeding|live|recomputing|completed|cancelled`.

### 3.1 Required storage (as reconciled — `db/schema.sql` is authoritative)

```
tournaments
  id                TEXT PK            -- 'trn_' + 26-char ULID
  slug              TEXT UNIQUE
  game_id           TEXT
  status            TEXT   -- draft|published|registration_open|registration_closed|
                           -- check_in|live|completed|cancelled|archived
  bracket_seed      INTEGER NOT NULL   -- uint32, the RNG seed. Fixed at creation, never changes.
  bracket_version   INTEGER NOT NULL DEFAULT 0   -- optimistic lock for recompute (§14.4)
  state_version     INTEGER NOT NULL DEFAULT 1   -- HTTP ETag validator; MUST be bumped in the
                                                 -- SAME batch as any bracket_version bump
  leaderboard_weight_pct INTEGER NOT NULL DEFAULT 100
                           -- replaces the `tier` column this doc originally asked for: an integer
                           -- percent is strictly more expressive than four named bands and needs no
                           -- lookup table. Map tiers to 50/100/150/200 in the create form if you
                           -- want the shorthand back in the UI.

stages
  id                TEXT PK            -- 'stg_' + 26-char ULID
  tournament_id     TEXT
  ordinal           INTEGER          -- 1-based; stage 1 runs first
  format            TEXT             -- single_elim|double_elim|round_robin|swiss|points_lobby
  options_json      TEXT             -- FormatOptions, validated by validateOptions()
  status            TEXT             -- pending|seeding|live|recomputing|completed|cancelled
  skeleton_hash     TEXT             -- fnv1a of canonical skeleton JSON (§5.3)
  skeleton_json     TEXT             -- THE Skeleton, verbatim, incl. seedList. Written ONCE at
                                     -- generation, never rewritten. §14.1 LOADS this.
  points_divisor    INTEGER NOT NULL DEFAULT 1  -- must equal options.pointsDivisor (§4.3)

stage_entrants
  stage_id          TEXT
  entrant_id        TEXT
  seed              INTEGER NULL     -- THE CANONICAL dense 1..N seed from §6.1 step 5, copied from
                                     -- Skeleton.seedList at generation. IMMUTABLE. Not the
                                     -- organiser's input seed (that is entrants.seed).
  group_no          INTEGER NOT NULL DEFAULT 1  -- DERIVED output of snakeAssign. Never read back
                                     -- as Entrant.groupHint.
  lobby_no          INTEGER NULL
  source_stage_id   TEXT NULL
  source_rank       INTEGER NULL

entrants
  id                TEXT PK
  tournament_id     TEXT
  display_name      TEXT
  seed              INTEGER NULL     -- organiser-assigned INPUT; 1 = strongest
  rating            INTEGER NULL     -- club-rating SNAPSHOT taken at registration. NULL in v1
                                     -- (nothing writes ratings — API.md §1.12); `seeding_method
                                     -- = 'rating'` is refused at the API, never silently degraded.
  status            TEXT             -- pending|confirmed|waitlisted|checked_in|
                                     -- withdrawn|disqualified|no_show   (see the mapping below)
  status_changed_at INTEGER NULL     -- unix seconds; REQUIRED by CHECK for withdrawn,
                                     -- disqualified AND no_show
  registered_at     INTEGER NOT NULL
  group_hint        INTEGER NULL     -- optional forced RR group, INPUT

matches
  id                    TEXT PK      -- 'mat_' + 26-char ULID, minted by the Worker.
  code                  TEXT         -- the engine's MatchId, e.g. 'W2-3'. UNIQUE (stage_id, code).
                                     -- The adapter maps code -> id before the batch, so every
                                     -- pointer below is a real ULID and D1's FK check protects
                                     -- the graph.
  stage_id              TEXT
  tournament_id         TEXT
  match_no              INTEGER      -- display number, UNIQUE per TOURNAMENT. SkeletonMatch.number
                                     -- is stage-LOCAL, so the adapter offsets it — see §9.6.
  play_order            INTEGER      -- suggested chronological run order (§9.6)
  bracket               TEXT         -- W|L|GF|RR|SW|BR
  round                 INTEGER
  round_label_key       TEXT
  position              INTEGER      -- 0-based index within (stage_id, bracket, round),
                                     -- STAGE-GLOBAL across groups. See §10.3. For 'BR',
                                     -- position = lobby_no - 1.
  group_no              INTEGER NULL
  lobby_no              INTEGER NULL
  had_rematch           INTEGER NOT NULL DEFAULT 0   -- Swiss; part of the hashed canonical JSON
  a_source_kind         TEXT         -- entrant|winner|loser|none
  a_source_match_id     TEXT NULL    -- FK matches(id)
  a_source_entrant_id   TEXT NULL    -- FK entrants(id); set iff a_source_kind = 'entrant'
  b_source_kind         TEXT
  b_source_match_id     TEXT NULL
  b_source_entrant_id   TEXT NULL
  entrant_a_id          TEXT NULL    -- RESOLVED/DERIVED. Written by the engine's diff, never by hand.
  entrant_b_id          TEXT NULL
  result_entrant_a_id   TEXT NULL    -- AS RECORDED. Written ONCE by the score endpoint at the
  result_entrant_b_id   TEXT NULL    -- instant the result is stored; never touched by the diff.
                                     -- The ONLY source of HeadToHeadResult.entrantAId/BId. §7.4.
  best_of               INTEGER NOT NULL DEFAULT 1
  conditional           INTEGER NOT NULL DEFAULT 0   -- 1 for GF2 only
  status                TEXT         -- pending|ready|live|complete|bye|void
  winner_entrant_id     TEXT NULL
  is_draw               INTEGER NOT NULL DEFAULT 0
  score_a               INTEGER NULL
  score_b               INTEGER NULL
  bonus_a               INTEGER NULL
  bonus_b               INTEGER NULL
  side_a                TEXT NULL    -- 'W'|'B' for chess; NULL otherwise
  method                TEXT NULL    -- normal|walkover|forfeit|dq|no_contest
  result_detail_json    TEXT NULL    -- opaque to the engine
  result_version        INTEGER NOT NULL DEFAULT 0
  recorded_at           INTEGER NULL
  recorded_by           TEXT NULL
  scheduled_at          INTEGER NULL -- IST is a display concern; store unix seconds UTC
  venue_id              TEXT NULL
  room_code             TEXT NULL    -- esports lobby code

match_participants          -- points_lobby ONLY (§12.2)
  match_id          TEXT
  entrant_id        TEXT
  stage_id          TEXT             -- denormalised: the standings recompute reads by stage
  tournament_id     TEXT
  slot_no           INTEGER
  placement         INTEGER          -- 1 = best
  kills             INTEGER NOT NULL DEFAULT 0
  placement_points  INTEGER NOT NULL DEFAULT 0   -- all four are recomputed server-side on every
  kill_points       INTEGER NOT NULL DEFAULT 0   -- write; the client never submits a total
  bonus_points      INTEGER NOT NULL DEFAULT 0
  total_points      INTEGER NOT NULL DEFAULT 0
  disqualified      INTEGER NOT NULL DEFAULT 0
  PRIMARY KEY (match_id, entrant_id)

match_audit
  id                TEXT PK          -- 'mad_' + 26-char ULID
  match_id          TEXT NULL        -- ON DELETE SET NULL; the trail outlives a bracket reset
  match_code        TEXT NOT NULL    -- denormalised so the row is readable without matches
  match_no          INTEGER NOT NULL
  stage_id          TEXT NULL
  tournament_id     TEXT
  actor_user_id     TEXT
  at                INTEGER
  kind              TEXT             -- result_set|result_corrected|result_cleared|status_forced
  before_json       TEXT
  after_json        TEXT
  reason            TEXT NULL
```

#### 3.1.1 `entrants.status` → `EntrantStatus` — the normative mapping

The schema's enum has seven values; the engine's `EntrantStatus` has three. The adapter maps them
with **exactly** this table, and nothing else. `active` is not a database value and never was.

| `entrants.status` | Engine | Notes |
|---|---|---|
| `confirmed` | `active` | |
| `checked_in` | `active` | |
| `pending` | — | **Excluded from `GenerateInput.entrants` entirely.** Not "active with a flag": an unconfirmed entrant is not in the tournament. |
| `waitlisted` | — | Excluded, as above. |
| `withdrawn` | `withdrawn` | `status_changed_at` required by CHECK. |
| `no_show` | `withdrawn` | Written by the check-in-close cron. `status_changed_at` required by CHECK — see §13.3 for why a null there was a live retroactive-forfeit bug. |
| `disqualified` | `disqualified` | `status_changed_at` and `dq_reason` required by CHECK. |

An entrant excluded at generation time simply does not exist in the skeleton (§6.1 step 1). An
entrant that becomes `pending`/`waitlisted` *after* generation is a state the API does not allow.

### 3.2 Invariants the persistence layer must uphold

0. **`stages.skeleton_json` is written once and never rewritten.** Every later read of the bracket
   loads it. Nothing re-derives a skeleton for a stage that already has one — see §14.1.
1. `bracket_seed` is generated once, at tournament creation, from
   `crypto.getRandomValues(new Uint32Array(1))[0]` in the Worker, and is **immutable**. It is
   what makes a randomised draw reproducible and auditable.
2. `matches` rows are created **only** by persisting a `Skeleton`. Nothing else inserts them.
3. `entrant_a_id`, `entrant_b_id`, `status`, `winner_entrant_id`, `loser_entrant_id` are
   **derived** columns. They are written only by the diff of a `resolveBracket` call. Treat them as
   a materialised view. The *source of truth* is `(skeleton, entrants, results)`.
3a. **`result_entrant_a_id` / `result_entrant_b_id` are NOT derived.** The score endpoint writes
   them, once, in the same statement that writes the score, from the entrant ids the organiser was
   looking at. The recompute diff must never write them. They are cleared to NULL exactly when the
   result is cleared. `HeadToHeadResult.entrantAId`/`entrantBId` are sourced from these and from
   nowhere else — sourcing them from `entrant_a_id`/`entrant_b_id` would make §7.3 step 7 compare
   the recompute against its own previous output, which is not a check at all.
4. Every write that changes a result goes through the recompute path in §14.4 and bumps
   `tournaments.bracket_version` **and `tournaments.state_version`, in the same batch**.
5. `match_audit` gets a row for **every** result write, correction, and clear. Non-negotiable:
   score disputes at a live event are settled by this table.
6. `stage_entrants.seed` is written at generation from `Skeleton.seedList` and is immutable for the
   life of the stage. Every tiebreak chain terminates in `seed`; if it drifts, two consecutive
   requests can produce two different standings orders.

---

## 4. Core types

`lib/bracket/types.ts`, verbatim. The implementer writes exactly these.

```ts
// ---------- identifiers ----------
export type EntrantId = string;
export type MatchId = string;

export type Format =
  | 'single_elim'
  | 'double_elim'
  | 'round_robin'
  | 'swiss'
  | 'points_lobby';

// ---------- entrants ----------
export type EntrantStatus = 'active' | 'withdrawn' | 'disqualified';

export interface Entrant {
  readonly id: EntrantId;
  readonly displayName: string;
  /** Organiser-assigned. 1 = strongest. null = unseeded. */
  readonly seed: number | null;
  readonly rating: number | null;
  /** unix seconds. Deterministic tiebreak for canonical ordering; ties break on id. */
  readonly registeredAt: number;
  readonly status: EntrantStatus;
  /** unix seconds. REQUIRED (non-null) when status !== 'active'. See §13. */
  readonly statusChangedAt: number | null;
  /** Optional forced round-robin group, 1-based. */
  readonly groupHint: number | null;
}

/** Entrant after canonical ordering: `seed` is now a guaranteed 1..N dense integer. */
export interface SeededEntrant extends Entrant {
  readonly seed: number;
}

// ---------- skeleton ----------
export type SlotSource =
  | { readonly kind: 'entrant'; readonly entrantId: EntrantId }
  | { readonly kind: 'winner'; readonly matchId: MatchId }
  | { readonly kind: 'loser'; readonly matchId: MatchId }
  /** Structurally empty: a phantom seed above N, or an unused lobby slot. */
  | { readonly kind: 'none' };

export type BracketSide = 'W' | 'L' | 'GF' | 'RR' | 'SW' | 'BR';

export interface SkeletonMatch {
  readonly id: MatchId;
  /** 1-based display number, assigned in generation order. Stable identity. */
  readonly number: number;
  /** 1-based suggested chronological run order. See §9.6. */
  readonly playOrder: number;
  readonly bracket: BracketSide;
  readonly round: number;
  readonly indexInRound: number;
  readonly roundLabelKey: string;
  readonly roundLabel: string;
  readonly a: SlotSource;
  readonly b: SlotSource;
  readonly bestOf: number;
  /** true only for GF2. A conditional match may resolve to 'void'. */
  readonly conditional: boolean;
  readonly groupNo: number | null;
  readonly lobbyNo: number | null;
  /** points_lobby only. Entrant ids are filled by assignLobbies(). */
  readonly lobbyEntrantIds: readonly EntrantId[] | null;
  /** Swiss only: true when no legal non-rematch pairing existed. See §11.3 step 6. */
  readonly hadRematch: boolean;
}

export interface RoundMeta {
  readonly bracket: BracketSide;
  readonly round: number;
  readonly labelKey: string;
  readonly label: string;
  readonly matchCount: number;
  readonly bestOf: number;
}

export interface Skeleton {
  readonly format: Format;
  readonly bracketSize: number;      // S for elimination formats; N otherwise
  readonly entrantCount: number;     // N
  readonly rounds: readonly RoundMeta[];
  /** MUST be in topological order: every match appears after all matches it references. */
  readonly matches: readonly SkeletonMatch[];
  /** The canonical seed order actually used, entrant ids indexed by seed-1. */
  readonly seedList: readonly EntrantId[];
  readonly hash: string;             // fnv1a of canonical JSON, §5.3
}

// ---------- results (inputs) ----------
export type ResultMethod = 'normal' | 'walkover' | 'forfeit' | 'dq' | 'no_contest';

export interface HeadToHeadResult {
  readonly matchId: MatchId;
  /** The participants AS RECORDED. Used for the invalidation check in §7.4. */
  readonly entrantAId: EntrantId | null;
  readonly entrantBId: EntrantId | null;
  readonly scoreA: number;
  readonly scoreB: number;
  readonly bonusA: number;
  readonly bonusB: number;
  /** null = draw. Only legal when options.allowDraws === true. */
  readonly winnerEntrantId: EntrantId | null;
  readonly method: ResultMethod;
  readonly sideA: 'W' | 'B' | null;
  readonly recordedAt: number;
  readonly version: number;
  readonly detail: unknown;
}

export interface LobbyRow {
  readonly entrantId: EntrantId;
  readonly placement: number;   // 1-based within the lobby
  readonly kills: number;
  readonly disqualified: boolean;
}

export interface LobbyResult {
  readonly matchId: MatchId;
  readonly rows: readonly LobbyRow[];
  readonly recordedAt: number;
  readonly version: number;
  readonly detail: unknown;
}

export type MatchResultInput = HeadToHeadResult | LobbyResult;

// ---------- resolved output ----------
export type MatchStatus =
  | 'pending'   // at least one participant not yet determined
  | 'ready'     // both participants known, no accepted result
  | 'live'      // organiser flagged in-progress (carried through from DB)
  | 'complete'  // accepted result
  | 'bye'       // exactly one participant; auto-advances; never playable
  | 'void';     // zero participants; never playable

export interface ResolvedMatch extends SkeletonMatch {
  readonly entrantAId: EntrantId | null;
  readonly entrantBId: EntrantId | null;
  readonly status: MatchStatus;
  readonly winnerEntrantId: EntrantId | null;
  readonly loserEntrantId: EntrantId | null;
  readonly isDraw: boolean;
  readonly scoreA: number | null;
  readonly scoreB: number | null;
  readonly bonusA: number | null;
  readonly bonusB: number | null;
  readonly sideA: 'W' | 'B' | null;
  readonly method: ResultMethod | null;
  /** points_lobby only: the per-squad rows with computed points. */
  readonly lobbyRows: readonly ResolvedLobbyRow[] | null;
  /** false when a stored result existed but was rejected (participants changed). */
  readonly resultAccepted: boolean;
}

export interface ResolvedLobbyRow extends LobbyRow {
  readonly placementPoints: number;
  readonly killPoints: number;
  readonly bonusPoints: number;
  readonly totalPoints: number;
}

export interface Standing {
  readonly entrantId: EntrantId;
  /** 1-based. Ties share the BEST place in the band (5,5,7,7 — never 5,6,7,8). */
  readonly placement: number;
  readonly placementLabel: string;   // "1st", "Joint 5th"
  readonly rank: number;             // dense display order 1..N, always distinct
  readonly played: number;
  readonly wins: number;
  readonly draws: number;
  readonly losses: number;
  readonly points: number;
  readonly scoreFor: number;
  readonly scoreAgainst: number;
  readonly scoreDiff: number;
  readonly eliminated: boolean;
  /** Ordered tiebreak values, parallel to the applied tiebreak chain. For UI columns. */
  readonly tiebreaks: readonly TiebreakValue[];
  readonly groupNo: number | null;
}

export interface TiebreakValue {
  readonly key: TiebreakKey;
  readonly label: string;
  readonly value: number;
}

export type TiebreakKey =
  | 'points' | 'headToHead' | 'scoreDiff' | 'scoreFor' | 'wins' | 'played' | 'fewestLosses'
  | 'buchholzCut1' | 'buchholz' | 'sonnebornBerger'
  | 'setRatio' | 'netRunRate'
  | 'kills' | 'bestPlacement'
  | 'brWins' | 'brPlacementPoints' | 'brKillPoints' | 'brBestPlacement' | 'brLastRound'
  | 'seed';

// ---------- options ----------
/**
 * ALL VALUES ARE INTEGERS, pre-multiplied by `CommonOptions.pointsDivisor`.
 * Chess is `{ win: 2, draw: 1, loss: 0, … }` with `pointsDivisor: 2`, displayed as 1 / 0.5 / 0.
 * There is no fractional arithmetic anywhere in this engine. See §4.3.
 */
export interface PointsConfig {
  readonly win: number;
  readonly draw: number;
  readonly loss: number;
  /** Awarded to the side that receives a walkover win. Default = `win`. */
  readonly walkoverWin: number;
  /** Awarded to the side that forfeits. Default = `loss`. */
  readonly forfeitLoss: number;
  /** Awarded to BOTH sides of a `no_contest` (weather abandonment, double no-show). Default = `draw`. */
  readonly noResult: number;
}

export interface CommonOptions {
  readonly bestOf: number;                              // default 1; must be odd
  readonly bestOfByRound: Readonly<Record<number, number>> | null;
  readonly allowDraws: boolean;                         // default false
  /**
   * [winnerScore, loserScore] recorded for a walkover.
   * DEFAULT `[null, null]` — a walkover records NO SCORE. Inventing a notional 2–0 pollutes
   * `netRunRate` and `setRatio` and will decide a group on a match nobody played
   * (OPERATIONS.md §8). `[ceil(bestOf/2), 0]` is available as an explicit per-stage opt-in for
   * formats whose governing body requires a notional scoreline.
   */
  readonly walkoverScore: readonly [number | null, number | null];
  /**
   * Every integer in `PointsConfig` and every emitted `Standing.points` is a multiple of this.
   * 1 for whole-point sports, 2 for chess halves. MUST equal `stages.points_divisor`;
   * `validateOptions` throws `E_INVALID_OPTIONS` if a caller passes a mismatch.
   * The UI divides for display; the engine never does.
   */
  readonly pointsDivisor: number;                       // default 1; integer >= 1
  readonly tiebreakChain: readonly TiebreakKey[] | null; // null = format default
}

export type SeedingStrategy = 'seeded' | 'random' | 'as_entered';

export interface SingleElimOptions extends CommonOptions {
  readonly kind: 'single_elim';
  readonly seedingStrategy: SeedingStrategy;
  readonly thirdPlace: boolean;                         // default false
}

export interface DoubleElimOptions extends CommonOptions {
  readonly kind: 'double_elim';
  readonly seedingStrategy: SeedingStrategy;
  readonly grandFinalReset: boolean;                    // default true
  readonly lbBestOf: number | null;                     // overrides bestOf in the L bracket
}

export interface RoundRobinOptions extends CommonOptions {
  readonly kind: 'round_robin';
  readonly seedingStrategy: SeedingStrategy;
  readonly groupCount: number;                          // default 1
  readonly legs: 1 | 2;                                 // default 1
  /** default { win:3, draw:1, loss:0, walkoverWin:3, forfeitLoss:0, noResult:1 }, divisor 1 */
  readonly points: PointsConfig;
  readonly byePoints: number;                           // default 0
  readonly sideBalance: 'berger' | 'none';              // default 'berger'
  readonly advancePerGroup: number | null;              // for seedNextStage()
}

export interface SwissOptions extends CommonOptions {
  readonly kind: 'swiss';
  readonly seedingStrategy: SeedingStrategy;
  readonly rounds: number;                              // default recommendedSwissRounds(N)
  /**
   * default { win:2, draw:1, loss:0, walkoverWin:2, forfeitLoss:0, noResult:1 }
   * with `pointsDivisor: 2` — i.e. chess's 1 / 0.5 / 0, stored and compared as integers.
   */
  readonly points: PointsConfig;
  readonly byePoints: number;                           // default = points.win
  readonly sides: 'chess' | 'none';                     // default 'none'
  readonly accelerated: boolean;                        // default false
  readonly acceleratedRounds: number;                   // default 2
}

export interface PointsLobbyOptions extends CommonOptions {
  readonly kind: 'points_lobby';
  readonly seedingStrategy: SeedingStrategy;
  readonly roundsCount: number;                         // number of games/matches in the stage
  readonly lobbyCapacity: number;                       // squads per lobby, e.g. 25 BGMI, 12 FF
  readonly lobbyRotation: 'snake_by_standings' | 'rotate' | 'fixed';
  /** index 0 = 1st place. Shorter than the lobby size => remaining places score 0. */
  readonly placementPoints: readonly number[];
  readonly killPoints: number;                          // default 1
  readonly wwcdBonus: number;                           // extra for 1st place. default 0
  readonly advanceCount: number | null;
}

export type FormatOptions =
  | SingleElimOptions | DoubleElimOptions | RoundRobinOptions
  | SwissOptions | PointsLobbyOptions;

// ---------- cross-stage and progressive-format inputs ----------
export interface SeedNextStageInput {
  /** Standings of the stage that just finished. §15 */
  readonly prevStandings: readonly Standing[];
  /** 1 when the previous stage was ungrouped. */
  readonly groupCount: number;
  /** Round robin: how many qualify per group. Null => use `advanceCount`. */
  readonly advancePerGroup: number | null;
  /** Points lobby / Swiss: flat number of qualifiers. Null => use `advancePerGroup`. */
  readonly advanceCount: number | null;
  /** Entrants of the previous stage, so display names and ids can be carried forward. */
  readonly entrants: readonly Entrant[];
}

export interface ProgressiveValidateInput {
  readonly format: 'swiss' | 'points_lobby';
  readonly options: SwissOptions | PointsLobbyOptions;
  readonly entrants: readonly Entrant[];
  readonly results: readonly MatchResultInput[];
  /** Every round already materialised and persisted, in round order. */
  readonly materialisedRounds: readonly {
    readonly round: number;
    readonly matches: readonly SkeletonMatch[];
  }[];
}

// ---------- call surfaces ----------
export interface GenerateInput {
  readonly format: Format;
  readonly options: FormatOptions;
  readonly entrants: readonly Entrant[];
  readonly rngSeed: number;             // uint32 from tournaments.bracket_seed
}

export interface ResolveContext {
  readonly entrants: readonly Entrant[];
  readonly results: readonly MatchResultInput[];
  readonly options: FormatOptions;
  readonly rngSeed: number;
  /** Statuses carried through from the DB, e.g. 'live'. Engine never invents 'live'. */
  readonly liveMatchIds: readonly MatchId[];
}

export interface ResolvedBracket {
  readonly format: Format;
  readonly matches: readonly ResolvedMatch[];
  readonly rounds: readonly RoundMeta[];
  readonly standings: readonly Standing[];
  readonly complete: boolean;
  readonly championEntrantId: EntrantId | null;
  /** Stored results the engine refused, because the match's participants changed. §7.4 */
  readonly invalidatedResults: readonly MatchId[];
  readonly warnings: readonly EngineWarning[];
}
```

### 4.1 Public API (`lib/bracket/index.ts`)

```ts
export function generateBracket(input: GenerateInput): Skeleton;
export function resolveBracket(skeleton: Skeleton, ctx: ResolveContext): ResolvedBracket;

/** generate + resolve with zero results. For the organiser's live preview screen. */
export function previewBracket(input: GenerateInput): { skeleton: Skeleton; resolved: ResolvedBracket };

export function computeStandings(b: ResolvedBracket, ctx: ResolveContext): readonly Standing[];

/** Validates a candidate result BEFORE it is stored. Returns null when valid. */
export function validateResult(
  match: ResolvedMatch, result: MatchResultInput, options: FormatOptions,
): EngineError | null;

export function validateOptions(format: Format, raw: unknown): FormatOptions;   // throws EngineError
export function defaultOptions(format: Format): FormatOptions;

/** Progressive formats. */
export function pairSwissRound(input: SwissPairInput): SwissPairing;
export function assignLobbies(input: LobbyAssignInput): readonly SkeletonMatch[];
export function validateProgressive(input: ProgressiveValidateInput): readonly EngineWarning[];

/** Persistence helper. Pure: computes what the DB must change. §14.3 */
export function diffMatches(
  prev: readonly ResolvedMatch[], next: readonly ResolvedMatch[],
): MatchDiff;

/** Cross-stage. §12.6 / §10.6. Called by POST /organizer/stages/:id/seed (API.md §4.23.4). */
export function seedNextStage(input: SeedNextStageInput): readonly SeededNextEntrant[];

/** Cross-tournament. §16 */
export function leaderboardPointsFor(input: LeaderboardInput): readonly LeaderboardAward[];

/** Scheduling helper: longest-path depth of every match. §9.6 */
export function matchDepth(skeleton: Skeleton): Readonly<Record<MatchId, number>>;

export function recommendedSwissRounds(n: number): number;
export function seedOrder(size: number): readonly number[];
export function nextPowerOfTwo(n: number): number;
```

### 4.2 The tiebreak token map (normative)

`content/games.json` and `stages.tiebreakers_json` speak **snake_case tokens**
(ARCHITECTURE.md §6.6). The engine speaks **camelCase `TiebreakKey`**. This is the only translation
table, it lives in `tiebreak.ts`, and an unknown token is `E_INVALID_OPTIONS` — never a silently
dropped comparator, because a dropped comparator produces a *wrong table that looks right* and
decides who qualifies.

| `games.json` / `tiebreakers_json` token | `TiebreakKey` | Direction | Meaning |
|---|---|---|---|
| `points` | `points` | desc | |
| `wins` | `wins` | desc | |
| `fewest_losses` | `fewestLosses` | asc | `losses`, ascending |
| `played` | `played` | desc | |
| `head_to_head` | `headToHead` | desc | mini-table among the tied set (§10.5) |
| `score_diff` | `scoreDiff` | desc | `scoreFor − scoreAgainst` |
| `score_for` | `scoreFor` | desc | |
| `set_ratio` | `setRatio` | desc | ×1000 integer, §4.2.1 |
| `net_run_rate` | `netRunRate` | desc | ×1000 integer, §4.2.2 |
| `kills` | `kills` | desc | BR kill count (alias of `brKillPoints` when `killPoints = 1`) |
| `best_placement` | `bestPlacement` | **asc** | best single-round placement |
| `buchholz` | `buchholz` | desc | |
| `buchholz_cut1` | `buchholzCut1` | desc | |
| `sonneborn_berger` | `sonnebornBerger` | desc | |
| `seed` | `seed` | **asc** | appended unconditionally; never authored |

The BR-specific keys `brWins`, `brPlacementPoints`, `brKillPoints`, `brBestPlacement`,
`brLastRound` are the `points_lobby` default chain (§12.6) and are engine-internal — they have no
`games.json` token because no game authors them.

#### 4.2.1 `setRatio`

```
setRatio = floor( 1000 × scoreFor / max(1, scoreAgainst) )
```

`scoreFor`/`scoreAgainst` are sets won / sets lost for a set-scored game (badminton, volleyball,
table tennis, throwball, carrom boards, Valorant/CS2 maps) because §1.4 already requires the
score-entry UI to put sets into `scoreA`/`scoreB`. **No `result_detail_json` read.** Stored ×1000 in
a `standings.tiebreak_*` slot.

#### 4.2.2 `netRunRate`

NRR needs four numbers that are *not* `scoreA`/`scoreB`: runs scored, runs conceded, overs faced,
overs bowled. Reading them out of `result_detail_json` would break the game-agnostic contract
(§1.4). So they are **engine inputs**, parsed by the API layer out of the innings fields and passed
in on the result:

```ts
export interface HeadToHeadResult {
  // …existing fields…
  /** Overs faced by side A, ×1000 (19.4 overs = 19 + 4/6 = 19666). null when not applicable. */
  readonly oversFacedMilliA: number | null;
  /** Overs faced by side B, ×1000. `oversBowled` by A is by definition B's oversFaced. */
  readonly oversFacedMilliB: number | null;
}
```

```
netRunRate(e) = floor( 1000 × ( scoreFor  × 1000 / max(1, Σ oversFacedMilli(e))
                              − scoreAgainst × 1000 / max(1, Σ oversFacedMilli(opponents of e)) ) )
```

When either `oversFacedMilli` is null for a completed match, that match is skipped for NRR and
`W_NRR_INCOMPLETE` is emitted. Stored ×1000 in a `standings.tiebreak_*` slot; **it may be negative**,
which is why those columns carry no `>= 0` CHECK.

**Rejected:** letting the engine read `result_detail_json`. One `if (game === 'cricket')` inside
`tiebreak.ts` is the end of "a new game is a row, not a code change".

#### 4.2.3 Persistence: five slots, and what is emitted

`standings` persists **exactly the first five comparators after `points`**, in chain order, into
`tiebreak_1..5`, and `GET /api/v1/tournaments/:slug/standings` emits exactly those as columns
(API.md §1.9). Rational values (`setRatio`, `netRunRate`) are the ×1000 integers above; everything
else is its natural integer. `seed` is never persisted in a slot — it lives on
`stage_entrants.seed`. A chain longer than six total participates in the sort but is not stored and
is not a column; `validateOptions` emits `W_TIEBREAKS_TRUNCATED` when that happens. Chess's shipped
chain (`points, buchholz_cut1, buchholz, sonneborn_berger, head_to_head, wins, seed`) fits exactly.

### 4.3 Everything is an integer

There is no fractional arithmetic in this engine and there never was meant to be. `standings.points`
and `standings.tiebreak_1..5` are `INTEGER NOT NULL` in a `STRICT` table; writing `4.5` into one is
a hard SQLite error that rolls back the entire score-write batch, which would mean **scores cannot
be entered for any chess event at all**.

Therefore, normatively:

1. Every value in `PointsConfig`, `byePoints`, `walkoverScore`, `Standing.points` and
   `TiebreakValue.value` is an **integer**.
2. Halves are expressed by `pointsDivisor`. Chess ships `{ win: 2, draw: 1, loss: 0 }` with
   `pointsDivisor: 2`. A draw is one point, not half a point, and the UI divides by 2 to render
   `0.5`.
3. `validateOptions` throws `E_INVALID_OPTIONS` for any non-integer in a points field, and for a
   `pointsDivisor` that does not equal the stage's `points_divisor` column.
4. Rational tiebreaks are ×1000 integers (§4.2.1, §4.2.2).

The old rule "all point values must be integer multiples of 0.5" is **deleted**. It was true about
float representability and irrelevant to the actual failure, which is the storage type.

---

## 5. Determinism

### 5.1 The rule

`generateBracket(input)` must return a value whose canonical JSON is **byte-identical** for
byte-identical input, in every JS engine, forever. Same for `resolveBracket`.

Consequences the implementer must respect:

1. **No `Math.random()`.** Randomised seeding uses `mulberry32(rngSeed)` only.
2. **No `Date.now()`.** Any time the engine needs is passed in.
3. **No `Object.keys()` iteration order dependence** for anything that affects output. Build
   arrays, sort them explicitly.
4. **No `Array.prototype.sort` without a total comparator.** V8's sort is stable since ES2019,
   but "stable" only saves you if the pre-sort order is itself deterministic. Every comparator
   in this engine must end in a tiebreak that is provably total — in practice `seed` ascending,
   which is a dense 1..N integer after §6. Never fall back to `displayName` (Unicode collation
   differs across engines) and never to insertion order alone.
5. **No `Math.pow` / `**` in any value that is compared or rounded.** `Math.pow` is not
   required by IEEE-754 to be correctly rounded and V8/JSC/SpiderMonkey differ in the last ULP.
   This bit us in §16: `Math.round(1000 / Math.pow(32, 0.8))` evaluates to `62` in V8 even
   though `32**0.8` is mathematically exactly `16` (which would give `63`). The leaderboard
   therefore uses a **committed integer lookup table**, not a runtime power.
6. **No locale-sensitive anything.** No `toLocaleString`, no `localeCompare`, no `Intl` inside
   `lib/bracket/`. Labels are plain ASCII English keys; the UI localises.

### 5.2 `rng.ts`

```ts
/** mulberry32. Deterministic, fast, 32-bit state. Returns [0,1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates, descending. Returns a NEW array. Direction is part of the spec. */
export function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = items.slice();
  const rng = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = out[i]; out[i] = out[j]; out[j] = tmp;
  }
  return out;
}

export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
```

The shuffle direction (`i` descending, `j = floor(rng() * (i+1))`) is normative. An ascending
Fisher-Yates with the same seed produces a different permutation, and a bracket that changes
when someone refactors the shuffle is a bracket players will not trust.

### 5.3 Skeleton hashing

`Skeleton.hash = fnv1a(canonicalJson(skeletonWithoutHash))`.

`canonicalJson` serialises objects with keys in a **fixed declared order** (the order the
interface declares them in §4), arrays in their natural order, numbers via `String(n)`, and no
whitespace. Do not use `JSON.stringify` on the object directly — key order would then depend on
property insertion order, which is stable in practice but is not something to bet a tournament
on. Write the serialiser explicitly.

The hash is stored in `stages.skeleton_hash`, alongside the skeleton itself in
`stages.skeleton_json`.

**The hash check applies to the GENERATE path only.** `POST .../bracket` with `force: true`, and
`POST .../stages/:id/seed`, regenerate a skeleton; if a skeleton already exists for that stage and
the regenerated hash differs, the write is refused with `E_SKELETON_DRIFT` unless the caller
explicitly asked to replace it. That is the guard rail that stops a mid-event "let me just add one
more team" from silently re-drawing a bracket people are already playing.

**The recompute path never regenerates and therefore never hash-checks.** §14.1 loads
`stages.skeleton_json`. Re-deriving instead would be provably wrong after the very first
withdrawal: §6.1 step 1 drops non-active entrants, so regenerating from the *current* entrant list
yields a smaller `N`, a different skeleton and a different hash — firing `E_SKELETON_DRIFT` on
exactly the flow §13.1 calls normal, and blocking every recompute for the rest of the event.

### 5.4 Randomised seeding

When `seedingStrategy === 'random'`, the canonical entrant list (§6) is shuffled with
`seededShuffle(list, rngSeed)` where `rngSeed` is `tournaments.bracket_seed`. Because the seed
is stored and immutable, the draw is:

- **reproducible** — anyone can re-derive it,
- **auditable** — publish the seed after the draw and a player can verify nobody re-rolled,
- **unfakeable after the fact** — the seed is written at tournament creation, before entrants
  exist.

Publish `bracket_seed` on the public tournament page once the draw is made. In a tier-2 city
club where everyone knows everyone, "the draw was rigged" is a real accusation and a verifiable
seed is a cheap, complete answer to it.

---

## 6. Canonical entrant ordering and seeding

### 6.1 `normalizeEntrants`

```ts
export function normalizeEntrants(
  entrants: readonly Entrant[],
  strategy: SeedingStrategy,
  rngSeed: number,
): readonly SeededEntrant[];
```

Steps, in order:

1. **Filter.** Drop entrants whose `status !== 'active'` **at generation time**. An entrant who
   withdrew *before* the bracket was generated simply does not exist as far as the structure is
   concerned (§13.1). Withdrawal *after* generation is handled entirely in `resolve` and must
   **not** re-filter here — `normalizeEntrants` is called with the entrant list as it stood at
   generation, and the stored `Skeleton` pins it via `seedList`.
2. **Reject duplicates.** Duplicate `id` → `E_DUPLICATE_ENTRANT`.
3. **Bounds.** `N < 2` → `E_TOO_FEW_ENTRANTS`. `N > 256` → `E_TOO_MANY_ENTRANTS` (§17.3).
4. **Order**, by strategy:
   - `'seeded'` — sort by:
     1. `seed` ascending, treating `null` as `+Infinity`
     2. `rating` **descending**, treating `null` as `-Infinity`
     3. `registeredAt` ascending
     4. `id` ascending, compared by **UTF-16 code unit** (`a < b ? -1 : a > b ? 1 : 0`), *not*
        `localeCompare`
   - `'as_entered'` — sort by `registeredAt` ascending, then `id` ascending (code unit).
   - `'random'` — first produce the `'as_entered'` order (so the shuffle input is
     deterministic), then `seededShuffle(list, rngSeed)`.
5. **Re-seed.** Overwrite `seed` with the dense 1-based index in the resulting order. From this
   point on, `seed` is a guaranteed total order over entrants and is the universal final
   tiebreak everywhere in the engine.

The re-seeding in step 5 is what makes every "…then a stable deterministic fallback" clause in
this document actually total. There is never a coin flip.

### 6.2 `seedOrder` — standard 1-vs-N bracket ordering

```ts
export function seedOrder(size: number): readonly number[] {
  // size must be a power of two >= 1
  let r: number[] = [1];
  while (r.length < size) {
    const n = r.length * 2;
    const next: number[] = [];
    for (const s of r) { next.push(s); next.push(n + 1 - s); }
    r = next;
  }
  return r;
}
```

`seedOrder(S)[p]` is the seed number occupying 0-based bracket position `p`. Round-1 match `i`
(1-based) occupies positions `2i-2` (slot A) and `2i-1` (slot B).

**Normative outputs** (test these literally):

| S | `seedOrder(S)` |
|---|---|
| 2 | `[1,2]` |
| 4 | `[1,4,2,3]` |
| 8 | `[1,8,4,5,2,7,3,6]` |
| 16 | `[1,16,8,9,4,13,5,12,2,15,7,10,3,14,6,11]` |
| 32 | `[1,32,16,17,8,25,9,24,4,29,13,20,5,28,12,21,2,31,15,18,7,26,10,23,3,30,14,19,6,27,11,22]` |

### 6.3 Bye allocation — the exact rule

Let `N` = entrant count, `S = nextPowerOfTwo(N)`, `B = S − N` byes.

> **Rule:** Fill every bracket position `p` with the entrant whose seed is `seedOrder(S)[p]`.
> If `seedOrder(S)[p] > N`, that slot's `SlotSource` is `{ kind: 'none' }`.
>
> **That is the entire rule. There is no separate bye-placement pass.**

**Why this is correct (and why you must not "improve" it):** in the standard ordering, the
round-1 opponent of seed `k` is always seed `S+1−k`. Seed `k` therefore faces a phantom exactly
when `S+1−k > N`, i.e. `k > N+1−... ` — solving, `S+1−k > N ⟺ k < S+1−N = B+1 ⟺ k ≤ B`.

So **seeds 1..B receive byes, automatically, and they are already distributed evenly through
the bracket.** Any explicit "now give byes to the top seeds" pass is at best redundant and at
worst breaks the even distribution. This falls out of the ordering for free.

Verified bye seeds:

| N | S | B | seeds with byes |
|---|---|---|---|
| 2 | 2 | 0 | — |
| 3 | 4 | 1 | 1 |
| 5 | 8 | 3 | 1,2,3 |
| 7 | 8 | 1 | 1 |
| 9 | 16 | 7 | 1–7 |
| 11 | 16 | 5 | 1–5 |
| 17 | 32 | 15 | 1–15 |

Because `S` is the *next* power of two ≥ N, we always have `N > S/2`, hence `B < S/2`, hence
**no round-1 match can have two byes**. (`S = 2` with `N = 2` is the degenerate lower bound.)
This is not true in the losers bracket, where double byes do occur — see §9.4.

### 6.4 Snake (serpentine) assignment

Used for round-robin groups and for battle-royale lobbies.

```ts
export function snakeAssign(count: number, buckets: number): number[] {
  // returns bucketOf[i] (1-based bucket) for 0-based canonical index i
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const cycle = Math.floor(i / buckets);
    const pos = i % buckets;
    out.push(cycle % 2 === 0 ? pos + 1 : buckets - pos);
  }
  return out;
}
```

Verified: `count=17, buckets=2` → bucket sizes `{1: 9, 2: 8}`.
Bucket sizes always differ by at most 1. If any `entrant.groupHint` is non-null, honour it for
those entrants and snake-assign only the rest into the remaining capacity, in canonical order;
emit `W_UNBALANCED_GROUPS` if the resulting sizes differ by more than 1.

---

## 7. The resolve pipeline

`lib/bracket/resolve.ts`. This single fold serves `single_elim`, `double_elim`, `round_robin`,
and (over already-materialised rounds) `swiss` and `points_lobby`.

### 7.1 Preconditions

- `skeleton.matches` is in **topological order**: for every match `m`, any match referenced by
  `m.a` or `m.b` appears earlier in the array. Every generator in §8–§12 emits in this order by
  construction.
- In development builds only, `graph.ts` asserts this with a single forward pass over a `Set`
  of seen ids; a violation throws `E_CYCLE_IN_SKELETON`. Do **not** run a real topological sort
  at runtime in the Worker — it is pure waste, and the invariant is cheap to assert in tests.

### 7.2 The fold

```
resolveBracket(skeleton, ctx):
  entrantById  := Map from ctx.entrants
  resultById   := Map<MatchId, MatchResultInput>
                  built by scanning ctx.results and keeping, for each matchId,
                  the entry with the highest `version`; ties broken by highest `recordedAt`;
                  further ties broken by last-in-array (results are already deduped in the DB
                  by primary key, so this is defence in depth only)
  liveIds      := Set from ctx.liveMatchIds
  winnerOf     := Map<MatchId, EntrantId | null>
  loserOf      := Map<MatchId, EntrantId | null>
  invalidated  := []
  warnings     := []

  for m in skeleton.matches (in order):
      A := resolveSlot(m.a)
      B := resolveSlot(m.b)
      ... determine status/winner/loser per §7.3 ...
      winnerOf[m.id] := winner
      loserOf[m.id]  := loser
```

`resolveSlot(src)` — **three-valued, and this is load-bearing.** It returns one of
`ENTRANT(id)`, `STRUCTURAL_NULL` ("no participant will ever arrive here"), or `UNDETERMINED`
("a participant will arrive here once an upstream match is played"). Collapsing the last two into a
single `null` is the single worst bug this engine can have; §7.3 step 0 exists to keep them apart.

| `src.kind` | condition | result |
|---|---|---|
| `'none'` | — | `STRUCTURAL_NULL` (a phantom seed above N, or an unused lobby slot) |
| `'entrant'` | — | `ENTRANT(src.entrantId)` — always resolves; the generator only emits ids that exist |
| `'winner'` | source status ∈ `{complete, bye}` | `ENTRANT(winnerOf[src.matchId])` |
| `'winner'` | source status = `void` | `STRUCTURAL_NULL` |
| `'winner'` | source status ∈ `{pending, ready, live}` | `UNDETERMINED` |
| `'loser'` | source status = `complete` **and not a draw** | `ENTRANT(loserOf[src.matchId])` |
| `'loser'` | source status ∈ `{bye, void}` | `STRUCTURAL_NULL` (a bye has no loser; a void has neither) |
| `'loser'` | source status ∈ `{pending, ready, live}` | `UNDETERMINED` |

Because `skeleton.matches` is in topological order, the source match's status is always already
computed when a slot referencing it is resolved.

**Why the three-way split, concretely.** N=8 single elimination, zero results. `W2-1` is
`winner(W1-1)` vs `winner(W1-2)`; both source matches are `ready`. Under the old two-valued rule
both slots resolve to `null`, step 2 fires, and `W2-1` becomes `void` — as does `W3-1` above it, so
**a freshly generated bracket renders as entirely void**. Worse, in the mixed case (N=11 double
elim, §9.8): `W2-1` = `winner(W1-1)` (a bye → seed 1) vs `winner(W1-2)` (unplayed). Two-valued, that
is one null and one entrant → step 3 → `bye`, and **seed 1 is auto-advanced into `W3-1` and shown on
the public bracket as a semi-finalist before `W1-2` has been played**. Three-valued, `W2-1` is
`pending` and nothing advances.

### 7.3 Status determination

Applied in this exact order for each match `m` with resolved slots `A`, `B`:

```
0.  if A is UNDETERMINED || B is UNDETERMINED:
        status = 'pending'; winner = null; loser = null
        resultAccepted = false          // a stored result on a pending match is not consulted;
                                        // it is neither accepted nor added to `invalidated`
        STOP
    // Only STRUCTURAL_NULL reaches steps 2 and 3. Only STRUCTURAL_NULL makes byes and voids.

0b. if m.lobbyEntrantIds !== null:       // bracket 'BR', a points_lobby row — §12.2
        take the lobby path in §7.3.1 and SKIP steps 1-9 entirely.

    // From here on, treat A and B as `id | null`, where null means STRUCTURAL_NULL.

1.  aOut := A !== null && isForfeitedBy(A, m)     // §13.3
    bOut := B !== null && isForfeitedBy(B, m)

2.  if A === null && B === null:
        status = 'void'; winner = null; loser = null; STOP

3.  if A === null XOR B === null:
        status = 'bye'
        winner = (A ?? B); loser = null
        scoreA = scoreB = null; method = null
        STOP
        // A bye is NOT a result. It is never counted as a win, never counted in
        // `played`, never contributes to Buchholz. It is a structural pass-through.

4.  if aOut && bOut:
        status = 'void'; winner = null; loser = null
        warnings += W_BOTH_ENTRANTS_INACTIVE
        STOP

5.  if aOut XOR bOut:
        status  = 'complete'
        winner  = the active one; loser = the inactive one
        method  = (inactive entrant's status === 'disqualified') ? 'dq' : 'walkover'
        scores  = options.walkoverScore applied to (winner, loser)
        resultAccepted = true (synthesised, not stored)
        STOP

6.  stored := resultById[m.id]
    if stored is undefined:
        status = liveIds.has(m.id) ? 'live' : 'ready'; winner = loser = null; STOP

7.  // participant-set check — the heart of score correction, §14
    if unorderedPairEquals({stored.entrantAId, stored.entrantBId}, {A, B}) is FALSE
       OR (stored.winnerEntrantId !== null AND stored.winnerEntrantId ∉ {A, B}):
        invalidated += m.id
        warnings   += W_RESULT_INVALIDATED(m.id)
        status = liveIds.has(m.id) ? 'live' : 'ready'
        winner = loser = null
        resultAccepted = false
        STOP

8.  if stored.method === 'no_contest':
        status = 'ready'; winner = loser = null
        warnings += W_NO_CONTEST_BLOCKS(m.id)
        STOP
        // A no-contest deliberately does NOT advance the bracket. The match must be replayed.

9.  status = 'complete'
    // Note: stored.entrantAId may be B and stored.entrantBId may be A (the organiser entered
    // the sides the other way round). Normalise: map stored scores onto the SKELETON's A/B
    // orientation before writing scoreA/scoreB.
    winner = stored.winnerEntrantId
    isDraw = (winner === null)
    if isDraw && !options.allowDraws: -> E_DRAW_NOT_ALLOWED (hard error, refuse the resolve)
    loser  = isDraw ? null : (winner === A ? B : A)
```

**`pending` vs `ready`, settled.** `pending` is assigned by **step 0 and only by step 0**: at least
one slot is `UNDETERMINED`, i.e. it points at a match that is not yet in `{complete, bye, void}`.
`ready` means both slots resolved to real entrants and no result is stored. There is no "final
touch-up" pass and there must not be one — a touch-up that only overrides `ready → pending` cannot
undo the `void` and `bye` that steps 2 and 3 would already have produced, which is precisely the bug
step 0 exists to prevent. UI greys out `pending` matches.

### 7.3.1 The lobby path (bracket `'BR'`, `points_lobby`)

A points-lobby match row is an entire lobby, not a pairing (§12.2): `m.a` and `m.b` are both
`{ kind: 'none' }` and the participants are in `m.lobbyEntrantIds`. Without this branch every one of
the 24 rows of a 4-lobby, 6-round BGMI qualifier would resolve to `void` at step 2, discarding every
stored `LobbyResult`, leaving `lobbyRows` null and the standings empty — i.e. the headline esports
format would not work at all.

```
0b. stored := resultById[m.id]                    // a LobbyResult, §4
    entrantAId = entrantBId = null
    winner = loser = null; isDraw = false; method = null
    scoreA = scoreB = bonusA = bonusB = null

    // Invalidation rule, the lobby analogue of step 7:
    // a LobbyResult is ACCEPTED iff the set of entrant ids in stored.rows
    // EQUALS m.lobbyEntrantIds exactly (same members, same cardinality; row order
    // is irrelevant). A squad added to or removed from the lobby invalidates it.
    if stored exists && setEquals(stored.rows.map(r => r.entrantId), m.lobbyEntrantIds):
        status         = 'complete'
        lobbyRows      = computeLobbyRows(stored, m, options)      // §12.4
        resultAccepted = true
    else if stored exists:
        invalidated   += m.id
        warnings      += W_RESULT_INVALIDATED(m.id)
        status         = liveIds.has(m.id) ? 'live' : 'ready'
        lobbyRows      = null
        resultAccepted = false
    else:
        status         = liveIds.has(m.id) ? 'live' : 'ready'
        lobbyRows      = null
        resultAccepted = false
    STOP
```

**Withdrawal and DQ inside a lobby.** `isForfeitedBy` is never called on A/B here — they are null —
so the rule is stated on the rows instead:

- Before the lobby is played (`status ∈ {ready, live}`): a squad whose `isForfeitedBy(id, m)` is
  true is **dropped from `m.lobbyEntrantIds` for scoring purposes**, the lobby's expected entrant set
  shrinks by one, and `W_LOBBY_ENTRANT_INACTIVE` is emitted. The skeleton row is not rewritten — the
  set-equality check above compares against the *reduced* set.
- After it is played (a result exists whose `recordedAt` predates `statusChangedAt`): the result
  stands untouched, per §13.3. A late DQ of one squad is expressed as
  `LobbyRow.disqualified = true` on that squad's row, which scores 0 and **does not re-rank anyone
  else** (§12.5). It is never expressed by removing the squad from the lobby.
- A lobby all of whose squads are inactive resolves to `void`.

### 7.4 Result invalidation — the whole of score correction

Step 7 above is the entire correctness argument for score correction. A stored result is
**accepted** if and only if the pair of entrants the fold computes for that match equals the
pair the organiser was looking at when they entered it.

**Where "the pair the organiser was looking at" comes from.** `HeadToHeadResult.entrantAId` and
`entrantBId` are read from `matches.result_entrant_a_id` / `result_entrant_b_id` — columns the score
endpoint writes at the instant the result is recorded and the recompute diff never touches (§3.2
invariant 3a). They must **not** be read from `matches.entrant_a_id`/`entrant_b_id`: those are
derived, so the check would be comparing the recompute against its own previous output, and its
correctness would rest entirely on the diff never updating a participant column without clearing the
result in the same atomic write. §14.4 explicitly breaks that: a >90-statement correction spans
several batches, so a failure between them leaves downstream matches carrying the NEW
`entrant_a_id` while their stale results are not yet cleared. With derived columns as the source,
the next resolve would read `stored.entrantAId === computed A`, accept the result, and silently
credit a score entered for {seed 1, seed 4} to a match now containing {seed 8, seed 4} — with
nothing in `match_audit` to show for it. With `result_entrant_*` the mismatch is detected and the
result is invalidated, which is the correct and visible outcome.

- Correct WB round 1 so a different player advances → round 2's computed pair changes → the
  round-2 result no longer matches → it is invalidated and its match reverts to `ready`.
- Correct only the *scoreline* of a match without changing the winner → no downstream pair
  changes → **nothing downstream is invalidated.** This is the common case (organiser typed
  13–11 instead of 21–11) and it must be non-destructive. It is, for free.
- Correct a result in a round robin → nothing structural changes at all; only standings move.

`invalidatedResults` is returned to the caller so the API can tell the organiser
*"3 later results were cleared and must be re-entered"* **before** committing. The
`PATCH /api/matches/:id/result` endpoint should run the recompute in dry-run mode, return the
invalidation list, and require `?confirm=1` when the list is non-empty. This turns the most
dangerous operation in the product into a two-tap confirmation.

---

## 8. Single elimination

`lib/bracket/formats/singleElim.ts`

### 8.1 Structure

- `S = nextPowerOfTwo(N)`, `R = log2(S)` rounds.
- Round `r` ∈ 1..R has `S / 2^r` matches.
- Match id: `` `W${r}-${i}` `` (1-based `i`).
- Round `r` match `i` feeds round `r+1` match `ceil(i/2)`, into **slot A if `i` is odd**, slot B
  if `i` is even.
- Optional third-place playoff: id `W3P`, `a = loser(W${R-1}-1)`, `b = loser(W${R-1}-2)`.
  Emitted only when `S >= 4`. If `S === 2` and `thirdPlace` was requested, skip it and emit
  `W_THIRD_PLACE_UNAVAILABLE`.

### 8.2 Generation

```ts
generate(input): Skeleton
```

1. `seeded = normalizeEntrants(entrants, options.seedingStrategy, rngSeed)` (§6.1).
2. `S = nextPowerOfTwo(N)`, `order = seedOrder(S)`.
3. Round 1: for `i` = 1..S/2, slot A = position `2i-2`, slot B = position `2i-1`.
   `slot = order[p] <= N ? { kind:'entrant', entrantId: seeded[order[p]-1].id } : { kind:'none' }`.
4. Rounds 2..R: `a = { kind:'winner', matchId: `W${r-1}-${2i-1}` }`,
   `b = { kind:'winner', matchId: `W${r-1}-${2i}` }`.
5. Third place if enabled.
6. `number` = 1..K assigned in the emission order above (round 1 matches first, ascending `i`,
   then round 2, …, then `W3P` last).
7. `playOrder` per §9.6.

`bestOf` for round `r` = `options.bestOfByRound?.[r] ?? options.bestOf`.

### 8.3 Round labels

| Condition | `roundLabelKey` | `roundLabel` |
|---|---|---|
| `r === R` | `final` | `Final` |
| `r === R-1` | `semi_final` | `Semi-final` |
| `r === R-2` | `quarter_final` | `Quarter-final` |
| otherwise | `round_of_${2**(R-r+1)}` | `Round of ${2**(R-r+1)}` |
| `W3P` | `third_place` | `Third-place playoff` |

### 8.4 Advancement

Nothing to specify beyond §7 — advancement *is* the fold. For the avoidance of doubt:

- **Bye auto-advance**: a round-1 match with one `none` slot resolves to `status: 'bye'`,
  `winner = the real entrant`. It appears in the DB as a row (so the graph is uniform and score
  correction can traverse it), and the public bracket view **hides** `bye` and `void` matches,
  rendering the seed as if it started in round 2.
  *Rejected alternative:* not emitting bye rows and instead pre-placing the seed directly into
  round 2. Rejected because it breaks the invariant "every edge in the advancement graph is a
  row", which is what makes recompute and audit uniform; and it makes the round number a player
  "played in" inconsistent between seeds.
- **Walkover / forfeit / DQ**: §13.
- **Third place with N=3**: `W3P` has one `loser()` source pointing at a bye match, so it
  resolves to `status: 'bye'`. That is correct — with 3 entrants the round-1 loser *is* third —
  and it is hidden from the UI like any other bye.

### 8.5 Match count oracles

`skeletonMatches = S − 1` (+1 if third place). **`playableMatches = N − 1`, always.** That
identity is the single best smoke test for this format and it holds for every N (verified, §18.1).

---

## 9. Double elimination

`lib/bracket/formats/doubleElim.ts`. This is the highest-risk section in the product. Read all
of it before writing any of it.

### 9.1 Shape

With `S = nextPowerOfTwo(N)`, `R = log2(S)`:

- **Winners bracket (WB)**: identical to §8. `W${r}-${i}`, `r` ∈ 1..R.
- **Losers bracket (LB)**: `2R − 2` rounds, ids `L${q}-${j}`, `q` ∈ 1..2R−2.
- **Grand final**: `GF`. **Bracket reset**: `GF2` (conditional).

LB round sizes:

| LB round `q` | kind | match count | slot A | slot B |
|---|---|---|---|---|
| `1` | minor | `S/4` | `loser(W1-${2j-1})` | `loser(W1-${2j})` |
| `2k`, k=1..R−1 | **major** | `S / 2^(k+1)` | `winner(L${2k-1}-${j})` | `loser(W${k+1}-${src(j)})` |
| `2k+1`, k=1..R−2 | minor | `S / 2^(k+2)` | `winner(L${2k}-${2j-1})` | `winner(L${2k}-${2j})` |

Total LB rounds = `1 + (R−1) major + (R−2) minor = 2R − 2`. ✓

- **Major** rounds are where WB losers *drop in*. LB survivor in slot A, WB dropper in slot B.
- **Minor** rounds halve the LB field with no external input.

This alternation is what makes double elimination work: a WB dropper never has to play two LB
rounds back to back without the LB field also halving, so both brackets stay in lockstep and
converge on the same round.

`GF`: `a = winner(W${R}-1)`, `b = winner(L${2R-2}-1)`.
`GF2`: `a = winner(GF)`, `b = loser(GF)`, `conditional: true`.

**Degenerate case `S === 2` (N = 2):** `R = 1`, so `2R−2 = 0` LB rounds. Special-case it:
emit `W1-1`, then `GF` with `a = winner(W1-1)`, `b = loser(W1-1)`, then `GF2`. This correctly
implements "the loser must beat you twice": worst case is 3 matches, and `playable = 2 = 2N−2`
before the reset. Verified in §18.2.

### 9.2 The losers-bracket drop mapping

This is the part every implementation gets wrong. The question: **when WB round `r` (r ≥ 2)
produces `m = S/2^r` losers, which LB match in major round `2(r−1)` does each go to?**

Let `src(r, j)` be the WB round-`r` match index whose loser drops into LB match `L${2(r-1)}-${j}`.

> ### Normative rule: **pair-flip**
> ```ts
> function dropSource(m: number, j: number): number {
>   if (m === 1) return 1;
>   return j % 2 === 1 ? j + 1 : j - 1;   // 1↔2, 3↔4, 5↔6, …
> }
> ```
> i.e. `src = [2,1]` for m=2; `[2,1,4,3]` for m=4; `[2,1,4,3,6,5,8,7]` for m=8.
>
> LB round 1 uses the **natural** mapping (`L1-${j}` takes the losers of `W1-${2j-1}` and
> `W1-${2j}`) with no permutation.

### 9.3 Why pair-flip, with the evidence

Define the **territory** of a match: the set of WB round-1 match indices its participants could
have come from. A player's every previous opponent lies inside their own territory. Therefore:

> If the LB survivor's territory is **disjoint** from the WB dropper's territory, an immediate
> rematch is *impossible*.

I evaluated the four candidate permutations by computing territories exhaustively, and then
confirmed with a 200,000-trial Monte Carlo over random match outcomes.

**Territory separation at major rounds** (the rounds where a WB dropper meets an LB survivor):

| S | natural | reverse | half-shift | **pair-flip** |
|---|---|---|---|---|
| 8 | fails at LB R2 | clean at R2 | clean at R2 | clean at R2 |
| 16 | fails at R2, R4 | clean R2, **fails R4** | clean R2, **fails R4** | **clean R2 and R4** |
| 32 | fails R2, R4, R6 | clean R2, **fails R4, R6** | clean R2, **fails R4, R6** | **clean R2, R4, R6** |
| 64 | fails all | clean R2 only | clean R2 only | **clean R2, R4, R6, R8** |

Only pair-flip keeps *every* major round rematch-free. (The final major round, where `m === 1` —
the LB final against the WB final's loser — always overlaps, and that is correct and expected:
the LB finalist may well have already lost to the WB finalist, and having to beat them twice in
the grand final is the whole point of double elimination.)

**Monte Carlo, average rematches per completed tournament (200k trials each):**

| S | scheme | total | **at major rounds** | at minor rounds |
|---|---|---|---|---|
| 8 | natural | 2.064 | 1.376 | 0.000 |
| 8 | reverse / half-shift / **pair-flip** | 1.31 | 0.375 | 0.251 |
| 16 | natural | 3.765 | 3.094 | 0.000 |
| 16 | reverse | 1.610 | 0.844 | 0.094 |
| 16 | half-shift | 1.610 | 0.845 | 0.093 |
| 16 | **pair-flip** | 1.705 | **0.344** | 0.688 |
| 32 | natural | 7.202 | 6.532 | 0.000 |
| 32 | reverse | 2.658 | 1.962 | 0.027 |
| 32 | half-shift | 2.652 | 1.958 | 0.027 |
| 32 | **pair-flip** | **2.552** | **0.335** | 1.549 |

**The tradeoff, stated plainly.** At S=16, pair-flip has ~6% more rematches *in total* than
reverse (1.705 vs 1.610) but **2.5× fewer at major rounds** (0.344 vs 0.844). At S=32 it wins on
both counts. Pair-flip moves rematches out of the major rounds and into the minor rounds.

That is the trade we want, because the two kinds of rematch are not equally bad:

- A **major-round** rematch is a player who just dropped out of the winners bracket being
  immediately handed, as their elimination match, someone they already beat. This is the one
  players complain about, and it is the one that looks broken on a shared bracket screenshot.
- A **minor-round** rematch is two players who are both already in the losers bracket meeting
  again. Both have a loss; neither has a grievance; nobody screenshots it.

**Rejected alternatives:**

- *`natural` (identity mapping)*: 4–6× more rematches. It is what you get if you don't think
  about this at all. Do not ship it.
- *`reverse` / `half-shift`*: the most commonly seen choice, and defensible, but they only
  protect the *first* major round. From LB R4 onward the losers bracket has been stirred so
  thoroughly that territory separation is destroyed and rematches return.
- *A runtime swap that detects a rematch and re-pairs on the fly*: rejected outright. The
  bracket structure must be fixed and publicly visible from the moment of the draw. A bracket
  whose shape changes based on results is a bracket nobody can plan around, cannot be shared as
  an image on WhatsApp, and cannot be verified after the fact.
- *Re-ordering LB round 1 to spread byes more evenly* (see §9.4): rejected because LB round 1's
  natural mapping is exactly what gives `L1-${j}` the same territory as `W2-${j}`, which is the
  precondition for pair-flip's separation guarantee at every subsequent major round. Trading a
  proven rematch guarantee for cosmetically tidier byes is a bad trade.

### 9.4 Byes and voids in the losers bracket

Unlike the winners bracket (§6.3), the losers bracket **can** produce matches with zero
participants, because a `loser()` reference to a bye match resolves to `null`.

- One `null` slot → `status: 'bye'`, the other entrant advances free.
- Two `null` slots → `status: 'void'`, both `winnerOf` and `loserOf` are `null`, which
  propagates forward and creates further byes/voids. §7 handles this with no special code.

This is not a defect. It is the correct consequence of byes: with N=11, seeds 4 and 5 both have
byes, so `W1-3` and `W1-4` both produce no loser, so `L1-2` is genuinely empty. The engine
must not try to "compact" it away.

**Verified consequence:** across every entrant count, `playableMatches = 2N − 2` exactly
(plus `GF2` if the reset is played). See §18.2. If your implementation produces any other
number, the bye/void propagation is wrong.

One asymmetry to be aware of and to document in the organiser UI: with non-power-of-two N, some
WB droppers land in an LB match that is a bye and get a free round. With N=11, the loser of
`W2-1` walks into `L2-2` unopposed. This is inherent to byes in any double-elimination bracket
and is not a bug; it is the LB-side mirror of the top seeds' WB byes.

### 9.5 Grand final and bracket reset

- `GF` is played. Slot A is the WB-side entrant (zero losses), slot B is the LB-side entrant
  (one loss).
- **If slot A wins:** they finish undefeated. Tournament over. `GF2` resolves to `void`
  (its `winner(GF)` and `loser(GF)` sources both resolve, but the format module marks
  conditional matches as `void` when `winnerOf['GF'] === skeleton A-side entrant`). Implement
  this as an explicit post-pass in `doubleElim.resolve`:
  ```
  after the fold:
    gf := resolved['GF']
    if gf.status === 'complete':
       wbSide := gf.entrantAId
       if gf.winnerEntrantId === wbSide:
           force resolved['GF2'].status = 'void'
           (and mark any stored GF2 result as invalidated)
  ```
- **If slot B wins:** the WB-side entrant now has one loss too. Both have exactly one loss, so
  the title is undecided. This is the **bracket reset**. `GF2` becomes live:
  `a = winner(GF)` (the LB-side player), `b = loser(GF)` (the WB-side player).
  Its winner is the champion.
- If `options.grandFinalReset === false`, `GF2` is never emitted at all and the `GF` winner is
  champion regardless. Offer this: for a Sunday-afternoon BGMI event on a schedule, a mandatory
  extra series can blow the timetable. Default is `true` because `false` is not strictly a
  double elimination.

**Slot orientation of `GF2`:** slot A = `winner(GF)`, slot B = `loser(GF)`.
*Rationale:* it makes `GF2`'s slot sources ordinary `winner`/`loser` references, so it needs no
special case anywhere in the fold — it is just another match. *Rejected alternative:* keeping
`a = WB-side` for visual continuity, which would require `GF2` to carry a hard-coded entrant
reference resolved from a *different* match's A-slot, i.e. a special case in the one function
that must have no special cases.

### 9.6 Match numbering and play order

Two different orderings, both stored:

- **`number`** — generation order: all WB rounds 1..R ascending, then LB rounds 1..2R−2
  ascending, then `GF`, then `GF2`. This is stable *identity* ("Match 23"), never re-derived.

  **`number` is stage-LOCAL (1..K per skeleton); `matches.match_no` is tournament-GLOBAL and
  `UNIQUE (tournament_id, match_no)`.** The persistence adapter must therefore offset it:

  ```sql
  -- computed ONCE, before the insert batch
  SELECT COALESCE(MAX(match_no), 0) AS base FROM matches WHERE tournament_id = ?1;
  -- then, for every skeleton match:  match_no = base + skeletonMatch.number
  ```

  Without the offset, stage 2 of a groups → playoff or qualifier → finals tournament regenerates
  numbers 1..K and the whole second-stage insert batch collides on `(tournament_id, 1)` — after the
  group stage has already been played. This is the adapter's job, not the engine's: the engine never
  sees other stages.
- **`playOrder`** — suggested chronological run order, for the organiser's run sheet and for
  "what's next" on the public page.

```ts
depth(m) = 0                                        if both slots are 'entrant' or 'none'
         = 1 + max(depth(source) for each match-referencing slot)   otherwise
```

Sort all matches by `(depth asc, bracketRank asc, round asc, indexInRound asc)` where
`bracketRank = { W: 0, L: 1, GF: 2, RR: 0, SW: 0, BR: 0 }`, then assign `playOrder` 1..K.

This produces the run order a real organiser wants: WB round 1, then WB round 2 *and* LB round 1
together, then WB round 3 and LB round 2, and so on — with the two brackets interleaved so the
venue is never idle. See the worked tables in §9.7 and §9.8.

### 9.7 Worked example: 8 entrants

`S = 8`, `R = 3`, LB rounds = 4, skeleton = 15 matches = `2S − 1`. ✓
Drop sources: WB R2 (m=2) → `[2,1]`. WB R3 (m=1) → `[1]`.

| # | id | slot A | slot B | status | depth | playOrder |
|---|----|--------|--------|--------|-------|-----------|
| 1 | `W1-1` | seed 1 | seed 8 | playable | 0 | 1 |
| 2 | `W1-2` | seed 4 | seed 5 | playable | 0 | 2 |
| 3 | `W1-3` | seed 2 | seed 7 | playable | 0 | 3 |
| 4 | `W1-4` | seed 3 | seed 6 | playable | 0 | 4 |
| 5 | `W2-1` | W(W1-1) | W(W1-2) | playable | 1 | 5 |
| 6 | `W2-2` | W(W1-3) | W(W1-4) | playable | 1 | 6 |
| 7 | `W3-1` | W(W2-1) | W(W2-2) | playable | 2 | 9 |
| 8 | `L1-1` | L(W1-1) | L(W1-2) | playable | 1 | 7 |
| 9 | `L1-2` | L(W1-3) | L(W1-4) | playable | 1 | 8 |
| 10 | `L2-1` | W(L1-1) | **L(W2-2)** | playable | 2 | 10 |
| 11 | `L2-2` | W(L1-2) | **L(W2-1)** | playable | 2 | 11 |
| 12 | `L3-1` | W(L2-1) | W(L2-2) | playable | 3 | 12 |
| 13 | `L4-1` | W(L3-1) | L(W3-1) | playable | 4 | 13 |
| 14 | `GF` | W(W3-1) | W(L4-1) | playable | 5 | 14 |
| 15 | `GF2` | W(GF) | L(GF) | conditional | 6 | 15 |

The pair-flip is visible in rows 10–11: `L2-1` holds the LB survivor from the *top* half
(`W1-1`, `W1-2` territory) and receives the WB dropper from the *bottom* half (`W2-2`). Those
territories are disjoint, so no rematch is possible. The naive mapping would have put
`L(W2-1)` into `L2-1`, where the dropper faces someone from their own half — a coin flip on
whether it's an instant rematch.

Playable = 14 = `2N − 2`. ✓

### 9.8 Worked example: 11 entrants

`S = 16`, `R = 4`, `B = 5` byes (seeds 1–5), LB rounds = 6, skeleton = 31 = `2S − 1`. ✓
Drop sources: WB R2 (m=4) → `[2,1,4,3]`. WB R3 (m=2) → `[2,1]`. WB R4 (m=1) → `[1]`.

| # | id | slot A | slot B | status | depth | playOrder |
|---|----|--------|--------|--------|-------|-----------|
| 1 | `W1-1` | seed 1 | — | **bye** | 0 | 1 |
| 2 | `W1-2` | seed 8 | seed 9 | playable | 0 | 2 |
| 3 | `W1-3` | seed 4 | — | **bye** | 0 | 3 |
| 4 | `W1-4` | seed 5 | — | **bye** | 0 | 4 |
| 5 | `W1-5` | seed 2 | — | **bye** | 0 | 5 |
| 6 | `W1-6` | seed 7 | seed 10 | playable | 0 | 6 |
| 7 | `W1-7` | seed 3 | — | **bye** | 0 | 7 |
| 8 | `W1-8` | seed 6 | seed 11 | playable | 0 | 8 |
| 9 | `W2-1` | W(W1-1) | W(W1-2) | playable | 1 | 9 |
| 10 | `W2-2` | W(W1-3) | W(W1-4) | playable | 1 | 10 |
| 11 | `W2-3` | W(W1-5) | W(W1-6) | playable | 1 | 11 |
| 12 | `W2-4` | W(W1-7) | W(W1-8) | playable | 1 | 12 |
| 13 | `W3-1` | W(W2-1) | W(W2-2) | playable | 2 | 17 |
| 14 | `W3-2` | W(W2-3) | W(W2-4) | playable | 2 | 18 |
| 15 | `W4-1` | W(W3-1) | W(W3-2) | playable | 3 | 23 |
| 16 | `L1-1` | L(W1-1) | L(W1-2) | **bye** | 1 | 13 |
| 17 | `L1-2` | L(W1-3) | L(W1-4) | **void** | 1 | 14 |
| 18 | `L1-3` | L(W1-5) | L(W1-6) | **bye** | 1 | 15 |
| 19 | `L1-4` | L(W1-7) | L(W1-8) | **bye** | 1 | 16 |
| 20 | `L2-1` | W(L1-1) | L(W2-2) | playable | 2 | 19 |
| 21 | `L2-2` | W(L1-2) | L(W2-1) | **bye** | 2 | 20 |
| 22 | `L2-3` | W(L1-3) | L(W2-4) | playable | 2 | 21 |
| 23 | `L2-4` | W(L1-4) | L(W2-3) | playable | 2 | 22 |
| 24 | `L3-1` | W(L2-1) | W(L2-2) | playable | 3 | 24 |
| 25 | `L3-2` | W(L2-3) | W(L2-4) | playable | 3 | 25 |
| 26 | `L4-1` | W(L3-1) | L(W3-2) | playable | 4 | 26 |
| 27 | `L4-2` | W(L3-2) | L(W3-1) | playable | 4 | 27 |
| 28 | `L5-1` | W(L4-1) | W(L4-2) | playable | 5 | 28 |
| 29 | `L6-1` | W(L5-1) | L(W4-1) | playable | 6 | 29 |
| 30 | `GF` | W(W4-1) | W(L6-1) | playable | 7 | 30 |
| 31 | `GF2` | W(GF) | L(GF) | conditional | 8 | 31 |

Counts: 9 byes, 1 void, **20 playable = 2N − 2**. ✓

Note `L1-2` is `void` — seeds 4 and 5 both had byes, so `W1-3` and `W1-4` produce no losers.
That void propagates into `L2-2`, making it a bye for the `W2-1` loser. This is the cascade
working exactly as designed, with no special-case code.

Note also rows 26–27: `L4-1` pairs the LB survivor from the top half against `L(W3-2)`, the
semifinal loser from the *bottom* half. Disjoint territories, guaranteed no rematch — the
property that `reverse` and `half-shift` both lose at exactly this round.

### 9.9 Round labels

| Bracket | round | key | label |
|---|---|---|---|
| W | `R` | `winners_final` | `Winners Final` |
| W | `R−1` | `winners_semi_final` | `Winners Semi-final` |
| W | other `r` | `winners_round_${r}` | `Winners Round ${r}` |
| L | `2R−2` | `losers_final` | `Losers Final` |
| L | `2R−3` | `losers_semi_final` | `Losers Semi-final` |
| L | other `q` | `losers_round_${q}` | `Losers Round ${q}` |
| GF | 1 | `grand_final` | `Grand Final` |
| GF | 2 | `grand_final_reset` | `Grand Final (Reset)` |

---

## 10. Round robin

`lib/bracket/formats/roundRobin.ts`

### 10.1 Circle method

Let `N` = entrants in the group. If `N` is odd, append a phantom BYE so `n = N + 1` is even;
otherwise `n = N`.

```
rounds      = n − 1
matchSlots  = n / 2 per round
```

```ts
// L is an array of n canonical indices; L[0] stays fixed, the rest rotate.
let L = [0, 1, 2, ..., n-1];
for (let r = 0; r < n - 1; r++) {
  for (let i = 0; i < n / 2; i++) {
    let a = L[i], b = L[n - 1 - i];
    // Berger alternation: flip the fixed player's side on odd rounds so their
    // white/black (or home/away) count stays balanced.
    if (options.sideBalance === 'berger' && r % 2 === 1 && i === 0) { const t = a; a = b; b = t; }
    emit(round r + 1, index i + 1, a, b);
  }
  L = [L[0], L[n - 1], ...L.slice(1, n - 1)];   // rotate positions 1..n-1 right by one
}
```

The rotation `[L[0], L[n-1], L[1], L[2], …, L[n-2]]` is normative. A left rotation produces a
different (also valid) schedule; pick one and never change it, or historical tournaments
re-render differently.

**Verified properties** (§18.3): every unordered pair appears exactly once, every entrant
appears at most once per round, `playable = N(N−1)/2`, `rounds = N` when N is odd else `N−1`.

Match id: `` `G${g}R${round}-${i}` `` where `g` is the 1-based group (always 1 when
`groupCount === 1`). `bracket = 'RR'`.

A slot holding the phantom index (`>= N`) is `{ kind: 'none' }` → the match resolves to
`status: 'bye'` per §7.3 step 3, and the real entrant collects `options.byePoints`.

### 10.2 Double round robin

When `options.legs === 2`, emit the leg-1 schedule, then repeat all `n−1` rounds with **slots A
and B swapped** and rounds numbered `n−1+r`. Ids continue as `G${g}R${round}-${i}` with the
higher round numbers. Total playable = `N(N−1)`.

### 10.3 Groups

`options.groupCount = G > 1`: assign entrants with `snakeAssign(N, G)` over the canonical
seeded order (§6.4), honouring any `groupHint`. Each group then runs its own independent circle
method. Group sizes differ by at most 1; if a group ends up with fewer than 2 entrants,
`E_INVALID_OPTIONS`.

**`indexInRound` is stage-global, not group-local (normative).** The circle method in §10.1 emits
`index i + 1` starting at 1 inside *every* group, so group 1 round 1 and group 2 round 1 would both
emit indices 1, 2 — and `matches` carries `UNIQUE (stage_id, bracket, round, position)`. Emitting
group-local indices as `position` makes every grouped round robin fail its insert batch on a
duplicate `('RR', 1, 0)`, which means cricket groups and the whole documented groups → playoff flow
are unbuildable.

The rule: **emit groups in ascending `g`, and within a group in ascending `i`, assigning
`indexInRound` sequentially `0, 1, 2, …` across the entire (bracket, round) of the stage.** Group
sizes may differ by one, so do not compute the offset as `(g − 1) × matchSlots`; just keep a counter
per `(bracket, round)` across the whole emission. `groupNo` is still set on every match, and the
human-readable `code` is still `G${g}R${round}-${i}` with the group-local `i`, so nothing the
organiser reads changes.

For `bracket = 'BR'` (points lobby, §12.3) the same column is defined as `position = lobbyNo − 1`.

### 10.4 Points

```
points(entrant) =
    Σ over completed, non-bye matches, by (method, outcome):
        method 'normal'  | 'dq'      , win   -> options.points.win
        method 'normal'                , draw  -> options.points.draw
        method 'normal'  | 'dq'      , loss  -> options.points.loss
        method 'walkover'              , win   -> options.points.walkoverWin
        method 'walkover'              , loss  -> options.points.forfeitLoss
        method 'forfeit'               , win   -> options.points.walkoverWin
        method 'forfeit'               , loss  -> options.points.forfeitLoss
        method 'no_contest'            , both  -> options.points.noResult
      + bonusA/bonusB for that entrant
  + options.byePoints × (number of bye matches)
```

`no_contest` is the one row that does not advance the bracket (§7.3 step 8) but **does** score: a
weather-abandoned group match shares `noResult` points to both sides, which is exactly what
OPERATIONS.md §8 routes weather abandonment to. In an elimination format the match must be replayed,
so the points are moot; in a group they decide the table.

`bonusA`/`bonusB` exist for real formats that need them — cricket bonus points for a fast chase
or an early all-out, for instance. The engine just adds them; the score-entry UI decides them.

**All point values are integers** (§4.3); a non-integer is `E_INVALID_OPTIONS`. Defaults:
`{ win: 3, draw: 1, loss: 0, walkoverWin: 3, forfeitLoss: 0, noResult: 1 }` with
`pointsDivisor: 1` for sports; chess ships
`{ win: 2, draw: 1, loss: 0, walkoverWin: 2, forfeitLoss: 0, noResult: 1 }` with `pointsDivisor: 2`
as tournament option data, not as code — displayed as 1 / 0.5 / 0.

These six values are exactly `CONTENT.md` §2.8's `match_points` block
(`{win, draw, loss, no_result, walkover_win, forfeit_loss, points_divisor}`); the seeder projects
that block onto `stages.points_win/draw/loss/bye/divisor` plus the two extra keys inside
`stages.scoring_config_json`, and `validateOptions` reads all of them into `PointsConfig`. There is
one set of numbers and the standings engine consumes it.

`byePoints` default **0** for round robin. In a full round robin with odd N, *every* entrant
gets exactly one bye, so awarding 0 is perfectly fair and keeps "points" readable as "points
actually earned on the board". (Swiss is different — see §11.5.)

### 10.5 Tiebreak chain

Default, applied strictly in order:

1. `points` — descending
2. `headToHead` — descending. Computed **only among the currently tied set**: build a
   mini-table from completed matches where *both* participants are in the tied set, score it
   with the same `options.points`, and compare. For a tied pair this reduces to the direct
   result. If the tied entrants did not all play each other, this yields a partial table —
   that is fine, it is still deterministic; entrants with no mini-table games score 0.
3. `scoreDiff` — `scoreFor − scoreAgainst` across the whole group, descending
4. `scoreFor` — descending
5. `wins` — descending
6. `seed` — **ascending** (the canonical dense seed from §6.1)

`options.tiebreakChain` may override steps 1–5. **The engine unconditionally appends `seed` as
the final comparator regardless of configuration.** That guarantees the chain is total, so the
sort is deterministic and never falls back to input order or a coin toss.

> **Never randomise a tiebreak.** If the club genuinely wants a playoff for a tied first place,
> that is a *new stage* the organiser creates, not a hidden `Math.random()` inside standings.

`headToHead` recursion: after applying head-to-head, if a *sub-group* is still tied, continue
down the chain **within that sub-group** — do not re-run head-to-head on the smaller set. This
avoids the classic infinite-regress bug and matches how football leagues actually resolve it.

### 10.6 Group stage → knockout playoff (`seedNextStage`)

Groups and the knockout are **two separate stages**, not one format. `roundRobin` never emits
knockout matches.

```ts
seedNextStage({ prevStandings, groupCount: G, advancePerGroup: k, ... }): readonly Entrant[]
```

1. From each group take the top `k` by the group's tiebreak chain.
2. Build the playoff seed list in **place-major, group-minor** order:
   `seedIndex(place p, group g) = (p − 1) × G + g`, 1-based.
   So for `G=2, k=2`: `[W1, W2, R1, R2]` → seeds 1, 2, 3, 4.
3. Emit those as `SeededNextEntrant[]` and hand them to a `single_elim` (or `double_elim`) stage
   with `seedingStrategy: 'seeded'`.

`seedNextStage` returns `Entrant` plus the provenance the persistence layer needs to write
`stage_entrants` — the engine computes it, so the adapter never has to re-derive a rank:

```ts
export interface SeededNextEntrant extends Entrant {
  readonly seed: number;              // 1..K, the playoff seed from step 2
  readonly sourceStageId: string;     // the stage this entrant qualified FROM
  readonly sourceRank: number;        // their `rank` in that stage's standings
  readonly sourceGroupNo: number | null;  // which group they came out of (null when ungrouped)
}
export function seedNextStage(input: SeedNextStageInput): readonly SeededNextEntrant[];
```

The adapter writes one `stage_entrants` row per returned entrant:
`(stage_id = the NEW stage, entrant_id, seed, group_no = 1, source_stage_id = sourceStageId,
source_rank = sourceRank, status = 'active')`, and flips the source stage's qualifiers'
`stage_entrants.status` to `'advanced'` and the rest to `'eliminated'`, in the same batch. The new
stage's own `group_no` is assigned later, by *its* generator, if it has groups. This is
`POST /api/v1/organizer/stages/:id/seed` (API.md §4.23.4).

**Why place-major order:** the standard bracket order pairs seed `s` against seed `S+1−s` in
round 1. With `G=2, k=2` that gives `1 v 4` = W1 v R2 and `2 v 3` = W2 v R1 — the correct
cross-group semifinals. The naive "winners then runners-up in reverse group order" list gives
W1 v R1, which is a same-group rematch in the very first knockout match.

**Same-group repair pass.** For odd `G` the formula can still produce a same-group round-1
pairing (e.g. `G=3, k=2`: group 2's winner and group 2's runner-up can meet). Apply this
deterministic repair after seeding, before generation:

```
for i = 1 .. (number of round-1 matches), ascending:
    if slots A and B of match i are from the same group:
        for d = 1 .. (number of round-1 matches − 1):
            j = ((i − 1 + d) mod matchCount) + 1
            if swapping B(i) with B(j) leaves BOTH match i and match j conflict-free:
                swap; break
        // if no swap exists, leave as-is and emit W_SAME_GROUP_R1
```

This only permutes which entrant sits in which position; it never changes the bracket shape,
so the skeleton hash stays meaningful and the bracket is still fully determined by the inputs.

**Cross-group comparison** (needed to order group winners against each other when group sizes
differ): compare by `points / played` desc, then `scoreDiff / played` desc, then
`scoreFor / played` desc, then `seed` asc. Normalising per match played is essential — a
5-entrant group plays 4 games and a 6-entrant group plays 5, and comparing raw points would
systematically favour the larger group.

### 10.7 Score correction in round robin

Trivial. Nothing structural depends on results, so a corrected result changes only the standings
computation. `invalidatedResults` is always empty for round robin. The organiser confirmation
in §7.4 will therefore never fire for this format — which is correct and worth surfacing in the
UI as "this change affects standings only".

---

## 11. Swiss

`lib/bracket/formats/swiss.ts`. **Progressive** (§1.3): one round is paired at a time.

### 11.1 Round count

```ts
export function recommendedSwissRounds(n: number): number {
  if (n < 4) return Math.max(1, n - 1);
  return Math.min(n - 1, Math.ceil(Math.log2(n)) + 1);
}
```

Verified values: `2→1, 3→2, 4→3, 5→4, 7→4, 8→4, 9→5, 11→5, 16→5, 17→6, 32→6, 64→7, 128→8`.

`ceil(log2 n)` is the *minimum* number of rounds that can produce a single undefeated player;
the `+1` is what real events use so that the top of the table separates instead of ending in a
five-way tie on tiebreaks. Capped at `n−1` because beyond that a round robin is unavoidable.
`options.rounds` overrides; the UI should prefill it from this function.

### 11.2 Pairing input

```ts
export interface SwissPlayerHistory {
  readonly entrantId: EntrantId;
  readonly points: number;
  /** Parallel arrays indexed by round-1. Length = number of completed rounds. */
  readonly opponents: readonly (EntrantId | null)[];   // null = bye or unplayed
  readonly colours: readonly ('W' | 'B' | null)[];
  readonly results: readonly ('w' | 'd' | 'l' | 'bye' | 'wo_win' | 'wo_loss')[];
  readonly byeRounds: readonly number[];
  readonly downfloatRounds: readonly number[];
  readonly upfloatRounds: readonly number[];
  readonly seed: number;
}

export interface SwissPairInput {
  readonly round: number;                       // 1-based, the round to pair
  readonly entrants: readonly SeededEntrant[];  // ACTIVE only; withdrawn/DQ excluded
  readonly history: readonly SwissPlayerHistory[];
  readonly options: SwissOptions;
}

export interface SwissPairing {
  readonly matches: readonly SkeletonMatch[];
  readonly byeEntrantId: EntrantId | null;
  readonly warnings: readonly EngineWarning[];
}
```

Match id: `` `S${round}-${i}` ``, `bracket: 'SW'`.

### 11.3 Pairing algorithm

Deterministic, no backtracking beyond the bounded repair described. Every scan direction below
is normative.

**Step 1 — rank.** Sort active entrants by the Swiss tiebreak chain (§11.6) computed over
completed rounds: `points` desc, then the configured tiebreaks, then `seed` asc. Assign
`rank` 1..M. For round 1, all points are 0 so this reduces to `seed` asc.

**Step 2 — accelerated pairings** (optional, `options.accelerated`). For rounds
`1..options.acceleratedRounds`, add **1 virtual point** to the top `floor(M/2)` players by the
round-1 ranking *for pairing purposes only*. Virtual points never appear in standings, never
appear in Buchholz, and are dropped entirely from round `acceleratedRounds + 1`. Purpose: in a
120-player one-day event, acceleration makes the strong players meet each other sooner so the
field separates in fewer rounds. Off by default.

**Step 3 — the bye.** If `M` is odd, exactly one player sits out:

```
candidates := active players sorted by (byeCount asc, rank DESC)
bye := candidates[0]
```

i.e. **the lowest-ranked player who has had the fewest byes.** Remove them from the pool. They
receive `options.byePoints` (default = `points.win`) and their round entry is recorded with
`results[r] = 'bye'`, `opponents[r] = null`, `colours[r] = null`.

Never give a second bye to anyone until every player has had one. The `(byeCount asc, rank
desc)` sort guarantees that.

**Step 4 — score groups.** Partition the pool into score groups by exact point total, ordered by
points descending. Within a group, keep rank order.

**Step 5 — pair each group, top group first**, carrying downfloaters:

```
carry := []
for each score group Gk (descending points):
    S := carry ++ Gk.members            // rank order preserved, carry first (they have more points)
    carry := []
    if S.length is odd:
        floater := the LOWEST-RANKED member of S that minimises
                       (downfloatedLastRound ? 1 : 0, downfloatRounds.length)
                   — scan S from the end toward the front, pick the first
                     player who did not downfloat in the immediately previous round;
                     if every member downfloated last round, pick the last member of S
        remove floater from S; carry := [floater]
    pair(S)
if carry is non-empty after the last group:
    // can only happen if the last group had exactly the floater and nothing else
    -> merge floater into the previous group and re-pair that group; if impossible,
       E_SWISS_NO_LEGAL_PAIRING
```

**`pair(S)` — the fold method:**

```
half := S.length / 2
S1 := S[0 .. half-1]       // top half, rank order
S2 := S[half .. end]       // bottom half, rank order
candidate pairs: (S1[i], S2[i]) for i = 0..half-1
```

**Step 6 — rematch repair** (bounded, deterministic):

```
for i = 0 .. half-1 ascending:
    if S1[i] has already played S2[i]:
        found := false
        for j in [i+1, i+2, ..., half-1] then [i-1, i-2, ..., 0]:      // this exact order
            if  !hasPlayed(S1[i], S2[j]) && !hasPlayed(S1[j], S2[i]):
                swap S2[i] and S2[j]; found := true; break
        if !found:
            for j in [i+1, ..., half-1] then [i-1, ..., 0]:
                if !hasPlayed(S1[j], S2[i]) && !hasPlayed(S1[i], S2[j]):
                    swap S1[i] and S1[j]; found := true; break
        if !found:
            // give up on this group in isolation
            merge this score group with the NEXT one and restart step 5 for the merged group
            if this was the last group:
                accept the rematch, set match.hadRematch = true, emit W_FORCED_REMATCH
```

`hasPlayed(x, y)` consults `history[x].opponents`. A **walkover** counts as having played for
rematch purposes (they were paired; re-pairing them is still undesirable) but does **not** count
for Buchholz (§11.6).

**Step 7 — colours / sides.** Only when `options.sides === 'chess'`. Define
`balance(p) = (#White) − (#Black)` over played games, and `last(p)` = most recent non-null colour.

For each pair `(x, y)` where `x` is the higher-ranked:

```
1. if balance(x) !== balance(y):
       the player with the LOWER balance gets White.
2. else if last(x) !== last(y) and both are non-null:
       the player whose last colour was Black gets White.
3. else if both have the same last colour (or both null after round 1):
       x gets the opposite of last(x); y gets the other.
4. round 1 (no history at all):
       in pair index i (0-based within the group's pairing), S1[i] gets White when i is EVEN,
       Black when i is ODD. This alternates colours down the pairing list and gives the field
       an even split.
5. ABSOLUTE CONSTRAINT: no player may receive the same colour three times in a row.
   If the rule above would do that to exactly one player, force the opposite for the pair.
   If it would do that to BOTH players (they both have the same two-in-a-row colour), keep
   the pairing, apply rule 1-4 anyway, and emit W_COLOUR_VIOLATION on that match.
```

Store the result as `matches.side_a` ∈ `{'W','B'}`.

When `options.sides === 'none'`, slot A is simply the higher-ranked player and `side_a` is NULL.

### 11.4 Progressive materialisation and staleness

`pairSwissRound` is called by **`POST /api/v1/organizer/stages/:id/rounds`** (API.md §4.23.5) when
the organiser presses "Pair round *k*". It requires rounds `1..k−1` to be fully `complete`, `bye`,
or `void`; otherwise `E_ROUND_NOT_COMPLETE`, which that endpoint surfaces as `409 conflict` with
`details.reason: "round_not_complete"`. The resulting `SkeletonMatch[]` is persisted, and from then
on those matches are ordinary rows resolved by the §7 fold.

Because rounds are materialised one at a time, `stages.skeleton_json` for a progressive stage is
**appended to**, not rewritten: it holds every round paired so far, and each successful pairing
rewrites it with the union. This is the one exception to §3.2 invariant 0, and it is safe because a
progressive skeleton only ever grows.

If an *earlier* result is later corrected, the pairings of round `k` are now **stale** — they
are no longer what `pairSwissRound` would produce. The engine does **not** silently re-pair:

```ts
validateProgressive(input): EngineWarning[]
// re-runs pairSwissRound for every materialised round and compares the unordered pair set.
// Any round whose pair set differs yields W_STALE_PAIRINGS(round).
```

The organiser UI shows a banner: *"Round 3's pairings no longer match the corrected results.
Re-pair round 3 (this deletes rounds 3 and later) or keep them as played."* Both choices are
legitimate — a real arbiter would usually keep the played games and just fix the standings.

`validateProgressive`'s warnings are surfaced on `GET /api/v1/organizer/tournaments/:id/bracket`
as `stale_rounds: [3]` (API.md §4.22), which is what drives that banner.

**Carry-over on explicit re-pair:** when the organiser *does* re-pair round `k`
(`DELETE /api/v1/organizer/stages/:id/rounds/:round`, then `POST .../rounds`), any existing
result whose unordered participant pair still exists in the new round-`k` pairing is
**re-attached** to the new match id for that pair (same scores, same winner, `version` bumped,
audited). Pairs that no longer exist are discarded. This means fixing a typo in round 1 usually
preserves most of round 2's already-played games instead of nuking them.

### 11.5 Byes and points in Swiss

`options.byePoints` defaults to `options.points.win` (a full point), which is standard chess
practice: a bye is not the player's fault and should not cost them the event. Contrast round
robin (§10.4), where the default is 0 because everyone gets exactly one.

A bye is not a played game: it does not increment `played`, `wins`, `scoreFor`, or feed
`headToHead`. It **does** feed Buchholz, via the virtual-opponent rule below.

### 11.6 Swiss tiebreaks

Default chain, in order:

1. `points` desc
2. `buchholzCut1` desc — Buchholz with the **single lowest** opponent score discarded
3. `buchholz` desc — full sum of opponents' final scores
4. `sonnebornBerger` desc
5. `wins` desc
6. `headToHead` desc — mini-table among the tied set, as §10.5
7. `seed` asc

**Buchholz** = Σ over the player's rounds of the opponent's final score.

**Sonneborn–Berger** = Σ (opponent's final score) over games won + ½ · Σ (opponent's final
score) over games drawn.

**Unplayed games — the virtual opponent (FIDE rule, applied verbatim).** For a round `r` in
which player `p` had a bye, a forfeit win, or a forfeit loss, the "opponent" contributed to
Buchholz/SB is a **virtual opponent** whose score is:

```
VO(p, r) = pointsOf(p, before round r)
         + (points.win − pointsScoredBy(p, in round r))
         + points.draw × (roundsPlayedSoFar − r)
```

`points.draw` replaces the FIDE rule's literal `0.5` because the engine is integral (§4.3): with
`pointsDivisor: 2`, `points.draw` **is** a half-point. Everything below is in divisor-2 units.

Worked: a full-point bye in round 2 of a 5-round event, for a player who had **2** internal points
(displayed 1.0) before round 2 and scored `points.win = 2` for the bye, with `points.draw = 1`:

```
VO = 2 + (2 − 2) + 1 × (5 − 2) = 2 + 0 + 3 = 5      (internal)
   = 5 / pointsDivisor(2) = 2.5                      (displayed)
```

Every Buchholz and Sonneborn–Berger value is likewise an integer in divisor units. Sonneborn–Berger
uses `points.draw / points.win` weighting expressed integrally: `SB = Σ(opponent score) over wins +
Σ(opponent score × points.draw) / points.win over draws`, evaluated as
`floor((Σ_win × points.win + Σ_draw × points.draw) / points.win)` so no division precedes a
comparison.

Without this rule a player who received a bye gets an artificially low Buchholz and is punished
twice for something outside their control. It is the single most common Swiss tiebreak bug.

`buchholzCut1` discards the lowest single value from the multiset **after** virtual opponents
are substituted in.

---

## 12. Battle royale / points lobbies

`lib/bracket/formats/pointsLobby.ts`. **Progressive.** Covers BGMI, Free Fire, COD Mobile
battle-royale modes, and anything else scored by "place well + get kills, repeat, add it up".

### 12.1 Vocabulary

The word "match" is overloaded in this space. Fixed meanings for this codebase:

| Term | Meaning |
|---|---|
| **stage** | The whole points-lobby phase, e.g. "Day 1 Qualifiers". |
| **round** | One *game* played simultaneously across all lobbies. Called "Match 1", "Match 2" by players and casters. `options.roundsCount` of these. |
| **lobby** | One game instance/room, up to `options.lobbyCapacity` squads. |
| **match row** | **One DB row per (round, lobby).** |

So a 4-lobby, 6-round qualifier is `4 × 6 = 24` match rows, and the public page shows six
"Matches" each containing four lobbies.

### 12.2 Mapping onto the schema

> **A points-lobby match row represents an entire lobby, not a pairing.**
> `entrant_a_id` and `entrant_b_id` are **NULL**. `a` and `b` are `{ kind: 'none' }`.
> Participants live in `match_participants` (one row per squad per lobby).
> `lobby_no` is set. `room_code` holds the in-game lobby/room code.

*Rejected alternative:* one match row per (squad, lobby) pair. For a 25-squad BGMI lobby over 6
rounds that is 150 rows per lobby and 600 for a 4-lobby event, versus 24. On D1, with its
result-set caps and per-request subrequest/CPU budget, that difference is the difference between
one small `.batch()` and a paginated write loop. It also makes "the lobby result" non-atomic —
a partially-written lobby would produce nonsense standings mid-write.

`ResolvedMatch.lobbyRows` carries the computed per-squad points so the UI can render the lobby
table without recomputing.

### 12.3 Lobby assignment

```ts
export interface LobbyAssignInput {
  readonly round: number;
  readonly entrants: readonly SeededEntrant[];   // active only
  readonly options: PointsLobbyOptions;
  readonly standings: readonly Standing[] | null; // cumulative before this round; null for round 1
}
export function assignLobbies(input: LobbyAssignInput): readonly SkeletonMatch[];
```

`L = ceil(N / options.lobbyCapacity)` lobbies. Match id `` `P${round}-L${lobby}` ``,
`bracket: 'BR'`.

Ordering of squads before assignment:

| `lobbyRotation` | round 1 | round `r > 1` |
|---|---|---|
| `snake_by_standings` (default) | canonical seed order | cumulative standings order (§12.6 chain) |
| `rotate` | canonical seed order | canonical seed order **rotated by `r−1` positions** |
| `fixed` | canonical seed order | identical to round 1 |

Then, in every case, **`lobbyOf = snakeAssign(N, L)` applied over that round's ordering**:

```ts
const bucket = snakeAssign(N, L);   // bucket[k] = lobby of the squad standing at position k

// snake_by_standings: position k holds the k-th squad in cumulative standings order.
// fixed:              position k holds canonical index k.
// rotate:             squad i stands at position ((i + (r - 1)) % N).
lobbyOf[i] = bucket[(i + (r - 1)) % N];               // rotate
```

**`rotate` rotates the ORDER, not the lobby label.** The formula an earlier draft shipped,
`lobbyOf[i] = ((i + (r − 1)) mod L) + 1`, is wrong: squads `i` and `j` share a lobby iff
`i ≡ j (mod L)`, which does not depend on `r` at all. Verified by execution for N=8, L=2:
round 1 = `{1:[0,2,4,6], 2:[1,3,5,7]}`, round 2 = `{1:[1,3,5,7], 2:[0,2,4,6]}` — the **same
partition** with the room labels swapped, for every round. `rotate` was exactly `fixed` with renamed
rooms, and the old §18.5 assertion ("index 0 is in lobbies 1, 2, 1, 2") passed anyway, so the suite
could never have caught it.

Verified by execution for the corrected rule (unordered partitions, i.e. ignoring lobby labels):

| N | L | round 1 | round 2 | distinct partitions over 6 rounds |
|---|---|---|---|---|
| 8 | 2 | `{0,3,4,7} {1,2,5,6}` | `{0,1,4,5} {2,3,6,7}` | 2 |
| 17 | 2 | — | ≠ round 1 | 6 |
| 16 | 4 | — | ≠ round 1 | 4 |
| 24 | 3 | — | ≠ round 1 | 3 |

Consecutive rounds always differ. The partition sequence repeats with period `2L` in the worst case
(snake's own period), so `rotate` is a genuine but bounded mixer — it is the right choice for a
fixed field where standings should not influence the draw, and `snake_by_standings` remains the
default for real qualifiers.

Verified: `N=17, capacity=12` → `L=2`, sizes `{1: 9, 2: 8}`.

`snake_by_standings` is the default because it is what real BGMI qualifiers do: it keeps lobby
strength balanced so no single lobby is a death group, and it keeps the leaders visible in
different lobbies for the stream.

### 12.4 Scoring

```
placementPoints(place) = options.placementPoints[place − 1] ?? 0
killPoints(row)        = row.kills × options.killPoints
wwcd(row)              = row.placement === 1 ? options.wwcdBonus : 0
total(row)             = row.disqualified ? 0
                       : placementPoints(row.placement) + killPoints(row) + wwcd(row)
```

Cumulative stage total = Σ over all completed rounds.

**Shipped placement-point presets** (tournament option data, selectable in the create form —
these are values, never code branches):

```ts
// BGMI / PUBG Mobile, Krafton official (16-squad lobby)
PLACEMENT_BGMI_16 = [10, 6, 5, 4, 3, 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0];

// Free Fire, Garena official (12-squad lobby)
PLACEMENT_FREEFIRE_12 = [12, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0];

// BGMI 25-squad club lobby (common at open community events)
PLACEMENT_BGMI_25 = [15, 12, 10, 8, 6, 4, 2, 1, 1, 1, 0, 0, 0, 0, 0,
                     0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
```

`killPoints` default `1`. `wwcdBonus` default `0` (the official tables already load 1st place).
The array may be shorter than the lobby; missing places score 0.

### 12.5 Lobby result validation

`validateResult` for a `LobbyResult` must reject:

- an `entrantId` not assigned to that lobby → `E_LOBBY_ENTRANT_UNKNOWN`
- duplicate `placement` values → `E_LOBBY_PLACEMENT_CONFLICT`
- `placement` outside `1..lobbySize` → `E_LOBBY_PLACEMENT_CONFLICT`
- a gap in placements (must be exactly `1..lobbySize`, each once) → `E_LOBBY_PLACEMENT_CONFLICT`
- negative `kills` → `E_INVALID_SCORE`

Missing squads (a squad no-shows) must still be submitted with a placement — give them the
worst remaining placement and 0 kills. This keeps placements a clean permutation, which is what
the validator requires and what makes the sum of placement points constant per lobby.

**Disqualification inside a lobby:** a squad marked `disqualified: true` scores 0 for that
lobby, and **the other squads' placements are not re-ranked**. If squad #3 is DQ'd, squad #4
stays 4th and keeps 4th-place points.
*Rejected alternative:* promoting everyone below the DQ'd squad. Rejected because it silently
changes the points of every other squad in the lobby, including squads with no involvement in
the incident, and because it means a DQ decided an hour later retroactively rewrites a
published table. Real Krafton/Garena rulings do it the way specified here.

### 12.6 Standings and advancement

Cumulative tiebreak chain (Krafton-style), in order:

1. `points` desc — total points across the stage
2. `brWins` desc — number of 1st-place finishes (WWCDs / Booyahs)
3. `brPlacementPoints` desc
4. `brKillPoints` desc
5. `brBestPlacement` **asc** — best single-round placement achieved
6. `brLastRound` **asc** — placement in the most recent completed round
7. `seed` asc

`options.advanceCount` squads advance. `seedNextStage` emits them as `SeededNextEntrant[]` (§10.6)
with `seed` 1..advanceCount in final standings order, for the next stage (typically another
`points_lobby` "Grand Finals", or a `single_elim` for a hybrid format). The API endpoint that calls
it is `POST /api/v1/organizer/stages/:id/seed` (API.md §4.23.4).

### 12.7 Score correction in points lobbies

A points-lobby round has no structural dependency on the previous round's *results* other than
through `lobbyRotation`. So:

- `lobbyRotation: 'fixed'` or `'rotate'` → correcting a result changes standings only.
  `invalidatedResults` is always empty.
- `lobbyRotation: 'snake_by_standings'` → later rounds' *lobby membership* was derived from
  standings that have now changed. Same treatment as Swiss (§11.4): the engine reports
  `W_STALE_PAIRINGS(round)` via `validateProgressive`, and the organiser explicitly chooses to
  keep or re-assign. **Never silently re-assign lobbies** — squads have already played in those
  lobbies and the room codes have been handed out on WhatsApp.

---

## 13. Withdrawal, walkover, forfeit, disqualification

### 13.1 Withdrawal before vs after generation

- **Before the bracket is generated.** The entrant is simply excluded by `normalizeEntrants`
  step 1. `N` is one smaller, the bracket is smaller, nobody sees a ghost. Nothing else to do.
- **After the bracket is generated.** The skeleton is immutable — it has been published, seeds
  have been shared on WhatsApp, and re-drawing would invalidate everything. Instead, set
  `entrants.status = 'withdrawn'` and `status_changed_at = now`, then recompute. §7.3 steps 1,
  4 and 5 turn every not-yet-decided match involving them into a walkover for the opponent, and
  a match between two inactive entrants into `void`.

Withdrawal is therefore **entrant state, not match mutation**. That is what makes it idempotent,
auditable, and reversible (un-withdraw by setting status back to `active` and recomputing).

*Rejected alternative:* writing walkover results into the affected match rows at the moment of
withdrawal. Rejected because it is not idempotent (two clicks write two results), because
un-withdrawing is then a manual cleanup, and because in double elimination a withdrawal has to
forfeit *two* matches (the current one and the resulting losers-bracket one), which an
event-time mutation gets wrong roughly always.

### 13.2 The four methods

| `method` | Meaning | Bracket effect | Counts as played? | Buchholz |
|---|---|---|---|---|
| `normal` | Played to a conclusion. | winner advances | yes | real opponent |
| `walkover` | Opponent never appeared / withdrew. | winner advances | **no** | virtual opponent (§11.6) |
| `forfeit` | Match started, one side abandoned. | winner advances | yes | real opponent |
| `dq` | Ruling against one side for this match. | winner advances | yes | real opponent |
| `no_contest` | Voided; must be replayed. | **does not advance** (§7.3 step 8) | no | excluded |

Walkover scores are `options.walkoverScore`, **default `[null, null]` — a walkover records no score
at all.** Inventing a notional 2–0 pollutes `setRatio` and `netRunRate` and will decide a group on a
match nobody played; OPERATIONS.md §8 states the same rule for the same reason. `scoreFor`,
`scoreAgainst` and `scoreDiff` are simply not incremented by a walkover, and the winner takes
`points.walkoverWin` while the absent side takes `points.forfeitLoss` (§10.4).

`[ceil(bestOf/2), 0]` — `[1,0]` for a best-of-1, `[2,0]` for a best-of-3 — remains available as an
explicit per-stage `walkoverScore` for formats whose governing body requires a notional scoreline.
It is opt-in, never the default.

For `dq`, both raw scores are recorded as 0 and the winner is credited with `walkoverScore[0]` when
one is configured (otherwise no score), so a DQ contributes nothing distorting to `scoreDiff`.

### 13.3 `isForfeitedBy(entrantId, match)`

```
e := entrantById[entrantId]
if e.status === 'active': return false

// DEFENSIVE. The schema CHECK requires status_changed_at for withdrawn,
// disqualified and no_show — but the engine must not depend on a constraint
// holding in data it did not write. A null here previously evaluated
// `stored.recordedAt < null` as false, fell through, and returned true:
// an already-played, already-published 16:00 result was retroactively
// converted into a walkover for the opponent because the organiser marked
// someone no_show at 18:00.
if e.statusChangedAt === null:
    warnings += W_MISSING_STATUS_TIMESTAMP(e.id)
    return false                       // treat as active; never forfeit on missing data

stored := resultById[match.id]
if stored exists AND stored.recordedAt < e.statusChangedAt: return false   // already played
return true
```

Results recorded **before** the withdrawal/DQ stand. Everything from that moment forward is an
automatic loss. This is the `from_now` semantics and it is the only semantics offered in
elimination formats.

### 13.4 Retroactive disqualification

Sometimes cheating is discovered after the fact and the organiser wants the player's *completed*
results erased, not just their future ones.

- **Allowed** in `round_robin`, `swiss`, `points_lobby`. Set `status = 'disqualified'` and
  `status_changed_at` to a timestamp **before the tournament started**. §13.3 then forfeits
  everything, and standings recompute with all their games as losses (or, if
  `options.removeRetroDqResults` is set by the API layer, the API deletes their result rows
  entirely so opponents' games become byes — this is a persistence-layer choice, and the engine
  handles either input correctly).
- **Refused** in `single_elim` and `double_elim`, with `E_RETRO_DQ_UNSUPPORTED`. Retroactively
  removing a player from a completed elimination bracket means every match they won never
  happened, so their opponents should have advanced, so the entire downstream bracket is
  fictional — including matches other people actually played. There is no correct automatic
  answer. The organiser must instead use `from_now` DQ, and handle any prize consequences
  administratively. **Say this in the UI**, do not just throw an error code.

### 13.5 Bye vs walkover — keep them distinct

A **bye** is structural (no opponent exists). A **walkover** is behavioural (an opponent existed
and did not play). They must never be conflated:

- A bye has `status: 'bye'`, no `method`, no scores, and does not count as a win. Nobody's
  "wins" column should inflate because the bracket had an odd size.
- A walkover has `status: 'complete'`, `method: 'walkover'`, and *does* count as a win.

The public bracket hides byes and shows walkovers as "W/O".

---

## 14. Score correction

The frequent, dangerous, real operation: the organiser typed the wrong winner, three matches
have since been played on top of it, and it must be fixed without corrupting the event.

### 14.1 The algorithm

There is no rollback algorithm. There is only:

```
1. Load the STORED skeleton: JSON.parse(stages.skeleton_json). NEVER regenerate it.
   Load ALL results for the stage.
2. Replace / delete the offending result in that in-memory array, bumping its `version`.
3. next := resolveBracket(skeleton, { entrants, results: modified, options, ... })
4. diff := diffMatches(previouslyResolved, next)
5. If next.invalidatedResults is non-empty and the request is not ?confirm=1:
       return 409 with the list of matches that would be cleared. Do not write.
6. Otherwise persist the diff atomically (§14.4) and write match_audit rows.
```

Step 3 is the same call made after any ordinary result entry. **Correction and normal entry are
literally the same code path.** That is the point: the correction path cannot rot, because it is
the hot path.

**Step 1 is not negotiable.** Re-deriving the skeleton instead of loading it is wrong from the first
withdrawal onwards: `normalizeEntrants` step 1 drops non-active entrants, so a regeneration after
someone withdraws produces a smaller `N`, a different bracket and a different hash. The skeleton is
pinned at generation precisely so that a withdrawal is handled by the fold (§13.1) rather than by
re-drawing a bracket people are already playing. `stages.skeleton_json` carries `seedList`, which is
also where `stage_entrants.seed` came from.

### 14.2 Worked example

8-entrant single elimination. Organiser records `W1-1: seed 1 beat seed 8`, then `W2-1` is
played (`seed 1 beat seed 4`), then `W3-1` is played (`seed 1 beat seed 2`). Now it emerges that
seed 8 actually won `W1-1`.

1. Result for `W1-1` is edited: `winnerEntrantId` = seed 8's id, `version` 1 → 2.
2. Recompute:
   - `W1-1` → complete, winner = seed 8.
   - `W2-1`: computed pair is now `{seed 8, seed 4}`. Its stored result recorded
     `{seed 1, seed 4}`. Sets differ → **invalidated**, status → `ready`.
   - `W3-1`: slot A = `winner(W2-1)` = `null` now. Slot B = seed 2. One slot null →
     §7.3 step 3 would make this a *bye*, which is wrong.

   **This is an important subtlety and must be handled:** a `winner()` reference to a match that
   is `ready`/`pending` is **not** the same as a reference to a `bye`/`void` match. Refine
   `resolveSlot`:

   **This is not a refinement introduced here — it is §7.2's normative `resolveSlot` table and
   §7.3's step 0**, restated for the worked example. A slot that is `UNDETERMINED` (as opposed to
   `STRUCTURAL_NULL`) forces the match to `status: 'pending'` at step 0, before steps 2–3 are
   consulted. Only structural nulls create byes and voids.

   So: `W3-1` → `pending`, its stored result not consulted, and the match reported as invalidated
   to the organiser.
3. `invalidatedResults = ['W2-1', 'W3-1']`. API returns 409 listing both. Organiser confirms.
4. Diff writes: `W1-1` winner changed; `W2-1` entrant_a changed + result cleared + status
   `ready`; `W3-1` entrant_a nulled + result cleared + status `pending`. Three `match_audit`
   rows of kind `result_corrected` / `result_cleared`.

**Contrast — the non-destructive case.** If instead the organiser only fixes the *scoreline*
(`2-1` → `2-0`) with the same winner, no computed pair anywhere changes, `invalidatedResults`
is empty, no confirmation is required, and only one row is written. That distinction is
automatic and requires no branching in the correction code.

### 14.3 `diffMatches`

```ts
export interface MatchDiff {
  readonly updated: readonly ResolvedMatch[];   // any watched field changed
  readonly clearedResults: readonly MatchId[];  // stored result must be deleted
  readonly statusChanges: readonly { id: MatchId; from: MatchStatus; to: MatchStatus }[];
}
```

Watched fields: `entrantAId, entrantBId, status, winnerEntrantId, loserEntrantId, isDraw,
scoreA, scoreB, bonusA, bonusB, sideA, method`. Compare with `Object.is` per field.

`diffMatches` is pure and takes both arrays; the caller supplies `prev` by re-resolving from the
stored results *before* the edit (cheap) rather than by reading derived columns. Re-resolving is
preferred because it guarantees `prev` is internally consistent even if the derived columns had
drifted from a previous partial write.

### 14.4 Persistence: atomicity on D1

D1 has no transactions across requests, but `db.batch()` executes its statements atomically.
The recompute write is:

```
batch([
  // 1. optimistic lock — MUST be first, and MUST bump state_version with it.
  //    bracket_version without state_version means a corrected score is served
  //    from cache under an unchanged ETag: a wrong score on the projector.
  UPDATE tournaments
     SET bracket_version = ?newV,
         state_version   = state_version + 1,
         updated_at      = ?now
   WHERE id = ?tid AND bracket_version = ?oldV,
  // 2. the result upsert / delete (writes result_entrant_a_id/b_id on an upsert,
  //    NULLs them on a delete)
  ...,
  // 3. one UPDATE per changed match row (derived columns only)
  ...,
  // 4. match_audit inserts
  ...,
  // 5. standings: DELETE FROM standings WHERE stage_id = ?  then the bulk INSERT
  ...,
])
```

Then check `results[0].meta.changes === 1`. If it is 0, another organiser wrote concurrently;
discard everything, re-read, and return `409 E_CONCURRENT_MODIFICATION` so the client retries.
Because the whole batch is atomic, a lost race writes nothing.

**Every statement in the batch must carry the guard, not just statement 1.** D1's `.batch()` is
all-or-nothing **only on error**; a statement that matches zero rows is a *successful* statement and
the batch still commits. So every write above gets
`AND (SELECT bracket_version FROM tournaments WHERE id = ?tid) = ?oldV` in its `WHERE`, and every
insert is written as `INSERT INTO … SELECT … WHERE (SELECT bracket_version FROM tournaments WHERE
id = ?tid) = ?oldV`. Only then does `results[0].meta.changes === 0` actually mean "nothing was
written anywhere". See API.md §6.2, which states the same rule for `result_version`.

**Chunking.** Cap a batch at **90 statements**. A correction near the root of a large bracket
can exceed that (a 256-entrant double elimination is 511 matches). When it does:

1. Batch 1: the version bumps (`bracket_version` **and** `state_version`) **plus**
   `UPDATE stages SET status = 'recomputing', updated_at = ?now WHERE id = ?`.
2. Batches 2..n−1: the match updates and audit rows, 90 at a time.
3. Batch n: the standings `DELETE` + bulk `INSERT` for the stage, **plus**
   `UPDATE stages SET status = ? ...` restoring the real status. Standings go last so a stage that
   is still `recomputing` never has a half-written table.

While `stages.status = 'recomputing'`, the read API serves the bracket with a `recomputing: true`
flag and the UI shows a spinner rather than a possibly-inconsistent bracket.

**Recovery from a failed chunk — this must exist, because the chunked path deliberately abandons
atomicity across batches.** If batch 3 of 5 fails (Worker CPU limit, D1 timeout), the stage is left
in `recomputing` with half its derived rows updated. The repair is the one operation that is always
safe, precisely because derived state is a pure function of `(skeleton, entrants, results)`:

> **Any read that finds `stages.status = 'recomputing'` with `stages.updated_at` older than 60
> seconds re-runs the full recompute from `(skeleton_json, entrants, results)` and writes it,
> starting from batch 1 with the *current* `bracket_version` as `oldV`.**

It is idempotent, it needs no knowledge of which chunk failed, and it cannot make things worse. Any
read may trigger it (it runs in `ctx.waitUntil`); the organiser bracket read (API.md §4.22) does so
eagerly. Without it the stage is stuck in `recomputing` forever, half the derived rows carry new
participants while their stale results were never cleared, and — before the
`result_entrant_a_id`/`b_id` fix in §7.4 — the next resolve would silently accept that half-written
state.

In practice `MAX_ENTRANTS = 256` (§17.3) keeps almost every real correction inside one batch — a
club event in Nellore is 8 to 64 entrants.

### 14.5 What the organiser sees

Correction is a **two-tap** flow, never a one-tap flow, whenever `invalidatedResults` is
non-empty:

> Changing this result will clear **2 later results** (Semi-final 1, Final).
> Those matches will need to be scored again.
> **[Cancel]  [Change it anyway]**

And every correction is stamped into `match_audit` with the actor. On a Sunday afternoon with a
₹5,000 prize pool and a WhatsApp group full of screenshots, "who changed this and when" is the
question that gets asked.

---

## 15. Standings

`lib/bracket/standings.ts`.

### 15.1 Placement bands and ties

`Standing.placement` is the **competitive** placement; ties share the *best* place in the band
(`1, 2, 3, 3, 5, 5, 5, 5`). `Standing.rank` is a **display** ordinal, always distinct 1..N,
ordered within a band by `seed` ascending. `placementLabel` is `"1st"`, `"2nd"`, `"3rd"`,
`"4th"`… and `"Joint 5th"` when the band has more than one occupant.

### 15.2 Single elimination

- 1st = winner of `W${R}-1`.
- 2nd = loser of `W${R}-1`.
- If `thirdPlace`: 3rd = winner of `W3P`, 4th = loser of `W3P`.
- Otherwise both semifinal losers are **joint 3rd**.
- A player eliminated in round `r` (where `r = R` is the final) is placed at
  `2^(R − r) + 1`, jointly.

Check for `R = 3` (8 entrants): final loser → `2^0 + 1 = 2` ✓; semifinal losers → `2^1 + 1 = 3`
(joint 3rd) ✓; round-1 losers → `2^2 + 1 = 5` (joint 5th) ✓.

Byes do not affect this: a seed that received a round-1 bye and lost in round 2 was eliminated
in round 2 and is placed accordingly. Entrants still alive have `eliminated: false` and no
placement until the bracket completes; expose `placement: 0` and `placementLabel: '—'` for them.

### 15.3 Double elimination

- 1st = winner of the final grand-final match played (`GF2` if it was played, else `GF`).
- 2nd = the other grand finalist.
- Then walk **LB rounds from `2R−2` down to 1**. In each round, the eliminated players are the
  losers of matches with `status: 'complete'` (byes and voids eliminate nobody). Assign:
  ```
  placement = 3 + (number of players already placed at 3rd or below)
  ```
  and give every player eliminated in that LB round the same placement.

Verified for 16 entrants (LB round sizes 4,4,2,2,1,1): 3rd, 4th, joint 5th (×2), joint 7th (×2),
joint 9th (×4), joint 13th (×4) — totalling `2 + 1 + 1 + 2 + 2 + 4 + 4 = 16`. ✓

Verified for 11 entrants (§9.8; LB rounds with 0, 3, 2, 2, 1, 1 *played* matches): placements
are `1, 2, 3, 4, 5, 5, 7, 7, 9, 9, 9` — eleven players. ✓ Note this uses **played** matches,
not slot counts; using slot counts here would over-allocate placements and produce a 16-row
standings table for an 11-player event.

### 15.4 Round robin

`placement = rank` from the fully-resolved tiebreak chain (§10.5), which is total, so there are
no joint placements. With groups: each group is ranked independently and `Standing.groupNo` is
set. If a playoff stage follows, the *tournament's* final placements come from the playoff
stage; group-stage non-qualifiers are placed after all qualifiers, ordered by
(group finishing position asc, cross-group comparison §10.6).

### 15.5 Swiss

`placement = rank` from §11.6. Total chain, no joint placements.

### 15.6 Points lobby

`placement = rank` from §12.6 on cumulative stage points. Total chain, no joint placements.

### 15.7 Multi-stage tournaments

A tournament's final placement list is: the **last stage's** standings first (placements 1..M),
then earlier stages' non-advancing entrants appended in reverse stage order, each ordered by
that stage's standings, with placements continuing from `M+1`. `seedNextStage` and this rule
together mean a "groups → playoff" or "qualifier → finals" tournament produces one coherent
1..N final table, which is what §16 consumes.

**How the API assembles it at publish time** (`POST .../publish`, API.md §4.16). The exact
procedure, because "reverse stage order" is not enough to implement from:

```
finalPlacements(tournament):
  stages   := SELECT * FROM stages WHERE tournament_id = ? ORDER BY ordinal DESC
  placed   := new Set<EntrantId>()
  out      := []
  next     := 1
  for s in stages:                       // highest ordinal first
      rows := SELECT * FROM standings WHERE stage_id = s.id ORDER BY rank ASC
      band := []                         // preserve joint placements within a stage
      for r in rows:
          if placed.has(r.entrant_id): continue      // an advancer already placed by a later stage
          band.push(r)
      // Re-base this stage's own placements onto `next`, preserving its ties:
      // entrants that shared a placement in `s` still share one here.
      for each tie-band b in band (in rank order):
          for r in b: out.push({ entrant_id: r.entrant_id, placement: next })
          next += b.length
          placed.add(every r.entrant_id in b)
  // Entrants who never appeared in any stage's standings (registered, never played)
  // are appended last, sharing placement `next`, and are excluded from awards by §16.1.
  return out
```

Two consequences worth stating: a group-stage runner-up who lost the playoff final is placed by the
**playoff** stage (it is later, so it wins), and a group-stage entrant who never advanced is placed
below every playoff entrant regardless of how many group points they scored. That is the correct
competitive reading and it is what `entrants.placement` is written from.

---

## 16. Cross-tournament leaderboard points

`lib/bracket/leaderboard.ts`.

### 16.1 Formula

```
award(place, N, weightPct) = max(10, floor( weightPct × FIELD_MILLI(N) × PLACE_TABLE[place] / 100000 ))

weightPct      = tournaments.leaderboard_weight_pct, an INTEGER 0..500 (100 = normal).
                 A weight of 0 means the event awards nothing at all and the
                 max(10, …) floor does NOT apply — check weightPct === 0 first
                 and return no awards.
FIELD_MILLI(N) = a COMMITTED INTEGER LITERAL keyed by nextPowerOfTwo(N), thousandths:
                 { 2:657, 4:714, 8:771, 16:829, 32:886, 64:943, 128:1000, 256:1000 }
PLACE_TABLE[p] = a COMMITTED INTEGER LITERAL, see 16.2
```

**Everything on that line is integer arithmetic.** The original spec used a float `TIER` table and
`0.6 + 0.4 × log2(N)/7` computed at runtime; that reintroduces exactly the hazard §16.2 exists to
kill — `Math.log2` is not required to be correctly rounded either, and the engine must produce
byte-identical awards in the Worker and in the browser preview. `FIELD_MILLI` is a lookup keyed by
`nextPowerOfTwo(N)`, which the engine already computes, and the whole expression is
`(int × int × int) / 100000` with a single floor. The named tiers
(`casual`/`standard`/`major`/`championship`) survive only as create-form shorthand for
`leaderboard_weight_pct` = 50 / 100 / 150 / 200; there is no `tournaments.tier` column.

- Only tournaments with `status = 'completed'` award points.
- **Joint placements award the best place in the band.** Two joint-5th players each get the
  5th-place award. *Rejected alternative:* averaging the band (5th and 6th → the mean).
  Rejected because it produces values players cannot verify by looking at a table, and because
  "we both finished 5th but I got fewer points" is an argument nobody wants to have.
- **Participation floor:** any entrant who played at least one non-bye match gets at least 10
  points. Turning up matters; this is a community club.
- An entrant who withdrew before playing anything gets **0** and does not appear in the award
  list.

### 16.2 `PLACE_TABLE` — why it is a literal, not a computation

`PLACE_TABLE[p]` is mathematically `round(1000 / p^0.8)`, floored at 10. It is **stored as a
committed array of integers**, not computed at runtime.

`Math.pow` is not required to be correctly rounded and implementations differ in the last ULP.
Concretely: `32 ** 0.8` is mathematically exactly `16`, so `round(1000/16)` should be `63` — but
V8 evaluates `Math.pow(32, 0.8)` slightly above 16 and yields **62**. A leaderboard that awards
62 in the Worker and 63 in the browser preview is a support ticket, and a leaderboard that
changes when Cloudflare updates V8 is worse. Hardcode the table.

```ts
// PLACE_TABLE[0] is unused; index by placement directly.
export const PLACE_TABLE: readonly number[] = [
  0,
  1000, 574, 415, 330, 276, 238, 211, 189, 172, 158,   //  1–10
   147, 137, 128, 121, 115, 109, 104,  99,  95,  91,   // 11–20
    88,  84,  81,  79,  76,  74,  72,  70,  68,  66,   // 21–30
    64,  62,  61,  60,  58,  57,  56,  54,  53,  52,   // 31–40
  // …continue to 256 with round(1000 / p**0.8), floored at 10.
  // Reference values for the test suite: [48]=45, [56]=40, [64]=36, [80]=30,
  // [96]=26, [112]=23, [128]=21, [160]=17, [192]=15, [224]=13, [256]=12.
];
// placements beyond 256 award the floor, 10.
```

The table is generated once by a committed throwaway script and pasted in; the test suite
asserts the listed reference values and asserts the array is monotonically non-increasing and
never below 10 after index 1.

### 16.3 Worked awards

16-entrant tournament at `leaderboard_weight_pct = 100` (`FIELD_MILLI(16) = 829`):

**The operator is `floor`, not `round`.** Every value below is
`floor(100 × 829 × PLACE_TABLE[p] / 100000)` = `floor(829 × PLACE_TABLE[p] / 1000)`, computed by
executing the formula. An earlier draft of this table was produced with `round()` and disagreed with
§16.1 in three rows (476/229/143 instead of 475/228/142), which would have failed §18.9 on day one
and invited the wrong fix — changing `floor` to `round` and silently altering every award in the
product.

| placement | `PLACE_TABLE[p]` | 829 × p / 1000 | award |
|---|---|---|---|
| 1st | 1000 | 829.000 | **829** |
| 2nd | 574 | 475.846 | **475** |
| 3rd | 415 | 344.035 | **344** |
| 4th | 330 | 273.570 | **273** |
| joint 5th (×2) | 276 | 228.804 | **228** each |
| joint 9th (×4) | 172 | 142.588 | **142** each |
| joint 13th (×4) | 128 | 106.112 | **106** each |

An 8-entrant event at `leaderboard_weight_pct = 50` (`FIELD_MILLI(8) = 771`) awards
`floor(50 × 771 × 1000 / 100000) = 385` for first — about 46% of a 16-player weight-100 win. Field
size and weight both matter, neither dominates, and nothing above the floor is worth zero.

Reference values the test suite pins: `award(1,16,100) = 829`, `award(2,16,100) = 475`,
`award(5,16,100) = 228`, `award(1,8,50) = 385`, `award(1,128,100) = 1000`, `award(999,4,100) = 10`.

**Walkovers and the leaderboard.** There is no per-walkover discount term in the formula, and there
must not be one — it would make an award unverifiable from the placement table. Instead, one
explicit rule: **an entrant whose non-bye played matches are *all* walkovers or forfeit-wins is
capped at the participation floor (10 points)**, regardless of placement. A team that reached the
semi-final because two opponents never turned up has not had the tournament a team that won two
matches had. This is the only place `method` affects a leaderboard award. (OPERATIONS.md §8 states
the same rule in the operator's words.)

### 16.4 API

```ts
export interface LeaderboardInput {
  readonly finalStandings: readonly Standing[];  // §15.7, whole tournament
  readonly entrantCount: number;                 // N at generation time
  /** tournaments.leaderboard_weight_pct — INTEGER 0..500. 0 = award nothing. */
  readonly weightPct: number;
  readonly gameId: string;
  readonly seasonId: string;
  readonly tournamentId: string;
}
export interface LeaderboardAward {
  readonly entrantId: EntrantId;
  readonly placement: number;
  readonly points: number;
  readonly gameId: string;
  readonly seasonId: string;
  readonly tournamentId: string;
}
export function leaderboardPointsFor(input: LeaderboardInput): readonly LeaderboardAward[];
```

Awards are written once, when a tournament transitions to `completed` (`POST .../publish`), into
**`points_ledger`** — the append-only table in `db/schema.sql` §10. (There is no
`leaderboard_awards` table; `points_ledger` is that table under the name the rest of the system
already uses, and it additionally carries the `voided_at` column that makes `unpublish` a void +
recompute rather than arithmetic on a total.) `leaderboard_entries` is the materialised
`SUM(points) GROUP BY (period, game_id, user_id)` over it.

Storing awards rather than recomputing from history means the leaderboard survives a formula change
without retroactively rewriting last season's standings.

**Team attribution — resolved.** The engine awards the **entrant**. The persistence layer then
writes one `points_ledger` row per **linked roster member** (`entrant_members.user_id IS NOT NULL`),
each for the full award, not a split. Rationale: the leaderboard is a player leaderboard, four
squadmates who won a BGMI cup all won a BGMI cup, and splitting 829 points four ways would rank a
solo chess player above every member of the winning squad. Unlinked (guest) members get nothing,
because there is no account to credit — which is also the strongest nudge in the product towards
creating one.

---

## 17. Errors, warnings, performance budget

### 17.1 Errors (hard; refuse the operation)

```ts
export type EngineErrorCode =
  | 'E_TOO_FEW_ENTRANTS'          // N < 2
  | 'E_TOO_MANY_ENTRANTS'         // N > 256
  | 'E_DUPLICATE_ENTRANT'
  | 'E_UNKNOWN_FORMAT'
  | 'E_INVALID_OPTIONS'
  | 'E_UNKNOWN_MATCH'
  | 'E_RESULT_PARTICIPANT_MISMATCH'  // validateResult: winner not in the match
  | 'E_INVALID_SCORE'
  | 'E_DRAW_NOT_ALLOWED'
  | 'E_RETRO_DQ_UNSUPPORTED'
  | 'E_ROUND_NOT_COMPLETE'
  | 'E_SWISS_NO_LEGAL_PAIRING'
  | 'E_LOBBY_PLACEMENT_CONFLICT'
  | 'E_LOBBY_ENTRANT_UNKNOWN'
  | 'E_CYCLE_IN_SKELETON'
  | 'E_SKELETON_DRIFT';

export class EngineError extends Error {
  readonly code: EngineErrorCode;
  readonly detail: Readonly<Record<string, unknown>>;
}
```

### 17.2 Warnings (soft; surface in the UI, do not block)

```
W_THIRD_PLACE_UNAVAILABLE   S < 4, third-place playoff skipped
W_RESULT_INVALIDATED        a stored result was rejected (matchId in detail)
W_NO_CONTEST_BLOCKS         a no-contest is blocking advancement
W_BOTH_ENTRANTS_INACTIVE    both sides withdrawn/DQ'd; match voided
W_FORCED_REMATCH            Swiss: no legal non-rematch pairing existed
W_COLOUR_VIOLATION          Swiss: a player got a third consecutive same colour
W_STALE_PAIRINGS            progressive format: round N's pairings no longer match results
W_SAME_GROUP_R1             playoff seeding could not avoid a same-group first-round match
W_UNBALANCED_GROUPS         group sizes differ by more than 1 (caused by groupHint)
W_ODD_LOBBY_SIZES           lobby sizes differ by more than 1
W_LOBBY_ENTRANT_INACTIVE    a squad in an unplayed lobby is withdrawn/DQ'd; dropped from scoring (§7.3.1)
W_MISSING_STATUS_TIMESTAMP  status != active but status_changed_at is null; treated as active (§13.3)
W_NRR_INCOMPLETE            a completed match lacks oversFacedMilli; skipped for netRunRate (§4.2.2)
W_TIEBREAKS_TRUNCATED       the chain has more than 5 comparators after `points`; the rest sort but
                            are not persisted and are not standings columns (§4.2.3)
```

### 17.3 Limits and performance

- `MAX_ENTRANTS = 256` per stage. Larger events use multiple stages (qualifiers → finals),
  which is how they run in reality anyway.
- Worst case is a 256-entrant double elimination: 511 skeleton matches.
- **Budget: `generateBracket` + `resolveBracket` together must complete in under 15 ms for 256
  entrants**, measured in `perf.test.ts`. Both are single linear passes with `Map` lookups; the
  realistic figure is well under 5 ms. This matters because it runs inside a Worker request
  alongside the D1 round trips, and it also runs in the browser on a mid-range Android phone
  every time the organiser drags a seed.
- No recursion anywhere. `seedOrder` and the fold are iterative. A 256-deep recursion is fine
  in practice but there is no reason to introduce a stack-depth question into the one module
  that must never fail.
- Allocation discipline: `resolveBracket` allocates one output array of matches and three Maps.
  Do not build intermediate arrays per match.

---

## 18. Test plan and oracles

Every table in this section was produced by executing the specified algorithm. They are
oracles: assert them literally.

### 18.1 Single elimination

`__tests__/singleElim.test.ts`. For each N, assert exactly:

| N | S | R | byes | skeleton | playable | seeds with byes |
|---|---|---|---|---|---|---|
| 2 | 2 | 1 | 0 | 1 | 1 | — |
| 3 | 4 | 2 | 1 | 3 | 2 | 1 |
| 4 | 4 | 2 | 0 | 3 | 3 | — |
| 5 | 8 | 3 | 3 | 7 | 4 | 1,2,3 |
| 7 | 8 | 3 | 1 | 7 | 6 | 1 |
| 8 | 8 | 3 | 0 | 7 | 7 | — |
| 9 | 16 | 4 | 7 | 15 | 8 | 1–7 |
| 11 | 16 | 4 | 5 | 15 | 10 | 1–5 |
| 16 | 16 | 4 | 0 | 15 | 15 | — |
| 17 | 32 | 5 | 15 | 31 | 16 | 1–15 |

Plus:

- **`playable === N − 1` for every N.** Property test over N = 2..256.
- **`skeleton === S − 1`** (+1 with `thirdPlace`).
- `seedOrder` returns the five literal arrays in §6.2.
- N=8, seeded: round 1 pairs are exactly `(1,8) (4,5) (2,7) (3,6)`.
- N=5: the only playable round-1 match is `W1-2` = seed 4 v seed 5.
- N=17: the only playable round-1 match is seed 16 v seed 17.
- **Top seeds never meet early:** for N=16, seeds 1 and 2 can only meet in `W4-1`; seeds 1 and 3
  no earlier than `W3-1`. Property test: for any two seeds `x < y`, the earliest round they can
  meet is `ceil(log2(S / (y − 1)))`… assert instead the concrete cases for S = 8, 16, 32.
- **A freshly generated bracket is not void.** N=8, zero results: assert `W2-1`, `W2-2` and `W3-1`
  are all `status: 'pending'` — **not** `void`. This is the §7.3 step-0 regression test and it is the
  cheapest possible guard on the single worst bug in the engine.
- **A bye does not leak past an undetermined sibling.** N=11 (§9.8), zero results: `W1-1` is `bye`
  with winner = seed 1, and `W2-1` (= `winner(W1-1)` vs `winner(W1-2)`) is `pending` with
  `winnerEntrantId === null`. Assert seed 1 has **not** been advanced into `W3-1`.
- `thirdPlace: true` with N=2 → no `W3P` emitted, `W_THIRD_PLACE_UNAVAILABLE` present.
- `thirdPlace: true` with N=3 → `W3P` emitted and resolves to `status: 'bye'`.
- Match numbering: N=8 yields `W1-1..W1-4` = 1..4, `W2-1`=5, `W2-2`=6, `W3-1`=7, `W3P`=8.

### 18.2 Double elimination

`__tests__/doubleElim.test.ts`.

| N | S | R | LB rounds | skeleton (2S−1) | playable (2N−2) | byes @gen | voids @gen | byes terminal | voids terminal |
|---|---|---|---|---|---|---|---|---|---|
| 2 | 2 | 1 | 0 (special) | 3 | 2 | 0 | 0 | 0 | 0 |
| 3 | 4 | 2 | 2 | 7 | 4 | 1 | 0 | 2 | 0 |
| 4 | 4 | 2 | 2 | 7 | 6 | 0 | 0 | 0 | 0 |
| 5 | 8 | 3 | 4 | 15 | 8 | **3** | **1** | 5 | 1 |
| 7 | 8 | 3 | 4 | 15 | 12 | 1 | 0 | 2 | 0 |
| 8 | 8 | 3 | 4 | 15 | 14 | 0 | 0 | 0 | 0 |
| 9 | 16 | 4 | 6 | 31 | 16 | **7** | **3** | 11 | 3 |
| 11 | 16 | 4 | 6 | 31 | 20 | **5** | **1** | 9 | 1 |
| 16 | 16 | 4 | 6 | 31 | 30 | 0 | 0 | 0 | 0 |
| 17 | 32 | 5 | 8 | 63 | 32 | **15** | **7** | 23 | 7 |

`playable` excludes `GF2`.

**Two bye/void columns, and the distinction matters.** *"@gen"* is the count produced by resolving
a freshly generated skeleton with **zero results**, under §7.3 step 0. *"terminal"* is the count in
the fully played-out bracket (the §9.7/§9.8 tables). An earlier draft published only the terminal
figures while labelling them "the counts at generation" — a test author asserting that literally
either writes a failing test or, worse, "fixes" the engine by collapsing `UNDETERMINED` into `null`,
which reintroduces the all-void bracket and the phantom semi-finalist of §7.2.

Worked, N=11 (§9.8), zero results: the only byes are the five WB round-1 byes `W1-1, W1-3, W1-4,
W1-5, W1-7`, and the only void is `L1-2` (both `loser()` sources point at byes). `L1-1`, `L1-3` and
`L1-4` are **`pending`**, because `loser(W1-2)` / `loser(W1-6)` / `loser(W1-8)` are undetermined,
and `L2-2` is **`pending`** because `loser(W2-1)` is undetermined. So 5 and 1, not 9 and 1.

General rule for the @gen columns: **byes @gen = B** (the WB round-1 byes, §6.3) and
**voids @gen = the number of LB round-1 matches whose two feeder WB matches are both byes**.

Assert additionally:

- **The full match table for N=8 in §9.7**, id for id, slot source for slot source. This is the
  single most valuable test in the suite.
- **The full match table for N=11 in §9.8**, likewise — it is the only one that exercises bye
  and void propagation into the losers bracket simultaneously.
- Drop sources are exactly `[2,1]`, `[2,1,4,3]`, `[2,1,4,3,6,5,8,7]` for m = 2, 4, 8, and `[1]`
  for m = 1.
- **Territory separation property:** for every major LB round with `m > 1`, the WB dropper's
  round-1 territory is disjoint from the LB survivor's. Assert for S = 8, 16, 32, 64.
- **No-rematch property, S = 16, exhaustive-ish:** simulate 20,000 seeded random playouts
  (`mulberry32`, fixed seed) and assert that **zero** rematches occur at LB rounds 2 and 4.
  (Rematches at LB 3 and 5 are expected and permitted — see §9.3.)
- `playable === 2N − 2` for every N = 2..256. Property test.
- `skeleton === 2S − 1` for every N (with `grandFinalReset: true`).
- `grandFinalReset: false` → no `GF2` row at all; skeleton is `2S − 2`.
- **Bracket reset fires:** play a full 8-entrant bracket where the LB-side player wins `GF`.
  Assert `GF2.status !== 'void'` and the champion is `GF2`'s winner.
- **Bracket reset does not fire:** same bracket, WB-side player wins `GF`. Assert
  `GF2.status === 'void'`, `championEntrantId === GF.winnerEntrantId`,
  `complete === true`.
- **Reset then correction:** with the reset played, correct `GF` so the WB-side player wins.
  Assert `GF2` becomes `void` **and** its stored result appears in `invalidatedResults`.
- N=2 special case: exactly `W1-1`, `GF`, `GF2`; the loser of `W1-1` is `GF`'s slot B.
- Placements for N=16: `1, 2, 3, 4, 5, 5, 7, 7, 9, 9, 9, 9, 13, 13, 13, 13`.
- Placements for N=11: `1, 2, 3, 4, 5, 5, 7, 7, 9, 9, 9`.

### 18.3 Round robin

`__tests__/roundRobin.test.ts`.

| N | rounds | playable | bye slots |
|---|---|---|---|
| 2 | 1 | 1 | 0 |
| 3 | 3 | 3 | 3 |
| 4 | 3 | 6 | 0 |
| 5 | 5 | 10 | 5 |
| 7 | 7 | 21 | 7 |
| 8 | 7 | 28 | 0 |
| 9 | 9 | 36 | 9 |
| 11 | 11 | 55 | 11 |
| 16 | 15 | 120 | 0 |
| 17 | 17 | 136 | 17 |

Properties (assert for all the above N):

- Every unordered pair appears **exactly once**.
- No entrant appears twice in the same round.
- `playable === N(N−1)/2`.
- `rounds === (N odd ? N : N − 1)`.
- Odd N: every entrant has exactly one bye.
- Berger side balance: `|whites − blacks| ≤ 1` for every entrant when `sideBalance: 'berger'`.
- N=4 concrete schedule with entrants A,B,C,D in seed order:
  R1 `(A,D) (B,C)`; R2 `(C,A) (D,B)`; R3 `(A,B) (C,D)`.
- `legs: 2`, N=4 → 6 rounds, 12 matches, every ordered pair once.

Tiebreak tests:

- Three-way tie on points, resolved by head-to-head mini-table; assert the exact order.
- Three-way tie where the mini-table is *also* tied → falls through to `scoreDiff`; assert it
  does **not** recurse into head-to-head again.
- Total-order test: 8 entrants all with identical results in every field → order is exactly
  `seed` ascending, and is byte-identical across 100 repeated calls.
- Groups: N=11, `groupCount: 3` → sizes `4, 4, 3` via snake; assert membership by seed.
- `seedNextStage` with `G=2, k=2` → playoff seed list `[W1, W2, R1, R2]`, and the generated
  4-entrant bracket's round-1 matches are `W1 v R2` and `W2 v R1` (no same-group pairing).
- `seedNextStage` with `G=3, k=2` (6 qualifiers, S=8): assert the repair pass eliminates any
  same-group round-1 pairing, or that `W_SAME_GROUP_R1` is emitted if it provably cannot.

### 18.4 Swiss

`__tests__/swiss.test.ts`.

- `recommendedSwissRounds`: `2→1, 3→2, 4→3, 5→4, 7→4, 8→4, 9→5, 11→5, 16→5, 17→6, 32→6, 64→7,
  128→8`.
- Round 1, N=8, seeded: pairs are `(1,5) (2,6) (3,7) (4,8)` — the fold, not `(1,2) (3,4)…`.
- Round 1, N=9: `byeEntrantId` = seed 9 (lowest-ranked, zero byes so far); 4 matches.
- Round 2, N=9: the round-1 bye recipient must **not** get a second bye.
- Full 5-round, 17-player simulation with seeded random results: assert
  (a) no player receives two byes before everyone has one,
  (b) no rematch occurs in any round unless `W_FORCED_REMATCH` was emitted,
  (c) with `sides: 'chess'`, no player has three consecutive identical colours unless
      `W_COLOUR_VIOLATION` was emitted,
  (d) `|whites − blacks| ≤ 2` for every player after 5 rounds.
- Floater: N=7 (odd, so one bye leaves 6), construct scores so a score group has 3 members;
  assert exactly one downfloater, that it is the lowest-ranked eligible member, and that a
  player who downfloated last round is not chosen again while an alternative exists.
- **Buchholz virtual opponent:** 5-round event, chess points `{win: 2, draw: 1, loss: 0}` with
  `pointsDivisor: 2`; player had **2** internal points (displayed 1.0) before round 2 and took a
  full-point bye in round 2. Assert their round-2 Buchholz contribution is exactly the integer
  `2 + 0 + 3 = 5` (displayed 2.5). Assert every `Standing.points` and `TiebreakValue.value` in the
  whole run is an integer — `Number.isInteger` over the entire output — because a `4.5` written into
  `standings.points INTEGER` in a `STRICT` table is a hard error that rolls back the score write.
- Buchholz-cut-1 removes exactly one (the lowest) value, after virtual substitution.
- Sonneborn–Berger: hand-built 4-player, 3-round table with a known answer.
- Determinism: same history + same seed → identical pairings across 100 calls, compared by
  canonical JSON.
- Staleness: pair rounds 1–3, correct a round-1 result, call `validateProgressive`; assert
  `W_STALE_PAIRINGS` for the rounds whose pair sets changed and **not** for those unchanged.
- Re-pair carry-over: on explicit re-pair of round 3, a result whose exact pair still exists is
  carried onto the new match id with its scores intact.

### 18.5 Points lobby

`__tests__/pointsLobby.test.ts`.

- N=17, capacity 12 → 2 lobbies, sizes 9 and 8, membership exactly as `snakeAssign` gives.
- N=64, capacity 25 → 3 lobbies of sizes `{1: 21, 2: 21, 3: 22}` (snake fills the *last*
  bucket on the reversing cycle, so the extra squad lands in lobby 3, not lobby 1 — assert the
  exact map, this is a classic off-by-one).
- One round, one lobby, `PLACEMENT_BGMI_16`, `killPoints: 1`: a squad placing 1st with 8 kills
  scores `10 + 8 = 18`; a squad placing 9th with 3 kills scores `0 + 3 = 3`.
- `PLACEMENT_FREEFIRE_12`: 1st with 5 kills = `12 + 5 = 17`.
- Cumulative across 4 rounds sums correctly per squad.
- Validator rejects: duplicate placement, placement 0, placement > lobby size, a gap in
  placements, an entrant not in that lobby, negative kills.
- DQ'd squad scores 0 and **the other squads' placements and points are unchanged**.
- Tiebreak: two squads on equal points, one with two WWCDs and one with one → the two-WWCD squad
  ranks higher. Then equal WWCDs, differing placement points. Then equal, differing kill points.
  Then equal, differing best single placement. Assert each level fires in order.
- `lobbyRotation: 'rotate'`, N=8, L=2: assert the round-1 and round-2 lobby **partitions** —
  compared as unordered sets of sets, so a mere relabelling of the rooms does **not** pass —
  are different. Round 1 is `{{0,3,4,7}, {1,2,5,6}}` and round 2 is `{{0,1,4,5}, {2,3,6,7}}`.
  Assert those two literal partitions. A per-squad assertion ("index 0 is in lobbies 1, 2, 1, 2")
  is **not** sufficient: the broken formula passed it while producing an identical partition every
  round.
- `lobbyRotation: 'fixed'`, N=8, L=2: assert the round-1 and round-2 partitions are **identical**.
- **A lobby row resolves, it does not void.** Generate a `points_lobby` stage with 4 lobbies × 6
  rounds = 24 rows, store a `LobbyResult` for each, and assert every row is `status: 'complete'`
  with a populated `lobbyRows` — never `void`. This is §7.3.1 step 0b; without it every BR row falls
  through §7.3 step 2 and the whole format silently produces empty standings.
- **Lobby result invalidation:** remove one squad from `lobbyEntrantIds` and assert the stored
  result is rejected (`W_RESULT_INVALIDATED`, `resultAccepted: false`, status back to `ready`).
- **Withdrawal inside an unplayed lobby:** withdraw one squad; assert it is dropped from scoring,
  `W_LOBBY_ENTRANT_INACTIVE` is emitted, and the other squads' points are unchanged.
- `lobbyRotation: 'snake_by_standings'`: correcting a round-1 result triggers
  `W_STALE_PAIRINGS` for round 2; `'fixed'` and `'rotate'` do not.

### 18.6 Withdrawal, walkover, forfeit, DQ

`__tests__/withdrawal.test.ts`.

- **Withdraw before generation:** N=9, one withdraws → the skeleton is the N=8 skeleton exactly
  (same hash as generating with those 8 entrants directly).
- **Withdraw after generation, before playing:** 8-entrant SE, seed 5 withdraws before `W1-2`.
  Assert `W1-2` is `complete`, `method: 'walkover'`, winner seed 4, scores `[1, 0]`, and seed 4
  is in `W2-1`.
- **Withdraw after playing a match:** seed 5 wins `W1-2` at t=100, withdraws at t=200. Assert
  `W1-2` keeps its real result (`recordedAt 100 < 200`) and `W2-1` becomes a walkover for the
  opponent.
- **Withdrawal is idempotent:** resolve twice, identical output, `invalidatedResults` empty the
  second time.
- **Un-withdraw:** set status back to `active`, recompute; the synthesised walkover disappears
  and the match returns to `ready`.
- **Double elimination withdrawal forfeits both sides:** in the N=8 DE bracket, a player who
  withdraws while alive in the winners bracket must forfeit their WB match *and* the LB match
  they drop into. Assert both resolve `complete` with `method: 'walkover'`, with no manual
  intervention.
- **Both sides inactive:** both entrants of a match withdrawn → `status: 'void'`,
  `W_BOTH_ENTRANTS_INACTIVE`, and the void propagates (the next match becomes a bye).
- **`from_now` DQ** in an elimination bracket: completed results before `statusChangedAt` stand.
- **Retroactive DQ** in `single_elim`/`double_elim` → `E_RETRO_DQ_UNSUPPORTED`.
- **Retroactive DQ** in `round_robin` → all their games become losses; opponents' standings
  recompute; no error.
- **Bye is not a win:** a seed with a round-1 bye has `wins: 0`, `played: 0` after round 1.
- **Walkover is a win:** `wins: 1`, and `played: 0` (walkovers do not count as played, §13.2).
- **`no_contest`** on `W1-1` → `W1-1` stays `ready`, `W2-1` is `pending`,
  `W_NO_CONTEST_BLOCKS` emitted, `complete === false`.

### 18.7 Score correction

`__tests__/correction.test.ts`.

- **The §14.2 scenario, end to end:** 8-entrant SE, three matches played, `W1-1` corrected.
  Assert `invalidatedResults === ['W2-1', 'W3-1']`, `W2-1.status === 'ready'`,
  `W3-1.status === 'pending'`, `W3-1.entrantAId === null`.
- **Scoreline-only correction is non-destructive:** change `2-1` to `2-0`, same winner. Assert
  `invalidatedResults` is empty and `diffMatches` reports exactly one updated row.
- **Correction two rounds deep in double elimination:** correct `W1-1` in the N=8 DE bracket
  after `W2-1`, `L1-1`, and `L2-2` have been played. Assert *both* the winners-side and the
  losers-side downstream results are invalidated (the losers bracket depends on `loser(W1-1)`,
  which most naive implementations miss entirely).
- **Correction that swaps sides:** the organiser recorded `entrantA=X, entrantB=Y` but the
  skeleton orientation is `A=Y, B=X`. Assert the result is still accepted (unordered set
  equality) and `scoreA`/`scoreB` are re-oriented onto the skeleton's A/B.
- **Correction of a bye is impossible:** attempting to store a result on a `status: 'bye'`
  match → `validateResult` returns `E_UNKNOWN_MATCH`-class rejection.
- **Round robin correction never invalidates:** `invalidatedResults` empty for every correction.
- **Idempotence:** resolve → resolve → resolve with the same inputs produces byte-identical
  canonical JSON each time.
- **Recompute-from-scratch equals incremental history:** for a full 16-entrant DE playout,
  assert that resolving with the results in *chronological* order and resolving with the same
  results in *reverse array* order produce identical output. (`resultById` picks by `version`,
  so array order must not matter.)

### 18.8 Determinism

`__tests__/determinism.test.ts`.

- `generateBracket` with identical input, called 100 times → identical `hash` every time.
- `seedingStrategy: 'random'` with `rngSeed: 12345` → identical bracket across 100 calls;
  and a *different* bracket for `rngSeed: 12346`.
- **Pinned PRNG values** — assert these literally, so a refactor cannot silently change every
  historical draw:
  ```
  mulberry32(1) first five calls:
    0.6270739405881613
    0.002735721180215478
    0.5274470399599522
    0.9810509674716741
    0.9683778982143849
  seededShuffle([1,2,3,4,5,6,7,8,9,10], 42) === [1,8,4,6,3,2,9,10,5,7]
  ```
  (Compare the floats with `Math.abs(a - b) < 1e-15`, or compare
  `Math.floor(x * 2**32)` as an integer, which is exact.)
- Entrants differing only in `displayName` (including names with combining marks, Telugu script,
  and emoji) produce identical brackets — proving no `localeCompare` crept in.
- Entrants with all-null `seed`, all-null `rating`, and identical `registeredAt` produce an
  order that is exactly `id` ascending by code unit.
- `fnv1a('') === '811c9dc5'` and `fnv1a('nellore.club') === '9a868cca'`.
- `PLACE_TABLE` reference values from §16.2 asserted; monotonically non-increasing; floor 10.

### 18.9 Standings and leaderboard

`__tests__/standings.test.ts`, `__tests__/leaderboard.test.ts`.

- SE N=8 placements: `1, 2, 3, 3, 5, 5, 5, 5` without third-place playoff;
  `1, 2, 3, 4, 5, 5, 5, 5` with it.
- SE N=11 placements: `1, 2, 3, 3, 5, 5, 5, 5, 9, 9, 9`
  (round-1 losers there are only 3 of them; assert the count, not just the values).
- DE N=16 and N=11 placements per §15.3.
- `placementLabel`: `"1st"`, `"2nd"`, `"3rd"`, `"4th"`, `"11th"`, `"21st"`, `"Joint 5th"`.
- `rank` is always a distinct 1..N permutation, ordered by `seed` within a band.
- Leaderboard: the full §16.3 table for a 16-entrant standard tournament, value for value —
  `829, 475, 344, 273, 228, 142, 106`. The operator is `floor`; if your implementation produces
  `476 / 229 / 143` you have used `round`.
- Participation floor: 32nd place in a 32-entrant casual event →
  `max(10, floor(50 × 886 × 62 / 100000))` = `max(10, 27)` = 27; and a 200th-place finisher →
  floor of 10.
- Walkover cap: an entrant whose only non-bye played matches are walkovers is awarded exactly 10,
  regardless of placement (§16.3).
- An entrant who withdrew without playing → **absent** from the award list.
- Joint 5th: both entrants receive an identical award.
- A tournament not in `completed` status → `leaderboardPointsFor` is never called; assert the
  API guard, not the engine.

### 18.10 Performance

`__tests__/perf.test.ts`.

- 256-entrant double elimination: `generateBracket` + `resolveBracket` with a full result set,
  100 iterations, assert median under 15 ms per iteration.
- 256-entrant round robin (32,640 matches would exceed `MAX_ENTRANTS` sanity — assert that
  `round_robin` with N > 64 emits `E_INVALID_OPTIONS` unless `groupCount` keeps every group at
  32 or fewer; a 256-player single round robin is 32,640 matches and is not a thing anyone
  should be able to create by accident).
- `resolveBracket` allocates no more than one output array plus three Maps (assert indirectly
  via a heap-delta check, or skip if the runner cannot measure it — but keep the note).

---

## Appendix A — implementation order

Build in this sequence; each step is independently testable and each unblocks the next.

1. `types.ts`, `errors.ts`, `rng.ts` — no logic to get wrong, but pin the PRNG tests first.
2. `seeding.ts` (`seedOrder`, `normalizeEntrants`, `snakeAssign`) + §18.8 determinism tests.
3. `resolve.ts` + `graph.ts` — the fold, with a hand-written 3-match fixture skeleton.
4. `formats/singleElim.ts` + §18.1. This proves the fold end to end.
5. `standings.ts` for single elimination + §18.9.
6. `formats/doubleElim.ts` + §18.2. **Write the §9.7 and §9.8 tables as tests before writing
   the generator.** They are the specification.
7. `correction.test.ts` (§18.7) — before round robin, because it validates the architecture.
8. `formats/roundRobin.ts`, `tiebreak.ts` + §18.3.
9. `stages.ts` (`seedNextStage`) + the group→playoff tests.
10. `formats/swiss.ts` + §18.4.
11. `formats/pointsLobby.ts` + §18.5.
12. `leaderboard.ts` + §18.9.
13. `perf.test.ts`.

## Appendix B — decisions log

| Decision | Rationale | Rejected alternative |
|---|---|---|
| Recompute-from-scratch, never incremental advance | Score correction becomes the hot path, not a rare untested branch | `advance()` + `rollback()` mutation |
| LB drop = pair-flip | Only scheme keeping *every* major round rematch-free; 2.5–5.9× fewer major-round rematches (measured) | `natural` (4–6× worse), `reverse` / `half-shift` (protect only the first major round), runtime re-pairing (breaks a published bracket) |
| Bye rows are real rows | Uniform advancement graph; correction and audit need no special cases | Omit bye matches, pre-place seeds in round 2 |
| Byes fall out of the seed ordering | Seeds 1..B provably get them, evenly spread; no separate pass to get wrong | Explicit bye-placement pass |
| `GF2` slots are `winner(GF)` / `loser(GF)` | No special case in the fold | `a = WB-side` for visual continuity |
| Withdrawal is entrant state, not match writes | Idempotent, reversible, auditable; forfeits *all* affected matches including the LB drop | Write walkover results at withdrawal time |
| Retroactive DQ refused in elimination formats | No correct automatic answer; would rewrite matches other people actually played | Silently void and re-advance |
| Progressive formats never auto-re-pair | A corrected round-1 result would delete already-played round-3 games | Auto-re-pair on every recompute |
| DQ in a lobby does not re-rank others | A late ruling would silently change uninvolved squads' published points | Promote everyone below |
| Tiebreak chains always end in `seed` | Guarantees a total order; no coin flips, ever | Leave ties unresolved / random |
| `PLACE_TABLE` is a committed literal | `Math.pow` differs in the last ULP across engines; `32**0.8` already misrounds in V8 | Compute `1000 / p**0.8` at runtime |
| One match row per lobby, not per squad | 24 rows vs 600 for a 4-lobby/6-round event; fits D1's budget and makes a lobby result atomic | Row per (squad, lobby) |
| `bracket_seed` stored and published | A random draw becomes reproducible, auditable, and impossible to re-roll | Unseeded `Math.random()` |
| Engine sees only `scoreA`/`scoreB` + opaque `detail` | Keeps the engine game-agnostic; cricket, chess and Valorant share one code path | Per-game scoring branches in the engine |
| `resolveSlot` is three-valued (`ENTRANT` / `STRUCTURAL_NULL` / `UNDETERMINED`), checked at §7.3 step 0 | Two-valued renders a freshly generated bracket entirely `void`, and in the mixed case auto-advances a bye recipient into a semi-final before the sibling match is played | A two-valued `null` plus a `ready → pending` touch-up pass, which cannot undo a `bye` or `void` |
| Lobby rows take their own branch at §7.3 step 0b | Otherwise every BR row resolves to `void` at step 2 and the entire esports format silently produces empty standings | Reusing the head-to-head slot path for lobbies |
| NRR/set-ratio inputs are engine INPUTS (`oversFacedMilli`, `scoreFor`/`scoreAgainst`), stored ×1000 | Keeps the engine out of `result_detail_json`; one `if (game === 'cricket')` in `tiebreak.ts` ends "a new game is a row" | Reading innings out of `result_detail_json` |
| All points are integers with `pointsDivisor` | `standings.points` is `INTEGER` in a `STRICT` table; a chess `4.5` is a hard error that rolls back the whole score write, so no chess event could be scored at all | `{win:1, draw:0.5, loss:0}` and "multiples of 0.5 sum exactly" |
| `result_entrant_a_id`/`b_id` are separate, immutable columns | The invalidation check must compare against what the organiser saw, not against the recompute's own previous output; §14.4's chunking makes the difference reachable | Sourcing the recorded pair from the derived `entrant_a_id`/`entrant_b_id` |
| `stages.skeleton_json` is stored and loaded, never re-derived | Re-deriving after any withdrawal yields a smaller N and fires `E_SKELETON_DRIFT` on the normal flow, blocking every recompute for the rest of the event | Regenerate and compare hashes on every recompute |
| Walkover records **no** score by default | A notional 2–0 pollutes net run rate and set ratio and decides a group on a match nobody played | `[ceil(bestOf/2), 0]` as the default |
| `rotate` rotates the ORDER by `r−1`, then snakes | `((i + r − 1) mod L) + 1` is `fixed` with renamed rooms — the partition never changes | The modulo-`L` label rotation |
