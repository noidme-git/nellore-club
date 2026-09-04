# nellore.club — authentication and authorization

**Status: normative.** Where this document and [`API.md`](./API.md) disagree about an auth mechanism,
this document wins. Where it disagrees with [`SECURITY.md`](./SECURITY.md) about a control, this
document wins for *how* and SECURITY.md wins for *why*.

---

## 1. The constraint, and the shape of the answer

There is **no email provider and no SMS provider**. Buying one must not be a launch blocker. Everything
below therefore works with zero external paid dependencies:

| Method | Cost | Status |
| --- | --- | --- |
| **Passkeys (WebAuthn)** | ₹0 | **Primary.** Every account has at least one. |
| **Recovery codes** | ₹0 | **Mandatory backup.** Issued at signup, 10 single-use codes. |
| **Admin bootstrap token** | ₹0 | First admin only, from a Worker secret. |
| **Guest capability token** | ₹0 | Walk-in entrants with no account at all. |
| Email OTP / magic link | needs a provider | **Optional, off by default, behind an env var.** |
| SMS OTP | needs a provider, and DLT registration in India | **Not implemented. Do not add it.** |

Passkeys are not a compromise here, they are the right primitive for this audience. The typical
nellore.club user is on a mid-range Android phone with a fingerprint sensor and a Google account that
already syncs passkeys. Signing in is one tap on a sensor: no password to forget, no OTP to wait for
on patchy 4G, no SMS cost, and nothing phishable. The thing passkeys are genuinely bad at — device
loss with no sync — is exactly what the recovery codes cover.

**SMS OTP is explicitly out of scope forever.** In India, transactional SMS requires TRAI DLT
registration of the sender ID and every template, it costs per message, and delivery on a crowded
evening is unreliable. It would be the most expensive and least reliable part of the system.

---

## 2. WebAuthn parameters (fixed, do not vary per environment except where stated)

| Parameter | Value | Why |
| --- | --- | --- |
| **RP ID** | `nellore.club` | The registrable apex. A passkey scoped to the apex is valid on `www.nellore.club` too (a subdomain of the RP ID), so the www→apex redirect cannot strand anyone mid-ceremony. Scoping to `www.` would have permanently excluded the apex. |
| **RP name** | `Nellore Club` | Shown in the OS passkey prompt. Keep it short — Android truncates. |
| **Allowed origins** | `https://nellore.club`, `https://www.nellore.club`; plus `http://localhost:8787` **only when `ENVIRONMENT !== "production"`** | Verified server-side against `clientDataJSON.origin`. The localhost entry is gated on the env var and must be impossible to enable in production. |
| **Attestation** | `"none"` | We do not verify attestation and would not act on it. Requesting `"direct"` triggers an extra scary consent dialog on some platforms, returns data we would only throw away, and on Safari/iCloud Keychain returns nothing useful anyway. |
| **Algorithms** | `[-7, -257]` — ES256, RS256 | ES256 covers Android, iOS, macOS, and every FIDO2 key. RS256 covers Windows Hello TPMs. Adding EdDSA (`-8`) is harmless but buys nothing today. |
| **`residentKey`** | `"required"` (and `requireResidentKey: true`) | Discoverable credentials. This is what makes **usernameless sign-in** work: the user taps "Sign in", the OS shows their passkey, done. Nobody has to remember a handle. |
| **`userVerification`, registration** | `"preferred"` | See §2.1. |
| **`userVerification`, authentication** | `"preferred"` | See §2.1. |
| **`authenticatorAttachment`** | *unset* | Allows both the phone's own sensor (platform) and a security key or a second phone via hybrid/QR (cross-platform). An organizer at a desktop scoring table signs in by scanning a QR with their phone; forcing `"platform"` would break that. |
| **Timeout** | 120 s in the options, 120 s server-side challenge TTL | Matched deliberately. A shorter server TTL produces "the ceremony worked but the server says expired", which is unfixable from the user's side. |
| **`hints`** | omitted | Newer spec field, inconsistent browser support in 2026; nothing depends on it. |

### 2.1 The user-verification policy, and why it is `preferred` and not `required`

`userVerification: "required"` guarantees a biometric or PIN, and it also hard-fails on the long tail
of cheap Android handsets, ROM-modified devices, and older WebViews that this club's audience actually
owns. A player who cannot register at all is a worse outcome than a player whose passkey is
possession-only.

So the policy is two-tier, and it is enforced server-side, not by asking politely:

1. `userVerification: "preferred"` in every ceremony. Almost every real device performs UV anyway.
2. The server **records the UV bit** from the authenticator data on every authentication into
   `sessions.uv`.
3. **Every privileged action requires `sessions.uv = 1`.** Specifically: all `/api/v1/admin/*`
   mutations, `POST /organizer/.../publish` and `/unpublish`, `POST /admin/users/:id/role`,
   `POST /auth/recovery/codes`, `DELETE /api/v1/me`, and adding a credential — **except adding a
   credential from a recovery-scoped session, where the redeemed single-use recovery code is itself
   the authenticating factor (§7.3.1).** A `uv = 0` session hitting one of these gets
   `403 uv_required`, and the client re-runs the authentication ceremony with
   `userVerification: "required"` to upgrade the session in place. That remedy is impossible for a
   user who has just lost their only passkey, which is exactly why the recovery exception exists.

A player can therefore always get in and always register for a tournament. Nobody can change a score
or grant a role from a session that never proved a human was present.

### 2.2 The library

**`@simplewebauthn/server` v13** (server) and **`@simplewebauthn/browser` v13** (client).

- It is **WebCrypto-based and runtime-agnostic**. From v10 the package deliberately dropped its Node
  `crypto` dependency and is published as isomorphic ESM that runs on Cloudflare Workers, Deno and
  Bun. There is no polyfill, no `node:crypto` import, and no shim to maintain.
- No `nodejs_compat` compatibility flag is required. (If a transitive dependency ever demands
  `Buffer`, adding `"compatibility_flags": ["nodejs_compat"]` to `wrangler.jsonc` is harmless and
  costs nothing at runtime — but verify with `wrangler dev` before assuming you need it.)
- The four functions used: `generateRegistrationOptions`, `verifyRegistrationResponse`,
  `generateAuthenticationOptions`, `verifyAuthenticationResponse`.
- `@simplewebauthn/browser` is ~5 KB gzipped and handles the base64url ↔ `ArrayBuffer` marshalling
  and the conditional-UI (`useBrowserAutofill`) plumbing, which is the part that is fiddly to
  hand-write and easy to get wrong on Android WebView.
- Note the v13 API shape: `verifyRegistrationResponse` returns
  `registrationInfo.credential = { id, publicKey, counter, transports }`, not the pre-v10 flat
  `credentialID` / `credentialPublicKey`. Older tutorials will not compile.

**Rejected:**
- *Hand-rolling it.* The ceremony is CBOR decoding of the attestation object, COSE key parsing,
  authenticator-data flag extraction, and ECDSA/RSA signature verification over
  `authData || SHA-256(clientDataJSON)`. Every one of those is a place where a subtle bug is a
  complete authentication bypass rather than a visible failure. This is the last code in the product
  that should be original.
- *`fido2-lib`.* Depends on Node's `crypto` and on `jsrsasign`; does not run on Workers without
  substantial shimming.
- *`webauthn-p256` (ox / viem family).* P-256 only, and it implements signature verification, not the
  ceremony — no challenge binding, no origin checking, no RP ID hash comparison. Using it means
  writing the security-critical half yourself.

---

## 3. The ceremonies

All four endpoints:
- are `POST`, `Content-Type: application/json`;
- require a valid `Origin` header (§ SECURITY.md §5), but **not** `X-CSRF-Token` — a caller with no
  session has no CSRF token to send;
- are rate-limited (`rl_auth_begin` / `rl_auth_verify`, API.md §7);
- respond `Cache-Control: private, no-store`.

### 3.1 Registration — `POST /api/v1/auth/passkey/register/options`

Three distinct callers use this endpoint. The server decides which from the request, never the client:

| Caller | Detected by | Result |
| --- | --- | --- |
| **New user signing up** | no session, no `bootstrap_token` | Creates a `player` on verify. Requires `SIGNUP_OPEN != "0"`, else `403 signup_closed`. |
| **First admin bootstrapping** | no session, valid `bootstrap_token`, no admin exists | Creates an `admin` on verify. §6. |
| **Existing user adding a device** | valid session (this is `POST /api/v1/me/credentials/options`, §3.5) | Adds a credential to the existing user. |

**Request**
```jsonc
{
  "handle": "arjun_n",             // required for signup; ^[a-z0-9][a-z0-9_]{2,19}$
  "display_name": "Arjun N",       // required for signup; 2..60 chars, SECURITY.md §7.2 charset
  "bootstrap_token": null          // optional, §6
}
```

**Server work, in order**
1. Rate limit. Normalise `handle` to lowercase NFC; validate the charset; reject reserved handles
   (API.md Appendix B) with `409 handle_taken`.
2. `SELECT 1 FROM users WHERE handle = ?` and `SELECT 1 FROM handle_reservations WHERE handle = ? AND released_at > ?`
   → `409 handle_taken` on either.
3. Generate `webauthn_user_id` = 32 CSPRNG bytes, base64url. **This, not the ULID, is the WebAuthn
   user handle.** It is opaque, contains no PII, and it is what a discoverable credential hands back
   at login (§3.3), so it must be stable and unique per user forever.
4. `generateRegistrationOptions({ rpID, rpName, userID, userName: handle, userDisplayName: display_name,
   attestationType: 'none', authenticatorSelection: { residentKey: 'required', requireResidentKey: true,
   userVerification: 'preferred' }, supportedAlgorithmIDs: [-7, -257], timeout: 120000,
   excludeCredentials: [...] })`.
   `excludeCredentials` is the existing user's credentials when adding a device (so the same phone
   cannot be enrolled twice), and `[]` for a new signup.
5. Persist the challenge (§3.4) with `purpose = 'register'`, and — this is the part that is easy to
   miss — **the pending `handle`, `display_name`, `webauthn_user_id`, and `intent`
   (`signup` | `add_credential` | `bootstrap_admin`) on the challenge row itself.**
   The verify step reads them from there and **never** from its own request body. If the client could
   re-send the handle at verify time, it could complete a ceremony for handle A and be created as
   handle B, or as an admin.

**200**
```jsonc
{ "data": { "options": { /* PublicKeyCredentialCreationOptionsJSON, verbatim from the library */ } } }
```

### 3.2 Registration — `POST /api/v1/auth/passkey/register/verify`

**Request**
```jsonc
{ "response": { /* RegistrationResponseJSON from @simplewebauthn/browser startRegistration() */ } }
```

Nothing else. No handle, no user id, no intent — all of that lives on the challenge row.

**Server work, in one `.batch()` after verification**
1. Extract the challenge from `response.response.clientDataJSON`, look it up in
   `webauthn_challenges`, and **consume it atomically**:
   `UPDATE webauthn_challenges SET consumed_at = ?1 WHERE challenge = ?2 AND purpose = 'register' AND consumed_at IS NULL AND expires_at > ?1`.
   `meta.changes !== 1` → `400 webauthn_challenge_expired`. A single-use challenge enforced by an
   atomic conditional update is the whole replay defence; do not implement it as read-then-write.
2. `verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin: ORIGINS,
   expectedRPID: 'nellore.club', requireUserVerification: false })`.
   `verified !== true` → `400 webauthn_verification_failed`.
3. Re-check the handle is still free (someone may have taken it during the 120 s ceremony) →
   `409 handle_taken`.
4. If `intent = 'bootstrap_admin'`: re-verify the bootstrap token is still configured **and** that no
   admin exists → else `409 bootstrap_closed`. (§6 — the check is repeated here because the state can
   change between options and verify.)
5. Insert the `users` row (role per intent), the `webauthn_credentials` row, **and the ten recovery
   codes** (§4). All in the same batch — a user cannot exist without a recovery set.
