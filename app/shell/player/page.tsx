/**
 * `/shell/player/index.html` — the single prerendered document behind every
 * `/p/<handle>/` URL (IA.md §2.2).
 *
 * PLACEHOLDER. W8 owns the body of this route; the `<head>` tag set below is
 * foundation-owned and must survive that rewrite.
 *
 * Everything in the header comment of `app/shell/tournament/page.tsx` applies
 * here identically — the Worker's `HTMLRewriter` replaces attributes and never
 * appends, so a tag missing from this file never appears in a shared profile
 * link; this route exports no `metadata`; and `app/layout.tsx` sets no title, so
 * the `<title id="nc-title">` below is the document's only one.
 *
 * The one difference is the default `og:image`: a shared profile falls back to
 * `/og/player.png` rather than the club's default card (DESIGN.md §10, IA.md §10).
 */
export default function PlayerShell() {
  return (
    <>
      <title id="nc-title">nellore.club</title>
      <meta id="nc-desc" name="description" content="Game tournaments in Nellore." />
      <meta id="nc-og-title" property="og:title" content="nellore.club" />
      <meta id="nc-og-desc" property="og:description" content="Game tournaments in Nellore." />
      <meta id="nc-og-image" property="og:image" content="https://nellore.club/og/player.png" />
      <meta id="nc-og-url" property="og:url" content="https://nellore.club/" />
      <link id="nc-canonical" rel="canonical" href="https://nellore.club/" />

      <meta property="og:type" content="website" />
      <meta property="og:site_name" content="nellore.club" />
      <meta property="og:locale" content="en_IN" />
      <meta property="og:image:width" content="1200" />
      <meta property="og:image:height" content="630" />
      <meta property="og:image:alt" content="nellore.club — game tournaments in Nellore" />
      <meta name="twitter:card" content="summary_large_image" />

      {/* `{}` rather than a populated stub — see the note in the tournament shell. */}
      <script id="nc-jsonld" type="application/ld+json">
        {'{}'}
      </script>

      <div id="nc-shell-root" data-nc-shell="player" />

      <noscript>
        <div className="mx-auto max-w-app px-6 py-16 text-center">
          <h1 className="text-2xl font-bold text-fg">This page needs JavaScript</h1>
          <p className="mx-auto mt-3 max-w-prose text-sm text-fg-muted">
            A player&rsquo;s results and ranking are fetched as they change, so this page cannot be shown without
            JavaScript.
          </p>
        </div>
      </noscript>
    </>
  );
}
