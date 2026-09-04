# nellore.club — build plan

Read `docs/ARCHITECTURE.md` first. It is the tie-breaker for every name, enum, route and unit used
below.

This plan is written so that **eleven agents can work at once without ever touching the same file**.
Every path below is owned by exactly one workstream. If you need to change a file you do not own,
you do not change it — you open the question with whoever owns it, or you write the thing you need
inside your own boundary.

Two rules make the parallelism real:

1. **The foundation lands first and lands completely.** Everything else codes against types and
   primitives that already exist and compile. `npm run typecheck` must be green at the end of the
   foundation step, with placeholder files where a stream will later write the body.
2. **Placeholder files are part of the foundation's job.** The five API route modules, the three
   shell pages and `worker/csp-hashes.json` all exist as valid, compiling, empty things on day one.
   Nothing "cannot start because the file does not exist yet".

---

## Phase 0 — FOUNDATION (one agent, blocking, nothing runs in parallel with it)

**Why it is a phase and not a workstream:** design tokens, the Tailwind config, the shared UI
primitives, the API client and the shared TypeScript types are imported by five of the ten parallel
streams. If two streams create them, they will differ, and the merge is a rewrite. If one stream
creates them and the others wait, the parallelism is fiction.

### Owned files — exhaustive

**Build and config**
```
package.json                      deps + scripts (see below)
wrangler.jsonc                    ARCHITECTURE.md §7 verbatim
tailwind.config.ts                DESIGN.md §5 `extend` block verbatim
tsconfig.json                     add "paths": {"@/*": ["./*"]}; keep "exclude": ["worker", …]
eslint.config.mjs                 incl. the no-restricted-imports boundary rules (ARCHITECTURE §4)
.dev.vars.example                 every var and secret name, with throwaway values
.gitignore                        add: worker/csp-hashes.json is COMMITTED, do not ignore it
```
`next.config.mjs`, `postcss.config.js`, `vitest.config.ts` and `worker/tsconfig.json` already exist
and are correct. Do not change them.

`package.json` must end up with:
- `"build": "next build && node scripts/csp-hashes.mjs"` — `next build` alone ships a site that will
  not hydrate under the enforced CSP.
- `"seed:games": "tsx scripts/seed-games.ts"`, `"budget": "node scripts/budget-check.mjs"`.
- `db:*` scripts pointed at `db/schema.sql` and `db/seed.sql` (already present).
- **Dependencies** (runtime, not dev): `next`, `react`, `react-dom`, `clsx`,
  `@simplewebauthn/server@^13`, `@simplewebauthn/browser@^13`, `marked` (Worker write-time
  tokenizer only), `ulid`. The two `@simplewebauthn` packages are currently in `devDependencies` —
  they are Worker runtime code; move them.
- Do **not** add: any UI library, icon library, animation library, bracket library, date library,
  chart library, or `workers-og`. `DESIGN.md` §9 is a hard budget and CI enforces it.

**Design layer**
```
app/globals.css                   the CSS-variable token layer (DESIGN.md §2.2, §2.4, §2.5),
                                  @layer components { .nc-focus, .nc-hit }, .nums-tab,
                                  print stylesheet (DESIGN.md §11), scroll-padding rules
app/layout.tsx                    <html lang="en">, font loading (DESIGN.md §3.2), theme bootstrap
                                  script (must be hashable — it goes in csp-hashes.json), skip link,
                                  <header>/<nav>/<main id="main">/<footer> landmarks, the
                                  route-change focus+announce region (IA.md §8.1)
app/not-found.tsx                 → out/404.html
```

**Shared UI primitives — `components/ui/`, one file each**
```
Button.tsx  Input.tsx  Textarea.tsx  Select.tsx  Tabs.tsx  SegmentedControl.tsx  Card.tsx
StatusPill.tsx  GameBadge.tsx  Avatar.tsx  Sheet.tsx  Modal.tsx  Toast.tsx  ToastHost.tsx
Skeleton.tsx  EmptyState.tsx  Stepper.tsx  Countdown.tsx  CodeReveal.tsx  ShareBar.tsx
WizardProgress.tsx  OfflineBar.tsx  FreshnessChip.tsx  HoldToConfirm.tsx  Icon.tsx  icons.tsx
index.ts
```
`icons.tsx` is the 28 hand-rolled inline SVGs of `DESIGN.md` §7 — no icon package.
`HoldToConfirm` must ship the keyboard/AT dialog fallback and honour `prefers-reduced-motion`;
holding is never the only way (WCAG 2.2 §2.5.7).
**These components never fetch and never import `lib/api`.** They take props.

