/**
 * The Worker's environment: every binding and var of ARCHITECTURE.md §7, plus
 * `assertEnv()`, the startup check of §7.2.
 *
 * `assertEnv(env)` runs at the TOP of `fetch()` and at the top of `scheduled()`,
 * before routing, before the rate limiter, before D1 is touched. It must be
 * impossible for the Worker to serve one request with a missing pepper and
 * silently write hashes it can never verify again — a session token hashed
 * under `undefined` is a session that can never be validated, and a recovery
 * code hashed under `undefined` locks a real person out of a real account
 * permanently. The failure has to be loud, immediate, and name the binding.
 *
 * The `RL_*` bindings are asserted for the same reason and one more: wrangler
 * treats an unknown top-level config key as a WARNING, so `"ratelimit"` instead
 * of `"ratelimits"` deploys cleanly and leaves every binding `undefined`, at
 * which point `env.RL_READ.limit(...)` throws and EVERY endpoint 500s on the
 * first request — a total outage whose cause looks like application code.
 * Checking for the `.limit` function at boot turns that into one log line
 * naming `RL_READ`.
 */

/* =====================================================================
 * Bindings
 * ===================================================================== */

/**
 * The eleven Workers Rate Limiting bindings, declared as `"ratelimits"`
 * (PLURAL) with a `"name"` (not `"binding"`) per entry in wrangler.jsonc.
 *
 * The binding only supports 10 s and 60 s windows and is per-colo, which is
 * fine for these: they exist to stop scripted abuse, not to meter an API.
 * Per-hour and per-day limits genuinely need to be global and use the
 * `rate_counters` D1 table instead.
 */
export interface RateLimitBindings {
  /** 300/60s — every public GET. A 429 here touches neither D1 nor the cache. */
  RL_READ: RateLimit;
  /** 20/60s — the `begin` half of every auth ceremony: cheap, and the one bots hammer. */
  RL_AUTH_BEGIN: RateLimit;
  /** 10/60s — the `verify` half: expensive, and the one worth guessing at. */
  RL_AUTH_VERIFY: RateLimit;
  /** 5/60s — recovery-code redemption. */
  RL_RECOVERY: RateLimit;
  /** 5/60s — registration. */
  RL_REGISTER: RateLimit;
  /** 5/60s — guest registration. */
  RL_GUEST: RateLimit;
  /** 30/60s — guest-token reads (a checked-in walk-in refreshing their entry). */
  RL_GUEST_TOKEN: RateLimit;
  /** 60/60s — ordinary authenticated mutations. */
  RL_WRITE: RateLimit;
  /** 30/10s — score entry. Deliberately a short window: an organiser scoring a round fast is normal. */
  RL_SCORE: RateLimit;
  /** 120/60s — authenticated reads (`/me/*`, `/organizer/*` GETs). */
  RL_AUTH_READ: RateLimit;
  /** 20/60s — bracket generation, reseed, recompute. The CPU-expensive endpoints. */
  RL_ENGINE: RateLimit;
}

/** Var names, so `assertEnv` and the callers agree on spelling. */
export type EnvVarName =
  | 'ENVIRONMENT'
  | 'SITE_ORIGIN'
  | 'SIGNUP_OPEN'
  | 'EMAIL_OTP_ENABLED'
  | 'EMAIL_PROVIDER'
  | 'EMAIL_FROM'
  | 'EMAIL_OTP_ALLOW_SIGNUP'
  | 'OG_DYNAMIC'
  | 'CSP_MODE'
  | 'TURNSTILE_SITE_KEY'
  | 'ALLOW_INTL_PHONE';

export type SecretName =
  | 'SESSION_PEPPER'
  | 'RECOVERY_PEPPER'
  | 'GUEST_PEPPER'
  | 'INVITE_PEPPER'
  | 'IP_HASH_KEY'
  | 'PII_KEY'
  | 'PHONE_INDEX_KEY'
  | 'OTP_PEPPER'
  | 'ADMIN_BOOTSTRAP_TOKEN'
  | 'EMAIL_API_KEY'
  | 'TURNSTILE_SECRET_KEY';

export type Environment = 'production' | 'preview' | 'development';

export type CspMode = 'enforce' | 'report-only';

export interface Env extends RateLimitBindings {
  /* ---- bindings ---- */

