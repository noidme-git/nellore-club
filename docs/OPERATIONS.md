# OPERATIONS.md — running an event on nellore.club

The runbook. Written for the person who is actually standing at the venue at 8 AM on a Sunday with
one phone, one power bank and sixteen captains asking when their match is.

Assume throughout: **one organizer, maybe two.** Every procedure here has to work solo. If a step
needs a second person, it says so.

---

## 0. Roles

| Role | Who | What they can do |
| --- | --- | --- |
| **Club head** | The owner. Bootstrapped from a Worker secret. | Everything. Creates organizers, imposes and lifts bans, is the final appeal on disputes. |
| **Organizer** | Trusted club members, granted by the club head. | Create and run tournaments, verify payments, enter scores, resolve disputes on the day, record payouts. |
| **Scorer** | Volunteer, scoped to **one** tournament (`tournament_organizers.role = 'scorer'`). | Enter scores and lobby results, pair the next round, set match times and room codes — for that tournament only. **Cannot see phone numbers, cannot export contacts, cannot touch payment fields, cannot publish or reopen results.** |
| **Moderator** | `role = 'moderator'`, scoped to one tournament. | Post announcements, confirm/reject entrants, run the check-in desk. **Cannot enter scores.** |
| **Player** | Anybody with a passkey. | Register, check in, view everything public. |

Give a volunteer **scorer**, not **organizer**. A scorer handing their phone to a friend should not
be able to leak forty phone numbers. The scoped role costs nothing and closes that hole.

**This is enforced, not advisory.** `AUTH.md` §7.2 defines `ORG_OF(t)` (any non-revoked staff row),
`FULLORG_OF(t)` (`owner`/`organizer` only) and `OWNER_OF(t)`, and the privileged surface —
`/entrants/:id/contact`, `entrants.csv?include_contact=true`, the payment fields of
`PATCH /organizer/entrants/:id`, `publish`, `unpublish`, `reopen` — is gated on `FULLORG_OF`. A
scorer hitting one gets `403 forbidden`, `details.reason: "role_insufficient"`. Every one of those
predicates also requires `revoked_at IS NULL`, so **removing someone takes effect on their very next
request** — their session is not killed, their authority is.

Every score write, payment verification and dispute ruling records `actor_id` and a timestamp. When
two people disagree about who changed a score, the audit log answers it in five seconds.

---

## 1. Two weeks out — plan the event

Do this on paper or in a notes app before touching the admin panel.

**1.1 Pick the game and the format.** `content/games.json` already has sane defaults per game —
`tournament_defaults.format`, `min_participants`, `max_participants`, `typical_duration_minutes`.
Start there and only override with a reason.

**1.2 Do the capacity maths.** The number that kills events is not registrations, it is court-hours.

```
total match slots = (duration_minutes + buffer_minutes) per match
matches in a single-elim draw of N        = N − 1   (+1 if third-place match)
matches in a round robin of N             = N(N−1)/2
matches in groups of 4 → knockout, 16 teams = 24 group + 7 knockout = 31
```

Then: `hours needed = matches × slot ÷ parallel courts ÷ 60`.

Worked example — 16-team box cricket, 45 min + 15 min buffer, groups of 4 then knockout, 1 turf:
`31 × 60 ÷ 1 ÷ 60 = 31 hours`. That is not a day. Fix it by shortening the format (6 overs, not 10),
running 2 pitches, or cutting to 8 teams. **Do this arithmetic before you announce a date**, because
the alternative is finishing a final at 11 PM with the ground owner standing over you.

**1.3 Set the prize table.** Publish it before registration opens and never shrink it.

```
gross         = entry_fee × expected_paid_entries
venue          − ground/court/hall rent
consumables    − balls, shuttles, powder, water, printing
prize pool     = gross − venue − consumables − club margin
```

Rules of thumb that have to hold:

- **Announce absolute rupee amounts, not percentages.** "Winner ₹8,000" is a promise a player can
  hold you to and will share. "Winner gets 40% of the pool" reads as "we might pay you nothing".
- **Never publish a prize pool larger than what a two-thirds-full draw would fund.** If 16 teams
  fill it and you need 11 to break even, you can absorb a slow week. If you need 15, you cannot.
- Add a small non-cash prize (best batter, MVP, best raider). It costs ₹1,000 and it is what people
  post about.

**1.4 Lock the venue.** Get it in writing on WhatsApp with a date, a time window and a price. Book
one hour past your worst-case finish.

**1.5 Check the guard rails.** If the game's `compliance.real_money_prizes_allowed` is `false`, the
entry fee must be ₹0 and the prizes must be non-cash. If `compliance.review_required` is `true`, do
not publish without a decision from the club head. Card games are `status: "disabled"` in
`content/games.json` and stay that way — see `content/club.json → policies.legal_note`.

---

## 2. Create the tournament

`/admin/t/new/`

**Status ladder.** A tournament moves in one direction:

```
draft → published → registration_open → registration_closed → check_in → live → completed
                                                                              ↘ cancelled
```