**Shared data layer — `components/data/`**
```
DataView.tsx        the five-state machine of IA.md §7.1. There is no sixth state and no
                    "spinner forever". Owns the 250 ms skeleton delay and the freshness chip.
useResource.ts      localStorage cache (nc:v1:<method>:<path>), If-None-Match, TTL table,
                    2 MB LRU eviction, try/catch around every localStorage call
usePoller.ts        ONE poller per slug per tab. Poll-After × jitter [0.85,1.15], ×1.5 on each
                    consecutive 304 capped at 120 s, 5 s floor, visibility gating, Retry-After
                    on 429, saveData/2g → off. API.md §8.4 is normative; implement it exactly.
useClockSkew.ts     from X-NC-Now. Every countdown in the product goes through this.
useOffline.ts       'offline' event OR two consecutive fetch failures (navigator.onLine lies)
index.ts
```

**Isomorphic library — `lib/`**
```
lib/types/api.ts        every wire type in API.md: envelopes, error codes (the closed 40-value
                        enum as a union), TournamentCard, PublicEntrant, PrivateEntrant, Match,
                        Standing rows, Game, Announcement, LeaderboardRow, AuthSession…
lib/types/db.ts         a row interface per table in db/schema.sql, hand-derived, plus every
                        enum from ARCHITECTURE.md §6.6 as a string-literal union
lib/types/index.ts
lib/format/datetime.ts  IST formatting, relative time, countdown strings, the `IST` suffix rule
lib/format/money.ts     paise → ₹, Indian digit grouping
lib/format/share.ts     the WhatsApp text composers (IA.md §10) — pure, unit-tested
lib/format/index.ts
lib/content/games.ts    typed loader + $preset resolution for content/games.json (build-time)
lib/content/club.ts     typed loader for content/club.json, with null-stat hiding
lib/api/client.ts       fetch wrapper: envelope unwrapping, typed errors, X-CSRF-Token,
                        Idempotency-Key, credentials:'same-origin', 401/403/409/429 handling
                        per AUTH.md §12
lib/api/endpoints.ts    one typed function per endpoint in API.md Appendix C
lib/api/index.ts
```

**Worker foundation — `worker/`**
```
worker/lib/env.ts       the Env interface AND assertEnv(): the startup check in ARCHITECTURE §7.2.
                        A missing pepper must be impossible to serve a request through.
worker/lib/errors.ts    the closed error-code enum → HTTP status map, ApiError
worker/lib/respond.ts   ok()/err()/noContent(): the ONE place an envelope is constructed
worker/lib/ids.ts       prefixed-ULID mint + parse + the 30-char/prefix validator
worker/lib/crypto.ts    HMAC-SHA256, AES-GCM, constant-time compare, base64url
worker/db/client.ts     prepare/bind/batch helpers, the ≤8-statement-per-request budget guard
                        (counting, and throwing in dev), and the 200-statement batch chunker
worker/api/auth/routes.ts        `export const routes: Route[] = []`   ← placeholder, owned by W3 after
worker/api/public/routes.ts      `export const routes: Route[] = []`   ← placeholder, owned by W4 after
worker/api/me/routes.ts          `export const routes: Route[] = []`   ← placeholder, owned by W5 after
worker/api/organizer/routes.ts   `export const routes: Route[] = []`   ← placeholder, owned by W5 after
worker/api/admin/routes.ts       `export const routes: Route[] = []`   ← placeholder, owned by W5 after
worker/csp-hashes.json           `{}` placeholder; scripts/csp-hashes.mjs regenerates it every build
```

**Shell placeholders** (so W7/W8/W9 have a file to fill and W2 has an asset to rewrite onto)
```
app/shell/tournament/page.tsx    renders the placeholder <head> tag set + an empty root
app/shell/player/page.tsx        ditto
app/shell/admin/page.tsx         ditto, no meta placeholders (never injected)
```
The tournament and player shells **must** ship a complete set of placeholder `<title>` /
`<meta og:*>` / `<link canonical>` / `<script id="nc-jsonld" type="application/ld+json">` tags with
stable ids. The Worker's `HTMLRewriter` **replaces attributes and never appends**; a shell missing a
tag means that tag silently never appears.

Two rules from `IA.md` §4.0 that the foundation must get right, because they are invisible locally
and only fail in the WhatsApp crawler:

