/**
 * Barrel for the display layer. ARCHITECTURE.md §4: `lib/format` is
 * isomorphic — it runs in the browser and in workerd, does no I/O, and imports
 * nothing but `lib/types` and `lib/content`.
 *
 * The one thing it must never do is leak into `lib/bracket`, which does not
 * format or collate at all (§4 rule 1).
 */

export * from './datetime';
export * from './money';
export * from './share';