6. Mint a session (§5) with `uv` from the verification result's `userVerified`, `scope = 'full'`.
7. Write the audit row (`user.signup` or `admin.bootstrap` or `credential.add`).

**201**
```jsonc
{
  "data": {
    "user": { "id": "usr_...", "handle": "arjun_n", "display_name": "Arjun N", "role": "player" },
    "credential": { "id": "crd_...", "label": "Phone", "backed_up": true },
    "recovery_codes": ["8H4K2-9QMTX", "..."],   // ONLY on signup, ONLY here, ONLY once
    "session": { "id": "ses_...", "uv": true, "scope": "full" }
  }
}
```
`Set-Cookie: __Host-nc_session=...` (§5.1).

`recovery_codes` is present **only** on the signup/bootstrap path and is never retrievable again.
The UI must block the "continue" button behind a "I have saved these" confirmation and offer a
copy-to-clipboard and a printable sheet that also carries the user's handle (the handle is required
at recovery time — §4.3).

**Stored fields on the credential:** `credential_id` (base64url), `public_key` (BLOB, the COSE key
the library returns), `counter`, `transports_json`, `backup_eligible` (BE flag),
`backup_state` (BS flag), `aaguid`, `device_type` (`singleDevice` | `multiDevice`), `label`,
`created_at`, `last_used_at`.

`backup_eligible = 0` means a device-bound passkey that will **not** survive losing the phone. When
that is the user's only credential, the UI shows a persistent "add a second passkey or keep your
recovery codes safe" banner. This is the single highest-value bit of UX in the whole auth design and
it costs one column.

### 3.3 Authentication — `POST /api/v1/auth/passkey/login/options`

**Request**
```jsonc
{ "handle": null, "mediation": "conditional" }   // both optional
```

- `handle` omitted (the default and the intended path) → `allowCredentials: []`, fully discoverable.
  The browser/OS shows whatever passkeys exist for `nellore.club`. **This is why `residentKey` is
  `required`.**
- `handle` supplied → `allowCredentials` is populated from that user's credentials. Used only by the
  "sign in with a security key that isn't discoverable" fallback. It is an enumeration oracle
  (a bad handle would return an empty list), so it is neutralised: an unknown handle returns a
  **normal-looking options object with `allowCredentials: []`**, indistinguishable from success. The
  ceremony then simply fails at verify.
- `mediation: "conditional"` → the client passes `useBrowserAutofill: true`, and the passkey appears
  in the browser's autofill dropdown as the page loads. Free, and it is the smoothest sign-in the web
  has; use it on the sign-in page.

`generateAuthenticationOptions({ rpID, userVerification: 'preferred', timeout: 120000, allowCredentials })`.
Persist the challenge with `purpose = 'login'`.

**200** `{ "data": { "options": { /* PublicKeyCredentialRequestOptionsJSON */ } } }`

### 3.4 Authentication — `POST /api/v1/auth/passkey/login/verify`

**Request** `{ "response": { /* AuthenticationResponseJSON */ } }`

**Server work**
1. Consume the challenge atomically, exactly as §3.2 step 1 but `purpose = 'login'`.
2. `response.response.userHandle` is the `webauthn_user_id` from §3.1 step 3 (present for
   discoverable credentials). Resolve the user by it. Also resolve the credential by
   `response.rawId`. **Both must resolve to the same user** or `400 webauthn_verification_failed` —
   a mismatch means a credential is being replayed against a different account.
3. `verifyAuthenticationResponse({ response, expectedChallenge, expectedOrigin: ORIGINS,
   expectedRPID: 'nellore.club', credential: { id, publicKey, counter, transports },
   requireUserVerification: false })`.
4. **Signature-counter check.** Let `stored` be the saved counter and `new` the returned one.
   - `stored > 0 && new <= stored` → **reject**, `400 webauthn_verification_failed`, write an audit
     row `auth.counter_regression`, and flag the credential for the user to review. This is the clone
     detector.
   - `stored === 0 && new === 0` → **accept.** Synced platform passkeys (Google Password Manager,
     iCloud Keychain) always report 0. Rejecting this would lock out essentially the entire target
     audience. Do not "fix" this.
   - otherwise update `counter = new`.
5. **Refuse if `users.status <> 'active'`** → `403 forbidden`, `details.reason: "suspended"` (or
   `"banned"`). Test `status`, **not** `suspended_until`: an indefinite suspension sets
   `suspended_until = NULL`, and a timestamp test reads that as *unsuspended*, so the banned user
   signs back in seconds after the epoch bump appeared to work. `suspended_until` is only the
   auto-lift timestamp for the cron (§7.2, §10.4).
   Refuse if `users.deletion_requested_at IS NOT NULL` → `403 forbidden`,
   `details.reason: "deletion_pending"`, with a hint to call `POST /api/v1/me/undelete`… which needs a
   session. So: signing in during the 30-day window **is allowed** and automatically surfaces the
   undelete prompt. Only a *finalised* deletion (no user row) fails.
6. Update `last_used_at`, `backup_state` (a passkey can become backed up later — refreshing this is
   how the "your passkey is now synced" banner clears itself).
7. Mint a session (§5). Revoke any pre-existing session presented in the request's cookie (§5.6).

**200** — same shape as §3.2 minus `recovery_codes`, plus `Set-Cookie`.

### 3.5 Adding a credential to an existing account

`POST /api/v1/me/credentials/options` and `/verify`. Identical to §3.1/§3.2 except: session required,
**`sessions.uv = 1` OR `sessions.scope = 'recovery'` required** (`403 uv_required` otherwise),
`intent = 'add_credential'` bound to the challenge with the session's `user_id`,
`excludeCredentials` populated, and **no** new recovery codes issued.

A recovery-scoped session (§4.4) may call these two endpoints and nothing else — that is the entire
point of the recovery flow, and it is why the UV requirement is waived for it. A recovery session
has `uv = 0` by construction (§4.3 step 6); requiring UV here would make the only two endpoints it
may call the only two it is guaranteed to fail, leaving the account permanently unrecoverable. See
§7.3.1 for the full argument.

### 3.6 Challenge storage

```sql
CREATE TABLE webauthn_challenges (
  challenge         TEXT PRIMARY KEY,          -- base64url, 32 CSPRNG bytes, from the library
  purpose           TEXT NOT NULL,             -- 'register' | 'login'
  intent            TEXT,                      -- 'signup' | 'add_credential' | 'bootstrap_admin' | NULL
  user_id           TEXT,                      -- set for add_credential
  pending_handle    TEXT,                      -- set for signup / bootstrap_admin
  pending_display   TEXT,
  webauthn_user_id  TEXT,                      -- base64url, set for signup / bootstrap_admin
  ip_hash           TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,          -- created_at + 120
  consumed_at       INTEGER
);
CREATE INDEX idx_wac_expires ON webauthn_challenges (expires_at);
```

- **TTL 120 s**, matching the ceremony timeout exactly.
- **Single use**, enforced by the atomic `UPDATE ... WHERE consumed_at IS NULL AND expires_at > now`
  and checking `meta.changes === 1`.
- Swept by the nightly cron: `DELETE FROM webauthn_challenges WHERE expires_at < ?`. Also
  opportunistically deleted on consume.

**Rejected: a stateless HMAC challenge in a cookie.** It saves one D1 write per ceremony and it cannot
enforce single use without state anyway, so the replay window would be the full 120 s. Two D1 writes
per sign-in is not a budget problem; a replayable challenge is a real one.

**Rejected: Workers KV for challenges.** KV is eventually consistent. A "consume" written to one colo
is not reliably visible at another within 120 s, which turns single-use into best-effort.

---

## 4. Recovery codes

### 4.1 Generation

- **10 codes** per batch, issued at signup and regenerable.
- Each code is **50 bits** of CSPRNG entropy rendered in Crockford base32 minus vowels and ambiguous
  glyphs — alphabet `23456789BCDFGHJKMNPQRSTVWXYZ` (28 symbols) — as **10 characters** grouped
  `XXXXX-XXXXX`, e.g. `8H4K2-9QMTX`. 28^10 ≈ 2^48.1; call it 48 bits and it is still far beyond
  online guessing.
- Normalisation before hashing or comparing: uppercase, strip everything not in the alphabet
  (so `8h4k2 9qmtx`, `8H4K2-9QMTX` and `8H4K29QMTX` are the same code). Crockford's substitutions are
  applied first: `O`→`0`… except `0` is not in our alphabet, so instead **`O`, `I`, `L`, `U`, `A`,
  `E`, `0`, `1` are rejected outright** rather than mapped, which is unambiguous and avoids a
  homoglyph mapping table.

### 4.2 Storage

```
code_hash = hex( HMAC-SHA256( key = RECOVERY_PEPPER, message = user_id || ":" || normalised_code ) )
```

`RECOVERY_PEPPER` is a **Worker secret**, 32 random bytes, never in D1 and never in the repo. Binding
the user id into the message means two users can hold the same code string without colliding, and a
code stolen from user A's row cannot be tested against user B.

**Why a keyed hash and not PBKDF2/scrypt/bcrypt.** **Workers bill CPU per millisecond**, so PBKDF2 at
any honest iteration count turns a login into a CPU-heavy request an attacker can weaponise into a
cost attack — and `/auth/recovery/login` is unauthenticated, which is the worst possible place to
put deliberately expensive work. (This project deploys on **Workers Paid**, 30 s CPU per request —
ARCHITECTURE.md §2 — so the argument is billing and amplification, **not** a 10 ms wall. An earlier
draft of this paragraph justified the choice by the free plan's 10 ms cap; that premise is wrong for
this deployment and the conclusion does not depend on it.)

The threat a slow KDF defends against is offline cracking of a stolen database. Here, a stolen D1
database yields nothing without `RECOVERY_PEPPER`, which lives in a different system (Cloudflare
secret storage). Combined with 48 bits of entropy per code, the keyed hash is both faster and, in this
threat model, stronger.

The trade is explicit: if an attacker gets **both** the D1 dump **and** the Worker secret, the codes
fall instantly whereas PBKDF2 would have bought some hours. That scenario is a total compromise
already — they would also have `SESSION_PEPPER` and `PII_KEY`.

The DDL lives in `db/schema.sql`, which is authoritative. Reproduced here for reading only:

```sql
CREATE TABLE recovery_codes (
  id            TEXT PRIMARY KEY,        -- rec_<ulid>
  user_id       TEXT NOT NULL,
  batch_id      TEXT NOT NULL,
  code_hash     TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  used_at       INTEGER,
  used_ip_hash  TEXT,
  superseded_at INTEGER                  -- set when a NEWER batch is generated
);
CREATE UNIQUE INDEX ux_rc_user_hash  ON recovery_codes (user_id, code_hash);
CREATE INDEX ix_rc_user_unused ON recovery_codes (user_id)
  WHERE used_at IS NULL AND superseded_at IS NULL;
CREATE INDEX ix_rc_batch ON recovery_codes (batch_id);
```

**Regeneration is a soft supersede, not a delete** — `superseded_at`, and the partial index built on
it, are the schema's shape and the schema wins on columns. It preserves the audit of how many
batches existed and when. **The consequence is that `superseded_at IS NULL` must appear in the
redemption `WHERE` clause** (§4.3 step 4) or regenerating codes does not invalidate the old sheet at
all — and regeneration is precisely the remedy the UI prompts for when a printed sheet is lost or
photographed (§4.5). Getting that wrong leaves the compromised codes live forever: the
account-takeover primitive survives its own remediation.

### 4.3 Redemption — `POST /api/v1/auth/recovery/login`

**Request** `{ "handle": "arjun_n", "code": "8H4K2-9QMTX" }` — **both required.**

Requiring the handle means an attacker must target a specific account rather than spraying one guessed
code across every account in the club. The handle is printed at the top of the recovery sheet next to
the codes, so a user who has the sheet has both.