- **No shell exports `metadata` or `generateMetadata`, and `app/layout.tsx` sets no `title` /
  `description` / `openGraph` default.** Next's Metadata API cannot set an `id` and emits its own
  `<title>` from the layout for every page, so doing both yields **two** `<title>` elements, of
  which the rewriter updates one — a coin flip for the crawler, cached for days, not reproducible on
  `curl`.
- `scripts/csp-hashes.mjs` (or a sibling run from the same `build` script) asserts, for each of
  `out/shell/*/index.html`, **exactly one** `<title>` and exactly one element for each of
  `description`, `og:title`, `og:description`, `og:image`, `og:url`, `canonical` and the JSON-LD
  block, each carrying its `nc-*` id. Fail the build otherwise.

Also in the foundation, and forbidden inside the shells from day one: **`next/link`,
`next/navigation` (`useRouter` / `redirect` / `notFound`) and `next/router` anywhere under
`app/shell/**`** (`ARCHITECTURE.md` §4 rule 7, `IA.md` §2.2.1). The shells use a hand-rolled
`history.pushState` router in `lib/router`. Add the `no-restricted-imports` entry and the CI grep
**before** W7 writes a component, not after.

**Database and scripts**
```
db/migrations/0001_init.sql   byte-for-byte copy of db/schema.sql
db/seed.sql                   one `seasons` row (is_active=1), one `venues` row, nothing else.
                              Games come from scripts/seed-games.ts, never from here.
scripts/csp-hashes.mjs        walk out/**/*.html, sha256 every inline <script>, emit
                              worker/csp-hashes.json keyed by asset path, and FAIL THE BUILD on
                              anything unhashable
public/robots.txt             Disallow: /shell/ /admin/ /api/
public/manifest.webmanifest
```

**Not owned by the foundation:** `db/schema.sql`, `content/*.json` and everything in `docs/` are
already written and are inputs, not outputs.

### Acceptance criterion

- **`FRAMEWORK_FLOOR` is measured and written into `DESIGN.md` §9.1 before any feature work
  starts.** Build the empty shell (layout + the six route stubs, no components, no fetches), read
  the "First Load JS shared by all" figure `next build` prints, and record it with the date and the
  exact `next`/`react` versions. Every route budget in §9.2 is `floor + allowance`, and
  `scripts/budget-check.mjs` reports both halves on failure. Skipping this gate means the first
  budget failure is unattributable and the team's fix is to raise the numbers, which discards the
  only mechanism protecting the 4G experience. This is a **blocking** gate, not a nice-to-have.
- `npm install && npm run typecheck && npm run build` succeeds, `out/` contains the static pages and
  the three shells, and `worker/csp-hashes.json` is non-empty.
- `npm run db:local` applies `db/schema.sql` to a local D1 with no error, and
  `npm run db:seed:local` follows it.
- `npx wrangler dev` boots; `/` renders with the Floodlight tokens applied and the `/404/` page
  works; `/api/v1/config` returns the success envelope (from the placeholder router).
- A one-page storybook route (or a throwaway `app/_kitchen-sink/page.tsx`, deleted before launch)
  renders every `components/ui/*` at every variant and passes the `DESIGN.md` §12 checklist.
- ESLint fails on a deliberately added `import { db } from '@/worker/db/client'` inside
  `lib/bracket/`, and on a deliberately added `dangerouslySetInnerHTML`.

---

## Phase 1 — ten parallel workstreams

### W1 — Bracket engine

**Owns**
```
lib/bracket/index.ts  types.ts  errors.ts  rng.ts  seeding.ts  graph.ts  resolve.ts  validate.ts
lib/bracket/tiebreak.ts  standings.ts  leaderboard.ts  stages.ts
lib/bracket/formats/index.ts  singleElim.ts  doubleElim.ts  roundRobin.ts  swiss.ts  pointsLobby.ts
lib/bracket/__tests__/*.test.ts        (all 12 files listed in BRACKET-ENGINE.md §2)
```

**Depends on** Foundation only — and on nothing at runtime. This module imports *nothing*: not
`app/`, not `worker/`, not `lib/types`, not one npm package. No `Math.random`, no `Date.now`, no
`Intl`, no `localeCompare`.

**Hand-off obligation (day one, before anything else in this stream):** commit
`lib/bracket/types.ts` complete and `lib/bracket/index.ts` with every exported signature present and
throwing `not_implemented`. W5 codes against those signatures from hour one.

