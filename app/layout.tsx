import type { Viewport } from 'next';

import './globals.css';

/**
 * The root layout: `<html lang="en">`, the font preload, the theme bootstrap,
 * the skip link, the four landmarks, and the route-change announce region.
 *
 * ── THE RULE THAT IS INVISIBLE LOCALLY AND ONLY FAILS IN THE WHATSAPP CRAWLER
 *
 * This file exports NO `metadata` and sets NO `title`, `description` or
 * `openGraph` default — not even a `title.template` (IA.md §4.0, BUILD-PLAN.md
 * Phase 0). Next's Metadata API cannot put an `id` on the tags it emits, and it
 * emits the layout's `<title>` on EVERY page including the three shells. The
 * shells render their own id'd `<title id="nc-title">` in the component tree
 * (React 19 hoists it into `<head>`), so a layout title would give every
 * `/t/<slug>/` document TWO `<title>` elements. The Worker's `HTMLRewriter`
 * rewrites the one matching `#nc-title`; which one the WhatsApp crawler reads is
 * a coin flip that it then caches for days with no purge API — and `curl` looks
 * fine, so it does not reproduce locally. `scripts/csp-hashes.mjs` fails the
 * build if a title ever reappears here.
 *
 * `viewport` is a SEPARATE export from `metadata` and is deliberately kept: it
 * emits `<meta name="viewport">`, `<meta name="color-scheme">` and the two
 * `theme-color` tags, none of which the rewriter touches and all of which every
 * page needs identically. Keeping it here is also what stops Next emitting its
 * own default viewport tag alongside a hand-written one.
 *
 * ── ZERO CLIENT JS IN THE GLOBAL CHROME
 *
 * Nothing below is a client component. The header, footer and bottom tab bar are
 * static markup, and every link in them is a plain `<a href>` rather than
 * `<Link>`. That is not laziness on two counts:
 *
 *   1. This layout also wraps `app/shell/**`. A `<Link>` rendered inside a
 *      document served at `/t/<slug>/` prefetches an RSC payload that does not
 *      exist for a Worker-rewritten URL (ARCHITECTURE.md §4 rule 7, IA.md
 *      §2.2.1), so the chrome would fire a miss per link per shell view.
 *   2. DESIGN.md §9.1 makes the measured framework floor a blocking gate. Chrome
 *      that hydrates on every page spends the allowance every route has to share.
 *
 * The cost is that the nav cannot mark its current destination — a server layout
 * is not told the pathname, and the alternative (making this file `'use client'`)
 * forfeits the `viewport` export above. So the nav deliberately indicates NO
 * selection rather than indicating one wrongly: there is no `aria-current` and no
 * active styling, which is a conforming (if plainer) navigation. The active
 * state of DESIGN.md §6.17 and the theme/language toggles of §6.18 need a small
 * client island under `components/ui/`; see the return note from this workstream.
 */

/**
 * DESIGN.md §2.1, verbatim, and the ONE `dangerouslySetInnerHTML` in the
 * codebase (ARCHITECTURE.md §4 rule 5).
 *
 * It must be a blocking inline script: `public/theme.js` costs a render-blocking
 * round trip (~400 ms RTT on the target network) on every cold view, and
 * dropping it gives every dark-mode user a white flash on every navigation.
 * `<script>{'…'}</script>` is not an option — React 19 runs a script's text
 * children through its HTML escaper, so `&&`, `<` and the quotes would come out
 * as entities and the script would be a syntax error.
 *
 * It is a compile-time string literal with NO interpolation. `scripts/csp-hashes.mjs`
 * asserts these exact bytes appear in this file, that this file contains exactly
 * one `dangerouslySetInnerHTML`, and that the snippet's sha256 is present in
 * EVERY page's hash list in worker/csp-hashes.json — a page missing it is a
 * build failure rather than a runtime flash.
 */
const THEME_BOOTSTRAP =
  "try{var t=localStorage.getItem('nc:v1:theme');if(t!=='dark'&&t!=='light'){t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'}document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme='dark'}";

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Required for `env(safe-area-inset-bottom)` to report a non-zero value, which
  // is what the `bottombar` and `safe-b` spacing tokens are built on. Without it
  // the fixed bottom tab bar sits on top of the iOS home indicator.
  viewportFit: 'cover',
  // Form controls, scrollbars and the UA's own widgets follow the theme.
  // globals.css also sets `color-scheme` per theme; this is the pre-CSS value.
  colorScheme: 'dark light',
  // DESIGN.md §10. A meta tag cannot read localStorage, so the media queries are
  // the best available approximation of the theme the bootstrap will pick.
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0B0F14' },
    { media: '(prefers-color-scheme: light)', color: '#FFFFFF' },
  ],
};

