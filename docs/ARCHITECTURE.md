# nellore.club — canonical architecture

**Status: normative, and it is the tie-breaker.** Five specs were written in parallel and they
contradicted each other. This document is the reconciliation. Where any other document in `docs/`
disagrees with this one about a name, an enum value, a route, a type or a unit, **this one wins** —
except that `db/schema.sql` wins over even this document about DDL, because it is the only artifact
with enforced constraints. §5 lists every contradiction that was found and how it was settled; the
losing files have already been edited.

Read this first. Then read the deep doc for whichever part you are building (§8).

---

## 1. What this is

**nellore.club is a tournament platform for a game club in Nellore, Andhra Pradesh.** It runs the
whole life of an event — a player creates an account with a passkey, registers solo or as a squad,
pays an entry fee by UPI and types the UTR, checks in at the venue, and watches a bracket that an
organiser advances from their phone while standing in a hall on bad 4G. It is deliberately
**game-agnostic**: BGMI, chess, carrom, badminton, box cricket and kabaddi are twenty rows in one
`games` table and zero branches in application code, and a twenty-first game is one JSON object and
a seed command. It is mobile-first for mid-range Android on patchy 4G, money is in INR paise, times
are shown in IST, and the entire distribution channel is WhatsApp — which is why link previews are
treated as a P0 feature and not a nicety.

---

## 2. Stack and runtime model

| Layer | Choice | Non-negotiable because |
| --- | --- | --- |
| Frontend | **Next.js 15 + React 19, `output: 'export'`**, `trailingSlash: true`, `images: { unoptimized: true }` | Matches the owner's proven stack (sandhyachess.club, optoads.com). Every page is prerendered HTML; there is **no SSR and no Node runtime at request time**. |
| Edge | **Cloudflare Workers Static Assets** serving `./out`, with `worker/index.ts` in front at `run_worker_first: true` | The Worker owns security headers, cache headers, `/api/*`, clean-URL rewrites and WhatsApp meta injection. Static export cannot pre-generate a page per tournament; the Worker is what makes `/t/<slug>/` exist. |
| Data | **Cloudflare D1** (SQLite), `STRICT` tables | No stored procedures, thin `ALTER TABLE`, `.batch()` as the only transaction primitive, capped result sets, a per-request subrequest and CPU budget. All of that is baked into `db/schema.sql` and Appendix D of `API.md`. |
| Auth | **WebAuthn passkeys** (SimpleWebAuthn v13, WebCrypto, no `nodejs_compat`) + one-time recovery codes | There is no email provider and no SMS provider, and the owner must not have to buy one to launch. Email OTP exists but is off behind `EMAIL_OTP_ENABLED` and degrades to `501 email_auth_disabled`. |
| Styling | **Tailwind CSS 3.4**, CSS-variable tokens, no `dark:` variants anywhere | One copy of every utility; the whole site's CSS budget is 14 KB gz. |
| Types | **TypeScript strict**, `noUncheckedIndexedAccess`, two tsconfigs (app + worker) | The Worker runs on workerd; the DOM lib must never leak into it. |
| Deploy | `npm run build && wrangler deploy` | `build` = `next build && node scripts/csp-hashes.mjs`. Running `next build` alone ships a site that will not hydrate under the enforced CSP. |
| **Plan** | **Cloudflare Workers Paid, $5/month.** Not the free tier. | Two hard requirements, both stated elsewhere and neither satisfiable on free: (1) `generateBracket + resolveBracket` is budgeted at **15 ms** for 256 entrants (§9.15) against the free plan's **10 ms** CPU cap — the single most important organiser action would not complete; (2) `run_worker_first` plus live polling puts a 3-hour event at roughly 60,000–70,000 Worker invocations (API.md §8.4) against a free ceiling of 100,000/day, so one event nearly exhausts the day and two exceed it, with the site erroring mid-final. Paid gives 30 s CPU and 10 M requests/month included. **AUTH.md's earlier "on the free plan the limit is 10 ms per request" premise is deleted**; the HMAC-not-PBKDF2 decision (AUTH.md §4.2) still stands on its own merits — a slow KDF is a cost-amplification vector on any plan — but it is no longer justified by a limit that does not apply. |

### 2.1 The one constraint that shapes everything

`output: 'export'` means **there is no page per tournament**. The build emits a fixed set of HTML
files that know nothing about D1. Three consequences drive the entire design:

1. Dynamic URLs are **Worker rewrites onto a small set of prerendered "shell" documents**.
   `/t/bgmi-diwali-2026/bracket/` and `/t/carrom-open-2026/standings/` are the *same* HTML file.
2. A shell's raw HTML contains no tournament, so a naive implementation hands WhatsApp a generic
   preview and the user a blank screen. Both are fixed by **`HTMLRewriter` injection in the
   Worker**, not by prerendering. (Prerendering per tournament by dumping D1 at build time was
   rejected: it makes `wrangler deploy` depend on a remote D1 read from the owner's laptop, and a
   tournament created after the last deploy would 404 at exactly the moment its link is being
   shared.)
3. **Every data-backed view must survive a failed fetch.** "Spinner forever" is a bug, not a state.

### 2.2 Request lifecycle — a static page (`/tournaments/`)

```
Browser → Cloudflare edge → Worker (run_worker_first)
  dispatch steps 1–9 all miss (not http:, not www, not /healthz, not /api/, not /og/,
                               not /shell/, GET is allowed, no short-link match)
  step 10: /tournaments/ matches no rewrite pattern
  step 12: env.ASSETS.fetch(request) → out/tournaments/index.html
           (html_handling: "auto-trailing-slash" resolves it with no redirect)
  step 13: security headers + per-page CSP script hashes from worker/csp-hashes.json
           Cache-Control from cachePolicyFor('static-html', 200)
             = public, max-age=0, must-revalidate, s-maxage=3600, stale-while-revalidate=86400
           X-Request-Id, X-NC-Now
→ HTML paints with zero JS. Then React hydrates and fetches /api/v1/tournaments for the list.
```

**Zero D1 reads.** A static page that hits the edge cache never reaches the Worker's D1 binding.

### 2.3 Request lifecycle — `/t/bgmi-diwali-2026/bracket/`

```
Browser (or the WhatsApp crawler — the path is identical, there is NO UA sniffing)
  → step 9: is 'bgmi-diwali-2026' in slug_redirects? Only if the slug regex passed first —
            an unfiltered lookup is a free DoS on the subrequest budget. Miss.
  → step 10: /t/<slug>/<tab>/ matches, <tab>='bracket' is in the allowed set
             a) ONE indexed D1 read for the preview record (title, summary, game, status,
                starts_at, fees, counts, state_version, og_image_url), memoised in
                caches.default for 30 s under a key derived from the slug
             b) env.ASSETS.fetch('/shell/tournament/index.html')  ← internal subrequest,
                never a browser redirect; the address bar keeps the real slug
             c) stream it through HTMLRewriter, REPLACING the content attribute of the
                placeholder <title>/<meta og:*>/<link canonical> tags the shell already ships
                (never appending — a duplicate og:title gives crawlers a coin flip),
                and inserting the <script type="application/json" id="__nc_boot"> island
                (≤ 2 KB, header record only, NEVER the bracket)
             d) Cache-Control: public, max-age=0, must-revalidate, s-maxage=60,
                                stale-while-revalidate=600
                ETag: "shell.<state_version>"
  If the D1 read fails or the slug is unknown → serve the shell UNMODIFIED, still 200.
  A 500 on a shared link loses a tournament; a generic preview is just a bad day.
→ Header paints from HTML alone at ~0.7 s on Slow 4G: name, game badge, LIVE pill, prize, venue.
→ React hydrates, reads #__nc_boot (header does not repaint), and fires ONE request:
     GET /api/v1/tournaments/bgmi-diwali-2026/bracket
→ Live polling starts on the server-supplied Poll-After cadence (API.md §8.4).
```

### 2.4 Request lifecycle — `GET /api/v1/tournaments/:slug/bracket` during a live final

```
400 phones in a hall, all polling.
  EVERY poll is a Worker invocation. run_worker_first means the Worker sits in
  FRONT of Cloudflare's cache, so a Response the Worker constructs is NOT stored
  in the zone cache — s-maxage on it is honoured by browsers and downstream
  caches, but it collapses nothing at the edge by itself.
  What collapses the load is caches.default, which API.md §8.5 makes MANDATORY
  on every public GET. It saves the D1 read and the JSON assembly, not the
  invocation.

  Worker step 5 → API router (Appendix C of API.md, first match wins).
    5a. rate limit (RL_READ). A 429 here touches neither D1 nor the cache.
    5b. If-None-Match: "118.b" present?
          SELECT state_version, status FROM tournaments WHERE slug = ?   ← ONE row
          Match → 304 + ETag + Cache-Control + Poll-After. STOP. ~200 bytes.
    5c. caches.default lookup, COOKIE-FREE key. Hit → serve. ZERO D1.
    5d. Miss → entrants + matches (+ match_participants for points_lobby) in one
        .batch(); assemble the tree in JS. 2 subrequests, 3-4 statements.

  Cache write uses a cookie-free key and a STRING body:
       const body = JSON.stringify(payload);
       ctx.waitUntil(cache.put(key, new Response(body, cacheHeaders)));
       return new Response(body, responseHeaders);
  NEVER cache.put(key, response.clone()) — that pattern silently truncated a JS bundle on
  optoads.com with no console error. Two Responses from one string costs nothing.
  cacheHeaders must NOT contain X-NC-Now: it is the clock every countdown is
  computed against and a cached one is minutes stale (API.md §8.5 rule 3).
  Step 13 re-stamps it fresh on every response, cache hits and 304s included.
```