**Acceptance criterion**
`npm test` green on all 18 test sections of `BRACKET-ENGINE.md` with the literal oracles at entrant
counts 2, 3, 4, 5, 7, 8, 9, 11, 16, 17 — including the machine-generated 8- and 11-entrant double
elimination match tables, the pinned PRNG and hash values, `2N−2` playable matches for every N, and
the perf test (`generateBracket + resolveBracket` under **15 ms** for 256 entrants). Two extra
non-negotiables: the leaderboard award path uses only integer arithmetic (`PLACE_TABLE` and
`FIELD_MILLI` literals — no `Math.pow`, no `Math.log2`), and a fuzz test asserts that resolving the
same `(skeleton, entrants, results)` twice is byte-identical.

---

### W2 — Worker platform and edge

**Owns**
```
worker/index.ts                  the 13-step dispatch (API.md Appendix A) + the scheduled() cron
worker/router.ts                 the ordered route table (API.md Appendix C); imports the five
                                 worker/api/*/routes.ts modules by name and concatenates them
worker/lib/headers.ts            security headers (SECURITY.md §8)
worker/lib/cache.ts              cachePolicyFor(pathClass, status) — status is a REQUIRED argument;
                                 caches.default helpers with a cookie-free key and the
                                 string-body-twice rule (never response.clone())
worker/lib/csp.ts                per-page hash CSP from worker/csp-hashes.json; CSP_MODE switch
worker/lib/inject.ts             the HTMLRewriter meta + boot-island injector (IA.md §4, API.md §8.6)
worker/lib/markdown.ts           marked tokenizer → the closed-allowlist JSON AST (API.md §9)
worker/lib/ratelimit.ts          the ONE helper over both the ratelimit bindings and rate_counters
worker/lib/idempotency.ts        API.md §6.1
worker/lib/shortlinks.ts         /j/ and /i/ resolution + slug_redirects
worker/lib/og.ts                 the /og/t/ handler (v1: always the 302 branch)
worker/lib/cron.ts               ALL ELEVEN nightly jobs, AUTH.md §10.1–§10.9, in that order, each
                                 its own .batch() with its own LIMIT and stated cap: the five
                                 ephemeral sweeps, released handles, old recovery codes, suspension
                                 auto-lift, the 180-day entrant-contact purge, the 18-month pii
                                 purge, the check-in-close no_show transition, the tournament
                                 status auto-advance, and the 30-day deletion finalisation.
                                 One job throwing must not skip the rest.
worker/lib/__tests__/*.test.ts
```

**Depends on** Foundation.

**Acceptance criterion**
The dispatch order is implemented step-for-step and a test asserts each step's precedence.
Specifically: `/shell/anything` returns the 404 page; a `POST` to `/about/` returns `405` with
`Allow`; `/j/AB7K2M/` with a code that fails the regex performs **zero** D1 reads; a 404 is stamped
`s-maxage=0` (the optoads.com bug); and a tournament named
`</script><img src=x onerror=alert(1)>` round-trips through both the meta injector and the JSON boot
island with a unit test using that exact string — this is the single highest-risk line of code in
the project. Markdown fixtures prove that raw HTML, `javascript:` hrefs, images, tables and
over-deep nesting are all dropped, and that the AST never exceeds the size caps.

---

### W3 — Auth: ceremonies, sessions, predicates

**Owns**
```
worker/api/auth/routes.ts        (takes over the foundation's placeholder)
worker/api/auth/passkey.ts  recovery.ts  session.ts  email.ts  bootstrap.ts  config.ts
worker/lib/webauthn.ts           SimpleWebAuthn v13 wiring, rpID, challenge single-use UPDATE
worker/lib/session.ts            mint/rotate/validate/revoke, the epoch, the 300 s activity write
worker/lib/predicate.ts          the predicate vocabulary of AUTH.md §7.2 as composable functions
worker/lib/guest.ts              the guest capability token
worker/db/auth.ts                every query against users / sessions / webauthn_* / recovery_codes
                                 / email_otps / handle_reservations
worker/api/auth/__tests__/*.test.ts
```

**Depends on** Foundation.

**Acceptance criterion**
A real phone completes signup → recovery-code display → sign-out → usernameless conditional-UI
sign-in → sign-in with a recovery code → forced passkey enrolment → epoch bump kills the thief's
session. Session validation is **one** D1 statement (`sessions JOIN users`). A challenge cannot be
consumed twice (asserted by two concurrent verifies). **Every row of the AUTH.md §7.3 predicate
table has a test**, positive and negative. Bootstrap works from the secret, refuses once an admin
exists, and 404s when the secret is deleted.

---

### W4 — Public read API

