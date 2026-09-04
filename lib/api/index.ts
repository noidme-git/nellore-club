/**
 * Barrel for the HTTP client. ARCHITECTURE.md §4: `lib/api` imports `lib/types`
 * and nothing else, and `components/ui/**` never imports this module at all —
 * a primitive that fetches cannot be rendered in a unit test, from a fixture,
 * or on the print sheet.
 */

export * from './client';
export * from './endpoints';
