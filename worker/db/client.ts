/**
 * The D1 client. `worker/db/**` is the ONLY module that touches D1
 * (ARCHITECTURE.md §4 rule 2), and every statement that leaves this file is
 * `prepare(...).bind(...)`. String-interpolated SQL is forbidden everywhere in
 * the codebase, including migrations and admin tooling.
 *
 * This wrapper exists for three things a bare `env.DB` cannot do:
 *
 *   1. **Count subrequests against the ≤ 8 budget** of API.md Appendix D rule 1,
 *      and throw outside production when a handler exceeds it. Cloudflare's own
 *      ceiling is far higher, so an over-budget handler does not fail at
 *      runtime — it just gets slower and more expensive until the day a live
 *      final is being polled by 400 phones. Failing in dev is the only moment
 *      anybody will notice.
 *   2. **Chunk large batches at 200 statements**, with the chunk boundary's
 *      atomicity consequence stated at the call site instead of discovered
 *      later.
 *   3. **Give one place to translate a D1 throw into `503 database_unavailable`**
 *      so a raw D1 message — which routinely contains a fragment of the failing
 *      query — can never reach a response body.
 *
 * WHAT `.batch()` DOES AND DOES NOT GUARANTEE. It is all-or-nothing ON ERROR,
 * and only on error. If any statement throws, nothing commits. But **a statement
 * that matches zero rows is a SUCCESSFUL statement** and the batch commits:
 * there is no procedural logic inside a batch, a `SELECT` cannot gate a sibling
 * `INSERT`, and a guarded `UPDATE ... WHERE version = ?` matching nothing does
 * not stop its unguarded siblings from writing. Therefore **every statement in a
 * conditional batch repeats the condition** and the handler reads
 * `meta.changes` on the guard statement. API.md §6.2.1 is normative and gives
 * the exact SQL; §3.3 (capacity) and §4.13 (score) are where it is load bearing.
 */

import type { Env } from '../lib/env';
import { databaseUnavailable } from '../lib/errors';

/** What D1 accepts as a bound parameter. Nothing else may be bound, ever. */
export type BindValue = string | number | boolean | null | ArrayBuffer | ArrayBufferView;

/** API.md Appendix D rule 1. A `.batch()` counts as ONE, whatever it contains. */
export const SUBREQUEST_BUDGET = 8;

/** API.md Appendix D rule 5. D1 rejects batches above roughly this size. */
export const MAX_BATCH_STATEMENTS = 200;

/**
 * The stated `LIMIT` for every un-paginated read (API.md Appendix D rule 7).
 *
 * These are deliberately EQUAL to the creation caps they mirror. A `LIMIT` lower
 * than the cap is how a legal 8-group league renders a truncated bracket with no
 * error, the standings table and the bracket disagree, and nobody can tell why.
 */
export const LIMITS = {
  /** = MAX_MATCHES_PER_TOURNAMENT. Bracket generation refuses to exceed it. */
  matchesPerTournament: 1024,
  matchParticipantsPerTournament: 2048,
  /** = MAX_ENTRANTS per stage. */
  entrantsPerTournament: 256,
  standingsPerStage: 256,
  /** Hard cap at stage create. */
  stagesPerTournament: 4,
  /** Pinned + 5 most recent, on `/overview`. */
  announcementsOnOverview: 6,
  liveMatches: 50,
} as const;

export interface DbOptions {
  /**
   * Throw rather than warn when the budget is exceeded. Set from
   * `ENVIRONMENT !== 'production'`: a live event must not 500 because a handler
   * is one subrequest over, but a developer must not be able to merge it.
   */
  strict: boolean;
  /** Called on every subrequest. Wired to the request log in dispatch. */
  onSubrequest?: (info: SubrequestInfo) => void;
}

export interface SubrequestInfo {
  kind: 'first' | 'all' | 'run' | 'batch';
  /** Number of SQL statements in this subrequest: 1, except for a batch. */
  statements: number;
  /** The running subrequest count for this request, including this one. */
  subrequestIndex: number;
}