**Server work**
1. `rl_recovery` (5 / 60 s / IP) and `rl_recovery_user` (10 / 24 h / user, D1 counter). Either →
   `429`.
2. Resolve the user by handle. **If the handle does not exist, still perform a dummy HMAC and return
   the same `401 invalid_recovery_code` after the same work** — no user-enumeration oracle.
3. `users.recovery_locked_until > now` → `429 recovery_locked` with `details.retry_after`.
4. Compute `code_hash`. Consume atomically:
   ```sql
   UPDATE recovery_codes SET used_at = ?1, used_ip_hash = ?2
    WHERE user_id = ?3 AND code_hash = ?4
      AND used_at IS NULL
      AND superseded_at IS NULL      -- ← a code from a regenerated batch is DEAD
   ```
   `meta.changes === 1` → success. `0` → failure. **Single-use *and* batch validity are enforced by
   that `WHERE` clause and nothing else** — no read-then-write, which races. Omitting
   `superseded_at IS NULL` is the difference between "regenerating my codes revoked the sheet I
   lost" and "it did not".
5. On failure: increment `users.recovery_fail_count`; at **10** consecutive failures set
   `recovery_locked_until = now + 3600` and write an audit row. Return `401 invalid_recovery_code`.
6. On success: reset `recovery_fail_count` to 0, mint a session with **`scope = 'recovery'`** and
   `uv = 0`, write an audit row `auth.recovery_used` with the remaining count.

**200**
```jsonc
{
  "data": {
    "user": { "handle": "arjun_n", "display_name": "Arjun N" },
    "session": { "scope": "recovery", "uv": false },
    "codes_remaining": 7,
    "next_step": "add_passkey"
  }
}
```

### 4.4 The recovery scope

A `scope = 'recovery'` session may call **exactly these** endpoints:

```
GET  /api/v1/auth/session
GET  /api/v1/me
POST /api/v1/me/credentials/options
POST /api/v1/me/credentials/verify
POST /api/v1/auth/logout
```

Everything else returns **`403 recovery_scope_only`**. Not `401` — the session is real, it is just
narrow, and the client needs to distinguish "sign in again" from "finish adding your passkey".

On a successful `POST /api/v1/me/credentials/verify` from a recovery session, the server **rotates the
session to `scope = 'full'`** with a **new session id and secret** (§5.6) and sets `uv` from the
registration result. The user is now normally signed in on their new phone. This is the entire device-
loss story and it involves no email, no SMS, and no support ticket.

### 4.5 Regeneration — `POST /api/v1/auth/recovery/codes`

Session + step-up (`auth_at` within 900 s) + `uv = 1`. `Idempotency-Key` required.

Invalidates the **entire** previous batch by **superseding** it, and inserts 10 fresh codes with a
new `batch_id`, in the same `.batch()`:

```sql
UPDATE recovery_codes SET superseded_at = ?1 WHERE user_id = ?2 AND superseded_at IS NULL;
-- then 10 × INSERT INTO recovery_codes (id, user_id, batch_id, code_hash, created_at) VALUES (…)
```

Not a `DELETE`: `recovery_codes.superseded_at` exists precisely so the history of how many batches a
user has held survives, which is what makes "my codes were regenerated without me asking" an
answerable question. The redemption `WHERE` in §4.3 step 4 carries `superseded_at IS NULL`, so a
code from an old sheet is rejected exactly as a used one is.

Returns the 10 plaintext codes once. Audited.

`GET /api/v1/auth/recovery/status` → `{ "remaining": 7, "total": 10, "generated_at": "...", "batch_id": "..." }`.
When `remaining <= 3` the client shows a regeneration prompt. When `remaining === 0` **and** the user
has only one credential, the client shows a hard warning — that account is one lost phone away from
being unrecoverable, and the only remedy at that point is an admin manually attaching a new credential,
which this system deliberately does **not** support (§9.3).

---

## 5. Sessions

### 5.1 The cookie

```
Set-Cookie: __Host-nc_session=<session_id>.<secret>; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=<idle window seconds>
```

| Attribute | Value | Why |
| --- | --- | --- |
| Name | `__Host-nc_session` | The `__Host-` prefix is enforced by the browser: the cookie **must** have `Secure`, **must** have `Path=/`, and **must not** have a `Domain` attribute. That makes it impossible for any subdomain — including a future `blog.nellore.club` on somebody else's hosting — to set or shadow it. Cookie shadowing from a sibling subdomain is a real, boring, common way session security dies; the prefix closes it for free. |
| `Path` | `/` | Required by `__Host-`. |
| `Secure` | present | Required by `__Host-`. |
| `HttpOnly` | present | No JavaScript reads the session. Note this does **not** stop CSRF — see §5.7 and SECURITY.md §5. |
| `SameSite` | `Lax` | `Strict` would break the product's primary distribution channel: a WhatsApp link to `/t/<slug>/` is a cross-site top-level GET, and under `Strict` the user would land signed-out and confused. `Lax` sends the cookie on top-level GETs and withholds it on cross-site POSTs, which is exactly right. It is **not** sufficient on its own — §5.7. |
| `Max-Age` | the role's idle window (§5.3) | Refreshed by a sliding renewal, at most once per 6 hours (§5.4). |
| `Domain` | **absent** | Host-only. Required by `__Host-`. |

**Local development:** `wrangler dev` serves `http://localhost:8787`, where `__Host-` + `Secure` is
honoured by Chrome and Firefox but not reliably by Safari. When `ENVIRONMENT !== "production"` the
cookie name is `nc_session_dev` and `Secure` is omitted. This branch must be keyed on the env var and
must be impossible to reach in production; assert it at Worker startup.

### 5.2 The token

Cookie value is `<session_id>.<secret>`:
- `session_id` = `ses_` + ULID. Indexed lookup key.
- `secret` = 32 CSPRNG bytes, base64url (43 chars).

The database stores `token_hash = hex(HMAC-SHA256(SESSION_PEPPER, session_id || ":" || secret))`.

Validation: parse the two parts, `SELECT ... FROM sessions WHERE id = ?` (one indexed read), then a
**constant-time** comparison of the recomputed hash against the stored one. Never `SELECT ... WHERE
token_hash = ?` on a hash of user input alone; splitting id from secret gives a cheap indexed lookup
*and* keeps the comparison constant-time.

`SESSION_PEPPER` is a Worker secret. A read-only D1 leak therefore does not yield usable session
tokens.

### 5.3 Lifetimes

Two clocks, both enforced on every request:

| Role | Idle expiry (`idle_expires_at`) | Absolute expiry (`absolute_expires_at`) |
| --- | --- | --- |
| `player` | 60 days | 365 days |
| `organizer` | 30 days | 180 days |
| `admin` | 7 days | 30 days |
| `scope = 'recovery'` (any role) | 30 minutes | 30 minutes |

Long player sessions are a deliberate product decision: a member who has to re-authenticate every
fortnight will simply stop opening the site, and the value at risk in a player session is "someone
could withdraw my registration". Admin sessions are short because the value at risk is the whole club.

`idle_expires_at` is pushed forward on activity (§5.4). `absolute_expires_at` is set once at creation
and never moves. Whichever fires first ends the session: `401 session_expired`.

A role change moves a live session's limits: the role is snapshotted on the session row
(`role_snapshot`), and a role change bumps the epoch and kills the session anyway (§5.5), so the new
limits apply from the next sign-in.

### 5.4 The activity write, and not melting D1 with it

Updating `last_seen_at` on every request would be one D1 write per request — the single most expensive
thing in this design if done naively.

Rule: update at most once per **300 seconds** per session, and do it in `ctx.waitUntil()` so it never
adds latency:

```ts
if (now - session.last_seen_at > 300) {
  ctx.waitUntil(db.prepare(
    'UPDATE sessions SET last_seen_at = ?1, idle_expires_at = ?2 WHERE id = ?3 AND revoked_at IS NULL'
  ).bind(now, now + idleWindow, session.id).run());
}
```

The cookie's `Max-Age` is refreshed on the same 6-hourly cadence (a `Set-Cookie` on every response
would defeat edge caching of nothing in particular but adds bytes to every response).

Consequence to accept: `last_seen_at` and `idle_expires_at` can lag by up to 5 minutes. Nothing
security-relevant depends on that precision — revocation does not go through this path.

### 5.5 Revocation: the epoch

`users.session_epoch INTEGER NOT NULL DEFAULT 1`. Every session row stores the `epoch` it was minted
under. Validation requires `session.epoch = user.session_epoch`.

Revoking **every** session of a user is therefore `UPDATE users SET session_epoch = session_epoch + 1`
— one row, no scan, instantly effective everywhere including sessions the code has never seen.

**The epoch is bumped on:**
- any role grant or revoke (`POST /api/v1/admin/users/:id/role`) — a privilege change must never be
  usable from a session minted before it, in either direction;
- suspension;
- `DELETE /api/v1/me/sessions` (revoke all others — the current session is then re-minted at the new
  epoch in the same batch);
- `DELETE /api/v1/admin/users/:id/sessions`;
- recovery-code redemption, **after** the new passkey is added (so a thief who had a live session on
  the old phone is kicked out when the real owner recovers);
- deletion request.

Revoking a **single** session is `UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ?`.

Session validation reads `sessions` joined to `users` in **one** statement:

```sql
SELECT s.*, u.role, u.session_epoch, u.suspended_until, u.handle, u.display_name
  FROM sessions s JOIN users u ON u.id = s.user_id
 WHERE s.id = ?1 AND s.revoked_at IS NULL
 LIMIT 1
```

One statement, one subrequest, for the auth check on every authenticated request. Everything after
that (hash comparison, epoch, expiry, suspension, scope) is in-memory.

### 5.6 Rotation

A new `session_id` **and** a new `secret` are issued (and the old row revoked, in the same batch) on:

1. **Every successful authentication** — passkey login, recovery login, email OTP. If the request
   arrived with an existing session cookie, that session is revoked. This is the session-fixation
   defence: a session identifier that existed before authentication is never the one that carries
   authority after it (SECURITY.md §5.4).
2. **Recovery → full scope upgrade** (§4.4).
3. **UV upgrade** (a `uv = 0` session re-running the ceremony with `userVerification: 'required'`).
4. **`DELETE /api/v1/me/sessions`** (revoke-all-others).

Rotation also mints a fresh `csrf_token`. The client refetches it from `GET /api/v1/auth/session`,
which every sign-in path already calls.

### 5.7 CSRF token

`sessions.csrf_token` = 32 CSPRNG bytes, base64url. Returned **only** by
`GET /api/v1/auth/session` — a same-origin `GET` that a cross-origin page cannot read the response of.

Every mutating request must send it as `X-CSRF-Token`, compared constant-time against the session row.
Mismatch or absent → `403 csrf_failed`.

**It is deliberately not a cookie.** The classic "double submit" pattern puts the token in a
non-`HttpOnly` cookie, which means any subdomain — or any XSS anywhere on the origin — can read it,
and a subdomain can *write* it (cookies ignore port and, without `__Host-`, are shared up the
registrable domain). A session-bound token delivered over a CORS-protected `GET` has neither problem.
The SPA holds it in memory and refetches after a reload.

Exempt (no session ⇒ no token): the ceremony endpoints in §3, `/auth/recovery/login`,
`/auth/email/*`, `POST /tournaments/:slug/guest-register`, and the `X-Guest-Token` routes. Those are
covered by the `Origin` allowlist, the JSON content-type requirement, and — for the guest routes — the
fact that a custom header cannot be attached by a cross-site form and a cross-site `fetch` that tries
gets preflighted and blocked. See SECURITY.md §5.3.

### 5.8 Step-up re-authentication

`sessions.auth_at` is the timestamp of the last completed authentication ceremony. It is set at mint
and updated only by a fresh ceremony — never by activity.

