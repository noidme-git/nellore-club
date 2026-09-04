/**
 * WebCrypto primitives: HMAC-SHA256, AES-256-GCM, constant-time compare and
 * base64url.
 *
 * WebCrypto only — this Worker runs without `nodejs_compat`, so there is no
 * `node:crypto`, no `Buffer` and no `timingSafeEqual`. Everything here is
 * `crypto.subtle` plus `crypto.getRandomValues`.
 *
 * WHY HMAC AND NOT A PASSWORD KDF. Recovery codes and session tokens are hashed
 * with HMAC-SHA256 under a Worker secret, not PBKDF2/scrypt/argon2. Two reasons,
 * both structural rather than stylistic:
 *
 *   1. Each secret already carries ~48 bits (recovery codes) or 256 bits
 *      (session tokens) of CSPRNG entropy. A KDF's work factor exists to make a
 *      *low-entropy human password* expensive to guess; it buys nothing against
 *      a value that was never guessable.
 *   2. Workers bill CPU. An honest PBKDF2 iteration count on an unauthenticated
 *      endpoint is a cost-amplification vector — an attacker spends one request
 *      to make us spend 100 ms.
 *
 * A D1 dump is worthless without the pepper, which lives in the Worker secret
 * store and never in the database. And because the hash is deterministic,
 * verifying a recovery code is ONE indexed lookup on `(user_id, code_hash)` —
 * no candidate scan, no per-code work.
 */

/* =====================================================================
 * Encoding
 * ===================================================================== */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8(value: string): Uint8Array {
  return encoder.encode(value);
}

export function fromUtf8(bytes: BufferSource): string {
  return decoder.decode(bytes);
}

const HEX = '0123456789abcdef';

/** Lowercase hex. The stored form of every `*_hash` column that is not a blind index. */
export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = '';
  for (let i = 0; i < view.length; i += 1) {
    const byte = view[i] ?? 0;
    out += HEX[byte >> 4];
    out += HEX[byte & 0x0f];
  }
  return out;
}

/**
 * base64url, unpadded (RFC 4648 §5). Used for session secrets, CSRF tokens,
 * guest tokens, `webauthn_user_id`, credential ids, `ip_hash` and cursors.
 *
 * Unpadded because these values appear in URLs and cookies, where `=` is legal
 * but routinely mangled by link shorteners and WhatsApp's own URL rewriting.
 */
