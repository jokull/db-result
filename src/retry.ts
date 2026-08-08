import { Result } from "better-result";
import {
  type DbError,
  mark,
  isConnectionFailure,
  QueryFailure,
  DeadlockError,
  LockTimeoutError,
} from "./tags.js";
import { classify } from "./classify/index.js";
import {
  type ShapeLedger,
  type DefaultLedger,
  type ShapeUnion,
  type ShapeProven,
} from "./lattice.js";

// better-result does not export `RetryConfig`/`TryPromiseContext` as types —
// these mirror the host's shapes so `tryDb`'s config is structurally
// identical to `Result.tryPromise`'s.
type TryPromiseContext = { attempt: number; signal?: AbortSignal };

type RetryOptions<E> =
  | {
      times: number;
      delayMs: number;
      backoff: "linear" | "constant" | "exponential";
      shouldRetry?: (error: E, context: TryPromiseContext) => boolean;
      jitter?: boolean | number;
    }
  | {
      times: number;
      delayMs: (error: E, context: TryPromiseContext) => number;
      shouldRetry?: (error: E, context: TryPromiseContext) => boolean;
    };

type RetryConfig<E> = {
  signal?: AbortSignal;
  retry?: RetryOptions<E>;
};

// ─── tryDb ───────────────────────────────────────────────────────────────────

/**
 * Carries the original driver failure on the classified error: the real
 * `message` and the standard enumerable `Error.cause`. The tag constructors
 * forward `message`/`cause` to `Error` and spread the props, so the rebuild
 * preserves the classification props (`constraint`, `potentiallyTransient`)
 * while making `error.message`, `String(error)`, `toJSON`, and structured
 * loggers self-describing — no hidden-property walking (ISSUES #2).
 * `retrySafe` is re-marked (non-enumerable by design).
 */
const withCause = (error: DbError, cause: unknown): DbError => {
  const retrySafe = (error as DbError & { retrySafe?: boolean }).retrySafe;
  const message =
    cause instanceof Error ? cause.message : typeof cause === "string" ? cause : String(cause);
  try {
    const rebuilt = new (error.constructor as new (args: Record<string, unknown>) => DbError)({
      ...(error as unknown as Record<string, unknown>),
      message,
      cause,
    });
    if (retrySafe !== undefined) mark(rebuilt, retrySafe);
    return rebuilt;
  } catch {
    // classification must never fail — fall back to the hidden cause
    try {
      Object.defineProperty(error, "cause", {
        value: cause,
        enumerable: false,
        writable: true,
        configurable: true,
      });
    } catch {
      // cause is diagnostic only
    }
    return error;
  }
};

/** Internal: may this classified error be auto-retried by the default policy? */ const isRetrySafe =
  (error: DbError): boolean => (error as DbError & { retrySafe?: boolean }).retrySafe === true;

/** Per-error retry delay — the "sensible defaults" behind retryTransient. */
const retryDelay = (error: DbError, ctx: TryPromiseContext): number => {
  const backoff = 2 ** (ctx.attempt - 1);
  if (isConnectionFailure(error)) return 200 * backoff; // reconnect, wait longer
  if (QueryFailure.is(error) || DeadlockError.is(error) || LockTimeoutError.is(error)) {
    return 50 * backoff;
  }
  return 100 * backoff;
};

const DEFAULT_RETRY: RetryOptions<DbError> = {
  times: 3,
  delayMs: retryDelay,
  shouldRetry: (e) => isRetrySafe(e),
};

/**
 * Config for `tryDb` / `tryTx`. An explicit `retry` always wins; without one,
 * transient failures are auto-retried (`retryTransient`, default `true`) with
 * sensible per-error defaults. Deterministic errors (constraints, auth, authz,
 * syntax, data) and ambiguous outcomes (connection lost mid-query, unknown
 * commit outcome) are never auto-retried.
 */
export type TryDbConfig<E> = {
  /** Auto-retry the transient set with per-error defaults. Default: `true`. */
  retryTransient?: boolean;
  /** Full retry policy override — you own `times`/`delayMs`/`shouldRetry`. */
  retry?: RetryOptions<E>;
  /** Abort signal forwarded to every attempt and retry delay. */
  signal?: AbortSignal;
};

/** A re-executable query builder — both the retry unit and the shape
 * carrier. `execute` is matched as a property so method-style (Kysely,
 * Drizzle async select) and property-style (Drizzle async writes) both
 * qualify. */
type BuilderQuery = { execute: (...args: any[]) => PromiseLike<unknown> };

