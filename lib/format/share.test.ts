import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseRfc3339 } from './datetime';
import {
  ordinal,
  shareBracketRound,
  shareMatch,
  sharePlayerResult,
  shareRoomCode,
  shareStandings,
  shareTournament,
  statusHeadline,
  tournamentPath,
  waBold,
} from './share';

const NOV_8 = parseRfc3339('2026-11-08T13:30:00Z') as number;

describe('the payload contract', () => {
  const payload = shareTournament({
    slug: 'bgmi-diwali-cup',
    title: 'BGMI Diwali Cup',
    status: 'live',
    starts_at: NOV_8,
    entry_fee_paise: 20_000,
    prize_pool_paise: 1_000_000,
    entrant_count: 32,
    progress: 'Match 3 of 6',
    lead: 'Team Vega leading with 42 pts',
  });

  it('is two short lines and never contains the URL in `text`', () => {
    // `navigator.share` appends `url` itself; carrying it in both fields posts
    // the link twice in the WhatsApp message.
    expect(payload.text.split('\n')).toHaveLength(2);
    expect(payload.text).not.toContain('nellore.club');
  });

  it('puts the bare display URL on the clipboard, scheme-less', () => {
    expect(payload.clipboard).toBe(`${payload.text}\nnellore.club/t/bgmi-diwali-cup/`);
    expect(payload.clipboard).not.toContain('https://');
  });

  it('shares an absolute URL', () => {
    expect(payload.url).toBe('https://nellore.club/t/bgmi-diwali-cup/');
  });

  it('reproduces the example in IA.md §10 exactly', () => {
    expect(payload.clipboard).toBe(
      '*BGMI Diwali Cup* — LIVE\n' +
        'Match 3 of 6 · Team Vega leading with 42 pts\n' +
        'nellore.club/t/bgmi-diwali-cup/',
    );
  });

  it('uses no emoji — the subset font has none and the printed pack has none', () => {
    expect(payload.clipboard).toMatch(/^[\p{L}\p{N}\p{P}\p{Zs}·—–₹\n]+$/u);
  });
});

describe('purity', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not read the clock — the same input gives the same bytes in any year', () => {
    // A composer whose output depends on `Date.now()` cannot be asserted on,
    // and the thing that would silently reintroduce it is a date formatter left
    // on `year: 'auto'`.
    const input = {
      slug: 'carrom-open-2026',
      title: 'Carrom Open 2026',
      status: 'registration_open' as const,
      starts_at: NOV_8,
      entry_fee_paise: 15_000,
      prize_pool_paise: 0,
      entrant_count: 24,
    };

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    const sameYear = shareTournament(input).clipboard;
    vi.setSystemTime(new Date('2031-01-01T00:00:00Z'));
    const laterYear = shareTournament(input).clipboard;

    expect(laterYear).toBe(sameYear);
  });
});

describe('shareTournament — the second line follows the status', () => {
  const base = {
    slug: 'carrom-open-2026',
    title: 'Carrom Open 2026',
    starts_at: NOV_8,
    entry_fee_paise: 15_000,
    prize_pool_paise: 1_000_000,
    entrant_count: 24,
  };

  it('leads with cost, time and slots before the event', () => {
    const message = shareTournament({
      ...base,
      status: 'registration_open',
      spots_left: 8,
    });
    expect(message.text).toBe(
      '*Carrom Open 2026* — Registration open\n' +
        '8 Nov, 7:00 PM IST · ₹150 entry · ₹10,000 prize pool · 8 slots left',
    );
  });

  it('says Free rather than ₹0', () => {
    const message = shareTournament({
      ...base,
      status: 'registration_open',
      entry_fee_paise: 0,
      prize_pool_paise: 0,
    });
    expect(message.text).toContain('Free entry');
    expect(message.text).not.toContain('prize pool');
  });

  it('names the winner once it is over', () => {
    const message = shareTournament({
      ...base,
      status: 'completed',
      winner: 'Ravi K',
    });
    expect(message.text).toBe('*Carrom Open 2026* — Result\nWon by Ravi K · 24 entered');
  });

  it('falls back to the entrant count when nobody is reported leading', () => {
    const message = shareTournament({ ...base, status: 'live', progress: 'Round 2 of 4' });
    expect(message.text).toBe('*Carrom Open 2026* — LIVE\nRound 2 of 4 · 24 entered');
  });
});

describe('shareBracketRound', () => {
  it('summarises the current round and links the bracket', () => {
    const message = shareBracketRound({
      slug: 'bgmi-diwali-cup',
      title: 'BGMI Diwali Cup',
      roundName: 'Semi-final',
      completed: 2,
      total: 4,
      remaining: 8,
    });
    expect(message.clipboard).toBe(
      '*BGMI Diwali Cup* — Semi-final\n' +
        '2 of 4 matches done · 8 left\n' +
        'nellore.club/t/bgmi-diwali-cup/bracket/',
    );
  });

  it('omits the "left" fragment when the format has no elimination', () => {
    const message = shareBracketRound({
      slug: 'chess-open',
      title: 'Chess Open',
      roundName: 'Round 3',
      completed: 6,
      total: 8,
    });
    expect(message.text).toBe('*Chess Open* — Round 3\n6 of 8 matches done');
  });
});