Endpoints marked ⚡ in API.md §5 require `now - auth_at <= 900` (15 minutes) **and** `uv = 1`.
Otherwise `403 step_up_required` with `details.auth_at`. The client runs
`POST /auth/passkey/login/options` + `/verify` with `userVerification: 'required'` for the
already-signed-in user, which rotates the session and resets `auth_at`, then retries the original
request.

**Step-up is deliberately not applied to score entry or publishing results.** An organizer at the
scorer's table entering forty badminton results in ninety minutes cannot be asked for a fingerprint
every fifteen minutes; they would find a way around it, and the way around it is always worse.
Score integrity is protected by the organizer predicate, the append-only `match_audit` history, the
public "last updated by" attribution, and the audit log (SECURITY.md §2) — controls that do not
depend on friction.

---

## 6. Bootstrapping the first admin

The chicken-and-egg: granting the organizer role requires an admin, and there is no admin.

**Mechanism.** A Worker secret:

```sh
# 32 random bytes, generated locally, pasted at the prompt. Never in the repo, never in wrangler.jsonc.
openssl rand -base64 32
npx wrangler secret put ADMIN_BOOTSTRAP_TOKEN
```

The owner then opens `https://nellore.club/admin/bootstrap/`, pastes the token, picks a handle, and
completes a normal passkey registration. That ceremony is the one in §3.1/§3.2 with
`bootstrap_token` in the options request.

**Server rules, all of them enforced:**

1. `ADMIN_BOOTSTRAP_TOKEN` unset or empty → the whole path is disabled.
   `GET /api/v1/auth/bootstrap/status` returns `{ "available": false }`, and a `bootstrap_token` in a
   registration request is ignored (the request becomes a normal player signup).
2. Comparison is **constant-time** over the raw bytes. A length mismatch is compared against a padded
   dummy so timing does not leak the length.
3. `SELECT 1 FROM users WHERE role = 'admin' LIMIT 1` — if any admin exists, `409 bootstrap_closed`,
   and this is checked **twice**: at `/options` and again inside the verify batch. The window between
   them is 120 s and it is exactly the window a race would use.
4. On success: the user is created with `role = 'admin'`, an audit row `admin.bootstrap` is written
   with the IP hash and user agent, and — because the token has now served its only purpose — the
   response body says, in plain English, `"Delete the ADMIN_BOOTSTRAP_TOKEN secret now: npx wrangler secret delete ADMIN_BOOTSTRAP_TOKEN"`.
5. Rate limited to **3 attempts per hour per IP hash**, and every failed attempt is audited with
   `admin.bootstrap_failed`. Three failures from one IP in an hour also disable the path for that IP
   for 24 h.

**Re-bootstrapping after losing every admin** (all admin devices lost, all recovery codes lost). There
is no back door, and there should not be one. The recovery is a deliberate, physical act by whoever
holds the Cloudflare account:

```sh
npx wrangler d1 execute nellore-club --remote \
  --command "UPDATE users SET role='player', session_epoch = session_epoch + 1 WHERE role='admin'"
npx wrangler secret put ADMIN_BOOTSTRAP_TOKEN     # a fresh value
# then complete the bootstrap ceremony again
```

That is documented here on purpose: the person with `wrangler` access to the D1 database can already
do anything, so pretending otherwise would be theatre. What matters is that it requires Cloudflare
account access and leaves an audit trail, and that no HTTP request can trigger it.

**Rejected: a permanent `ADMIN_HANDLES` env var** that promotes listed handles to admin on sign-in.
It is simpler, and it means anyone who registers that handle before the real owner does becomes
admin — a race with the whole internet, permanently armed.

---

## 7. Roles and authorization

### 7.1 Roles

Three, on `users.role`, strictly ordered:

| Role | Can |
| --- | --- |
| `player` | Manage their own profile, credentials and sessions. Register for tournaments, check in, withdraw, edit their own entry. Read everything public. |
| `organizer` | Everything a player can, **plus** create tournaments and fully manage **the tournaments they own or co-organize**. An organizer has **no** authority over another organizer's tournament. |
| `admin` | Everything, everywhere. Manage games, grant roles, suspend users, read the audit log, revoke any session, unpublish results. |

Per-tournament scope is a separate table, `tournament_organizers (tournament_id, user_id)`, plus
`tournaments.owner_user_id`. **Role is granted by an admin; scope is granted by the tournament owner.**
Keeping them separate is what stops an organizer from bootstrapping themselves upward by adding
themselves to something.

### 7.2 The predicate vocabulary

Given a validated session `s` and its user `u`:

```
S           := s exists ∧ s.revoked_at IS NULL
                       ∧ hmac(s) matches
                       ∧ s.epoch = u.session_epoch
                       ∧ now < s.idle_expires_at ∧ now < s.absolute_expires_at
                       ∧ u.status = 'active'                -- THE moderation gate. See below.
                       ∧ u.deleted_at IS NULL
FULL        := S ∧ s.scope = 'full'                       -- else 403 recovery_scope_only
UV          := s.uv = 1                                    -- else 403 uv_required
STEPUP      := now - s.auth_at <= 900                      -- else 403 step_up_required
PLAYER      := FULL
ORG         := FULL ∧ u.role IN ('organizer','admin')
ADMIN       := FULL ∧ u.role = 'admin'

-- Per-tournament scope. All three read tournament_organizers.role AND revoked_at.
TORG(t, roles) := EXISTS(tournament_organizers
                          WHERE tournament_id = t.id
                            AND user_id       = u.id
                            AND revoked_at IS NULL          -- soft revoke MUST remove authority
                            AND role IN roles)

OWNER_OF(t) := FULL ∧ ( u.role = 'admin' ∨ t.owner_user_id = u.id )
ORG_OF(t)   := FULL ∧ ( u.role = 'admin'
                      ∨ t.owner_user_id = u.id
                      ∨ TORG(t, {'owner','organizer','scorer','moderator'}) )
-- "Full organiser": everything ORG_OF can reach EXCEPT what is listed as OWNER/ORG-only below.
FULLORG_OF(t) := FULL ∧ ( u.role = 'admin'
                        ∨ t.owner_user_id = u.id
                        ∨ TORG(t, {'owner','organizer'}) )
-- SCORER_OF is a deliberate SYNONYM of ORG_OF, not a narrower predicate. It exists so an
-- endpoint's row in the tables below reads "a scorer may do this" rather than the reader
-- having to remember that ORG_OF happens to admit them. The narrowing is done by
-- FULLORG_OF on the endpoints a scorer must NOT reach.
SCORER_OF(t) := ORG_OF(t)

MINE(e)     := FULL ∧ ( e.user_id = u.id
                      ∨ EXISTS(entrant_members m WHERE m.entrant_id = e.id
                                                  AND m.user_id = u.id
                                                  AND m.role   = 'captain'
                                                  AND m.status = 'active') )
-- Read-only membership: a squad player who is not the captain.
ROSTERED(e) := FULL ∧ EXISTS(entrant_members m WHERE m.entrant_id = e.id
                                                 AND m.user_id = u.id
                                                 AND m.status  = 'active')
GUEST(e)    := X-Guest-Token present ∧ constant_time_eq(hmac(GUEST_PEPPER, token), e.guest_token_hash)
                                     ∧ e.guest_revoked_at IS NULL
CSRF        := constant_time_eq(header['X-CSRF-Token'], s.csrf_token)
ORIGIN      := request Origin (or Referer origin) ∈ ALLOWED_ORIGINS
```

#### Suspension is gated on `users.status`, not on `suspended_until`

`POST /api/v1/admin/users/:id/suspend` accepts `{ "until": null }` and API.md calls that
"indefinite" — the strongest sanction an admin has, used against a cheat or an abuser at a live
event. The old predicate tested `(u.suspended_until IS NULL ∨ u.suspended_until < now)`, which reads
a NULL as **not suspended**. The epoch bump kills the current sessions so it *looks* like it worked;
the banned user signs in with their passkey seconds later and re-registers. `users.status`
(`active|suspended|banned|deleted`) was read by no predicate at all.

So, normatively:

- **`S` requires `u.status = 'active'`.** That is the gate.
- `POST .../suspend` sets `status = 'suspended'` **and** `suspended_until` (timestamp or NULL) and
  bumps `session_epoch`.
- `suspended_until` is now only an **auto-lift timestamp**: the nightly cron (§10.4) runs
  `UPDATE users SET status = 'active', suspended_until = NULL
   WHERE status = 'suspended' AND suspended_until IS NOT NULL AND suspended_until <= :now`.
  A `NULL` there means "never auto-lift", which is exactly what indefinite should mean.
- `DELETE .../suspend` sets `status = 'active'`, `suspended_until = NULL`.
- §3.4 step 5 of the login ceremony applies the same test: refuse when `users.status <> 'active'`.
  Do not test the timestamp there either.

#### `tournament_organizers.role` is enforced

`role` is a closed enum (`owner|organizer|scorer|moderator`) and OPERATIONS.md §0 tells the operator
to hand a volunteer **scorer**, not **organizer**, because *"a scorer handing their phone to a friend
should not be able to leak forty phone numbers"* and *"scorers do not see contact details — that is
why the scorer role exists"*. Previously no predicate read `role`, so a one-event volunteer could
pull every entrant's phone number one at a time, export the contact CSV, and publish results. The
operator was being told to rely on a control the authorization layer did not implement — which under
DPDP is an unauthorised disclosure the club believed it had prevented.

| Capability | Predicate |
| --- | --- |
| Enter scores, lobby results, `PATCH` match logistics, pair a progressive round | `SCORER_OF(t)` — any non-revoked staff row |
| Read the organiser bracket, entrant list (masked), audit trail, stages | `ORG_OF(t)` |
| `GET /organizer/entrants/:id/contact`; `entrants.csv?include_contact=true`; the `payment_status` / `payment_ref` / `paid_amount_paise` fields of `PATCH /organizer/entrants/:id`; `POST .../publish`; `POST .../unpublish`; `POST .../reopen` | **`FULLORG_OF(t)`** — `role IN ('owner','organizer')`, the owner, or admin |
| Add/remove co-organizers, cancel the tournament, delete a draft | `OWNER_OF(t)` |

A `scorer` or `moderator` hitting a `FULLORG_OF` endpoint gets `403 forbidden` with
`details.reason: "role_insufficient"` — `403` rather than `404` because the object is one they can
legitimately see, so hiding it buys nothing and confuses the volunteer.

`moderator` is `ORG_OF` plus announcements and entrant-status changes, and is **not** `SCORER_OF`
for score writes: it is the "runs the WhatsApp group and the check-in desk" role. If a future
deployment does not want this granularity, the correct move is to delete `scorer` and `moderator`
from the schema enum and correct OPERATIONS.md §0 — **not** to ship a role the docs promise and the
code ignores.

**Every mutating request** additionally requires `ORIGIN`, and every mutating request **that carries a
session** additionally requires `CSRF`. Those two are checked in the middleware before the handler
runs, so they are omitted from the per-endpoint column below.

**The object is always loaded before the predicate is evaluated, and the predicate always uses the
loaded object — never a value from the request body or the path.** `PATCH /entrants/:id` loads the
entrant, reads *its* `tournament_id`, and checks the predicate against *that* tournament. It never
trusts a `tournament_id` in the body. This is the entire IDOR defence and it is not optional
(SECURITY.md §4).

**Failure mode:** if the predicate fails and the object is **not** publicly visible to an anonymous
caller, return `404 not_found`. If it **is** publicly visible, return `403 forbidden`. Returning 403
for a private object confirms the object exists.

### 7.3 The complete table

Every mutating endpoint in API.md, with its exact predicate — **plus the four reads whose object is
not public**, because a read that returns organiser-visibility data needs a predicate exactly as
much as a write does, and "unspecified" defaults to whatever the implementer assumes.

