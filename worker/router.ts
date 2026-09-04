/**
 * PLACEHOLDER — W2 owns this file (BUILD-PLAN.md ownership map). It exists at the
 * end of Phase 0 for one reason: the five `worker/api/<area>/routes.ts` placeholders
 * (the glob form of that path cannot be written here — its `*` + `/` closes the
 * block comment and silently reparses the rest of the file as code)
 * declare `export const routes: Route[] = []` and import `Route` from here, so
 * without it `tsc -p worker/tsconfig.json` reports five unresolved-module errors
 * and the foundation's typecheck gate cannot be green — which BUILD-PLAN.md
 * Phase 0 rule 1 requires it to be before any parallel stream starts.
 *
 * What is fixed here is the SHAPE the five route modules are already written
 * against. What is deliberately absent is the dispatch: `matchRoute` is the
 * ordered first-match-wins table of API.md Appendix C, and building it is W2's
 * job alongside `worker/index.ts`. W2 replaces the body below; it should not
 * need to change `Route`'s field names, because five files already reference
 * them.
 *
 * Matching is on `(method, segment count, literal segments)` — NOT a regex
 * chain. API.md Appendix C calls this out as the classic bug in this table:
 * `/tournaments/:slug/register` must be tested before `/tournaments/:slug`, and
 * `DELETE /me/sessions` before `DELETE /me/sessions/:id`. A regex chain makes
 * that ordering invisible; a segment table makes a mis-ordering a two-line diff.
 */

import type { Env } from './lib/env';

/** The methods the API answers on. `HEAD` is served by the `GET` route (Appendix A step 8). */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * One `:param` segment's captured value, keyed by the name in the pattern.
 * Always a single path segment — Appendix C states `:param` never spans a slash,
 * which is what lets the matcher compare segment COUNTS before anything else.
 */
export type RouteParams = Readonly<Record<string, string>>;

/**
 * Everything a handler is given. Assembled once per request by `worker/index.ts`
 * so that one request has one clock and one id: `now` is not re-read per handler
 * because two `Date.now()` calls inside one response can straddle a second
 * boundary and make an ETag disagree with the `X-NC-Now` beside it.
 *
 * The auth-bearing fields are deliberately NOT declared here. Step 5 of the
 * dispatch evaluates a route's `predicate` (AUTH.md §7.2) before the handler
 * runs, and W3 owns the session type; adding a `session` field now would fix its
 * shape from the wrong file. W2 widens this interface when W3's type lands.
 */
export interface RouteContext {
  readonly request: Request;
  readonly env: Env;
  readonly ctx: ExecutionContext;
  readonly url: URL;
  /** Captured `:param` values, in the pattern's own naming. */
  readonly params: RouteParams;
  /** The ULID minted at dispatch step 0 and echoed as `X-Request-Id`. */
  readonly requestId: string;
  /** Unix SECONDS, read once per request. Also stamped as `X-NC-Now`. */
  readonly now: number;
}

export type RouteHandler = (ctx: RouteContext) => Promise<Response> | Response;

/**
 * A single row of the Appendix C table.
 *
 * `pattern` is the path WITHOUT the `/api/v1` prefix and without a trailing
 * slash — the API is the one part of the site that does not use `trailingSlash`,
 * because a JSON client that guesses wrong should get the response rather than a
 * redirect it may not follow with its method intact.
 */
export interface Route {
  readonly method: HttpMethod;
  /** e.g. `/tournaments/:slug/bracket`. Order in the array is significant. */
  readonly pattern: string;
  readonly handler: RouteHandler;
  /**
   * The rate-limit binding to charge before the handler runs (Appendix A step
   * 5a). Named rather than bound so a route module never imports `env`.
   */
  readonly rateLimit?: keyof Env & `RL_${string}`;
  /** Free-text note for the route table dump; not used at runtime. */
  readonly note?: string;
}

/**
 * NOT IMPLEMENTED — W2. Present so a caller written today compiles; it must not
 * be treated as a working matcher. Returning `null` here means `worker/index.ts`
 * answers every `/api/` path with `404 not_found` in the standard envelope,
 * which is the correct behaviour for an API whose handlers have not landed yet
 * (BUILD-PLAN.md Phase 0: "an unimplemented section of the API is a 404 ... rather
 * than a build error").
 */
export function matchRoute(
  _routes: readonly Route[],
  _method: string,
  _pathname: string,
): { route: Route; params: RouteParams } | null {
  return null;
}