/** The result type a builder produces. Drizzle's builders carry it in their
 * `_` slot — rc.4 declares `execute` as a `this`-derived property that
 * inference can't follow, so the `_` slot is the reliable source; Kysely's
 * `execute` infers directly. */
type QueryResultOf<F> = F extends { _: { result: infer R } }
  ? R
  : F extends { execute: (...args: any[]) => PromiseLike<infer T> }
    ? T
    : never;

/** Guards the thunk/promise overloads against builder values — pass a
 * builder directly instead of wrapping it. */
type NotBuilder<T> = T extends BuilderQuery ? never : T;

/** Query-shaped thunk — no parameters, re-invoked once per retry attempt. */
export type QueryThunk<T> = () => PromiseLike<T> | NotBuilder<T>;

/**
 * The `tryDb` surface bound to a narrowed error union `E` and a shape ledger
 * `L`. Three forms, in overload order:
 *
 *   1. A **query builder value** — the shape lattice reads the builder's own
 *      type (Kysely's brands, Drizzle's clause surface) and narrows the
 *      union to what that shape provably cannot produce. Auto-retry
 *      re-executes the builder. A builder that proves no shape is a compile
 *      error (fail-loud) — never a silent full union.
 *   2. A **promise-returning thunk** — `tryDb` cannot see into the call, so
 *      the union stays full; auto-retry re-invokes the thunk.
 *   3. A **settled promise** — one-shot, so auto-retry is off (a dev warning
 *      fires once); wrap in a thunk to get retry.
 *
 * Bare values and builders wrapped in thunks are compile errors.
 */
export interface TryDbFor<E extends DbError, L extends ShapeLedger = DefaultLedger> {
  <F extends BuilderQuery>(
    query: F & ShapeProven<F>,
    config?: TryDbConfig<E>,
  ): Promise<Result<QueryResultOf<F>, ShapeUnion<E, L, F>>>;
  <T>(query: QueryThunk<T>, config?: TryDbConfig<E>): Promise<Result<T, E>>;
  <T>(query: PromiseLike<T>, config?: TryDbConfig<E>): Promise<Result<T, E>>;
}

/** The `tryTx` surface bound to a narrowed error union `E`. */
export interface TryTxFor<E extends DbError> {
  <T>(thunk: QueryThunk<T> | PromiseLike<T> | T, config?: TryDbConfig<E>): Promise<Result<T, E>>;
}

/**
 * Shared retry engine behind `tryDb` / `tryTx`.
 *
 * Built on better-result's `Result.tryPromise`. Transient failures retry by
 * default with per-error defaults; deterministic errors (constraints, auth,
 * authz, syntax, data) and ambiguous outcomes (connection lost mid-query,
 * unknown commit outcome) are never auto-retried. Hand an explicit `retry` to
 * own the policy (a safe gate is injected unless you provide `shouldRetry`),
 * or set `retryTransient: false` to disable auto-retry entirely.
 *
 * Retry re-invokes the query per attempt: a builder is re-executed, a thunk
 * re-called. A settled promise cannot be re-run — the promise form never
 * auto-retries (a dev-mode warning fires once; `retryTransient: false`
 * silences it).
 *
 * Keep the thunk to the SQL statement — it runs once per attempt, so hoist
 * async work and narrowed values out of it.
 *
 * A failure that survived retries carries a non-enumerable attempt count —
 * see `isRetriedError` / `RetriedDbError`.
 *
 * Errors that match no known protocol shape are **rethrown** (as a `Panic` in
 * `Result.gen` contexts) — they are not ours to label.
 */
const runDb = async <T>(
  query: PromiseLike<T> | (() => PromiseLike<T> | T),
  config: TryDbConfig<DbError> | undefined,
): Promise<Result<T, DbError>> => {
  const isPromiseForm = !isThunk(query) && !isBuilder(query);
  const retryConfig: RetryConfig<DbError> | undefined = config?.retry
    ? {
        signal: config.signal,
        retry: {
          ...config.retry,
          shouldRetry: config.retry.shouldRetry ?? ((e) => isRetrySafe(e)),
        },
      }
    : isPromiseForm || config?.retryTransient === false
      ? config?.signal
        ? { signal: config.signal }
        : undefined
      : { signal: config?.signal, retry: DEFAULT_RETRY };

  if (isPromiseForm && config?.retryTransient !== false) warnPromiseForm();

  let attempts = 0;
  const result = await Result.tryPromise(
    {
      try: () => {
        attempts += 1;
        return Promise.resolve(resolveQuery(query));
      },
      catch: (cause: unknown): DbError => withCause(classify(cause), cause),
    },
    retryConfig,
  );

  if (result.isErr() && attempts > 1) markRetried(result.error, attempts);
  return result;
};