/** Header nav (≥768px) and the bottom tab bar (<768px) — IA.md §3.1. */
const DESTINATIONS = [
  { href: '/', label: 'Home' },
  { href: '/tournaments/', label: 'Play' },
  { href: '/live/', label: 'Live' },
  { href: '/leaderboard/', label: 'Ranks' },
  { href: '/me/', label: 'Me' },
] as const;

/* -----------------------------------------------------------------------------
 * Icons.
 *
 * DESIGN.md §7: hand-rolled inline SVG, no icon package, no sprite sheet. These
 * five are inlined here rather than imported from `components/ui/icons.tsx`
 * because the chrome is server-rendered on every page in the product and must
 * not pull a client module in behind it.
 * -------------------------------------------------------------------------- */

const TAB_ICON_PATHS: Record<string, string> = {
  '/': 'M3 10.5 12 3.5l9 7M5.6 9.3V19a1 1 0 0 0 1 1h3.4v-5.5h4V20h3.4a1 1 0 0 0 1-1V9.3',
  '/tournaments/': 'M3.6 6h.01M3.6 12h.01M3.6 18h.01M8 6h12.4M8 12h12.4M8 18h12.4',
  '/live/': 'M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8M9.2 9.2a4.5 4.5 0 0 0 0 5.6M14.8 9.2a4.5 4.5 0 0 1 0 5.6',
  '/leaderboard/': 'M8 4h8v4.5a4 4 0 0 1-8 0zM8 5.2H5.6a2.4 2.4 0 0 0 0 4.8H8M16 5.2h2.4a2.4 2.4 0 0 1 0 4.8H16M12 12.5V17M9 20.5h6',
  '/me/': 'M12 11.5a3.75 3.75 0 1 0 0-7.5 3.75 3.75 0 0 0 0 7.5ZM4.75 20a7.25 7.25 0 0 1 14.5 0',
};

