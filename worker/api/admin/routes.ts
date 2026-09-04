/**
 * PLACEHOLDER — W5 — the club-admin surface: games, users, sessions, audit, club content,
 * stats, leaderboard recompute, redirects, cache purge, venues and seasons
 * (API.md §5).
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