- `draft` — visible only to organizers. Everything editable.
- `published` — public page live, "registration opens <date>". Use this to build anticipation and to
  let a poster point somewhere real.
- `registration_open` — the Register button works. **Game, format, entry fee and prize table are
  frozen from this moment.** They are a published promise.
- `registration_closed` — no new entries. Seeding and the draw happen here.
- `check_in` — the check-in window is open. Rosters are confirmed; no-shows are marked.
- `live` — bracket generated and locked, matches are being scored.
- `completed` — final match scored, results published, leaderboard points awarded.
- `cancelled` — the terminal failure state, used for **both** an event that never started and one
  abandoned partway. There is no separate `abandoned` status; the difference is recorded in the
  cancellation note and it changes only the payout rule (§11.4), not the state machine.

Separately, `tournaments.visibility` is `public` | `unlisted` | `private`. `unlisted` is the useful
one: a page that works for anybody with the link but never appears in listings — exactly right for a
college or corporate event you do not want strangers registering for.

**Fields to fill.** Most are prefilled from the game definition:

| Field | Note |
| --- | --- |
| Game | Picks the whole definition. Everything below is prefilled from it. |
| Title | Under 45 characters. `"Box cricket — September Cup"`. |
| Slug | Auto from title, editable while `draft`. `/t/<slug>/` is the URL you will paste 200 times. Make it short and typeable: `box-cricket-sep-21`. |
| Starts at | IST. Stored UTC, always displayed IST. |
| Registration closes at | Default: 36 hours before start. Do not make it the morning of. |
| Format, seeding, third-place | Prefilled from `tournament_defaults`. |
| Max entries | Prefilled. This is a hard cap enforced server-side; registration 17 on a 16-team draw is rejected, not waitlisted, unless you turn the waitlist on. |
| Entry fee (₹) | Integer rupees. `0` = free, and the whole payment flow disappears. |
| Prize table | Rows of `{ position label, amount ₹ }`. Free-text labels so "Best batter" works. |
| Venue | Name, landmark, Google Maps URL. Required when the game's `match_defaults.venue_kind` is `onsite` or `hybrid`. |
| Rules addendum | Anything on top of the game's `rules_summary`. Keep it to the overrides. |
| Cover image | 1200×630. Becomes the OG image. See `docs/CONTENT.md` §10.5. |

**Before you hit Publish, check three things:**

1. Does the date on the page match the date in your poster? (It will not, once.)
2. Does `entry_fee × max_entries` actually cover the prize table plus the venue?
3. Is the club UPI ID configured? While `policies.entry_fee.upi_id` is null in
   `content/club.json`, the API **rejects** any tournament with a fee above ₹0. That is deliberate.

---

## 3. Promote it

The link is the product. Everything else is a way to get the link in front of somebody.

**Order of operations, T−10 days:**

1. Publish the page first. Never announce before there is a URL to send.
2. Post to the club WhatsApp group / channel using the "Registration open" template in
   `docs/CONTENT.md` §10.4. First line is the notification preview — put game, date and top prize in
   the first 65 characters.
3. Send the link to last event's participants individually. This is the highest-converting thing you
   will do and it takes twenty minutes.
4. Instagram post + story with the link in the bio and the story sticker.
5. Ask the top three teams from last time to share it to their own groups. Ask directly, by name.

**Check the link preview before you send it anywhere.** Paste the URL into a WhatsApp chat with
yourself. If the image, title and description do not all render, fix the OG tags before the
announcement, not after. A link with no preview in a group of forty gets scrolled past.

**Cadence.** T−10 announce → T−4 "N slots left" → T−1 evening "registration closes at 9 PM" →
T−0 morning "fixtures are out, first match 8 AM". Four messages. More than that and people mute the
group, which costs you the next event too.

---

## 4. Registrations and money

### 4.1 The honest position on payments

**There is no payment gateway. Payment verification is manual.** This is a deliberate launch choice,
not an oversight, and everyone involved should understand exactly what it means.

The flow:

1. Player registers. The entry is created with `payment_status = 'pending'` and gets a reference
   code built from `entrants.entrant_no` — `NC-BC21-0042` (`NC` + tournament code + zero-padded
   entrant number). A free event sets `payment_status = 'not_required'` instead and skips all of
   this.
2. The confirmation screen shows the club's UPI ID, the exact amount, the reference code, and a
   **Pay now** button that opens the player's UPI app pre-filled:

   ```
   upi://pay?pa=<club-vpa>&pn=<Club%20Name>&am=<amount>&cu=INR&tn=NC-BC21-0042
   ```

   Also show the raw UPI ID as copyable text and a QR code. On desktop the deep link does nothing;
   the QR is the only route.
3. Player pays in GPay / PhonePe / Paytm.
4. Player returns and types the **12-digit UTR / UPI reference number** from their payment app.
   It is stored in `entrants.payment_ref` and the status moves to `submitted`. Validation
   `^[0-9]{12}$`, and the UTR must be **globally unique** — a reference already used on another
   entry is rejected on the spot. That one constraint kills the most common fraud, which is one
   screenshot pasted by four people. (If the schema has no unique index on `payment_ref`, the API
   enforces it with a lookup before insert; either way it is not optional.)