Per poll: **1 Worker invocation, always**; **0–1 D1 statements** in the steady state (0 on a
`caches.default` hit, 1 on a 304, 3–4 on a genuine change). A 32-team knockout final therefore stays
under **~15 D1 queries per minute at any audience size** — but a 3-hour event is still on the order
of 60,000–70,000 invocations, which is why §2 pins the paid plan.

That arithmetic is why SSE and WebSockets were rejected (`API.md` §8.4): they convert a cacheable
request into a *long-lived* billable one and remove even the D1 saving, to solve a problem that a
conditional GET plus `caches.default` already solves at hundreds — not tens of thousands — of
viewers.

One thing not to build on: **Cloudflare's Cache API does not implement `stale-while-revalidate`.** A
`cache.match` hits or misses on the entry's own freshness. `IA.md` §4's promise that "the 401st
person is served instantly from a stale copy" holds in the **browser** cache and in the SPA's
`localStorage` layer, which already deliver it — not in `caches.default`.

---

## 3. Repository layout

```
/
├── next.config.mjs           output:'export', trailingSlash, images.unoptimized. Do not add rewrites.
├── package.json              build = `next build && node scripts/csp-hashes.mjs`
├── tsconfig.json             the app half (DOM lib, jsx). EXCLUDES worker/.
├── tailwind.config.ts        DESIGN.md §5 verbatim. content globs: app, components, lib, content.
├── postcss.config.js
├── vitest.config.ts          node env; include lib/**/*.test.ts and worker/**/*.test.ts
├── wrangler.jsonc            §7. assets + D1 + ratelimit bindings + cron + vars.
│
├── app/                      Next App Router. EVERY file here is a prerendered static page.
│   ├── layout.tsx            <html lang="en">, fonts, theme bootstrap, nav, footer, skip link
│   ├── globals.css           the CSS-variable token layer + @layer components (.nc-focus, .nc-hit)
│   ├── page.tsx              /                  home
│   ├── live/                 /live/             everything happening right now
│   ├── tournaments/          /tournaments/      filterable list
│   ├── games/                /games/ and /games/[slug]/ (generateStaticParams over content/games.json)
│   ├── leaderboard/          /leaderboard/
│   ├── search/               /search/
│   ├── signin/ join/ recover/                   passkey auth pages, fully client-side
│   ├── me/                   /me/ and children  static shells, all data client-fetched
│   ├── about/ venue/ contact/ code-of-conduct/ fair-play/ privacy/ terms/ refunds/
│   │                         pure content from content/club.json, zero JS needed
│   ├── offline/              service-worker navigation fallback
│   ├── not-found.tsx         → out/404.html, served by not_found_handling:"404-page"
│   └── shell/                THE THREE SPA SHELLS. Never linked. Worker 404s /shell/** directly.
│       ├── tournament/       ← /t/<slug>/{,bracket,standings,teams,schedule,rules,register,checkin,entry}/ and /m/<n>/
│       ├── player/           ← /p/<handle>/
│       └── admin/            ← /admin/**   (noindex, private no-store, no injection)
│
├── components/
│   ├── ui/                   DESIGN.md §6 primitives. No data fetching, no router, no API import.
│   ├── data/                 DataView (the 5-state machine), poller, localStorage cache, freshness chip
│   ├── public/               home/list/leaderboard/game-page composites
│   ├── tournament/           bracket viewer (Rounds/Follow/Map), standings, match sheet, check-in
│   ├── account/              auth sheets, /me screens, credential + session management
│   └── admin/                wizards, registrations, seeding, live scoring, correction sheet
│
├── lib/                      ISOMORPHIC. Runs in the browser AND in workerd. No DOM, no D1.
│   ├── bracket/              THE ENGINE. Pure, zero-dependency, zero-I/O. See BRACKET-ENGINE.md.
│   ├── types/                the shared wire + row types. The contract between app and worker.
│   ├── format/               IST dates, INR money, WhatsApp share text, relative time
│   ├── content/              typed loaders for content/games.json and content/club.json
│   ├── router/               the hand-rolled history.pushState router the three shells use.
│   │                         next/link and next/navigation are FORBIDDEN under app/shell/**
│   │                         (§4 rule 7) — under output:'export' the App Router client router
│   │                         fetches an RSC payload that does not exist for a rewritten URL.
│   └── api/                  the typed fetch client: envelopes, errors, CSRF, idempotency, ETags
│
├── worker/                   workerd only. Its own tsconfig; no DOM lib.
│   ├── index.ts              the 13-step dispatch order (API.md Appendix A) and the cron handler
│   │                         (AUTH.md §10.1–§10.9 — eleven jobs, each its own batch)
│   ├── router.ts             the ordered route table (API.md Appendix C), first match wins
│   ├── csp-hashes.json       GENERATED by scripts/csp-hashes.mjs. Never hand-edited.
│   ├── lib/                  headers, cache policy, CSP, HTMLRewriter injection, markdown→AST,
│   │                         rate limiting, idempotency, crypto (HMAC/AES-GCM), ULID, errors
│   ├── db/                   the ONLY code that touches D1. prepare().bind() always.
│   └── api/                  handlers: auth/, public/, me/, organizer/, admin/
│
├── content/
│   ├── games.json            20 games, 3 categories, 15 field presets. Authoring source of truth.
│   └── club.json             identity, story, contact, FAQ, code of conduct, policies, TODO_VERIFY
│
├── db/
│   ├── schema.sql            THE schema. Authoritative for every name, type and enum.
│   ├── migrations/           0001_init.sql is a byte-for-byte copy of schema.sql at launch.
│   └── seed.sql              a season row, a venue, and nothing else. Games come from the seeder.
│
├── docs/                     this file plus the eight deep specs (§8)
│
├── public/
│   ├── og/                   the six static 1200×630 PNGs. No per-game art in v1.
│   ├── robots.txt            Disallow: /shell/  /admin/  /api/
│   ├── sitemap.xml           static pages only — /t/<slug>/ is not knowable at build time
│   ├── manifest.webmanifest
│   └── sw.js                 ~2 KB service worker. skipWaiting is OFF.
│
└── scripts/
    ├── seed-games.ts         content/games.json → D1. Idempotent, validates every CHECK in JS first.
    ├── csp-hashes.mjs        scans out/**/*.html, emits worker/csp-hashes.json, FAILS on unhashable
    ├── og-cards.mjs          SVG → the six PNGs. Run by hand, output committed.
    └── budget-check.mjs      per-route transfer budget from DESIGN.md §9. CI-blocking.
```

---

## 4. Module boundaries and dependency direction

```
                  content/*.json          db/schema.sql
                        │                       │
                        ▼                       ▼
   ┌─────────────────────────────────────────────────────────┐
   │  lib/  (isomorphic, no I/O)                             │
   │    types/  ◄── everything                               │
   │    bracket/  ── imports NOTHING but lib/bracket/*        │
   │    format/, content/                                     │
   │    api/     ── imports lib/types only                    │
   └───────────┬──────────────────────────────┬──────────────┘
               │                              │
   ┌───────────▼───────────┐      ┌───────────▼──────────────┐
   │  app/ + components/   │      │  worker/                 │
   │  (browser)            │      │  (workerd)               │
   │   ui/ ◄ data/ ◄ feat. │      │   index ► router ► api/  │
   │   never imports worker│      │   api/ ► db/ ► D1        │
   └───────────────────────┘      └──────────────────────────┘
```

Rules, enforced by ESLint `no-restricted-imports` and a CI grep:

1. **`lib/bracket/` imports nothing.** Not `app/`, not `worker/`, not `lib/db`, not a single npm
   package. No `Math.random`, no `Date.now`, no `Intl`, no `localeCompare`, no `toLocaleString`.
   Every export is a pure function or a type. This is what lets the seeding preview in the browser
   and the bracket generated in the Worker be provably the same computation.
2. **`worker/db/` is the only module that touches D1**, and every statement is
   `prepare(...).bind(...)`. String-interpolated SQL is forbidden everywhere, including migrations
   and admin tooling.
3. **`components/ui/` never fetches.** It takes props. `components/data/` owns loading, caching,
   polling and error states; feature components compose the two.