| Endpoint | Predicate | Extra |
| --- | --- | --- |
| `GET /entrants/:id` | `MINE(e) ∨ ROSTERED(e) ∨ ORG_OF(entrant.tournament)` | **404 otherwise.** Entrant ids are public (§1.6, §1.7) and signup is free, so a bare-`S` predicate lets any account harvest every organizer-visibility field in the club. `ROSTERED` is read-only — a squad player must be able to see the entry they are on, and `MINE` admits only the owner and the captain. |
| `GET /organizer/tournaments/:id` | `ORG_OF(t)` | 404 otherwise, incl. for another organiser's draft |
| `GET /organizer/entrants/:id/contact` | **`FULLORG_OF(t)`** | audited on every call, rate-limited |
| `GET /organizer/tournaments/:id/entrants.csv` | `ORG_OF(t)`; **`include_contact=true` needs `FULLORG_OF(t)`** | audited, watermarked |
| `POST /auth/passkey/register/options` | none (or `S` for add-credential) | `SIGNUP_OPEN != "0"` for signup |
| `POST /auth/passkey/register/verify` | none (or `S`) | challenge-bound intent |
| `POST /auth/passkey/login/options` | none | |
| `POST /auth/passkey/login/verify` | none | |
| `POST /auth/recovery/login` | none | rate + account lock |
| `POST /auth/recovery/codes` | `FULL ∧ UV ∧ STEPUP` | idempotency |
| `POST /auth/email/start` / `verify` | none | `EMAIL_OTP_ENABLED` |
| `POST /auth/logout` | `S` (any scope) | |
| `PATCH /me` | `FULL` | handle cooldown 30 d |
| `DELETE /me` | `FULL ∧ UV ∧ STEPUP` | `confirm_handle` must match |
| `POST /me/undelete` | `FULL` | within 30 d |
| `POST /me/credentials/options` | **`S ∧ (UV ∨ s.scope = 'recovery')`** | see §7.3.1 |
| `POST /me/credentials/verify` | **`S ∧ (UV ∨ s.scope = 'recovery')`** | sets `uv` from the registration result, then rotates to `scope = 'full'` |
| `PATCH /me/credentials/:id` | `FULL ∧ credential.user_id = u.id` | |
| `DELETE /me/credentials/:id` | `FULL ∧ STEPUP ∧ credential.user_id = u.id` | refuse if last credential ∧ no unused recovery codes |
| `DELETE /me/sessions/:id` | `FULL ∧ session.user_id = u.id` | |
| `DELETE /me/sessions` | `FULL ∧ STEPUP` | epoch bump + re-mint current |
| `POST /me/registrations/:id/leave` | `FULL ∧ EXISTS(entrant_members WHERE entrant_id = :id AND user_id = u.id)` | fails once bracket exists |
| `POST /me/registrations/claim` | `FULL ∧ GUEST(e) ∧ e.user_id IS NULL ∧ t.status ≠ 'completed' ∧ ¬EXISTS(live entrant for u in t)` | §8.3; audited |
| `POST /tournaments/:slug/register` | `FULL ∧ t.status = 'registration_open' ∧ now ∈ [reg_opens, reg_closes] ∧ ¬EXISTS(live entrant for u in t) ∧ (t.min_account_age_hours = 0 ∨ now - u.created_at ≥ that)` | idempotency; unique index is the backstop |
| `POST /tournaments/:slug/guest-register` | `t.allow_guest_registration = 1 ∧ t.status = 'registration_open' ∧ (¬t.requires_join_code ∨ VALID_JOIN_CODE(t)) ∧ (TURNSTILE unset ∨ token verifies)` | idempotency; always `status = 'pending'` |
| `PATCH /entrants/:id` | `MINE(e) ∧ e.status ∈ {pending, confirmed, waitlisted} ∧ t.status = 'registration_open' ∧ t.bracket_generated_at IS NULL` | else `409 entrant_locked` |
| `POST /entrants/:id/roster-invites` | `MINE(e) ∧ e.status ∈ {pending, confirmed, waitlisted} ∧ t.status = 'registration_open' ∧ t.bracket_generated_at IS NULL` | captain only, **not** `ROSTERED`; API.md §3.12.1 |
| `POST /invites/:code/accept` | `FULL ∧ EXISTS(invite i WHERE i.code_hash = HMAC(INVITE_PEPPER, code) AND i.kind = 'roster' AND i.revoked_at IS NULL AND (i.expires_at IS NULL OR i.expires_at > now) AND i.used_count < i.max_uses) ∧ t.status = 'registration_open' ∧ t.bracket_generated_at IS NULL ∧ ¬EXISTS(active entrant_members row for u in t)` | The one endpoint that writes a row on an object the caller does not own. Safe because the write is a single fully specified `entrant_members` insert for the caller's **own** `user_id` into the entrant the **code** names — no entrant id is taken from the caller. `ux_member_one_team` is the backstop → `409 conflict`. `410 gone` when the conditional consume matches 0 rows. API.md §3.12.3 |
| `POST /entrants/:id/checkin` | `MINE(e) ∧ now ∈ [t.checkin_opens_at, t.checkin_closes_at] ∧ e.status ∈ {confirmed, checked_in}` | code if required; idempotent |
| `POST /entrants/:id/withdraw` | `MINE(e) ∧ e.status ∉ {withdrawn, disqualified} ∧ ¬(t.bracket_generated_at IS NOT NULL ∧ e has a completed match)` | promotes the first waitlist entry |
| `PATCH /guest/entrant` | `GUEST(e)` + the same state conditions as `PATCH /entrants/:id` | |
| `POST /guest/entrant/checkin` | `GUEST(e)` + as above | |
| `POST /guest/entrant/withdraw` | `GUEST(e)` + as above | |
| `POST /organizer/tournaments` | `ORG` | idempotency |
| `PATCH /organizer/tournaments/:id` | `ORG_OF(t)` | field mutability by status, API.md §4.3 |
| `DELETE /organizer/tournaments/:id` | `OWNER_OF(t) ∧ t.status = 'draft' ∧ t.entrant_count = 0` | |
| `POST /organizer/tournaments/:id/status` | `ORG_OF(t)`; **`→ cancelled` needs `OWNER_OF(t)`** | legal transitions only |
| `POST /organizer/tournaments/:id/entrants` | `ORG_OF(t)` | `override_capacity` audited |
| `PATCH /organizer/entrants/:id` | `ORG_OF(t)`; the `payment_status` / `payment_ref` / `paid_amount_paise` fields additionally require **`FULLORG_OF(t)`** | `dq_reason` required for disqualify; `status_changed_at` required for `withdrawn`/`disqualified`/`no_show` |
| `DELETE /organizer/entrants/:id` | `ORG_OF(t) ∧ ¬(entrant has a completed match) ∧ t.results_published_at IS NULL` | API.md §4.8b |
| `POST /organizer/entrants/:id/guest-token` | `ORG_OF(t) ∧ entrant.user_id IS NULL` | audited |
| `POST /organizer/tournaments/:id/entrants/reseed` | `ORG_OF(t) ∧ (t.bracket_generated_at IS NULL ∨ force ∧ no completed matches)` | `method: 'rating'` → `400` (API.md §1.12.2) |
| `POST /organizer/tournaments/:id/bracket` | `ORG_OF(t) ∧ (no bracket ∨ force ∧ no completed matches)` | idempotency |
| `DELETE /organizer/tournaments/:id/bracket` | `ORG_OF(t) ∧ no completed matches ∧ t.results_published_at IS NULL` | API.md §4.12b |
| `POST /organizer/tournaments/:id/stages` | `ORG_OF(t) ∧ t.status ∈ {draft, published, registration_open}` | ≤ 4 stages |
| `PATCH` / `DELETE /organizer/stages/:id` | `ORG_OF(stage.tournament) ∧ stage.bracket_generated_at IS NULL` | else `409 stage_locked` |
| `POST /organizer/stages/:id/seed` | `ORG_OF(t) ∧ stage.seed_source = 'previous_stage' ∧ source stage fully complete ∧ stage.bracket_generated_at IS NULL` | API.md §4.23.4 |
| `POST /organizer/stages/:id/rounds` | `SCORER_OF(t) ∧ rounds 1..k−1 all in {complete,bye,void} ∧ t.results_published_at IS NULL` | idempotency + version; API.md §4.23.5 |
| `DELETE /organizer/stages/:id/rounds/:round` | `ORG_OF(t) ∧ t.results_published_at IS NULL` | `reason` ≥ 10 chars, public |
| `PUT /organizer/matches/:id/score` | `SCORER_OF(match.tournament) ∧ t.results_published_at IS NULL ∧ every scores[].entrant_id ∈ match slots` | idempotency + `result_version` |
| `POST /organizer/matches/:id/confirm` | `ORG_OF(t) ∧ match.pending_confirm_by IS NOT NULL ∧ u.id ≠ match.pending_confirm_by` | dual-confirm only. **The column is `matches.pending_confirm_by`.** There is no `matches.updated_by_user_id`; the earlier name in this table did not exist in `db/schema.sql`, and the obvious repair — comparing against a column that is `NULL` before the first submission — makes the check pass silently on exactly the match with the prize money attached. The `IS NOT NULL` clause is load bearing. |
| `POST /organizer/matches/:id/reopen` | **`FULLORG_OF(t)`** while `t.status = 'live'`; **`ADMIN`** once `t.status = 'completed'`; always `t.results_published_at IS NULL` | `reason` ≥ 10 chars, public |
| `PATCH /organizer/matches/:id` | `SCORER_OF(t)` | `stream_url` host allowlist |
| `POST /organizer/matches/:id/lobby-results` | `SCORER_OF(t) ∧ t.results_published_at IS NULL` | idempotency + `result_version` |
| `POST /organizer/tournaments/:id/publish` | **`FULLORG_OF(t)`**; **`force: true` requires `ADMIN`** | idempotency + version |
| `POST /organizer/tournaments/:id/unpublish` | `ADMIN ∧ UV ∧ STEPUP` | `reason` ≥ 10 chars, public |
| `POST /organizer/tournaments/:id/announcements` | `ORG_OF(t)` | markdown → AST, API.md §9 |
| `PATCH` / `DELETE /organizer/announcements/:id` | `ORG_OF(announcement.tournament)` | |
| `POST /organizer/tournaments/:id/invites` | `ORG_OF(t)` | idempotency |
| `DELETE /organizer/invites/:id` | `ORG_OF(invite.tournament)` | |
| `POST /organizer/tournaments/:id/organizers` | `OWNER_OF(t) ∧ target.users.role IN ('organizer','admin') ∧ body.role ∈ {organizer, scorer, moderator}` | grants **scope**, never role; clears `revoked_at` on re-add |
| `DELETE /organizer/tournaments/:id/organizers/:handle` | `OWNER_OF(t) ∧ target ≠ t.owner_user_id` | **Sets `revoked_at = now`** (soft revoke). Every scope predicate requires `revoked_at IS NULL`, so authority is gone on the next request. Sessions are not revoked — the predicate is evaluated per request against the loaded row. |
| `POST /admin/games` | `ADMIN` | schema + regex validation |
| `PATCH /admin/games/:id` | `ADMIN` | slug frozen once referenced |
| `DELETE /admin/games/:id` | `ADMIN` | soft delete |
| `GET /admin/users/:id/contact` | `ADMIN ∧ UV ∧ STEPUP` | audited |
| `POST /admin/users/:id/role` | `ADMIN ∧ UV ∧ STEPUP ∧ ¬(target is the last admin ∧ new role ≠ 'admin')` | **epoch bump**, `reason` required |
| `POST /admin/users/:id/suspend` | `ADMIN ∧ UV ∧ STEPUP ∧ target.id ≠ u.id` | epoch bump |
| `DELETE /admin/users/:id/suspend` | `ADMIN` | |
| `DELETE /admin/users/:id/sessions` | `ADMIN ∧ UV ∧ STEPUP` | epoch bump |
| `DELETE /admin/sessions/:id` | `ADMIN` | |
| `PATCH /admin/club` | `ADMIN` | version |
| `POST /admin/announcements` | `ADMIN` | |
| `POST /admin/leaderboard/rebuild` | `ADMIN ∧ UV ∧ STEPUP` | resumable |
| `POST /admin/redirects` | `ADMIN` | |
| `POST /admin/cache/purge` | `ADMIN ∧ UV ∧ STEPUP` | |

