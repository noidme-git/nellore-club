/**
 * One typed function per route in **API.md Appendix C**, in Appendix C order.
 *
 * Why a function per endpoint rather than a generic `api.get(path)`: the path,
 * the method, the query shape, whether an `Idempotency-Key` is *required*
 * (API.md §6.1) and whether a `version` guard is *required* (§6.2) are facts of
 * the contract, not of the call site. Encoded here they are encoded once;
 * spread across forty components they are wrong in one of them, and the one
 * they are wrong in is the score endpoint.
 *
 * Conventions, uniform across the file:
 *
 *  - Endpoints where API.md §6.1 says "Idempotency: required" take
 *    `idempotencyKey` as a **required** argument. A caller cannot forget it,
 *    and `newIdempotencyKey()` must be minted once per logical attempt and
 *    reused across retries — not regenerated per retry.
 *  - Endpoints where §6.2 requires a concurrency token carry `version` (or
 *    `result_version`) as a required field of the body type, named exactly
 *    after the column so there is no translation layer to get wrong.
 *  - Public GETs return the payload. `useResource` wants the ETag and
 *    `Poll-After` too, so it calls `request()` from `./client` directly with
 *    the path built by `paths.*` below — that is the only reason those path
 *    builders are exported.
 *  - Every WebAuthn ceremony payload is generic with a `JsonObject` default, so
 *    this module never imports `@simplewebauthn/browser`. ARCHITECTURE.md §4:
 *    `lib/api` imports `lib/types` and nothing else. The auth workstream calls
 *    `passkeyLoginOptions<PublicKeyCredentialRequestOptionsJSON>()`.
 */

import type {
  Announcement,
  AnnouncementSeverity,
  AuthSession,
  BracketResponse,
  ClubResponse,
  ConfigResponse,
  EntrantId,
  EntrantStatus,
  EntrantsMeta,
  FieldValues,
  Game,
  GameCategory,
  HandleAvailability,
  JsonObject,
  LeaderboardMeta,
  LeaderboardMetric,
  LeaderboardRow,
  LiveResponse,
  Match,
  MatchId,
  MatchMethod,
  MatchWithEntrants,
  MeProfile,
  MyRegistration,
  PaymentStatus,
  Paise,
  ParticipantType,
  PlayerProfile,
  PrivateEntrant,
  PublicEntrant,
  Rfc3339,
  SearchResponse,
  SessionId,
  StageFormat,
  StageId,
  StandingsResponse,
  TournamentCard,
  TournamentDetail,
  TournamentFormat,
  TournamentId,
  TournamentOverview,
  TournamentStatus,
  UserId,
  UserRole,
  Venue,
  VenueId,
  VenueMode,
} from '../types';

import type { Paged as PagedResult, QueryParams } from './client';
import { del, get, getPaged, patch, post, put } from './client';

/* =====================================================================
 * Path builders
 *
 * Exported because `components/data/useResource.ts` keys its localStorage
 * cache on `nc:v1:<method>:<path>` and its poller on the tournament slug, so it
 * needs the exact string this module would have fetched.
 * ===================================================================== */

export const paths = {
  config: () => '/config',
  games: () => '/games',
  game: (slug: string) => `/games/${encodeURIComponent(slug)}`,
  venues: () => '/venues',
  club: () => '/club',
  announcements: () => '/announcements',
  leaderboard: () => '/leaderboard',
  player: (handle: string) => `/players/${encodeURIComponent(handle)}`,
  live: () => '/live',
  search: () => '/search',
  invite: (code: string) => `/invites/${encodeURIComponent(code)}`,
  tournaments: () => '/tournaments',
  tournament: (slug: string) => `/tournaments/${encodeURIComponent(slug)}`,
  tournamentOverview: (slug: string) => `/tournaments/${encodeURIComponent(slug)}/overview`,
  tournamentEntrants: (slug: string) => `/tournaments/${encodeURIComponent(slug)}/entrants`,
  tournamentBracket: (slug: string) => `/tournaments/${encodeURIComponent(slug)}/bracket`,
  tournamentMatches: (slug: string) => `/tournaments/${encodeURIComponent(slug)}/matches`,
  tournamentStandings: (slug: string) => `/tournaments/${encodeURIComponent(slug)}/standings`,
  tournamentAnnouncements: (slug: string) =>
    `/tournaments/${encodeURIComponent(slug)}/announcements`,
  authSession: () => '/auth/session',
  me: () => '/me',
  myRegistrations: () => '/me/registrations',
} as const;

/* =====================================================================
 * Shared query shapes
 * ===================================================================== */

/** API.md §0.9. `limit` defaults to 20 and is clamped at 100, never rejected. */
export interface PageQuery {
  limit?: number;
  cursor?: string | null;
}

/* =====================================================================
 * §1 Public read API
 * ===================================================================== */

/** §1.1 — feature flags, limits and the nav badge counts. */
export function getConfig(): Promise<ConfigResponse> {
  return get<ConfigResponse>(paths.config());
}

export interface GamesQuery extends PageQuery {
  category?: GameCategory;
  /** Admin-only in effect: the public list is active games. */
  active?: boolean;
}

/** §1.2 */
export function listGames(query: GamesQuery = {}): Promise<PagedResult<Game>> {
  return getPaged<Game>(paths.games(), { query: query as QueryParams });
}

/** §1.3 */
export function getGame(slug: string): Promise<Game> {
  return get<Game>(paths.game(slug));
}

/** §1.15 */
export function listVenues(): Promise<PagedResult<Venue>> {
  return getPaged<Venue>(paths.venues());
}

/** §1.14 — a structural passthrough; `lib/content/club.ts` owns the shape. */
export function getClub(): Promise<ClubResponse> {
  return get<ClubResponse>(paths.club());
}

/** §1.11 — club-wide announcements plus promoted tournament ones. */
export function listClubAnnouncements(query: PageQuery = {}): Promise<PagedResult<Announcement>> {
  return getPaged<Announcement>(paths.announcements(), { query: query as QueryParams });
}

export interface LeaderboardQuery extends PageQuery {
  /** A game slug, or `all`. */
  game?: string;
  /** Mutually exclusive with `game`; `game` wins if both are sent. */
  category?: GameCategory;
  /** `all_time` | `season:<season_slug>`. Nothing else in v1. */
  period?: string;
  /** `rating` returns 501 in v1 (§1.12.2) — do not offer it in the UI. */
  metric?: LeaderboardMetric;
}

/** §1.12 — served from the materialised `leaderboard_entries` table. */
export async function getLeaderboard(
  query: LeaderboardQuery = {},
): Promise<{ rows: LeaderboardRow[]; page: PagedResult<LeaderboardRow>['page']; meta: LeaderboardMeta | null }> {
  const result = await getPaged<LeaderboardRow>(paths.leaderboard(), { query: query as QueryParams });
  return { rows: result.data, page: result.page, meta: (result.meta as LeaderboardMeta | null) ?? null };
}

/** §1.13 — 404 for an unknown handle, a deleted account, or `profile_public = 0`. */
export function getPlayer(handle: string): Promise<PlayerProfile> {
  return get<PlayerProfile>(paths.player(handle));
}

/** §1.16 — every live tournament plus every live match, in one call. Query-free by design. */
export function getLive(): Promise<LiveResponse> {
  return get<LiveResponse>(paths.live());
}

export interface SearchQuery {
  q?: string;
  /** Comma-joined by the client: `tournaments`, `players`, `games`. */
  type?: ('tournaments' | 'players' | 'games')[];
  /** ≤ 20 per type, default 5. */
  limit?: number;
}

/** §1.16.1 */
export function search(query: SearchQuery = {}): Promise<SearchResponse> {
  return get<SearchResponse>(paths.search(), { query: query as QueryParams });
}

/* ---- Invites (public; must be matched before any /invites/:id route) ---- */

export interface InvitePreview {
  valid: boolean;
  kind?: 'roster' | 'join';
  tournament?: { slug: string; title: string; game: { slug: string; name: string }; starts_at: Rfc3339 };
  entrant_display_name?: string;
  slot_no?: number;
  expires_at?: Rfc3339 | null;
}