/**
 * Thrown when a handler exceeds the per-request subrequest budget in a
 * non-production environment. Not an `ApiError`: it is a programming error, and
 * the top-level catch turning it into `500 internal_error` with a request id is
 * exactly the right outcome.
 */
export class BudgetExceededError extends Error {
  constructor(readonly used: number, readonly budget: number) {
    super(
      `D1 subrequest budget exceeded: ${used} > ${budget} (API.md Appendix D rule 1). ` +
        'Restructure the handler into a .batch() — a batch counts as one subrequest ' +
        'regardless of how many statements it contains.',
    );
    this.name = 'BudgetExceededError';
  }
}

/**
 * A request-scoped D1 client. Construct ONE per request in dispatch and pass it
 * down; the budget is per request, so a client shared across requests would
 * count nothing useful.
 */
export class Db {
  #subrequests = 0;
  #statements = 0;

  constructor(
    private readonly d1: D1Database,
    private readonly options: DbOptions,
  ) {}

  /** Subrequests used so far. This is the number the ≤ 8 budget is about. */
  get subrequestCount(): number {
    return this.#subrequests;
  }

  /** SQL statements executed so far, counting each statement inside a batch. */
  get statementCount(): number {
    return this.#statements;
  }

  /**
   * Prepare and bind. Does NOT count against the budget — nothing has been sent
   * yet — so a handler may build a batch of 200 freely and pay for one
   * subrequest when it runs it.
   */
  prepare(sql: string, ...binds: BindValue[]): D1PreparedStatement {
    const stmt = this.d1.prepare(sql);
    return binds.length > 0 ? stmt.bind(...binds) : stmt;
  }

  /** One row or `null`. Every `SELECT` that can return more than one row needs a `LIMIT`. */
  async first<T>(sql: string, binds: BindValue[] = []): Promise<T | null> {
    this.#charge('first', 1);
    try {
      return await this.prepare(sql, ...binds).first<T>();
    } catch (cause) {
      throw databaseUnavailable(cause);
    }
  }

  /**
   * All rows. `limit` is REQUIRED and is appended by the caller in the SQL — it
   * is passed here only so the budget log records it, because an unbounded
   * `SELECT *` on `entrants`, `matches`, `audit_log` or `leaderboard_entries` is
   * the query that will one day exceed D1's row-scan budget on the evening it
   * matters.
   */
  async all<T>(sql: string, binds: BindValue[] = []): Promise<T[]> {
    this.#charge('all', 1);
    try {
      const result = await this.prepare(sql, ...binds).all<T>();
      return result.results;
    } catch (cause) {
      throw databaseUnavailable(cause);
    }
  }

  /**
   * A single write. Read `meta.changes` on anything guarded by a version or a
   * status: `changes === 0` is how optimistic concurrency reports a conflict,
   * and it is a SUCCESS as far as D1 is concerned.
   */
  async run(sql: string, binds: BindValue[] = []): Promise<D1Result> {
    this.#charge('run', 1);
    try {
      return await this.prepare(sql, ...binds).run();
    } catch (cause) {
      throw databaseUnavailable(cause);
    }
  }

