/**
 * WhatsApp share-text composers. IA.md §10.
 *
 * WhatsApp is the club's entire distribution channel, so these strings are a
 * product surface, not a utility. Every composer is a **pure function of its
 * arguments** — no `Date.now()`, no DOM, no fetch — because the only way to
 * know a share message is right is to assert on it in a test, and the only way
 * to do that is if it cannot vary.
 *
 * Three shape rules, all from IA.md §10:
 *
 *  - The payload is always `{ title, text, url }` for `navigator.share`, with a
 *    **WhatsApp-shaped `text`: two short lines**. Long paragraphs are truncated
 *    by every client that renders them.
 *  - `*bold*` is WhatsApp's own markup and is used on the event name.
 *  - `clipboard` carries the same two lines **plus the bare display URL**
 *    (`nellore.club/t/<slug>/`, no scheme). That is the copy-to-clipboard
 *    fallback and the "Copy for WhatsApp" button. `text` deliberately does NOT
 *    contain the URL: `navigator.share` appends `url` itself, and a payload
 *    carrying it in both fields posts the link twice.
 *
 * Emoji are not used. DESIGN.md §3.2 subsets the font to Latin plus five
 * codepoints, and an emoji in a share string renders as tofu in the printed
 * pack and inconsistently across Android OEM keyboards.
 */

import type { MatchStatus, TournamentStatus } from '../types';

import { absoluteUrl, displayUrl } from '../content/club';
import { DOT, formatIstDateTime, formatIstTimeWithZone } from './datetime';
import { formatFee, formatPrizePool } from './money';

/**
 * What a Share control passes to `navigator.share` (`title`/`text`/`url`) and
 * what a Copy control puts on the clipboard (`clipboard`).
 */
export interface ShareMessage {
  title: string;
  /** Two short lines. No URL — `url` carries that. */
  text: string;
  /** Absolute, `https://nellore.club/...`. */
  url: string;
  /** `text` + newline + the bare `nellore.club/...` display URL. */
  clipboard: string;
}

/** `*BGMI Diwali Cup*` — WhatsApp's bold markup, not markdown's. */
export function waBold(text: string): string {
  return `*${text}*`;
}

/**
 * Assemble the payload. One place builds `clipboard`, so the URL can never be
 * present in `text` and absent from the clipboard, or vice versa.
 */
function message(title: string, lines: string[], path: string): ShareMessage {
  const text = lines.filter((line) => line !== '').join('\n');
  return {
    title,
    text,
    url: absoluteUrl(path),
    clipboard: `${text}\n${displayUrl(path)}`,
  };
}

/** Trailing-slash canonical paths, matching IA.md §1.1. */
export function tournamentPath(slug: string): string {
  return `/t/${slug}/`;
}

export function playerPath(handle: string): string {
  return `/p/${handle}/`;
}

/**
 * The status word that leads a share line. `LIVE` is upper case because it is
 * the one status that changes what the reader does next; the rest are sentence
 * case (CONTENT.md §10.2 — no shouting).
 */
export function statusHeadline(status: TournamentStatus): string {
  switch (status) {
    case 'live':
      return 'LIVE';
    case 'registration_open':
      return 'Registration open';
    case 'registration_closed':
      return 'Registration closed';
    case 'check_in':
      return 'Check-in open';
    case 'completed':
      return 'Result';
    case 'cancelled':
      return 'Cancelled';
    case 'published':
    case 'draft':
    case 'archived':
    default:
      return 'Upcoming';
  }
}

/** Join non-empty fragments with the interpunct the whole product uses. */
function joinDot(parts: (string | null | undefined)[]): string {
  return parts.filter((part): part is string => typeof part === 'string' && part !== '').join(
    ` ${DOT} `,
  );
}

/* =====================================================================
 * 1. Tournament overview
 * ===================================================================== */

export interface TournamentShareInput {
  slug: string;
  title: string;
  status: TournamentStatus;
  /** Unix seconds. */
  starts_at: number;
  entry_fee_paise: number;
  prize_pool_paise: number;
  entrant_count: number;
  /** `null` when uncapped; drives the "slots left" line while registration is open. */
  spots_left?: number | null;
  /** Live only: `Match 3 of 6`-style progress, already computed by the caller. */
  progress?: string | null;
  /** Live only: who is ahead, e.g. `Team Vega leading with 42 pts`. */
  lead?: string | null;
  /** Completed only. */
  winner?: string | null;
}

/**
 * ```
 * *BGMI Diwali Cup* — LIVE
 * Match 3 of 6 · Team Vega leading with 42 pts
 * nellore.club/t/bgmi-diwali-cup/
 * ```
 *
 * The second line is status-dependent because the question the reader has is
 * status-dependent: before the event it is "what does it cost and when", during
 * it is "who is winning", after it is "who won".
 */