/**
 * §3.12.2 — the landing read for an invite link. An unknown, revoked, expired
 * or consumed code is `404` with `{ valid: false }`, deliberately not a `410`:
 * distinguishing "consumed" from "never existed" turns this into an oracle for
 * guessed codes.
 */
export function getInvite(code: string): Promise<InvitePreview> {
  return get<InvitePreview>(paths.invite(code));
}

export interface AcceptInviteBody {
  display_name?: string;
  /** Validated against the schema's `member_fields`; unknown keys are rejected. */
  fields?: FieldValues;
}

/** §3.12.3 — session required; returns the `PrivateEntrant` the caller just joined. */
export function acceptInvite(code: string, body: AcceptInviteBody): Promise<PrivateEntrant> {
  return post<PrivateEntrant>(`${paths.invite(code)}/accept`, { body });
}

/* ---- Tournaments ---- */

export interface TournamentListQuery extends PageQuery {
  /** A slug, or up to 10 comma-joined slugs. */
  game?: string[] | string;
  category?: GameCategory;
  /** `draft` and `archived` are never returned regardless of what is asked. */
  status?: TournamentStatus[];
  format?: TournamentFormat;
  fee?: 'free' | 'paid';
  from?: Rfc3339;
  to?: Rfc3339;
  /** ≤ 60 chars, case-insensitive substring on title. */
  q?: string;
  sort?: 'starts_at_asc' | 'starts_at_desc' | 'newest';
}

/** §1.4 — the home page and `/tournaments/`. */
export function listTournaments(
  query: TournamentListQuery = {},
): Promise<PagedResult<TournamentCard>> {
  return getPaged<TournamentCard>(paths.tournaments(), { query: query as QueryParams });
}

/** §1.5.2 — inline signup validation. `private, no-store`: a cached "available" is worse than a round-trip. */
export function checkHandleAvailable(handle: string): Promise<HandleAvailability> {
  return get<HandleAvailability>('/handle-available', { query: { handle } });
}

export interface RegisterMemberInput {
  /** A linked account. Mutually exclusive with `display_name`. */
  handle?: string;
  /** An unlinked name, for a squadmate with no account. */
  display_name?: string;
  role?: 'captain' | 'player';
  is_substitute?: boolean;
  fields?: FieldValues;
}

export interface RegisterBody {
  /** Must equal the tournament's `participant_type`. */
  participant_type: ParticipantType;
  /** Team entries only. 2..40 chars. */
  team_name?: string;
  /** ≤ 6 chars, `[A-Za-z0-9]`. */
  team_tag?: string;
  members?: RegisterMemberInput[];
  /** Entrant-level answers, validated against the effective `registration_schema`. */
  fields?: FieldValues;
  /** Required iff `requires_phone` and the user has none on file. */
  phone_e164?: string;
  /** ≤ 300 chars, organizer-visible only. */
  notes?: string;
  /** Must be `true`. */
  agree_rules: boolean;
  /** Required iff `requires_join_code`. */
  join_code?: string;
}

export interface RegisterResponse {
  entrant: PrivateEntrant;
  position: 'pending' | 'confirmed' | 'waitlisted';
  waitlist_position: number | null;
}

/**
 * §3.3 — the single registration endpoint for solo and team, every game.
 * `Idempotency-Key` is required: a POST that times out on 4G has almost
 * certainly reached the Worker, and the retry must not create a second entrant.
 */
export function registerForTournament(
  slug: string,
  body: RegisterBody,
  idempotencyKey: string,
): Promise<RegisterResponse> {
  return post<RegisterResponse>(`${paths.tournament(slug)}/register`, { body, idempotencyKey });
}

export interface GuestRegisterBody extends Omit<RegisterBody, 'phone_e164'> {
  /** The walk-in's own name — there is no account to take it from. */
  display_name: string;
  phone_e164?: string;
  /** Required when `TURNSTILE_SECRET_KEY` is configured. */
  turnstile_token?: string;
}

export interface GuestRegisterResponse {
  entrant: PrivateEntrant;
  /** Shown ONCE. A bearer capability scoped to exactly one entrant (AUTH.md §8.3). */
  guest_token: string;
  position: 'pending';
}

/** §3.4 — no account. Always created `pending`, regardless of `requires_confirmation`. */
export function guestRegisterForTournament(
  slug: string,
  body: GuestRegisterBody,
  idempotencyKey: string,
): Promise<GuestRegisterResponse> {
  return post<GuestRegisterResponse>(`${paths.tournament(slug)}/guest-register`, {
    body,
    idempotencyKey,
  });
}

export interface EntrantListQuery extends PageQuery {
  /** Default `confirmed,checked_in`. */
  status?: EntrantStatus[];
}

/** §1.6 — public and redacted. `entrants_public = 0` answers 200 with `[]` and `meta.hidden`. */
export async function listTournamentEntrants(
  slug: string,
  query: EntrantListQuery = {},
): Promise<{ entrants: PublicEntrant[]; page: PagedResult<PublicEntrant>['page']; meta: EntrantsMeta | null }> {
  const result = await getPaged<PublicEntrant>(paths.tournamentEntrants(slug), {
    query: query as QueryParams,
  });
  return { entrants: result.data, page: result.page, meta: (result.meta as EntrantsMeta | null) ?? null };
}

/** §1.7 — the hot endpoint. No bracket yet is a 200 with `rounds: []`, never a 404. */
export function getBracket(slug: string): Promise<BracketResponse> {
  return get<BracketResponse>(paths.tournamentBracket(slug));
}

export interface MatchListQuery extends PageQuery {
  /** A `stg_` id or a stage ordinal. Defaults to the live stage. */
  stage?: string | number;
  round?: number;
  state?: string[];
  entrant?: EntrantId;
  group?: string;
  from?: Rfc3339;
  to?: Rfc3339;
  sort?: 'scheduled_asc' | 'round_asc';
}

/** §1.8 — the flat fixtures list, with entrants inlined into slots. */
export function listMatches(
  slug: string,
  query: MatchListQuery = {},
): Promise<PagedResult<MatchWithEntrants>> {
  return getPaged<MatchWithEntrants>(paths.tournamentMatches(slug), {
    query: query as QueryParams,
  });
}

/** §1.9 — one stage at a time; `standings` is keyed `(stage_id, entrant_id)` for exactly that reason. */
export function getStandings(
  slug: string,
  query: { stage?: string | number } = {},
): Promise<StandingsResponse> {
  return get<StandingsResponse>(paths.tournamentStandings(slug), { query: query as QueryParams });
}

/** §1.10 */
export function listTournamentAnnouncements(
  slug: string,
  query: PageQuery = {},
): Promise<PagedResult<Announcement>> {
  return getPaged<Announcement>(paths.tournamentAnnouncements(slug), {
    query: query as QueryParams,
  });
}

/**
 * §1.5.1 — THE call the tournament page makes on boot: header, first page of
 * entrants, bracket, standings and pinned announcements in one round-trip. Its
 * `Poll-After` is deliberately `0`; after boot the client polls the individual
 * endpoints, which have tighter ETags and much smaller 304s.
 */
export function getTournamentOverview(slug: string): Promise<TournamentOverview> {
  return get<TournamentOverview>(paths.tournamentOverview(slug));
}

/** §1.5 — full public detail. `410 gone` for a cancelled tournament, `404` for a draft. */
export function getTournament(slug: string): Promise<TournamentDetail> {
  return get<TournamentDetail>(paths.tournament(slug));
}

/* =====================================================================
 * §2 Auth API
 *
 * The ceremony endpoints do not require `X-CSRF-Token` — a caller with no
 * session has none. They are protected by the Origin allowlist, the JSON
 * content-type requirement, and the fact that a forged cross-site call cannot
 * read the response (SECURITY.md §5.3).
 * ===================================================================== */

export interface AuthConfig {
  passkey: boolean;
  email_otp: boolean;
  recovery: boolean;
  signup_open: boolean;
  rp_id: string;
  bootstrap_available: boolean;
}

export function getAuthConfig(): Promise<AuthConfig> {
  return get<AuthConfig>('/auth/config');
}

/**
 * §2.1 — called once on boot and again after any sign-in. Anonymous is a
 * **200 with `authenticated: false`**, not a 401.
 *
 * `noAuthRecovery` is set because this endpoint is what the recovery ladder
 * calls: letting it recurse into `refreshSession()` would be an infinite loop
 * on a network blip.
 */