4. **`app/` never imports from `worker/`.** The only contract between them is `lib/types` and HTTP.
5. **`dangerouslySetInnerHTML` appears in exactly ONE file: `app/layout.tsx`, for the theme
   bootstrap.** Rich text arrives as a closed-allowlist JSON AST and is rendered through a `switch`
   into real React elements — that rule is absolute and unchanged. The single exception exists
   because `DESIGN.md` §2.1 requires a blocking inline script in `<head>` that sets
   `document.documentElement.dataset.theme` before first paint, and in **React 19 that is the only
   way to emit an inline `<script>` with arbitrary JS**: `<script>{'…'}</script>` runs the string
   through React's text escaper, so `&&`, `<` and quotes come out HTML-escaped and the script is
   syntactically broken. The alternatives are worse in ways that are visible on the first page load:
   moving it to `public/theme.js` pays a render-blocking round trip (~400 ms RTT on the target
   network) on every cold view, and dropping it gives every dark-mode user a white flash on every
   navigation. It is also the stable inline script the CSP-hash strategy needs something to hash.

   The exception is bounded, and the bound is mechanical:
   - the content is a **compile-time string literal with no interpolation** — if it contains the
     substring `${` the build fails;
   - **CI allowlists that one occurrence by the exact sha256 of the script's bytes** and fails on
     any other occurrence of `dangerouslySetInnerHTML` anywhere in the tree;
   - `scripts/csp-hashes.mjs` asserts the theme script's sha256 is present in **every** page's hash
     list in `worker/csp-hashes.json`. A page that somehow does not carry it is a build failure, not
     a runtime flash.
6. **No component branches on a game slug.** `if (game.slug === 'bgmi')` is a build failure. A
   component may branch on `category`, `scoring_model` and `format` — three closed enums — and
   nothing else.
7. **`next/link`, `next/navigation`'s `useRouter` / `redirect` / `notFound`, and `next/router` are
   forbidden anywhere under `app/shell/**`.** Add them to the `no-restricted-imports` list and add a
   CI grep. Under `output: 'export'`, the App Router's client router resolves a navigation by
   fetching the target route's RSC payload; for a Worker-rewritten URL like `/t/<slug>/bracket/` the
   Worker either 404s the `.txt` sibling or returns the injected HTML shell for the `?_rsc=` form,
   neither of which is a valid RSC payload — so the router falls back to a **full document load**.
   `<Link>` also prefetches on viewport entry, so `/tournaments/` rendering 20 cards would fire 20
   RSC requests that all miss. See `IA.md` §2.2.1 for the hand-rolled `history.pushState` router
   that replaces it, and for the rule that any link *into* a rewritten URL from a prerendered page
   is a plain `<a href>`.

---

## 5. Contradictions found and how they were settled

Every row below was a real disagreement between two or more of the five parallel specs. The losing
files have been edited; this table is the record, not a to-do list.

### 5.1 The big ones

| # | Contradiction | Resolution | Why |
| --- | --- | --- | --- |
| 1 | Identity table: `players`/`player_id` (`db/schema.sql`, 35 refs) vs `users`/`user_id` (`API.md`, `AUTH.md`, `SECURITY.md`, 79 refs incl. copy-paste SQL) | **`users` / `user_id`.** `db/schema.sql` rewritten. | "Player" is already the domain word for a human in a roster (`entrant_members`); reusing it for the account table is what made three documents diverge. Three docs and every normative SQL snippet used `users`; renaming one file beats rewriting three. |
| 2 | `db/schema.sql` and `API.md` Appendix E described **two different databases** (Appendix E named 12 tables the schema did not have; the schema had 6 the API never mentioned) | **`db/schema.sql` is the schema, rewritten to be the union.** Appendix E is now a reader's index onto it, explicitly non-authoritative. | Only one artifact has enforced constraints and only one is what `wrangler d1 execute` runs. A prose table that can drift from the DDL is a bug generator. Added: `handle_reservations`, `venues`, `invites`, `slug_redirects`, `match_audit`, `idempotency_keys`, `rate_counters` (renamed from `rate_limits`), plus ~40 columns the API needed. |
| 3 | Match advancement: `matches.winner_to_match_id` / `loser_to_match_id` (schema, push-based) vs `a_source_kind` / `a_source_match_id` (engine, pull-based fold) | **Source pointers.** Destination pointers deleted. | The engine never advances incrementally; it re-derives every participant by folding forward over the skeleton. A destination pointer only serves a push-based advance, whose rollback path is the least-tested code in every tournament product and the classic way a live bracket gets corrupted in front of an audience. With source pointers, correcting a score two rounds back is the *same code path* as entering it. |
| 4 | Tournament **format** enum: `br_points` (schema, `content/games.json`) vs `points_lobby` (engine, API) vs `br_points_series` (IA) | **`points_lobby`.** Schema + 3 game rows + `$formats` edited. | `br_points` is already the **scoring model** value; using the same string on two different axes is how `IA.md` ended up putting a scoring model in a `"format"` field. `points_lobby` also survives the game-agnostic test: a ten-team quiz round scored by points is a `points_lobby`, and is not "battle royale". |
| 5 | Match **status**: `pending/ready/live/completed/bye/cancelled/disputed` (schema) vs `pending/ready/live/complete/bye/void` (engine, API) | **`pending / ready / live / complete / bye / void`.** `disputed` dropped. | The fold produces exactly these six; a seventh value the engine never emits would be written by hand and immediately overwritten by the next recompute. A dispute is an organiser act (reopen + a public `reason`), not a match state. |
| 6 | Per-set detail lived in **both** a `match_games` table (schema) and `matches.result_detail_json` (engine) | **`result_detail_json` only.** `match_games` deleted. | Two homes for the same fact is a synchronisation bug waiting for a cricket match. The engine consumes only `score_a`/`score_b` plus an opaque `detail` it never inspects — that contract is precisely what keeps one code path serving cricket runs, chess results, Valorant maps and badminton sets. |
| 7 | Lobby participants: `lobby_entrants` (schema) vs `match_participants` (engine, API) | **`match_participants`**, keeping the schema's richer computed-points columns. | Two docs to one, and the API's validation error strings already name it. |
| 8 | Scores typed `REAL` (engine, API "chess uses halves, accepts 0.5 steps") vs `INTEGER` ("no REAL columns, ever" — schema, CONTENT) | **`INTEGER` everywhere.** Chess is 2/1/0 with `stages.points_divisor = 2`. | Standings sorting compares points for equality at every tiebreak step. Float equality is where "these two are tied" quietly becomes "not tied" at the third decimal — on a projector, in front of the two players. |
| 9 | Timestamps: epoch **milliseconds** (engine) vs epoch **seconds** (schema, API) | **Unix seconds** in storage and in `X-NC-Now`; RFC 3339 `…Z` on the wire. | Two time units in one system has no upside and one obvious failure mode. |
| 10 | Leaderboard award formula used floats: `TIER × (0.6 + 0.4·log2(N)/7) × PLACE_TABLE[p]` | **All-integer**: `floor(weightPct × FIELD_MILLI[nextPow2(N)] × PLACE_TABLE[p] / 100000)`. | The engine already refuses to compute `1000/p**0.8` at runtime because `Math.pow` is not correctly rounded (`32**0.8` misrounds in V8). `Math.log2` has exactly the same problem, and the doc reintroduced it two sections later. A leaderboard that differs between the Worker and the browser preview is unacceptable. |
| 11 | `tournaments.tier` (`casual/standard/major/championship`, engine) vs `leaderboard_weight_pct INTEGER 0..500` (schema) vs `leaderboard_weight: 1.0` float (API) | **`leaderboard_weight_pct`, integer.** Tiers survive as create-form shorthand for 50/100/150/200. | An integer percent is strictly more expressive than four named bands, needs no lookup table, and keeps rule 8. |
| 12 | ID format: bare 26-char ULID (schema) vs prefixed `trn_<ulid>` (API) with prefixes of mixed length | **Prefixed ULID, uniformly 30 chars**: 3-char prefix + `_` + 26-char ULID. `cred_` → `crd_`. Every table has `CHECK (id GLOB 'xxx_*' AND length(id) = 30)`. | Prefixes make logs and error reports readable and make an ID pasted in the wrong field fail at the database. A uniform length makes the CHECK a one-liner and the parser trivial. |
| 13 | Persistent teams: `teams` + `team_members` + `GET /teams/:slug` + `/team/<slug>/` + a fourth SPA shell (API, IA) vs no such thing anywhere else | **Cut from v1.** Two tables, one shell, one page, one endpoint and `/me/teams/` all removed. | `API.md` itself flagged it as possibly-v2. A squad is `entrants` + `entrant_members`; the captain's inputs prefill from `users.profile_answers_json`, so re-registering next month is three taps rather than a membership model with invites, renames and a disband policy. This removed a whole workstream. |
| 14 | Auth tables defined twice with different columns (`AUTH.md` §10 DDL vs `db/schema.sql` §1) | **Merged into `db/schema.sql`**, keeping AUTH.md's superset. | The schema's `sessions` was missing `csrf_token`, `epoch`, `scope`, `uv`, `auth_at`, `idle_expires_at`, `absolute_expires_at` — every column AUTH.md's predicate table reads. Not a naming dispute; the schema simply could not run the auth design. Also: `credentials` → `webauthn_credentials`, `sign_count` → `counter`, `transports` → `transports_json`, `email_otp_codes` → `email_otps`, and recovery codes moved from PBKDF2 + `code_prefix` to HMAC + pepper (one indexed lookup, no candidate scan, no CPU-amplification vector). |

### 5.2 Enum and vocabulary conflicts