describe('shareRoomCode — IA.md Journey 3 fixes this one verbatim', () => {
  it('matches the documented message', () => {
    const message = shareRoomCode({
      slug: 'bgmi-diwali-cup',
      title: 'BGMI Diwali Cup',
      matchLabel: 'Match 3',
      roomCode: '48213',
      roomPassword: '7712',
      scheduledAt: parseRfc3339('2026-11-08T14:00:00Z') as number,
    });
    expect(message.clipboard).toBe(
      'BGMI Diwali Cup — Match 3\n' +
        'Room 48213 · Pass 7712\n' +
        '7:30 PM IST\n' +
        'nellore.club/t/bgmi-diwali-cup/',
    );
  });

  it('uses the game definition labels when supplied', () => {
    const message = shareRoomCode({
      slug: 'cs2-lan',
      title: 'CS2 LAN',
      matchLabel: 'Map 1',
      roomCode: 'connect 10.0.0.4',
      codeLabel: 'Server',
    });
    expect(message.text).toBe('CS2 LAN — Map 1\nServer connect 10.0.0.4');
  });

  it('drops the password fragment entirely when there is none', () => {
    const message = shareRoomCode({
      slug: 'ff-cup',
      title: 'Free Fire Cup',
      matchLabel: 'Lobby 2',
      roomCode: '99120',
      roomPassword: null,
    });
    expect(message.text).toBe('Free Fire Cup — Lobby 2\nRoom 99120');
  });
});

describe('shareStandings', () => {
  it('renders a podium and links the standings page', () => {
    const message = shareStandings({
      slug: 'carrom-open-2026',
      title: 'Carrom Open 2026',
      top: [
        { rank: 1, name: 'Ravi K' },
        { rank: 2, name: 'Sudheer' },
        { rank: 3, name: 'Priya' },
        { rank: 4, name: 'Not shown' },
      ],
    });
    expect(message.clipboard).toBe(
      '*Carrom Open 2026* — Final standings\n' +
        '1st Ravi K · 2nd Sudheer · 3rd Priya\n' +
        'nellore.club/t/carrom-open-2026/standings/',
    );
  });

  it('takes a mid-event label', () => {
    const message = shareStandings({
      slug: 'chess-open',
      title: 'Chess Open',
      top: [{ rank: 1, name: 'Ravi K' }],
      label: 'Standings after Round 3',
    });
    expect(message.text).toBe('*Chess Open* — Standings after Round 3\n1st Ravi K');
  });
});

describe('sharePlayerResult', () => {
  it('links the tournament standings, not the profile', () => {
    const message = sharePlayerResult({
      handle: 'ravik',
      displayName: 'Ravi K',
      tournamentTitle: 'Carrom Open 2026',
      tournamentSlug: 'carrom-open-2026',
      placement: 2,
      entrantCount: 32,
    });
    expect(message.clipboard).toBe(
      '*Ravi K* — 2nd at Carrom Open 2026\n' +
        'Out of 32 entries\n' +
        'nellore.club/t/carrom-open-2026/standings/',
    );
  });

  it('uses the team name when the entry was a squad', () => {
    const message = sharePlayerResult({
      handle: 'arjun_n',
      displayName: 'Arjun',
      entrantDisplayName: 'Team Falcon',
      tournamentTitle: 'BGMI Diwali Cup',
      tournamentSlug: 'bgmi-diwali-cup',
      placement: 1,
      entrantCount: 25,
    });
    expect(message.text.startsWith('*Team Falcon* — 1st at BGMI Diwali Cup')).toBe(true);
  });

  it('says "played" when there is no placement', () => {
    const message = sharePlayerResult({
      handle: 'ravik',
      displayName: 'Ravi K',
      tournamentTitle: 'Carrom Open 2026',
      tournamentSlug: 'carrom-open-2026',
      placement: null,
      entrantCount: 32,
    });
    expect(message.text).toContain('played Carrom Open 2026');
  });
});

describe('shareMatch', () => {
  it('shows a live score line', () => {
    const message = shareMatch({
      slug: 'carrom-open-2026',
      title: 'Carrom Open 2026',
      matchLabel: 'Semi-final 1',
      state: 'live',
      sideA: 'Ravi K',
      sideB: 'Sudheer',
      scoreA: 2,
      scoreB: 1,
    });
    expect(message.text).toBe('*Carrom Open 2026* — Semi-final 1\nRavi K 2 – 1 Sudheer · LIVE');
  });

  it('shows the scheduled time when the match has not started', () => {
    const message = shareMatch({
      slug: 'carrom-open-2026',
      title: 'Carrom Open 2026',
      matchLabel: 'Final',
      state: 'ready',
      sideA: 'Ravi K',
      sideB: 'Priya',
      scheduledAt: NOV_8,
    });
    expect(message.text).toBe('*Carrom Open 2026* — Final\nRavi K vs Priya · 7:00 PM IST');
  });
});

describe('helpers', () => {
  it('bolds with WhatsApp markup, not markdown', () => {
    expect(waBold('BGMI Diwali Cup')).toBe('*BGMI Diwali Cup*');
  });

  it('builds canonical trailing-slash paths', () => {
    expect(tournamentPath('bgmi-diwali-cup')).toBe('/t/bgmi-diwali-cup/');
  });

  it('shouts only for LIVE', () => {
    expect(statusHeadline('live')).toBe('LIVE');
    expect(statusHeadline('registration_open')).toBe('Registration open');
    expect(statusHeadline('draft')).toBe('Upcoming');
  });

  it('gets the English ordinals right, including the teens', () => {
    expect(ordinal(1)).toBe('1st');
    expect(ordinal(2)).toBe('2nd');
    expect(ordinal(3)).toBe('3rd');
    expect(ordinal(4)).toBe('4th');
    expect(ordinal(11)).toBe('11th');
    expect(ordinal(12)).toBe('12th');
    expect(ordinal(13)).toBe('13th');
    expect(ordinal(21)).toBe('21st');
    expect(ordinal(111)).toBe('111th');
  });
});