**Owns**
```
worker/api/public/routes.ts      (takes over the placeholder)
worker/api/public/config.ts  games.ts  tournaments.ts  bracket.ts  matches.ts  standings.ts
worker/api/public/entrants.ts  announcements.ts  leaderboard.ts  players.ts  club.ts  venues.ts
worker/api/public/handle.ts  health.ts
worker/db/read/*.ts              the read queries, one file per resource
worker/lib/serialize.ts          the ONE public serializer that strips custom fields by
                                 FieldDef.visibility. A phone number on a public page is a P0.
worker/lib/cursor.ts             base64url {v,k,q} with the query fingerprint
worker/api/public/__tests__/*.test.ts
```

**Depends on** Foundation. Reads rows that W5 writes, but does not import W5.

**Acceptance criterion**
The load-bearing invariant is tested directly: **a public response is byte-identical for an
anonymous request and for an authenticated admin's request.** `GET /tournaments/:slug/bracket` uses
**≤ 3** D1 statements and the `If-None-Match` 304 path uses **exactly 1** — asserted with a counting
D1 stub, not by reading the code. No handler contains `COUNT(*)`. A reused cursor with changed
filters returns `400 invalid_cursor`. A draft tournament 404s and a cancelled one 410s with a body.

---

### W5 — Write API: player, organizer, admin, and the bracket persistence

**Owns**
```
worker/api/me/routes.ts  profile.ts  registrations.ts  credentials.ts  sessions.ts  dpdp.ts
worker/api/entrants/*.ts         register.ts  guest.ts  checkin.ts  withdraw.ts  edit.ts
worker/api/organizer/routes.ts   tournaments.ts  entrants.ts  bracket.ts  stages.ts  rounds.ts
                                 score.ts  lobby.ts  announcements.ts  invites.ts  organizers.ts
                                 audit.ts  csv.ts  impact.ts  publish.ts
                                 (stages.ts = API.md §4.23.1–§4.23.4; rounds.ts = §4.23.5–§4.23.6,
                                  the progressive pairing endpoints without which Swiss and BGMI
                                  cannot get past round 1)
worker/api/invites/*.ts          public.ts (GET /invites/:code) accept.ts (POST .../accept)
                                 roster.ts (POST /entrants/:id/roster-invites) — API.md §3.12
worker/api/admin/routes.ts       games.ts  users.ts  sessions.ts  audit.ts  club.ts  stats.ts
                                 leaderboard.ts  redirects.ts  cache.ts  venues.ts  seasons.ts
worker/db/write/*.ts
worker/db/bracket-adapter.ts     Skeleton ⇄ matches rows: mints ULIDs, builds the code→id map
                                 BEFORE the batch, persists in topological order, applies the
                                 resolveBracket diff
worker/db/standings.ts           the standings recompute, in the same batch as the score write
worker/db/leaderboard.ts         points_ledger + leaderboard_entries
worker/lib/fields.ts             FieldDef validation. **CONTENT.md §3 is authoritative for the whole
                                 type** — the FieldType union, the nested `validation` object,
                                 `visibility`, `pii`, `options`, `visible_if`, every key name.
                                 API.md §3.3 owns ONLY the wire reason codes and the unknown-key
                                 rule (reject on POST, drop on PATCH). Do not write a validator
                                 from any type list in API.md; it no longer contains one.
                                 Also owns the `pii: true` + `type: "tel"` write path: encrypt to
                                 entrants.guest_phone_enc / entrant_members.phone_enc (AAD = the
                                 owning row id), store phone_last4, and put ONLY the mask into
                                 fields_json (SECURITY.md §10.2.1).
worker/api/organizer/__tests__/*.test.ts   worker/api/me/__tests__/*.test.ts
```

**Depends on** Foundation, plus W1's `lib/bracket/types.ts` + `index.ts` signatures (available on
W1's day one).

**Acceptance criterion**
A score write, its `match_audit` row, the `resolveBracket` diff, the affected `standings` rows, the
`bracket_version` **and** `state_version` bumps, the `audit_log` row and the `idempotency_keys`
completion all land in **one** `.batch()` — asserted by a stub that fails the test if it sees two.
The worked correction example in `BRACKET-ENGINE.md` §14.2 reproduces exactly, including the
`invalidatedResults` list surfaced by `GET /organizer/matches/:id/impact` and the `?confirm=1`
gate. A retry with the same `Idempotency-Key` replays with `Idempotent-Replay: true` and creates no
second row; a different attempt with a stale `result_version` gets `409 stale_version` carrying
`details.current`. `PUT .../score` with an `entrant_id` that is not in the match is a `400`, and a
`winner_entrant_id` contradicting the scores is a `400` — the client's opinion about who won is
never authoritative. Bracket generation for 256 entrants completes inside the CPU budget and is
retryable after an injected mid-run failure (orphaned matches are deleted, `bracket_generated_at`
is still null).

