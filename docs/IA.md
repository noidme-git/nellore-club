# nellore.club — Information Architecture, Routing & UX Flows

**Status:** design spec, authoritative. Implement literally.
**Owner of this doc:** IA/UX. It owns page URLs, the shells, navigation and the boot-injection
contract; where it disagreed with another document about a DB name, an enum or an API path, that
disagreement has been resolved in `docs/ARCHITECTURE.md` and this file corrected.
Sibling specs: `docs/ARCHITECTURE.md` (the tie-breaker), `docs/DESIGN.md` (visual system),
`docs/API.md`, `db/schema.sql`, `docs/AUTH.md`, `docs/BRACKET-ENGINE.md`.
**Timezone:** every human-facing time on this site is **IST (UTC+05:30)** and is rendered with an
explicit `IST` suffix. Storage is UTC epoch seconds. Never render a bare local time.
**Currency:** INR, rendered `₹1,500` (Indian digit grouping: `₹1,00,000` for a lakh).

---

## 0. The constraint that shapes everything

`output: 'export'` means **there is no page per tournament**. The build produces a fixed set of HTML
files with no knowledge of what is in D1. Everything that changes during a live event — the bracket,
the score, the registration count, the room code — arrives on the client via `fetch`.

Three consequences drive the whole IA:

1. **Dynamic URLs are Worker rewrites onto a small set of prerendered "shell" documents.**
   `/t/bgmi-diwali-cup/bracket/` and `/t/carrom-open-2026/standings/` are the *same* HTML file.
2. **A shell's raw HTML has no tournament in it**, so a naive implementation gives WhatsApp a
   generic link preview and gives the user a blank screen for 2 seconds on 4G. Both are fixed by
   the Worker's **`HTMLRewriter` boot-injection** (§4), not by prerendering.
3. **Every data-backed view must survive a failed fetch**, because the audience is on patchy 4G in a
   WhatsApp in-app WebView. "Spinner forever" is a bug, not a state. See §7.

---

## 1. URL scheme

These links get pasted into WhatsApp, read aloud over a phone, and printed on A4 posters taped to a
wall in Nellore. Design rules, in priority order:

| Rule | Why |
| --- | --- |
| Lowercase, hyphen-separated, ASCII only | Telugu in a URL percent-encodes into unreadable noise in a WhatsApp bubble. Slugs are transliterated Latin; the *display* name may be Telugu. |
| No query string in any shareable URL | WhatsApp truncates long links and some clients strip `?`. Every shareable state is a path. Filters (leaderboard, search) may use `?` because nobody shares a filtered leaderboard. |
| Short prefixes: `/t/`, `/p/`, `/j/`, `/i/`, `/m/` | `nellore.club/t/bgmi-diwali-cup/` is 38 chars and fits on one line in a WhatsApp preview card. `/tournaments/bgmi-diwali-cup/` does not. |
| Trailing slash always | `trailingSlash: true`; `html_handling: "auto-trailing-slash"` resolves it with no redirect. Emit canonical links with the slash. |
| Slugs are immutable once published | A slug change breaks every WhatsApp message already sent. Renaming a tournament keeps the slug; the Worker serves old slugs from the `slug_redirects` table with a 301. |
| Slug budget: ≤ 28 chars, ≤ 4 words | Enforced in the admin form with a live character counter. |

### 1.1 Canonical routes

```
/                                   home
/live/                              everything happening right now
/tournaments/                       all tournaments, filterable
/t/<slug>/                          tournament overview
/t/<slug>/bracket/                  bracket / points table / fixtures (format-dependent)
/t/<slug>/standings/                standings & results
/t/<slug>/teams/                    entrant list (teams or players)
/t/<slug>/schedule/                 fixtures by day, venue, timings
/t/<slug>/rules/                    rules, format, prize split, fair-play
/t/<slug>/m/<matchNo>/              one match, deep-linked
/t/<slug>/register/                 registration wizard
/t/<slug>/checkin/                  match-day check-in + room code
/t/<slug>/entry/                    a guest's own entry, opened from ?g=<guest_token>
/j/<code>/                          short join link -> 302 to /t/<slug>/register/
/i/<code>/                          roster invite link -> 302 to /t/<slug>/register/?invite=<code>
/games/                             game directory
/games/<gameSlug>/                  one game: what it is, past tournaments, leaderboard
/leaderboard/                       cross-tournament leaderboard
/p/<handle>/                        player profile
/search/                            search
/signin/                            sign in (passkey)
/join/                              create account (passkey)
/recover/                           recovery-code sign-in + re-enrol a passkey
/me/                                my dashboard
/me/registrations/                  my registrations & entry-fee status
/me/security/                       passkeys, sessions, recovery codes
/me/settings/                       display name, handle, language, notifications
/admin/                             organizer dashboard
/admin/t/new/                       create-tournament wizard
/admin/t/<slug>/                    manage one tournament
/admin/t/<slug>/registrations/      approve entrants, verify UPI payments (UTR)
/admin/t/<slug>/checkin/            match-day check-in desk
/admin/t/<slug>/seeding/            seed + generate bracket
/admin/t/<slug>/score/              LIVE SCORING (full-screen, phone-first)
/admin/t/<slug>/schedule/           assign venues/courts/time slots, publish room codes
/admin/t/<slug>/results/            publish results, prize/payout sheet
/admin/t/<slug>/audit/              audit log of every result change and dispute
/admin/t/<slug>/print/              printable offline pack: no JS, black and white
/admin/games/                       game catalogue (data-driven, no code changes)
/admin/people/                      players, bans, organizer roles
/about/  /venue/  /contact/  /code-of-conduct/  /fair-play/
/privacy/  /terms/  /refunds/
/offline/                           service-worker fallback document
/404/                               not found
```

### 1.2 Rejected URL alternatives

| Rejected | Why |
| --- | --- |
| `/tournament/<id>/` with a numeric id | Unreadable and unmemorable when read out loud at a venue. A slug is also a free SEO asset. |
| `/t/<slug>?tab=bracket` | The bracket is the single most-shared view. It must be a path so a WhatsApp forward lands on it. |
| A separate short-link domain (`nlr.cc`) | Second zone, second cert, second Worker, and the club's brand disappears from the shared link. `/j/<code>/` on the primary domain costs nothing and keeps `nellore.club` visible in the WhatsApp preview. |
| Prerendering one static page per tournament by querying D1 at build time (`generateStaticParams` over a `wrangler d1 execute --remote --json` dump) | Tempting: real static pages, real OG tags, instant LCP. Rejected because (a) the interesting data — bracket, scores, entrant count — is stale the moment it is built, so the client fetch runs anyway and the only win is the title; (b) it makes `wrangler deploy` depend on a successful remote D1 read from the owner's laptop on Indian broadband, turning a deploy into a two-system failure; (c) a tournament created after the last deploy would 404, which is the exact moment the link is being shared. The Worker's `HTMLRewriter` injection (§4) delivers the same OG/LCP win with zero staleness and zero build coupling. |

---

## 2. Sitemap: prerendered pages vs. Worker-rewritten shells

### 2.1 Prerendered static pages (real files in `out/`)

Every one of these is a genuine Next route with a real HTML file. Content that is not data-backed
(hero copy, rules text, game descriptions) is baked in and needs no JS.

| Route | File in `out/` | Audience | What it shows | Indexed |
| --- | --- | --- | --- | --- |
| `/` | `index.html` | public | Hero, "Live now" strip (`GET /api/v1/live`, first 3), next 6 tournaments (`GET /api/v1/tournaments?limit=6`), game grid (static, from `content/games.json` at build time), club stats strip (`GET /api/v1/config` → `counts`, with static fallback copy). **No admin-only endpoint feeds a public page** — `/api/v1/admin/stats` is not a source here. | yes |
| `/live/` | `live/index.html` | public | Every live tournament + every live match, auto-refreshing. The best WhatsApp share during an event. **One call: `GET /api/v1/live` (API.md §1.16)**, `Poll-After: 20`, capped at 50 matches. Not `/tournaments?status=live` followed by one `/bracket` per tournament — that is an N+1 on 4G on the page the design names as the best share during an event. | yes |
| `/tournaments/` | `tournaments/index.html` | public | Filterable list. Filters via `?game=&status=&category=&from=` | yes |
| `/games/` | `games/index.html` | public | 3 category sections, all game cards. Built at build time from `content/games.json`. | yes |
| `/games/<gameSlug>/` | `games/<slug>/index.html` | public | Prerendered per game via `generateStaticParams()` over `content/games.json`. Static description + rules; dynamic tournament list and leaderboard fetched. | yes |
| `/leaderboard/` | `leaderboard/index.html` | public | Cross-tournament ranking. Filters via `?game=&season=&category=` | yes |
| `/search/` | `search/index.html` | public | Query via `?q=`. Backed by **`GET /api/v1/search`** (API.md §1.16.1) — tournaments by title substring, players by **`handle` prefix only** (never `display_name`; a substring search over display names is a member-directory scrape), games matched client-side. `q` empty → recent + popular, which is that endpoint's empty-`q` response. `no-store`, debounced 300 ms, `limit ≤ 20` per type. | no |
| `/signin/` `/join/` `/recover/` | ... | public | Auth. Fully static; all logic client-side. | no |
| `/me/` and children | `me/**/index.html` | signed-in | Static shells, all data client-fetched. | no (`X-Robots-Tag: noindex` from Worker) |
| `/about/` `/venue/` `/contact/` `/code-of-conduct/` `/fair-play/` `/privacy/` `/terms/` `/refunds/` | ... | public | Pure content, zero JS needed. | yes |
| `/offline/` | `offline/index.html` | public | Service-worker navigation fallback. | no |
| `/404/` | `404.html` | public | `not_found_handling: "404-page"` | no |

> `/refunds/` is not optional. Entry fees are collected in INR; an Indian club taking money needs a
> stated refund/cancellation policy, and UPI disputes go there first.

### 2.2 Worker-rewritten SPA shells

Shells are real prerendered pages that live under `/shell/` and are **never linked**. The Worker
rewrites dynamic URLs onto them and returns a **404 for any direct request to `/shell/*`** so they
never appear in search results or get shared by accident.

