import { describe, expect, it } from 'vitest';

import {
  formatFee,
  formatPaise,
  formatPaiseCompact,
  formatPrizePool,
  isValidPaise,
  paiseToWholeRupees,
  parseRupeesToPaise,
  rupeesToPaise,
} from './money';

describe('formatPaise — Indian digit grouping', () => {
  it('groups 3-2-2, not 3-3-3', () => {
    // The whole reason `en-IN` is used rather than a hand-rolled grouper.
    expect(formatPaise(10_000_000)).toBe('₹1,00,000');
    expect(formatPaise(100_000_000)).toBe('₹10,00,000');
    expect(formatPaise(1_234_567_800)).toBe('₹1,23,45,678');
  });

  it('does not group below 1,000', () => {
    expect(formatPaise(20_000)).toBe('₹200');
    expect(formatPaise(99_900)).toBe('₹999');
  });

  it('groups the first comma at 1,000', () => {
    expect(formatPaise(100_000)).toBe('₹1,000');
  });

  it('renders zero as ₹0 unless a zeroLabel is supplied', () => {
    expect(formatPaise(0)).toBe('₹0');
    expect(formatPaise(0, { zeroLabel: 'Free' })).toBe('Free');
  });

  it('renders a single paise rather than rounding it away', () => {
    // The naive `paise / 100` + maximumFractionDigits:0 implementation prints
    // ₹0 here, which is the bug this test exists to prevent.
    expect(formatPaise(1)).toBe('₹0.01');
    expect(formatPaise(99)).toBe('₹0.99');
    expect(formatPaise(101)).toBe('₹1.01');
    expect(formatPaise(20_050)).toBe('₹200.50');
  });

  it('keeps whole rupees clean but can be forced to two decimals', () => {
    expect(formatPaise(20_000)).toBe('₹200');
    expect(formatPaise(20_000, { showPaise: true })).toBe('₹200.00');
  });

  it('handles a negative amount (a refund line)', () => {
    expect(formatPaise(-20_000)).toBe('-₹200');
    expect(formatPaise(-1)).toBe('-₹0.01');
  });

  it('can drop the symbol for a column that carries it in the header', () => {
    expect(formatPaise(10_000_000, { symbol: false })).toBe('1,00,000');
  });

  it('never throws on a corrupt number — a bad value must not blank a page', () => {
    expect(formatPaise(Number.NaN)).toBe('—');
    expect(formatPaise(Number.POSITIVE_INFINITY)).toBe('—');
    expect(formatPaise(1.5)).toBe('—');
  });
});

describe('formatFee / formatPrizePool', () => {
  it('says Free rather than ₹0', () => {
    expect(formatFee(0)).toBe('Free');
    expect(formatFee(15_000)).toBe('₹150');
  });

  it('hides a zero prize pool entirely so the row can be dropped', () => {
    expect(formatPrizePool(0)).toBeNull();
    expect(formatPrizePool(-1)).toBeNull();
    expect(formatPrizePool(1_500_000)).toBe('₹15,000');
  });
});

describe('formatPaiseCompact', () => {
  it('uses Indian units', () => {
    expect(formatPaiseCompact(1_000_000)).toBe('₹10K');
    expect(formatPaiseCompact(1_500_000)).toBe('₹15K');
    expect(formatPaiseCompact(15_000_000)).toBe('₹1.5L');
    expect(formatPaiseCompact(1_000_000_000)).toBe('₹1Cr');
  });

  it('falls back to the exact figure below ₹10,000', () => {
    expect(formatPaiseCompact(20_000)).toBe('₹200');
    expect(formatPaiseCompact(999_900)).toBe('₹9,999');
  });
});

describe('conversions', () => {
  it('rupees to paise is exact', () => {
    expect(rupeesToPaise(200)).toBe(20_000);
    expect(rupeesToPaise(1200)).toBe(120_000);
    expect(rupeesToPaise(0)).toBe(0);
  });

  it('paise to whole rupees refuses to silently drop a remainder', () => {
    expect(paiseToWholeRupees(20_000)).toBe(200);
    expect(paiseToWholeRupees(20_001)).toBeNull();
  });

  it('validates', () => {
    expect(isValidPaise(0)).toBe(true);
    expect(isValidPaise(1.5)).toBe(false);
    expect(isValidPaise('200')).toBe(false);
  });
});

describe('parseRupeesToPaise', () => {
  it('accepts what an organizer actually types', () => {
    expect(parseRupeesToPaise('200')).toBe(20_000);
    expect(parseRupeesToPaise(' 200 ')).toBe(20_000);
    expect(parseRupeesToPaise('₹200')).toBe(20_000);
    expect(parseRupeesToPaise('1,00,000')).toBe(10_000_000);
    expect(parseRupeesToPaise('100000')).toBe(10_000_000);
  });

  it('accepts one or two decimal places and pads correctly', () => {
    expect(parseRupeesToPaise('200.5')).toBe(20_050);
    expect(parseRupeesToPaise('200.50')).toBe(20_050);
    expect(parseRupeesToPaise('0.01')).toBe(1);
  });

  it('rejects rather than guessing', () => {
    expect(parseRupeesToPaise('')).toBeNull();
    expect(parseRupeesToPaise('abc')).toBeNull();
    expect(parseRupeesToPaise('200.505')).toBeNull();
    expect(parseRupeesToPaise('1e3')).toBeNull();
    expect(parseRupeesToPaise('2 0 0 x')).toBeNull();
  });
});