export function getAuthSession(): Promise<AuthSession> {
  return get<AuthSession>(paths.authSession(), { noAuthRecovery: true });
}

export function getBootstrapStatus(): Promise<{ available: boolean }> {
  return get<{ available: boolean }>('/auth/bootstrap/status');
}

export interface RecoveryStatus {
  remaining: number;
  generated_at: Rfc3339 | null;
  batch_id: string | null;
}

export function getRecoveryStatus(): Promise<RecoveryStatus> {
  return get<RecoveryStatus>('/auth/recovery/status');
}

export interface PasskeyRegisterOptionsBody {
  /** Required for signup. `^[a-z0-9][a-z0-9_]{2,19}$`. */
  handle?: string;
  /** Required for signup. 2..60 chars. */
  display_name?: string;
  /** AUTH.md §6. Ignored when `ADMIN_BOOTSTRAP_TOKEN` is unset. */
  bootstrap_token?: string | null;
}

/**
 * `T` is `PublicKeyCredentialCreationOptionsJSON` at the call site. It is
 * generic so this module does not import `@simplewebauthn/browser`.
 */
export function passkeyRegisterOptions<T = JsonObject>(
  body: PasskeyRegisterOptionsBody = {},
): Promise<{ options: T }> {
  return post<{ options: T }>('/auth/passkey/register/options', { body, noAuthRecovery: true });
}

/** Body is `{ response: RegistrationResponseJSON }` and nothing else — everything else lives on the challenge row. */
export function passkeyRegisterVerify<TResponse = JsonObject>(
  response: TResponse,
): Promise<AuthSession & { recovery_codes?: string[] }> {
  return post<AuthSession & { recovery_codes?: string[] }>('/auth/passkey/register/verify', {
    body: { response },
    noAuthRecovery: true,
  });
}

export interface PasskeyLoginOptionsBody {
  /** Omitted is the intended path: fully discoverable credentials. */
  handle?: string | null;
  /** `conditional` → the client passes `useBrowserAutofill: true`. */
  mediation?: 'conditional' | 'optional';
}

export function passkeyLoginOptions<T = JsonObject>(
  body: PasskeyLoginOptionsBody = {},
): Promise<{ options: T }> {
  return post<{ options: T }>('/auth/passkey/login/options', { body, noAuthRecovery: true });
}

export function passkeyLoginVerify<TResponse = JsonObject>(
  response: TResponse,
): Promise<AuthSession> {
  return post<AuthSession>('/auth/passkey/login/verify', {
    body: { response },
    noAuthRecovery: true,
  });
}

/** §4.3 — handle AND code, both required: an attacker must target one account, not spray. */
export function recoveryLogin(handle: string, code: string): Promise<AuthSession> {
  return post<AuthSession>('/auth/recovery/login', {
    body: { handle, code },
    noAuthRecovery: true,
  });
}

export interface RecoveryCodesResponse {
  /** The ten plaintext codes, returned once and never again. */
  codes: string[];
  batch_id: string;
  generated_at: Rfc3339;
}

/** §4.5 — session + step-up + UV. Idempotency required. Show the codes on a full screen. */
export function regenerateRecoveryCodes(idempotencyKey: string): Promise<RecoveryCodesResponse> {
  return post<RecoveryCodesResponse>('/auth/recovery/codes', { body: {}, idempotencyKey });
}

/** §9.3 — always `202` with the same body whether or not the address is known. */
export function emailStart(email: string): Promise<{ sent: boolean }> {
  return post<{ sent: boolean }>('/auth/email/start', { body: { email }, noAuthRecovery: true });
}

/** Mints a session with `uv = 0`: an email session can browse and register, and nothing else. */
export function emailVerify(email: string, code: string): Promise<AuthSession> {
  return post<AuthSession>('/auth/email/verify', { body: { email, code }, noAuthRecovery: true });
}

/** `204`. Revokes the current session and clears the cookie. */
export function logout(): Promise<void> {
  return post<void>('/auth/logout', { body: {} });
}

/* =====================================================================
 * §3 Player API — session required, `private, no-store`
 * ===================================================================== */

export function getMe(): Promise<MeProfile> {
  return get<MeProfile>(paths.me());
}

export interface UpdateMeBody {
  display_name?: string;
  /** Changeable at most once per 30 days; the old handle is reserved for 90. */
  handle?: string;
  bio?: string;
  city?: string;
  /** E.164. `""` clears it. */
  phone_e164?: string;
  profile_public?: boolean;
  notify_whatsapp?: boolean;
}

export function updateMe(body: UpdateMeBody): Promise<MeProfile> {
  return patch<MeProfile>(paths.me(), { body });
}

/** §3.11 DPDP. Starts the deletion window; `undeleteMe` cancels it. */
export function deleteMe(body: { reason?: string } = {}): Promise<void> {
  return del<void>(paths.me(), { body });
}

export function undeleteMe(): Promise<MeProfile> {
  return post<MeProfile>('/me/undelete', { body: {} });
}

/** §3.11 — the DPDP data export. Rate limited to 1/hour. */
export function exportMe(): Promise<JsonObject> {
  return get<JsonObject>('/me/export');
}

export interface MyRegistrationsQuery extends PageQuery {
  status?: EntrantStatus[];
  when?: 'upcoming' | 'past' | 'all';
}

/**
 * §3.9 — and §3.9.1: `next_match.room_code` / `room_password` reach a squad
 * **here and only here**. They must never appear on a `/tournaments/:slug/*`
 * route, because a public response that varies by identity is exactly what
 * §1's cacheability invariant forbids.
 */
export function listMyRegistrations(
  query: MyRegistrationsQuery = {},
): Promise<PagedResult<MyRegistration>> {
  return getPaged<MyRegistration>(paths.myRegistrations(), { query: query as QueryParams });
}

/** §3.9 — attach a guest entry to the account that just signed up. Matched before the `:id` route. */
export function claimGuestRegistration(guestToken: string): Promise<PrivateEntrant> {
  return post<PrivateEntrant>('/me/registrations/claim', { body: { guest_token: guestToken } });
}

/** §3.9 — the escape hatch from being listed on someone else's roster. `204`. */
export function leaveRegistration(entrantId: EntrantId): Promise<void> {
  return post<void>(`/me/registrations/${encodeURIComponent(entrantId)}/leave`, { body: {} });
}

export interface CredentialSummary {
  id: string;
  label: string | null;
  created_at: Rfc3339;
  last_used_at: Rfc3339 | null;
  backed_up: boolean;
  device_type: string;
  aaguid_name: string | null;
}

export function listCredentials(): Promise<PagedResult<CredentialSummary>> {
  return getPaged<CredentialSummary>('/me/credentials');
}

/** Add another passkey to this account. Session + UV. */
export function addCredentialOptions<T = JsonObject>(): Promise<{ options: T }> {
  return post<{ options: T }>('/me/credentials/options', { body: {} });
}

export function addCredentialVerify<TResponse = JsonObject>(
  response: TResponse,
  label?: string,
): Promise<CredentialSummary> {
  return post<CredentialSummary>('/me/credentials/verify', { body: { response, label } });
}

export function renameCredential(id: string, label: string): Promise<CredentialSummary> {
  return patch<CredentialSummary>(`/me/credentials/${encodeURIComponent(id)}`, { body: { label } });
}

/**
 * Step-up. `409 conflict` / `details.reason: "last_credential"` when it is the
 * only one and no unused recovery codes remain — never let a user lock
 * themselves out.
 */
export function deleteCredential(id: string): Promise<void> {
  return del<void>(`/me/credentials/${encodeURIComponent(id)}`);
}

export interface SessionSummary {
  id: SessionId;
  current: boolean;
  created_at: Rfc3339;
  last_seen_at: Rfc3339 | null;
  /** From `request.cf.city`. The raw IP is never stored or returned. */
  ip_city: string | null;
  ua_summary: string | null;
  uv: boolean;
}

export function listSessions(): Promise<PagedResult<SessionSummary>> {
  return getPaged<SessionSummary>('/me/sessions');
}

