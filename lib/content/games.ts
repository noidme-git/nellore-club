/**
 * Typed loader and `$preset` resolver for `content/games.json` (CONTENT.md §2–§4).
 *
 * The file is imported at **build time**, so `/games/` and `/games/<slug>/`
 * prerender with no request. The same resolved objects are what
 * `scripts/seed-games.ts` projects onto the D1 `games` table (CONTENT.md §6),
 * which is why resolution lives here and not in the seed script: two resolvers
 * would drift, and the thing they would drift on is a phone-number regex.
 *
 * **`$preset` resolution is a SHALLOW merge with sibling keys winning**
 * (CONTENT.md §4). Shallow is deliberate and is the part people get wrong:
 * overriding one key of `validation` means restating the whole `validation`
 * object. A deep merge makes it impossible to *remove* a constraint, and
 * "why is max_length still 10" is a bad afternoon.
 *
 * The Worker never sees a `$preset` — CONTENT.md §4 says resolution happens
 * once, and what lands in D1 is fully expanded. This module is that "once" for
 * the browser half.
 */

import type {
  FieldDef,
  GameCategory,
  JsonObject,
  JsonValue,
  ParticipantType,
  ScoringModel,
  StageFormat,
  VenueMode,
} from '../types';

import raw from '../../content/games.json';

/* =====================================================================
 * Authoring shapes
 * ===================================================================== */

/**
 * A field as authored: either a complete `FieldDef`, or a `$preset` reference
 * with any subset of `FieldDef` overriding it.
 */
export type AuthoredField = FieldDef | ({ $preset: string } & Partial<FieldDef>);

export interface GameIcon {
  /** Rendered in WhatsApp announcement templates and the printed pack (CONTENT.md §2.9). */
  emoji: string;
  /** Forward-compatible id. Nothing reads it in v1 — there is no sprite sheet. */
  sprite: string;
}

export interface GameCategoryDef {
  slug: GameCategory;
  name: string;
  short_name: string;
  description: string;
  icon: GameIcon;
  accent: string;
  sort_order: number;
}

/**
 * Authoring-level status. D1 has only `games.is_active` (0/1): `active` and
 * `beta` seed as 1, `disabled` and `archived` as 0. Only `active` and `beta`
 * may have new tournaments created, and that check reads this field, not
 * `is_active`.
 */
export type GameStatus = 'active' | 'beta' | 'disabled' | 'archived';

export interface GameCompliance {
  /** `false` MUST force `entry_fee_inr = 0` and block a cash prize table (CONTENT.md §2.2). */
  real_money_prizes_allowed: boolean;
  /** `true` shows the organizer a blocking warning before publish. */
  review_required: boolean;
  notes: string;
}

export interface GameParticipant {
  type: ParticipantType;
  team_size_min: number;
  team_size_max: number;
  substitutes_max: number;
  captain_required: boolean;
  member_label: string;
  roster_locked_at: 'registration' | 'check_in' | 'never';
  allow_partial_roster: boolean;
  free_agent_pool: boolean;
  supports_pairs: boolean;
}

export interface GameTournamentDefaults {
  format: StageFormat;
  seeding: string;
  third_place_match: boolean;
  min_participants: number;
  max_participants: number;
  check_in_opens_minutes_before: number;
  check_in_closes_minutes_before: number;
  /** Authored in whole RUPEES. D1 stores paise; multiply by 100 (CONTENT.md §2.5). */
  entry_fee_inr_default: number;
  typical_duration_minutes: number;
  multi_stage: boolean;
  /** Only read for `swiss` and `points_lobby`. */
  rounds?: number;
}

export interface GameMatchDefaults {
  best_of: number;
  duration_minutes: number;
  buffer_minutes: number;
  venue_kind: VenueMode;
  needs_lobby_code: boolean;
  lobby_code_label: string | null;
  lobby_password_label: string | null;
  /** Free-form, chess only. Displayed verbatim. */
  time_control?: string;
}

/** `params` is model-specific (CONTENT.md §5) and is passed through untouched. */
export interface GameScoringDef<TField = FieldDef> {
  model: ScoringModel;
  side_labels: string[];
  side_assignment: string;
  params: JsonObject;
  match_fields: TField[];
}

export interface GameMatchPoints {
  win: number;
  draw: number;
  loss: number;
  no_result: number;
  walkover_win: number;
  forfeit_loss: number;
  /** Chess/scrabble use 2 so 1 / 0.5 / 0 is stored as 2 / 1 / 0 with no REAL anywhere. */
  points_divisor: number;
}

export interface GameStandings {
  match_points: GameMatchPoints;
  /** Ordered tokens, applied until one separates. Always terminated by a total order. */
  tiebreakers: string[];
}

export interface GameLeaderboard {
  counts_toward_global: boolean;
  /** Integer percent, 0–500. `counts_toward_global: false` seeds 0. */
  default_weight_pct: number;
}