---

### W6 — Public site pages

**Owns**
```
app/page.tsx                     home
app/live/page.tsx
app/tournaments/page.tsx
app/games/page.tsx  app/games/[slug]/page.tsx   (generateStaticParams over content/games.json)
app/leaderboard/page.tsx
app/search/page.tsx
app/offline/page.tsx
components/public/**             HomeHero, LiveStrip, TournamentCard, TournamentList, FilterBar,
                                 GameGrid, GameCard, LeaderboardTable, LeaderboardRow, SearchResults,
                                 ClubStats, CategorySection
public/sitemap.xml
public/sw.js                     ~2 KB. skipWaiting OFF — a silent hot-swap during a live scoring
                                 session is how you lose a round of results.
```

**Depends on** Foundation.

**Acceptance criterion**
Every route meets its `DESIGN.md` §9 byte budget (`npm run budget` is CI-blocking). Every view
implements all five `IA.md` §7.1 states including offline, with the exact empty-state copy in
`IA.md` §7.2 — the home page's live strip is **removed** when nothing is live and is **silent** on
error; a home hero must never show an error card. Leaderboard pagination is a **Show 50 more**
button, not infinite scroll (which breaks the back button inside a WhatsApp WebView). Works at
320 px and 400 % zoom.

---

### W7 — Tournament shell (the SPA every WhatsApp link lands on)

**Owns**
```
app/shell/tournament/page.tsx    (takes over the foundation's placeholder; keeps its meta tag set)
components/tournament/**         TournamentHeader, TabStrip, Overview, BracketView,
                                 BracketRounds, BracketFollow, BracketMap, BracketTable,
                                 MatchCard, MatchSheet, StandingsTable, PointsTable,
                                 EntrantList, Schedule, Rules, RegisterWizard, CheckIn,
                                 RoomCodeCard, GuestEntry, ShareCard, BootIsland
```

**Depends on** Foundation. Renders `lib/types` shapes; can be built against fixtures before W4 exists.

**Acceptance criterion**
The three bracket view modes work: **Rounds** (mobile default, one round at a time, scroll-snap not
a JS drag transform, no connector lines — lineage is navigation), **Follow** (one entrant's path,
deep-linked with `?e=`), **Map** (the classic tree, one inline `<svg>` of `<path>` for all
connectors, zoom by button as well as pinch). The `role="grid"` keyboard model of `IA.md` §8.2 is
implemented key for key, including `→` jumping to where the winner feeds and `Shift+→` to the
loser's destination. Every match carries the composed `aria-label` sentence from `IA.md` §8.3, and
the **Table view** alternative is offered to everyone, not hidden behind an a11y menu — it is also
what the print stylesheet renders. A 126-match double elimination paints in **< 120 ms** of
scripting on a Snapdragon 680. Byes render as byes and are in the accessible tree; walkovers show
`W/O`. No bracket library, no `d3`.

---

### W8 — Account, auth UI and player profile

**Owns**
```
app/signin/page.tsx  app/join/page.tsx  app/recover/page.tsx
app/me/page.tsx  app/me/registrations/page.tsx  app/me/security/page.tsx  app/me/settings/page.tsx
app/shell/player/page.tsx        (takes over the placeholder; keeps its meta tag set)
components/account/**            IdentitySheet, PasskeyButton, RecoveryCodes, HandleField,
                                 CredentialList, SessionList, ProfileForm, MyRegistrations,
                                 PlayerProfile, PlayerStats, PlayerHistory, DeleteAccountFlow
```

**Depends on** Foundation. Talks to W3's endpoints; buildable against fixtures.

**Acceptance criterion**
The three identity-gate states of `IA.md` Journey 2 step 0 all render correctly, and **State B is
the one that matters**: inside a WhatsApp/Instagram WebView, where `PublicKeyCredential` is absent
or `isUserVerifyingPlatformAuthenticatorAvailable()` is false, the UI shows *"Open this in Chrome to
sign up"* with a copy-link and share affordance — and **never a dead "Create passkey" button that
throws**. Recovery codes are ten, shown once, in **one** `<pre>` block that supports paste
(WCAG 2.2 §3.3.8), gated by a required checkbox, with download and copy. Conditional UI is attempted
first on `/signin/` (`autocomplete="username webauthn"`) so a returning user signs in with zero
taps. There is no CAPTCHA anywhere in this stream.

---

