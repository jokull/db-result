/**
 * db-result — classify database failures into tagged errors, as better-result
 * Results.
 *
 * Driver-agnostic: reads the *protocol* error shape, not any ORM's. It walks
 * `Error.cause` chains (plus the payload slots Effect wrappers use) to reach
 * the driver's error, then recognizes the protocols:
 *
 *   1. PostgreSQL SQLSTATE   — `code: "23505"` (pg, postgres.js, Drizzle)
 *   2. SQLite code strings   — `code: "SQLITE_CONSTRAINT_UNIQUE"`,
 *      `extendedCode` (libsql), `errcode`/`rawCode` numbers (node:sqlite,
 *      wa-sqlite, libsql)
 *   3. SQLite message shapes — `"UNIQUE constraint failed: t.c"`, D1's
 *      `D1_ERROR: … (code 2067 SQLITE_CONSTRAINT_UNIQUE[2067])` prefix
 *   4. Connection layer      — Node system codes (`ECONNREFUSED`, TLS codes)
 *      and the pool/client bare messages (`"timeout exceeded when trying to
 *      connect"`, `"Connection terminated unexpectedly"`)
 *
 * Works at the driver-call level: pass any thenable or thunk
 * (`db.prepare(...).run()`, `client.query(...)`, `db.insert(...)`) and get a
 * `Result<T, DbError>` back. Constraint outcomes become tags a handler can
 * fold into its domain vocabulary — attempting the insert *is* the uniqueness
 * check, including under races.
 *
 * Classification is duck-typed but strictly guarded: only `^[0-9A-Z]{5}$`
 * codes count as SQLSTATE, only enumerated prefixes count as driver codes,
 * numeric errcodes only count with a SQLite signal present. An error that
 * matches **no** known protocol shape is rethrown, not tagged — `tryDb`
 * classifies database failures; a `TypeError` from your own callback is a
 * defect, not a `db/query-failure`. In `Result.gen`, rethrown errors surface
 * as better-result's `Panic`.
 *
 * The original failure stays attached as a non-enumerable `Error.cause` for
 * observability; only `{ constraint }` (and the transient hint) ever reaches
 * the tagged error's data. Strip `cause` before any wire boundary.
 *
 *   bun add better-result db-result
 *   bun test
 */

import { Result, TaggedError } from "better-result";

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

// ─── Vocabulary ──────────────────────────────────────────────────────────────

const transient = { potentiallyTransient: true } as const;

/**
 * Attaches an internal, non-enumerable "safe to auto-retry" flag. The public
 * `potentiallyTransient` hint says *retrying may help*; `retrySafe` says the
 * default policy may retry (deterministic and ambiguous-outcome errors never
 * get it).
 */