export interface GameRating {
  has_rating: boolean;
  rating_kinds: string[];
}

/**
 * A game exactly as authored. `TField` is `AuthoredField` in the raw file and
 * `FieldDef` after `resolveGame`, so the two states are distinguishable at the
 * type level and an unresolved `$preset` cannot reach a form renderer.
 */
export interface GameDefinitionOf<TField> {
  slug: string;
  name: string;
  full_name: string;
  short_name: string;
  category: GameCategory;
  subcategory: string;
  status: GameStatus;
  sort_order: number;
  tagline: string;
  description: string;
  search_terms: string[];
  icon: GameIcon;
  accent: string;
  age_min: number;
  equipment: string[];
  rules_summary: string[];
  rules_url: string | null;
  compliance: GameCompliance;
  participant: GameParticipant;
  registration_fields: TField[];
  member_fields: TField[];
  tournament_defaults: GameTournamentDefaults;
  match_defaults: GameMatchDefaults;
  scoring: GameScoringDef<TField>;
  standings: GameStandings;
  leaderboard: GameLeaderboard;
  primary_ingame_id_field: string | null;
  primary_ingame_id_label: string | null;
  rating: GameRating;
}

export type AuthoredGame = GameDefinitionOf<AuthoredField>;
/** Every `$preset` expanded. This is what renders and what the seed script projects. */
export type GameDefinition = GameDefinitionOf<FieldDef>;

interface GamesFile {
  $schema_version: number;
  $field_types: string[];
  $scoring_models: string[];
  categories: GameCategoryDef[];
  field_presets: Record<string, FieldDef>;
  games: AuthoredGame[];
}

/**
 * The one cast in this file. The inferred type of a large JSON literal is a
 * union of every shape that appears across twenty games — `params` alone
 * differs per scoring model — so structural assignability cannot be established
 * without it. `scripts/seed-games.ts` validates the file against the D1 CHECK
 * constraints at build time, which is where a real mismatch is caught.
 */
const file = raw as unknown as GamesFile;

/* =====================================================================
 * $preset resolution — CONTENT.md §4
 * ===================================================================== */

export class PresetError extends Error {
  readonly presetName: string;

  constructor(presetName: string, context: string) {
    super(`Unknown $preset "${presetName}" referenced by ${context}. Add it to field_presets in content/games.json.`);
    this.name = 'PresetError';
    this.presetName = presetName;
  }
}

function hasPreset(field: AuthoredField): field is { $preset: string } & Partial<FieldDef> {
  return typeof (field as { $preset?: unknown }).$preset === 'string';
}

/**
 * `resolved = { ...field_presets[$preset], ...obj }`, then `$preset` removed.
 * Sibling keys win; the merge is shallow, so an override of `validation`
 * replaces the whole object rather than merging into it.
 *
 * Throws on an unknown preset. CONTENT.md §4: "If a `$preset` names a key that
 * does not exist, the seed script exits non-zero and writes nothing." Silently
 * dropping the field would ship a registration form missing the captain's
 * WhatsApp number, which is discovered on match day.
 */
export function resolveField(field: AuthoredField, context = 'content/games.json'): FieldDef {
  if (!hasPreset(field)) return field;

  const { $preset, ...overrides } = field;
  const base = file.field_presets[$preset];
  if (base === undefined) throw new PresetError($preset, context);

  return { ...base, ...overrides };
}

export function resolveFields(fields: AuthoredField[], context?: string): FieldDef[] {
  return fields.map((field) => resolveField(field, context));
}

export function resolveGame(game: AuthoredGame): GameDefinition {
  const where = `game "${game.slug}"`;
  return {
    ...game,
    registration_fields: resolveFields(game.registration_fields, `${where} registration_fields`),
    member_fields: resolveFields(game.member_fields, `${where} member_fields`),
    scoring: {
      ...game.scoring,
      match_fields: resolveFields(game.scoring.match_fields, `${where} scoring.match_fields`),
    },
  };
}

/* =====================================================================
 * The catalogue
 * ===================================================================== */

/** All twenty games, fully resolved, in file order. Resolved once at module load. */
export const games: GameDefinition[] = file.games.map(resolveGame);

export const categories: GameCategoryDef[] = file.categories;

/** The fifteen presets, for a form builder that offers "add a standard field". */
export const fieldPresets: Readonly<Record<string, FieldDef>> = file.field_presets;

const BY_SLUG = new Map<string, GameDefinition>(games.map((game) => [game.slug, game]));

export function gameBySlug(slug: string): GameDefinition | null {
  return BY_SLUG.get(slug) ?? null;
}

export function categoryBySlug(slug: string): GameCategoryDef | null {
  return categories.find((category) => category.slug === slug) ?? null;
}

/** `active` and `beta` — the two statuses that seed `is_active = 1`. */
export function isPlayable(game: GameDefinition): boolean {
  return game.status === 'active' || game.status === 'beta';
}

