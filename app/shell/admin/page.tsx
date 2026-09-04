/**
 * `/shell/admin/index.html` — the single prerendered document behind every
 * `/admin/**` URL (IA.md §2.2).
 *
 * PLACEHOLDER. W9 owns the body of this route.
 *
 * ── THIS SHELL DELIBERATELY SHIPS NO META TAGS AT ALL
 *
 * Not a `<title>`, not an `og:*`, not a canonical, not a JSON-LD block. The
 * Worker serves `/admin/**` with `no-inject`, `X-Robots-Tag: noindex` and
 * `Cache-Control: private, no-store` (IA.md §2.2, §4): every byte on these
 * screens is authenticated, so there is nothing a link preview could honestly
 * say and nothing for `HTMLRewriter` to replace.
 *
 * That absence is also a build-time canary. `scripts/csp-hashes.mjs` asserts this
 * document contains ZERO `<title>` elements and zero `nc-*` ids — so if anyone
 * ever re-adds a `title` to `app/layout.tsx` (the IA.md §4.0 failure that gives
 * the tournament shell two `<title>`s and WhatsApp a coin flip), it shows up here
 * first, as a failed build, instead of in a link preview that is cached for days.
 *
 * There is no `<noscript>` fallback either: an organiser scoring a live final
 * needs the app, and a message telling them to enable JavaScript on the admin
 * screen would be the only thing a signed-out crawler ever saw.
 */
export default function AdminShell() {
  return <div id="nc-shell-root" data-nc-shell="admin" />;
}
