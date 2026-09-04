import { describe, expect, it } from 'vitest';

import {
  countdownAriaLabel,
  countdownParts,
  countdownTickMs,
  formatCountdown,
  formatDurationMinutes,
  formatIstDate,
  formatIstDateTime,
  formatIstRange,
  formatIstTime,
  formatIstTimeWithZone,
  formatOfflineLabel,
  formatRelative,
  formatUpdatedLabel,
  isSameIstDay,
  istDateKey,
  istParts,
  parseRfc3339,
  toRfc3339,
} from './datetime';

/** The example instant used throughout API.md: 13:30 UTC = 19:00 IST. */
const NOV_8 = parseRfc3339('2026-11-08T13:30:00Z') as number;

describe('wire conversions', () => {
  it('round-trips RFC 3339 with a Z and no milliseconds', () => {
    expect(toRfc3339(NOV_8)).toBe('2026-11-08T13:30:00Z');
    expect(parseRfc3339('2026-11-08T13:30:00Z')).toBe(1_794_144_600);
  });

  it('returns null for every nullable form rather than NaN', () => {
    expect(parseRfc3339(null)).toBeNull();
    expect(parseRfc3339(undefined)).toBeNull();
    expect(parseRfc3339('')).toBeNull();
    expect(parseRfc3339('not a date')).toBeNull();
  });

  it('truncates rather than rounds, so a timestamp never moves forward', () => {
    expect(toRfc3339(1_794_144_600.9)).toBe('2026-11-08T13:30:00Z');
  });
});

describe('IST conversion — UTC+05:30, no DST', () => {
  it('adds 5:30 to UTC', () => {
    expect(istParts(NOV_8)).toEqual({
      year: 2026,
      month: 11,
      day: 8,
      hour: 19,
      minute: 0,
      second: 0,
      weekday: 0, // Sunday
    });
  });

  it('rolls the IST calendar day at 18:30 UTC', () => {
    // The boundary that catches an implementation using the device zone.
    const before = parseRfc3339('2026-11-08T18:29:00Z') as number;
    const after = parseRfc3339('2026-11-08T18:30:00Z') as number;
    expect(istDateKey(before)).toBe('2026-11-08');
    expect(istDateKey(after)).toBe('2026-11-09');
    expect(formatIstTime(after)).toBe('12:00 AM');
    expect(isSameIstDay(before, after)).toBe(false);
  });

  it('does not shift across the northern-hemisphere DST changeovers', () => {
    // India has no DST. Two instants exactly six months apart, both at 09:00
    // UTC, must both render 2:30 PM IST — a formatter that leaked the machine's
    // local zone would differ by an hour between these two.
    const march = parseRfc3339('2026-03-29T09:00:00Z') as number;
    const november = parseRfc3339('2026-11-01T09:00:00Z') as number;
    expect(formatIstTime(march)).toBe('2:30 PM');
    expect(formatIstTime(november)).toBe('2:30 PM');
  });

  it('renders noon and midnight as 12, not 0 or 24', () => {
    const istMidnight = parseRfc3339('2026-11-08T18:30:00Z') as number;
    const istNoon = parseRfc3339('2026-11-08T06:30:00Z') as number;
    expect(formatIstTime(istMidnight)).toBe('12:00 AM');
    expect(formatIstTime(istNoon)).toBe('12:00 PM');
  });
});

