/**
 * Money formatting. ARCHITECTURE.md §5.1, API.md §0.8.
 *
 * Storage and the wire are **integer paise**. Display is `₹` with the Indian
 * digit grouping (`₹1,00,000`, not `₹100,000`) that `Intl.NumberFormat('en-IN')`
 * produces for free.
 *
 * The one rule that shapes every function here: **no value in this module is
 * ever a non-integer.** The obvious implementation — `paise / 100` handed to a
 * currency formatter — is a float, and a float is how ₹1,499.995 becomes
 * ₹1,500.00 in one place and ₹1,499.99 in another on the same screen. Instead
 * the rupee part and the paise part are separated with integer division and the
 * grouped string is assembled by hand. `Intl` is used only for the grouping of
 * an integer, which is exactly the part that is genuinely locale knowledge.
 */

import type { Paise } from '../types';

/** DESIGN.md §3.2 subsets `₹` (U+20B9) into the font on purpose. */
export const RUPEE = '₹';

export const PAISE_PER_RUPEE = 100;

/**
 * Grouping only. Never `style: 'currency'`: that path forces a fractional
 * `number` through the formatter, and the symbol placement/spacing it emits
 * varies with the ICU build shipped in a given browser, which then varies the
 * bytes of a WhatsApp share message between two phones.
 */
const GROUP = new Intl.NumberFormat('en-IN', {
  style: 'decimal',
  useGrouping: true,
  maximumFractionDigits: 0,
});

export interface MoneyFormatOptions {
  /**
   * Force the two-decimal form even when the amount is a whole rupee. Off by
   * default: every fee the club charges today is a whole rupee and `₹200.00`
   * reads like a bank statement, not a poster.
   */
  showPaise?: boolean;
  /** Omit the `₹`. For a column that carries the symbol in its header. */
  symbol?: boolean;
  /** Render `0` as this string instead of `₹0`. `null` keeps `₹0`. */
  zeroLabel?: string | null;
}

/** True for a safe integer. Rejects `NaN`, `Infinity` and any fraction. */
export function isValidPaise(value: unknown): value is Paise {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

/**
 * `20000` → `"₹200"`, `1` → `"₹0.01"`, `10000000` → `"₹1,00,000"`.
 *
 * A non-integer or non-finite input returns `"—"` rather than throwing: this is
 * called from render, and a corrupt number must not blank a tournament page.
 */
export function formatPaise(paise: Paise, options: MoneyFormatOptions = {}): string {
  const { showPaise = false, symbol = true, zeroLabel = null } = options;

  if (!isValidPaise(paise)) return '—';
  if (paise === 0 && zeroLabel !== null) return zeroLabel;

  const negative = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.trunc(abs / PAISE_PER_RUPEE);
  const remainder = abs % PAISE_PER_RUPEE;

  let body = GROUP.format(rupees);
  if (remainder !== 0 || showPaise) {
    body += `.${String(remainder).padStart(2, '0')}`;
  }

  return `${negative ? '-' : ''}${symbol ? RUPEE : ''}${body}`;
}

/**
 * The player-facing fee line: `0` is **"Free"**, not `₹0`. IA.md's tournament
 * card and CONTENT.md §10 both say the word, and "₹0 entry" reads like a bug.
 */
export function formatFee(paise: Paise): string {
  return formatPaise(paise, { zeroLabel: 'Free' });
}

/**
 * Prize pool. `0` renders as `null` so the caller can drop the whole row —
 * a "Prize pool ₹0" line is worse than no line (IA.md §7.1's null-stat rule
 * applied to money).
 */
export function formatPrizePool(paise: Paise): string | null {
  if (!isValidPaise(paise) || paise <= 0) return null;
  return formatPaise(paise);
}

/**
 * Compact form for a badge where the full number will not fit: `₹1.5L`,
 * `₹10K`. Only ever used where the exact figure is also on the page — a prize
 * table never rounds.
 */
export function formatPaiseCompact(paise: Paise): string {
  if (!isValidPaise(paise)) return '—';
  const negative = paise < 0;
  const rupees = Math.trunc(Math.abs(paise) / PAISE_PER_RUPEE);
  const sign = negative ? '-' : '';

  // Integer arithmetic throughout: one decimal place is produced by scaling by
  // 10 and splitting, never by dividing into a float.
  const scaled = (value: number, unit: number, suffix: string): string => {
    const tenths = Math.round((value * 10) / unit);
    const whole = Math.trunc(tenths / 10);
    const frac = tenths % 10;
    return `${sign}${RUPEE}${GROUP.format(whole)}${frac === 0 ? '' : `.${frac}`}${suffix}`;
  };

  if (rupees >= 10_000_000) return scaled(rupees, 10_000_000, 'Cr');
  if (rupees >= 100_000) return scaled(rupees, 100_000, 'L');
  if (rupees >= 10_000) return scaled(rupees, 1_000, 'K');
  return formatPaise(paise);
}

/** `content/games.json` authors fees in whole rupees; D1 stores paise (CONTENT.md §2.5). */
export function rupeesToPaise(rupees: number): Paise {
  if (!Number.isFinite(rupees)) return 0;
  return Math.round(rupees * PAISE_PER_RUPEE);
}

/** Exact only. Returns `null` when there is a paise remainder, so a caller cannot silently drop it. */
export function paiseToWholeRupees(paise: Paise): number | null {
  if (!isValidPaise(paise)) return null;
  return paise % PAISE_PER_RUPEE === 0 ? paise / PAISE_PER_RUPEE : null;
}

/**
 * Organizer form input → paise, without ever building a float.
 *
 * Accepts `200`, `₹200`, `1,00,000`, `200.5`, `200.50`, ` 200 `. Rejects
 * anything else (including `1e3` and `200.505`) with `null`, so the form can
 * say why instead of writing 0 into a fee column.
 */
export function parseRupeesToPaise(input: string): Paise | null {
  const cleaned = input.trim().replace(RUPEE, '').replace(/[\s,]/g, '');
  if (cleaned === '') return null;

  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;

  const [, sign, whole, frac] = match;
  if (whole === undefined) return null;

  const rupees = Number(whole);
  if (!Number.isSafeInteger(rupees)) return null;

  const paisePart = frac === undefined ? 0 : Number(frac.padEnd(2, '0'));
  const total = rupees * PAISE_PER_RUPEE + paisePart;
  if (!Number.isSafeInteger(total)) return null;

  return sign === '-' ? -total : total;
}