| Concern | Was | Now |
| --- | --- | --- |
| Game **category** | `esport\|board\|outdoor` (schema, content) · `esports\|board\|outdoor` (API) · `esports\|mind\|outdoor` (IA) | **`esport` \| `board` \| `outdoor`** |
| Tournament **status** | schema lacked `archived`; API lacked `check_in`; engine had a private `draft\|open\|locked\|running\|completed\|cancelled` | **`draft, published, registration_open, registration_closed, check_in, live, completed, cancelled, archived`** |
| Entrant **status** | schema had `no_show` but not `checked_in`; API had `checked_in` but not `no_show`; engine had `active\|withdrawn\|disqualified` | **`pending, confirmed, waitlisted, checked_in, withdrawn, disqualified, no_show`**; the engine's `active` = "not `withdrawn` and not `disqualified`" |
| Stage **status** | `pending\|seeding\|live\|completed\|cancelled` vs `pending\|running\|complete`, plus an undeclared `recomputing` the engine needs for chunked recompute | **`pending, seeding, live, recomputing, completed, cancelled`** |
| Match **result kind** | `outcome: a\|b\|draw\|wo_a\|wo_b\|double_forfeit\|no_contest` (schema) · `method + is_draw + winner_entrant_id` (engine) · `normal\|walkover\|double_forfeit\|retirement\|disqualification\|no_result` (OPERATIONS) | **`method ∈ normal, walkover, forfeit, dq, no_contest`** plus `is_draw` and `winner_entrant_id`. `outcome` deleted. Retirement = `forfeit` + the score at retirement. Double forfeit and abandonment = `no_contest`. |
| **Payment status** | `not_required\|pending\|submitted\|paid\|refunded\|waived` (schema) vs `unpaid\|paid\|waived\|refunded` (API) | schema's six |
| **Participant type** | `participant_type: solo\|team` (schema, content) vs `entry_mode: solo\|team\|either` (API) | **`participant_type: solo \| team`.** No game used `either`. |
| **Roster size** | `roster_max` (schema) vs `substitutes_max` (API, content) | **`substitutes_max`**; roster size is `team_size_max + substitutes_max`, computed where needed |
| **Seeding method** | `manual\|random\|registration_order\|rating` (schema) vs `registration\|random\|manual\|rating\|previous_stage` (content, stages) | **`registration, random, manual, rating`** on `tournaments`; `+ previous_stage` on `stages` |
| **Tiebreak chain terminator** | every game's list ended in `random` | **`seed`.** 20 game rows + `$tiebreakers` edited. The engine re-seeds to a dense 1..N, so `seed` is a guaranteed total order — no coin flips, no dependence on input order or Unicode collation. |
| **Handle regex** | `3..24 chars` (schema) · `^[a-z0-9][a-z0-9_]{2,19}$` (API) · `^[a-z0-9_]{3,20}$` (IA) | **`^[a-z0-9][a-z0-9_]{2,19}$`** |
| **Slug regex** | `3..80` (schema) vs `^[a-z0-9][a-z0-9-]{1,40}$` (API) | **`^[a-z0-9][a-z0-9-]{1,40}$`**, with a 28-char soft budget enforced by the admin form's counter |
| Column vs wire drift | `check_in_opens_at`/`require_check_in`/`allow_guest_entrants` (schema) vs `checkin_opens_at`/`requires_checkin`/`allow_guest_registration` (API, AUTH, IA) | schema renamed to the wire names — **one name, no translation layer to get wrong** |
| `matches.station_label` vs `matches.table_label` | both | **`station_label`** — "Court 2" / "Board 5" / "Table 3" is the game-agnostic noun, which is the whole point |
| `stages.stage_no` vs `stages.ordinal` | both | **`ordinal`** |
| `matches.index_in_round` vs `position` | both | **`position`**, 0-based |
| Slug aliases | `tournament_slug_alias(old_slug, tournament_id)` (IA) vs `slug_redirects(from_slug, to_slug)` (API) | **`slug_redirects`** |
| Rate-limit table | `rate_limits(key, …)` (schema) vs `rate_counters(bucket, key, …)` (API) | **`rate_counters`** for long windows; short windows use the Workers Rate Limiting binding and never touch D1 |
| Leaderboard storage | `leaderboard_awards` (engine) · `points_ledger` + `leaderboard_entries` (schema) · `leaderboard_contributions` + `leaderboard_entries` (API) | **`points_ledger`** (append-only, signed, voidable) + **`leaderboard_entries`** (materialised) |
| Leaderboard `period` | `all_time \| year:2026 \| season:<slug> \| rolling_90d` (API) vs `season_id` (schema) | **`all_time` \| `season:<season_slug>`.** A rolling window needs a rollup job nobody is building, and `year:` is a season by another name. |
| Session cookie | `nc_session` (API §0.10) vs `__Host-nc_session` (AUTH, SECURITY) | **`__Host-nc_session`** (`nc_session_dev`, no `Secure`, when `ENVIRONMENT != "production"`) |
| Recovery code count | 8 (IA Journey 2) vs 10 (AUTH) | **10** |
| Auth page URL | `/signin/` (IA) vs `/login/` (AUTH §12) | **`/signin/`** — IA owns page URLs |

### 5.3 Route conflicts