### W9 — Admin / organizer shell

**Owns**
```
app/shell/admin/page.tsx         (takes over the placeholder)
components/admin/**              AdminNav, Dashboard, CreateWizard (5 steps), TournamentManage,
                                 Registrations, PaymentVerify, CheckInDesk, Seeding, BracketPreview,
                                 LiveScoring, LobbyEntry, CorrectionSheet, Schedule, RoomCodes,
                                 Results, Payouts, AuditLog, PrintPack, GamesAdmin, PeopleAdmin,
                                 OfflineWriteQueue
```

**Depends on** Foundation. Talks to W5's endpoints; buildable against fixtures.

**Acceptance criterion**
The live-scoring screen is usable **standing up, one-handed, in bad light, on bad signal**: a single
match fills the viewport, 96 px entrant rows, 64 px steppers, a hold-to-confirm lock with the
keyboard/AT dialog fallback, auto-advance to the next unscored match, and an **IndexedDB write queue
that survives a reload** so an organiser can score an entire round with no signal. A `409
stale_version` opens a blocking compare sheet — never a silent overwrite. The correction flow shows
the exact `GET /organizer/matches/:id/impact` list before anything is editable, requires an extra
checkbox if any listed match is `live`, requires a reason, and states plainly that **there is no
undo**. Seeding offers ▲/▼ buttons and a "move to position" input as well as drag (WCAG 2.2 §2.5.7)
and shows the RNG seed for a random draw so it can be re-run in front of the room.
`/admin/t/<slug>/print/` renders with **no JavaScript, black and white, A4** — bracket, fixtures,
contact sheet, blank score sheets, prize table. That page is the entire offline disaster plan
(`OPERATIONS.md` §12) and it ships in v1.

---

### W10 — Content, static pages, assets and tooling

**Owns**
```
app/about/page.tsx  app/venue/page.tsx  app/contact/page.tsx  app/code-of-conduct/page.tsx
app/fair-play/page.tsx  app/privacy/page.tsx  app/terms/page.tsx  app/refunds/page.tsx
components/content/**            FaqAccordion, PolicyBlock, StoryBlock, ContactCard, ConductLadder
content/games.json  content/club.json      (edits only; the schema of these files is CONTENT.md's)
scripts/seed-games.ts            CONTENT.md §7, literally — validate every db/schema.sql CHECK in
                                 JS BEFORE the first statement, collect ALL errors and print them
                                 together, resolve $preset, compute _content_hash, skip unchanged,
                                 one batch, ON CONFLICT(slug) DO UPDATE, NEVER delete (is_active=0)
scripts/og-cards.mjs             SVG → the six PNGs; run by hand, output committed
scripts/budget-check.mjs         DESIGN.md §9 per-route budget; CI-blocking
public/og/default.png  cat-esport.png  cat-board.png  cat-outdoor.png  player.png  leaderboard.png
```

**Depends on** Foundation.

**Acceptance criterion**
`npm run seed:games` against a fresh local D1 inserts all 20 games with zero CHECK violations, and
running it twice writes nothing the second time. `grep -rn TODO_VERIFY content/` is wired as a
**pre-deploy gate** and currently fails on five blocking nulls — that is correct and intentional;
the gate is what stops a plausible-looking placeholder UPI VPA being screenshotted into a WhatsApp
group. Every static page renders with JavaScript disabled. The six OG cards are ≤ 40 KB each, flat
PNG-8, with all essential content inside a centred 630 × 630 safe square (some clients crop to a
square thumbnail). `/refunds/` is not optional — a club taking money in INR needs a stated
cancellation policy and UPI disputes go there first.

---

## Phase 2 — integration (sequential, after Phase 1)

### I1 — Wire it together

Replace every fixture with the real API. One agent, touching whatever it must, because by
definition this step crosses boundaries. Order of operations:

1. `wrangler d1 create nellore-club`, apply `db/schema.sql`, `db/seed.sql`, `npm run seed:games`.
2. Confirm `wrangler.jsonc` matches `ARCHITECTURE.md` §7 **exactly**: `"ratelimits"` (plural) with
   `"name"` per entry, the two `routes` entries for the apex and www, and the array form of
   `run_worker_first`. Then hit any endpoint once — an `undefined` RL binding throws on
   `.limit(...)` and 500s every request, and unknown top-level wrangler keys are a *warning*, so the
   deploy succeeds and the failure looks like application code.
3. `wrangler secret put` every required secret; confirm `assertEnv` fails loudly with one missing,
   **including a missing `RL_*` binding**.
