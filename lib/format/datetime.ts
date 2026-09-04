/**
 * Time formatting. ARCHITECTURE.md §5.1 row "Display", IA.md §0, CONTENT.md §10.2.
 *
 * Three rules, all load-bearing:
 *
 *  1. **Storage is unix seconds UTC; the wire is RFC 3339 with a `Z`; display
 *     is IST.** The zone is written out as `'Asia/Kolkata'` on every formatter
 *     and is never the browser's local zone — an organiser who travels, or a
 *     phone whose zone was never set (common on cheap Android), must still see
 *     the time the venue will run on.
 *  2. **Every human-facing time carries an explicit `IST` suffix.** IA.md §0 is
 *     unambiguous: never render a bare local time. A bare "6:00 PM" in a
 *     WhatsApp message is the one that gets a squad to the ground an hour late.
 *  3. **Strings are assembled from `formatToParts`, not from `format`.** ICU
 *     builds disagree about the separator before AM/PM (U+0020 vs U+202F) and
 *     about its case (`pm` in `en-IN`, `PM` in `en-US`). Left to `format()`,
 *     the same tournament renders `6:00 pm` on one phone and `6:00 PM` on the
 *     next, and a share message differs byte-for-byte between two people in the
 *     same group. Parts are extracted with Intl; the sentence is ours.
 *
 * IST is UTC+05:30 with **no DST**, which is why there is no "which offset was
 * in force" bookkeeping anywhere here. That is a property of the zone, not an
 * assumption: do not reuse this module for another one.
 */

import type { Rfc3339, UnixSeconds } from '../types';

export const IST_TIME_ZONE = 'Asia/Kolkata';
export const IST_LABEL = 'IST';

/** CONTENT.md §10.2: ranges use an en dash with spaces around it. */
const EN_DASH = '–';

/** The interpunct that separates fields on a card meta row (DESIGN.md §6). */
export const DOT = '·';

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/**
 * One formatter instance, constructed lazily. `Intl.DateTimeFormat` costs
 * ~1 ms to construct and this module is called once per bracket cell; building
 * it inside the function would be measurable on a 128-entrant draw.
 *
 * `hourCycle: 'h23'` rather than `hour12: false`, because the latter renders
 * midnight as `24` under some ICU builds.
 */
let partsFormatter: Intl.DateTimeFormat | null = null;

