/**
 * INTERIM Worker entrypoint — replaced by W2.
 *
 * BUILD-PLAN.md assigns worker/index.ts to W2, which implements the full 13-step
 * dispatch of API.md Appendix A: rate limiting, the API router, HTMLRewriter meta
 * injection for link previews, per-page hash CSP, shortlink resolution and the
 * scheduled() cron. None of that exists yet.
 *
 * This file exists so the domain can serve the launch page today instead of a
 * GoDaddy parking record. It does exactly three things and deliberately no more:
 * serve static assets, attach security headers, and answer /api/v1/config so the
 * deploy is verifiable from the outside.
 *
 * What it deliberately does NOT do, so nobody mistakes it for the real thing:
 *   - No D1 access. The binding is declared in wrangler.jsonc and unused here.
 *   - No assertEnv(). The real dispatch fails startup on a missing pepper; this
 *     one touches no secret, so calling it would fail the deploy for no reason.
 *   - No rate limiting, no CSP hashes, no meta injection, no cron.
 *
 * When W2 lands, this file is overwritten wholesale. Nothing should import it.
 */

import type { Env } from './lib/env';

/**
 * Security headers, per SECURITY.md §8, minus the parts that need machinery that
 * does not exist yet.
 *
 * The CSP here is deliberately NOT the real one. The real policy is per-page and
 * hash-based, built from worker/csp-hashes.json, because the theme-bootstrap
 * script is inline and must be allowed by hash rather than by 'unsafe-inline'.
 * Emitting a permissive placeholder and calling it done is how a site ships with
 * a CSP that passes a scanner and stops nothing, so this one is restrictive and
 * page-agnostic: it has to tolerate any inline script the export emits, which is
 * exactly the limitation W2 removes.
 */
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

/** Paths the launch page has no business serving yet. */
const BLOCKED_PREFIXES = ['/shell/', '/admin/', '/kitchen-sink'];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Canonicalise to the apex. www and the workers.dev preview both resolve, and
    // two hostnames serving identical HTML splits link-preview caches and search
    // signals for no benefit.
    if (url.hostname === 'www.nellore.club') {
      url.hostname = 'nellore.club';
      return Response.redirect(url.toString(), 308);
    }

    // A liveness probe that does not touch D1, so it stays honest about what is
    // actually deployed rather than reporting the health of a database the
    // interim worker never reads.
    if (url.pathname === '/api/v1/config') {
      return json({
        ok: true,
        phase: 'launch-page',
        note: 'Interim worker. The tournament API is not deployed yet.',
        environment: env.ENVIRONMENT ?? null,
      });
    }

    // Every other /api/ path must fail loudly. Falling through to the asset
    // handler would return the 404 *page* — HTML, 200-shaped to a fetch() caller —
    // and a client written against the real API would parse it as a broken
    // envelope instead of seeing a clean "not deployed yet".
    if (url.pathname.startsWith('/api/')) {
      return json(
        { ok: false, error: { code: 'not_implemented', message: 'The tournament API is not deployed yet.' } },
        501,
      );
    }

    if (BLOCKED_PREFIXES.some((p) => url.pathname.startsWith(p))) {
      return withHeaders(await env.ASSETS.fetch(new Request(new URL('/404/', url), request)), 404);
    }

    return withHeaders(await env.ASSETS.fetch(request));
  },
} satisfies ExportedHandler<Env>;

function json(body: unknown, status = 200): Response {
  return withHeaders(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    }),
  );
}

function withHeaders(res: Response, overrideStatus?: number): Response {
  const out = new Response(res.body, {
    status: overrideStatus ?? res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);

  // A 404 must not be cached at the edge. optoads.com shipped a bug where a 404
  // inherited the success path's s-maxage and every subsequent visitor was served
  // the cached miss for the life of the TTL, including after the page existed.
  if (out.status >= 400) out.headers.set('Cache-Control', 'no-store');
  return out;
}