5. Organizer opens `/admin/t/<slug>/registrations/` (the payment column is a filter on that list, not a separate screen), opens their bank or UPI app statement side by side,
   and ticks off matching references. Status → `paid`, with `paid_amount_paise`,
   `payment_method = 'upi'`, `paid_at`, `payment_verified_by` and `payment_verified_at` all written
   in the same statement. A mismatch goes back to `pending` with the reason in
   `entrants.status_reason`.

**Payment statuses** are `not_required` | `pending` | `submitted` | `paid` | `refunded` | `waived`.
`waived` is for comped entries — a sponsor's team, a volunteer — and is a distinct state from
`not_required` so a free slot in a paid event is still visible as a decision somebody made.

**Why the UTR and not a screenshot upload.** A screenshot is 200–600 KB uploaded over a patchy 4G
connection by somebody who wants to be done registering; it needs object storage; and it still has
to be read by a human. A UTR is 12 characters, works on a 2G fallback, is machine-comparable against
a bank statement, is uniquely constrained in the database, and is exactly what the bank's own record
is keyed on.
*Trade-off accepted:* a determined player can type a UTR from a real payment they made to somebody
else, and the mismatch only shows up when the organizer checks amount and timestamp. That is a
manual check either way — a screenshot would not have caught it faster.

**Throughput, measured honestly.** With the payments screen sorted by claim time and the bank
statement open beside it, a batch of 40 registrations takes 10–15 minutes. Do it twice: once the
evening registration opens, once the evening before the event. Never leave it all to match morning.

**What goes wrong, and the standing answer:**

| Problem | What to do |
| --- | --- |
| Paid, never came back to enter the UTR | The payments screen has an "unmatched credits" note field. Search your statement for the amount, message the player, enter it for them. Very common. |
| Typed the UTR wrong | Move back to `pending` with `status_reason = 'utr_not_found'`, message them, let them resubmit. Do not delete the entry. |
| Paid the wrong amount | Short: ask for the difference or reject. Over: verify, and refund the excess in the same batch as prize payouts. |
| Same UTR twice | Auto-rejected by the unique constraint. Both players get an error; investigate before verifying either. |
| Paid to somebody's personal number from a group chat | Not your payment. Say so plainly, tell them to raise it with whoever took the money, and repeat the rule: **pay only to the UPI ID on the tournament page.** Put that line in every announcement. |
| Cash at the venue | Allowed only where the tournament says so. Set `payment_status = 'paid'`, `payment_method = 'cash'`, and write a numbered paper receipt. Cash without a receipt is how a club loses trust. |

**Refunds are manual too.** You send the money back from the same UPI app and record the outbound
UTR against the registration. Follow `content/club.json → policies.refunds`: full refund at 48+
hours' notice, no refund inside 48 hours but the slot is transferable, full refund if the club
cancels, full refund for an unmatched free agent.

### 4.2 When to add a gateway

Adding Razorpay or Cashfree turns steps 4 and 5 into a webhook and makes refunds one click. The
costs, stated so the decision is made with numbers:

- ~2% of every transaction, plus 18% GST on that fee → about **2.36% effective**. On a ₹1,200 team
  entry that is ~₹28; across 16 teams, ~₹453 out of the prize pool.