  /** Workers Static Assets over `./out`. `run_worker_first` is the ARRAY form. */
  ASSETS: Fetcher;
  /** D1. `worker/db/**` is the only module allowed to touch it. */
  DB: D1Database;

  /* ---- vars (ARCHITECTURE.md §7.1) ---- */

  /** Gates the dev cookie name and the localhost origin allowlist. Unset => fail startup. */
  ENVIRONMENT: string;
  /** The `Origin` allowlist and the base of every absolute OG URL. Unset => fail startup. */
  SITE_ORIGIN: string;
  /** `"0"` => `POST /auth/passkey/register/*` returns `403 signup_closed`. Unset is `"1"`. */
  SIGNUP_OPEN?: string;
  /** Unset/`"0"` => `/auth/email/*` returns `501 email_auth_disabled`. This is the launch state. */
  EMAIL_OTP_ENABLED?: string;
  EMAIL_PROVIDER?: string;
  EMAIL_FROM?: string;
  /** `"0"` => email OTP can sign an existing user in but cannot create an account. */
  EMAIL_OTP_ALLOW_SIGNUP?: string;
  /** Never set in v1. `/og/t/*` always 302s to the static category card. */
  OG_DYNAMIC?: string;
  /** `"report-only"` for exactly one deploy after a CSP change, never longer. */
  CSP_MODE?: string;
  /** Unset => `GET /config` reports `turnstile: false` and the guest form renders no widget. */
  TURNSTILE_SITE_KEY?: string;
  /** `"0"` => phone numbers must start `+91`. */
  ALLOW_INTL_PHONE?: string;

  /* ---- secrets (ARCHITECTURE.md §7.2) ---- */

  /** HMAC key for `sessions.token_hash`. Rotating logs everyone out. */
  SESSION_PEPPER: string;
  /** HMAC key for `recovery_codes.code_hash`. Rotating invalidates every recovery code. */
  RECOVERY_PEPPER: string;
  /** HMAC key for `entrants.guest_token_hash`. Rotating kills every live guest link. */
  GUEST_PEPPER: string;
  /** HMAC key for `invites.code_hash`. Rotating invalidates unused join codes. */
  INVITE_PEPPER: string;
  /** HMAC key for every `ip_hash`. The alternative is storing raw IPs, which the DPDP posture forbids. */
  IP_HASH_KEY: string;
  /** AES-256-GCM key, base64url, 32 bytes decoded. Rotating needs a re-encryption migration. */
  PII_KEY: string;
  /** HMAC key for the `users.phone_hash` blind index, base64url, 32 bytes decoded. Deliberately separate from PII_KEY. */
  PHONE_INDEX_KEY: string;
  /** HMAC key for `email_otps.code_hash`. Required only when email OTP is on. */
  OTP_PEPPER?: string;
  /** Unset => the bootstrap ceremony 404s. THAT IS THE CORRECT STEADY STATE — delete it after the first admin exists. */
  ADMIN_BOOTSTRAP_TOKEN?: string;
  EMAIL_API_KEY?: string;
  /** Unset => the Turnstile check is not registered at all, rather than failing open at a check. */
  TURNSTILE_SECRET_KEY?: string;
}

/* =====================================================================
 * The startup check
 * ===================================================================== */

/**
 * Thrown by `assertEnv`. The caller turns it into a `503 database_unavailable`-
 * shaped error with a distinct `request_id`, and logs `missing` — the operator
 * needs the NAME, because "the site is down" and "SESSION_PEPPER is not set"
 * are twenty minutes apart.
 *
 * The message is safe to log and unsafe to return: it names internal
 * configuration. The response body says nothing but the request id.
 */
export class EnvError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(`Worker misconfigured; refusing to serve. Missing or invalid: ${missing.join(', ')}`);
    this.name = 'EnvError';
    this.missing = missing;
  }
}

/** Fail-startup vars. Guessing a default for either of these is not acceptable. */
const REQUIRED_VARS = ['ENVIRONMENT', 'SITE_ORIGIN'] as const satisfies readonly EnvVarName[];