| Shell asset | Rewritten from | Notes |
| --- | --- | --- |
| `/shell/tournament/index.html` | `/t/<slug>/`, `/t/<slug>/bracket/`, `/standings/`, `/teams/`, `/schedule/`, `/rules/`, `/m/<n>/`, `/register/`, `/checkin/`, `/entry/` | One document. The client router reads `location.pathname`, so all six tabs are one JS bundle and tab switches are instant with no network. Gets full `HTMLRewriter` boot-injection (§4). |
| `/shell/player/index.html` | `/p/<handle>/` | Boot-injects handle, display name, avatar seed, OG tags. |
| `/shell/admin/index.html` | `/admin/**` | `noindex`, `Cache-Control: private, no-store`. No boot-injection (all data is authenticated). |

**Rewrite table (Worker, in order).** The Worker matches on `URL.pathname` after normalising to a
trailing slash:

```
/j/<code>/                      -> 302 to /t/<slug>/register/     (D1 lookup on join_code)
/i/<code>/                      -> 302 to /t/<slug>/register/?invite=<code>
/t/<slug>/                      -> asset /shell/tournament/index.html   + inject
/t/<slug>/<tab>/                -> asset /shell/tournament/index.html   + inject
    where <tab> in { bracket, standings, teams, schedule, rules, register, checkin, entry }
/t/<slug>/m/<matchNo>/          -> asset /shell/tournament/index.html   + inject
/p/<handle>/                    -> asset /shell/player/index.html       + inject
/admin/**                       -> asset /shell/admin/index.html        (no inject, no-store)
/shell/**                       -> 404
/api/**                         -> API router (not assets)
everything else                 -> ASSETS.fetch()  (real prerendered page or 404 page)
```

`<slug>` matches `^[a-z0-9][a-z0-9-]{1,40}$`; `<handle>` matches `^[a-z0-9][a-z0-9_]{2,19}$`;
`<matchNo>` matches `^[0-9]{1,4}$`. Anything failing the pattern falls through to the 404 page.
**Do not** run the D1 lookup for a path whose slug fails the regex — that is a free DoS on the
subrequest budget.

### 2.2.1 The shell router is hand-rolled. `next/link` is forbidden inside a shell.

§2.2 promises that "all six tabs are one JS bundle and tab switches are instant with no network",
and §3.1 specifies the sub-tabs as "each tab is an `<a>` to a real URL". Those two are only
compatible under one implementation, and it is not the framework default — so it is stated
normatively here rather than left to whoever writes the component.

**Under `output: 'export'`, the Next App Router's client router resolves a navigation by fetching
the target route's RSC payload** (a `.txt` sibling, or `?_rsc=` on the same URL). For
`/t/<slug>/bracket/` the Worker either 404s the `.txt` — step 10's `<tab>` allowlist does not match
`index.txt` — or returns the injected HTML shell for the `?_rsc=` form. Neither is a valid RSC
payload, so the router falls back to a **full document load**: ~700 ms plus rehydration on Slow 4G,
on the single most-shared view in the product. And `<Link>` prefetches on viewport entry, so
`/tournaments/` rendering 20 tournament cards fires 20 RSC requests that all miss — 20 wasted Worker
invocations per listing view.

**Normative:**

1. Inside the three shells, navigation is a **hand-rolled `history.pushState` router**, living in
   `lib/router` and consumed by `components/data/`. Tabs are plain `<a href="/t/<slug>/bracket/">`
   with an intercepted `onClick` that calls `pushState` and updates state, plus a `popstate`
   listener for Back. The `<a href>` stays real so middle-click, long-press-open-in-new-tab, and
   a crawler all work.
2. **`next/link`, `next/navigation` (`useRouter`, `redirect`, `notFound`) and `next/router` are
   forbidden anywhere under `app/shell/**`.** Added to the `no-restricted-imports` list in
   `ARCHITECTURE.md` §4 rule 7, with a CI grep for `next/link` under `app/shell/` that fails the
   build.
3. **Any link *into* a rewritten URL (`/t/*`, `/p/*`, `/admin/*`) from a prerendered page is a plain
   `<a>`, never `<Link>`** — including every tournament card on `/`, `/tournaments/`, `/live/`,
   `/search/` and `/games/<slug>/`, and every player link on `/leaderboard/`. This is the rule that
   stops the prefetch storm. A `<Link>` between two *prerendered* pages is fine and is what Next is
   good at; it is the rewritten URLs that have no RSC payload to fetch.
4. The intercepted `onClick` bails out (letting the browser do a normal navigation) on
   `event.defaultPrevented`, a modifier key, `button !== 0`, a `target` attribute, or a
   cross-origin href. Getting that wrong is how "open in new tab" silently breaks.

### 2.3 Why one shell per entity type and not one global SPA shell

Rejected: a single `/shell/app/index.html` for everything. It would mean the tournament bundle, the
admin bundle and the profile bundle are one file, and the admin code (scoring UI, seeding, wizards —
the largest part of the app) would ship to every anonymous visitor who taps a WhatsApp link. Three
shells give Next three route entry points and therefore three independently code-split bundles, which
is how `/t/<slug>/` stays under the JS budget in `docs/DESIGN.md` §9.

---

## 3. Navigation model

### 3.1 Mobile (< 768px) — the primary target

**Top bar, 56px, sticky, `backdrop-blur-none` (blur is expensive on mid-range Android — use an
opaque `bg-surface` with a hairline bottom border instead).**

```
[ ◀ back? ]  [ nellore.club wordmark (SVG) ]            [ search ]  [ avatar | Sign in ]
```

- Back chevron appears only on depth-2+ routes (`/t/<slug>/m/<n>/`, `/me/security/`, admin detail
  screens) and calls `history.back()` with a fallback to the parent route when `history.length <= 1`
  (the WhatsApp WebView case — the user arrived with no history).
- The wordmark is a link to `/`. Tap target 44×44 minimum.

**Bottom tab bar, fixed, `56px + env(safe-area-inset-bottom)`.** Five destinations, **icon + always-
visible 11px label**. Icon-only navigation is rejected: this audience spans a 19-year-old and a
45-year-old carrom player, and unlabelled glyphs fail the second group.

| Tab | Route | Badge |
| --- | --- | --- |
| Home | `/` | — |
| Play | `/tournaments/` | count of tournaments with registration open, if > 0 — from **`GET /api/v1/config` → `counts.registration_open`** (API.md §1.1), which the shell already fetches on boot and which is cached 60/300. Not a bespoke counts endpoint, and not a `COUNT(*)` on a paginated list (API.md §0.9 forbids that). |
| **Live** | `/live/` | red dot when `counts.live > 0`, from the same `/api/v1/config` payload; the exact match count comes from `GET /api/v1/live` once the user is on that page |
| Ranks | `/leaderboard/` | — |
| Me | `/me/` (or `/signin/` if anonymous) | amber dot when there is an action for you: unpaid entry fee, un-checked-in match starting < 2h, unread result correction |

The bar hides on scroll-down and returns on scroll-up **only** on `/t/<slug>/bracket/` in Map view,
where vertical space is scarce; everywhere else it is permanently visible (hiding chrome is
disorienting and costs a WCAG 2.2 §2.4.11 problem when focus lands under it). `scroll-padding-bottom:
calc(56px + env(safe-area-inset-bottom) + 8px)` is set globally so a keyboard-focused element is
never obscured by the bar.

**Tournament sub-navigation.** Below the tournament header, a horizontally scrollable, `scroll-snap-
type: x proximity` tab strip implementing the ARIA *tabs-with-manual-activation* pattern but where
each tab is an `<a>` to a real URL (so tabs are shareable and the back button works):

```
Overview · Bracket · Standings · Teams · Schedule · Rules
```

Tab labels swap by format so the label always describes the content:

| Format | Tab 2 label | Tab 3 label |
| --- | --- | --- |
| single / double elimination | Bracket | Standings |
| round robin / swiss / league | Fixtures | Table |
| points lobby | Matches | Points |

The active tab has an amber 2px underline **and** `aria-current="page"` **and** 700 weight — three
signals, only one of which is colour.

**Organizer affordance.** If the signed-in user has `organizer` or `owner` on this tournament, a
persistent **Manage** button sits in the tournament header (not buried in `/admin/`), and during a
live event a **fixed bottom action bar replaces the tab bar** with `Score next match →`.

### 3.2 Desktop (≥ 768px)

- No bottom bar. Top bar grows to 64px and carries the five destinations inline plus a right-aligned
  search field and account menu.
- Tournament sub-tabs render inline in the header, no scroll.
- `/admin/**` gets a 240px left sidebar (Dashboard, Tournaments, Games, People, Audit) that collapses
  to icons < 1024px and disappears into the mobile pattern < 768px.
- Bracket **Map view** becomes the default at ≥ 768px (§6.2).

### 3.3 Footer

Three columns on desktop, stacked accordion on mobile: **Club** (About, Venue, Contact, Code of
conduct) / **Play** (Tournaments, Live, Leaderboard, Games) / **Legal** (Privacy, Terms, Refunds,
Fair play). Plus the language toggle (English / తెలుగు), the theme toggle, and
`© 2026 nellore.club · Nellore, Andhra Pradesh`.

---

## 4. The boot-injection contract (fixes OG previews *and* first paint)

For every rewrite marked "+ inject" in §2.2, the Worker performs **one** D1 read, memoises it in the
Cache API for 30 s under a key derived from the entity, and streams the shell HTML through
`HTMLRewriter` making exactly two kinds of edit.

**(a) Replace the placeholder head tags.** The shell ships placeholders with stable ids so the
rewriter is a simple attribute set, not string surgery:

```html
<title id="nc-title">nellore.club</title>
<meta id="nc-desc"      name="description"     content="Game tournaments in Nellore.">
<meta id="nc-og-title"  property="og:title"    content="nellore.club">
<meta id="nc-og-desc"   property="og:description" content="Game tournaments in Nellore.">
<meta id="nc-og-image"  property="og:image"    content="https://nellore.club/og/default.png">
<meta id="nc-og-url"    property="og:url"      content="https://nellore.club/">
<link id="nc-canonical" rel="canonical"        href="https://nellore.club/">
<script id="nc-jsonld" type="application/ld+json">{"@context":"https://schema.org"}</script>
```