export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  // Chunked: `String.fromCharCode(...view)` blows the argument limit somewhere
  // above ~64 KB, and an encrypted phone blob is small but a cursor payload need
  // not be.
  const CHUNK = 0x8000;
  for (let i = 0; i < view.length; i += CHUNK) {
    binary += String.fromCharCode(...view.subarray(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode base64url. Throws on anything that is not base64url — callers are
 * decoding untrusted input (a cursor, a guest token, a credential id) and a
 * silent empty result would be indistinguishable from a legitimately empty
 * value.
 */
export function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new TypeError('crypto: not base64url');
  }
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, '=');
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/* =====================================================================
 * Random
 * ===================================================================== */

/** `n` CSPRNG bytes. */
export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

/**
 * A 32-byte CSPRNG token as 43 base64url characters. This is the shape of a
 * session secret, a CSRF token, a guest token and `webauthn_user_id`.
 */
export function randomToken(bytes = 32): string {
  return toBase64Url(randomBytes(bytes));
}

/**
 * A uint32 from the CSPRNG. `tournaments.bracket_seed` is written once at
 * creation from this and is IMMUTABLE, so a randomised draw is reproducible and
 * "the draw was rigged" has a verifiable answer.
 */
export function randomUint32(): number {
  const [value] = crypto.getRandomValues(new Uint32Array(1));
  if (value === undefined) throw new Error('crypto: getRandomValues returned nothing');
  return value;
}

/**
 * Pick `count` characters from `alphabet` with REJECTION SAMPLING.
 *
 * Modulo-reducing a random byte into a 28-symbol alphabet makes the first eight
 * symbols ~14% more likely than the rest. For a 6-character join code read
 * aloud in a hall that is a measurable reduction in guessing work, and it costs
 * nothing to do correctly.
 *
 * The join/invite alphabet is `23456789BCDFGHJKMNPQRSTVWXYZ` — no `0 O 1 I L`,
 * no vowels, because the code is read aloud in a noisy hall and must not
 * accidentally spell a word.
 */
export function randomFromAlphabet(alphabet: string, count: number): string {
  const n = alphabet.length;
  if (n < 2 || n > 256) throw new RangeError('crypto: alphabet must be 2..256 symbols');
  // Largest multiple of n that fits in a byte; anything at or above it is
  // redrawn rather than folded.
  const limit = Math.floor(256 / n) * n;
  let out = '';
  while (out.length < count) {
    const batch = randomBytes(Math.max(count - out.length, 8) * 2);
    for (let i = 0; i < batch.length && out.length < count; i += 1) {
      const byte = batch[i] ?? 0;
      if (byte < limit) out += alphabet[byte % n];
    }
  }
  return out;
}

export const INVITE_CODE_ALPHABET = '23456789BCDFGHJKMNPQRSTVWXYZ';

/* =====================================================================
 * Constant-time comparison
 * ===================================================================== */

/**
 * Compare two strings without leaking their contents through timing.
 *
 * `a === b` on a token hash short-circuits at the first differing byte, which is
 * a byte-at-a-time oracle over a network an attacker can measure. Every
 * comparison of a session token hash, a recovery-code hash, a CSRF token, a
 * guest token or a bootstrap token goes through here.
 *
 * Length is compared first and NOT in constant time — a length mismatch is
 * already public (these values are fixed-length by construction), and folding
 * it into the loop would either read out of bounds or introduce a branch.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** The same, for raw bytes (a decoded credential id, a MAC). */
export function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

/* =====================================================================
 * HMAC-SHA256
 * ===================================================================== */

/**
 * Imported keys are cached per (algorithm, key material) for the life of the
 * isolate. `importKey` is not free and a hot request path HMACs the session
 * token on every single authenticated call; the pepper is a module-scope
 * constant for the deployment, so re-importing it per request buys nothing.
 *
 * The cache is keyed by the raw secret string, which is why nothing in this
 * module ever logs a cache key.
 */
const hmacKeyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  const cached = hmacKeyCache.get(secret);
  if (cached !== undefined) return cached;
  const promise = crypto.subtle.importKey(
    'raw',
    utf8(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  hmacKeyCache.set(secret, promise);
  return promise;
}

/** Raw HMAC-SHA256 bytes. */
export async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await hmacKey(secret);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(message)));
}

/**
 * HMAC-SHA256 as lowercase hex. This is the stored form of
 * `sessions.token_hash`, `recovery_codes.code_hash`, `entrants.guest_token_hash`,
 * `invites.code_hash` and `email_otps.code_hash` — the schema comments name hex
 * explicitly, so the encoding is part of the contract and not a choice a caller
 * gets to make.
 */
export function hmacHex(secret: string, message: string): Promise<string> {
  return hmac(secret, message).then(toHex);
}

/**
 * HMAC-SHA256 as base64url. Used where the value goes into a URL or a cache key
 * rather than a `*_hash` column — notably `ip_hash`, which SECURITY.md §10.3
 * defines as `base64url(HMAC(IP_HASH_KEY, ip))[0:16]`.
 */
export function hmacBase64Url(secret: string, message: string): Promise<string> {
  return hmac(secret, message).then(toBase64Url);
}

/**
 * `ip_hash` — SECURITY.md §10.3. Raw client IPs are NEVER written to D1 and
 * never returned by any endpoint; where one is needed (rate limiting, abuse
 * forensics, "where am I signed in") this truncated HMAC is what is stored.
 *
 * Truncated to 16 characters (96 bits) on purpose: it is a bucketing key, not a
 * signature, and a shorter column is a smaller thing to leak.
 */
export async function ipHash(key: string, ip: string): Promise<string> {
  return (await hmacBase64Url(key, ip)).slice(0, 16);
}

/** SHA-256 as lowercase hex. Request-body fingerprints, content hashes, CSP hashes. */
export async function sha256Hex(message: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', utf8(message)));
}

/** SHA-256 as base64url. The cursor's 8-character query fingerprint is the first 8 of this. */
export async function sha256Base64Url(message: string): Promise<string> {
  return toBase64Url(await crypto.subtle.digest('SHA-256', utf8(message)));
}

/* =====================================================================
 * AES-256-GCM — the PII path
 * ===================================================================== */

