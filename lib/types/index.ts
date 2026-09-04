/**
 * The shared type barrel — the contract between `app/`, `components/`, `lib/`
 * and `worker/`. ARCHITECTURE.md §4 rule 4: the only things the browser half
 * and the Worker half share are these types and HTTP.
 *
 * `export *` on both halves rather than a curated list, because a curated list
 * is a second place to remember and the first symptom of forgetting is a
 * workstream re-declaring a type that already exists. There is exactly one name
 * collision hazard between the two files and it is deliberate:
 *
 *   `./db`  exports row types and STORAGE enums — `MatchStatus`, `EntrantId`,
 *           `TournamentFormat`, and every `*Row`.
 *   `./api` exports WIRE types — `Match`, `PublicEntrant`, `TournamentCard` —
 *           and re-uses the storage enums by importing them, so they are one
 *           definition, not two that can drift.
 *
 * The wire word for a bracket (`winners`) and the storage word (`W`) are the
 * one place the two genuinely differ, and they carry different names
 * (`WireBracket` vs `MatchBracket`) precisely so nobody assigns one to the
 * other by accident.
 *
 * `lib/bracket/**` imports NONE of this (ARCHITECTURE.md §4 rule 1). The engine
 * has its own types and the adapter in `worker/db/bracket-adapter.ts` is the
 * single translation point.
 */

export * from './db';
export * from './api';