- Business KYC: PAN, a current account in the club's name, and a registered entity. `identity.
  legal_name` in `content/club.json` is `null` today, so this is blocked regardless of cost.
- Settlement is T+2. Prize money is paid on the day. You will need working capital to bridge it.
- A webhook needs a request-time endpoint. The Worker already has one, so this part is easy —
  `POST /api/webhooks/payments`, signature-verified, idempotent on the gateway's payment id.

**Recommendation: stay manual until you are doing more than ~100 paid registrations a month.** Below
that, manual verification is 30 minutes a month and costs nothing. Above it, the 2.36% is cheaper
than your time and the failure modes above stop being anecdotes.

### 4.3 Watching the fill

`/admin/t/<slug>/registrations/` shows counts by payment status. Two decisions come out of it:

- **Under-filled at T−2 days** (below `min_participants`): decide now, not on the morning. Either
  extend registration by 24 hours and re-announce, or cancel and refund everybody. Cancelling two
  days out is annoying. Cancelling at 8 AM with people already at the ground costs you the club.
- **Over-subscribed:** turn on the waitlist. Waitlisted entries sit at `status = 'waitlisted'` with
  `payment_status = 'pending'` and are only asked to pay if a slot opens.

---

## 5. The day before

A 30-minute checklist. Do it in this order.

1. **Close registration** at the announced time. Do not extend it quietly for one friend — somebody
   who missed the deadline will find out.
2. **Clear the payment queue.** Every `submitted` becomes `paid`, or goes back to `pending` with a
   reason. Anybody still `pending` gets one message: pay in the next two hours or the slot goes to
   the waitlist.
3. **Withdraw unpaid entries** (`status = 'withdrawn'`, which frees the slot for a genuine
   re-registration) and promote the waitlist. Confirmed entries move to `status = 'confirmed'`.
4. **Seed and generate the bracket.** Check `seeding` — `rating` for chess, `manual` for badminton
   and Valorant where you know who the top players are, `random` for everything else. Look at the
   draw before you lock it: if it puts the two best teams in the first round, reseed. Once locked, the
   bracket does not change.
5. **Publish fixtures** and announce them. Include reporting time, which is 30 minutes before the
   first match, not the match time.
6. **Print the pack** (§12.1). Yes, on paper. It costs ₹20 and it is the entire disaster plan.
7. **Charge everything.** Phone, power bank, a spare phone if you have one.
8. **Confirm the venue** on WhatsApp. Ask them to confirm back in writing.

---

## 6. Check-in on match day

`/admin/t/<slug>/checkin/`

The window opens `check_in_opens_minutes_before` and closes `check_in_closes_minutes_before` — from
the game definition, typically 60 and 15 minutes.

**Players self-check-in** from the tournament page with their passkey. One tap. This is the whole
point: sixteen captains checking themselves in is sixteen taps you did not do.

**Organizers can force check-in** for anyone. Use it freely — the player whose phone is dead, the
player who registered for their whole team, the walk-in you accepted. Forced check-ins are logged
with your actor id.

**Roster confirmation.** For games with `roster_locked_at: "check_in"` — BGMI, Free Fire, box
cricket, volleyball, kabaddi, badminton doubles — the captain confirms the playing roster at
check-in. This is the last moment substitutions can be made without an organizer. After the window
closes, the roster is frozen and any change is an organizer action with a reason.

**When check-in closes:** anyone not checked in gets `entrants.status = 'no_show'`. Do not
immediately delete them — generate the bracket with byes where needed and let §7 handle it. People
walk in at 8:10, and an organizer can move them back to `confirmed`.

**Physical check-in still matters at onsite events.** Have captains come to you, confirm their
playing eleven against the roster on your screen, and check the game-specific stuff:
kabaddi nails and no oil, badminton non-marking shoes, esports device check. Two minutes per team,
done while they self-check-in on their phone.

---

## 7. Running the bracket live, from a phone, on bad wifi

This is the core loop and it is the thing that has to not break.

### 7.1 The loop

1. Open `/admin/t/<slug>/bracket/`. Match statuses are `pending` (opponents not both known yet),
   `ready` (both known, playable), `live`, `complete`, `bye`, `void`. Those six are the whole enum
   (ARCHITECTURE.md §6.6) — there is no `cancelled` and no `disputed` match status. A dispute is an
   organiser act (`reopen` with a public `reason`), not a state.
2. Tap a match → **Start**. Status `live`, `started_at` recorded.
3. For esports, tap **Send room code**. The lobby code and password go to checked-in captains and
   appear on the match page for checked-in players only. Never in a public group.
4. Match ends. Tap the match → the score form, rendered from the game's `scoring.match_fields`.
   Badminton is one text field: `21-18, 19-21, 21-15`. Cricket is toss, runs, wickets, overs ×2.
   BGMI is placement and kills.
5. **Save.** The engine validates the score against `scoring.params`, writes the result, advances the
   winner into the next match, and recomputes standings. Both the public bracket and the standings
   page update on their next poll.
6. Tap **Copy result** and paste it into the group. Ten seconds, and it is what keeps the people who
   are not at the venue watching.

### 7.2 What the platform must guarantee for this to work

These are requirements on the implementation, not suggestions. The venue wifi will be bad.

- **Idempotent score writes.** Every submission carries
  `Idempotency-Key: <match_id>:<client_nonce>`. A retry after a timeout must not advance the bracket
  twice. This is the single most important guarantee in the system: a double-advance on a live
  bracket is unrecoverable in front of players.
- **Optimistic UI with a durable retry queue.** The score shows as saved immediately and queues
  locally (IndexedDB). A pending badge shows the queue depth. Nothing is lost by a tab reload or a
  dead connection.
- **Small payloads.** A score POST is under 2 KB. The bracket poll returns a delta, not the whole
  tournament.
- **No hard reload needed.** Once the admin bracket page has loaded, the organizer can keep working
  through a total connectivity loss and the queue drains when signal returns.
- **Big tap targets.** Steppers, not dropdowns, for numeric scores. This is used one-handed, in
  sunlight, with the other hand holding a clipboard.
- **Poll, do not stream.** Public pages poll on the server-supplied `Poll-After` cadence while a tournament is `live`,
  every 60 seconds otherwise, and stop when the tab is hidden. WebSockets are not worth a Durable
  Object for a club running two events a month.

### 7.3 Organizer field habits

- **Hotspot from your own phone.** Do not trust venue wifi. Budget 100 MB for a full day; the admin
  UI is text.
- **Carry a power bank.** Non-negotiable. The admin panel is the tournament.
- **Enter the score before you announce it.** If you announce first and the save fails, you have two
  versions of the truth in the group.
- **Keep the paper sheet in parallel** for the whole event, not just when things break. It takes
  three seconds per match and it is the evidence in a dispute.
- **Announce the next match while the current one is being scored.** Dead time between matches is
  what makes a day run long.

---

## 8. No-shows and walkovers

The rules, applied identically every time. Announce them at the start of the day so nobody argues
later.

**Grace period: 10 minutes from the scheduled start.** For team sports, a team must have
`team_size_min` players present; short of that, the clock is running.

| Situation | Action | `matches.method` | Score recorded |
| --- | --- | --- | --- |
| One side absent past grace | Present side advances | `walkover` | **none** |
| Both sides absent past grace | Both eliminated, slot moves on | `no_contest`, no winner, both entrants `no_show` | none |
| Team present but below `team_size_min` | 10 more minutes, then walkover against them | `walkover` + note | none |
| Retires mid-match (injury, disconnect they cannot fix) | Opponent advances, partial score kept | `forfeit` | **the score at retirement**, reason in `note` |
| Removed for conduct | Opponent advances | `dq` + reason; entrant `status = 'disqualified'` with `status_reason` | 0–0, winner credited |
| Weather / venue failure, unplayable | No result, points shared in groups; rescheduled in knockouts | `no_contest` | none |

`matches.method` is the column, and its complete enum is
**`normal | walkover | forfeit | dq | no_contest`** (ARCHITECTURE.md §6.6). "Retirement" is
`forfeit`; "double forfeit" and "abandonment" are both `no_contest`. There is no `disqualification`
value — it is `dq`.

**Standings treatment.** The game definition's `standings.match_points` block —
`{win, draw, loss, no_result, walkover_win, forfeit_loss, points_divisor}` (CONTENT.md §2.8) — is
read **in full** by the standings engine. `PointsConfig` in `BRACKET-ENGINE.md` §4 carries all six
values (`win, draw, loss, walkoverWin, forfeitLoss, noResult`) and §10.4's points formula reads all
six, keyed on `matches.method`. They are not decorative: `no_result` is what a weather-abandoned
group match shares to both sides, and it is the only reason a `no_contest` scores at all.

**A walkover records no score at all**, and that is the engine default
(`options.walkoverScore = [null, null]`, `BRACKET-ENGINE.md` §13.2), not a convention an organiser
has to remember. Inventing a notional 2–0 pollutes net run rate and set ratio and will decide a
group on a match nobody played. A tournament whose governing body requires a notional scoreline can
set `walkoverScore` explicitly on the stage; nothing else should.

**All six values are integers.** Chess's half-points are `points_divisor: 2` with 2/1/0 stored and
1/0.5/0 displayed. There are no fractional points anywhere in the system
(`BRACKET-ENGINE.md` §4.3).

**Leaderboard treatment.** An entrant whose non-bye played matches are **all** walkovers or
forfeit-wins is capped at the participation floor — 10 points — regardless of where they finished
(`BRACKET-ENGINE.md` §16.3). A team that reached the semi-final because two opponents never turned
up has not had the tournament a team that won two matches had. This is a flat cap, not a percentage
discount: an award has to be verifiable by looking at the placement table, and a sliding "reduced
share of `leaderboard.default_weight_pct`" is not.

**No-shows are not free.** Entry fee is not refunded (`policies.refunds.no_show`). Three no-shows
across a season is a conversation with the club head; it is the single most damaging thing a player
can do to a small club's schedule.

---

## 9. Resolving a score dispute

**Evidence window: 30 minutes from the match ending.** Say this out loud at the start of the day.
After 30 minutes the score stands.

**The procedure:**

1. **Both sides, one at a time, 60 seconds each.** Do not let them talk to each other while you
   listen. This is the whole trick.
2. **Ask for evidence,** in this priority order:
   - Organizer's own record: the printed sheet, the spectator scoreboard, the arbiter's ruling.
   - A photo of the signed paper score sheet.
   - The in-game end-of-match scoreboard screenshot with its timestamp.
   - Video.
   - Player recollection. Weakest, and where most disputes die.
3. **Decide.** Log it at `/admin/t/<slug>/audit/` — the dispute note is the `reason` on the score correction, which is public on the bracket for 48 h — with: match id, who raised it, both claims, the
   evidence, your decision, your reasoning, timestamp, your actor id. If the score changes, the
   correction is an **amendment** — the original stays visible in the audit trail. Never silently
   overwrite a published score.
4. **Tell both sides the outcome and the reason,** in the same message, in the group where it
   matters. A decision nobody heard the reasoning for is a rumour by evening.
5. **If the bracket already advanced,** the engine must support a correction that re-advances
   downstream matches. Do this immediately, before the next match starts. Once a downstream match has
   been played, the result stands and you note the error publicly instead — unwinding a played match
   is worse than living with the mistake.

**Standing rules that prevent most disputes:**

- The organizer's record is primary. Player screenshots are supporting evidence, not the score.
- For esports, the organizer's spectator scoreboard beats every player screenshot.
- For chess, the arbiter's ruling at the board is final and is not a "dispute".
- Both captains sign the paper sheet before leaving. An unsigned sheet is a weak position and
  everybody learns that fast.

**Appeal:** to the club head, within 24 hours, on WhatsApp, with reasons. Answer within 72 hours.
That answer ends it. Once results are published, nothing reopens except a plain arithmetic error —
and that gets corrected publicly with a note saying what changed and why.

---

## 10. Publishing results

At `/admin/t/<slug>/` once the final is scored:

1. **Freeze the bracket.** No more score edits without a club-head override.
2. **Check the standings by eye.** Walk the tiebreakers on the top three. If two teams are level on
   points and net run rate decided it, confirm the NRR is right — that is the number that gets
   argued about, and a "bowled out counts full quota" bug shows up exactly here.
3. **Fill the placements** — champion, runner-up, third, plus the individual awards.
4. **Publish.** Status → `completed`. The public page switches to results mode, the leaderboard job
   awards season points using `tournaments.leaderboard_weight_pct`, which was seeded from the game's
   `leaderboard.default_weight_pct`.
5. **Announce** with the "Results published" template. Name the winners, name one individual
   performance, link the full bracket.

### 10.1 Paying the prizes

Pay before the venue closes. Cash-in-hand credibility is worth more than any Instagram post.

- Team prizes go to the **registered captain's UPI ID**, whole. The team splits it themselves; the
  club does not (`policies.prizes.team_payout`).
- Record every payout against the registration: amount, method, outbound UTR, timestamp, your actor
  id. `/admin/t/<slug>/results/`.
- **Above ₹10,000** to a single winner: collect a PAN, deduct tax at source as required, and hand
  over a receipt showing gross, deduction and net. Get the current threshold and rate from a CA —
  `content/club.json → todo_verify` flags this as unverified.
- A winner **under 18** is paid to the guardian's UPI ID (`policies.age.under_18_prize_note`).
- Photograph the winners with the cheque or the phone screen. That photo is next month's poster.

---

## 11. Post-event wrap

**Within 24 hours** — this is where a club compounds or stalls.

1. Results published and the announcement sent. (Should already be done at the venue.)
2. All payouts recorded with UTRs. Any pending refund sent.
3. Photos up: 6–10 good ones, not 60. Faces, not wide shots of an empty ground.
4. **Reconcile the money.** Entry fees in, venue and consumables out, prizes out, what is left.
   Write it down. A club that does not know whether an event made or lost money will run the same
   losing event again.
5. **Write three lines for yourself:** what ran late, what confused people, what you would change.
   Next month you will not remember.
6. Message everybody who played, once, with the results link and the next event's date. Highest
   converting message in the whole cycle.
7. Message everybody who registered and did not show, once, asking why. You will learn something.
8. Close out disputes: anything unresolved gets a final ruling and is marked closed.
9. Tease the next event. "Next up: badminton doubles, 5 Oct. Registration opens Monday."

**Within a week:** confirm the venue for next time, and check the leaderboard rendered correctly —
a game weight that is wrong shows up as a standings order nobody expected.

**11.4 If the event was abandoned partway:** decide the payout rule *before* announcing anything.
Group stage complete but knockouts not played → pay group-stage-based placings only, and say so.
Nothing meaningful played → full refunds. Whatever you choose, announce it once, apply it to
everybody identically, and do not negotiate individually.

---

## 12. When the platform is unreachable

Cloudflare has an incident. The venue has no signal and your data has run out. Your phone is dead
and the spare is not signed in. **The event does not stop.**

### 12.1 The printed pack — prepare this the night before, every time

Print from `/admin/t/<slug>/print/` (a plain, black-and-white, no-JavaScript page):

1. **The bracket**, one page, with empty score boxes.
2. **The fixture list** with times and, for onsite events, court or pitch assignment.
3. **Contact sheet** — captain names and phone numbers. **This is the one sheet with personal data
   on it. It stays in your pocket, and it gets shredded within 48 hours** (§13.5).
4. **Blank score sheets**, one per match, pre-headed with the two sides and the fields from the
   game's `match_fields`.
5. The prize table and the rules summary.

Total: about six sheets. ₹20 at any shop. Do it every single time, including the times you are sure
you will not need it.

### 12.2 Declaring fallback mode

Say it once, clearly, in the group and out loud at the venue:

> **"The site is down. We are running on the printed bracket. The paper sheet is the official record
> until we are back online. Results will be updated on the site tonight."**

From that announcement, **the paper is authoritative.** Do not run half on paper and half on the
site — that is how two versions of the truth get created, and reconciling them at 10 PM is worse
than any outage.

### 12.3 Running on paper

- Fixtures and match times come off the printed sheet.
- Scores are written on the score sheet and **signed by both captains**. Unsigned sheets cause
  disputes you cannot settle later.
- **Photograph every completed sheet** immediately with your phone camera. Local storage, no
  network needed. This is your backup for the backup.
- Broadcast results to the group as plain text messages. People not at the venue still get to
  follow along.
- Advance the bracket by hand on the printed page, in pen.

### 12.4 Backfilling when you are back online

Same evening, not "sometime this week".

1. Enter every match in **chronological order**. Out-of-order entry confuses bracket advancement.
2. Set `played_at` to the actual time from the paper sheet, not the time you are typing. Standings
   and the leaderboard read `played_at`.
3. Mark each backfilled match `entry_source = 'offline_backfill'` so the audit trail shows why forty
   matches were entered in nine minutes.
4. Re-check the standings against your paper table before publishing. If they disagree, find out
   why before you publish, not after.
5. Keep the photographed sheets until the event is fully closed out and no dispute is open.

### 12.5 Reducing the chance you need this

- The public tournament page is a static asset served from Cloudflare's edge. It survives a lot,
  including your Worker being broken.
- The admin bracket page keeps working after first load, with writes queued (§7.2). Load it before
  you leave home, on your home wifi, and do not close the tab.
- Two organizer devices signed in, when you have two organizers.

---

## 13. Data protection — the DPDP posture

India's Digital Personal Data Protection Act, 2023 applies to this club. The club is a **Data
Fiduciary**; players are **Data Principals**. This section is the operating posture. It is not legal
advice, and `content/club.json → todo_verify` flags what needs a lawyer.

The short version: **the phone numbers are the risk.** Everything else on this platform is a game
score.

### 13.1 What is collected and why

| Data | Purpose | Where it lives |
| --- | --- | --- |
| Name | Identifies you on the bracket and in results | `entrants.display_name`, `entrant_members.display_name`, `fields_json` |
| WhatsApp number | Fixtures, room codes, schedule changes, prize payment | **Encrypted** (AES-256-GCM under `PII_KEY`) in `users.phone_enc`, `entrants.guest_phone_enc` or `entrant_members.phone_enc`, with `phone_last4` in the clear. `fields_json` holds **only the mask** (`+91 ••••• •4417`) — never the number (SECURITY.md §10.2.1). `visibility: "organizer"`, `pii: true` |
| Age | Enforcing the game's minimum age | `users.is_adult` (a yes/no, never a date of birth), plus `fields_json` where a game asks |
| Guardian's number | Consent for players under 18 | `entrant_members.phone_enc` + the mask in `fields_json`, as above |
| In-game IDs, ratings, jersey number | Running the game itself; prefilled next time | `entrant_members.ingame_id`, `users.profile_answers_json`, `fields_json` — `pii: false` |
| Locality | Choosing venues near most players | `users.city`, `fields_json` |
| UPI reference (UTR) | Reconciling payment; financial record | `entrants.payment_ref` |
| Match results | Public record, standings, leaderboard | `matches`, permanent |
| Passkey credential | Signing you in | `webauthn_credentials` — a public key, no biometric ever leaves the device |
| Session, IP, user-agent | Security and session revocation | `sessions`, short-lived |

**No behavioural tracking. No analytics SDK. No advertising. No third-party scripts.** This is a
club website; it does not need to know what you scrolled past. Keeping it that way removes the
entire "targeted advertising to children" problem under the DPDP Act rather than managing it.

### 13.2 Notice and consent

Show this at registration, above the submit button — not behind a link, not in a modal:

> **How we use this**
> We use your name and WhatsApp number to run this tournament: fixtures, room codes, schedule
> changes and prize payment. Your number is never shown publicly and never shared with anyone.
> Your name and your results appear on the public bracket. You can ask us to delete your account and
> your personal details any time.
> [ ] I agree.

Plain language, purpose stated, no bundling. Consent for running the event is separate from consent
for photos (opt-out at the venue) and from any future promotional messaging (opt-in only, and there
is none today).

**Under 18:** the guardian's number is required and a consent message goes to the guardian before the
player's first match. The registration is not confirmed until the guardian replies. Log that reply
with a timestamp. Under-18 players are never targeted with anything, because nothing here targets
anybody.

### 13.3 Retention

| Class | Retention |
| --- | --- |
| Sessions | Expire after 30 days idle, 90 days absolute. Revocable individually or all-at-once by the player. |
| Server logs (IP, user-agent) | 30 days, then gone. |
| Contact details — every field with `pii: true` | **18 months after the player's last event**, then nulled. |
| In-game IDs, ratings, profile values | 24 months after last event. |
| Payment records (UTR, amount, payout) | Kept as long as tax law requires the club's books — confirm the number with a CA. These are club financial records, held separately from the player profile. |
| Match results and standings | Permanent. This is the public record and the leaderboard depends on it. |
| Photos | Until a takedown is requested. |
| Printed contact sheets | **Shredded within 48 hours of the event.** |

**The purge job** is job **§10.6 of the nightly cron** (`AUTH.md` §10), not a separate monthly
trigger — there is exactly one Cron Trigger in `wrangler.jsonc` and it runs eleven jobs, of which
this is one. It is capped at 500 entrants per run because it is a read-modify-write on a JSON blob,
not a bulk `UPDATE`; a backlog is fine and is logged, not an error.

For every player whose last match is older than 18 months:

- null every field marked `pii: true` in the tournament's snapshot definition, in **both**
  `entrants.fields_json` and `entrant_members.fields_json`;
- null the promoted copies — **`entrants.guest_phone_enc` / `guest_phone_last4` / `contact_email`,
  `entrant_members.phone_enc` / `phone_last4` / `ingame_id` / `ingame_name`, `users.phone_enc` /
  `phone_hash` / `phone_last4`** — and set `entrant_members.display_name` and
  `entrants.display_name` to `Player #<short id>`;
  (Those are the real column names in `db/schema.sql`. `entrant_members.phone`,
  `players.phone` and `players.default_ingame_ids_json` do **not** exist — the table is `users` and
  the phone column is encrypted. Profile prefill values live in `users.profile_answers_json`, which
  is nulled with the rest.)
