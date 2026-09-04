/**
 * `/shell/tournament/index.html` — the single prerendered document behind every
 * `/t/<slug>/**` URL (IA.md §2.2).
 *
 * PLACEHOLDER. W7 owns the body of this route and writes the actual SPA; the
 * `<head>` tag set below is foundation-owned and must survive that rewrite.
 *
 * ── WHY THESE TAGS ARE HERE AND NOT IN A `metadata` EXPORT
 *
 * The Worker streams this asset through `HTMLRewriter` and **replaces the
 * attributes of existing elements — it never appends** (API.md §8.6). A tag that
 * is missing from this file therefore never appears in the shared link preview,
 * silently, and only in the crawler. So the set below is complete and every
 * element the rewriter targets by id carries its `nc-*` id.
 *
 * This route exports NO `metadata` and no `generateMetadata` (IA.md §4.0 rule 1):
 * Next's Metadata API cannot set an element `id`, so it cannot produce these
 * tags, and using it as well as these would emit a SECOND `<title>` — the
 * rewriter would update one of the two and WhatsApp would pick between them,
 * then cache the answer for days. `app/layout.tsx` therefore also sets no title,
 * and `scripts/csp-hashes.mjs` fails the build if this document ever contains
 * more than one of any of these elements.
 *
 * React 19 hoists `<title>`, `<meta>` and `<link>` rendered anywhere in the tree
 * into `<head>`, which is what makes the id'd form possible at all.
 *
 * ── THE VALUES
 *
 * These are the fallbacks a request keeps when the D1 read fails, times out, or
 * the slug is unknown (IA.md §4 rule 3/5: serve the shell unmodified, still 200 —
 * a 404 makes WhatsApp render no preview at all and the sharer assumes the link
 * is broken). So they have to read as a sane generic club preview on their own.
 * Absolute URLs, because a crawler resolves `og:image` against nothing.
 */
export default function TournamentShell() {
  return (
    <>
      <title id="nc-title">nellore.club</title>
      <meta id="nc-desc" name="description" content="Game tournaments in Nellore." />
      <meta id="nc-og-title" property="og:title" content="nellore.club" />
      <meta id="nc-og-desc" property="og:description" content="Game tournaments in Nellore." />
      <meta id="nc-og-image" property="og:image" content="https://nellore.club/og/default.png" />
      <meta id="nc-og-url" property="og:url" content="https://nellore.club/" />
      <link id="nc-canonical" rel="canonical" href="https://nellore.club/" />

      {/*
        Constant for every tournament, so the rewriter targets them by attribute
        rather than by id — but they still have to EXIST here, for the same
        never-appends reason as everything above. DESIGN.md §10, API.md §8.6.
      */}
      <meta property="og:type" content="website" />
      <meta property="og:site_name" content="nellore.club" />
      <meta property="og:locale" content="en_IN" />
      <meta property="og:image:width" content="1200" />
      <meta property="og:image:height" content="630" />
      <meta property="og:image:alt" content="nellore.club — game tournaments in Nellore" />
      <meta name="twitter:card" content="summary_large_image" />

      {/*
        The one `<script>` the rewriter touches (API.md §8.6, SECURITY.md §8.1
        point 4). Its build-time sha256 is in worker/csp-hashes.json; on a request
        that injects a real SportsEvent block the Worker hashes the exact bytes it
        is about to write and appends that source to this response's `script-src`.

        The body is `{}` and not IA.md §4's illustrative
        `{"@context":"https://schema.org"}` for a mechanical reason: React 19 runs
        a script element's text children through its HTML escaper (the same
        constraint that forces the theme bootstrap in app/layout.tsx to use
        dangerouslySetInnerHTML), so every `"` here would be emitted as `&quot;`.
        Script content is raw text to the HTML parser — entities are NOT decoded —
        so the shipped placeholder would be invalid JSON on exactly the requests
        where the rewriter left it alone. `{}` contains no character React
        escapes, and an empty JSON-LD object is valid and simply ignored.
      */}
      <script id="nc-jsonld" type="application/ld+json">
        {'{}'}
      </script>

      {/*
        The mount point. W7 replaces this with the real shell; the id is the
        contract in the meantime.
      */}
      <div id="nc-shell-root" data-nc-shell="tournament" />

      <noscript>
        <div className="mx-auto max-w-app px-6 py-16 text-center">
          <h1 className="text-2xl font-bold text-fg">This page needs JavaScript</h1>
          <p className="mx-auto mt-3 max-w-prose text-sm text-fg-muted">
            Live brackets, scores and check-in are fetched as they change, so this page cannot be shown without
            JavaScript. The printed pack at the venue carries the same fixtures.
          </p>
        </div>
      </noscript>
    </>
  );
}