#### 7.3.1 The recovery session must be able to enrol a passkey

This is the entire zero-cost device-loss story (§1: *"the thing passkeys are genuinely bad at —
device loss with no sync — is exactly what the recovery codes cover"*), and it was deadlocked by its
own predicates.

§4.3 step 6 mints the recovery session with `scope = 'recovery'` and **`uv = 0`**. §4.4 says that
session may call **exactly** `/auth/session`, `/me`, `/me/credentials/options`,
`/me/credentials/verify` and `/auth/logout`. But §3.5 and this table required `S ∧ UV` on the two
credential endpoints, so **the only two endpoints a recovery session is permitted to call were the
two it is guaranteed to fail**. The client remedy in §12 (`403 uv_required` → run the passkey
ceremony with `userVerification: 'required'`, then retry) is impossible for the exact user this flow
exists for: one who has lost their only passkey. A user who burned a recovery code landed in a
session that could do nothing at all, and §7.3 deliberately has no admin endpoint that attaches a
credential to another account — so the account was **permanently unrecoverable**.

The fix, and it is the whole fix:

- The predicate on `POST /me/credentials/options` and `/verify` is
  **`S ∧ (UV ∨ s.scope = 'recovery')`**.
- §2.1's list of privileged actions reads: *"…and adding a credential — **except from a
  recovery-scoped session, where the redeemed single-use recovery code is itself the authenticating
  factor**."*
- On the resulting `/verify`, the server sets `uv` from the registration result (a fresh
  `userVerification: 'required'` ceremony on the new phone will normally give `uv = 1`) and rotates
  the session to `scope = 'full'` with a new id and secret, exactly as §4.4 already says.
- Nothing else changes. A recovery session still cannot reach `/auth/recovery/codes`,
  `DELETE /me`, any organiser endpoint or any admin endpoint — those all require `FULL`, and the
  session is not `FULL` until the moment it has enrolled a working credential.

The security argument: the authenticating factor for that one action is the recovery code, which is
50 bits of CSPRNG, single-use, consumed atomically, rate-limited to 5/min per IP and 10/day per
account, and locks the account after 10 consecutive failures (§4.3, §12.2). Requiring a *second*
factor from a user who has just proved they have none is not a control, it is a dead end.

#### 7.3.2 `VALID_JOIN_CODE(t)`

Used by the guest-register predicate above. **The scoping to `t` is the whole control.**

```
VALID_JOIN_CODE(t) := EXISTS(invites i
                              WHERE i.code_hash     = HMAC(INVITE_PEPPER, normalised_code)
                                AND i.tournament_id = t.id          -- ← NOT optional
                                AND i.kind          = 'join'
                                AND i.revoked_at IS NULL
                                AND (i.expires_at IS NULL OR i.expires_at > now)
                                AND i.used_count < i.max_uses)
```

`invites.code_hash` is `HMAC(INVITE_PEPPER, code)` over the code **alone**, with a **global**
`UNIQUE` (`db/schema.sql`). So the lazy lookup `WHERE code_hash = ?` returns a row from *any*
tournament: a code printed at the desk for the free carrom draw would open the paid BGMI cup's guest
registration. §8.2 calls the join code control 2 and SECURITY.md §3 rates it at "~380 million
attempts through a 5-per-minute limit" — all of which is worth nothing if the code is not bound to
the event.

**The consume is a conditional `UPDATE` inside the registration batch, never a read-then-write:**

```sql
UPDATE invites SET used_count = used_count + 1 WHERE id = ?1 AND used_count < max_uses;
```

`meta.changes === 1` required; `0` → `410 gone`. A read-then-write lets a `single_use` code be
redeemed N times concurrently — the same race already solved correctly for challenges (§3.6) and
recovery codes (§4.3). And per API.md §6.2.1, every other statement in that batch repeats the
condition, or a losing racer commits an entrant while being told `410`.

Three deliberate absences, each a decision rather than an oversight:

- **No "sign in as user".** An admin can revoke and inspect; an admin cannot become someone else. In a
  system whose whole output is competitive results, "the admin was logged in as the winner" must not
  be a sentence anyone can say.
- **No admin endpoint that attaches a credential to another user's account.** That endpoint would be a
  complete account-takeover primitive with one compromised admin session, and it would undermine the
  non-repudiation that makes passkeys worth having. Account recovery is recovery codes, and only
  recovery codes.
- **No organizer access to another organizer's tournament.** `ORG` alone authorises exactly one
  action: creating a new tournament.

---

## 8. Guests: playing without an account

A walk-in arrives at the venue on a Sunday evening and wants to enter the carrom draw. Making them
create an account with a passkey while forty people queue behind them is not going to happen.

### 8.1 Two guest paths

**Path A — organizer types them in (`POST /organizer/tournaments/:id/entrants`).** The desk enters a
name and optionally a phone. `entrants.user_id` is `NULL`, `origin = 'organizer'`, `status =
'confirmed'`. Zero abuse surface: it is an authenticated organizer action, rate-limited and audited.
**This is the primary path and the one the club will use most.**

**Path B — the guest registers themselves (`POST /tournaments/:slug/guest-register`).** For online
events and for the WhatsApp-group-link case. `origin = 'guest_self'`, `status = 'pending'` **always**
— an organizer must confirm before the entrant counts for anything.

### 8.2 Keeping Path B from being an abuse hole

Four independent gates, each individually bypassable and jointly not worth the trouble:

1. **The tournament must opt in.** `allow_guest_registration = 1`, default `0`. A paid tournament
   should simply leave it off.
2. **A join code** when `requires_join_code = 1` (recommended default for any free tournament). Codes
   are generated by the organizer (API.md §4.18), 6 characters from a 28-symbol alphabet (~28.5 bits),
   stored as `HMAC(INVITE_PEPPER, code)`, and either `single_use` or `shared` with a `max_uses` cap
   and an expiry. Printed at the desk, or dropped in the club's WhatsApp group. An attacker outside
   that group has to guess ~380 million codes through a 5-per-minute rate limit.
3. **Cloudflare Turnstile** when `TURNSTILE_SECRET_KEY` is set. Free, no account cost, verified from
   the Worker with a plain `fetch` to
   `https://challenges.cloudflare.com/turnstile/v0/siteverify` with `secret`, `response`, and
   `remoteip`. A failed or missing token → `403 turnstile_failed`. When the secret is unset the check
   is skipped entirely and `/api/v1/config` reports `features.turnstile: false` so the UI does not
   render a widget that cannot work.
4. **Rate limits.** `rl_guest` (5 / 60 s / IP hash) and `rl_register_ip` (15 / 24 h / IP hash, D1
   counter).

Plus the structural containment: a guest entrant is `pending` until an organizer confirms it, does not
count toward `confirmed_count`, does not appear in the public entrant list, is not seeded, and
contributes nothing to the leaderboard (it has no `user_id`). The worst outcome of a successful flood
is a list of junk rows that an organizer bulk-rejects — annoying, not damaging.

### 8.3 The guest capability token

On success the response contains `guest_token`: 32 CSPRNG bytes, base64url (43 chars). Stored as
`entrants.guest_token_hash = hex(HMAC-SHA256(GUEST_PEPPER, token))`.

- It is a **bearer capability scoped to exactly one entrant row**. It grants view, edit, check-in and
  withdraw on that entrant and nothing else. It is not a session, it has no user, it cannot be
  elevated, and it never appears in a `Set-Cookie`.
- Sent as `X-Guest-Token`, never as a cookie — a bearer token in a custom header cannot be attached by
  a cross-site form, and a cross-site `fetch` that tries is preflighted and blocked by the absence of
  CORS headers. That is why the guest routes need no CSRF token.
- Delivered to the guest as a URL: `https://nellore.club/t/<slug>/entry/?g=<token>`. The SPA reads
  `?g=`, stores it in `localStorage` under `nc_guest_<slug>`, and **immediately does
  `history.replaceState` to strip the query string** so the token does not end up in a screenshot,
  a shared link, or a `Referer`.
- Revocable and reissuable by the organizer (`POST /organizer/entrants/:id/guest-token`), which
  rotates the hash and invalidates the old token.
- Expires when the tournament reaches `completed` — after that the routes return
  `401 guest_token_invalid`.
- Rate-limited under `rl_guest_token`, keyed by `sha256(token)`.

**Claiming a guest entry later.** A guest who creates a real account afterwards can attach the entry:
`POST /api/v1/me/registrations/claim` with `{ "guest_token": "..." }`, which sets `entrants.user_id`
and clears `guest_token_hash`, but **only** while the tournament is not yet `completed` — otherwise
someone could retroactively claim a stranger's winning entry and inherit its leaderboard points.
Audited.

---

## 9. Optional email (OTP / magic link) — off by default

### 9.1 The switch

| Env var | Type | Default | Meaning |
| --- | --- | --- | --- |
| `EMAIL_OTP_ENABLED` | var | unset | `"1"` turns the path on. Anything else, including unset, leaves it **off**. |
| `EMAIL_PROVIDER` | var | `"resend"` | `resend` \| `brevo` \| `postmark`. Selects the adapter. |
| `EMAIL_API_KEY` | **secret** | unset | Provider key. |
| `EMAIL_FROM` | var | unset | e.g. `Nellore Club <noreply@nellore.club>`. |
| `EMAIL_OTP_ALLOW_SIGNUP` | var | `"0"` | Whether email alone may *create* an account. |

**Startup assertion:** if `EMAIL_OTP_ENABLED === "1"` and any of `EMAIL_API_KEY` / `EMAIL_FROM` is
missing, the Worker logs a loud error and **forces the feature off**. A half-configured email path that
accepts a request and then silently fails to send is worse than one that is cleanly disabled.

**When off:**
- `GET /api/v1/auth/config` → `"email_otp": false`; `GET /api/v1/config` → `features.email_otp: false`.
  The sign-in UI renders no email tab at all — not a greyed-out one.
- `POST /api/v1/auth/email/start` and `/verify` → **`501`** with
  `{ "error": { "code": "email_auth_disabled", "message": "Email sign-in is not configured for this club." } }`.
  `501`, not `404`: the route exists in the contract and the operator can turn it on. A 404 would send
  an implementer hunting for a missing route.

### 9.2 The provider

**Resend**, called with a plain `fetch` from the Worker — no SDK, no Node APIs, one HTTP call:

```
POST https://api.resend.com/emails
Authorization: Bearer <EMAIL_API_KEY>
Content-Type: application/json

{ "from": EMAIL_FROM, "to": [email], "subject": "Your nellore.club code", "text": "..." }
```

It has a free tier that covers a club's volume, it needs only a DNS record on a domain already on
Cloudflare, and the whole integration is that one request.

**Swappability is structural.** The Worker exposes exactly one internal function:

```ts
// worker/lib/email.ts
export interface EmailAdapter {
  send(to: string, subject: string, text: string): Promise<{ ok: boolean; id?: string; error?: string }>;
}
```

with one adapter per provider selected by `EMAIL_PROVIDER`, each ~15 lines of `fetch`. Nothing outside
this module knows a provider exists. Swapping to Brevo or Postmark is adding a file and changing an
env var; there is no SDK to rip out.

**Note on MailChannels:** it used to be the free-for-Workers option and is no longer free. Do not
design around it.

### 9.3 The flow, if enabled

`POST /api/v1/auth/email/start` `{ "email": "..." }`:
- Normalise (lowercase, trim; **do not** strip Gmail dots or `+tags` — that is a source of subtle
  account-merging bugs).
- 6-digit numeric OTP, CSPRNG, stored as `HMAC(OTP_PEPPER, user_or_email || ":" || code)` in
  `email_otps(id, email, user_id, code_hash, attempts, expires_at, consumed_at, ip_hash, created_at)`.
- **TTL 10 minutes. Max 5 verify attempts. Single use**, consumed by the same atomic conditional
  `UPDATE` pattern as §4.3.
- Rate limit `rl_auth_begin`, plus 3 per email per hour (D1 counter).
- **Always returns `202` with the same body** whether or not the address is known — no enumeration.
- If the address is unknown and `EMAIL_OTP_ALLOW_SIGNUP !== "1"`, no mail is sent and the response is
  still `202`.

`POST /api/v1/auth/email/verify` `{ "email": "...", "code": "482913" }` → mints a session with
`scope = 'full'` and **`uv = 0`**.

**That `uv = 0` is the whole security posture of this feature.** Email is a weaker factor than a
passkey — it is phishable and it depends on a mailbox this club does not control. An email session can
browse and register for tournaments. It cannot enter a score for a tournament it organises, publish
results, grant a role, regenerate recovery codes, delete the account, or reach any ⚡ endpoint, because
every one of those requires `UV`, and only a passkey ceremony sets it. The upgrade is one tap:
run the passkey ceremony, session rotates, `uv = 1`.

Magic links use the same store and TTL with a 32-byte token in place of the 6 digits; the link lands on
`/auth/verify/?t=<token>`, and the SPA immediately `history.replaceState`s the token out of the URL.
Prefer the OTP: a 6-digit code survives being copied between apps on a phone, a long link often does
not.

---

## 10. Auth schema, and the nightly cron

Two things live here: the auth DDL rationale (below), and — because it is the only scheduled job in
the system and it is the auth cron that grew — **the complete cron specification**, from §10.1
onward. `worker/lib/cron.ts` implements exactly §10.1–§10.9 and nothing else.

These five definitions were **originally owned by this document**. They have been merged into
`db/schema.sql`, which is now the single DDL. The blocks below are kept as the rationale for each
column; **`db/schema.sql` is authoritative for the exact names**. The reconciliation renamed
`webauthn_credentials.transports` → `transports_json`, `sign_count` → `counter`, and moved the
`csrf_token`, `epoch`, `scope`, `uv`, `auth_at`, `idle_expires_at` and `absolute_expires_at` columns
onto the existing `sessions` table. `email_otps` gained a `purpose` column.
Booleans are `INTEGER` 0/1. Timestamps are `INTEGER` Unix seconds UTC.

```sql
-- Auth-relevant columns on users. The full table is in db/schema.sql §1.
--   id                TEXT PRIMARY KEY            -- usr_<ulid>
--   handle            TEXT NOT NULL UNIQUE        -- lowercase, ^[a-z0-9][a-z0-9_]{2,19}$
--   display_name      TEXT NOT NULL
--   role              TEXT NOT NULL DEFAULT 'player'   -- 'player' | 'organizer' | 'admin'
--   webauthn_user_id  TEXT NOT NULL UNIQUE        -- base64url of 32 random bytes; the WebAuthn user handle
--   session_epoch     INTEGER NOT NULL DEFAULT 1
--   recovery_fail_count    INTEGER NOT NULL DEFAULT 0
--   recovery_locked_until  INTEGER
--   suspended_until   INTEGER
--   email             TEXT UNIQUE                 -- nullable; only if email OTP is enabled
--   email_verified    INTEGER NOT NULL DEFAULT 0
--   created_at        INTEGER NOT NULL
--   last_seen_at      INTEGER

CREATE TABLE webauthn_credentials (
  id                TEXT PRIMARY KEY,             -- crd_<ulid> (3-char prefix; every id is 30 chars)
  user_id           TEXT NOT NULL REFERENCES users(id),
  credential_id     TEXT NOT NULL UNIQUE,         -- base64url of the raw credential id
  public_key        BLOB NOT NULL,                -- COSE key bytes as returned by the library
  counter           INTEGER NOT NULL DEFAULT 0,
  transports_json   TEXT,                         -- '["internal","hybrid"]'
  backup_eligible   INTEGER NOT NULL DEFAULT 0,   -- BE flag: will this passkey sync?
  backup_state      INTEGER NOT NULL DEFAULT 0,   -- BS flag: is it currently backed up?
  device_type       TEXT,                         -- 'singleDevice' | 'multiDevice'
  aaguid            TEXT,
  label             TEXT NOT NULL DEFAULT 'Passkey',
  created_at        INTEGER NOT NULL,
  last_used_at      INTEGER,
  revoked_at        INTEGER
);
CREATE INDEX idx_cred_user ON webauthn_credentials (user_id) WHERE revoked_at IS NULL;

CREATE TABLE webauthn_challenges (
  challenge         TEXT PRIMARY KEY,
  purpose           TEXT NOT NULL,                -- 'register' | 'login'
  intent            TEXT,                         -- 'signup' | 'add_credential' | 'bootstrap_admin'
  user_id           TEXT,
  pending_handle    TEXT,
  pending_display   TEXT,
  webauthn_user_id  TEXT,
  ip_hash           TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  consumed_at       INTEGER
);
CREATE INDEX idx_wac_expires ON webauthn_challenges (expires_at);

CREATE TABLE recovery_codes (
  id           TEXT PRIMARY KEY,                  -- rec_<ulid>
  user_id      TEXT NOT NULL REFERENCES users(id),
  batch_id     TEXT NOT NULL,
  code_hash    TEXT NOT NULL,                     -- hex HMAC-SHA256(RECOVERY_PEPPER, user_id||':'||code)
  used_at      INTEGER,
  used_ip_hash TEXT,
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_rc_user_hash ON recovery_codes (user_id, code_hash);
CREATE INDEX idx_rc_user_unused ON recovery_codes (user_id) WHERE used_at IS NULL;

CREATE TABLE sessions (
  id                   TEXT PRIMARY KEY,          -- ses_<ulid>
  user_id              TEXT NOT NULL REFERENCES users(id),
  token_hash           TEXT NOT NULL,             -- hex HMAC-SHA256(SESSION_PEPPER, id||':'||secret)
  csrf_token           TEXT NOT NULL,             -- base64url of 32 random bytes
  epoch                INTEGER NOT NULL,          -- must equal users.session_epoch
  role_snapshot        TEXT NOT NULL,
  scope                TEXT NOT NULL DEFAULT 'full',   -- 'full' | 'recovery'
  uv                   INTEGER NOT NULL DEFAULT 0,
  auth_method          TEXT NOT NULL,             -- 'passkey' | 'recovery' | 'email'
  credential_id        TEXT,                      -- which passkey signed in
  created_at           INTEGER NOT NULL,
  auth_at              INTEGER NOT NULL,          -- last full ceremony; drives step-up
  last_seen_at         INTEGER NOT NULL,
  idle_expires_at      INTEGER NOT NULL,
  absolute_expires_at  INTEGER NOT NULL,
  revoked_at           INTEGER,
  revoked_reason       TEXT,
  ip_hash              TEXT,
  ip_city              TEXT,                      -- from request.cf.city; coarse, for "where am I signed in"
  ua_summary           TEXT                       -- e.g. 'Chrome on Android'; never the raw UA string
);
CREATE INDEX idx_sessions_user ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_sessions_expiry ON sessions (absolute_expires_at);

CREATE TABLE email_otps (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  user_id     TEXT,
  code_hash   TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  ip_hash     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX idx_otp_email ON email_otps (email, expires_at);
```

**The nightly cron** (`triggers.crons` in `wrangler.jsonc`, `0 20 * * *` UTC = 01:30 IST) is
implemented in `worker/lib/cron.ts` and runs **eleven** jobs, not five. Every claim the project
makes to its users about retention — the 180-day contact purge, the 30-day erasure, the 18-month PII
purge — is asserted in SECURITY.md §10.4 and OPERATIONS.md §13 and is implemented **here or
nowhere**. `DELETE /api/v1/me` returns `202` with a `finalises_at`; job 7 is what honours it.

Rules that apply to every job below:

- **Each job is its own `.batch()`**, not one giant batch. A failure in the 18-month purge must not
  roll back the session sweep.
- **Every statement has a `LIMIT` and a stated per-run cap.** SQLite compiled without
  `SQLITE_ENABLE_UPDATE_DELETE_LIMIT` (which is D1's build) does not accept `LIMIT` on `DELETE`
  directly, so the form is `DELETE FROM t WHERE rowid IN (SELECT rowid FROM t WHERE <cond> LIMIT n)`.
- **A job that hits its cap is not an error.** It logs `job=<name> capped=true` and the next night's
  run continues. These are backlogs, not deadlines.
- The whole handler is wrapped so one job throwing does not skip the rest, and every job logs
  `{ job, rows, ms }`.

#### 10.1 Ephemeral sweeps (cap 5,000 rows each)

```sql
DELETE FROM webauthn_challenges WHERE rowid IN (SELECT rowid FROM webauthn_challenges WHERE expires_at < :now LIMIT 5000);
DELETE FROM email_otps          WHERE rowid IN (SELECT rowid FROM email_otps          WHERE expires_at < :now - 86400 LIMIT 5000);
DELETE FROM sessions            WHERE rowid IN (SELECT rowid FROM sessions            WHERE absolute_expires_at < :now - 2592000 LIMIT 5000);
DELETE FROM idempotency_keys    WHERE rowid IN (SELECT rowid FROM idempotency_keys    WHERE expires_at < :now LIMIT 5000);
DELETE FROM rate_counters       WHERE rowid IN (SELECT rowid FROM rate_counters       WHERE window_start < :now - 172800 LIMIT 5000);
```

#### 10.2 Released handles (cap 1,000)

`handle_reservations.released_at` had an index and no sweeper, so a released handle was parked
forever instead of for 90 days.

```sql
DELETE FROM handle_reservations
 WHERE rowid IN (SELECT rowid FROM handle_reservations WHERE released_at <= :now LIMIT 1000);
```

#### 10.3 Superseded and used recovery codes (cap 2,000)

Kept for 180 days after supersede/use so "which batch was this from" stays answerable, then dropped.

```sql
DELETE FROM recovery_codes
 WHERE rowid IN (SELECT rowid FROM recovery_codes
                  WHERE COALESCE(superseded_at, used_at) IS NOT NULL
                    AND COALESCE(superseded_at, used_at) < :now - 15552000
                  LIMIT 2000);
```

#### 10.4 Suspension auto-lift (cap 500)

```sql
UPDATE users SET status = 'active', suspended_until = NULL, updated_at = :now
 WHERE status = 'suspended' AND suspended_until IS NOT NULL AND suspended_until <= :now;
```

An indefinite suspension has `suspended_until IS NULL` and is therefore **never** lifted here. That
is the point (§7.2).

#### 10.5 Entrant contact purge — 180 days after a tournament ends (cap 2,000 entrants)

SECURITY.md §10.4's row: *"Contact details on an entrant, purged 180 days after the tournament
reaches `completed` or `cancelled`."* The exact columns:

```sql
-- entrants
UPDATE entrants SET guest_phone_enc = NULL, guest_phone_last4 = NULL,
                    contact_email = NULL, notes = NULL, guest_token_hash = NULL, updated_at = :now
 WHERE id IN (SELECT e.id FROM entrants e JOIN tournaments t ON t.id = e.tournament_id
               WHERE t.status IN ('completed','cancelled','archived')
                 AND COALESCE(t.completed_at, t.updated_at) < :now - 15552000
                 AND (e.guest_phone_enc IS NOT NULL OR e.contact_email IS NOT NULL OR e.notes IS NOT NULL)
               LIMIT 2000);

-- entrant_members
UPDATE entrant_members SET phone_enc = NULL, phone_last4 = NULL, updated_at = :now
 WHERE id IN (SELECT m.id FROM entrant_members m JOIN tournaments t ON t.id = m.tournament_id
               WHERE t.status IN ('completed','cancelled','archived')
                 AND COALESCE(t.completed_at, t.updated_at) < :now - 15552000
                 AND m.phone_enc IS NOT NULL
               LIMIT 2000);
```

`organizer_note` is **not** purged here — it is the organiser's record of a ruling, retained with
the audit trail — but it is redacted by job 10.6 when it contains PII markers, and it is nulled by
the erasure job below for the deleted user's own rows.

#### 10.6 `pii: true` field purge — 18 months after a player's last event (cap 500 entrants)

CONTENT.md §3.3: *"18 months after a player's last event, every `pii: true` value in their
`entrants.fields_json` / `entrant_members.fields_json` is replaced with null and their display name
becomes `Player #<id>`."*

This one cannot be pure SQL, because which keys are `pii: true` is a property of the game's
`FieldDef` snapshot. Per row: read `tournaments.registration_schema_json`, collect the `pii: true`
keys, rewrite the JSON blob in the Worker with those keys set to `null`, and write it back — plus
`entrants.display_name = 'Player #' || entrant_no` and
`entrant_members.display_name = 'Player #' || slot_no`, and `ingame_id = NULL`. Cap **500 entrants
per run** because it is a read-modify-write, not a bulk `UPDATE`.

Selection: entrants whose `user_id` (or, for a guest, whose entrant row) has no tournament with
`starts_at > :now - 47304000` (18 months). Match results, scores, placements and `points_ledger`
survive untouched — the record of the competition stands; the person does not.

#### 10.7 Check-in close → `no_show` (cap 2,000 entrants)

OPERATIONS.md §6: *"When check-in closes: anyone not checked in gets `entrants.status = 'no_show'`.
Do not immediately delete them."* This is the only writer of that status besides an organiser's
explicit `PATCH`, and `status_changed_at` is **mandatory** — the schema CHECK requires it and
`BRACKET-ENGINE.md` §13.3 forfeits from that instant. Without the timestamp the engine would
retroactively convert an already-played match into a walkover.

```sql
UPDATE entrants SET status = 'no_show', status_changed_at = :now, updated_at = :now
 WHERE id IN (SELECT e.id FROM entrants e JOIN tournaments t ON t.id = e.tournament_id
               WHERE t.requires_checkin = 1
                 AND t.checkin_closes_at IS NOT NULL
                 AND t.checkin_closes_at <= :now
                 AND t.status IN ('check_in','live')
                 AND e.status = 'confirmed'
               LIMIT 2000);
```

Followed by `UPDATE tournaments SET state_version = state_version + 1 WHERE id IN (…)` for the
affected tournaments. An organiser can move a late arrival back to `confirmed` at any time (§4.8).

#### 10.8 Tournament status auto-advance (cap 500)

`db/schema.sql` builds `ix_tournaments_clock` for exactly this and nothing used it.
**Which transitions fire from the clock, and which never do:**

| From | To | Trigger | Fires from cron? |
| --- | --- | --- | --- |
| `published` | `registration_open` | `registration_opens_at <= now` | **yes** |
| `registration_open` | `registration_closed` | `registration_closes_at <= now` | **yes** |
| `registration_closed` | `check_in` | `requires_checkin = 1 ∧ checkin_opens_at <= now` | **yes** |
| `check_in` / `registration_closed` | `live` | — | **never** |
| `live` | `completed` | — | **never** |
| anything | `cancelled` | — | **never** |

The three that fire are calendar facts the organiser already committed to; leaving them manual means
a tournament sits in `published` while the WhatsApp link says registration is open. The three that
do not fire are **judgements**: going `live` requires a generated bracket and a room full of people,
and `completed` is `POST .../publish`, which writes the leaderboard. A cron must never publish
results.

```sql
UPDATE tournaments SET status = 'registration_open', state_version = state_version + 1,
                       version = version + 1, updated_at = :now
 WHERE status = 'published' AND registration_opens_at IS NOT NULL AND registration_opens_at <= :now;
-- …and the analogous two, each its own statement, each bumping state_version and listing_version.
```

Each transition writes an `audit_log` row with `actor_user_id = NULL` and
`action = 'tournament.status.auto'`, and bumps `settings['version.listing']` once at the end.

#### 10.9 Account deletion finalisation — 30 days (cap 100 users)

SECURITY.md §10.4 and API.md §3.11. The complete column list, so nobody has to guess:

```sql
-- 1. users
UPDATE users SET
    display_name = 'Deleted user',
    handle       = 'deleted_' || substr(id, 5, 10),   -- the first 10 ULID chars; lowercase by construction
    email = NULL, email_verified = 0,
    phone_enc = NULL, phone_hash = NULL, phone_last4 = NULL,
    bio = NULL, city = NULL, avatar_seed = NULL,
    profile_answers_json = NULL,
    profile_public = 0, status = 'deleted', deleted_at = :now,
    session_epoch = session_epoch + 1, profile_version = profile_version + 1,
    updated_at = :now
  WHERE deletion_requested_at IS NOT NULL AND deletion_requested_at < :now - 2592000
    AND deleted_at IS NULL;

-- 2. release the old handle for reuse after the usual 90 days
INSERT INTO handle_reservations (handle, user_id, reserved_at, released_at)
SELECT <old handle>, NULL, :now, :now + 7776000;      -- user_id NULL: nobody may reclaim it

-- 3. anonymise their entrant rows, keeping the competition record intact
UPDATE entrants SET display_name = 'Deleted user', user_id = NULL, contact_email = NULL,
                    guest_phone_enc = NULL, guest_phone_last4 = NULL, notes = NULL,
                    organizer_note = NULL, fields_json = NULL, updated_at = :now
  WHERE user_id = :uid;
UPDATE entrant_members SET display_name = 'Deleted user', user_id = NULL, ingame_id = NULL,
                    ingame_name = NULL, phone_enc = NULL, phone_last4 = NULL,
                    fields_json = NULL, updated_at = :now
  WHERE user_id = :uid;

-- 4. credentials, sessions, recovery codes, ratings
DELETE FROM webauthn_credentials WHERE user_id = :uid;
DELETE FROM sessions             WHERE user_id = :uid;
DELETE FROM recovery_codes       WHERE user_id = :uid;
DELETE FROM player_ratings       WHERE user_id = :uid;
```

**Not deleted:** `matches`, `standings`, `points_ledger`, `leaderboard_entries` and `audit_log` rows
where they are the actor. `points_ledger.user_id` is `ON DELETE CASCADE`, which is why the `users`
row is **anonymised in place and never dropped** — hard-deleting it would silently erase other
players' relative rankings. `audit_log` retains the actor id for 3 years, which is the stated
legitimate-purpose retention. This is the shape SECURITY.md §10.4 describes and the privacy page
states.

`POST /api/v1/me/undelete` (§3.11) clears `deletion_requested_at`, and job 10.9 only ever touches
rows where it is still set past the window.

---

## 11. Secrets

| Name | Kind | Purpose | Rotation |
| --- | --- | --- | --- |
| `SESSION_PEPPER` | secret | HMAC key for `sessions.token_hash` | Rotating logs everyone out. Only on suspicion of compromise. |
| `RECOVERY_PEPPER` | secret | HMAC key for `recovery_codes.code_hash` | Rotating invalidates every recovery code. Only on compromise, and tell users first. |
| `GUEST_PEPPER` | secret | HMAC key for `entrants.guest_token_hash` | Rotating invalidates live guest links. |
| `INVITE_PEPPER` | secret | HMAC key for `invites.code_hash` | Rotating invalidates unused join codes. |
| `OTP_PEPPER` | secret | HMAC key for `email_otps.code_hash` | Free to rotate — 10-minute TTL. |
| `IP_HASH_KEY` | secret | HMAC key for `ip_hash` | Yearly. Resets rate counters; acceptable. |
| `PII_KEY` | secret | AES-GCM key for `phone_enc` | Needs a re-encryption migration. See SECURITY.md §10.2. |
| `PHONE_INDEX_KEY` | secret | HMAC key for the `phone_hash` blind index | Needs a re-index migration. |
| `ADMIN_BOOTSTRAP_TOKEN` | secret | First admin only | **Delete it after use.** When unset, `GET /auth/bootstrap/status` returns `{available:false}` and the bootstrap ceremony 404s. |
| `EMAIL_API_KEY` | secret | Email provider | Only if email is enabled. |
| `TURNSTILE_SECRET_KEY` | secret | Turnstile siteverify | Optional. |

All are set with `npx wrangler secret put <NAME>`. **None of them ever appears in `wrangler.jsonc`, in
`.dev.vars` committed to the repo, in a `NEXT_PUBLIC_*` variable, or in any file that is not
gitignored.** `.dev.vars` is in `.gitignore`; a local one holds throwaway development values, never
production ones.

Non-secret configuration that *is* fine in `wrangler.jsonc` under `vars`: `ENVIRONMENT`,
`SIGNUP_OPEN`, `EMAIL_OTP_ENABLED`, `EMAIL_PROVIDER`, `EMAIL_FROM`, `EMAIL_OTP_ALLOW_SIGNUP`,
`OG_DYNAMIC`, `CSP_MODE`, `TURNSTILE_SITE_KEY` (the site key is public by design),
`ALLOW_INTL_PHONE`.

---

## 12. Client-side auth flow (what the SPA does)

Normative, so the frontend and the Worker agree.

**Boot**
1. `GET /api/v1/auth/session`. Cache the result in a React context. Hold `csrf_token` in memory only —
   never in `localStorage`, where XSS could read it and where it would outlive the session.
2. `authenticated: false` → render the public UI with a "Sign in" affordance. Never block the page on
   auth; the public tournament view must render for a signed-out phone in one paint.

**Sign in** (`/signin/`, and as a bottom sheet anywhere)
1. On mount, call `POST /auth/passkey/login/options` with `mediation: "conditional"` and pass the
   result to `startAuthentication({ optionsJSON, useBrowserAutofill: true })`. The passkey now offers
   itself in the browser's autofill, which for a returning user is a one-tap sign-in with no button
   press at all.
2. The explicit "Sign in with passkey" button calls `/options` (no handle) then
   `startAuthentication({ optionsJSON })` then `/verify`.
3. `browserSupportsWebAuthn()` false, or the ceremony throws `NotAllowedError` /
   `NotSupportedError` → show "Use a recovery code" and, if enabled, the email tab. Do not show a
   stack trace; a WebAuthn abort is usually just the user dismissing the sheet.
4. On success, refetch `GET /auth/session` to pick up the rotated `csrf_token`.

**Sign up**
1. Handle + display name → `POST /auth/passkey/register/options` → `startRegistration()` → `/verify`.
2. **Show the ten recovery codes on a full screen**, with copy and print, and a checkbox
   "I have saved these" that gates the continue button. Do not let this be a dismissible toast. This
   screen is the only thing standing between a lost phone and a lost account.

**Every mutation**
```ts
fetch(path, {
  method,
  headers: {
    'Content-Type': 'application/json',
    'X-CSRF-Token': csrfToken,
    ...(idempotencyKey && { 'Idempotency-Key': idempotencyKey }),
  },
  body: JSON.stringify(payload),
  credentials: 'same-origin',
})
```
`credentials: 'same-origin'` is the default for same-origin requests but state it explicitly — a
future refactor to an absolute URL would otherwise silently drop the cookie.

**Error handling**
- `401` → clear the auth context, show the sign-in sheet, and preserve the pending action so it can be
  retried after sign-in.
- `403 uv_required` → run the passkey ceremony with `userVerification: 'required'`, then retry once.
- `403 step_up_required` → same, then retry once.
- `403 csrf_failed` → refetch `GET /auth/session` for a fresh token and retry **once**. If it fails
  again, treat it as `401` — never loop.
- `409 stale_version` → show the server's `details.current` beside the local edit and make the
  organizer choose. Never silently overwrite.
- `429` → honour `Retry-After`, disable the submit button, and count down visibly.