export function shareTournament(input: TournamentShareInput): ShareMessage {
  const headline = `${waBold(input.title)} — ${statusHeadline(input.status)}`;

  let detail: string;
  switch (input.status) {
    case 'live':
      detail = joinDot([input.progress, input.lead ?? `${input.entrant_count} entered`]);
      break;
    case 'completed':
      detail = joinDot([
        input.winner === null || input.winner === undefined ? null : `Won by ${input.winner}`,
        `${input.entrant_count} entered`,
      ]);
      break;
    case 'cancelled':
      detail = formatIstDateTime(input.starts_at, { separator: ', ', year: 'never' });
      break;
    default:
      detail = joinDot([
        // `year: 'never'` rather than the default `'auto'`, for two reasons:
        // `'auto'` compares against `Date.now()`, which would make this
        // composer impure and its output untestable; and IA.md §4's
        // og:description example is `12 Nov, 6:00 PM IST`. A share message is
        // read within days of being sent.
        formatIstDateTime(input.starts_at, { separator: ', ', year: 'never' }),
        `${formatFee(input.entry_fee_paise)} entry`,
        formatPrizePool(input.prize_pool_paise) === null
          ? null
          : `${formatPrizePool(input.prize_pool_paise)} prize pool`,
        typeof input.spots_left === 'number' && input.spots_left > 0
          ? `${input.spots_left} slots left`
          : null,
      ]);
      break;
  }

  return message(input.title, [headline, detail], tournamentPath(input.slug));
}

/* =====================================================================
 * 2. Bracket — the current round summary
 * ===================================================================== */

export interface BracketShareInput {
  slug: string;
  title: string;
  /** `Winners Round 3`, `Round 2`, `Semi-final`. */
  roundName: string;
  /** Matches finished / matches in the round. */
  completed: number;
  total: number;
  /** Entrants still alive, when the format has an elimination notion. */
  remaining?: number | null;
}

/**
 * ```
 * *BGMI Diwali Cup* — Semi-final
 * 2 of 4 matches done · 8 teams left
 * nellore.club/t/bgmi-diwali-cup/bracket/
 * ```
 */
export function shareBracketRound(input: BracketShareInput): ShareMessage {
  return message(
    `${input.title} — ${input.roundName}`,
    [
      `${waBold(input.title)} — ${input.roundName}`,
      joinDot([
        `${input.completed} of ${input.total} matches done`,
        typeof input.remaining === 'number' ? `${input.remaining} left` : null,
      ]),
    ],
    `${tournamentPath(input.slug)}bracket/`,
  );
}

/* =====================================================================
 * 3. Room code — IA.md Journey 3
 * ===================================================================== */

export interface RoomCodeShareInput {
  slug: string;
  title: string;
  /** `Match 3`, `Lobby 2`. */
  matchLabel: string;
  roomCode: string;
  roomPassword?: string | null;
  /** Unix seconds. The start time the squad has to be in the lobby by. */
  scheduledAt?: number | null;
  /** `Room ID` for BGMI, `Server` for CS2 — `match_defaults.lobby_code_label`. */
  codeLabel?: string;
  passwordLabel?: string;
}

/**
 * IA.md Journey 3 fixes this one verbatim, including the absence of bold:
 *
 * ```
 * BGMI Diwali Cup — Match 3
 * Room 48213 · Pass 7712
 * 7:30 PM IST
 * nellore.club/t/bgmi-diwali-cup/
 * ```
 *
 * Three lines rather than two because the code is the payload and the time is
 * what makes it actionable; this is the one message a captain forwards
 * verbatim into a squad group at speed.
 */
export function shareRoomCode(input: RoomCodeShareInput): ShareMessage {
  const codeLabel = input.codeLabel ?? 'Room';
  const passwordLabel = input.passwordLabel ?? 'Pass';

  const credentials = joinDot([
    `${codeLabel} ${input.roomCode}`,
    input.roomPassword === null || input.roomPassword === undefined || input.roomPassword === ''
      ? null
      : `${passwordLabel} ${input.roomPassword}`,
  ]);

  const when =
    typeof input.scheduledAt === 'number' ? formatIstTimeWithZone(input.scheduledAt) : '';

  return message(
    `${input.title} — ${input.matchLabel}`,
    [`${input.title} — ${input.matchLabel}`, credentials, when],
    tournamentPath(input.slug),
  );
}

/* =====================================================================
 * 4. Final standings
 * ===================================================================== */

export interface StandingsShareEntry {
  rank: number;
  name: string;
}

export interface StandingsShareInput {
  slug: string;
  title: string;
  /** Podium, in rank order. Anything past three is dropped — this is a message, not a table. */
  top: StandingsShareEntry[];
  /** `Final standings` vs `Standings after Round 3`. */
  label?: string;
}

const PLACE = ['1st', '2nd', '3rd'] as const;

/**
 * ```
 * *Carrom Open 2026* — Final standings
 * 1st Ravi K · 2nd Sudheer · 3rd Priya
 * nellore.club/t/carrom-open-2026/standings/
 * ```
 */
