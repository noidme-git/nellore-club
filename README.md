# nellore.club

Tournament platform for the Nellore game club — esports, board games and outdoor sports,
on one game-agnostic engine.

A new game is added as **data** (a row in `content/games.json`), never as code. That is the
central design claim, and the 20 seeded games — BGMI and Valorant next to chess, carrom,
box cricket, throwball and kabaddi — are the proof.

## Status

**Not yet deployed.** The specification and the Phase 0 foundation are complete and green;
the ten feature workstreams are not built. See `docs/BUILD-PLAN.md` for the plan and
[Remaining work](#remaining-work) for what is actually left.

| | |
| --- | --- |
| Specification | complete — ~23,000 lines across `docs/` |
| Database schema | complete — 31 tables, applied to live D1 |
| Phase 0 foundation | complete — typecheck, build, lint and tests green |
| Feature workstreams (W1–W10) | **not started** |
| Deployed | **no** |

## Stack

Next.js 15 static export (`output: 'export'`) served from Cloudflare Workers Static Assets,
with `worker/index.ts` in front for the API, security headers and clean dynamic URLs. Data in
Cloudflare D1. Tailwind 3.4. TypeScript strict.

There is **no SSR and no Node runtime at request time**. Every page is prerendered HTML.
Tournament data changes during a live event, so pages that show it ship as a shell and fetch
from the Worker API on the client; the Worker rewrites `/t/<slug>` onto that shell, because a
static export cannot prerender a page per tournament.

Design decisions and their rationale are in `docs/ARCHITECTURE.md`, which is the tie-breaker
for every name, enum, route and unit in the project.

## Getting started

```bash
npm install
npm run typecheck     # tsc for the app AND the worker, separately
npm test              # vitest
npm run build         # next build && node scripts/csp-hashes.mjs
npm run dev           # Next dev server
npx wrangler dev      # the Worker, once worker/index.ts exists (W2)
```

Local database:

```bash
npm run db:local      # apply db/schema.sql
npm run db:seed:local # one season, one venue
npm run seed:games    # the 20 games from content/games.json
```

Copy `.dev.vars.example` to `.dev.vars` and fill it in. `assertEnv()` fails loudly at startup
on a missing secret rather than at first use, so an unset pepper cannot serve a request.

## Deploying

```bash
npm run deploy        # next build && wrangler deploy
```

### Cloudflare credentials — read this before deploying

**This repo currently has no dedicated Cloudflare token, and deploys depend on tokens named
for other projects.** That works today and will break confusingly later. The permissions are
split across three tokens on the operator's machine:

| Token | Workers | D1 | KV | DNS | Routes |
| --- | --- | --- | --- | --- | --- |
| `~/.noidme-cf-token` | yes | — | — | — | — |
| `~/.optoads-cf-token` | yes | — | — | **yes** | **yes** |
| `~/.sandhya-cf-token` | yes | **yes** | **yes** | — | — |

So today: `.sandhya` creates the D1 database and deploys the Worker, `.optoads` attaches the
custom domain. If either is rotated or revoked for *its own* project, deploys here break for a
reason that will not be obvious from the error.

**TODO — replace with one dedicated token.** Cloudflare dashboard → My Profile → API Tokens →
Create Token → Custom token:

| Permission | Level | Scope |
| --- | --- | --- |
| Account → D1 | Edit | Developer@noidme.com's Account |
| Account → Workers Scripts | Edit | Developer@noidme.com's Account |
| Account → Workers KV Storage | Edit | Developer@noidme.com's Account |
| Zone → DNS | Edit | nellore.club |
| Zone → Workers Routes | Edit | nellore.club |

Then `echo '<token>' > ~/.noidme-cf-token` and use that one everywhere. No code changes —
`wrangler.jsonc` is already correct.

### GitHub Actions

`.github/workflows/` cannot be pushed with the current credentials: the `noidme-git` token has
`repo` but not `workflow` scope. Verified, not assumed — an ordinary file pushes fine while a
workflow file returns a masked 404. To enable:

```bash
gh auth refresh -h github.com -u noidme-git -s workflow
```

## Layout

```
app/          Next.js routes. app/shell/{tournament,player,admin} are SPA shells the
              Worker rewrites clean URLs onto.
components/   ui/ primitives (never fetch, never import lib/api), data/ the five-state
              fetch layer, plus per-area component sets.
lib/          types/ the wire and row contracts; format/ IST + INR + share text;
              bracket/ the pure tournament engine; api/ the typed client.
worker/       The Cloudflare Worker: routing, API, auth, caching, security headers.
db/           schema.sql (source of truth), migrations, seed.
content/      games.json and club.json — the game-agnostic catalog and club copy.
docs/         The specification. ARCHITECTURE.md first.
```

### Boundaries that ESLint enforces

These are not conventions, they fail the lint:

- `lib/bracket/**` imports **nothing** — not `app/`, not `worker/`, not `lib/types`, not one
  npm package. It is pure data-in/data-out so it runs identically in the Worker and the
  browser, and so the same bracket cannot resolve two different ways.
- `components/ui/**` never fetches and never imports `lib/api`.
- `app/shell/**` never imports `next/link`, `next/navigation` or `next/router`.
- No `dangerouslySetInnerHTML`, anywhere.

All four were verified to actually fire by adding a deliberate violation and watching the
lint fail — a boundary rule that silently matches nothing is worse than no rule, because it
manufactures confidence.

## House rules worth knowing

- **No floats. Ever.** Money is integer paise; chess half-points are `stages.points_divisor = 2`.
  Standings compare points for equality at every tiebreak step, and float equality is where
  "these two are tied" quietly becomes "not tied" at the third decimal — on a projector, in
  front of the two players.
- **Timestamps** are integer unix seconds in storage, RFC 3339 `…Z` on the wire, IST on screen.
- **Brackets use source pointers, not destination pointers.** A match records where its
  participants came *from*, and the bracket is re-derived by folding forward. This is why
  correcting a score two rounds back is the same code path as entering it, instead of a
  separate rollback path — which is the least-tested code in every tournament product and the
  usual way a live bracket gets corrupted in front of an audience.
- **The byte budget is real.** `npm run budget` is CI-blocking. The audience is a mid-range
  Android phone on patchy 4G in a tier-2 city, and links arrive via WhatsApp. No UI kit, no
  icon package, no date library, no bracket library.

## Remaining work

Phase 1 is ten parallel workstreams (`docs/BUILD-PLAN.md`): the bracket engine, the Worker
platform, auth, the public read API, the write API, public pages, the tournament shell, the
account UI, the admin scoring console, and content/tooling. Then integration and hardening.

Known gaps carried out of Phase 0, none of them hidden:

- `public/fonts/*.woff2` are referenced by `app/globals.css` and preloaded by `app/layout.tsx`
  but **do not exist** — every page currently preloads two 404s. Subsetting Inter and Noto
  Sans Telugu is an unowned launch task.
- No favicon and `manifest.webmanifest` declares no icons, so the site is not installable.
- `app/kitchen-sink/` is a real crawlable route. `robots.txt` disallows it as a stopgap; it
  should be deleted before launch.
- Two countdown formatters disagree above one hour (`lib/format/datetime.ts` renders `24:11`,
  `components/ui/Countdown.tsx` renders `24:11:00`). Needs one owner decision before W7.
- The measured JS floor (102 KB gz) breaks the `DESIGN.md` §9.2 ceiling on the two shell
  routes (~185–190 KB against 180 KB). Per the spec's own rule this is a scope or framework
  decision, **not a number to raise**. Open for W7.
- Route-change announcement is half-shipped: `app/layout.tsx` owns the live region, but the
  shell routers must write the new title into it and move focus. If they don't, every
  client-side tab change is silent to a screen reader — and the region existing makes it look
  done.