describe('display strings', () => {
  it('always carries the IST suffix on a player-facing time', () => {
    expect(formatIstTimeWithZone(NOV_8)).toBe('7:00 PM IST');
  });

  it('uses an ASCII space before the meridiem, not U+202F', () => {
    // A narrow no-break space from some ICU builds would make a WhatsApp
    // message differ byte-for-byte between two phones in the same group.
    expect(formatIstTime(NOV_8)).not.toMatch(/[  ]/);
  });

  it('formats dates with an optional weekday and an automatic year', () => {
    expect(formatIstDate(NOV_8, { relativeTo: NOV_8 })).toBe('8 Nov');
    expect(formatIstDate(NOV_8, { weekday: true, relativeTo: NOV_8 })).toBe('Sun 8 Nov');
    expect(formatIstDate(NOV_8, { year: 'always' })).toBe('8 Nov 2026');
    // A different year is shown without being asked.
    const nextYear = parseRfc3339('2027-01-10T06:00:00Z') as number;
    expect(formatIstDate(nextYear, { relativeTo: NOV_8 })).toBe('10 Jan 2027');
  });

  it('builds the card meta row', () => {
    expect(formatIstDateTime(NOV_8, { weekday: true, relativeTo: NOV_8 })).toBe(
      'Sun 8 Nov · 7:00 PM IST',
    );
    expect(formatIstDateTime(NOV_8, { separator: ', ', relativeTo: NOV_8 })).toBe(
      '8 Nov, 7:00 PM IST',
    );
  });

  it('collapses a same-day range to one date and an en dash', () => {
    const end = parseRfc3339('2026-11-08T16:30:00Z') as number;
    expect(formatIstRange(NOV_8, end, { weekday: true, relativeTo: NOV_8 })).toBe(
      'Sun 8 Nov, 7:00 PM – 10:00 PM IST',
    );
  });

  it('spells out both ends when the event crosses IST midnight', () => {
    const end = parseRfc3339('2026-11-08T19:30:00Z') as number;
    expect(formatIstRange(NOV_8, end, { relativeTo: NOV_8 })).toBe(
      '8 Nov, 7:00 PM – 9 Nov, 1:00 AM IST',
    );
  });

  it('degrades to the start alone when ends_at is null', () => {
    expect(formatIstRange(NOV_8, null, { relativeTo: NOV_8 })).toBe('8 Nov, 7:00 PM IST');
  });
});

describe('relative time and the freshness chip', () => {
  const now = NOV_8;

  it('says "just now" inside 45 seconds, in both directions', () => {
    expect(formatRelative(now - 10, now)).toBe('just now');
    expect(formatRelative(now + 10, now)).toBe('just now');
  });

  it('counts minutes, hours and days', () => {
    expect(formatRelative(now - 4 * 60, now)).toBe('4 min ago');
    expect(formatRelative(now + 4 * 60, now)).toBe('in 4 min');
    expect(formatRelative(now - 3 * 3600, now)).toBe('3 hours ago');
    expect(formatRelative(now - 3600, now)).toBe('1 hour ago');
    expect(formatRelative(now - 2 * 86_400, now)).toBe('2 days ago');
  });

  it('falls back to a date past a week — "in 43 days" is not a plan', () => {
    expect(formatRelative(now - 40 * 86_400, now)).toBe('29 Sep');
  });

  it('switches the chip from relative to absolute at one hour (IA.md §7.1)', () => {
    expect(formatUpdatedLabel(now - 4 * 60, now)).toBe('Updated 4 min ago');
    expect(formatUpdatedLabel(now - 61 * 60, now)).toBe('Updated 5:59 PM IST');
  });

  it('has an offline variant that names the time the data is from', () => {
    expect(formatOfflineLabel(now)).toBe('Offline · as of 7:00 PM IST');
  });
});

describe('countdowns', () => {
  const now = NOV_8;

  it('is mm:ss under an hour and hh:mm above it', () => {
    // Both forms are quoted verbatim in IA.md Journey 3.
    expect(formatCountdown(now + 12 * 60 + 41, now)).toBe('12:41');
    expect(formatCountdown(now + 24 * 3600 + 11 * 60, now)).toBe('24:11');
  });

  it('switches to days past four days', () => {
    expect(formatCountdown(now + 5 * 86_400 + 6 * 3600, now)).toBe('5d 06h');
  });

  it('clamps at zero rather than counting up', () => {
    expect(formatCountdown(now - 500, now)).toBe('00:00');
    expect(countdownParts(now - 500, now).expired).toBe(true);
  });

  it('gives a screen reader words, not a clock face', () => {
    expect(countdownAriaLabel(now + 12 * 60 + 41, now)).toBe('12 minutes 41 seconds');
    expect(countdownAriaLabel(now + 24 * 3600 + 11 * 60, now)).toBe('1 day 11 minutes');
    expect(countdownAriaLabel(now - 1, now)).toBe('now');
  });

  it('ticks per second only when seconds are on screen', () => {
    expect(countdownTickMs(now + 30 * 60, now)).toBe(1000);
    expect(countdownTickMs(now + 5 * 3600, now)).toBe(30_000);
  });
});

describe('durations', () => {
  it('formats what an organizer books a venue for', () => {
    expect(formatDurationMinutes(150)).toBe('2h 30m');
    expect(formatDurationMinutes(45)).toBe('45m');
    expect(formatDurationMinutes(120)).toBe('2h');
    expect(formatDurationMinutes(0)).toBe('—');
  });
});