/** Revoke **all others**, keeping the current one. Matched before the `:id` route. Step-up. `204`. */
export function revokeOtherSessions(): Promise<void> {
  return del<void>('/me/sessions');
}

export function revokeSession(id: SessionId): Promise<void> {
  return del<void>(`/me/sessions/${encodeURIComponent(id)}`);
}

/* ---- §3.5 Guest self-service (X-Guest-Token; no session, no CSRF) ---- */

export interface GuestEntrantResponse extends PrivateEntrant {
  next_match: (Match & { room_password: string | null }) | null;
}

export function getGuestEntrant(guestToken?: string): Promise<GuestEntrantResponse> {
  return get<GuestEntrantResponse>('/guest/entrant', { guestToken });
}

export interface UpdateEntrantBody {
  team_name?: string;
  team_tag?: string;
  /** A **full replacement** of the roster, never a patch (§3.6.1). */
  members?: RegisterMemberInput[];
  fields?: FieldValues;
  notes?: string;
  phone_e164?: string;
}

/** `PATCH /guest/entrant` additionally requires `version` (§6.2). */
export interface UpdateGuestEntrantBody extends UpdateEntrantBody {
  version: number;
}

export function updateGuestEntrant(
  body: UpdateGuestEntrantBody,
  guestToken?: string,
): Promise<PrivateEntrant> {
  return patch<PrivateEntrant>('/guest/entrant', { body, guestToken });
}

export function guestCheckIn(
  body: { checkin_code?: string } = {},
  guestToken?: string,
): Promise<PrivateEntrant> {
  return post<PrivateEntrant>('/guest/entrant/checkin', { body, guestToken });
}

export function guestWithdraw(
  body: { reason?: string } = {},
  guestToken?: string,
): Promise<PrivateEntrant> {
  return post<PrivateEntrant>('/guest/entrant/withdraw', { body, guestToken });
}

/* ---- §3.6 Entrants ---- */

/** §3.6 — predicate is `MINE ∨ ROSTERED ∨ ORG_OF`, and a failure is `404`, not `403`. */
export function getEntrant(id: EntrantId): Promise<PrivateEntrant> {
  return get<PrivateEntrant>(`/entrants/${encodeURIComponent(id)}`);
}

/** §3.6.1 — captain or owner only. `409 entrant_locked` once the bracket exists. */
export function updateEntrant(id: EntrantId, body: UpdateEntrantBody): Promise<PrivateEntrant> {
  return patch<PrivateEntrant>(`/entrants/${encodeURIComponent(id)}`, { body });
}

/** §3.7 — idempotent: checking in twice is a 200, not a 409. */
export function checkInEntrant(
  id: EntrantId,
  body: { checkin_code?: string } = {},
): Promise<PrivateEntrant> {
  return post<PrivateEntrant>(`/entrants/${encodeURIComponent(id)}/checkin`, { body });
}

/** §3.8 — promotes the first waitlisted entrant in the same batch. */
export function withdrawEntrant(
  id: EntrantId,
  body: { reason?: string } = {},
): Promise<PrivateEntrant> {
  return post<PrivateEntrant>(`/entrants/${encodeURIComponent(id)}/withdraw`, { body });
}

export interface RosterInvitesResponse {
  /** Plaintext, returned once, unrecoverable afterwards. */
  codes: string[];
  urls: string[];
  expires_at: Rfc3339 | null;
}

/** §3.12.1 — captain-minted roster invites. `MINE(e)` only; a rostered member cannot mint. */
export function createRosterInvites(
  id: EntrantId,
  body: { count: number; expires_at?: Rfc3339 },
): Promise<RosterInvitesResponse> {
  return post<RosterInvitesResponse>(`/entrants/${encodeURIComponent(id)}/roster-invites`, { body });
}

/* =====================================================================
 * §4 Organizer API — `:id` is a `trn_` id, except §4.2b which also takes a slug
 * ===================================================================== */

const org = (suffix: string): string => `/organizer${suffix}`;
const orgTournament = (id: string): string => org(`/tournaments/${encodeURIComponent(id)}`);

export interface OrganizerTournamentQuery extends PageQuery {
  status?: TournamentStatus[];
  q?: string;
}

/** §4.1 */
export function listOrganizerTournaments(
  query: OrganizerTournamentQuery = {},
): Promise<PagedResult<TournamentCard>> {
  return getPaged<TournamentCard>(org('/tournaments'), { query: query as QueryParams });
}

export interface StageInput {
  ordinal: number;
  name: string;
  format: StageFormat;
  seed_source?: 'registration' | 'random' | 'manual' | 'previous_stage';
  /** Everywhere except a create body, where `source_stage_ordinal` is used instead. */
  source_stage_id?: StageId | null;
  /** Create-body only: no stage id exists yet, so an earlier stage is named by ordinal. */
  source_stage_ordinal?: number;
  advance_count?: number | null;
  group_count?: number;
  lobby_count?: number;
  lobby_size?: number;
  rounds_planned?: number | null;
  best_of?: number;
  final_best_of?: number | null;
  third_place_match?: boolean;
  points_win?: number;
  points_draw?: number;
  points_loss?: number;
  points_bye?: number;
  /** Must equal `options.pointsDivisor`. Chess is 2/1/0 with divisor 2 — no REALs. */
  points_divisor?: number;
  tiebreakers?: string[];
  options?: JsonObject;
  scoring_config?: JsonObject | null;
}

export interface TournamentPrizeInput {
  position: number;
  label: string;
  amount_paise: Paise;
  extra?: string | null;
}

export interface CreateTournamentBody {
  title: string;
  /** Derived from `title` when absent. Explicitly supplied and colliding is `409 slug_taken`. */
  slug?: string;
  game_slug: string;
  /** `null`/absent resolves to the `seasons` row with `is_active = 1` (§4.2.0). */
  season_slug?: string | null;
  format: TournamentFormat;
  participant_type: ParticipantType;
  summary?: string;
  /** Markdown source ≤ 20000 chars; the server compiles it to `rules_ast` (§9). */
  rules_md?: string;
  starts_at: Rfc3339;
  ends_at?: Rfc3339 | null;
  registration_opens_at?: Rfc3339 | null;
  registration_closes_at?: Rfc3339 | null;
  checkin_opens_at?: Rfc3339 | null;
  checkin_closes_at?: Rfc3339 | null;
  requires_checkin?: boolean;
  checkin_requires_code?: boolean;
  venue_id?: VenueId | null;
  venue_mode?: VenueMode;
  entry_fee_paise?: Paise;
  prize_pool_paise?: Paise;
  prizes?: TournamentPrizeInput[];
  max_entrants?: number | null;
  waitlist_enabled?: boolean;
  requires_confirmation?: boolean;
  requires_phone?: boolean;
  min_account_age_hours?: number;
  allow_guest_registration?: boolean;
  requires_join_code?: boolean;
  entrants_public?: boolean;
  publish_room_codes?: boolean;
  require_dual_confirm_final?: boolean;
  team_size_min?: number;
  team_size_max?: number;
  substitutes_max?: number;
  format_config?: JsonObject;
  scoring_config?: JsonObject;
  /** `null` inherits the game's. */
  registration_schema?: JsonObject[] | null;
  contact?: { whatsapp_group_url?: string | null; public_phone?: string | null };
  leaderboard_weight_pct?: number;
  /** Top-level, NOT `format_config.stages`. Absent = one implicit stage from `format`. */
  stages?: StageInput[];
}

/** §4.2 — Idempotency required. `201` with `status: "draft"`. */
export function createTournament(
  body: CreateTournamentBody,
  idempotencyKey: string,
): Promise<TournamentDetail> {
  return post<TournamentDetail>(org('/tournaments'), { body, idempotencyKey });
}

/** The organizer view carries `checkin_code`, which no other endpoint returns (§4.2b). */
export interface OrganizerTournament extends TournamentDetail {
  checkin_code: string | null;
  version: number;
}

/** §4.2b — the one organizer route whose `:id` may also be a slug. */
export function getOrganizerTournament(idOrSlug: string): Promise<OrganizerTournament> {
  return get<OrganizerTournament>(orgTournament(idOrSlug));
}