/** Playable games, ordered as the game list page renders them (CONTENT.md §6.1). */
export function activeGames(): GameDefinition[] {
  return games
    .filter(isPlayable)
    .sort(
      (a, b) =>
        categoryOrder(a.category) - categoryOrder(b.category) || a.sort_order - b.sort_order,
    );
}

function categoryOrder(slug: GameCategory): number {
  return categoryBySlug(slug)?.sort_order ?? 999;
}

export function gamesInCategory(category: GameCategory): GameDefinition[] {
  return activeGames().filter((game) => game.category === category);
}

/**
 * The game picker's matcher. `search_terms` is why "pubg" finds BGMI and
 * "kabbadi" — a deliberate misspelling in the file — finds kabaddi.
 * Prefix-and-substring over a 20-element array; no index, no fuzzy library.
 */
export function searchGames(query: string): GameDefinition[] {
  const q = query.trim().toLowerCase();
  if (q === '') return activeGames();
  return activeGames().filter(
    (game) =>
      game.slug.includes(q) ||
      game.name.toLowerCase().includes(q) ||
      game.full_name.toLowerCase().includes(q) ||
      game.search_terms.some((term) => term.includes(q)),
  );
}

/* =====================================================================
 * Field-schema helpers
 * ===================================================================== */

/** The `scope` tag is positional in the content file and explicit in D1 (CONTENT.md §6.1). */
export type FieldScope = 'entrant' | 'member';

export interface ScopedFieldDef extends FieldDef {
  scope: FieldScope;
}

/**
 * The single concatenated array that becomes `games.registration_fields_json`:
 * `registration_fields` tagged `entrant`, then `member_fields` tagged `member`.
 */
export function scopedRegistrationSchema(game: GameDefinition): ScopedFieldDef[] {
  return [
    ...game.registration_fields.map((field) => ({ ...field, scope: 'entrant' as const })),
    ...game.member_fields.map((field) => ({ ...field, scope: 'member' as const })),
  ];
}

/**
 * The render-time split back into two arrays. The API serves the concatenated
 * form (`TournamentDetail.registration_schema`), and the registration form
 * needs to know which questions are asked once and which are asked per player.
 *
 * An untagged field defaults to `entrant`: a snapshot written before the tag
 * existed must still render its questions rather than silently dropping them.
 */
export function splitRegistrationSchema(schema: readonly FieldDef[]): {
  entrant: FieldDef[];
  member: FieldDef[];
} {
  const entrant: FieldDef[] = [];
  const member: FieldDef[] = [];
  for (const field of schema) {
    const scope = (field as Partial<ScopedFieldDef>).scope;
    if (scope === 'member') member.push(field);
    else entrant.push(field);
  }
  return { entrant, member };
}

/**
 * The FieldDef that carries the game's in-game identity, resolved through the
 * preset chain. Seeds `games.ingame_id_pattern` (CONTENT.md §6.1) and is what a
 * form highlights as the field an organiser will actually chase people for.
 */
export function primaryIngameIdField(game: GameDefinition): FieldDef | null {
  if (game.primary_ingame_id_field === null) return null;
  const key = game.primary_ingame_id_field;
  return (
    game.member_fields.find((field) => field.key === key) ??
    game.registration_fields.find((field) => field.key === key) ??
    null
  );
}

/**
 * Evaluate a `visible_if` condition against the values entered so far
 * (CONTENT.md §3.5). A hidden field is never required, whatever `required`
 * says, and its value is dropped on submit — so this predicate gates
 * validation, not just rendering.
 *
 * No nesting and no and/or, by design: if you need boolean logic you need two
 * fields.
 */
export function isFieldVisible(field: FieldDef, values: Record<string, JsonValue>): boolean {
  const condition = field.visible_if;
  if (condition === undefined) return true;

  const value = values[condition.field];

  if ('equals' in condition) return value === condition.equals;
  if ('in' in condition) {
    return (
      (typeof value === 'string' || typeof value === 'number') &&
      (condition.in as (string | number)[]).includes(value)
    );
  }
  if ('not_empty' in condition) {
    if (value === null || value === undefined || value === '') return false;
    return !(Array.isArray(value) && value.length === 0);
  }
  if ('lt' in condition) return typeof value === 'number' && value < condition.lt;
  if ('gt' in condition) return typeof value === 'number' && value > condition.gt;

  return true;
}

/** Roster capacity: playing members plus substitutes. There is no `default_roster_max` column. */
export function rosterMax(game: GameDefinition): number {
  return game.participant.team_size_max + game.participant.substitutes_max;
}

/** `entry_fee_inr_default` is authored in rupees; every storage path wants paise. */
export function defaultEntryFeePaise(game: GameDefinition): number {
  return game.tournament_defaults.entry_fee_inr_default * 100;
}
