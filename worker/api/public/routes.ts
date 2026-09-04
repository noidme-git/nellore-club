/**
 * PLACEHOLDER — W4 — the public read API (API.md §1). Every route here answers identically
 * for an anonymous request and for a signed-in admin's request; that invariant is
 * the load-bearing one in the whole module.
 *
 * The foundation ships this file empty and COMPILING so that `worker/router.ts`
 * can import and concatenate the five route modules by name from day one
 * (BUILD-PLAN.md Phase 0). Nothing "cannot start because the file does not exist
 * yet", and an unimplemented section of the API is a `404 not_found` in the
 * standard error envelope rather than a build error.
 *
 * The owning workstream replaces the array below; it does not replace the export
 * name or its type. Route ORDER inside the array is significant — the router
 * matches top to bottom and the first match wins (API.md Appendix C).
 */

import type { Route } from '../../router';

export const routes: Route[] = [];