export interface UpdateTournamentBody extends Partial<CreateTournamentBody> {
  /** §6.2. Named after the column, so there is no translation layer to get wrong. */
  version: number;
}

/** §4.3 — field mutability by status is enforced server-side, not just in the UI. */
export function updateTournament(
  id: TournamentId,
  body: UpdateTournamentBody,
): Promise<OrganizerTournament> {
  return patch<OrganizerTournament>(orgTournament(id), { body });
}

/** §4.5 — draft with zero entrants only; everything else is archived, never deleted. `204`. */
export function deleteTournament(id: TournamentId, version: number): Promise<void> {
  return del<void>(orgTournament(id), { body: { version } });
}

export interface StatusChangeBody {
  to: TournamentStatus;
  version: number;
  /** Required for `cancelled`. */
  reason?: string;
}

/** §4.4 — everything not on the legal-transition graph is `409 invalid_state_transition`. */
export function changeTournamentStatus(
  id: TournamentId,
  body: StatusChangeBody,
): Promise<OrganizerTournament> {
  return post<OrganizerTournament>(`${orgTournament(id)}/status`, { body });
}

export interface OrganizerEntrantQuery extends PageQuery {
  status?: EntrantStatus[];
  /** Team name, member display name, handle, or in-game ID. */
  q?: string;
  checked_in?: boolean;
  payment?: PaymentStatus;
  sort?: 'seed_asc' | 'registered_asc' | 'name_asc';
}

export interface OrganizerEntrantCounts extends JsonObject {
  total: number;
  pending: number;
  confirmed: number;
  waitlisted: number;
  checked_in: number;
  withdrawn: number;
  disqualified: number;
}

/**
 * §4.6 — unredacted apart from phones: every `pii: true` `tel` value is masked,
 * because the presets ship four of them on the default form of every team game
 * and this endpoint is paginated and un-audited. The full number is §4.10 only.
 */
export async function listOrganizerEntrants(
  id: TournamentId,
  query: OrganizerEntrantQuery = {},
): Promise<{
  entrants: PrivateEntrant[];
  page: PagedResult<PrivateEntrant>['page'];
  counts: OrganizerEntrantCounts | null;
}> {
  const result = await getPaged<PrivateEntrant>(`${orgTournament(id)}/entrants`, {
    query: query as QueryParams,
  });
  const meta = result.meta as { counts?: OrganizerEntrantCounts } | null;
  return { entrants: result.data, page: result.page, counts: meta?.counts ?? null };
}

export interface AddWalkInBody extends Omit<GuestRegisterBody, 'turnstile_token' | 'join_code'> {
  /** Link an existing account instead of creating a guest. */
  user_handle?: string;
  /** Default `confirmed` — an organizer typing it in *is* the confirmation. */
  status?: EntrantStatus;
  payment_status?: PaymentStatus;
  /** Audited. Required to exceed `max_entrants`. */
  override_capacity?: boolean;
}

/** §4.7 — the walk-in desk. Idempotency required. */
export function addWalkInEntrant(
  id: TournamentId,
  body: AddWalkInBody,
  idempotencyKey: string,
): Promise<PrivateEntrant> {
  return post<PrivateEntrant>(`${orgTournament(id)}/entrants`, { body, idempotencyKey });
}

export interface EntrantsCsvQuery {
  /** Adds one `phone_e164` column, requires `FULLORG_OF`, and writes an audit row. */
  include_contact?: boolean;
  status?: EntrantStatus[];
}

/**
 * §4.19 — the only endpoint in this file that is not JSON. Returned as the path
 * rather than fetched, because a CSV download is an `<a download>` or a
 * `window.location`, not an XHR whose body would sit in memory on a phone.
 */
export function entrantsCsvPath(id: TournamentId, query: EntrantsCsvQuery = {}): string {
  const search = new URLSearchParams();
  if (query.include_contact === true) search.set('include_contact', 'true');
  if (query.status !== undefined && query.status.length > 0) {
    search.set('status', query.status.join(','));
  }
  const qs = search.toString();
  return `/api/v1${orgTournament(id)}/entrants.csv${qs === '' ? '' : `?${qs}`}`;
}

export interface ReseedBody {
  version: number;
  /** `rating` is `400 validation_failed` in v1: `entrants.rating` is NULL for every row. */
  method: 'random' | 'registration_order' | 'manual';
  /** `random` requires one, or the server generates and returns it, so a draw is auditable. */
  seed_value?: number;
  seeds?: { entrant_id: EntrantId; seed: number }[];
  /** Required once a bracket exists; also requires zero completed matches. */
  force?: boolean;
}

/** §4.11 */
export function reseedEntrants(
  id: TournamentId,
  body: ReseedBody,
): Promise<{ seeded: number; method: string; seed_value: number | null }> {
  return post<{ seeded: number; method: string; seed_value: number | null }>(
    `${orgTournament(id)}/entrants/reseed`,
    { body, maxBodyBytes: 256 * 1024 },
  );
}

/** §4.22 — §1.7 plus room codes, referee notes, `pending_confirm_by` and unpublished matches. */
export function getOrganizerBracket(
  id: TournamentId,
  query: { stage_id?: StageId } = {},
): Promise<BracketResponse> {
  return get<BracketResponse>(`${orgTournament(id)}/bracket`, { query: query as QueryParams });
}

export interface GenerateBracketBody {
  version: number;
  /** Defaults to the lowest-ordinal stage with `bracket_generated_at IS NULL`. */
  stage_id?: StageId | null;
  /** Requires zero completed matches. */
  force?: boolean;
  options?: JsonObject;
  /** Stage 1 only; ignored for stage 2+, which uses the `stage_entrants` rows. */
  include_statuses?: EntrantStatus[];
}

/**
 * §4.14.2 — the dry run. Costs real CPU (`previewBracket` over up to 256
 * entrants) and is rate-limited under `rl_engine`; matched **before** the
 * generate route because they share a prefix.
 */
export function previewBracket(
  id: TournamentId,
  body: Omit<GenerateBracketBody, 'version'> & { version?: number },
): Promise<BracketResponse> {
  return post<BracketResponse>(`${orgTournament(id)}/bracket/preview`, { body });
}

/** §4.12 — Idempotency required. `201` with the §1.7 body from the organizer's view. */
export function generateBracket(
  id: TournamentId,
  body: GenerateBracketBody,
  idempotencyKey: string,
): Promise<BracketResponse> {
  return post<BracketResponse>(`${orgTournament(id)}/bracket`, { body, idempotencyKey });
}

/** §4.12b — clears a bracket so it can be regenerated. `204`, and idempotent. */
export function deleteBracket(
  id: TournamentId,
  body: { version: number },
  query: { stage_id?: StageId } = {},
): Promise<void> {
  return del<void>(`${orgTournament(id)}/bracket`, { body, query: query as QueryParams });
}

export interface Stage {
  id: StageId;
  ordinal: number;
  name: string;
  format: StageFormat;
  status: string;
  group_count: number;
  lobby_count: number;
  lobby_size: number | null;
  rounds_planned: number | null;
  rounds_completed: number;
  best_of: number;
  final_best_of: number | null;
  third_place_match: boolean;
  seed_source: string;
  source_stage_id: StageId | null;
  advance_count: number | null;
  points_win: number;
  points_draw: number;
  points_loss: number;
  points_bye: number;
  points_divisor: number;
  tiebreakers: string[];
  options: JsonObject;
  scoring_config: JsonObject | null;
  entrant_count: number;
  bracket_generated_at: Rfc3339 | null;
  /** `bracket_generated_at IS NOT NULL`. */
  locked: boolean;
  starts_at: Rfc3339 | null;
  completed_at: Rfc3339 | null;
}

/** §4.23.1 — ordered by `ordinal`. Every tournament has at least one. */
export function listStages(id: TournamentId): Promise<PagedResult<Stage>> {
  return getPaged<Stage>(`${orgTournament(id)}/stages`);
}

/** §4.23.2 — `ordinal` must be `max(existing) + 1`; inserting in the middle is `409`. */
export function createStage(id: TournamentId, body: StageInput): Promise<Stage> {
  return post<Stage>(`${orgTournament(id)}/stages`, { body });
}