| Was | Now | Why |
| --- | --- | --- |
| `GET /api/v1/t/<slug>/overview`, `/t/<slug>/matches/<n>/impact`, `POST /t/<slug>/matches/<n>/correct`, `GET /t/<slug>/bracket/preview` (IA) — none of which exist in `API.md` | Canonical paths are `GET /api/v1/tournaments/:slug/overview`, **`GET /api/v1/organizer/matches/:id/impact`** (new, §4.14.1), `PUT /api/v1/organizer/matches/:id/score?confirm=1`, **`POST /api/v1/organizer/tournaments/:id/bracket/preview`** (new, §4.14.2) | IA needed a correction-impact preview and a seeding preview; the engine already provides both as dry-run folds. They were unowned, so they are now specified in `API.md`. `/api/v1/t/` was a shorthand and is not a route. |
| Guest URL `https://nellore.club/t/<slug>/entry/?g=<token>` (API §3.4) with `entry` **absent** from the Worker's `<tab>` allowlist | `entry` added to the allowlist in `IA.md` §2.2 and `API.md` Appendix A step 10 | A live bug: every guest's saved check-in link would have 404'd. |
| Admin routes: `/admin/tournaments/new/`, `/admin/t/<slug>/payments/`, `/disputes/`, `/payouts/`, `/print/` (CONTENT, OPERATIONS) vs IA's shorter set | One canonical list (§6.2). `payments` folded into `registrations`, `disputes` into `audit`, `payouts` into `results`; `checkin` and `print` added to IA — `print` is the entire offline disaster plan and had no home | Fewer screens, and every path referenced by any doc now exists. |
| Optimistic concurrency: `If-Match: <version>` header (IA) vs `result_version` in the body (API) | **`result_version` in the body**, plus `Idempotency-Key`. They are not redundant: a retry of the *same* attempt must replay as success (bad 4G); a *different* attempt built on stale data must be rejected (two organisers at the scorer's table). | |
| OG images: `/og/games/<slug>.png` (API) vs six category cards (DESIGN) vs `cat-esports`/`cat-mind` (IA) | **Exactly six**: `default`, `cat-esport`, `cat-board`, `cat-outdoor`, `player`, `leaderboard` | Twenty per-game PNGs is a launch-blocking art task for an 80 px thumbnail. The title and description do the work in a WhatsApp card and are already per-tournament. |
| Game icons: a required `public/icons/games.svg` sprite (CONTENT) vs "**Rejected: an SVG sprite**" (DESIGN §7) | **No sprite.** `games.icon_url` seeds as `NULL`; a game renders as its category glyph tinted with `accent`, next to `short_name`. `emoji` stays for WhatsApp text and the printed pack. | DESIGN's argument is correct — an extra request with a 400 ms RTT penalty, render-blocking above the fold — and this keeps "add a game = one JSON object" literally true. |
| Dynamic OG rendering: `OG_DYNAMIC=1` + `workers-og` (API) vs "Rejected for v1" (DESIGN §10) | **`OG_DYNAMIC` is documented but never implemented in v1**; the Worker's `/og/t/` branch always 302s to the static card | Both docs can be right: the flag is the upgrade path, the 302 is the product. |
| Shells: four (`tournament`, `player`, `team`, `admin`) | **Three** — `team` removed with the team model | |

### 5.4 Things that looked like conflicts and are not

- **`/api/v1/organizer/*` and `/api/v1/admin/*` are separate namespaces even though `IA.md` puts
  both behind one `/admin/**` page surface.** The URL namespace encodes *privilege*; the page
  namespace encodes *navigation*. One authenticated shell calls both.
- **`br_points` (scoring model) and `points_lobby` (format) are different axes.** BGMI is
  `scoring_model: 'br_points'` and `format: 'points_lobby'`. Rummy is `scoring_model: 'manual'` and
  `format: 'points_lobby'`.
- **`standings.match_points.no_result` / `walkover_win` / `forfeit_loss` are stage scoring
  settings**, not `matches.method` values. They ride in `stages.scoring_config_json` and tell the
  standings engine what to award; `method` tells it what happened.
- **`entrants.checked_in` (a status) and `entrants.checked_in_at` (a timestamp) both exist and are
  not redundant.** A checked-in entrant can later be withdrawn; the timestamp is the record of when
  they showed up, the status is where they are now. The two are not constrained against each other.

---

## 6. Canonical vocabulary

**This section settles all disputes.** If code, a doc or a comment uses a word that is not here,
it is wrong.

### 6.1 Entities

| Entity | Table | One-line definition |
| --- | --- | --- |
| **User** | `users` | A person with an account. Identified publicly by `handle`, at `/p/<handle>/`. Roles: `player`, `organizer`, `admin`. |
| **Game** | `games` | A template of defaults, never an authority. Seeded from `content/games.json`. |
| **Season** | `seasons` | A date range that scopes the leaderboard. Exactly one `is_active` (`ux_seasons_active`), and it is the `NOT NULL` parent of `points_ledger.season_id` — so `POST /organizer/tournaments` resolves it at creation and `publish` refuses with `409 no_active_season` if there is none. Managed at `GET/POST/PATCH /api/v1/admin/seasons`. |
| **Venue** | `venues` | A physical or online place. Managed at `POST/PATCH/DELETE /api/v1/admin/venues`; `DELETE` is a soft delete to `is_active = 0`. |
| **Tournament** | `tournaments` | One event, at `/t/<slug>/`. Owns a snapshot of the game definition taken at creation. |
| **Stage** | `stages` | The shape authority — the engine reads stages, never `tournaments.format`. Every tournament has ≥ 1; a plain 8-player knockout has exactly one and the organiser never sees the word. Groups → playoffs is two. **Created, edited, seeded and round-paired through `/api/v1/organizer/tournaments/:id/stages` and `/api/v1/organizer/stages/:id/{,seed,rounds}`** (API.md §4.23) — without those, multi-stage and both progressive formats have no runnable path. Carries `skeleton_json` (loaded, never re-derived) and `points_divisor`. |
| **Stage entrant** | `stage_entrants` | Who is in which stage. `seed` is the **canonical dense 1..N** order from `Skeleton.seedList`, immutable after generation; `group_no` is derived output, never an input. |
| **Entrant** | `entrants` | One entry. **Always internally a team**, including a solo chess entry (a team of one), so the engine, standings and leaderboard have zero solo/team branches. |
| **Entrant member** | `entrant_members` | A human on a roster. May or may not be linked to a `users` row. |
| **Match** | `matches` | One bracket node. For `points_lobby`, one *lobby* is one match with N participants. |
| **Match participant** | `match_participants` | A squad's line in a `points_lobby` match. |
| **Standing** | `standings` | A materialised row per `(stage, entrant)`. |
| **Award** | `points_ledger` | One append-only, signed, voidable leaderboard award to a **user**. |

### 6.2 Routes

**Public pages** (prerendered). `/live/` is backed by `GET /api/v1/live`, `/search/` by
`GET /api/v1/search`, and the two nav tab badges by `counts` on `GET /api/v1/config` — none of the
three had a data source before, and `/api/v1/admin/stats` is admin-only and must never feed a public
page:
`/` · `/live/` · `/tournaments/` · `/games/` · `/games/<gameSlug>/` · `/leaderboard/` · `/search/` ·
`/signin/` · `/join/` · `/recover/` · `/me/` `/me/registrations/` `/me/security/` `/me/settings/` ·
`/about/` `/venue/` `/contact/` `/code-of-conduct/` `/fair-play/` `/privacy/` `/terms/` `/refunds/` ·
`/offline/` · `/404/`

**Worker-rewritten** (onto three shells):

| URL | Shell | Injected |
| --- | --- | --- |
| `/t/<slug>/` and `/t/<slug>/<tab>/` where `<tab> ∈ {bracket, standings, teams, schedule, rules, register, checkin, entry}`, and `/t/<slug>/m/<matchNo>/` | `/shell/tournament/index.html` | yes |
| `/p/<handle>/` | `/shell/player/index.html` | yes |
| `/admin/**` | `/shell/admin/index.html` | **no** — `private, no-store`, `X-Robots-Tag: noindex` |

**Admin sub-routes** (client-side, all one shell):
`/admin/` · `/admin/t/new/` · `/admin/t/<slug>/` · `/registrations/` · `/checkin/` · `/seeding/` ·
`/score/` · `/schedule/` · `/results/` · `/audit/` · `/print/` · `/admin/games/` · `/admin/people/`

**Short links:** `/j/<code>/` → 302 `/t/<slug>/register/` (a `kind='join'` invite) ·
`/i/<code>/` → 302 `/t/<slug>/register/?invite=<code>` (a `kind='roster'` invite, redeemed via
`GET /api/v1/invites/:code` then `POST /api/v1/invites/:code/accept`). Alphabet
`23456789BCDFGHJKMNPQRSTVWXYZ` — no `0 O 1 I L`, no vowels, because the code is read aloud in a
noisy hall. A join code is looked up **`AND tournament_id = t.id`**, never by `code_hash` alone —
the `UNIQUE` on `code_hash` is global, so an unscoped lookup lets a code for one event open another.

**API:** base `https://nellore.club/api/v1`. Full table in `API.md` Appendix C, matched in that
exact order (`/tournaments/:slug/register` before `/tournaments/:slug`;
`/organizer/stages/:id/{seed,rounds}` before `/organizer/stages/:id`).

**The one route whose `:id` is not an id:** `GET /api/v1/organizer/tournaments/:id` also accepts a
**slug**, disambiguated on the `trn_` prefix, because `IA.md` addresses the whole organiser page
surface by slug (`/admin/t/<slug>/score/`) while every organiser endpoint is addressed by id. No
other route does this.

`/shell/**` returns 404. `/t` and `/p` bare redirect to `/tournaments/` and `/leaderboard/`.

### 6.3 Identifiers

Every primary key is a **prefixed ULID, exactly 30 characters**: `<3-char prefix>_<26-char Crockford
base32 ULID>` — 48 bits of millisecond timestamp + 80 bits of CSPRNG.

```
trn_01JB2KQ8ZT4R9V6M0X3H7C1N2P
```

| Prefix | Entity || Prefix | Entity |
| --- | --- || --- | --- |
| `usr_` | user || `mad_` | match audit row |
| `ses_` | session || `led_` | points ledger row |
| `crd_` | WebAuthn credential || `aud_` | audit log row |
| `rec_` | recovery code || `ann_` | announcement |
| `otp_` | email OTP || `inv_` | invite / join code |
| `gam_` | game || `ven_` | venue |
| `sea_` | season || `stg_` | stage |
| `trn_` | tournament || `ent_` | entrant |
| `mat_` | match || `mem_` | entrant member |

Generated in the Worker so a whole bracket, including its cross-referencing source pointers, is
written in one `.batch()`. 80 bits of randomness makes enumeration infeasible, which is half the
IDOR defence (the other half is the predicate check, which is mandatory anyway). The timestamp
prefix keeps them lexicographically sortable, which makes cursor pagination a plain `WHERE id < ?`.

**Tournaments are addressed publicly by `slug` and privately by `id`.** Public URLs must be pretty
and shareable on WhatsApp; organiser URLs must survive a rename.

**Not a ULID:** `matches.code` (the engine's own `W2-3`, `L4-1`, `GF`, `GF2`, `G1R3-2`, `S4-7`,
`P2-L3` — unique per stage), `webauthn_challenges.challenge` (base64url), and the composite keys of
`match_participants`, `standings`, `tournament_organizers`, `stage_entrants`, `player_ratings`,
`idempotency_keys`, `rate_counters`, `settings`, `slug_redirects`, `handle_reservations`.

### 6.4 Time

| Layer | Representation |
| --- | --- |
| D1 | `INTEGER`, **unix seconds, UTC**, column suffix `_at`. Never TEXT, never milliseconds. |
| Engine | `number`, unix seconds. |
| Wire | **RFC 3339 UTC with a `Z`**: `"2026-11-08T13:30:00Z"`. Never a local-time string, never a non-`Z` offset, never a bare epoch — with one exception. |
| The exception | `X-NC-Now`, a response header on **every** response, carrying server epoch **seconds**. The client computes `skew = X-NC-Now − Date.now()/1000` once and renders every countdown as `target − (Date.now()/1000 + skew)`. Mid-range Android clocks are routinely minutes wrong, and a check-in countdown that lies is worse than no countdown. If `|skew| > 120` the UI says so. |
| Display | IST (UTC+05:30, no DST), always with an explicit `IST` suffix, via `Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata' })`. **The server never formats a date for display** — except the `og:description` line, which is assembled server-side in IST because that string is read inside WhatsApp where no JS runs. |

### 6.5 Money

`INTEGER` **paise**, 1 INR = 100 paise, field and column names always end in `_paise`.
`entry_fee_paise: 20000` is ₹200. The API never emits a formatted currency string; the client uses
`Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 })`,
which produces the Indian `₹1,00,000` grouping for free.

**Why paise when every fee is a whole rupee.** D1's `ALTER TABLE` support is a thin subset of
SQLite's, so changing a money column's meaning later means a table rebuild with a data migration on
a live database. A ₹49.50 early-bird fee or a payment gateway would force exactly that. Paise costs
one multiplication today and removes a migration forever.

`content/games.json` authors whole rupees (`entry_fee_inr_default`); the seed script multiplies by
100. **The API must reject `entry_fee_paise > 0` while neither `tournaments.upi_vpa` nor
`settings['club.upi_vpa']` is set** — otherwise a player's ₹200 goes to a stranger.

### 6.6 Closed enums

```
users.role                 player | organizer | admin
users.status               active | suspended | banned | deleted
                           ↑ THE moderation gate. The session predicate `S` requires
                             status = 'active' (AUTH.md §7.2). suspended_until is only
                             the auto-lift timestamp; NULL means "never auto-lift",
                             i.e. indefinite, and must not be read as "not suspended".
sessions.scope             full | recovery
                           ↑ a recovery session may enrol a credential without uv = 1
                             (AUTH.md §7.3.1); it is the redeemed code that authenticates.
tournament_organizers.role owner | organizer | scorer | moderator
                           ↑ READ BY THE PREDICATES, not decorative. AUTH.md §7.2 defines
                             ORG_OF (any non-revoked staff row), FULLORG_OF (owner|organizer
                             only — contact lookups, contact CSV, payment fields, publish,
                             reopen) and OWNER_OF. Every one of them also requires
                             revoked_at IS NULL, so the DELETE that soft-revokes actually
                             removes authority.

games.category             esport | board | outdoor
games.scoring_model        h2h_simple | h2h_sets | h2h_innings | br_points | manual
tournaments.format         single_elim | double_elim | round_robin | swiss | points_lobby | multi_stage
stages.format              single_elim | double_elim | round_robin | swiss | points_lobby
participant_type           solo | team
venue_mode                 online | onsite | hybrid

tournaments.status         draft | published | registration_open | registration_closed
                           | check_in | live | completed | cancelled | archived
tournaments.visibility     public | unlisted | private
stages.status              pending | seeding | live | recomputing | completed | cancelled
entrants.status            pending | confirmed | waitlisted | checked_in
                           | withdrawn | disqualified | no_show
entrants.payment_status    not_required | pending | submitted | paid | refunded | waived
stage_entrants.status      active | eliminated | advanced | withdrawn | disqualified

matches.bracket            W | L | GF | RR | SW | BR
      → wire projection    winners | losers | grand_final | groups | swiss | series
matches.status             pending | ready | live | complete | bye | void
matches.method             normal | walkover | forfeit | dq | no_contest
matches.side_a             W | B | NULL              (chess colours only)
slot source kind           entrant | winner | loser | none
resolveSlot() result       ENTRANT(id) | STRUCTURAL_NULL | UNDETERMINED
                           ↑ ENGINE-INTERNAL, three-valued, and the distinction is
                             load bearing: only STRUCTURAL_NULL makes a bye or a void.
                             UNDETERMINED forces `pending` at step 0 of the fold.
                             Collapsing the two renders a freshly generated bracket
                             entirely void and auto-advances a bye recipient into a
                             semi-final. BRACKET-ENGINE.md §7.2, §7.3.

seeding_method             registration | random | manual | rating          (tournaments)
stages.seed_source         registration | random | manual | rating | previous_stage
payment_mode               free | upi_manual | at_venue
announcements.scope        club | tournament
announcements.severity     info | important | urgent
points_ledger.reason       placement | participation | bonus | penalty | adjustment
match_audit.kind           result_set | result_corrected | result_cleared | status_forced
leaderboard period         all_time | season:<season_slug>

tiebreak tokens            points | wins | fewest_losses | played | head_to_head
                           | score_diff | score_for | set_ratio | net_run_rate
                           | kills | best_placement
                           | buchholz | buchholz_cut1 | sonneborn_berger | seed
                           (these are the snake_case tokens content/games.json and
                            stages.tiebreakers_json author. The engine's camelCase
                            TiebreakKey and the ONE map between them are
                            BRACKET-ENGINE.md §4.2. An unknown token is
                            E_INVALID_OPTIONS — never a silently dropped comparator,
                            because a dropped comparator produces a wrong table that
                            looks right and decides who qualifies.
                            Every chain terminates in `seed`; the engine appends it
                            unconditionally, so no chain is ever partial and nothing
                            is ever decided by a coin flip.)
```

`set_ratio`, `net_run_rate` and `buchholz_cut1` are **required**, not optional: without
`net_run_rate` a six-team cricket group with two teams on 4 points cannot be resolved, and without
`set_ratio` neither can a badminton group. Eight of the twenty shipped games name one of them.

- **`set_ratio` = `floor(1000 × scoreFor / max(1, scoreAgainst))`**, computed from `scoreA`/`scoreB`
  (which §1.4 of the engine already requires to be sets won for a set-scored game). No
  `result_detail_json` read.
- **`net_run_rate`** needs overs, which are not `scoreA`/`scoreB`. They are **engine inputs**, not
  `result_detail_json` reads: `HeadToHeadResult` carries optional `oversFacedMilliA` /
  `oversFacedMilliB` integers that the **API layer** parses out of the innings fields and passes in
  (BRACKET-ENGINE.md §4.2.2). That preserves the game-agnostic contract — one
  `if (game === 'cricket')` inside `tiebreak.ts` would end "a new game is a row, not a code change".

Rational tiebreaks are stored **×1000 as integers** and **may be negative** (net run rate routinely
is). Storage is `standings.tiebreak_1..5` — **five** slots, not three: chess ships four tiebreaks
past `points` (`buchholz_cut1, buchholz, sonneborn_berger, head_to_head`) and round robin's default
has four, so three slots could not reconstruct a chess or carrom standings row for `GET
.../standings`'s `columns` array. **Normatively, exactly the first five comparators after `points`
are persisted and emitted as columns**; a longer chain still sorts, but the surplus is not stored
and `W_TIEBREAKS_TRUNCATED` is emitted.

```
points arithmetic          INTEGERS ONLY, end to end.
                           PointsConfig = { win, draw, loss, walkoverWin, forfeitLoss, noResult },
                           every value an integer pre-multiplied by options.pointsDivisor.
                           Chess = { 2, 1, 0, 2, 0, 1 } with pointsDivisor 2, displayed 1/0.5/0.
                           stages.points_divisor MUST equal options.pointsDivisor.
                           standings.points and standings.tiebreak_1..5 are INTEGER in a
                           STRICT table: a 4.5 is a hard SQLite error that rolls back the
                           whole score-write batch, i.e. no chess event could be scored.
                           BRACKET-ENGINE.md §4.3.
walkover scoring           options.walkoverScore defaults to [null, null] — a walkover records
                           NO SCORE. A notional 2-0 pollutes net_run_rate and set_ratio and
                           decides a group on a match nobody played. [ceil(bestOf/2), 0] is an
                           explicit per-stage opt-in. Points come from walkoverWin /
                           forfeitLoss; an abandonment is no_contest scoring noResult to both.
```

### 6.7 Derived state, and who is allowed to write it

| Column(s) | Written only by | Source of truth |
| --- | --- | --- |
| `matches.entrant_a_id`, `.entrant_b_id`, `.status`, `.winner_entrant_id`, `.loser_entrant_id` | the `resolveBracket` recompute diff | `(skeleton, entrants, recorded results)` |
| **`matches.result_entrant_a_id`, `.result_entrant_b_id`** | **the score endpoint, once, at the instant the result is recorded — NEVER the recompute diff** | the organiser's submission. These are *not* derived; they are the participants **as recorded**, and they are the sole source of `HeadToHeadResult.entrantAId`/`entrantBId`. Sourcing that from the derived columns would make the invalidation check compare the recompute against its own previous output, and §14.4's chunked correction makes the difference reachable (BRACKET-ENGINE.md §7.4). |
| `stages.skeleton_json`, `.skeleton_hash` | bracket generation, **once**, never rewritten (a progressive stage appends a round) | `generateBracket()`. The recompute **loads** this and never re-derives — re-deriving after any withdrawal yields a smaller N and fires `E_SKELETON_DRIFT` on the normal flow. |
| `stage_entrants.seed` | bracket generation, from `Skeleton.seedList`; immutable thereafter | the canonical dense 1..N order (BRACKET-ENGINE.md §6.1 step 5). Every tiebreak chain ends in it, so drift makes standings order irreproducible. |
| `stage_entrants.group_no` | the generator's `snakeAssign` output | **derived output** — never fed back as `Entrant.groupHint`. That input is `entrants.group_hint`. |
| `standings.*` | the standings recompute, in the **final** chunk of the same `.batch()` sequence as the score write | matches + stage points config |
| `points_ledger` | `POST .../publish` (append-only), voided by `unpublish` | the engine's award list, one row per **linked roster member** |
| `leaderboard_entries.*` | `POST .../publish` and `POST /admin/leaderboard/rebuild`, always as `SUM(points)` over `points_ledger WHERE voided_at IS NULL` — never written from the award list directly | `points_ledger` |
| `tournaments.entrant_count`, `.confirmed_count`, `.checked_in_count`, `.waitlist_count` | the same batch as the entrant mutation | `entrants` |
| `tournaments.state_version` | **any** mutation visible under `/api/v1/tournaments/<slug>/*` | — |
| `match_participants.placement_points`, `.kill_points`, `.total_points` | the lobby-result handler, from the scoring config | placement + kills + bonus |

**`state_version` is the HTTP cache validator.** Every bump of `bracket_version` must bump
`state_version` in the same `.batch()`. One tournament has one `state_version`, so an announcement
invalidates the bracket's ETag too. That over-invalidation is accepted: the alternative is six
version columns, six places to remember, and one day a bracket that does not update because
somebody forgot one. Over-invalidation costs a wasted 15 KB; under-invalidation puts a wrong score
on a projector.

**Leaderboard attribution (previously unowned, now settled):** the engine awards the **entrant**;
the persistence layer writes one `points_ledger` row per **linked roster member**, each for the
**full** award, not a split. Four squadmates who won a BGMI cup all won a BGMI cup; splitting 829
points four ways would rank a solo chess player above every member of the winning squad. Unlinked
guest members get nothing — which is also the strongest nudge in the product towards making an
account.

---

## 7. Environment, bindings and secrets

`wrangler.jsonc`:

```jsonc
{
  "name": "nellore-club",
  "main": "worker/index.ts",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": [],              // NO nodejs_compat. SimpleWebAuthn v13 is Workers-native.

  // WITHOUT THESE the Worker deploys to *.workers.dev only and never serves
  // nellore.club — so the OG/WhatsApp strategy, which is the entire
  // distribution channel, reaches nothing, and API.md Appendix A step 2's
  // www -> apex 301 never runs because www never reaches this Worker.
  "routes": [
    { "pattern": "nellore.club/*",     "zone_name": "nellore.club" },
    { "pattern": "www.nellore.club/*", "zone_name": "nellore.club" }
  ],

  "assets": {
    "directory": "./out",
    "binding": "ASSETS",
    // ARRAY form, not `true`. `true` routes EVERY request through the Worker,
    // including every /_next/static/** chunk, every font and every OG PNG, so
    // one cold page view costs 15-20 Worker invocations instead of 1. The
    // prefixes below are exactly the paths that need Worker logic: the API, the
    // three rewritten shells, the short links, the OG route and the health
    // check. Everything else is served by the asset worker.
    "run_worker_first": [
      "/api/*", "/t/*", "/p/*", "/admin/*", "/j/*", "/i/*", "/og/t/*", "/healthz"
    ],
    "html_handling": "auto-trailing-slash",
    "not_found_handling": "404-page"
  },

  "d1_databases": [
    { "binding": "DB", "database_name": "nellore-club", "database_id": "<from wrangler d1 create>" }
  ],

  // "ratelimits" — PLURAL — and the per-entry key is "name", NOT "binding".
  // Verified against node_modules/wrangler/config-schema.json (wrangler 4.111):
  // RawConfig has no `ratelimit` property at all, and unknown top-level keys are
  // a WARNING, not an error. So `"ratelimit": [{ "binding": ... }]` deploys
  // cleanly and leaves env.RL_READ ... env.RL_SCORE all `undefined`, at which
  // point env.RL_READ.limit(...) throws and EVERY endpoint returns 500 on the
  // first request — a total outage whose cause looks like application code.
  "ratelimits": [
    { "name": "RL_READ",        "namespace_id": "1001", "simple": { "limit": 300, "period": 60 } },
    { "name": "RL_AUTH_BEGIN",  "namespace_id": "1002", "simple": { "limit": 20,  "period": 60 } },
    { "name": "RL_AUTH_VERIFY", "namespace_id": "1003", "simple": { "limit": 10,  "period": 60 } },
    { "name": "RL_RECOVERY",    "namespace_id": "1004", "simple": { "limit": 5,   "period": 60 } },
    { "name": "RL_REGISTER",    "namespace_id": "1005", "simple": { "limit": 5,   "period": 60 } },
    { "name": "RL_GUEST",       "namespace_id": "1006", "simple": { "limit": 5,   "period": 60 } },
    { "name": "RL_GUEST_TOKEN", "namespace_id": "1007", "simple": { "limit": 30,  "period": 60 } },
    { "name": "RL_WRITE",       "namespace_id": "1008", "simple": { "limit": 60,  "period": 60 } },
    { "name": "RL_SCORE",       "namespace_id": "1009", "simple": { "limit": 30,  "period": 10 } },
    { "name": "RL_AUTH_READ",   "namespace_id": "1010", "simple": { "limit": 120, "period": 60 } },
    { "name": "RL_ENGINE",      "namespace_id": "1011", "simple": { "limit": 20,  "period": 60 } }
  ],

  "triggers": { "crons": ["0 20 * * *"] },   // 01:30 IST — the nightly cron, AUTH.md §10
  "observability": { "enabled": true },
  "vars": { /* below */ }
}
```

**`assertEnv(env)` (§7.2) must assert that every `RL_*` binding above is present and has a
`.limit` function**, and fail startup if not. The whole point is that a config regression fails
loudly at boot with a named binding rather than at 7 p.m. on the first player request.

The Workers Rate Limiting binding only supports 10 s and 60 s windows and is per-colo. That is fine
for the buckets above — they exist to stop scripted abuse, not to meter an API. **Per-hour and
per-day limits** (`rl_export`, `rl_contact`, `rl_me_export`, `rl_register_ip`, `rl_recovery_user`)
genuinely need to be global, so they use the `rate_counters` D1 table instead; those endpoints are
all low-frequency. One helper in `worker/lib/ratelimit.ts` owns both paths.

**What narrowing `run_worker_first` costs, stated honestly.** `/_next/static/**`, `/og/*.png`,
fonts and `robots.txt` are now served by the asset worker, so the Worker's `cachePolicyFor()` and
security-header pass (API.md Appendix A step 13) **do not run on them**. That is acceptable and in
two cases better:

- Hashed assets under `/_next/static/**` already get `public, max-age=31536000, immutable` from the
  assets layer, which is exactly what §8.2 wanted.
- A CSP on a JS chunk or a PNG does nothing — `script-src` governs the *document* that loads it.
- What is genuinely lost is `X-Content-Type-Options` and `Cross-Origin-Resource-Policy` on static
  assets. Both are worth having; neither is load bearing when every asset is same-origin, immutable
  and served with a correct `Content-Type` by Cloudflare. If a future audit wants them, add
  `"/_next/*"` back to the array and accept ~15 extra invocations per cold page view.
- `out/**/*.html` for the **prerendered** pages is also no longer Worker-processed, so those pages
  lose their per-page CSP hashes. **This is the one that matters**, and it is why the array keeps
  `/t/*`, `/p/*` and `/admin/*` (the shells, which carry the injected content) — the prerendered
  marketing and content pages render no user input at all (`about`, `privacy`, `games`, …), so
  `script-src 'self'` from the `_headers`-equivalent default is sufficient for them. If
  `scripts/csp-hashes.mjs` ever finds an inline script on a page **not** covered by the array, it
  must fail the build; add that assertion to the script.

### 7.1 Vars (non-secret, in `wrangler.jsonc`)

| Var | Default | When unset |
| --- | --- | --- |
| `ENVIRONMENT` | `"production"` | **Fail startup.** It gates the dev cookie name and the localhost origin allowlist; guessing is not acceptable. |
| `SITE_ORIGIN` | `"https://nellore.club"` | Fail startup. It is the `Origin` allowlist and the base of every absolute OG URL. |
| `SIGNUP_OPEN` | `"1"` | Treated as `"1"`. `"0"` → `POST /auth/passkey/register/*` returns `403 signup_closed`; existing users still sign in. |
| `EMAIL_OTP_ENABLED` | `"0"` | Treated as off. `/auth/email/*` returns `501 email_auth_disabled` and `GET /auth/config` reports `email_otp: false`. **This is the launch state.** |
| `EMAIL_PROVIDER` | unset | Email stays off even if `EMAIL_OTP_ENABLED=1`. Both must be set, plus `EMAIL_API_KEY`. |
| `EMAIL_FROM` | unset | Same. |
| `EMAIL_OTP_ALLOW_SIGNUP` | `"0"` | Email OTP can sign an existing user in but cannot create an account. |
| `OG_DYNAMIC` | `"0"` | **Never set in v1.** `/og/t/*` always 302s to the static category card. |
| `CSP_MODE` | `"enforce"` | `"report-only"` emits `Content-Security-Policy-Report-Only` instead. Use it for one deploy after a CSP change, never longer. |
| `TURNSTILE_SITE_KEY` | unset | `GET /api/v1/config` reports `turnstile: false` and the guest-registration form renders no widget. Guest registration still works, one abuse layer weaker. |
| `ALLOW_INTL_PHONE` | `"0"` | Phone numbers must start `+91`. |

### 7.2 Secrets (`wrangler secret put`, never in any file)

| Secret | When unset | Rotation cost |
| --- | --- | --- |
| `SESSION_PEPPER` | **Fail startup.** Sessions cannot be verified. | Logs everyone out. Only on suspected compromise. |
| `RECOVERY_PEPPER` | **Fail startup.** | Invalidates every recovery code. Tell users first. |
| `GUEST_PEPPER` | **Fail startup.** | Invalidates every live guest link; organisers re-issue. |
| `INVITE_PEPPER` | **Fail startup.** | Invalidates unused join codes. |
| `IP_HASH_KEY` | **Fail startup.** Rate limiting and audit would have to store raw IPs, which the DPDP posture forbids. | Yearly. Resets long-window counters; acceptable. |
| `PII_KEY` | **Fail startup** if any phone column is non-null; otherwise phone collection is disabled and `requires_phone` tournaments are refused at creation. | Needs a re-encryption migration. |
| `PHONE_INDEX_KEY` | Same as `PII_KEY`. | Needs a re-index migration. |
| `OTP_PEPPER` | Required only when email OTP is on. | Free — 10-minute TTL. |
| `ADMIN_BOOTSTRAP_TOKEN` | `GET /auth/bootstrap/status` returns `{available:false}` and the bootstrap ceremony 404s. **This is the correct steady state** — delete the secret after the first admin exists. | n/a |
| `EMAIL_API_KEY` | Email stays off. | n/a |
| `TURNSTILE_SECRET_KEY` | Turnstile verification is skipped entirely (not failed open at a check — the check is not registered). | n/a |

**"Fail startup"** means a single `assertEnv(env)` at the top of `fetch()` that throws a
`503 database_unavailable`-shaped error with a distinct `request_id` and logs which name is missing.
It must be impossible for the Worker to serve a request with a missing pepper and silently write
unverifiable hashes.

Also assert at startup: `ENVIRONMENT === "production"` ⟹ the dev cookie branch is unreachable and
`SITE_ORIGIN` is `https:`.

---

## 8. Where the depth is

| Document | Authoritative for |
| --- | --- |
| **`db/schema.sql`** | Every table, column, type, enum and index. Beats every prose doc, including this one. |
| **`docs/BRACKET-ENGINE.md`** | Generation, the resolve fold, seeding, byes, the double-elim pair-flip drop mapping, Swiss pairing, lobby scoring, score correction, standings, leaderboard points, and 18 test sections with literal oracles. |
| **`docs/API.md`** | Every URL under `/api/v1`, methods, status codes, envelopes, the 40-value error enum, pagination, idempotency, ETags and the polling contract, the Worker dispatch order (Appendix A), the route table (Appendix C), the D1 budget rules (Appendix D). |
| **`docs/AUTH.md`** | WebAuthn ceremonies, recovery codes, sessions, the epoch, CSRF, step-up, guest tokens, admin bootstrap, and the complete authorization predicate table (§7.3). |
| **`docs/SECURITY.md`** | Threat model, score tampering, IDOR, registration abuse, CSRF, the hash-based CSP for a static export, PII and DPDP, rate-limit policy, residual risks, the pre-launch checklist. |
| **`docs/CONTENT.md`** | The `FieldDef` type, `visibility` / `pii` / `profile_key`, `$preset` resolution, the five scoring models, the `games.json` → D1 projection, the seed script's required behaviour, editorial voice. |
| **`docs/IA.md`** | URL scheme, shells, boot injection, six user journeys, the bracket viewer's three view modes, the five-state data contract, offline behaviour, WCAG 2.2 AA. |
| **`docs/DESIGN.md`** | Colour with stated contrast ratios, type, spacing, the Tailwind config verbatim, the component inventory, icons, the per-route performance budget, OG cards, print. |
| **`docs/OPERATIONS.md`** | Capacity maths, the manual UPI/UTR flow, check-in, running a bracket from a phone, walkovers, disputes, publishing, the printed offline pack, the DPDP posture. |
| **`docs/BUILD-PLAN.md`** | The ordered implementation plan and file ownership. |

---

## 9. Non-goals — what v1 deliberately does not do

1. **No SSR, ever.** Not a single dynamic page render. If a feature needs SSR, it needs redesigning.
2. **No persistent teams.** No `teams` table, no `/team/<slug>/`, no membership handshake. A squad
   is typed per registration and prefilled from the captain's profile.
3. **No payment gateway.** UPI intent link + a typed 12-digit UTR, verified by a human against the
   bank statement. Razorpay/Cashfree need business KYC, a settlement account and per-transaction
   fees before the club has taken a rupee. The break-even is around 100 paid registrations a month;
   below that, manual wins. `entrants.payment_method` / `payment_ref` / `payment_status` are shaped
   so a gateway is an addition, not a migration.
4. **No email and no SMS on the critical path.** Passkeys + recovery codes. Email OTP is behind two
   env vars and a paid provider the owner does not have.
5. **No push notifications.** In-page state and an `.ics` download. `/me/settings/` reserves a
   *Match reminders* toggle; **no UI copy may promise a notification the platform cannot send.**
6. **No WebSockets, no SSE, no Durable Objects.** Conditional GET polling with `s-maxage=5`. The
   upgrade path is documented (`API.md` §8.4) and gated on a real event exceeding ~2,000 concurrent
   viewers.
7. **No image uploads.** No avatars, no team logos, no tournament posters. `images: { unoptimized:
   true }` means there is no optimizer, so any upload must be size-enforced at ingest and served
   from R2 — a whole subsystem for decoration. Avatars are deterministic identicons from a seed.
8. **No per-game icon art.** Category glyph + accent + short name.
9. **No dynamic OG image rendering.** Six static cards; the title and description carry the
   information and are already per-tournament and never stale.
10. **No ladder format, no seasons UI, no rolling leaderboard windows.** `all_time` and
    `season:<slug>` only.
11. **No i18n beyond the toggle's plumbing.** `<html lang="en">`, Telugu strings wrapped in
    `<span lang="te">`, a font stack that has Telugu in it, and `name_te` on a tournament. The UI
    string catalogue is not translated in v1.
12. **No admin "sign in as user", no admin endpoint that attaches a credential to another account,
    and no step-up on score entry.** Impersonation would destroy the non-repudiation that makes
    results credible, and biometric friction on the fortieth badminton result in ninety minutes gets
    worked around — and the workaround (a shared account on an unlocked laptop) is worse than the
    threat. Score integrity rests on the organiser predicate, the append-only `match_audit`, public
    "last updated by" attribution, and the audit log.
13. **No retroactive disqualification in elimination formats.** Erasing a player from a completed
    bracket means every match they won never happened, so their opponents should have advanced, so
    the whole downstream bracket — including matches other people actually played — is fictional.
    There is no correct automatic answer. The organiser uses a from-now DQ and settles prizes
    administratively. (Retroactive DQ **is** supported in round robin, Swiss and points lobbies.)
14. **Round robin is capped.** `E_INVALID_OPTIONS` for `round_robin` with N > 64 unless
    `groupCount` keeps every group ≤ 32. 256 entrants in one round robin is 32,640 matches; that is
    a footgun, not a feature.
15. **`MAX_ENTRANTS = 256` per stage**, and `generateBracket + resolveBracket` must stay under 15 ms
    for 256 entrants. (This is one of the two reasons §2 pins the paid plan: the free tier's 10 ms
    CPU cap cannot complete it.)
18. **`MAX_MATCHES_PER_TOURNAMENT = 1024`**, validated at `POST /organizer/tournaments/:id/bracket`
    and `POST /organizer/stages/:id/rounds` with `409 conflict`,
    `details.reason: "too_many_matches"`, `details.match_count`, checked before the first insert.
    The payload worst case is a **league, not a knockout**: 256 entrants in 8 groups of 32 is
    3,968 matches ≈ 715 KB of JSON on a query-free endpoint every phone in the hall polls, which
    also blows the 32 KiB idempotency-response cap and D1's per-query response ceiling. The same
    1024 is the `LIMIT` on the matches `SELECT` (API.md Appendix D rule 7), so a legal draw can
    never be silently truncated — the cap and the limit are deliberately the same number. Large
    leagues use `GET /tournaments/:slug/matches`, which is paginated.
19. **Club ratings are not implemented.** `player_ratings` exists so enabling them later is a flag,
    not a migration, but nothing writes it: `leaderboard?metric=rating` → `501`,
    `games[].rating` → always `null`, `seeding_method: 'rating'` and reseed `method: "rating"` →
    `400 validation_failed`. Deliberately a hard error rather than a fallback — "seed by club
    rating" degrading silently to registration order produces a wrong bracket that looks right,
    which nobody discovers until the draw is already on WhatsApp (API.md §1.12.2).
20. **No `/search/` beyond a bounded prefix match, and no member directory.** `GET /api/v1/search`
    matches players on a **`handle` prefix only**, never on `display_name`, and only where
    `profile_public = 1`.
16. **Rummy ships disabled.** `status: "disabled"`, `compliance.review_required: true`,
    `real_money_prizes_allowed: false` — which the API enforces as `entry_fee_paise = 0`. Andhra
    Pradesh restricts gaming for stakes. Enabling any card game needs written advice from a lawyer
    licensed in AP.
17. **Five `content/club.json` fields are blocking `null`s** (`contact.email`, `contact.phone`,
    `contact.whatsapp`, `policies.entry_fee.upi_id`, `policies.privacy_summary.grievance_officer`).
    `grep -rn TODO_VERIFY content/` is a pre-deploy gate. Until `upi_id` is set the API must refuse
    any tournament with `entry_fee_paise > 0`.