const mark = (error: DbError, retrySafe: boolean): DbError => {
  try {
    Object.defineProperty(error, "retrySafe", {
      value: retrySafe,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  } catch {
    // diagnostic only; never fail classification over it.
  }
  return error;
};

class UniqueViolation extends TaggedError("db/unique-violation")<{
  constraint: string;
  potentiallyTransient?: boolean;
}> {}
class ForeignKeyViolation extends TaggedError("db/foreign-key-violation")<{
  constraint: string;
  potentiallyTransient?: boolean;
}> {}
class NotNullViolation extends TaggedError("db/not-null-violation")<{
  constraint: string;
  potentiallyTransient?: boolean;
}> {}
class CheckViolation extends TaggedError("db/check-violation")<{
  constraint: string;
  potentiallyTransient?: boolean;
}> {}
class ConnectionFailure extends TaggedError("db/connection-failure")<{
  potentiallyTransient?: boolean;
}> {}
class AuthenticationFailed extends TaggedError("db/authentication-failed")<{
  potentiallyTransient?: boolean;
}> {}
class AuthorizationFailed extends TaggedError("db/authorization-failed")<{
  potentiallyTransient?: boolean;
}> {}
class SqlSyntaxError extends TaggedError("db/sql-syntax-error")<{
  potentiallyTransient?: boolean;
}> {}
class QueryFailure extends TaggedError("db/query-failure")<{
  potentiallyTransient?: boolean;
}> {}

export type DbError =
  | UniqueViolation
  | ForeignKeyViolation
  | NotNullViolation
  | CheckViolation
  | ConnectionFailure
  | AuthenticationFailed
  | AuthorizationFailed
  | SqlSyntaxError
  | QueryFailure;

// ─── Guards ──────────────────────────────────────────────────────────────────

const tagOf = (e: unknown): string | undefined => {
  if (typeof e !== "object" || e === null) return undefined;
  const tag = Reflect.get(e, "_tag");
  return typeof tag === "string" ? tag : undefined;
};

export const isUniqueViolation = (e: unknown): e is UniqueViolation =>
  tagOf(e) === "db/unique-violation";
export const isForeignKeyViolation = (e: unknown): e is ForeignKeyViolation =>
  tagOf(e) === "db/foreign-key-violation";
export const isNotNullViolation = (e: unknown): e is NotNullViolation =>
  tagOf(e) === "db/not-null-violation";
export const isCheckViolation = (e: unknown): e is CheckViolation =>
  tagOf(e) === "db/check-violation";
export const isConnectionFailure = (e: unknown): e is ConnectionFailure =>
  tagOf(e) === "db/connection-failure";
export const isAuthenticationFailed = (e: unknown): e is AuthenticationFailed =>
  tagOf(e) === "db/authentication-failed";
export const isAuthorizationFailed = (e: unknown): e is AuthorizationFailed =>
  tagOf(e) === "db/authorization-failed";
export const isSqlSyntaxError = (e: unknown): e is SqlSyntaxError =>
  tagOf(e) === "db/sql-syntax-error";
export const isQueryFailure = (e: unknown): e is QueryFailure => tagOf(e) === "db/query-failure";

// ─── Classification ──────────────────────────────────────────────────────────

const DEFAULT_CONSTRAINT = "unknown";
const MAX_HOPS = 16;
const SLOTS = ["cause", "failure", "error", "defect"] as const;

/** Only 5-char alphanumeric codes count as SQLSTATE. */
const SQLSTATE_RE = /^[0-9A-Z]{5}$/;

/** Connect-phase failures — the channel was never established; safe to retry. */
const SAFE_CONNECT_CODES = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNABORTED",
]);
/** Mid-query channel loss — the outcome is unknown; hint, not auto-retry. */
const AMBIGUOUS_CONNECT_CODES = new Set(["ECONNRESET", "EPIPE"]);
/** TLS/crypto failure codes — connection realm, but not transient (config). */
const TLS_CODES_RE =
  /^(DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_HAS_EXPIRED|ERR_TLS_CERT_ALTNAME_INVALID|ERR_TLS_PROTOCOL_VERSION|ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED)$/;

/** Message markers that say "this is SQLite", so numeric errcodes count. */
const SQLITE_MESSAGE_RE =
  /constraint failed|database is locked|table is locked|is not a database|disk image is malformed|attempt to write a readonly database|malformed|no such (table|column|function)|database or disk is full|out of memory/i;

const isString = (v: unknown): v is string => typeof v === "string";
const isNumber = (v: unknown): v is number => typeof v === "number";
const get = (obj: object, key: string): unknown => Reflect.get(obj, key);

/**
 * Constraint name, taken from the driver's own field when present, else from
 * the message text. Both stop at the constraint identifier and never run past
 * it — a looser match could capture whatever the driver or ORM appended
 * (including query parameters, which must never reach `data`).
 */
const constraintFrom = (node: object): string => {
  const field = get(node, "constraint");
  if (isString(field) && field.trim().length > 0) return field.trim();

  const message = get(node, "message");
  if (!isString(message)) return DEFAULT_CONSTRAINT;

  // SQLite: `UNIQUE constraint failed: table.column[, table.column …]`
  const sqlite = /constraint failed: ([\w]+(?:\.[\w]+)+)(?:,\s*[\w]+(?:\.[\w]+)+)*/i.exec(message);
  if (sqlite?.[1]) return sqlite[1].trim();
  // Postgres: `duplicate key value violates unique constraint "name"`
  const pg = /constraint "([^"]+)"/.exec(message);
  return pg?.[1]?.trim() ?? DEFAULT_CONSTRAINT;
};