/** A thunk (function) or a builder value (has `execute`), else a promise. */
const isThunk = (query: unknown): query is () => unknown => typeof query === "function";
const isBuilder = (query: unknown): boolean =>
  !!query && typeof (query as { execute?: unknown }).execute === "function";

/** Runs the query once: thunks are invoked, builders executed, promises
 * awaited as-is. A thunk's return value is the result — a builder returned
 * from a thunk is passed through untouched (the direct form is the typed
 * one). */
const resolveQuery = <T>(query: PromiseLike<T> | (() => PromiseLike<T> | T)): PromiseLike<T> | T =>
  isThunk(query)
    ? query()
    : isBuilder(query)
      ? (query as unknown as { execute: () => PromiseLike<T> }).execute()
      : query;

/**
 * Runs any database query and resolves the outcome as a `Result<T, DbError>`.
 *
 * The query's form decides both the error union and the retry policy:
 *   - `tryDb(db.select().from(users))` — a builder value: the lattice reads
 *     the builder's type (see `ShapeOfQuery` / `ShapeProven`) and narrows
 *     the union to what that shape provably cannot produce — a select
 *     excludes the constraint tags, a delete keeps only FK. Auto-retry
 *     re-executes the builder.
 *   - `tryDb(() => db.insert(...).returning())` — a promise-returning thunk:
 *     full union, auto-retry re-invokes the thunk. This is the form for
 *     one-shot calls (Prisma, raw SQL) that can't be re-executed.
 *   - `tryDb(somePromise)` — a settled promise: full union, no auto-retry
 *     (one-shot; a dev warning fires once).
 *
 * A builder that proves no shape fails to compile (fail-loud) — the lattice
 * never silently degrades to the full union.
 */
export function tryDb<F extends BuilderQuery>(
  query: F & ShapeProven<F>,
  config?: TryDbConfig<DbError>,
): Promise<Result<QueryResultOf<F>, ShapeUnion<DbError, DefaultLedger, F>>>;
export function tryDb<T>(
  query: QueryThunk<T>,
  config?: TryDbConfig<DbError>,
): Promise<Result<T, DbError>>;
export function tryDb<T>(
  query: PromiseLike<T>,
  config?: TryDbConfig<DbError>,
): Promise<Result<T, DbError>>;
export function tryDb<T>(query: any, config?: TryDbConfig<DbError>): Promise<Result<T, DbError>> {
  return runDb(query, config);
}

/**
 * Runs a whole transaction and resolves the outcome as a `Result<T, DbError>`.
 *
 * Classification-only: the thunk owns the transaction lifecycle — write your
 * own BEGIN…COMMIT, or call your ORM's transaction API (`db.transaction(...)`,
 * `prisma.$transaction(...)`, `db.transaction().execute(...)`) inside the
 * thunk. Retrying re-runs the WHOLE thunk, which starts a fresh transaction —
 * safe because a transaction that failed before COMMIT left nothing committed.
 * The one ambiguity is failure at COMMIT (connection died mid-COMMIT): did it
 * land? Those failures are never auto-retried — flagged `potentiallyTransient`
 * for a deliberate policy, exactly like mid-query loss in `tryDb`.
 *
 * The thunk form is required for retry to function (same rule as `tryDb`).
 */
export const tryTx = <T>(
  thunk: PromiseLike<T> | (() => PromiseLike<T> | T),
  config?: TryDbConfig<DbError>,
): Promise<Result<T, DbError>> => runDb(thunk, config);

/** Attaches the attempt count (non-enumerable) after a failure survived retries. */
const markRetried = (error: DbError, attempts: number): void => {
  try {
    Object.defineProperty(error, "retries", {
      value: attempts,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  } catch {
    // observability only; never fail over it.
  }
};

let warnedPromiseForm = false;
/** Dev-only, once-per-process warning: a settled promise can't re-run on retry. */
const warnPromiseForm = (): void => {
  if (warnedPromiseForm) return;
  if (typeof process === "undefined" || process.env.NODE_ENV === "production") return;
  warnedPromiseForm = true;
  console.warn(
    "[db-result] tryDb(promise): a settled promise can't re-run, so transient failures won't auto-retry. " +
      "Pass a thunk (tryDb(() => prisma.user.findMany(args))) to get retry, or set retryTransient: false to silence this.",
  );
};