/**
 * §4.23.3. Note the route shape: `/organizer/stages/:id`, not nested under the
 * tournament — and the four-segment `seed` and `rounds` siblings below must be
 * matched before it (Appendix C's second ordering hazard).
 */
export function updateStage(
  stageId: StageId,
  body: Partial<StageInput> & { version: number },
): Promise<Stage> {
  return patch<Stage>(org(`/stages/${encodeURIComponent(stageId)}`), { body });
}

export function deleteStage(stageId: StageId, version: number): Promise<void> {
  return del<void>(org(`/stages/${encodeURIComponent(stageId)}`), { body: { version } });
}

export interface SeededEntrant {
  entrant_id: EntrantId;
  display_name: string;
  seed: number;
  source_rank: number;
  source_group_no: number;
}

/**
 * §4.23.4 — seeds stage N+1 from stage N's standings. Seeding and generation
 * are two calls on purpose: the organiser gets to look at the qualifier list,
 * and fix a group-stage score they only now notice is wrong, before the draw is
 * fixed and shared.
 */
export function seedStage(
  stageId: StageId,
  body: { version: number; force?: boolean },
): Promise<{ stage: Stage; seeded: SeededEntrant[] }> {
  return post<{ stage: Stage; seeded: SeededEntrant[] }>(
    org(`/stages/${encodeURIComponent(stageId)}/seed`),
    { body },
  );
}

export interface CarryOverResult {
  entrants: [EntrantId, EntrantId];
  score_a: number;
  score_b: number;
  winner_entrant_id: EntrantId | null;
}

export interface CreateRoundBody {
  version: number;
  round: number;
  force?: boolean;
  /** Re-attached from a prior `deleteStageRound`; re-validated server-side, so tampering is inert. */
  carry_over?: CarryOverResult[];
}

/**
 * §4.23.5 — **the endpoint that makes round 2 of a Swiss or a BGMI event
 * exist.** `swiss` and `points_lobby` are progressive: round k's pairings are a
 * pure function of rounds 1..k−1's results and cannot be emitted at generation
 * time. Idempotency required.
 */
export function createStageRound(
  stageId: StageId,
  body: CreateRoundBody,
  idempotencyKey: string,
): Promise<{ round: { index: number; name: string; stage_id: StageId; matches: Match[] } }> {
  return post<{ round: { index: number; name: string; stage_id: StageId; matches: Match[] } }>(
    org(`/stages/${encodeURIComponent(stageId)}/rounds`),
    { body, idempotencyKey },
  );
}

/**
 * §4.23.6 — deletes round `round` **and every round after it**; re-pairing round
 * 3 while round 4 exists would leave round 4 built on pairings that no longer
 * exist. `meta.carry_over` comes back and is passed to the next `createStageRound`.
 */
export function deleteStageRound(
  stageId: StageId,
  round: number,
  body: { version: number; reason: string },
): Promise<{ deleted_rounds: number[]; deleted_matches: number }> {
  return del<{ deleted_rounds: number[]; deleted_matches: number }>(
    org(`/stages/${encodeURIComponent(stageId)}/rounds/${round}`),
    { body },
  );
}

export interface LobbyResultEntry {
  entrant_id: EntrantId;
  placement: number;
  kills: number;
  /** −100..100. A non-zero bonus requires a `note`. */
  bonus?: number;
  disqualified?: boolean;
  note?: string | null;
}

export interface LobbyResultsBody {
  result_version: number;
  state: 'live' | 'complete';
  /** `true` when some squads have not finished yet; otherwise `placement` must be a permutation of 1..n. */
  allow_partial?: boolean;
  entries: LobbyResultEntry[];
}

/**
 * §4.15.1 — bulk result entry for a `points_lobby` match (one BGMI lobby, up to
 * 25 squads). Idempotency required; body cap 256 KiB.
 *
 * **Points are computed entirely server-side.** The client never submits a
 * total, so a tampered total is not a representable request (SECURITY.md §2.2).
 */
export function submitLobbyResults(
  matchId: MatchId,
  body: LobbyResultsBody,
  idempotencyKey: string,
): Promise<{ match: Match; standings: StandingsResponse }> {
  return post<{ match: Match; standings: StandingsResponse }>(
    org(`/matches/${encodeURIComponent(matchId)}/lobby-results`),
    { body, idempotencyKey, maxBodyBytes: 256 * 1024 },
  );
}

/** §4.16 — freeze the results and push points to the leaderboard. Idempotency required. */
export function publishTournament(
  id: TournamentId,
  body: { version: number; force?: boolean },
  idempotencyKey: string,
): Promise<OrganizerTournament> {
  return post<OrganizerTournament>(`${orgTournament(id)}/publish`, { body, idempotencyKey });
}

export function unpublishTournament(
  id: TournamentId,
  body: { version: number; reason?: string },
): Promise<OrganizerTournament> {
  return post<OrganizerTournament>(`${orgTournament(id)}/unpublish`, { body });
}

export interface AnnouncementBody {
  /** ≤ 100 chars. */
  title: string;
  /** ≤ 4000 chars of markdown; compiled to `body_ast` server-side (§9). */
  body_md: string;
  severity?: AnnouncementSeverity;
  pinned?: boolean;
  promote_to_club?: boolean;
}

/** §4.17 — posting bumps `state_version`, so a bracket poller gets a 200. Accepted over-invalidation. */
export function createTournamentAnnouncement(
  id: TournamentId,
  body: AnnouncementBody,
): Promise<Announcement> {
  return post<Announcement>(`${orgTournament(id)}/announcements`, { body });
}

export interface InvitesBody {
  /** ≤ 200. */
  count: number;
  mode: 'single_use' | 'shared';
  max_uses?: number;
  expires_at?: Rfc3339 | null;
  label?: string;
}

export interface InvitesResponse {
  /** Stored hashed; unrecoverable after this response. A lost code is regenerated. */
  codes: string[];
  expires_at: Rfc3339 | null;
  mode: 'single_use' | 'shared';
}

/** §4.18 — `kind = 'join'` invites, gating guest registration for this tournament. Idempotency required. */
export function createJoinInvites(
  id: TournamentId,
  body: InvitesBody,
  idempotencyKey: string,
): Promise<InvitesResponse> {
  return post<InvitesResponse>(`${orgTournament(id)}/invites`, { body, idempotencyKey });
}

export interface InviteSummary {
  id: string;
  label: string | null;
  mode: 'single_use' | 'shared';
  used_count: number;
  max_uses: number;
  expires_at: Rfc3339 | null;
  revoked: boolean;
}

/** Metadata only — never the codes. */
export function listJoinInvites(id: TournamentId): Promise<PagedResult<InviteSummary>> {
  return getPaged<InviteSummary>(`${orgTournament(id)}/invites`);
}

export interface OrganizerRef {
  handle: string;
  display_name: string;
  role: 'owner' | 'organizer' | 'scorer' | 'moderator';
  is_owner: boolean;
  added_at: Rfc3339;
  added_by: string | null;
}

/** §4.20 — revoked rows are omitted. */
export function listCoOrganizers(id: TournamentId): Promise<PagedResult<OrganizerRef>> {
  return getPaged<OrganizerRef>(`${orgTournament(id)}/organizers`);
}

/**
 * Grants **scope**, never **role**: the target must already have
 * `users.role IN ('organizer','admin')`. Role grants are admin-only (§5.3), and
 * separating the two is what stops an organizer inviting themselves upward.
 */
export function addCoOrganizer(
  id: TournamentId,
  body: { handle: string; role: 'organizer' | 'scorer' | 'moderator' },
): Promise<OrganizerRef> {
  return post<OrganizerRef>(`${orgTournament(id)}/organizers`, { body });
}

/** Soft revoke (`revoked_at = now`). Authority is lost immediately: the predicates read the row. `204`. */
export function removeCoOrganizer(id: TournamentId, handle: string): Promise<void> {
  return del<void>(`${orgTournament(id)}/organizers/${encodeURIComponent(handle)}`);
}

export interface AuditEntry {
  id: string;
  at: Rfc3339;
  actor: { handle: string; display_name: string; role: UserRole } | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  summary: string;
  /** PII-redacted for non-admins: a phone number appears as `"[redacted]"`. */
  before: JsonObject | null;
  after: JsonObject | null;
  request_id: string | null;
}