- clear `users.profile_answers_json`;
- leave `matches`, `match_participants`, `standings` and `points_ledger` completely untouched.

The promoted columns are the part that gets forgotten. Nulling the JSON blob and leaving
`entrant_members.phone_enc` populated is a purge that did not purge anything. Log what was purged as
counts and a timestamp — **never log the values.**

There is a **second, earlier** purge that this table does not cover and that must not be confused
with it: the **180-day entrant-contact purge**, cron job §10.5, which nulls
`entrants.guest_phone_enc` / `contact_email` / `notes` and `entrant_members.phone_enc` 180 days
after a *tournament* completes, regardless of when that player last played (SECURITY.md §10.4). The
18-month job above is keyed on the *player*; the 180-day job is keyed on the *event*. Both run.

### 13.4 Player rights, and how to actually service them

| Right | How | SLA |
| --- | --- | --- |
| Access — a copy of my data | Self-serve export from the account page: JSON of profile, registrations and matches | Immediate |
| Correction | Edit in the account page. Answers on a locked registration need an organizer. | Immediate / same day |
| Erasure | "Delete my account" in the account page, or a WhatsApp message from a registered number | **30 days**, usually same day |
| Withdraw consent | Same as erasure. Withdrawing means we can no longer run events for you. | 30 days |
| Grievance | The named grievance officer in `content/club.json`. **Currently null and blocking.** | 30 days |

