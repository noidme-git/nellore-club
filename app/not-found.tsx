import type { Metadata } from 'next';

/**
 * `/404/` — prerendered to `out/404.html` and served by Workers Static Assets
 * under `not_found_handling: "404-page"` (IA.md §1.1, §2.1).
 *
 * It is reached by far more than a typo'd URL: every `/shell/**` request (Worker
 * dispatch step 7), every path whose slug or handle fails its regex (step 10),
 * and every unmatched asset (step 12) lands here. So it is a real screen, not a
 * placeholder, and it must be useful with JavaScript disabled — it has no data
 * behind it and no state to load.
 *
 * IA.md §7.2's rule for empty states applies: a dead end is a bug. Every route
 * offered below is a prerendered page, so all three work offline from the
 * service-worker cache.
 *
 * Unlike an unknown tournament slug — which returns 200 so WhatsApp still
 * renders a preview (IA.md §4 rule 5) — this document is served with a real 404
 * status by the Worker.
 */
export const metadata: Metadata = {
  title: 'Page not found · nellore.club',
  description: 'That page does not exist. Browse tournaments, or search for a team or player.',
  // No `robots` key: Next already emits `<meta name="robots" content="noindex">`
  // on this route, and adding one produces two robots tags in the document.
};

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-app flex-col items-center px-6 py-16 text-center">
      <p className="text-2xs uppercase text-fg-faint">Error 404</p>
      <h1 className="mt-2 text-2xl font-bold text-fg">This page doesn&rsquo;t exist</h1>
      <p className="mt-3 max-w-[36ch] text-sm text-fg-muted">
        The link may be mistyped, or the tournament it pointed at may have been renamed. Nothing here is lost —
        start from one of these.
      </p>

      {/*
        Plain `<a>`, not `<Link>`: this document is also what the Worker serves
        for a rewritten URL that failed its pattern, so there is no client router
        in the page to hand the navigation to (ARCHITECTURE.md §4 rule 7).
      */}
      <div className="mt-8 flex w-full max-w-sheet flex-col gap-3">
        <a
          href="/tournaments/"
          className="nc-focus flex min-h-touch items-center justify-center rounded-md bg-brand-fill px-5 text-sm font-bold text-on-brand"
        >
          Browse tournaments
        </a>
        <a
          href="/search/"
          className="nc-focus flex min-h-touch items-center justify-center rounded-md border border-line-strong px-5 text-sm font-semibold text-fg"
        >
          Search
        </a>
        <a
          href="/"
          className="nc-focus flex min-h-touch items-center justify-center rounded-md px-5 text-sm font-semibold text-fg-muted hover:text-fg"
        >
          Go to the home page
        </a>
      </div>
    </div>
  );
}