const classifySQLSTATE = (code: string, constraint: string): DbError => {
  switch (code) {
    case "23505":
      return new UniqueViolation({ constraint }); // incl. primary key
    case "23503":
      return new ForeignKeyViolation({ constraint });
    case "23502":
      return new NotNullViolation({ constraint });
    case "23514":
      return new CheckViolation({ constraint });
    case "28P01":
    case "28000":
      return new AuthenticationFailed({});
    case "42501":
      return new AuthorizationFailed({}); // before the 42* catch-all
  }
  if (code.startsWith("08")) {
    // Connect-phase SQLSTATEs are safe to auto-retry; mid-query loss and state
    // bugs are ambiguous (the write may have committed) — hint, not retry.
    const safe = code === "08001" || code === "08004";
    const isTransient = code !== "08003";
    return mark(new ConnectionFailure(isTransient ? transient : {}), safe);
  }
  if (code.startsWith("23")) return new QueryFailure({});
  if (code.startsWith("42")) return new SqlSyntaxError({});
  // Transient set — the ones Effect's pg classifier misses (53300). Safe to
  // auto-retry: a failed statement / aborted transaction leaves nothing committed.
  if (
    code === "40001" ||
    code === "40P01" ||
    code === "55P03" ||
    code === "57014" ||
    code === "53300"
  ) {
    return mark(new QueryFailure(transient), true);
  }
  // Server shutting down — connection realm; only "starting up" is retry-safe.
  if (code === "57P01" || code === "57P02") return mark(new ConnectionFailure(transient), false);
  if (code === "57P03") return mark(new ConnectionFailure(transient), true);
  return new QueryFailure({});
};

const classifySqliteCodeString = (code: string, constraint: string): DbError | undefined => {
  if (
    code.startsWith("SQLITE_CONSTRAINT_UNIQUE") ||
    code.startsWith("SQLITE_CONSTRAINT_PRIMARYKEY")
  ) {
    return new UniqueViolation({ constraint });
  }
  if (code.startsWith("SQLITE_CONSTRAINT_FOREIGNKEY"))
    return new ForeignKeyViolation({ constraint });
  if (code.startsWith("SQLITE_CONSTRAINT_NOTNULL")) return new NotNullViolation({ constraint });
  if (code.startsWith("SQLITE_CONSTRAINT_CHECK")) return new CheckViolation({ constraint });
  if (code.startsWith("SQLITE_CONSTRAINT")) return new QueryFailure({});
  // BUSY/LOCKED are transient contention, not a tag — retry by policy.
  if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"))
    return mark(new QueryFailure(transient), true);
  // The authorizer denies *permissions*; SQLITE_AUTH is a permission signal.
  if (code.startsWith("SQLITE_PERM") || code.startsWith("SQLITE_AUTH"))
    return new AuthorizationFailed({});
  if (code.startsWith("SQLITE_CANTOPEN")) return new ConnectionFailure({});
  if (code.startsWith("SQLITE_")) return new QueryFailure({});
  // libsql client errors: network layer.
  if (code.startsWith("CLIENT_NETWORK")) return new ConnectionFailure(transient);
  return undefined;
};

const classifySqliteNumeric = (n: number, constraint: string): DbError | undefined => {
  // Exact extended codes — never mask & 0xff (that's how Effect loses
  // unique-vs-other specificity for node:sqlite's 2067).
  switch (n) {
    case 2067:
    case 1555:
      return new UniqueViolation({ constraint }); // unique, PK
    case 787:
      return new ForeignKeyViolation({ constraint });
    case 1299:
      return new NotNullViolation({ constraint });
    case 275:
      return new CheckViolation({ constraint });
    case 5:
    case 261:
    case 517:
    case 773:
    case 6:
      return mark(new QueryFailure(transient), true); // BUSY/LOCKED
    case 3:
    case 23:
      return new AuthorizationFailed({}); // PERM, AUTH
    case 14:
      return new ConnectionFailure({}); // CANTOPEN
    default:
      return new QueryFailure({});
  }
};

const classifyNodeCode = (code: string): DbError | undefined => {
  if (SAFE_CONNECT_CODES.has(code)) return mark(new ConnectionFailure(transient), true);
  if (AMBIGUOUS_CONNECT_CODES.has(code)) return mark(new ConnectionFailure(transient), false);
  if (TLS_CODES_RE.test(code)) return mark(new ConnectionFailure({}), false);
  return undefined;
};