/** 96-bit IV: the size AES-GCM is specified and optimised for. */
const GCM_IV_BYTES = 12;
const AES_KEY_BYTES = 32;

const aesKeyCache = new Map<string, Promise<CryptoKey>>();

function aesKey(base64UrlKey: string): Promise<CryptoKey> {
  const cached = aesKeyCache.get(base64UrlKey);
  if (cached !== undefined) return cached;
  const raw = fromBase64Url(base64UrlKey);
  if (raw.length !== AES_KEY_BYTES) {
    // `assertEnv` already checks this at boot; repeating it here means a key
    // passed from anywhere else cannot silently weaken the cipher.
    throw new Error(`crypto: AES key must be ${AES_KEY_BYTES} bytes, got ${raw.length}`);
  }
  const promise = crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
  aesKeyCache.set(base64UrlKey, promise);
  return promise;
}

/**
 * Encrypt a phone number (or any small PII string) for
 * `users.phone_enc` / `entrants.guest_phone_enc` / `entrant_members.phone_enc`.
 *
 * @param base64UrlKey the `PII_KEY` secret
 * @param plaintext E.164, e.g. `+919876504417`
 * @param aad **the owning row's id**. This is not optional and it is not
 *   decoration: GCM authenticates the AAD, so a ciphertext copied from one row
 *   into another fails to decrypt instead of silently becoming that row's phone
 *   number. SECURITY.md §10.2.
 *
 * The returned blob is `IV (12 bytes) || ciphertext || tag`, stored as a single
 * BLOB column. Keeping the IV in the blob rather than in a second column means
 * there is no way to write one without the other, and no migration if the IV
 * size ever changes.
 */
export async function encryptPii(
  base64UrlKey: string,
  plaintext: string,
  aad: string,
): Promise<Uint8Array> {
  const key = await aesKey(base64UrlKey);
  const iv = randomBytes(GCM_IV_BYTES);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: utf8(aad) },
      key,
      utf8(plaintext),
    ),
  );
  const out = new Uint8Array(iv.length + ciphertext.length);
  out.set(iv, 0);
  out.set(ciphertext, iv.length);
  return out;
}

/**
 * Decrypt a PII blob written by `encryptPii`.
 *
 * Returns `null` — it does not throw — when the blob is malformed or the tag
 * does not verify. Both cases mean the same operational thing: this row's
 * number is not readable (wrong key after a rotation, a truncated write, or a
 * ciphertext that was moved between rows), and every caller's correct response
 * is to show the `phone_last4` it already has rather than 500 an organiser's
 * contact screen mid-event.
 *
 * `aad` MUST be the same owning row id used at encrypt time.
 */
export async function decryptPii(
  base64UrlKey: string,
  blob: ArrayBuffer | Uint8Array,
  aad: string,
): Promise<string | null> {
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  if (bytes.length <= GCM_IV_BYTES) return null;
  try {
    const key = await aesKey(base64UrlKey);
    const iv = bytes.subarray(0, GCM_IV_BYTES);
    const ciphertext = bytes.subarray(GCM_IV_BYTES);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: utf8(aad) },
      key,
      ciphertext,
    );
    return fromUtf8(plaintext);
  } catch {
    return null;
  }
}

/**
 * The blind index for `users.phone_hash`: `HMAC(PHONE_INDEX_KEY, e164)`.
 *
 * Answers "is this number already registered?" without decrypting anything. It
 * is brute-forceable over the 10-digit Indian mobile space IF the key leaks —
 * which is exactly why `PHONE_INDEX_KEY` is a different secret from `PII_KEY`,
 * so that a D1 dump plus one leaked key yields either the numbers or a usable
 * index, never both.
 */
export function phoneBlindIndex(indexKey: string, e164: string): Promise<string> {
  return hmacHex(indexKey, e164);
}

/**
 * The stored, displayed form of a phone number: `+91 ••••• •4417`.
 *
 * This is what goes into `fields_json` and what `/api/v1/me` returns — the
 * plaintext never enters the JSON blob, so it cannot be leaked by a serializer
 * that forgets a rule (SECURITY.md §10.2.1). The full number is returned by
 * exactly one endpoint, which writes an `audit_log` row on every call.
 */
export function maskPhone(last4: string): string {
  return `+91 ••••• •${last4}`;
}