/**
 * Fail-startup secrets. `OTP_PEPPER` is not here (it is required only when email
 * OTP is on, and is checked below), and neither are `ADMIN_BOOTSTRAP_TOKEN`,
 * `EMAIL_API_KEY` or `TURNSTILE_SECRET_KEY`, whose absence is a documented
 * steady state rather than a failure.
 *
 * `PII_KEY` and `PHONE_INDEX_KEY` ARE here. §7.2 permits phone collection to be
 * disabled instead, but that degradation has to be decided at boot, not
 * discovered at the instant an organiser saves a squad's WhatsApp numbers — and
 * `requires_phone` tournaments must be refused at creation, which needs the
 * answer before the first request either way.
 */
const REQUIRED_SECRETS = [
  'SESSION_PEPPER',
  'RECOVERY_PEPPER',
  'GUEST_PEPPER',
  'INVITE_PEPPER',
  'IP_HASH_KEY',
  'PII_KEY',
  'PHONE_INDEX_KEY',
] as const satisfies readonly SecretName[];

/** Every binding wrangler.jsonc's `"ratelimits"` array declares, in the same order. */
export const RATE_LIMIT_BINDINGS = [
  'RL_READ',
  'RL_AUTH_BEGIN',
  'RL_AUTH_VERIFY',
  'RL_RECOVERY',
  'RL_REGISTER',
  'RL_GUEST',
  'RL_GUEST_TOKEN',
  'RL_WRITE',
  'RL_SCORE',
  'RL_AUTH_READ',
  'RL_ENGINE',
] as const satisfies readonly (keyof RateLimitBindings)[];

/** A pepper shorter than this is a typo or a placeholder, not a secret. */
const MIN_PEPPER_LENGTH = 16;

/** AES-256 and HMAC-SHA256 both want 32 bytes. base64url of 32 bytes is 43 chars. */
const KEY_BYTES = 32;

/**
 * Decodes a base64url secret and returns its byte length, or -1 if it is not
 * decodable. Deliberately does not throw: `assertEnv` collects EVERY problem and
 * reports them together, because fixing one secret, redeploying, and finding the
 * next one is three deploys instead of one.
 */
function base64urlByteLength(value: string): number {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return -1;
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  try {
    return atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '=')).length;
  } catch {
    return -1;
  }
}

/**
 * Validate the environment. Call at the top of `fetch()` and `scheduled()`.
 *
 * Cheap enough to be unconditional: eleven property reads, nine string length
 * checks and two base64 decodes of 43 characters. Caching the result in a
 * module-level flag was rejected — a Worker isolate is reused across requests,
 * so a cached "ok" from a previous deployment's `env` would survive a config
 * change, which is exactly the failure this function exists to catch.
 *
 * @throws {EnvError} naming every missing or invalid binding, var and secret.
 */