**What "delete" actually does:** passkey credentials and sessions are destroyed; every `pii: true`
value is nulled; the display name becomes `Player #<id>`; profile values are wiped; match results,
scores and standings survive with the pseudonymised name. Say this in exactly these words when
someone asks, because "we deleted everything" is not true and they will notice their old result
still on the bracket.

An open payment or an unpaid prize pauses the personal-data deletion until it is settled. Say so
when it happens.

### 13.5 Operator rules — the ones that get broken

1. **Never export the registration list to a spreadsheet and put it in a WhatsApp group.** This is
   the single most likely breach at a club, and it is one tap. Use the admin panel.
2. **Phone numbers never appear in a public API response.** The serializer strips by `visibility`
   (`docs/CONTENT.md` §3.2). If a phone number ever renders on a public page, that is a P0.
3. **Scorers do not see contact details.** That is why the scorer role exists.
4. **The printed contact sheet is shredded within 48 hours.** Not left in the kit bag.
5. **No player data goes to a sponsor.** Not a list, not a count broken down by anything, not "just
   the numbers of the finalists".
6. **Do not add an analytics or ad script "just to see traffic".** It changes the compliance posture
   of the whole site.

### 13.6 If there is a breach

1. Contain it — revoke sessions, rotate secrets, take the affected endpoint offline.
2. Establish what data, whose, and how much. The audit log is the source.
3. Notify affected players directly and plainly: what happened, what data, what you have done, what
   they should do.