export function shareStandings(input: StandingsShareInput): ShareMessage {
  const label = input.label ?? 'Final standings';
  const podium = input.top
    .slice(0, 3)
    .map((entry, index) => `${PLACE[index] ?? `${entry.rank}.`} ${entry.name}`);

  return message(
    `${input.title} — ${label}`,
    [`${waBold(input.title)} — ${label}`, podium.join(` ${DOT} `)],
    `${tournamentPath(input.slug)}standings/`,
  );
}

/* =====================================================================
 * 5. A player's own result
 * ===================================================================== */

export interface PlayerResultShareInput {
  handle: string;
  displayName: string;
  tournamentTitle: string;
  tournamentSlug: string;
  /** `null` when the tournament has no placement for them (withdrawn, still running). */
  placement: number | null;
  entrantCount: number;
  /** The name they played under: a team name for a squad entry. */
  entrantDisplayName?: string | null;
}

/**
 * ```
 * *Ravi K* — 2nd at Carrom Open 2026
 * Out of 32 entries
 * nellore.club/t/carrom-open-2026/standings/
 * ```
 *
 * The link points at the tournament's standings, not at the player profile: a
 * result is only credible next to the table it came from, and that is the page
 * the recipient wants.
 */
export function sharePlayerResult(input: PlayerResultShareInput): ShareMessage {
  const who = input.entrantDisplayName ?? input.displayName;
  const place =
    input.placement === null ? `played ${input.tournamentTitle}` : `${ordinal(input.placement)} at ${input.tournamentTitle}`;

  return message(
    `${who} — ${place}`,
    [`${waBold(who)} — ${place}`, `Out of ${input.entrantCount} entries`],
    `${tournamentPath(input.tournamentSlug)}standings/`,
  );
}

/** `1st`, `2nd`, `3rd`, `4th`, `11th`, `21st`. */
export function ordinal(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(Math.trunc(n));
  const lastTwo = abs % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return `${abs}th`;
  switch (abs % 10) {
    case 1:
      return `${abs}st`;
    case 2:
      return `${abs}nd`;
    case 3:
      return `${abs}rd`;
    default:
      return `${abs}th`;
  }
}

/* =====================================================================
 * 6. A single match — the "who is playing right now" forward
 * ===================================================================== */

export interface MatchShareInput {
  slug: string;
  title: string;
  matchLabel: string;
  state: MatchStatus;
  sideA: string;
  sideB: string;
  scoreA?: number | null;
  scoreB?: number | null;
  scheduledAt?: number | null;
}

/**
 * ```
 * *Carrom Open 2026* — Semi-final 1
 * Ravi K 2 – 1 Sudheer · LIVE
 * nellore.club/t/carrom-open-2026/bracket/
 * ```
 */
export function shareMatch(input: MatchShareInput): ShareMessage {
  const hasScore = typeof input.scoreA === 'number' && typeof input.scoreB === 'number';
  const line = hasScore
    ? `${input.sideA} ${input.scoreA} – ${input.scoreB} ${input.sideB}`
    : `${input.sideA} vs ${input.sideB}`;

  const suffix =
    input.state === 'live'
      ? 'LIVE'
      : input.state === 'complete'
        ? 'Final'
        : typeof input.scheduledAt === 'number'
          ? formatIstTimeWithZone(input.scheduledAt)
          : null;

  return message(
    `${input.title} — ${input.matchLabel}`,
    [`${waBold(input.title)} — ${input.matchLabel}`, joinDot([line, suffix])],
    `${tournamentPath(input.slug)}bracket/`,
  );
}

/* =====================================================================
 * The Share control's own behaviour
 * ===================================================================== */

/**
 * The Web Share payload, declared here rather than taken from `lib.dom`:
 * `worker/tsconfig.json` includes `../lib/**` and checks this file with
 * `lib: ["ES2022"]`, where `ShareData` does not exist.
 */
export interface WebShareData {
  title?: string;
  text?: string;
  url?: string;
}

interface ShareCapableNavigator {
  canShare?: (data: WebShareData) => boolean;
  share?: (data: WebShareData) => Promise<void>;
}

/** The `{ title, text, url }` triple, ready for `navigator.share`. */
export function toWebShareData(payload: ShareMessage): WebShareData {
  return { title: payload.title, text: payload.text, url: payload.url };
}

/**
 * True when the browser can hand the payload to WhatsApp directly. `canShare`
 * is checked with the actual payload, not just for the presence of
 * `navigator.share`: Safari advertises the API and rejects some payloads, and a
 * rejected share is a dead button with no fallback.
 */
export function canNativeShare(payload: ShareMessage): boolean {
  const nav = (globalThis as unknown as { navigator?: ShareCapableNavigator }).navigator;
  if (nav === undefined || typeof nav.share !== 'function') return false;
  const data = toWebShareData(payload);
  return typeof nav.canShare === 'function' ? nav.canShare(data) : true;
}