export function assertEnv(env: Env): void {
  const missing: string[] = [];

  if (typeof env.DB?.prepare !== 'function') missing.push('DB (D1 binding)');
  if (typeof env.ASSETS?.fetch !== 'function') missing.push('ASSETS (static assets binding)');

  for (const name of RATE_LIMIT_BINDINGS) {
    if (typeof env[name]?.limit !== 'function') {
      // Almost always `"ratelimit"` instead of `"ratelimits"`, or `"binding"`
      // instead of `"name"`, in wrangler.jsonc. Both deploy cleanly.
      missing.push(`${name} (ratelimits binding — check wrangler.jsonc uses "ratelimits" and "name")`);
    }
  }

  for (const name of REQUIRED_VARS) {
    if (!isNonEmpty(env[name])) missing.push(`${name} (var)`);
  }

  for (const name of REQUIRED_SECRETS) {
    const value = env[name];
    if (!isNonEmpty(value)) {
      missing.push(`${name} (secret)`);
      continue;
    }
    if (name === 'PII_KEY' || name === 'PHONE_INDEX_KEY') {
      const bytes = base64urlByteLength(value);
      if (bytes !== KEY_BYTES) {
        missing.push(`${name} (secret must be base64url of exactly ${KEY_BYTES} bytes, got ${bytes < 0 ? 'undecodable' : `${bytes}`})`);
      }
    } else if (value.length < MIN_PEPPER_LENGTH) {
      missing.push(`${name} (secret must be at least ${MIN_PEPPER_LENGTH} characters)`);
    }
  }

  // Email OTP needs all four or none. A half-configured provider means
  // `/auth/email/begin` accepts a request, mints an OTP row, and then cannot
  // send it — the user waits for a code that will never arrive.
  if (isFlagOn(env.EMAIL_OTP_ENABLED)) {
    if (!isNonEmpty(env.EMAIL_PROVIDER)) missing.push('EMAIL_PROVIDER (var, required by EMAIL_OTP_ENABLED=1)');
    if (!isNonEmpty(env.EMAIL_FROM)) missing.push('EMAIL_FROM (var, required by EMAIL_OTP_ENABLED=1)');
    if (!isNonEmpty(env.EMAIL_API_KEY)) missing.push('EMAIL_API_KEY (secret, required by EMAIL_OTP_ENABLED=1)');
    if (!isNonEmpty(env.OTP_PEPPER)) missing.push('OTP_PEPPER (secret, required by EMAIL_OTP_ENABLED=1)');
  }

  // ARCHITECTURE.md §7.2, last paragraph: in production the dev cookie branch
  // must be unreachable and SITE_ORIGIN must be https:. A `__Host-` cookie is
  // rejected by the browser over http anyway, so an http SITE_ORIGIN in
  // production is an outage that presents as "sign-in silently does nothing".
  if (env.ENVIRONMENT === 'production') {
    if (!env.SITE_ORIGIN?.startsWith('https://')) {
      missing.push('SITE_ORIGIN (must be https: when ENVIRONMENT=production)');
    }
    if (isFlagOn(env.OG_DYNAMIC)) {
      // Nothing implements the non-302 branch; a truthy flag in production
      // would route WhatsApp at a handler that does not exist.
      missing.push('OG_DYNAMIC (must not be enabled in v1 — the dynamic branch is unimplemented)');
    }
  }

  if (env.CSP_MODE !== undefined && env.CSP_MODE !== 'enforce' && env.CSP_MODE !== 'report-only') {
    missing.push(`CSP_MODE (must be "enforce" or "report-only", got ${JSON.stringify(env.CSP_MODE)})`);
  }

  if (missing.length > 0) throw new EnvError(missing);
}

/* =====================================================================
 * Typed readers — one place per var, so a default is decided once.
 * ===================================================================== */

function isNonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * The project's one truthiness convention for a var: `"1"` is on, everything
 * else — including `"true"`, `"yes"` and `""` — is off. Vars are strings, and
 * `"0"` is truthy in JavaScript; a feature flag that turns itself on when
 * someone writes `"false"` is a defect waiting for a launch day.
 */
export function isFlagOn(value: string | undefined): boolean {
  return value === '1';
}

/** Unset is treated as `"1"` (ARCHITECTURE.md §7.1). */
export function isSignupOpen(env: Env): boolean {
  return env.SIGNUP_OPEN === undefined || env.SIGNUP_OPEN === '1';
}

export function isEmailOtpEnabled(env: Env): boolean {
  return (
    isFlagOn(env.EMAIL_OTP_ENABLED) &&
    isNonEmpty(env.EMAIL_PROVIDER) &&
    isNonEmpty(env.EMAIL_FROM) &&
    isNonEmpty(env.EMAIL_API_KEY)
  );
}

export function isTurnstileEnabled(env: Env): boolean {
  return isNonEmpty(env.TURNSTILE_SITE_KEY) && isNonEmpty(env.TURNSTILE_SECRET_KEY);
}

export function isProduction(env: Env): boolean {
  return env.ENVIRONMENT === 'production';
}

export function cspMode(env: Env): CspMode {
  return env.CSP_MODE === 'report-only' ? 'report-only' : 'enforce';
}

/**
 * `__Host-nc_session` in production; `nc_session_dev` (no `Secure`) everywhere
 * else. The `__Host-` prefix is refused by the browser over http, so localhost
 * needs the second name — and the two names are deliberately different so a dev
 * cookie can never be mistaken for a production one in a log or a bug report.
 */
export function sessionCookieName(env: Env): string {
  return isProduction(env) ? '__Host-nc_session' : 'nc_session_dev';
}

/**
 * The `Origin` allowlist for every mutation. Localhost is added only outside
 * production — SECURITY.md §5 depends on this list being exact.
 */
export function allowedOrigins(env: Env): readonly string[] {
  if (isProduction(env)) return [env.SITE_ORIGIN];
  return [env.SITE_ORIGIN, 'http://localhost:8787', 'http://127.0.0.1:8787', 'http://localhost:3000'];
}