4. Bootstrap the first admin from `ADMIN_BOOTSTRAP_TOKEN`, then **delete the secret**.
5. Create a real tournament for each of the five formats and run each to completion, **including
   the two progressive ones and one multi-stage one** — those are the paths that only exist because
   of API.md §4.23:
   - Swiss chess: pair round 1, score it, `POST /organizer/stages/:id/rounds` for round 2, and
     confirm round 2 cannot be paired while round 1 has an unscored match
     (`409 round_not_complete`).
   - BGMI `points_lobby`: 4 rounds, `matches_per_round: 4` as `content/games.json` ships it, with
     `lobbyRotation: 'snake_by_standings'` — so rounds 2–4 provably cannot exist at generation time.
   - Box cricket, 24 teams, groups → knockouts: generate stage 1, complete it,
     `POST /organizer/stages/:id/seed` to populate stage 2's `stage_entrants`, then generate stage
     2. Confirm `match_no` does not collide across stages and that the standings endpoint answers
     per stage.
6. Run the cron by hand (`wrangler dev --test-scheduled`) and verify all eleven jobs log a row count.
7. `npm run budget` and fix whatever regressed — reported as `floor + app`, per DESIGN.md §9.1.

**Acceptance criterion:** a 16-entrant double-elimination carrom event, a 20-squad BGMI
points-lobby event **and a 24-team two-stage box-cricket event** all run end to end — create,
publish, register (account + guest + organiser walk-in + **roster invite link**), pay by UPI and
verify the UTR, check in, generate, score every match from a phone with the network throttled to
Slow 4G, correct a round-2 result and watch the cascade, publish, and see the leaderboard move.

### I2 — Harden and launch

Work the `SECURITY.md` §17 pre-launch checklist line by line, then:

- Paste a tournament URL into WhatsApp on Android **and** iOS, Telegram, Instagram DM and X;
  confirm title, description and image all render. Test with a fresh URL — WhatsApp's preview cache
  is measured in days and there is no purge API.
- Run one deploy with `CSP_MODE=report-only`, read the reports, then enforce.
- Verify the printed pack actually prints on the club's printer.
- Verify the offline path: aeroplane mode mid-round, score four matches, come back, watch the queue
  drain.

---

## Ownership map at a glance

| Directory | Owner |
| --- | --- |
| `package.json`, `wrangler.jsonc`, `tailwind.config.ts`, `tsconfig.json`, `eslint.config.mjs` | Foundation |
| `app/globals.css`, `app/layout.tsx`, `app/not-found.tsx` | Foundation |
| `components/ui/**`, `components/data/**` | Foundation |
| `lib/types/**`, `lib/format/**`, `lib/content/**`, `lib/api/**` | Foundation |
| `worker/lib/{env,errors,respond,ids,crypto}.ts`, `worker/db/client.ts`, `worker/csp-hashes.json` | Foundation |
| `db/migrations/**`, `db/seed.sql`, `scripts/csp-hashes.mjs`, `public/robots.txt`, `public/manifest.webmanifest` | Foundation |
| `lib/bracket/**` | W1 |
| `worker/index.ts`, `worker/router.ts`, `worker/lib/{headers,cache,csp,inject,markdown,ratelimit,idempotency,shortlinks,og,cron}.ts` | W2 |
| `worker/api/auth/**`, `worker/lib/{webauthn,session,predicate,guest}.ts`, `worker/db/auth.ts` | W3 |
| `worker/api/public/**`, `worker/db/read/**`, `worker/lib/{serialize,cursor}.ts` | W4 |
| `worker/api/{me,entrants,organizer,admin}/**`, `worker/db/{write/**,bracket-adapter,standings,leaderboard}.ts`, `worker/lib/fields.ts` | W5 |
| `app/{page.tsx,live,tournaments,games,leaderboard,search,offline}`, `components/public/**`, `public/{sitemap.xml,sw.js}` | W6 |
| `app/shell/tournament/**`, `components/tournament/**` | W7 |
| `app/{signin,join,recover,me}/**`, `app/shell/player/**`, `components/account/**` | W8 |
| `app/shell/admin/**`, `components/admin/**` | W9 |
| `app/{about,venue,contact,code-of-conduct,fair-play,privacy,terms,refunds}/**`, `components/content/**`, `content/**`, `scripts/{seed-games.ts,og-cards.mjs,budget-check.mjs}`, `public/og/**` | W10 |
| `db/schema.sql`, `docs/**` | frozen inputs — change one only through an explicit reconciliation, and update `docs/ARCHITECTURE.md` §5 when you do |