  /**
   * The only atomicity primitive available: D1 executes a batch as an implicit
   * transaction. There is no BEGIN/COMMIT, no savepoint, no stored procedure.
   *
   * Every multi-row write goes through here. A score write and its
   * `match_audit` row, the `resolveBracket` diff, the affected `standings`
   * rows, the `bracket_version` and `state_version` bumps, the `audit_log` row
   * and the `idempotency_keys` completion must all land in ONE call.
   *
   * @throws if `statements.length > MAX_BATCH_STATEMENTS`. Use `batchChunked`
   *   and read its warning first — chunking gives up cross-chunk atomicity, and
   *   that is a decision, not a detail.
   */
  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    if (statements.length === 0) return [];
    if (statements.length > MAX_BATCH_STATEMENTS) {
      throw new RangeError(
        `D1 batch of ${statements.length} exceeds ${MAX_BATCH_STATEMENTS}. ` +
          'Use batchChunked(), and make each chunk independently safe to re-run.',
      );
    }
    this.#charge('batch', statements.length);
    try {
      return await this.d1.batch<T>(statements);
    } catch (cause) {
      throw databaseUnavailable(cause);
    }
  }

  /**
   * Split a large write into ≤ 200-statement batches and run them in order.
   *
   * **THE CHUNK BOUNDARY IS NOT ATOMIC.** Each chunk is its own transaction, so
   * a failure between chunks leaves the earlier chunks committed. That is
   * acceptable only when both of API.md Appendix D rule 5's conditions hold, and
   * the caller is responsible for both:
   *
   *   - every chunk is independently safe to re-run, and
   *   - the operation's "done" flag (`bracket_generated_at`,
   *     `results_published_at`) is written in the LAST chunk.
   *
   * That is what makes a mid-run failure during 256-entrant bracket generation
   * *retryable* — orphaned matches are deleted and `bracket_generated_at` is
   * still null — rather than half-committed-and-marked-done.
   *
   * Each chunk costs one subrequest, so a 1024-statement write is 6 of the 8.
   * Long operations that would exceed that return `truncated: true` and a
   * `resume_cursor` instead (rule 9).
   */
  async batchChunked<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const out: D1Result<T>[] = [];
    for (let i = 0; i < statements.length; i += MAX_BATCH_STATEMENTS) {
      out.push(...(await this.batch<T>(statements.slice(i, i + MAX_BATCH_STATEMENTS))));
    }
    return out;
  }

  #charge(kind: SubrequestInfo['kind'], statements: number): void {
    this.#subrequests += 1;
    this.#statements += statements;
    this.options.onSubrequest?.({ kind, statements, subrequestIndex: this.#subrequests });
    if (this.#subrequests > SUBREQUEST_BUDGET) {
      const error = new BudgetExceededError(this.#subrequests, SUBREQUEST_BUDGET);
      if (this.options.strict) throw error;
      // In production the request still completes: a live final erroring
      // because a handler is one subrequest over is strictly worse than the
      // subrequest. The log line is what gets it fixed.
      console.warn(error.message);
    }
  }
}

/**
 * Build the request-scoped client. `strict` is on everywhere but production, so
 * `npm run cf:dev`, preview deployments and the test suite all fail loudly on an
 * over-budget handler.
 */
export function createDb(env: Env, overrides: Partial<DbOptions> = {}): Db {
  return new Db(env.DB, {
    strict: env.ENVIRONMENT !== 'production',
    ...overrides,
  });
}

/* =====================================================================
 * Helpers that keep SQL out of string concatenation
 * ===================================================================== */

/**
 * `?, ?, ?` for an `IN (...)` list.
 *
 * This is the ONE construction where SQL text legitimately varies with input,
 * and it varies only in the number of placeholders — never in a value. Callers
 * must bind the values themselves:
 *
 * ```ts
 * const ids = [...];
 * db.all(`SELECT * FROM entrants WHERE id IN (${placeholders(ids.length)}) LIMIT ?`,
 *        [...ids, LIMITS.entrantsPerTournament]);
 * ```
 *
 * @throws when `count` is not a positive integer, so a `0` from an empty array
 *   cannot produce `IN ()` — which is a SQLite syntax error at the worst moment
 *   rather than an empty result.
 */
export function placeholders(count: number): string {
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`placeholders(${count}): guard the empty case before building the query`);
  }
  return new Array<string>(count).fill('?').join(', ');
}

/**
 * Did a guarded write actually match?
 *
 * `UPDATE ... WHERE id = ? AND result_version = ?` returning `changes === 0` is
 * D1 reporting a **successful statement that matched nothing** — which is
 * exactly the optimistic-concurrency conflict, and is the difference between
 * `409 stale_version` and silently discarding a second organiser's score.
 */
export function changed(result: D1Result): boolean {
  return result.meta.changes > 0;
}

/** The number of rows a write touched. */
export function changeCount(result: D1Result): number {
  return result.meta.changes;
}

/**
 * SQLite `LIKE` escaping for a user-supplied search fragment.
 *
 * `%`, `_` and `\` are escaped and the query must carry `ESCAPE '\'` — without
 * it, a `q` of `%` matches every row in `tournaments`, which is both a wrong
 * answer and a full table scan on the endpoint a search box calls on every
 * keystroke.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