#### 4.0 Exactly one of each tag — and how to actually get that from Next 15

API.md §8.6 requires the rewriter to *replace the content attribute of existing tags rather than
appending new ones*, because "a duplicate `og:title` gives crawlers a coin flip". Getting exactly
one of each out of the App Router takes a deliberate choice, and the wrong one fails in the only
place that matters:

Next 15's supported way to emit head tags is the **Metadata API** (`export const metadata`), which
**cannot set an `id`** and which emits its own `<title>` from `app/layout.tsx` for every page
including the shells. If a shell instead renders the tags in its component tree (relying on React
19's head hoisting), the layout's metadata `<title>` is emitted **as well** — two `<title>`
elements, of which `HTMLRewriter`'s `#nc-title` selector rewrites one. `curl` looks fine, a browser
looks fine, and the WhatsApp crawler gets a coin flip between "BGMI Diwali Cup 2026" and
"nellore.club" — cached for days, with no purge API. That is precisely the non-deterministic,
cache-forever-wrong preview this whole subsystem exists to prevent, and it will not reproduce
locally.

**Normative:**

1. `app/shell/tournament/page.tsx`, `app/shell/player/page.tsx` and `app/shell/admin/page.tsx`
   **must not export `metadata`** (or `generateMetadata`).
2. `app/layout.tsx` **must not set `title`, `description` or `openGraph` defaults** — not even a
   `title.template`. Every prerendered page sets its own via its own `metadata` export; the shells
   render the id'd placeholders above in their component tree.
3. **A build gate**, in `scripts/csp-hashes.mjs` or a sibling script run from the same `build`
   script: for each of `out/shell/*/index.html`, assert **exactly one** `<title>`, and exactly one
   element for each of `description`, `og:title`, `og:description`, `og:image`, `og:url`,
   `canonical` and the JSON-LD block — **each carrying its `nc-*` id**. Fail the build otherwise.
   A CI check is the only thing that will catch a future refactor re-adding a layout title.
4. The Worker keys its CSP-hash lookup by the **asset** path (`/shell/tournament/index.html`), not
   the request path, because step 13 fires on rewritten URLs (SECURITY.md §8.1 point 3).
5. `#nc-jsonld` is the one `<script>` the rewriter touches; its hash is computed at injection time
   and appended to that response's `script-src` (API.md §8.6, SECURITY.md §8.1 point 4).

Injected values for `/t/<slug>/*`:

| Tag | Value |
| --- | --- |
| `title` | `{name} · {game} · nellore.club` |
| `og:title` | `{name}` |
| `og:description` | Composed, ≤ 110 chars, status-dependent: <br>`Registration open · ₹150 entry · ₹10,000 prize pool · 18 of 32 slots left · 12 Nov, 6:00 PM IST` <br>`LIVE now · Round 3 of 5 · 8 teams left` <br>`Won by Team Vega · 32 teams · 9 Nov 2026` |
| `og:image` | `tournaments.og_image_url` if set, else `https://nellore.club/og/cat-{category}.png` where category ∈ `esport`\|`board`\|`outdoor` (six static 1200×630 PNGs, §10) |
| `og:url` / `canonical` | The full canonical URL **without** the tab segment for `/m/<n>/`, **with** it for tabs |
| `og:type` | `website` |

**(b) Insert a boot island** immediately before `</head>`:

```html
<script type="application/json" id="__nc_boot">{ ... }</script>
```

Payload for the tournament shell (this is the *header* record only — never the bracket):

```json
{
  "v": 1,
  "kind": "tournament",
  "fetchedAt": 1794823200,
  "t": {
    "slug": "bgmi-diwali-cup",
    "name": "BGMI Diwali Cup",
    "gameSlug": "bgmi", "gameName": "BGMI", "category": "esport",
    "format": "points_lobby",
    "status": "live",
    "startsAt": 1794823800, "endsAt": 1794841800,
    "entryFeePaise": 15000, "prizePoolPaise": 1000000,
    "entrantCount": 32, "capacity": 32, "teamSize": 4,
    "venueName": "Club Arena, Trunk Road", "posterUrl": null,
    "currentRoundLabel": "Match 3 of 6"
  }
}
```

**Rules the implementer must not get wrong:**

1. Everything injected is **user-authored text** (tournament names, venue names, player handles).
   For `<title>` and `<meta content="...">`, use `HTMLRewriter`'s `setAttribute()` and
   `replace(text, { html: false })` so the runtime escapes for you — never build the tag by string
   concatenation. For the JSON island: `JSON.stringify(payload)`, then additionally replace `<`
   with `\u003c`, `>` with `\u003e`, `&` with `\u0026`, U+2028 with `\u2028` and U+2029 with
   `\u2029` in the resulting string before writing it into the `<script type="application/json">`
   body. Without the `<` replacement, a tournament named `</script><img src=x onerror=…>` is stored
   XSS served to every WhatsApp visitor. This is the single highest-risk line of code in the
   project; it needs a unit test using that exact tournament name.
2. Cap the payload at **2 KB**. It exists to paint a header, not to preload data.
3. If the D1 read fails or times out, **serve the shell unmodified**. A generic preview is a bad day;
   a 500 on a shared link is a lost tournament.
4. Set `Cache-Control: public, max-age=0, must-revalidate, s-maxage=30, stale-while-revalidate=300`
   on injected HTML. 30 s of edge cache absorbs a WhatsApp broadcast to 400 people; SWR means the
   401st person is served instantly from a stale copy while the edge refreshes.
5. Unknown slug → inject nothing and let the client render the not-found state; **still return 200**,
   because a 404 makes WhatsApp render no preview at all and the user assumes the link is broken.
   The client shows the not-found card and the Worker sets `X-Robots-Tag: noindex`.

**Client contract.** On boot the app reads `#__nc_boot`; if `kind` matches the current route it
renders the header synchronously from it (zero network) and marks the rest of the page as loading.
If the island is absent (dev server, cache miss, injection failure) the app renders the header
skeleton and fetches `/api/v1/tournaments/<slug>/overview` as normal. **The app must never require the island.**

---

## 5. User journeys

Notation: `→` screen transition. **Bold** = named screen/state. Timings assume Slow 4G (≈400 kbps,
400 ms RTT) on a mid-range Android.

### Journey 1 — WhatsApp visitor lands on a live tournament and wants the bracket

Entry: someone forwarded `nellore.club/t/bgmi-diwali-cup/`.

1. **WhatsApp preview card** (before the tap). Title `BGMI Diwali Cup`, description
   `LIVE now · Match 3 of 6 · 32 teams`, image = the organizer's poster or the `esport` category card.
   This is the *first* screen of this journey and it is rendered by §4(a), not by the app.
2. Tap → WhatsApp in-app WebView (Android) or SFSafariViewController (iOS).
3. **t ≈ 0.7 s — Header paint.** Worker returns the injected shell (~7 KB gz, often edge-cached).
   Visible immediately, from HTML alone, *before any JS runs*: wordmark, tournament name, game badge,
   **LIVE** pill, `₹10,000 prize pool`, `32 teams`, venue, and the sub-tab strip with **Bracket**
   pre-highlighted (the URL had no tab, so Overview is active; the strip is still rendered).
   Below it: skeletons sized to the real content, so there is no layout shift later.
4. **t ≈ 2.0 s — Interactive.** JS hydrates. It reads the boot island, so the header does not repaint.
   It fires one request: `GET /api/v1/tournaments/bgmi-diwali-cup/overview` (returns header + current-round
   summary + top 5 of the points table in one response — one round trip, not four).
5. **t ≈ 2.8 s — Content paint.** Overview shows: a **Now playing** card (current match, live scores,
   a pulsing red dot, "updated 4 s ago"), the top of the points table, and the next 3 fixtures.
   Sticky bottom CTA: registration is closed, so it reads **Share** + **Add to calendar**.
6. User taps **Bracket** (here: **Matches**, because the format is `points_lobby`). Client-side
   route change, no document load. `GET /api/v1/tournaments/<slug>/bracket` fires; the tab paints its skeleton
   in < 16 ms and fills in ≈ 600 ms.
7. **Live polling** starts (§7.4). A score change animates the changed cell only (a 420 ms amber
   background flash, once) and announces via a polite live region: *"Match 3, Team Vega now 1st, 14
   points."*

Failure branches:
- **Fetch fails at step 4** → header stays (it came from HTML), skeletons are replaced by an inline
  **Couldn't load** card with a Retry button. Never a blank page. This is the entire reason the boot
  island exists.
- **User is offline and has a cached copy** → renders cached data with an offline bar (§7.3).
- **WebView blocks the passkey API** → irrelevant here; this journey requires no account.

### Journey 2 — New player registers a squad of 4

Entry: `/t/<slug>/` with `status = registration_open`, or the short link `/j/AB7K2M/`.

1. **Tournament overview** → sticky bottom CTA **`Register — ₹600 / squad`** (the fee is shown
   per-entry, not per-player, and the label states which).
2. → **Registration wizard** `/t/<slug>/register/`. A 5-step wizard with a persistent progress bar
   (`Step 2 of 5`), **each step a separate history entry** so Android back = previous step, not exit.
   Draft state is persisted to `localStorage` under `nc:v1:reg:<slug>` on every field blur, so a
   killed WebView does not lose 4 in-game IDs.
3. **Step 0 — Identity gate** (skipped if already signed in). Bottom sheet, not a page navigation, so
   the wizard context stays behind it.
   - **State A — passkeys available**: `Handle` (live-checked against `GET /api/v1/handle-available?h=`,
     debounced 400 ms, shows `✓ available` / `✗ taken` / suggestions), `Display name`, then a single
     primary button **Create passkey**. Platform authenticator prompt (fingerprint / face). On success
     the session cookie is set and the sheet advances to A2.
   - **State A2 — Recovery codes.** Ten codes shown as selectable monospace text in one `<pre>`
     block (**one block, not ten inputs** — WCAG 2.2 §3.3.8 requires paste to work), plus
     **Download .txt**, **Copy all**, and a required checkbox *"I have saved these. Without them I
     cannot get in from a new phone."* The Continue button is disabled until the box is ticked. Codes
     are shown exactly once, ever.
   - **State B — passkeys unavailable** (the WhatsApp/Instagram WebView case; detected by
     `!window.PublicKeyCredential ||
      !(await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable())`, or UA containing
     `; wv)`): a card headed **Open this in Chrome to sign up** with a two-step illustrated hint
     (`⋮` → *Open in Chrome*), a **Copy link** button, and — if `navigator.share` exists — a
     **Share to yourself** button. Do **not** show a dead "Create passkey" button that throws.
   - **State C — returning user**: **Sign in with passkey** (conditional UI / autofill is attempted
     first: the handle field carries `autocomplete="username webauthn"` so a saved passkey appears
     in the keyboard suggestion strip with zero taps). Secondary link: **Use a recovery code**.
4. **Step 1 — Team.** There are no persistent teams in v1 (`docs/ARCHITECTURE.md` §9). The captain
   types `Team name` (2–40 chars) and `Tag` (2–6 chars, uppercase, shown in brackets), both
   prefilled from their last entry in this game via `users.profile_answers_json`. The avatar is a
   deterministic identicon generated from the entrant id — there are no uploads in v1.
5. **Step 2 — Roster.** The tournament's `team_size_max` (4) required slots + `substitutes_max` (1) optional.
   - The captain slot is **pre-filled and locked** from the account, including a saved in-game ID if
     one exists for this game (WCAG 2.2 §3.3.7 Redundant Entry).
   - Default sub-mode: **Invite links.** The captain submits the entry with just themselves, then
     taps "Invite player" up to three times; each tap calls
     **`POST /api/v1/entrants/:id/roster-invites`** (API.md §3.12.1) and yields a `/i/<code>/` link
     with **Share on WhatsApp** (`https://wa.me/?text=` + encoded message). The teammate opens it,
     the Worker 302s to `/t/<slug>/register/?invite=<code>`, the SPA calls
     **`GET /api/v1/invites/<code>`** (§3.12.2) to render "Join **Team Falcon** in the BGMI Diwali
     Cup", they sign up (step 0), fill their own name + in-game ID, and
     **`POST /api/v1/invites/<code>/accept`** (§3.12.3) appends their `entrant_members` row. Nobody
     types four BGMI IDs on one phone.
     The codes are single-use, expire at `registration_closes_at`, and are **not honoured after
     registration closes** even if unexpired — the roster the organiser confirmed is the roster.
     `409 conflict` if the invitee is already on another team in this tournament
     (`ux_member_one_team`); `410 gone` if the code was already used.
   - Toggle: **Add manually** — for each slot, `Player name` + `In-game ID`. The in-game ID field's
     label, placeholder, `inputmode`, and validation regex all come from the game record
     (the game's `registration_fields` / `member_fields` FieldDef — `docs/CONTENT.md` §3), so a new
     game needs no code.
   - Live roster status: `2 of 4 confirmed · 2 invites pending`. The wizard can be submitted with
     pending invites; the registration then sits in `pending` with an incomplete roster and the organizer sees it.
6. **Step 3 — Review & rules.** Read-only summary + a required checkbox linking to `/t/<slug>/rules/`
   (opens as a sheet, does not navigate away).
7. **Step 4 — Entry fee.** Only when `entry_fee_paise > 0`.
   - **No payment gateway is configured** (see §11 dependency). The screen shows: the amount, the
     club's UPI VPA as selectable text, a **Pay ₹600 with UPI** button (`upi://pay?pa=<vpa>&pn=
     Nellore%20Club&am=600.00&cu=INR&tn=<regRef>`), and a QR rendered as inline SVG for desktop /
     second-device payment. After paying, the user returns and enters the **12-digit UPI reference
     (UTR)** — `inputmode="numeric"`, pattern-validated, pasteable.
   - `entrants.payment_status` becomes `submitted`. A banner explains: *"Your slot is held for 60 minutes. The
     organizer will confirm your payment."*
   - **Rejected: Razorpay/Cashfree.** They require business KYC, a settlement account and per-txn
     fees before the club has taken a single rupee, which violates the "zero paid dependencies to
     launch" constraint. The UPI-intent + manual-UTR flow costs ₹0 and is what every small club in
     India actually does. The admin reconciliation screen (Journey 4, step 3) is designed around it,
     and `db/schema.sql` keeps `entrants.payment_method` / `payment_ref` / `payment_status` so a gateway can
     be added later without a migration of the flow.
8. **Step 5 — Confirmed.** Big status pill, registration ref, **Add to calendar (.ics)**,
   **Share on WhatsApp**, and a link to `/t/<slug>/checkin/` with the check-in window stated.
   A one-time sheet offers **Turn on match reminders** (see §11).

### Journey 3 — Captain checks in on match day and finds the room code

Entry: `/me/` shows an amber action row *"Check-in opens in 24 min — BGMI Diwali Cup"*, or the
captain taps `Check in` from the tournament header. Route: `/t/<slug>/checkin/`.

The page is a single vertical stack, deliberately dumb, because it is used one-handed while standing
in a noisy hall.

| State | What the screen shows |
| --- | --- |
| **Too early** (`now < checkin_opens_at`) | Big countdown `Check-in opens in 24:11`, the match time in IST, venue, and **Add to calendar**. No enabled buttons. Countdown ticks client-side from a server-supplied epoch (never from device clock alone — see below). |
| **Open, not checked in** | Roster list with each player's confirmed/pending state, and one 56px-tall primary button **Check in all 4 players**. Individual per-player check-in is a secondary "check in players separately" link (captains check in the squad; per-player is the exception). |
| **Checked in, code not yet published** | Green **Checked in ✓** pill + `Room code appears here at 7:15 PM IST (in 12:41)`. Auto-reveals when the countdown hits zero, with a `role="status"` announcement. |
| **Checked in, code published** | The payoff screen. A card with `ROOM ID` and `PASSWORD` in 28px tabular monospace, letter-spaced, **behind a tap-to-reveal blur** (venues are crowded; codes get shoulder-surfed). Buttons: **Copy room ID**, **Copy password**, and **Copy for WhatsApp** which puts one message on the clipboard: `BGMI Diwali Cup — Match 3\nRoom 48213 · Pass 7712\n7:30 PM IST\nnellore.club/t/bgmi-diwali-cup/`. |
| **Code changed** | If the organizer republishes a code, the card flashes amber once, shows `Updated 7:22 PM IST`, and announces politely. Old code is struck through for 30 s so a captain who already copied it sees they are stale. |
| **Check-in window closed, not checked in** | Red-bordered card: *"Check-in closed at 7:10 PM IST. Talk to the organizer at the desk."* + the organizer's listed contact. No dead ends. |
| **Offline** | Everything above still renders from cache with the offline bar. If the code was already fetched it is still readable — **this is the single most important offline case in the product** and the room code is explicitly cached (it is short-lived and already scoped to a checked-in captain). |

**Clock trust.** The countdown must not drift with a wrong device clock. Every API response carries
`X-NC-Now` (server epoch seconds; `docs/API.md` §0.10). On first response the client computes
`skew = serverNow - Date.now()/1000` and renders every countdown as `target - (Date.now()/1000 +
skew)`. If `|skew| > 120`, show a one-line notice: *"Your phone's clock is 6 minutes fast — times
shown are the club's."*

### Journey 4 — Organizer runs a tournament from creation to live scoring

**4a. Create** — `/admin/` → **New tournament** → `/admin/t/new/`, a 5-step wizard.

| Step | Fields | Notes |
| --- | --- | --- |
| 1 Game | Searchable list from the game catalogue, grouped by category | Choosing a game sets defaults for everything downstream: team size, scoring model, allowed formats, in-game-ID field. **Nothing about a game is hardcoded in the wizard.** |
| 2 Format | Only `supported_formats` for that game. Radio cards with a one-line plain-English explanation and a tiny inline diagram | e.g. *Double elimination — you must lose twice to be out. Takes about 2× as long.* |
| 3 Schedule & venue | Name, slug (auto-derived, editable, live-uniqueness-checked, 28-char counter), start/end (IST pickers), venue, capacity, team size, subs, check-in window, registration open/close | Slug field shows the final URL: `nellore.club/t/bgmi-diwali-cup/` |
| 4 Money & rules | Entry fee (₹, per team or per player — explicit radio), prize pool + split table, rules rich text (a constrained markdown subset), fair-play link | Prize split must sum to ≤ pool; live validation. |
| 5 Publish | Preview of the tournament card **and the WhatsApp preview card**, poster upload (optional), then **Save as draft** / **Publish** | Publishing mints the `/j/<code>/` short link and shows a **Copy WhatsApp announcement** button. |

**4b. Registrations** — `/admin/t/<slug>/registrations/`. A dense list, filterable by status
(`pending payment`, `roster incomplete`, `confirmed`, `waitlist`, `rejected`). Each row: team name +
tag, captain handle, roster completeness `4/4`, UTR (tappable to copy), and a two-button action pair
**Confirm** / **Reject**. Bulk-select for confirming a batch after checking the bank statement.
Waitlist auto-promotes when a confirmed entry is rejected, with an explicit toast naming who moved up.

**4c. Close registration.** A destructive-styled confirm sheet stating the exact consequences:
*"32 confirmed, 3 pending payment, 5 on waitlist. Closing will reject the 3 pending and clear the
waitlist. This cannot be undone."* Two-step (§ hold-to-confirm below).

**4d. Seeding** — `/admin/t/<slug>/seeding/`. An ordered list of confirmed entrants, 1..N.

- Reorder is available three ways, and **drag is never the only way** (WCAG 2.2 §2.5.7): each row has
  ▲/▼ buttons (44×44), a "move to position…" number input, and drag handles for those who want them.
- Seed presets, applied as a one-tap action then still editable: **Registration order**,
  **Random (seeded)** — which displays the RNG seed so the draw is auditable and can be re-run in
  front of the room — and **Manual**.
  **"By club rating" is not offered in v1.** Ratings are not implemented (API.md §1.12.2):
  `entrants.rating` is `NULL` for every row, and `POST .../entrants/reseed` with
  `{"method": "rating"}` returns `400 validation_failed`,
  `details.fields["method"] = "rating_not_implemented"` rather than silently falling back to
  registration order. A seeding control that quietly does something other than what its label says
  produces a wrong bracket that looks right, and nobody finds out until the draw is on WhatsApp. The
  button is hidden while `GET /api/v1/config` reports no rating feature, which in v1 is always.
- Below the list: a **live preview** of round 1 pairings and the bye count
  (`32 entrants → 32-slot bracket, 0 byes` / `21 entrants → 32-slot bracket, 11 byes, seeds 1–11 get
  a bye`). The preview is computed client-side from the same pure function the server uses, exposed
  via `POST /api/v1/organizer/tournaments/<id>/bracket/preview` so the two can never disagree.
- **Generate bracket** — hold-to-confirm. After generation the seeding screen becomes read-only and
  says *"Bracket generated 6:02 PM IST. To reseed you must reset the bracket, which clears all
  results."*

**4e. Live scoring** — `/admin/t/<slug>/score/`. This screen is used standing up, one-handed, in bad
light, on bad signal. It is the only screen in the product allowed to break the normal layout rules.

- **Full-screen, no bottom tab bar, no footer.** A single match fills the viewport.
- Top: `WB Round 2 · Match 12 · Court 1 · 7:30 PM IST` and a **Next unscored match →** control.
- Middle: the two entrants as two large 96px-tall rows. Each row has the team name, tag, seed, and a
  **giant stepper**: `[ − ]  2  [ + ]` with 64×64 buttons and a 40px tabular numeral. Long-press
  repeat is *not* used (misfires); a `Set score…` link opens a numeric keypad sheet for large values
  (cricket runs, scrabble points).
- For a **points lobby** the middle becomes a per-team row list with two numeric fields
  (`Placement` / `Kills`) and a live-computed `Pts` column using the game's points table; a `Paste
  results` affordance accepts a pasted block of `team,placement,kills` lines for organizers who type
  it up elsewhere.
- Bottom: a full-width **Lock result** button requiring a **1.2 s press-and-hold** with a filling
  progress ring. Rationale: a stray tap in a pocket must not advance a bracket. Accessibility escape
  hatch: the same button responds to **Enter/Space** (keyboard/AT) by opening a normal confirm dialog
  instead of requiring a hold, and if `prefers-reduced-motion` is set *or* the organizer enables
  *Simple confirmations* in `/me/settings/`, the dialog is always used. Holding is never the only way.
- On lock: optimistic UI — the match flips to **Done**, the winner's name animates into the next
  match's slot (420 ms, once), a toast says *"Result saved. Ravi Teja → WB R3 M2."*, and the screen
  auto-advances to the next unscored match after 1.5 s (with an **Undo advance** affordance in the
  toast that only navigates back — it does not undo the result).
- **Offline write queue.** Writes go to an IndexedDB queue first. A persistent chip shows
  `2 results queued · will sync` with an amber…no — with a **neutral** chip carrying a cloud-off
  glyph (amber is reserved, see `docs/DESIGN.md` §2.3). Retry with exponential backoff
  (2s, 4s, 8s, 16s, 30s, then every 30 s) while the tab is visible. Queue survives a reload. The
  organizer can keep scoring an entire round with no signal.
- **Conflict.** Every write carries `result_version` in the body (`docs/API.md` §6.2), plus an
  `Idempotency-Key` for the retry case. A `409 stale_version` opens a blocking sheet:
  *"Match 12 was updated by @priya at 7:42 PM IST. Yours: 2–1. Theirs: 1–2."* with **Keep mine** /
  **Keep theirs** / **Open match**. Never silently overwrite; two organizers on two phones at one
  venue is the normal case, not the edge case.

### Journey 5 — Organizer corrects a wrong score from two rounds ago

This is the flow most tournament software gets wrong. It must be **possible, safe, visible, and
auditable**.

1. Entry: `/admin/t/<slug>/score/` → **All matches** → filter to Round 2 → tap match 12. (Also
   reachable from the public bracket: an organizer sees an **Edit** affordance on every match node.)
2. **Match sheet (organizer view)** shows the current result, who entered it and when, and a
   secondary destructive button **Correct result**.
3. **Correction sheet, step 1 of 2 — Impact.** Before anything is editable, the server is asked
   `GET /api/v1/organizer/matches/<id>/impact` and the sheet renders the *exact* consequence list:

   ```
   Changing this result will reset 3 later matches:

     ● WB R3 M2   Done   Ravi Teja 2–0 Anil        → scores cleared, entrants re-derived
     ● WB R4 M1   LIVE   Ravi Teja 1–1 Sandeep     → scores cleared, entrants re-derived
     ● LB R2 M4   Done   Anil 2–1 Kiran            → scores cleared, entrants re-derived

   Standings, points and the leaderboard will be recomputed.
   ```

   Each listed match is tappable (opens read-only). If **any** listed match is `live`, an extra
   required checkbox appears: *"I understand Match 41 is live right now."*
4. **Step 2 of 2 — New result.** The same stepper UI as live scoring, pre-filled with the current
   (wrong) values, plus an optional 120-char **Reason** field (`Scoresheet misread — Anil won 2–1`).
   Confirm is the same **hold-to-apply** control with the keyboard/AT dialog fallback.
5. **Apply.** `PUT /api/v1/organizer/matches/<id>/score?confirm=1` performs the recompute-and-reapply
   **in a single `D1.batch()`** so the public bracket is never observed half-corrected. On success: toast *"Result
   corrected. 3 matches reset."*, the bracket repaints, and every affected node briefly shows a
   `Reset` chip.
6. **There is no Undo.** Stated plainly in the UI: *"Corrections are logged, not undone. To reverse
   this, correct the match again."* An optimistic client-side undo across a cascading multi-row batch
   is a correctness trap (the state it would restore may no longer be reachable), so the product buys
   safety with the impact preview and the audit log instead of a fragile undo button. **Rejected
   alternative:** a 15-second undo toast — it encourages fast, unconsidered confirmation and would
   have to be honoured even if another organizer wrote to a downstream match in the meantime.
7. **Audit** — `/admin/t/<slug>/audit/` lists, newest first: timestamp (IST), actor handle, action,
   match, before → after, reason, and the count of cascaded resets. Read-only, paginated, exportable
   as CSV client-side. Public tournaments additionally show a **Result corrected** chip with the
   timestamp on the affected match node in the *public* bracket for 48 h — players notice when a
   score changes, and hiding it destroys trust faster than the original mistake did.

### Journey 6 — Returning player checks the leaderboard and their own history

1. Bottom tab **Ranks** → `/leaderboard/`.
2. **Filter bar** (sticky under the header): `Game ▾` `Season ▾` `Category ▾`. Defaults: all games,
   current season. Filters write to the query string (`?game=bgmi&season=2026-h2`) and to
   `localStorage` so the next visit restores them; the URL always wins on load.
3. **Rows**: `#4` (or `T4` for a tie) · avatar · handle + display name · **points** (tabular, the
   largest number on the row) · `12 played` · a trend glyph with a text label (`▲ +3` / `▬ 0` /
   `▼ −2`, never colour alone). The signed-in user's own row is duplicated as a **sticky bottom
   bar** if they are outside the visible window — "you are #47" is the reason this page exists.
4. **Pagination**: 50 rows, then a **Show 50 more** button. Infinite scroll is rejected — it breaks
   the back button (a serious problem in an in-app WebView) and makes the footer unreachable.
5. Tap a row → `/p/<handle>/`.
6. **Player profile**: header (avatar, display name, `@handle`, `Member since Mar 2026`, badges for
   titles won). Four stat tiles: `Tournaments 14` / `Win rate 62%` / `Best finish 1st` /
   `Points 1,240`. Tabs: **Overview** (recent 5 results + best games) / **History** (reverse-chron
   list: tournament, date, format, placement pill, points earned; filterable by game).
7. Own profile adds an **Edit profile** button and a link to `/me/security/` (passkeys list with
   device name + last-used, **Add another passkey**, **Sign out everywhere**, **Regenerate recovery
   codes**). Sessions are listed with device/UA summary, IP city, last seen, and a **Revoke** button
   per session.

---

## 6. The bracket viewer

The hardest UI in the product. A 32-entrant **double elimination** bracket is 31 winners-bracket
matches + 30 losers-bracket matches + 1 grand final (+1 possible bracket reset) = **62–63 matches
across 14 rounds**. Drawn as a classic tree at a legible node size (168 × 68 px, 32 px column gap,
12 px row gap) that is **≈ 2,800 px wide × 1,280 px tall**. On a 360 px viewport that is 7.8 screens
across. Pan-and-zoom as the primary interaction is therefore not a design choice, it is a defect.

### 6.1 Three view modes

The bracket route (`/t/<slug>/bracket/`) offers three modes in a segmented control in the toolbar.
The chosen mode persists in `localStorage` (`nc:v1:bracketview`); the default depends on viewport.

| Mode | Default on | What it is |
| --- | --- | --- |
| **Rounds** | < 768 px | One round at a time. The primary mobile experience. |
| **Follow** | — (opt-in, but auto-selected when the URL carries `?e=<entrantId>`) | One entrant's path through the tournament as a vertical timeline. |
| **Map** | ≥ 768 px | The classic tree with connector lines. Available on mobile as *Full bracket*. |

#### Mode A — Rounds (the mobile default)

Two stacked controls at the top of the panel, both sticky:

```
┌─────────────────────────────────────────┐
│  [ Winners ] [ Losers ] [ Final ]        │  ← segmented control (elimination only)
│  R1  R2  R3 •NOW•  R4  R5                │  ← round strip, horizontally scrollable
└─────────────────────────────────────────┘
```

- The **segmented control** exists because a 14-round flat strip is unusable. Single elimination,
  round robin and BR series render only one segment and the control is hidden.
- The **round strip** is an ARIA `tablist` of `<a>` tabs. The current round carries an amber
  underline, 700 weight, `aria-current="page"`, and a small `NOW` label. On first load the strip
  auto-scrolls that tab into view (`scrollIntoView({ inline: 'center', behavior: 'auto' })` — never
  `smooth` on first paint) and selects it.
- The **panel** is a vertical list of full-width match cards (328 px at a 360 px viewport). Live
  matches are hoisted to the top of the list within their round, under a `Live now` sub-heading.
- Horizontal **swipe** between rounds is supported via CSS `scroll-snap-type: x mandatory` on a
  panel container — *not* a JS drag transform. This matters: scroll-snap keeps native momentum,
  keeps the scrollbar, keeps keyboard `←/→` working, and satisfies WCAG 2.2 §2.5.7 because tapping a
  tab is an equivalent single-pointer path.
- **There are no connector lines in Rounds mode.** Lineage is expressed as navigation instead of
  geometry, which is both smaller and more useful on a phone. Every card carries:
  - a *feeder* line when entrants are undetermined: `vs. winner of R1 M7` (tappable → that match),
  - an *outcome* line when decided: `Winner → WB R3 M2` and, in double elimination,
    `Loser → LB R2 M4` (both tappable).

**Match card anatomy** (Rounds mode, 328 px):

```
┌────────────────────────────────────────────┐
│ #12 · WB R2            ● LIVE   7:30 PM IST│  meta row, 12px, fg-faint
├────────────────────────────────────────────┤
│ ▎ 1  Team Vega  [VEG]                    2 │  44px row · winner: amber left bar,
│   4  Team Orion [ORI]                    1 │  700 weight, ✓ glyph · loser: fg-faint
├────────────────────────────────────────────┤
│ Winner → WB R3 #29      Loser → LB R2 #41  │  12px links
└────────────────────────────────────────────┘
```

Special rows:
- **TBD**: `— · Winner of R1 M7` in `fg-faint` italic, no score cell.
- **Bye**: a single 32px row, `Bye — Team Vega advances`, muted, no score. Kept in the DOM and in the
  accessible tree (a screen-reader user must be able to tell a bye from a missing match) but visually
  de-emphasised and non-tappable.
- **Walkover / forfeit / DQ**: the score cell shows `W/O`, `FF` or `DQ` as text, plus the normal
  winner encoding. A tooltip/`<details>` gives the reason if the organizer entered one.

#### Mode B — Follow

Deep-linkable: `/t/<slug>/bracket/?e=<entrantId>` (the one place a query param is acceptable, because
it is generated by a **Share this team's path** button rather than typed).

A vertical timeline of just that entrant's matches, past at top, future at bottom, with a rail line
connecting them:

```
 ● R1 M3   won   2–0 vs Team Orion
 ● R2 M12  won   2–1 vs Team Nova
 ◉ R3 M29  LIVE  1–1 vs Team Kite            ← larger card, live scores
 ○ R4 M45  next  vs winner of R3 M30 · ~8:40 PM IST
 ○ Final   —
```

This is the single most-wanted view for a WhatsApp arrival ("did my cousin's team win?") and it
costs almost nothing to build once the bracket graph is in memory. It also serves as a natural,
fully linear, fully accessible reading of the bracket.

#### Mode C — Map

The classic left-to-right tree, for desktop and for the wall projector at the venue.

- Rendered as absolutely-positioned nodes inside a relatively-positioned canvas, with connectors as a
  **single inline `<svg>` of `<path>` elements** behind them (one SVG, one paint, no per-node DOM
  cost). Orthogonal elbow connectors, 1.5 px, `stroke: var(--line-strong)`; the connector on the path
  a *winner actually took* is drawn in amber at 2 px.
- **Zoom is by button, not only by gesture**: `[−] 100% [+]` with stops at 50 / 75 / 100 / 125 %,
  plus a **Fit** button. Pinch-zoom works but is never required (WCAG 2.2 §2.5.7).
- Panning is normal overflow scrolling on both axes (again: not a drag transform), so trackpad,
  scrollbar, keyboard and screen-reader virtual cursors all work.
- A 96 × 64 px **mini-map** in the bottom-right shows the viewport rectangle over the whole bracket,
  tappable to jump. Hidden below 768 px.
- Round headers are `position: sticky; top: 0` inside the canvas so you always know which round you
  are looking at.
- **Losers bracket** is rendered below the winners bracket with its own sticky heading, not
  interleaved. Grand final sits to the right of both, vertically centred, visually enlarged.

### 6.2 Live and current-round indication

Never colour alone. A live match carries **all four**:
1. the text `LIVE` in the meta row,
2. a 8 px dot that pulses (2 s ease-in-out, opacity 1 → 0.4 → 1; static when `prefers-reduced-motion`),
3. a 3 px left border on the card,
4. `aria-live="polite"` score updates and an `<span class="sr-only">Live match</span>`.

The current round is marked by the amber underline + `NOW` text label on its tab, and by
`aria-current="page"`. Completed rounds get a `✓` in the tab; future rounds are plain.

### 6.3 Degradation to other formats

The route, the toolbar and the match-sheet are identical; only the panel changes. This is why the tab
is labelled from the format (§3.1).

| Format | Panel |
| --- | --- |
| **Round robin / league / swiss** | Two sub-tabs: **Table** (standings from `GET /tournaments/:slug/standings?stage=…`, columns rendered straight from that response's `columns` array — the frontend knows nothing about kills or net run rate; the qualification cut-line is a 2 px amber rule labelled `Top 4 qualify`) and **Fixtures**. **Fixtures reads `GET /tournaments/:slug/matches?stage=…` (paginated), not the bracket response** — a grouped league is the payload worst case (§6.4) and the bracket endpoint is the wrong shape for it. Grouped by matchday, each an accordion, current matchday expanded. Follow mode still works — it filters fixtures to one entrant. |
| **Points lobby** (BGMI, Free Fire) | Two sub-tabs: **Points** (rank, team, `M` matches played, `Plc` placement points, `Kills`, `Pts` total, `WWCD` wins, with the top-N cut-line rule) and **Matches** (one accordion per **round**, containing one card per lobby: room label, time, and the per-team placement/kills breakdown from `match_participants`). The points formula is displayed above the table in plain text, read from the game record — e.g. `1st = 10 pts, 2nd = 6, 3rd = 5 … + 1 pt per kill`. |
| **Multi-stage** (groups → playoffs) | A stage selector above everything: `Group stage · Playoffs`, driven by the `stages[]` array present in **both** the bracket response (API.md §1.7) and the standings response (§1.9). Selecting a stage sets `?stage=<ordinal>` on the standings and matches fetches. Each stage renders with its own format's panel. The selector is hidden when `stages.length === 1`, which is the single-stage case and the majority. |

**A number rendered as `points` divides by `stages.points_divisor`** when the standings response's
`points` column carries `"divisor": 2` (chess). The server never formats it; there are no fractional
numbers on the wire. Columns typed `"ratio_milli"` (`set_ratio`, `net_run_rate`) divide by 1000 and
may be negative.

### 6.4 Bracket performance budget

- The whole bracket for one tournament arrives in **one** JSON response
  (`GET /api/v1/tournaments/<slug>/bracket`, ETag'd). A 64-entrant double-elimination bracket is
  ~126 matches; at ~180 bytes of JSON per match that is ~23 KB uncompressed, ~5 KB gzipped.
  Acceptable.
- **The worst case is a league, not a knockout, and it is capped.** 256 entrants in 8 groups of 32
  is 3,968 matches ≈ 715 KB — which is why `MAX_MATCHES_PER_TOURNAMENT = 1024` is enforced at
  generation (API.md §1.7, ARCHITECTURE.md §9.18) and is also the `LIMIT` on the query, so a legal
  draw can never render truncated. At the cap the bracket response is ~185 KB uncompressed / ~30 KB
  gzipped, which is the number to design the league panel against. If `meta.truncated` is ever
  `true`, the panel renders a banner pointing at the fixtures list instead of a short bracket.
- Rounds mode renders **only the active round's cards** (16 nodes worst case) plus the two adjacent
  rounds for snap-scroll. Map mode renders everything but with plain `<div>`s and one SVG; no
  virtualisation, no canvas, no library. Measured target: < 120 ms scripting to paint 126 nodes on a
  Snapdragon 680.
- **No bracket library.** `react-brackets`, `d3` and friends are 30–90 KB gz and none of them do
  double elimination + BR points + round robin. The layout is `y = f(round, index)` arithmetic; write
  the 60 lines.

---

## 7. Loading, empty, error and offline states

### 7.1 The universal data-view contract

Every data-backed view implements the same five-state machine. There is no sixth state and there is
no "spinner forever".

```
                ┌──────────┐
   mount ─────► │  BOOT    │ read localStorage cache (nc:v1:<key>)
                └────┬─────┘
        cache hit    │    cache miss
      ┌──────────────┴───────────────┐
      ▼                              ▼
┌───────────┐  revalidate      ┌───────────┐
│  STALE    │ ───────────────► │ LOADING   │  skeleton after 250ms delay
│ (content  │ ◄─────────────── │ (skeleton)│  "still loading…" + Retry at 10s
│  + "as of"│    304 / 200     └─────┬─────┘
│   chip)   │                        │
└─────┬─────┘                        ▼
      │                        ┌───────────┐
      └───────────────────────►│  READY    │
                               └─────┬─────┘
        fetch throws / 5xx / offline │
                               ┌─────▼─────┐        no cache
                               │  ERROR    │◄───────────────
                               │ or OFFLINE│
                               └───────────┘
```

**Cache.** `localStorage` key `nc:v1:<method>:<path>`; value `{ etag, fetchedAt, body }`.
TTLs by view: bracket/live 60 s soft, 24 h hard; tournament list 5 min soft, 7 d hard; leaderboard
10 min soft, 7 d hard; static-ish (game catalogue, rules) 24 h soft, 30 d hard. "Soft" means paint
from cache and revalidate; "hard" means past this age, do not paint from cache, go to LOADING.
Revalidation always sends `If-None-Match`; a 304 costs ~200 bytes and just bumps `fetchedAt`.
Total quota guard: evict least-recently-used keys when the store exceeds 2 MB; wrap every
`localStorage` call in try/catch (private-mode WebViews throw).

**Freshness chip.** Any view painted from cache shows a small chip in its toolbar:
`Updated 4 min ago` (relative under 1 h, then `Updated 6:42 PM IST`). Tapping it forces a revalidate.
This is how a user tells a stale bracket from a live one, and it is mandatory on every live view.

**Skeletons** are laid out to the exact dimensions of the real content (fixed row heights, fixed card
heights) so filling them causes **zero layout shift**. They appear only after a **250 ms** delay —
on a warm cache or a fast connection the user should never see a flash of skeleton.

### 7.2 Per-view specification

| View | Loading | Empty | Error | Offline (cache present) |
| --- | --- | --- | --- | --- |
| `/` live strip | 1 skeleton card, 250 ms delay | Strip is removed entirely (no "nothing is live" card on the home page — it is depressing and it is the default) | Strip removed, silent (a home-page hero must never show an error) | Cached strip + `Updated …` chip |
| `/live/` | 3 skeleton cards | **"Nothing live right now."** + next 3 upcoming tournaments + **Browse tournaments** | Error card + Retry | Cached + offline bar |
| `/tournaments/` | 6 skeleton cards | Filtered: *"No tournaments match these filters."* + **Clear filters**. Unfiltered: *"No tournaments yet. The club is setting up."* + link to `/games/` | Error card + Retry; existing results stay visible if this was a filter change | Cached list + offline bar; filter controls disabled with a tooltip |
| `/t/<slug>/` overview | Header from boot island (never a skeleton) + 3 skeleton blocks | n/a | Inline **Couldn't load the latest** card + Retry, header intact | Cached + offline bar |
| `/t/<slug>/` unknown slug | — | **"This tournament doesn't exist, or the link changed."** + **Browse tournaments** + **Search**. HTTP 200 (§4 rule 5) | — | — |
| bracket | Round strip skeleton + 4 card skeletons | Registration still open: **"Bracket appears when registration closes."** + countdown + **Register**. Draft: **"The organizer hasn't generated the bracket yet."** | Error card + Retry, round strip preserved if cached | Cached bracket, offline bar, live polling paused, freshness chip turns to `Offline · as of 7:41 PM IST` |
| standings / points | Table skeleton, 6 rows | **"No results yet."** + first fixture time | Error card + Retry | Cached + offline bar |
| teams | 6 skeleton rows | **"No one has registered yet. Be first."** + **Register** | Error + Retry | Cached |
| check-in | Card skeleton | (states are enumerated in Journey 3) | Error + Retry + organizer contact | Cached; the room code remains readable — highest-value offline case |
| `/leaderboard/` | 10 skeleton rows | **"No ranked players for this filter yet."** + **Clear filters** | Error + Retry | Cached |
| `/p/<handle>/` | Header from boot island + stat-tile skeletons | Unknown handle: **"No player with that handle."** + **Search** | Error + Retry | Cached |
| `/me/*` | Skeletons | *"You haven't registered for anything yet."* + **Browse tournaments** | 401 → sign-in sheet, not an error card | Cached, all write actions disabled with a `Offline — actions unavailable` note |
| `/admin/**` | Skeletons | Per-list empty states with a primary create action | 401 → sign-in; 403 → **"You don't manage this tournament."** + link to `/` | Read-only; the **live scoring** screen is the exception and queues writes (Journey 4e) |
| `/search/` | 5 skeleton rows | `q` empty: recent + popular. No results: **"Nothing for 'xyz'."** + spelling hint + browse links | Error + Retry | Search disabled offline with a clear message |

### 7.3 Offline behaviour

- A **service worker** (~2 KB) is registered on first visit. Strategy:
  - `/_next/static/**`, fonts, `/og/*`: **cache-first, immutable**.
  - Shell + prerendered HTML: **stale-while-revalidate**.
  - `GET /api/v1/**`: **network-first with a 3 s timeout, falling back to the SW cache**, and the
    response is also mirrored into the localStorage cache used by §7.1.
  - Anything non-GET, and anything under `/api/v1/auth/**` or `/admin/**`: **never cached**.
  - Navigation failure with no cache → `/offline/`.
  - `skipWaiting` is **off**. A new version shows a toast **"New version available — Reload"**; the
    user chooses. Silent hot-swaps during a live scoring session are how you lose a round of results.
- **Offline bar**: a full-width 36 px bar directly under the header, `bg-surface-2`, hairline border,
  cloud-off glyph, text `Offline — showing data from 7:41 PM IST`, and a **Retry** button. It is
  `role="status"`. It appears on `offline` events *and* on two consecutive fetch failures (the
  `navigator.onLine` API lies constantly on Android — treat repeated failure as the real signal).
- **Write attempts while offline**: outside live scoring, every mutating button becomes disabled with
  a short inline note `Needs internet`. Do not let a user fill a 5-step registration wizard and then
  discover at submit that it failed — the wizard's **Next** buttons stay enabled (the draft is local)
  but step 5's **Submit** is gated with the note plus *"Your entries are saved on this phone."*

### 7.4 Live polling

Only `/live/`, `/t/<slug>/` (overview), `/t/<slug>/bracket/`, `/standings/` and `/checkin/` poll.

| Condition | Interval |
| --- | --- |
| Tab visible, a match is `live`, changes seen recently | 20 s |
| Tab visible, live, but no change for 5 min | 45 s |
| Tab visible, nothing live | 120 s |
| `document.visibilityState !== 'visible'` | **paused**, and a single immediate revalidate on return |
| `navigator.connection.saveData === true` or `effectiveType` in `2g`/`slow-2g` | polling **off**; a **Refresh** button appears in the toolbar next to the freshness chip |
| Two consecutive failures | back off ×2 up to 5 min, show the offline bar |

Every poll is a conditional `GET` with `If-None-Match`; the Worker answers 304 in the common case, so
a 400-person WhatsApp audience polling a live final costs a few hundred bytes each per 20 s.
**Rejected: WebSockets / Durable Objects for live scores.** They are the technically superior answer
and they are wrong here — one Durable Object per live tournament adds a stateful component, a
reconnect state machine, and a bill, to solve a problem that a 20-second conditional GET solves for
free at this club's scale (hundreds, not tens of thousands, of concurrent viewers). Revisit if a
single tournament ever exceeds ~2,000 concurrent viewers.

---

## 8. Accessibility (target: WCAG 2.2 level AA)

### 8.1 Global

- **Language.** `<html lang="en">`. Any Telugu string is wrapped in `<span lang="te">` so screen
  readers switch voice. The language toggle sets `lang` on `<html>` and persists to
  `localStorage` + the `nc_lang` cookie (read by the Worker only to pick the OG description language).
- **Landmarks.** One `<header>` (banner), one `<nav aria-label="Primary">`, one `<main id="main">`,
  one `<footer>` (contentinfo). The bottom tab bar is `<nav aria-label="Sections">`. A **Skip to
  content** link is the first focusable element, visually hidden until focused.
- **Focus order** follows DOM order everywhere; no positive `tabindex` anywhere in the codebase.
  Route changes move focus to the `<h1>` of the new view (`tabindex="-1"`, focus, no scroll) and
  announce the new page title in a visually hidden `role="status"` region — a client-side route
  change is silent to a screen reader otherwise.
- **Focus visibility (2.4.11, 2.4.13).** A 2 px `--focus` outline with a 2 px offset in the page
  background colour, so the ring is legible on any fill including the amber primary button. Never
  removed, never `outline: none` without a replacement. `scroll-padding-top: 64px` and
  `scroll-padding-bottom: calc(56px + env(safe-area-inset-bottom) + 8px)` keep focused elements clear
  of the sticky header and bottom bar.
- **Target size (2.5.8).** Every interactive control is **≥ 44 × 44 CSS px**, which exceeds the AA
  floor of 24 × 24. Where a control must render smaller (a 20 px close glyph, a table-row chevron)
  the hit area is expanded with a pseudo-element, and adjacent targets keep ≥ 8 px spacing.
- **Dragging (2.5.7).** Nothing in the product requires a drag: seeding has ▲/▼ and "move to
  position"; bracket panning is native scroll plus round tabs plus arrow keys; zoom has buttons.
- **Accessible authentication (3.3.8).** Passkeys are the primary path and are exempt by design (no
  cognitive function test — the user proves identity with a fingerprint). The recovery-code fallback
  is a **single text field that accepts paste** (`autocomplete="one-time-code"` is *not* used; paste
  is never blocked, `onPaste` is never intercepted). There is no CAPTCHA anywhere; rate limiting is
  server-side and IP/handle-scoped.
- **Redundant entry (3.3.7).** In-game IDs, display name and phone are pre-filled from the profile on
  every subsequent registration and are editable.
- **Consistent help (3.2.6).** A **Help** link occupies the same last position in the footer on every
  page and points at `/contact/`, which lists the club's WhatsApp number and venue address.
- **Reflow (1.4.10) and zoom (1.4.4).** All content works at 320 px width and at 400 % zoom with no
  two-dimensional scrolling **except** the bracket Map view and wide data tables, which are the
  documented exception the criterion allows — and both have an equivalent linear alternative
  (Rounds/Follow mode; the stacked card list for tables below 480 px).
- **Motion (2.3.3).** `prefers-reduced-motion: reduce` collapses all transitions to ≤ 1 ms except
  opacity fades (capped at 120 ms), turns the live pulse into a static dot, disables the advance
  animation and all auto-scrolling, and switches hold-to-confirm to the dialog variant.
- **Colour independence (1.4.1).** Enforced by review checklist: every status is a **glyph + text
  label + colour**, never colour alone. See the table in §8.3.
- **Forms (3.3.1–3.3.4).** Every input has a visible `<label>` (no placeholder-as-label). Errors are
  announced in an `role="alert"` region at the top of the form *and* rendered inline under the field
  with `aria-describedby` and `aria-invalid="true"`. Destructive or financial submissions (close
  registration, generate bracket, correct result, pay) all have a reversible/confirm step.

### 8.2 Keyboard model for the bracket

This is the specific hard part; here is the concrete answer.

**Rounds mode.**

| Key | Action |
| --- | --- |
| `Tab` | Segmented control → round tablist (one stop) → first match card → … |
| `←` `→` (in tablist) | Previous/next round, **manual activation** (moves focus and selects, updating the URL via `history.replaceState`) |
| `Home` / `End` (in tablist) | First / last round |
| `Tab` from the tablist | Enters the round panel (`role="tabpanel"`, `tabindex="0"`, `aria-labelledby` the active tab) |
| `↑` `↓` (in panel) | Move between match cards (roving `tabindex`, so the whole panel is **one** tab stop even with 16 matches) |
| `Enter` / `Space` | Open the match sheet |
| `Esc` | Close the sheet, returning focus to the card that opened it |

**Map mode** uses `role="grid"` over the bracket, columns = rounds, rows = matches, with roving
`tabindex`:

| Key | Action |
| --- | --- |
| `↑` `↓` | Previous/next match **within the same round** |
| `→` | Jump to the match this one's **winner feeds into** (semantically: "where does this go?"). If undetermined, jumps to the same-index match in the next round. |
| `←` | Jump to the **feeder** match (the one whose winner arrived in the focused slot). |
| `Shift + →` | Jump to the loser's destination match (double elimination only). |
| `Home` / `End` | First / last match in the round |
| `Ctrl+Home` | Round 1, match 1 |
| `+` / `−` / `0` | Zoom in / out / fit |

Every focus move scrolls the node into view with `block: 'nearest', inline: 'nearest'` so focus is
never off-screen (2.4.11). The grid is preceded by a `<details>` element, **Keyboard shortcuts**,
listing exactly this table — discoverable, not folklore.

### 8.3 Screen-reader semantics for a bracket

A bracket is a graph rendered as geometry. Geometry is invisible to a screen reader, so the
*relationships* must be in the accessible name and in explicit links. Three mechanisms, all shipped:

**1. Structure.** The bracket is `<section aria-labelledby="bracket-h">` containing, per round, a
`<section role="tabpanel" aria-labelledby="tab-r2">` with an `<ol>` of matches. Each match is an
`<li>` containing an `<article>`. Ordered lists give "item 3 of 16" for free.

**2. A composed accessible name per match.** The card's visible content is decorative fragments; the
`aria-label` on the `<article>` is a full sentence built from the data:

> *"Match 12, Winners Round 2. Completed. Team Vega, seed 1, 2. Team Orion, seed 4, 1. Team Vega won
> and advances to Winners Round 3, match 29. Team Orion drops to Losers Round 2, match 41."*

> *"Match 29, Winners Round 3. Live now. Team Vega 1, Team Kite 1. Started 7:30 PM IST."*

> *"Match 45, Winners Round 4. Not yet played. Winner of match 29 versus winner of match 30.
> Scheduled 8:40 PM IST."*

> *"Match 7, Round 1. Bye. Team Nova advances without playing."*

The inner decorative fragments (`▎`, `✓`, the pulsing dot) are `aria-hidden="true"`.

**3. An explicit table alternative.** A toolbar toggle **Table view** (also linked from the top of
the bracket as a visually-hidden-until-focused link *"Skip to accessible table of this bracket"*)
renders the same data as a real `<table>` with `<caption>`, `<th scope="col">` and `<th scope="row">`:

| Match | Round | Entrant A | A | Entrant B | B | Status | Result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 12 | WB R2 | Team Vega (1) | 2 | Team Orion (4) | 1 | Completed | Vega → M29 · Orion → M41 |
| 29 | WB R3 | Team Vega (1) | 1 | Team Kite (5) | 1 | **Live** | — |
| 45 | WB R4 | Winner of M29 | — | Winner of M30 | — | Scheduled | — |

Table view is not a lesser experience hidden behind an a11y menu — it is offered to everyone (it is
genuinely the best way to scan results and to copy them into a WhatsApp message), which is what keeps
it from rotting. It is also the print stylesheet's rendering of a bracket.

**4. Live updates.** One `aria-live="polite" aria-atomic="true"` region per bracket view, updated at
most once every 10 s (batched), phrased as a whole sentence:
*"Score update. Match 29: Team Vega 2, Team Kite 1."* Score-change flashes are `aria-hidden`.
`aria-live="assertive"` is used **only** for the room-code reveal and for a conflict error.

**5. Colour-independent status encoding** (the enforced mapping):

| Status | Colour | Glyph | Text |
| --- | --- | --- | --- |
| Registration open | green | `+` in a circle | `Registration open` |
| Registration closing < 24 h | green + countdown | clock | `Closes in 6h 12m` |
| Scheduled / upcoming | cyan | calendar | `Starts 6:00 PM IST` |
| Live | red | pulsing dot | `LIVE` |
| Completed | slate | check | `Completed` |
| Cancelled | slate + strikethrough on the title | `×` | `Cancelled` |
| Winner (in a match) | amber left bar | `✓` | bold weight + `aria-label` says "won" |
| Eliminated | slate, 70 % opacity | `—` | `Eliminated in R2` |
| Payment pending | slate | rupee-clock | `Payment pending` |
| Queued (offline write) | slate | cloud-off | `Queued — will sync` |

---

## 9. Content model boundaries (what IA assumes about the data)

The IA is game-agnostic because **every game-specific string, field and rule comes from a game
record**, never from a component. A component may branch on `format` and on `scoring_model`, which
are enumerations, but never on a game slug. Anything a designer would want to vary per game lives in
`content/games/<slug>.json` and/or the `games` table:

The authoritative list of those fields is `docs/CONTENT.md` §2 and the `games` table in
`db/schema.sql`; this document does not re-declare them. The three enumerations a component **may**
branch on are:

- `category` — `esport` | `board` | `outdoor`
- `scoring_model` — `h2h_simple` | `h2h_sets` | `h2h_innings` | `br_points` | `manual`
- `format` — `single_elim` | `double_elim` | `round_robin` | `swiss` | `points_lobby` (plus
  `multi_stage` on the tournament row, which means "render the stage selector")

Everything else — labels, in-game ID field, points table, equipment list, rules summary, accent
colour — is read from the game record.

**Adding "Ludo" to the platform is: one object in `content/games.json` + `npm run seed:games`. Zero component changes.** If a reviewer
finds a `if (game === 'bgmi')` anywhere in the UI, that is a bug against this document.

---

## 10. Social sharing surface

Covered visually in `docs/DESIGN.md` §10; the IA obligations are:

- Every shareable view has a **Share** control that uses `navigator.share` where available and falls
  back to copy-to-clipboard with a toast. The share payload is always
  `{ title, text, url }` with a WhatsApp-shaped `text` (2 short lines + the URL).
- **Copy for WhatsApp** appears on: tournament overview, bracket (current round summary), room code,
  final standings, and a player's own result. It copies pre-formatted plain text with `*bold*`
  WhatsApp markup, e.g.:

  ```
  *BGMI Diwali Cup* — LIVE
  Match 3 of 6 · Team Vega leading with 42 pts
  nellore.club/t/bgmi-diwali-cup/
  ```
- OG images: `tournaments.og_image_url` if the organizer supplied one, else one of six prebuilt
  static PNGs at `/og/cat-esport.png`, `/og/cat-board.png`, `/og/cat-outdoor.png`, `/og/default.png`,
  `/og/leaderboard.png`, `/og/player.png`. There is no per-game PNG and no runtime renderer in v1.
- Poster uploads (v1.1, not v1): R2 bucket, hard limits enforced at the Worker — ≤ 300 KB, ≤ 1600 px
  on the long edge, JPEG/PNG/WebP only, re-served with `Cache-Control: immutable` under a
  content-hashed key. Rejected: on-the-fly resizing — `images: { unoptimized: true }` means there is
  no optimizer, so the limit must be enforced at ingest or the OG image becomes the heaviest asset
  on the site.

---

## 11. Dependencies on other design areas

Assumptions this document makes. If any is wrong, this document is wrong.

1. `GET /api/v1/tournaments/<slug>/overview` returns the tournament header **and** the current-round summary
   **and** the top of the standings in one response, so a WhatsApp landing costs one round trip.
2. Every GET response carries a strong `ETag` and honours `If-None-Match`, and carries `X-NC-Now`
   (server epoch seconds) for clock-skew correction.
3. Match write endpoints implement optimistic concurrency via the `result_version` integer in the
   request body and a `409 stale_version` response.
4. A score write, a status transition and bracket generation are each a single `D1.batch()` (chunked
   at 200 statements); there is no observable half-applied state.
5. `GET /api/v1/organizer/matches/:id/impact` exists and returns the exact downstream match list the
   correction sheet renders (it is the engine's dry-run recompute).
6. Bracket seeding/pairing is exposed as a pure function shared by the client preview and the server
   generator, so the seeding preview cannot disagree with the generated bracket.
7. The Worker can do **one** D1 read per shell request within the subrequest/CPU budget, and can
   memoise it in the Cache API for 30 s.
8. `slug_redirects(from_slug, to_slug)` exists for 301s after a rename (Worker dispatch step 9).
9. Join codes (`/j/<code>/`), invite codes (`/i/<code>/`) and room codes use an alphabet that
   **excludes `0 O 1 I L`** — they are read aloud in a noisy hall and typed on a phone keyboard.
10. Payments in v1 are UPI-intent + manually verified UTR; the schema keeps `payment_provider`,
    `payment_ref` and `payment_status` so a gateway can be added later.
11. Notifications in v1 are **in-page + `.ics` calendar download only** (no email, no SMS, no push). The
    `/me/settings/` screen reserves a **Match reminders** toggle; if free Web Push (VAPID direct to
    the browser push service, no paid vendor) is added later, that toggle drives it and the
    subscription lives in a `push_subscriptions` table. No UI copy in v1 may promise a notification
    the platform cannot send.
12. Organizer bootstrap is via a Worker secret (per `docs/AUTH.md`); `/admin/` renders a
    **"You don't manage anything yet"** state rather than a 403 page for a signed-in non-organizer.

---

## 12. Open questions for the owner

1. Is there one physical venue (address on `/venue/`) or several? The schedule UI currently assumes
   a `venue` string plus an optional `court/table/lobby` label per match.
2. Should player **phone numbers** be collected at registration? It is the club's real-world contact
   channel, but it is personal data with no provider to use it, and collecting it triggers
   DPDP-Act-shaped obligations. Current design: **optional**, captain only, never displayed publicly.
3. Season boundaries for the leaderboard: calendar year, or half-year (`2026-h2`)? The URL scheme
   assumes a string season key either way.
4. Is Telugu content authored per-tournament (`name_te`, `rules_te`) or only for static UI strings?
   The design supports both; the admin form only exposes `name_te` today.