/** SQLite / D1 message shapes, and the pg pool/client bare messages. */
const classifyMessage = (raw: string, constraint: string): DbError | undefined => {
  const message = raw.replace(/^D1_ERROR:\s*/i, "");

  // D1 appends the extended code: `(code 2067 SQLITE_CONSTRAINT_UNIQUE[2067])`
  const d1 = /(\(code (\d+) (SQLITE_[A-Z_]+))/i.exec(message);
  const d1Name = d1?.[3];
  if (d1Name) {
    const classified = classifySqliteCodeString(d1Name, constraint);
    if (classified) return classified;
  }

  if (
    /^UNIQUE constraint failed:/i.test(message) ||
    /^PRIMARY KEY constraint failed:/i.test(message)
  ) {
    return new UniqueViolation({ constraint });
  }
  if (/^FOREIGN KEY constraint failed/i.test(message))
    return new ForeignKeyViolation({ constraint });
  if (/^NOT NULL constraint failed:/i.test(message)) return new NotNullViolation({ constraint });
  if (/^CHECK constraint failed:/i.test(message)) return new CheckViolation({ constraint });
  if (/no such (table|column|function)/i.test(message)) return new SqlSyntaxError({});

  // Common SQLite failure messages that carry no code — clearly sqlite, no tag.
  if (
    /database or disk is full|disk image is malformed|file is not a database|attempt to write a readonly database|out of memory|disk I\/O error|unable to open database file/i.test(
      message,
    )
  ) {
    return new QueryFailure({});
  }

  // pg-pool / pg-client bare errors (no code property):
  if (/timeout exceeded when trying to connect/i.test(message))
    return mark(new ConnectionFailure(transient), true);
  if (/Connection terminated due to connection timeout/i.test(message))
    return mark(new ConnectionFailure(transient), true);
  if (/Connection terminated unexpectedly/i.test(message))
    return mark(new ConnectionFailure(transient), false);
  if (/^Connection terminated$/i.test(message.trim()))
    return mark(new ConnectionFailure({}), false);
  if (/Client was closed and is not queryable/i.test(message))
    return mark(new ConnectionFailure({}), false);
  if (/Client has encountered a connection error/i.test(message))
    return mark(new ConnectionFailure({}), false);

  return undefined;
};

type Classifiable = object;

/** True when a node carries a SQLite-ish signal, so numeric codes count. */
const hasSqliteSignal = (node: Classifiable): boolean => {
  const code = get(node, "code");
  const extended = get(node, "extendedCode");
  if (isString(code) && (code.startsWith("SQLITE") || code.startsWith("ERR_SQLITE"))) return true;
  if (isString(extended)) return true;
  const message = get(node, "message");
  return isString(message) && SQLITE_MESSAGE_RE.test(message);
};

const classifyNode = (node: Classifiable): DbError | undefined => {
  const code = get(node, "code");
  const message = get(node, "message");
  const constraint = constraintFrom(node);

  // 1. PostgreSQL SQLSTATE (strict 5-char shape)
  if (isString(code) && SQLSTATE_RE.test(code)) {
    return classifySQLSTATE(code, constraint);
  }

  // 2. SQLite code strings — libsql's specific `extendedCode` first, so a
  //    generic `SQLITE_ERROR` code never shadows it, then the `code` itself.
  const extendedCode = get(node, "extendedCode");
  const sqliteCode = isString(extendedCode)
    ? (extendedCode as string)
    : isString(code)
      ? code
      : undefined;
  if (sqliteCode) {
    const classified = classifySqliteCodeString(sqliteCode, constraint);
    if (classified) return classified;
  }

  // 3. SQLite numeric errcodes (wa-sqlite puts the number in `code`)
  const errcode = get(node, "errcode");
  const rawCode = get(node, "rawCode");
  const numeric = isNumber(errcode)
    ? errcode
    : isNumber(rawCode)
      ? rawCode
      : isNumber(code)
        ? code
        : undefined;
  if (numeric !== undefined && hasSqliteSignal(node)) {
    const classified = classifySqliteNumeric(numeric, constraint);
    if (classified) return classified;
  }

  // 4. Node system codes (connection layer) — never SQLSTATE-shaped
  if (isString(code)) {
    const classified = classifyNodeCode(code);
    if (classified) return classified;
  }

  // 5. Message shapes (SQLite/D1/pg-pool bare errors)
  if (isString(message)) {
    const classified = classifyMessage(message, constraint);
    if (classified) return classified;
  }

  return undefined;
};

/**
 * Classifies an unknown failure into a `DbError`, or — when no known protocol
 * shape matches — rethrows the original. `tryDb` classifies database
 * failures; anything else is not ours to label.
 */
const classify = (cause: unknown): DbError => {
  const pending: unknown[] = [cause];
  const visited = new Set<object>();

  for (let inspected = 0; inspected < MAX_HOPS && pending.length > 0; inspected += 1) {
    const current = pending.shift();
    if (typeof current !== "object" || current === null) continue;
    if (visited.has(current)) continue;
    visited.add(current);

    const classified = classifyNode(current);
    if (classified) return classified;

    pending.push(...SLOTS.map((slot) => get(current, slot)));
  }

  throw cause; // Variant B: not ours to label
};

// ─── tryDb ───────────────────────────────────────────────────────────────────

/** Attaches the original failure as a non-enumerable cause for observability. */
const withCause = (error: DbError, cause: unknown): DbError => {
  try {
    Object.defineProperty(error, "cause", {
      value: cause,
      enumerable: false,
      writable: true,
      configurable: true,
    });
  } catch {
    // cause is diagnostic only; never fail the classification over it.
  }
  return error;
};

/** Runs any database query and resolves the outcome as a thenable. */
const runDbQuery = <T>(query: PromiseLike<T> | (() => PromiseLike<T> | T)): PromiseLike<T> | T =>
  typeof query === "function" ? query() : query;

/** Internal: may this classified error be auto-retried by the default policy? */
const isRetrySafe = (error: DbError): boolean =>
  (error as DbError & { retrySafe?: boolean }).retrySafe === true;

/** Per-error retry delay — the "sensible defaults" behind retryTransient. */
const retryDelay = (error: DbError, ctx: TryPromiseContext): number => {
  const backoff = 2 ** (ctx.attempt - 1);
  if (isConnectionFailure(error)) return 200 * backoff; // reconnect, wait longer
  if (isQueryFailure(error)) return 50 * backoff; // deadlock / serialization / busy
  return 100 * backoff;
};

const DEFAULT_RETRY: RetryOptions<DbError> = {
  times: 3,
  delayMs: retryDelay,
  shouldRetry: (e) => isRetrySafe(e),
};

/**
 * Config for `tryDb`. An explicit `retry` always wins; without one, transient
 * failures are auto-retried (`retryTransient`, default `true`) with sensible
 * per-error defaults. Deterministic errors (constraints, auth, authz, syntax)
 * and ambiguous outcomes (connection lost mid-query) are never auto-retried.
 */
export type TryDbConfig<E> = {
  /** Auto-retry the transient set with per-error defaults. Default: `true`. */
  retryTransient?: boolean;
  /** Full retry policy override — you own `times`/`delayMs`/`shouldRetry`. */
  retry?: RetryOptions<E>;
  /** Abort signal forwarded to every attempt and retry delay. */
  signal?: AbortSignal;
};

/**
 * Runs any database query and resolves the outcome as a `Result<T, DbError>`.
 *
 * Built on better-result's `Result.tryPromise`. Transient failures retry by
 * default with per-error defaults; deterministic errors and ambiguous
 * mid-query outcomes never retry. Hand an explicit `retry` to own the policy
 * (a safe gate is injected unless you provide `shouldRetry`), or set
 * `retryTransient: false` to disable auto-retry entirely.
 *
 * Errors that match no known protocol shape are **rethrown** (as a `Panic` in
 * `Result.gen` contexts) — they are not ours to label.
 */
export const tryDb = async <T>(
  query: PromiseLike<T> | (() => PromiseLike<T> | T),
  config?: TryDbConfig<DbError>,
): Promise<Result<T, DbError>> => {
  const retryConfig: RetryConfig<DbError> | undefined = config?.retry
    ? {
        signal: config.signal,
        retry: {
          ...config.retry,
          shouldRetry: config.retry.shouldRetry ?? ((e) => isRetrySafe(e)),
        },
      }
    : config?.retryTransient === false
      ? config.signal
        ? { signal: config.signal }
        : undefined
      : { signal: config?.signal, retry: DEFAULT_RETRY };

  return Result.tryPromise(
    {
      try: () => Promise.resolve(runDbQuery(query)),
      catch: (cause: unknown): DbError => withCause(classify(cause), cause),
    },
    retryConfig,
  );
};