4. Notify the Data Protection Board as the law requires. Confirm the current form and deadline with
   counsel — assume it is short and assume it is mandatory.
5. Write it up: cause, fix, prevention. Keep the record.

### 13.7 Processors

Cloudflare is the only data processor: Workers, D1, and Static Assets. Data sits in Cloudflare's
network. There is no analytics vendor, no email vendor, no SMS vendor, no CRM and no ad network.
**Adding any of them is a decision that changes this section**, so it gets made deliberately rather
than in a pull request.

---

## 14. Quick reference — event day

Screenshot this.

```
T−60   Arrive. Venue check. Check-in window opens.
T−45   Captains report. Roster + kit checks.
T−15   Check-in closes. Mark no-shows.
T−10   Announce first fixtures. Send room codes (esports).
T−0    Start match 1.
       ── loop ──────────────────────────────────
       Start → play → enter score → save → copy result to group
       Announce the next match while scoring the last one.
       Paper sheet in parallel, signed, photographed.
       ──────────────────────────────────────────
END    Freeze bracket. Check standings by eye. Publish.
       Pay prizes by UPI. Record every UTR.
       Winners' photo.
+24h   Photos posted. Money reconciled. Message players. Tease next event.
+48h   Shred the printed contact sheet.
```

**The four rules that matter most, if you remember nothing else:**

1. Print the pack. Every time.
2. Enter the score before you announce it.
3. Pay the prize money before the venue closes.
4. The phone numbers are the only thing here you can genuinely hurt someone with. Treat them that
   way.