export interface AuditQuery extends PageQuery {
  action?: string;
  actor?: string;
  from?: Rfc3339;
  to?: Rfc3339;
}

/** §4.21 — so an organizer can answer "who changed that score" without an admin. */
export function listTournamentAudit(
  id: TournamentId,
  query: AuditQuery = {},
): Promise<PagedResult<AuditEntry>> {
  return getPaged<AuditEntry>(`${orgTournament(id)}/audit`, { query: query as QueryParams });
}

export interface OrganizerEntrantPatch extends UpdateEntrantBody {
  version: number;
  status?: EntrantStatus;
  seed?: number | null;
  payment_status?: PaymentStatus;
  payment_ref?: string | null;
  organizer_note?: string | null;
}

/** §4.8 — the organizer's entrant control surface. */
export function updateOrganizerEntrant(
  entrantId: EntrantId,
  body: OrganizerEntrantPatch,
): Promise<PrivateEntrant> {
  return patch<PrivateEntrant>(org(`/entrants/${encodeURIComponent(entrantId)}`), { body });
}

/** §4.8b — the "someone typed the same walk-in twice" button, not the withdrawal button. `204`. */
export function deleteOrganizerEntrant(entrantId: EntrantId): Promise<void> {
  return del<void>(org(`/entrants/${encodeURIComponent(entrantId)}`));
}

/** §4.9 — re-issue a lost guest capability token. Invalidates the old one. Audited. */
export function reissueGuestToken(
  entrantId: EntrantId,
): Promise<{ guest_token: string; url: string }> {
  return post<{ guest_token: string; url: string }>(
    org(`/entrants/${encodeURIComponent(entrantId)}/guest-token`),
    { body: {} },
  );
}

/**
 * §4.10 — **the only endpoint that returns a full phone number**, which is why
 * the entrant list does not. Every call writes an audit row and it is rate
 * limited to 60/hour per organizer.
 */
export function getEntrantContact(
  entrantId: EntrantId,
): Promise<{ phone_e164: string | null; whatsapp_url: string | null; email: string | null }> {
  return get<{ phone_e164: string | null; whatsapp_url: string | null; email: string | null }>(
    org(`/entrants/${encodeURIComponent(entrantId)}/contact`),
  );
}

export interface MatchLogisticsBody {
  version: number;
  scheduled_at?: Rfc3339 | null;
  venue_id?: VenueId | null;
  room_code?: string | null;
  room_password?: string | null;
  room_code_publish_at?: Rfc3339 | null;
  /** `https:` and in the host allowlist; an arbitrary URL here is a phishing vector. */
  stream_url?: string | null;
  station_label?: string | null;
  referee_note?: string | null;
}

/** §4.15 — scheduling and logistics only, never scores. */
export function updateMatchLogistics(matchId: MatchId, body: MatchLogisticsBody): Promise<Match> {
  return patch<Match>(org(`/matches/${encodeURIComponent(matchId)}`), { body });
}

export interface ScoreEntry {
  entrant_id: EntrantId;
  /** Integer 0..9999. There are no fractional scores anywhere in the product. */
  score: number;
  /** Integer −100..100. A non-zero bonus requires a `note`. */
  bonus?: number;
}

export interface SubmitScoreBody {
  /** §6.2 — the match's own counter, not `version`. */
  result_version: number;
  method: MatchMethod;
  is_draw?: boolean;
  scores: ScoreEntry[];
  /** Required unless `is_draw`, or `method` is `no_contest`. The server recomputes and rejects a contradiction. */
  winner_entrant_id?: EntrantId | null;
  detail?: JsonObject;
  state: 'live' | 'complete';
  /** ≤ 300 chars; lands in `match_audit.reason`. */
  note?: string;
}

export interface SubmitScoreResponse {
  match: Match;
  /** `202` path: `require_dual_confirm_final` is on and a different organizer must confirm. */
  awaiting_confirmation?: boolean;
}

/**
 * §4.13 — the most security-sensitive endpoint in the product.
 *
 * `Idempotency-Key` and `result_version` are both required and they are not
 * redundant: a retry of the *same* attempt replays (idempotency); a *different*
 * attempt built on stale data is rejected (version).
 */
export function submitScore(
  matchId: MatchId,
  body: SubmitScoreBody,
  idempotencyKey: string,
): Promise<SubmitScoreResponse> {
  return put<SubmitScoreResponse>(org(`/matches/${encodeURIComponent(matchId)}/score`), {
    body,
    idempotencyKey,
  });
}

/**
 * §4.13b — the second half of `require_dual_confirm_final`. `403 forbidden`
 * with `details.reason: "same_organizer"` when the caller is the submitter;
 * a *different* organizer confirming is the entire control.
 */
export function confirmScore(
  matchId: MatchId,
  body: { result_version: number },
): Promise<SubmitScoreResponse> {
  return post<SubmitScoreResponse>(org(`/matches/${encodeURIComponent(matchId)}/confirm`), { body });
}

export interface ReopenMatchBody {
  result_version: number;
  /** ≥ 10 chars and **public** — it appears on the bracket as a correction note. */
  reason: string;
  /** `reset` (default) resets downstream; `strict` refuses if anything downstream is complete. */
  cascade?: 'reset' | 'strict';
}

/** §4.14 */
export function reopenMatch(
  matchId: MatchId,
  body: ReopenMatchBody,
): Promise<{ match: Match; reset: MatchId[]; voided: MatchId[] }> {
  return post<{ match: Match; reset: MatchId[]; voided: MatchId[] }>(
    org(`/matches/${encodeURIComponent(matchId)}/reopen`),
    { body },
  );
}

export interface MatchImpact {
  match: Match;
  changes_winner: boolean;
  invalidated: {
    match_id: MatchId;
    code: string;
    match_no: number;
    round_label: string;
  }[];
}

/**
 * §4.14.1 — the dry run behind the correction sheet. Runs the full
 * `resolveBracket` fold and writes nothing; rate-limited under `rl_engine`
 * because one request costs milliseconds of CPU rather than microseconds.
 */
export function getMatchImpact(
  matchId: MatchId,
  query: { winner_entrant_id?: EntrantId; is_draw?: boolean } = {},
): Promise<MatchImpact> {
  return get<MatchImpact>(org(`/matches/${encodeURIComponent(matchId)}/impact`), {
    query: query as QueryParams,
  });
}

/** §4.17 — edits within 15 min are silent; after that the public object carries `edited_at`. */
export function updateAnnouncement(
  announcementId: string,
  body: Partial<AnnouncementBody> & { version: number },
): Promise<Announcement> {
  return patch<Announcement>(org(`/announcements/${encodeURIComponent(announcementId)}`), { body });
}

/** Soft delete. `204`. */
export function deleteAnnouncement(announcementId: string): Promise<void> {
  return del<void>(org(`/announcements/${encodeURIComponent(announcementId)}`));
}

/** §4.18 — revoke a join invite. Note this is a different object from `GET /invites/:code`. `204`. */
export function revokeInvite(inviteId: string): Promise<void> {
  return del<void>(org(`/invites/${encodeURIComponent(inviteId)}`));
}

/* =====================================================================
 * §5 Admin API — `role = 'admin'` for everything; ⚡ routes also need step-up + UV
 * ===================================================================== */

const admin = (suffix: string): string => `/admin${suffix}`;

/** Includes inactive games. */
export function listAdminGames(): Promise<PagedResult<Game>> {
  return getPaged<Game>(admin('/games'));
}

/** **This is how a new game is added — a row, not a deploy.** `201`. */
export function createAdminGame(body: Omit<Game, 'id'>): Promise<Game> {
  return post<Game>(admin('/games'), { body });
}

export function updateAdminGame(
  id: string,
  body: Partial<Omit<Game, 'id'>> & { version: number },
): Promise<Game> {
  return patch<Game>(admin(`/games/${encodeURIComponent(id)}`), { body });
}

/** Soft delete → `active: false`. Hard delete refused if referenced. `204`. */
export function deleteAdminGame(id: string): Promise<void> {
  return del<void>(admin(`/games/${encodeURIComponent(id)}`));
}