function TabIcon({ href }: { href: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={TAB_ICON_PATHS[href] ?? ''} />
      {href === '/live/' ? <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" /> : null}
    </svg>
  );
}

const FOOTER_COLUMNS = [
  {
    heading: 'Club',
    links: [
      { href: '/about/', label: 'About' },
      { href: '/venue/', label: 'Venue' },
      { href: '/code-of-conduct/', label: 'Code of conduct' },
    ],
  },
  {
    heading: 'Play',
    links: [
      { href: '/tournaments/', label: 'Tournaments' },
      { href: '/live/', label: 'Live' },
      { href: '/leaderboard/', label: 'Leaderboard' },
      { href: '/games/', label: 'Games' },
    ],
  },
  {
    heading: 'Legal',
    links: [
      { href: '/privacy/', label: 'Privacy' },
      { href: '/terms/', label: 'Terms' },
      { href: '/refunds/', label: 'Refunds' },
      { href: '/fair-play/', label: 'Fair play' },
      // WCAG 2.2 §3.2.6 Consistent Help: the LAST item of the LAST column, on
      // every page, pointing at the club's WhatsApp number and venue address.
      { href: '/contact/', label: 'Help' },
    ],
  },
] as const;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // `suppressHydrationWarning` because THEME_BOOTSTRAP writes `data-theme` onto
    // this element before React ever runs; without it every page logs a
    // hydration mismatch for an attribute that is supposed to differ.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
          The only font we preload (DESIGN.md §3.2). `crossOrigin` is mandatory
          even same-origin: fonts are fetched in CORS mode, and a preload without
          it is fetched twice — the second time being the one that actually gets
          used.
        */}
        <link rel="preload" href="/fonts/inter-var-subset.woff2" as="font" type="font/woff2" crossOrigin="" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      {/*
        The bottom padding clears the fixed tab bar so the footer and the last
        focusable control are never underneath it (DESIGN.md §6.17; the matching
        `scroll-padding-bottom` is in globals.css).
      */}
      <body className="flex min-h-dvh flex-col pb-[calc(56px+env(safe-area-inset-bottom)+16px)] md:pb-0">
        {/*
          The first focusable element on every page (IA.md §8.1). It is hidden by
          `.nc-sr-only` until focused, at which point the `focus:` utilities pull
          it back into the document flow as a real, visible control.
        */}
        <a
          href="#main"
          className="nc-focus sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 focus:inline-flex focus:h-touch focus:items-center focus:rounded-md focus:border focus:border-line-strong focus:bg-surface-2 focus:px-4 focus:text-sm focus:font-semibold focus:text-fg"
        >
          Skip to content
        </a>

        {/*
          No `backdrop-blur`: it is the single most expensive effect on mid-range
          Android GPUs and it makes a sticky header stutter on scroll
          (globals.css, DESIGN.md §6.17). Sticky surfaces here are opaque.
        */}
        <header className="sticky top-0 z-30 h-header border-b border-line bg-surface md:h-header-lg">
          <div className="mx-auto flex h-full max-w-app items-center gap-2 px-4">
            <a
              href="/"
              className="nc-focus -ml-2 flex min-h-touch items-center rounded-md px-2 text-lg font-extrabold tracking-[-0.02em] text-fg"
            >
              {/*
                DESIGN.md §3.1 specifies the wordmark as SVG outlines so it is
                pixel-identical before Inter loads. That asset does not exist yet;
                until it does this renders as text, which the metric-matched
                fallback face keeps from shifting on swap.
              */}
              nellore<span className="text-brand">.club</span>
            </a>

            <nav aria-label="Primary" className="ml-2 hidden items-center gap-1 md:flex">
              {DESTINATIONS.map((d) => (
                <a
                  key={d.href}
                  href={d.href}
                  className="nc-focus flex min-h-touch items-center rounded-md px-3 text-sm font-semibold text-fg-muted hover:text-fg"
                >
                  {d.label}
                </a>
              ))}
            </nav>

            <div className="ml-auto flex items-center gap-1">
              <a
                href="/search/"
                aria-label="Search"
                className="nc-focus flex h-touch w-touch items-center justify-center rounded-md text-fg-muted hover:text-fg"
              >
                <svg
                  viewBox="0 0 24 24"
                  width="22"
                  height="22"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <circle cx="11" cy="11" r="6.25" />
                  <path d="m20 20-4.4-4.4" />
                </svg>
              </a>
              <a
                href="/me/"
                className="nc-focus flex min-h-touch items-center rounded-md px-3 text-sm font-semibold text-fg-muted hover:text-fg"
              >
                Account
              </a>
            </div>
          </div>
        </header>

        {/*
          `tabIndex={-1}` is what makes the skip link actually move focus rather
          than only scroll (IA.md §8.1). It is never in the tab order.
        */}
        <main id="main" tabIndex={-1} className="nc-focus flex-1">
          {children}
        </main>

        <footer className="mt-16 border-t border-line bg-surface">
          <div className="mx-auto grid max-w-app gap-8 px-4 py-10 sm:grid-cols-3">
            {FOOTER_COLUMNS.map((column) => (
              <div key={column.heading}>
                <h2 className="text-2xs uppercase text-fg-faint">{column.heading}</h2>
                <ul className="mt-2">
                  {column.links.map((link) => (
                    <li key={link.href}>
                      {/* `py-2` is what turns a 20px line of text into a 44px target. */}
                      <a href={link.href} className="nc-focus block py-2 text-sm text-fg-muted hover:text-fg">
                        {link.label}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <div className="mx-auto max-w-app px-4 pb-10 text-xs text-fg-faint">
            © 2026 nellore.club · Nellore, Andhra Pradesh
          </div>
        </footer>

        {/*
          IA.md §3.1. Icon AND an always-visible 11px label: this audience spans a
          19-year-old and a 45-year-old carrom player, and unlabelled glyphs fail
          the second group. Rendered after the footer so the tab order ends here,
          which matches where it sits on screen.
        */}
        <nav
          aria-label="Sections"
          className="fixed inset-x-0 bottom-0 z-30 grid h-bottombar grid-cols-5 border-t border-line bg-surface pb-safe-b md:hidden"
        >
          {DESTINATIONS.map((d) => (
            <a
              key={d.href}
              href={d.href}
              className="nc-focus flex min-h-touch flex-col items-center justify-center gap-0.5 text-2xs text-fg-faint"
            >
              <TabIcon href={d.href} />
              {d.label}
            </a>
          ))}
        </nav>

        {/*
          IA.md §8.1 — the route-change announce region.
          A client-side route change is silent to a screen reader, so the SPA
          routers under `app/shell/**` (lib/router) write the new page title into
          this node and move focus to the new view's `<h1>` with
          `tabindex="-1"` + `focus({ preventScroll: true })`.
          It lives in the layout because the region has to be in the DOM BEFORE
          the text is written into it — a live region created and populated in the
          same tick is not announced by any screen reader.
          Every prerendered page navigates with a full document load (see the file
          header on why the chrome uses plain `<a>`), where the browser announces
          and moves focus natively; this region is inert on those pages.
        */}
        <div id="nc-route-announce" role="status" aria-live="polite" aria-atomic="true" className="nc-sr-only" />
      </body>
    </html>
  );
}