function getPartsFormatter(): Intl.DateTimeFormat {
  partsFormatter ??= new Intl.DateTimeFormat('en-GB', {
    timeZone: IST_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  return partsFormatter;
}

/** Calendar fields of an instant, in IST. `weekday` is 0 = Sunday. */
export interface IstParts {
  year: number;
  /** 1–12. */
  month: number;
  /** 1–31. */
  day: number;
  /** 0–23. */
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** Split an instant into IST calendar fields. The only place Intl touches a zone. */
export function istParts(seconds: UnixSeconds): IstParts {
  const parts = getPartsFormatter().formatToParts(new Date(seconds * 1000));

  let year = 1970;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let weekday = 4; // 1970-01-01 was a Thursday.

  for (const part of parts) {
    switch (part.type) {
      case 'year':
        year = Number(part.value);
        break;
      case 'month':
        month = Number(part.value);
        break;
      case 'day':
        day = Number(part.value);
        break;
      case 'hour':
        hour = Number(part.value) % 24;
        break;
      case 'minute':
        minute = Number(part.value);
        break;
      case 'second':
        second = Number(part.value);
        break;
      case 'weekday':
        weekday = WEEKDAY_INDEX[part.value] ?? weekday;
        break;
      default:
        break;
    }
  }

  return { year, month, day, hour, minute, second, weekday };
}

/* =====================================================================
 * Wire <-> storage
 * ===================================================================== */

/**
 * `1762608600` → `"2026-11-08T13:30:00Z"`. No milliseconds: API.md §0.8 fixes
 * the shape and a `.000` suffix is a needless three bytes on every field of a
 * 60 KB bracket.
 */
export function toRfc3339(seconds: UnixSeconds): Rfc3339 {
  return `${new Date(Math.trunc(seconds) * 1000).toISOString().slice(0, 19)}Z`;
}

/**
 * `"2026-11-08T13:30:00Z"` → `1762608600`. Returns `null` for `null`,
 * `undefined`, `""` and anything unparseable — every `_at` field on the wire is
 * nullable and a render path must not throw on one.
 *
 * Deliberately lenient about the offset it accepts while `toRfc3339` is strict
 * about the one it emits: Postel's rule is right here, because the alternative
 * is a blank match time if the server ever grows a `+05:30`.
 */
export function parseRfc3339(value: Rfc3339 | null | undefined): UnixSeconds | null {
  if (value === null || value === undefined || value === '') return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

/**
 * Device wall clock, in seconds. **Not for countdowns** — those go through
 * `components/data/useClockSkew.ts`, which corrects against `X-NC-Now`, because
 * a mid-range Android clock is routinely minutes wrong and a check-in countdown
 * that lies is worse than no countdown (API.md §0.10).
 */
export function deviceNowSeconds(): UnixSeconds {
  return Math.floor(Date.now() / 1000);
}

/* =====================================================================
 * Display
 * ===================================================================== */

export interface DateFormatOptions {
  /** Prefix the weekday: `Sat 12 Nov`. */
  weekday?: boolean;
  /** `auto` (default) prints the year only when it differs from `relativeTo`. */
  year?: 'auto' | 'always' | 'never';
  /** The instant "this year" is judged against. Defaults to the device clock. */
  relativeTo?: UnixSeconds;
  /** `November` instead of `Nov`. */
  longMonth?: boolean;
}

/** `12 Nov`, `Sat 12 Nov`, `9 Nov 2026`. */
export function formatIstDate(seconds: UnixSeconds, options: DateFormatOptions = {}): string {
  const { weekday = false, year = 'auto', relativeTo, longMonth = false } = options;
  const p = istParts(seconds);
  const month = (longMonth ? MONTHS_LONG[p.month - 1] : MONTHS[p.month - 1]) ?? '';

  let out = `${p.day} ${month}`;
  if (weekday) out = `${WEEKDAYS[p.weekday] ?? ''} ${out}`;

  const showYear =
    year === 'always' ||
    (year === 'auto' && p.year !== istParts(relativeTo ?? deviceNowSeconds()).year);
  if (showYear) out += ` ${p.year}`;

  return out;
}

/** `6:00 PM`. 12-hour with an uppercase meridiem and a plain ASCII space. */
export function formatIstTime(seconds: UnixSeconds): string {
  const p = istParts(seconds);
  const meridiem = p.hour < 12 ? 'AM' : 'PM';
  const hour12 = p.hour % 12 === 0 ? 12 : p.hour % 12;
  return `${hour12}:${String(p.minute).padStart(2, '0')} ${meridiem}`;
}

/** `6:00 PM IST`. The default for anything a player reads. */
export function formatIstTimeWithZone(seconds: UnixSeconds): string {
  return `${formatIstTime(seconds)} ${IST_LABEL}`;
}

export interface DateTimeFormatOptions extends DateFormatOptions {
  /** Between the date and the time. `' · '` on a card meta row, `', '` in prose. */
  separator?: string;
  /** Drop the `IST` suffix. Only legitimate next to another element that carries it. */
  zone?: boolean;
}

/** `Sat 12 Nov · 6:00 PM IST` — DESIGN.md §6's tournament-card meta row. */
export function formatIstDateTime(
  seconds: UnixSeconds,
  options: DateTimeFormatOptions = {},
): string {
  const { separator = ` ${DOT} `, zone = true, ...dateOptions } = options;
  const time = zone ? formatIstTimeWithZone(seconds) : formatIstTime(seconds);
  return `${formatIstDate(seconds, dateOptions)}${separator}${time}`;
}

/** Same IST calendar day. Used to decide whether a range repeats the date. */
export function isSameIstDay(a: UnixSeconds, b: UnixSeconds): boolean {
  const pa = istParts(a);
  const pb = istParts(b);
  return pa.year === pb.year && pa.month === pb.month && pa.day === pb.day;
}

/**
 * `Sun 21 Sep, 8:00 AM – 6:00 PM IST` within one day; both dates in full when
 * the event crosses midnight. `end === null` degrades to the start alone rather
 * than inventing an end — `tournaments.ends_at` is genuinely nullable.
 */
export function formatIstRange(
  start: UnixSeconds,
  end: UnixSeconds | null,
  options: DateFormatOptions = {},
): string {
  if (end === null) return formatIstDateTime(start, { ...options, separator: ', ' });

  if (isSameIstDay(start, end)) {
    return `${formatIstDate(start, options)}, ${formatIstTime(start)} ${EN_DASH} ${formatIstTimeWithZone(end)}`;
  }

  return `${formatIstDateTime(start, { ...options, separator: ', ', zone: false })} ${EN_DASH} ${formatIstDateTime(end, { ...options, separator: ', ' })}`;
}

/* =====================================================================
 * Relative time and countdowns
 * ===================================================================== */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * `just now`, `4 min ago`, `in 3 h`, `2 days ago`. Past and future both, so one
 * function serves "updated" chips and "starts" lines.
 *
 * Beyond 7 days it hands back the IST date: "in 43 days" is a number nobody
 * converts into a plan.
 */
export function formatRelative(seconds: UnixSeconds, now: UnixSeconds): string {
  const delta = seconds - now;
  const abs = Math.abs(delta);
  const past = delta < 0;

  if (abs < 45) return 'just now';

  const say = (value: number, unit: string): string => {
    const plural = value === 1 ? unit : `${unit}s`;
    return past ? `${value} ${plural} ago` : `in ${value} ${plural}`;
  };

  if (abs < HOUR) {
    const mins = Math.round(abs / MINUTE);
    return past ? `${mins} min ago` : `in ${mins} min`;
  }
  if (abs < DAY) return say(Math.round(abs / HOUR), 'hour');
  if (abs < 7 * DAY) return say(Math.round(abs / DAY), 'day');

  return formatIstDate(seconds, { relativeTo: now });
}

/**
 * The freshness chip of IA.md §7.1: relative under an hour, then the absolute
 * IST time. `Updated 4 min ago` / `Updated 6:42 PM IST`.
 *
 * The switch exists because "Updated 3 hours ago" is a fact nobody can act on,
 * while "Updated 6:42 PM IST" tells an organiser at the desk exactly which
 * round the number they are looking at belongs to.
 */
export function formatUpdatedLabel(fetchedAt: UnixSeconds, now: UnixSeconds): string {
  const age = now - fetchedAt;
  if (age < HOUR && age > -HOUR) return `Updated ${formatRelative(fetchedAt, now)}`;
  return `Updated ${formatIstTimeWithZone(fetchedAt)}`;
}

/** `Offline · as of 7:41 PM IST` — the offline variant of the same chip (DESIGN.md §6). */
export function formatOfflineLabel(fetchedAt: UnixSeconds): string {
  return `Offline ${DOT} as of ${formatIstTimeWithZone(fetchedAt)}`;
}

export interface CountdownParts {
  /** Whole seconds remaining, clamped at 0. */
  remaining: number;
  expired: boolean;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

export function countdownParts(target: UnixSeconds, now: UnixSeconds): CountdownParts {
  const remaining = Math.max(0, Math.trunc(target - now));
  return {
    remaining,
    expired: remaining === 0,
    days: Math.floor(remaining / DAY),
    hours: Math.floor((remaining % DAY) / HOUR),
    minutes: Math.floor((remaining % HOUR) / MINUTE),
    seconds: remaining % MINUTE,
  };
}

/**
 * The ticking string: `12:41` (mm:ss) under an hour, `24:11` (hh:mm) above it,
 * `5d 06h` past four days. IA.md Journey 3 quotes both of the first two forms.
 *
 * Under an hour it counts seconds because a room code appearing is a
 * to-the-second event a captain is staring at; above an hour it counts minutes,
 * because a ticking seconds digit on a 24-hour countdown is a repaint every
 * second for no information (and, on a phone, battery).
 *
 * Pair it with `countdownAriaLabel` — `24:11` read aloud is a time of day.
 */
export function formatCountdown(target: UnixSeconds, now: UnixSeconds): string {
  const p = countdownParts(target, now);
  if (p.remaining >= 4 * DAY) {
    return `${p.days}d ${String(p.hours).padStart(2, '0')}h`;
  }
  if (p.remaining >= HOUR) {
    const totalHours = p.days * 24 + p.hours;
    return `${totalHours}:${String(p.minutes).padStart(2, '0')}`;
  }
  return `${String(p.minutes).padStart(2, '0')}:${String(p.seconds).padStart(2, '0')}`;
}

/** `2 days 4 hours`, `12 minutes 41 seconds`. What a screen reader gets. */
export function countdownAriaLabel(target: UnixSeconds, now: UnixSeconds): string {
  const p = countdownParts(target, now);
  if (p.expired) return 'now';

  const unit = (value: number, name: string): string | null =>
    value === 0 ? null : `${value} ${value === 1 ? name : `${name}s`}`;

  const pieces =
    p.remaining >= HOUR
      ? [unit(p.days, 'day'), unit(p.hours, 'hour'), unit(p.minutes, 'minute')]
      : [unit(p.minutes, 'minute'), unit(p.seconds, 'second')];

  const said = pieces.filter((piece): piece is string => piece !== null);
  return said.length === 0 ? 'less than a minute' : said.join(' ');
}

/**
 * How often a countdown must repaint to stay honest, in milliseconds. A
 * `hh:mm` countdown re-rendering every second is 3,599 wasted repaints an hour
 * on the phone least able to afford them.
 */
export function countdownTickMs(target: UnixSeconds, now: UnixSeconds): number {
  return target - now >= HOUR ? 30_000 : 1_000;
}

/** `2h 30m`, `45m` — a duration, not a countdown (`typical_duration_minutes`). */
export function formatDurationMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '—';
  const whole = Math.round(minutes);
  const h = Math.floor(whole / 60);
  const m = whole % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/** `2026-11-08` in IST — for a `<time datetime>` attribute and for day grouping. */
export function istDateKey(seconds: UnixSeconds): string {
  const p = istParts(seconds);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