export interface AdminUserSummary {
  id: UserId;
  handle: string;
  display_name: string;
  role: UserRole;
  created_at: Rfc3339;
  last_seen_at: Rfc3339 | null;
  credential_count: number;
  has_phone: boolean;
  tournaments_played: number;
  suspended_until: Rfc3339 | null;
}

export interface AdminUserQuery extends PageQuery {
  q?: string;
  role?: UserRole;
  state?: 'active' | 'deletion_pending' | 'suspended';
}

/** No phone numbers in this response, ever. */
export function listAdminUsers(query: AdminUserQuery = {}): Promise<PagedResult<AdminUserSummary>> {
  return getPaged<AdminUserSummary>(admin('/users'), { query: query as QueryParams });
}

export interface AdminUserDetail extends AdminUserSummary {
  phone_masked: string | null;
  email: string | null;
  session_count: number;
  recovery_codes_remaining: number;
}

export function getAdminUser(id: UserId): Promise<AdminUserDetail> {
  return get<AdminUserDetail>(admin(`/users/${encodeURIComponent(id)}`));
}

/** ⚡ Audited. The full phone, which the list deliberately does not carry. */
export function getAdminUserContact(
  id: UserId,
): Promise<{ phone_e164: string | null; email: string | null }> {
  return get<{ phone_e164: string | null; email: string | null }>(
    admin(`/users/${encodeURIComponent(id)}/contact`),
  );
}

/**
 * ⚡ Bumps `users.session_epoch`, invalidating every existing session of that
 * user: a role change must never be usable from a session that predates it.
 * Refuses to demote the last remaining admin.
 */
export function setUserRole(
  id: UserId,
  body: { role: UserRole; reason: string },
): Promise<AdminUserDetail> {
  return post<AdminUserDetail>(admin(`/users/${encodeURIComponent(id)}/role`), { body });
}

/**
 * ⚡ Sets `users.status = 'suspended'` — that is the authoritative gate —
 * and `suspended_until` to the timestamp or NULL. `null` means indefinite and
 * it works, because the session predicate reads `status`, not the timestamp.
 */
export function suspendUser(
  id: UserId,
  body: { until: Rfc3339 | null; reason: string },
): Promise<AdminUserDetail> {
  return post<AdminUserDetail>(admin(`/users/${encodeURIComponent(id)}/suspend`), { body });
}

/** Lifts a suspension; `moderation_reason` is preserved. `204`. */
export function unsuspendUser(id: UserId): Promise<void> {
  return del<void>(admin(`/users/${encodeURIComponent(id)}/suspend`));
}

/** ⚡ Revoke every session for a user (epoch bump). `204`. */
export function revokeUserSessions(id: UserId): Promise<void> {
  return del<void>(admin(`/users/${encodeURIComponent(id)}/sessions`));
}

export interface AdminSessionSummary extends SessionSummary {
  user: { handle: string };
  scope: string;
  revoked_at: Rfc3339 | null;
}

export function listAdminSessions(
  query: PageQuery & { user_id?: UserId; active?: boolean } = {},
): Promise<PagedResult<AdminSessionSummary>> {
  return getPaged<AdminSessionSummary>(admin('/sessions'), { query: query as QueryParams });
}

export function revokeAdminSession(id: SessionId): Promise<void> {
  return del<void>(admin(`/sessions/${encodeURIComponent(id)}`));
}

export interface AdminAuditQuery extends AuditQuery {
  entity_type?: string;
  entity_id?: string;
  tournament_id?: TournamentId;
}

/** Unredacted, unlike §4.21. */
export function listAdminAudit(query: AdminAuditQuery = {}): Promise<PagedResult<AuditEntry>> {
  return getPaged<AuditEntry>(admin('/audit'), { query: query as QueryParams });
}

/** Club info (§1.14). `version` required. Bumps `club_version`. */
export function updateClub(body: JsonObject & { version: number }): Promise<ClubResponse> {
  return patch<ClubResponse>(admin('/club'), { body });
}

/** Club-scope announcement. Same body as §4.17. */
export function createClubAnnouncement(body: AnnouncementBody): Promise<Announcement> {
  return post<Announcement>(admin('/announcements'), { body });
}

export interface VenueBody {
  name: string;
  area?: string | null;
  address?: string | null;
  /** Must be `https:` on an allowlisted maps host — same phishing rule as `stream_url`. */
  maps_url?: string | null;
  is_online?: boolean;
  capacity?: number | null;
  sort_order?: number;
}

/** §5.8 */
export function createVenue(body: VenueBody): Promise<Venue> {
  return post<Venue>(admin('/venues'), { body });
}

/** `venues.version` exists for exactly this: venue edits are not last-write-wins. */
export function updateVenue(
  id: VenueId,
  body: Partial<VenueBody> & { version: number },
): Promise<Venue> {
  return patch<Venue>(admin(`/venues/${encodeURIComponent(id)}`), { body });
}

/** Soft delete → `is_active = 0`; refused while any live tournament or future match references it. `204`. */
export function deleteVenue(id: VenueId): Promise<void> {
  return del<void>(admin(`/venues/${encodeURIComponent(id)}`));
}

export interface Season {
  id: string;
  slug: string;
  name: string;
  starts_at: Rfc3339;
  ends_at: Rfc3339 | null;
  is_active: boolean;
  tournament_count: number;
  version: number;
}

/** §5.9 — newest first. */
export function listSeasons(): Promise<PagedResult<Season>> {
  return getPaged<Season>(admin('/seasons'));
}

export interface SeasonBody {
  slug: string;
  name: string;
  starts_at: Rfc3339;
  ends_at?: Rfc3339 | null;
  is_active?: boolean;
}

/** `slug` follows the tournament slug regex and is immutable once created. */
export function createSeason(body: SeasonBody): Promise<Season> {
  return post<Season>(admin('/seasons'), { body });
}

/**
 * Only one season may be active: setting `is_active` clears it on every other
 * season in the same batch, and `meta.deactivated` says which one lost it.
 * Clearing the only active season is refused — publishing needs one.
 */
export function updateSeason(
  id: string,
  body: Partial<SeasonBody> & { version: number },
): Promise<Season> {
  return patch<Season>(admin(`/seasons/${encodeURIComponent(id)}`), { body });
}

export interface AdminStats {
  users: number;
  users_30d: number;
  tournaments_by_status: Record<string, number>;
  entrants_30d: number;
  matches_30d: number;
  sessions_active: number;
  d1: { size_bytes: number; rows_read_24h: number };
}

export function getAdminStats(): Promise<AdminStats> {
  return get<AdminStats>(admin('/stats'));
}

export interface LeaderboardRebuildBody {
  game?: string | null;
  period?: string;
  dry_run?: boolean;
  /** Returned as `resume_cursor` when `truncated` — a full rebuild is never one request. */
  cursor?: string | null;
}

/** ⚡ Chunked. If `truncated`, re-invoke with `resume_cursor`. */
export function rebuildLeaderboard(body: LeaderboardRebuildBody = {}): Promise<{
  processed: number;
  written: number;
  took_ms: number;
  truncated: boolean;
  resume_cursor: string | null;
}> {
  return post<{
    processed: number;
    written: number;
    took_ms: number;
    truncated: boolean;
    resume_cursor: string | null;
  }>(admin('/leaderboard/rebuild'), { body });
}

/** The Worker 301s `/t/<from>/` to `/t/<to>/`. `201`. */
export function createRedirect(body: { from: string; to: string }): Promise<{ from: string; to: string }> {
  return post<{ from: string; to: string }>(admin('/redirects'), { body });
}

/**
 * ⚡ Bumps the relevant version counter, which invalidates ETags and edge
 * entries by changing the URL-independent validator. It does **not** call the
 * Cloudflare purge API — there is no API token in the Worker (SECURITY.md §9).
 */
export function purgeCache(
  body: { scope: 'tournament'; id: TournamentId } | { scope: 'all' },
): Promise<{ purged: boolean }> {
  return post<{ purged: boolean }>(admin('/cache/purge'), { body });
}

/**
 * Re-export so a feature module can type a paginated result without also
 * importing `./client`. `Paged` from `lib/types` is not a thing; this is the
 * client's.
 */
export type { PagedResult as PagedResponse };
