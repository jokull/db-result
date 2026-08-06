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
class DataError extends TaggedError("db/data-error")<{
  potentiallyTransient?: boolean;
}> {}
class DeadlockError extends TaggedError("db/deadlock")<{
  potentiallyTransient?: boolean;
}> {}
class LockTimeoutError extends TaggedError("db/lock-timeout")<{
  potentiallyTransient?: boolean;
}> {}
class TransactionAborted extends TaggedError("db/transaction-aborted")<{
  potentiallyTransient?: boolean;
}> {}
class ConnectFailure extends TaggedError("db/connect-failure")<{
  potentiallyTransient?: boolean;
}> {}
class ConnectionLost extends TaggedError("db/connection-lost")<{
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
  | DataError
  | DeadlockError
  | LockTimeoutError
  | TransactionAborted
  | ConnectFailure
  | ConnectionLost
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
export const isDataError = (e: unknown): e is DataError => tagOf(e) === "db/data-error";
export const isDeadlock = (e: unknown): e is DeadlockError => tagOf(e) === "db/deadlock";
export const isLockTimeout = (e: unknown): e is LockTimeoutError => tagOf(e) === "db/lock-timeout";
export const isTransactionAborted = (e: unknown): e is TransactionAborted =>
  tagOf(e) === "db/transaction-aborted";
export const isConnectFailure = (e: unknown): e is ConnectFailure =>
  tagOf(e) === "db/connect-failure";
export const isConnectionLost = (e: unknown): e is ConnectionLost =>
  tagOf(e) === "db/connection-lost";

/** Family guard — either connection tag. `db/connect-failure` is a
 * connect-phase failure (safe to retry); `db/connection-lost` is ambiguous
 * mid-query loss (never auto-retried). */
export const isConnectionFailure = (e: unknown): e is ConnectFailure | ConnectionLost =>
  isConnectFailure(e) || isConnectionLost(e);
export const isAuthenticationFailed = (e: unknown): e is AuthenticationFailed =>
  tagOf(e) === "db/authentication-failed";
export const isAuthorizationFailed = (e: unknown): e is AuthorizationFailed =>
  tagOf(e) === "db/authorization-failed";
export const isSqlSyntaxError = (e: unknown): e is SqlSyntaxError =>
  tagOf(e) === "db/sql-syntax-error";
export const isQueryFailure = (e: unknown): e is QueryFailure => tagOf(e) === "db/query-failure";

/** True when `e` is any of the fourteen `DbError` tags — the boundary check. */
export const isDbError = (e: unknown): e is DbError =>
  isUniqueViolation(e) ||
  isForeignKeyViolation(e) ||
  isNotNullViolation(e) ||
  isCheckViolation(e) ||
  isDataError(e) ||
  isDeadlock(e) ||
  isLockTimeout(e) ||
  isTransactionAborted(e) ||
  isConnectFailure(e) ||
  isConnectionLost(e) ||
  isAuthenticationFailed(e) ||
  isAuthorizationFailed(e) ||
  isSqlSyntaxError(e) ||
  isQueryFailure(e);

/** A `DbError` that survived its retries — carries the attempt count. */
export type RetriedDbError = DbError & { retries: number };

/** True when the error went through ≥1 retry; `error.retries` is the attempt count. */
export const isRetriedError = (e: unknown): e is RetriedDbError =>
  typeof e === "object" && e !== null && typeof Reflect.get(e, "retries") === "number";

// ─── Classification ──────────────────────────────────────────────────────────

const DEFAULT_CONSTRAINT = "unknown";
const MAX_HOPS = 16;
const SLOTS = ["cause", "failure", "error", "defect", "originalError"] as const;

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

  // Prisma P-coded errors: `meta.target: ["email"]` / `meta.field_name`.
  const meta = get(node, "meta");
  if (meta !== null && typeof meta === "object") {
    const target = get(meta as object, "target");
    if (Array.isArray(target) && target.length > 0 && target.every((x) => typeof x === "string"))
      return (target as string[]).join(".");
    const fieldName = get(meta as object, "field_name");
    if (isString(fieldName) && fieldName.trim().length > 0) return fieldName.trim();
  }

  const message = get(node, "message");
  if (!isString(message)) return DEFAULT_CONSTRAINT;

  // SQLite: `UNIQUE constraint failed: table.column[, table.column …]`
  const sqlite = /constraint failed: ([\w]+(?:\.[\w]+)+)(?:,\s*[\w]+(?:\.[\w]+)+)*/i.exec(message);
  if (sqlite?.[1]) return sqlite[1].trim();
  // Postgres: `duplicate key value violates unique constraint "name"`
  const pg = /constraint "([^"]+)"/.exec(message);
  if (pg?.[1]) return pg[1].trim();
  // MySQL / vitess: `Duplicate entry 'x' for key 'name'`
  const mysql = /for key '([^']+)'/.exec(message);
  return mysql?.[1]?.trim() ?? DEFAULT_CONSTRAINT;
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
    // 08001/08004 — the channel never established: connect-phase, safe to
    // auto-retry. Every other 08* is mid-query loss: the outcome is unknown
    // (the write may have committed) — hint, never auto-retried.
    if (code === "08001" || code === "08004") return mark(new ConnectFailure(transient), true);
    if (code === "08003") return new ConnectionLost({}); // client holds no connection
    return mark(new ConnectionLost(transient), false);
  }
  if (code.startsWith("23")) return new QueryFailure({});
  if (code.startsWith("42")) return new SqlSyntaxError({});
  // Data exceptions — value too long / numeric overflow / invalid text input.
  // Deterministic: retrying bad input is theater.
  if (code === "22001" || code === "22003" || code === "22P02") return new DataError({});
  // Transaction aborted — the whole transaction is dead; roll back, don't
  // retry the statement. Retrying the transaction is tryTx's job.
  if (code === "25P02") return new TransactionAborted({});
  // Deadlock / serialization get the distinct tag; `40001` (serialization
  // failure) folds here — same caller decision (retry the whole transaction).
  // Split again when a second driver proves a distinct serialization signal.
  if (code === "40P01" || code === "40001") return mark(new DeadlockError(transient), true);
  if (code === "55P03") return mark(new LockTimeoutError(transient), true);
  // Statement-timeout / too-many-connections stay folded into query-failure —
  // a distinct statement-timeout tag is parked until a second driver earns it.
  if (code === "57014" || code === "53300") return mark(new QueryFailure(transient), true);
  // Server shutting down — connection realm; only "starting up" is retry-safe.
  if (code === "57P01" || code === "57P02") return mark(new ConnectionLost(transient), false);
  if (code === "57P03") return mark(new ConnectFailure(transient), true);
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
  // BUSY/LOCKED are lock contention — the lock-timeout tag, retryable.
  if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"))
    return mark(new LockTimeoutError(transient), true);
  // The authorizer denies *permissions*; SQLITE_AUTH is a permission signal.
  if (code.startsWith("SQLITE_PERM") || code.startsWith("SQLITE_AUTH"))
    return new AuthorizationFailed({});
  if (code.startsWith("SQLITE_CANTOPEN")) return new ConnectFailure({});
  if (code.startsWith("SQLITE_")) return new QueryFailure({});
  // libsql client errors: network layer — connect or mid-query, ambiguous.
  if (code.startsWith("CLIENT_NETWORK")) return new ConnectionLost(transient);
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
      return mark(new LockTimeoutError(transient), true); // BUSY/LOCKED
    case 3:
    case 23:
      return new AuthorizationFailed({}); // PERM, AUTH
    case 14:
      return new ConnectFailure({}); // CANTOPEN
    default:
      return new QueryFailure({});
  }
};

const classifyNodeCode = (code: string): DbError | undefined => {
  if (SAFE_CONNECT_CODES.has(code)) return mark(new ConnectFailure(transient), true);
  if (AMBIGUOUS_CONNECT_CODES.has(code)) return mark(new ConnectionLost(transient), false);
  if (TLS_CODES_RE.test(code)) return mark(new ConnectFailure({}), false);
  return undefined;
};

/**
 * mysql2 protocol — stable `code: "ER_*"` strings first, `errno` fallback.
 * Deterministic constraint/parse/auth errors are never retried; deadlock
 * (`1213`) and lock-wait-timeout (`1205`) are transient contention.
 */
const classifyMysql = (
  code: unknown,
  errno: number | undefined,
  constraint: string,
): DbError | undefined => {
  const match = (prefixes: string[], numbers: number[]): boolean =>
    (isString(code) && prefixes.some((p) => code.startsWith(p))) ||
    (errno !== undefined && numbers.includes(errno));
  if (match(["ER_DUP_ENTRY"], [1062])) return new UniqueViolation({ constraint });
  if (match(["ER_NO_REFERENCED_ROW_2", "ER_ROW_IS_REFERENCED_2"], [1451, 1452]))
    return new ForeignKeyViolation({ constraint });
  if (match(["ER_BAD_NULL_ERROR"], [1048])) return new NotNullViolation({ constraint });
  if (match(["ER_CHECK_CONSTRAINT_VIOLATED"], [3819])) return new CheckViolation({ constraint });
  if (match(["ER_LOCK_DEADLOCK"], [1213])) return mark(new DeadlockError(transient), true);
  if (match(["ER_LOCK_WAIT_TIMEOUT"], [1205])) return mark(new LockTimeoutError(transient), true);
  if (match(["ER_ACCESS_DENIED_ERROR"], [1045])) return new AuthenticationFailed({});
  if (match(["ER_TABLEACCESS_DENIED_ERROR", "ER_COLUMNACCESS_DENIED_ERROR"], [1142, 1143]))
    return new AuthorizationFailed({});
  if (match(["ER_PARSE_ERROR"], [1064])) return new SqlSyntaxError({});
  if (
    match(
      ["ER_DATA_TOO_LONG", "ER_WARN_DATA_OUT_OF_RANGE", "ER_TRUNCATED_WRONG_VALUE"],
      [1406, 1264, 1366],
    )
  )
    return new DataError({});
  return new QueryFailure({});
};

/**
 * mssql protocol — tedious's positive integer `number` field. Deadlock
 * (`1205`) and lock-request-timeout (`1222`) are transient; `1205` is the
 * "deadlock victim" signal, hence the deadlock tag. `547` is shared by FK and
 * CHECK conflicts — the message tells them apart. Login failures carry no
 * number at all: code `ELOGIN`, mapped in `classifyNode`.
 */
const classifyMssql = (n: number, message: string, constraint: string): DbError | undefined => {
  switch (n) {
    case 2627:
    case 2601:
      return new UniqueViolation({ constraint });
    case 547:
      return /CHECK constraint/i.test(message)
        ? new CheckViolation({ constraint })
        : new ForeignKeyViolation({ constraint });
    case 515:
      return new NotNullViolation({ constraint });
    case 1205:
      return mark(new DeadlockError(transient), true);
    case 1222:
      return mark(new LockTimeoutError(transient), true);
    case 18456:
      return new AuthenticationFailed({});
    case 102:
    case 207:
    case 208:
      return new SqlSyntaxError({});
    case 8115:
    case 245:
    case 220:
      return new DataError({});
    default:
      return new QueryFailure({});
  }
};

/** Prisma engine P-codes: exactly `P` + four digits. */
const PRISMA_CODE_RE = /^P\d{4}$/;

/**
 * Prisma protocol — engine P-codes are ORM-level (same codes over any
 * driver), so they classify structurally: `code: "P2002"` + `clientVersion`.
 * The classic engine path strips the driver cause; `meta` carries the fields.
 */
const classifyPrisma = (code: string, constraint: string): DbError => {
  switch (code) {
    case "P2002":
      return new UniqueViolation({ constraint });
    case "P2003":
      return new ForeignKeyViolation({ constraint });
    // P2034 — write conflict / deadlock; Prisma's own message says to retry.
    case "P2034":
      return mark(new DeadlockError(transient), true);
    // P2028 — interactive transaction closed / unusable; the tx is dead.
    case "P2028":
      return new TransactionAborted({});
    // Connect-phase: reach / pool / timeout — the channel never established,
    // safe to auto-retry. `P1003` (database missing) is deterministic.
    case "P1001":
    case "P1002":
    case "P1008":
    case "P2024":
    case "P2037":
      return mark(new ConnectFailure(transient), true);
    case "P1003":
    case "P1011": // TLS error — deterministic
    case "P1013": // invalid connection string — deterministic
      return mark(new ConnectFailure({}), false);
    // P1017 — server closed the connection: ambiguous mid-query loss.
    case "P1017":
      return mark(new ConnectionLost(transient), false);
    case "P1000":
      return new AuthenticationFailed({});
    case "P1010":
      return new AuthorizationFailed({});
    // P2025 (record required but not found) is a not-found semantic — the
    // caller's domain — so it folds into the generic failure, not a tag.
    default:
      return new QueryFailure({});
  }
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
    return mark(new ConnectFailure(transient), true);
  if (/Connection terminated due to connection timeout/i.test(message))
    return mark(new ConnectFailure(transient), true);
  if (/Connection terminated unexpectedly/i.test(message))
    return mark(new ConnectionLost(transient), false);
  if (/^Connection terminated$/i.test(message.trim())) return new ConnectionLost({});
  if (/Client was closed and is not queryable/i.test(message)) return new ConnectionLost({});
  if (/Client has encountered a connection error/i.test(message)) return new ConnectionLost({});

  // PostgreSQL message shapes — for paths that strip the SQLSTATE code:
  // aws-data-api (RDS Data API), xata-http, netlify-db, pg-proxy. The
  // constraint name is pulled from `constraint "…"` by `constraintFrom`.
  if (/duplicate key value violates unique constraint/i.test(message))
    return new UniqueViolation({ constraint });
  if (/violates foreign key constraint/i.test(message))
    return new ForeignKeyViolation({ constraint });
  if (/null value in column .* violates not-null constraint/i.test(message))
    return new NotNullViolation({ constraint });
  if (/violates check constraint/i.test(message)) return new CheckViolation({ constraint });
  if (/password authentication failed/i.test(message)) return new AuthenticationFailed({});
  if (/permission denied/i.test(message)) return new AuthorizationFailed({});
  if (/syntax error at or near/i.test(message)) return new SqlSyntaxError({});
  if (/(relation|column|schema|function) ".*" does not exist/i.test(message))
    return new SqlSyntaxError({}); // 42P01/42703 fold here too

  // MySQL message shapes — for vitess/TiDB/proxy paths without `ER_*` codes
  // (planetscale-serverless, tidb-serverless, mysql-proxy, aws-data-api).
  if (/^Duplicate entry '.*' for key '.*'/i.test(message))
    return new UniqueViolation({ constraint });
  if (/Cannot add or update a child row|Cannot delete or update a parent row/i.test(message))
    return new ForeignKeyViolation({ constraint });
  if (/Column '.*' cannot be null/i.test(message)) return new NotNullViolation({ constraint });
  if (/Check constraint violated/i.test(message)) return new CheckViolation({ constraint });
  if (/^Access denied for user/i.test(message)) return new AuthenticationFailed({});
  if (/You have an error in your SQL syntax/i.test(message)) return new SqlSyntaxError({});
  if (/Table '.*' doesn't exist|Unknown column '.*' in/i.test(message))
    return new SqlSyntaxError({}); // 42P01/42703 equivalents

  // Turso Database (Rust engine, `drizzle-orm/tursodatabase*`): the JS
  // binding surfaces message-only errors. MVCC write-write conflicts arrive
  // as SQLITE_BUSY-compatible text — transient contention, whole-tx retry
  // via tryTx (the conflict aborted the transaction; statement retry is
  // futile, which the tx-shape's retry-off already assumes).
  if (/write-write conflict|database snapshot is stale/i.test(message))
    return mark(new LockTimeoutError(transient), true);
  if (/^database is locked$/i.test(message.trim()))
    return mark(new LockTimeoutError(transient), true);

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

  // 0. Prisma protocol — engine P-codes (`code: "P2002"` + `clientVersion`).
  //    Structurally most specific: `P` + four digits also matches the SQLSTATE
  //    shape, so this must run before the SQLSTATE branch.
  if (isString(code) && PRISMA_CODE_RE.test(code) && isString(get(node, "clientVersion"))) {
    return classifyPrisma(code, constraint);
  }

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

  // 4. mysql2 protocol — `code: "ER_*"` or `errno` + SQLSTATE `sqlState`.
  const sqlState = get(node, "sqlState");
  const errno = get(node, "errno");
  if (
    (isString(code) && code.startsWith("ER_")) ||
    (isNumber(errno) && isString(sqlState) && SQLSTATE_RE.test(sqlState))
  ) {
    const classified = classifyMysql(code, isNumber(errno) ? errno : undefined, constraint);
    if (classified) return classified;
  }

  // 5. mssql protocol — tedious's positive integer `number` field; login
  //    failures carry the code `ELOGIN` instead of a number.
  const mssqlNumber = get(node, "number");
  if (code === "ELOGIN") return new AuthenticationFailed({});
  if (isNumber(mssqlNumber) && mssqlNumber > 0) {
    const classified = classifyMssql(mssqlNumber, isString(message) ? message : "", constraint);
    if (classified) return classified;
  }

  // 6. Node system codes (connection layer) — never SQLSTATE-shaped
  if (isString(code)) {
    const classified = classifyNodeCode(code);
    if (classified) return classified;
  }

  // 7. Message shapes (SQLite/D1/pg-pool bare errors)
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
  if (isQueryFailure(error) || isDeadlock(error) || isLockTimeout(error)) return 50 * backoff;
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

// ─── Type-level shape lattice ────────────────────────────────────────────────

/**
 * Duck-typed probe: is a thunk parameter a transaction client, across every
 * ORM with zero imports? Each branch is that ORM's own marker, probed
 * structurally:
 *
 *   - Kysely  — `isTransaction: true` (the literal getter on `Transaction<DB>`)
 *   - Drizzle — `rollback(): never` member on `PgAsyncTransaction`
 *   - Prisma  — raw-query surface (`$queryRaw`) minus `$transaction` (its
 *     `TransactionClient` is an `Omit` of the client — detected by absence)
 *
 * A parameter matching none of these is treated as a query client.
 */
export type IsTxParam<T> = T extends { isTransaction: true }
  ? true
  : T extends { rollback(): never }
    ? true
    : "$queryRaw" extends keyof T
      ? "$transaction" extends keyof T
        ? false
        : true
      : false;

/** `any` proves nothing — guards the lattice against untyped parameters. */
type IsAny<T> = 0 extends 1 & T ? true : false;

/** `never` proves nothing — an unannotated parameter is contextually typed
 * `never` from the overload constraint, so it must fail loudly too. */
type IsNever<T> = [T] extends [never] ? true : false;

/** Kysely `SelectQueryBuilder` — literal brand, exact for selects. */
export type IsSelectBuilder<T> = "isSelectQueryBuilder" extends keyof T ? true : false;

/** Kysely `Kysely<DB>` pool/connection client — `isTransaction: boolean`
 * accessor (the literal `true` was already claimed by `IsTxParam`). */
export type IsPoolClient<T> = "isTransaction" extends keyof T ? true : false;

/** Drizzle select — the select-only clause surface. `limit` is deliberately
 * absent: it is shared with the delete builder, so it is not evidence. */
export type IsDrizzleSelect<T> = "groupBy" extends keyof T
  ? true
  : "having" extends keyof T
    ? true
    : "offset" extends keyof T
      ? true
      : "union" extends keyof T
        ? true
        : "intersect" extends keyof T
          ? true
          : "except" extends keyof T
            ? true
            : "for" extends keyof T
              ? true
              : false;

/** Insert builders — `values()` (Kysely Insert, Drizzle `PgInsertBuilder`),
 * or the on-conflict surface that only the post-`values` Drizzle insert
 * carries (`PgInsertBase` / `PgInsert`). */
export type IsInsertBuilder<T> = "values" extends keyof T
  ? true
  : "onConflictDoUpdate" extends keyof T
    ? true
    : "onConflictDoNothing" extends keyof T
      ? true
      : false;

/** Update builders — `set()` (Kysely Update, Drizzle `PgUpdateBuilder`), or
 * `from()` — the Drizzle post-`set` update (`PgUpdateBase`/`PgUpdate`). The
 * select probe already claimed `PgSelect` (which also has `from`), so a
 * bare `from` here is a write. */
export type IsUpdateBuilder<T> = "set" extends keyof T
  ? true
  : "from" extends keyof T
    ? true
    : false;

/** Delete builders and Prisma where-only args — `where()`/`where`, once
 * `values`/`set`/`from` and the Prisma write/read probes are ruled out by
 * the pipeline order. Honest for the whole Prisma where-only family: reads
 * (findUnique/findFirst) and deletes (delete/deleteMany) can neither raise
 * unique/not-null/check (constraints are write-only) nor FK except deletes —
 * so `Fk` stays in the union while the other constraints go. `RawBuilder`
 * and Kysely `MergeQueryBuilder` (which can raise constraints via
 * `thenInsert`) have no `where` → fall to opaque. */
export type IsDeleteBuilder<T> = "where" extends keyof T ? true : false;

/** Prisma write args — `data` (create/update/createMany/updateMany args) or
 * `create`+`update` (upsert args). `data` is write-exclusive in Prisma's
 * args surface. */
export type IsPrismaWriteArgs<T> = "data" extends keyof T
  ? true
  : "create" extends keyof T
    ? "update" extends keyof T
      ? true
      : false
    : false;

/** Prisma read args — keys only reads carry (findMany `take`/`skip`/…,
 * groupBy `by`, aggregate `_count`/…). `orderBy` is deliberately absent
 * (Kysely's delete builder has it). `{ where }`-only args don't match — the
 * delete probe claims them (honestly: reads and deletes share the shape and
 * neither can raise the non-FK constraints). */
export type IsPrismaReadArgs<T> = "take" extends keyof T
  ? true
  : "skip" extends keyof T
    ? true
    : "cursor" extends keyof T
      ? true
      : "distinct" extends keyof T
        ? true
        : "by" extends keyof T
          ? true
          : "_count" extends keyof T
            ? true
            : "_avg" extends keyof T
              ? true
              : "_sum" extends keyof T
                ? true
                : "_min" extends keyof T
                  ? true
                  : "_max" extends keyof T
                    ? true
                    : false;

/** Every shape the lattice can prove. */
export type DbShape = "transaction" | "pool" | "read" | "write" | "delete" | "opaque";

/**
 * The shape a parameter proves, in lattice order (most specific first). A
 * probe firing is structural evidence the ORM emitted; a non-match falls
 * through to the next. `any`/unknown prove nothing — `"opaque"` — which the
 * caller turns into a compile error (fail-loud), never a silent full union.
 *
 * Order notes: the Prisma write/read probes run before the delete probe
 * because update/upsert/findMany args all carry `where`; the delete probe's
 * `where` is only honest once they are claimed. The update probe's `from`
 * is only honest after the select probe claimed Drizzle `PgSelect` (which
 * also has `from`).
 */
export type ShapeOfParam<T> =
  IsAny<T> extends true
    ? "opaque"
    : IsNever<T> extends true
      ? "opaque"
      : IsTxParam<T> extends true
        ? "transaction"
        : IsSelectBuilder<T> extends true
          ? "read"
          : IsPoolClient<T> extends true
            ? "pool"
            : IsDrizzleSelect<T> extends true
              ? "read"
              : IsInsertBuilder<T> extends true
                ? "write"
                : IsUpdateBuilder<T> extends true
                  ? "write"
                  : IsPrismaWriteArgs<T> extends true
                    ? "write"
                    : IsPrismaReadArgs<T> extends true
                      ? "read"
                      : IsDeleteBuilder<T> extends true
                        ? "delete"
                        : "opaque";

type ParamOf<F> = F extends (arg: infer P) => any ? P : never;

/** The shape a thunk's parameter proves — `"opaque"` when it proves nothing. */
export type ShapeOf<F> = ShapeOfParam<ParamOf<F>>;

/**
 * The exclusion ledger — the "no lying types" contract. Each key lists the
 * tags that shape provably cannot produce **on this driver**, with the reason
 * inline. A tag stays in the union unless a shape proves it impossible; the
 * runtime classifier is never affected (narrowing is type-level only).
 * Drivers override entries where their protocol differs — see
 * `db-result/sqlite`, which keeps `connect-failure` inside transactions
 * (`ATTACH DATABASE` can still fire CANTOPEN mid-query).
 */
export interface ShapeLedger {
  /** The callback runs after acquire + BEGIN: authn already succeeded and the
   * channel is established. `transaction-aborted` stays (it can happen). */
  transaction: DbError;
  /** A fresh pool connection is never in an aborted-transaction state. */
  pool: DbError;
  /** Pure reads cannot raise constraints. Footgun: "reads that write" (DML
   * CTEs, volatile functions, INSTEAD-OF triggers) CAN — the runtime still
   * classifies them correctly, the tag just falls to the fold terminal; use
   * the zero-arg form for reads-with-writes. `transaction-aborted` is
   * impossible without a transaction. */
  read: DbError;
  /** Writes can raise every constraint; only transaction-state is excluded. */
  write: DbError;
  /** A DELETE can only FK-fail among the constraints. */
  delete: DbError;
}

/** The ledger every driver starts from. */
export interface DefaultLedger extends ShapeLedger {
  transaction: AuthenticationFailed | ConnectFailure;
  pool: TransactionAborted;
  read:
    | UniqueViolation
    | ForeignKeyViolation
    | NotNullViolation
    | CheckViolation
    | TransactionAborted;
  write: TransactionAborted;
  delete: UniqueViolation | NotNullViolation | CheckViolation | TransactionAborted;
}

/** Tags a shape excludes, per the ledger. `"opaque"` excludes nothing. */
export type ShapeExclusions<L extends ShapeLedger, S extends DbShape> = S extends "transaction"
  ? L["transaction"]
  : S extends "pool"
    ? L["pool"]
    : S extends "read"
      ? L["read"]
      : S extends "write"
        ? L["write"]
        : S extends "delete"
          ? L["delete"]
          : never;

/** The driver union `E` narrowed by what the thunk's shape provably cannot do. */
export type ShapeUnion<E extends DbError, L extends ShapeLedger, F> = Exclude<
  E,
  ShapeExclusions<L, ShapeOf<F>>
>;

/** A thunk whose parameter proves a shape — else `never` (fail-loud). */
type ShapeProven<F> = ShapeOf<F> extends "opaque" ? never : F;

/** Query-shaped thunk — no parameters. */
export type QueryThunk<T> = () => PromiseLike<T> | T;
/**
 * One-parameter thunk — the parameter is a type-level shape signal ONLY:
 * `tryDb` never passes an argument (it is `undefined` at runtime), so the
 * declared parameter type is what the shape lattice reads. Close over the
 * real client/builder in the thunk body.
 */
export type ParamThunk<T> = (arg: never) => PromiseLike<T> | T;

/**
 * The `tryDb` surface bound to a narrowed error union `E` and a shape ledger
 * `L`. The param-shaped overload comes first (arity variance): a thunk whose
 * parameter proves a shape — a transaction client, an ORM query builder, or
 * Prisma args — resolves to the shape-narrowed union. A one-arg thunk whose
 * parameter proves nothing fails to compile (fail-loud): the lattice never
 * silently degrades to the full union. Zero-arg thunks, promises and values
 * are query-shaped: full union, transient retry on.
 */
export interface TryDbFor<E extends DbError, L extends ShapeLedger = DefaultLedger> {
  <T, F extends ParamThunk<T>>(
    query: F & ShapeProven<F>,
    config?: TryDbConfig<E>,
  ): Promise<Result<T, ShapeUnion<E, L, F>>>;
  <T>(query: QueryThunk<T> | PromiseLike<T> | T, config?: TryDbConfig<E>): Promise<Result<T, E>>;
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
 * `txForm` — the thunk declared a parameter: it's an in-transaction statement,
 * so statement-level auto-retry is off (retrying inside an aborted transaction
 * fights `25P02`); an explicit `retry` still wins.
 *
 * The thunk form is required for retry to function: a settled promise can't
 * re-run, so `tryDb(promise)` retries the same outcome forever (a dev-mode
 * warning fires once). Keep the thunk to the SQL statement — it runs once per
 * attempt, so hoist async work and narrowed values out of it.
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
  txForm: boolean,
): Promise<Result<T, DbError>> => {
  const retryConfig: RetryConfig<DbError> | undefined = config?.retry
    ? {
        signal: config.signal,
        retry: {
          ...config.retry,
          shouldRetry: config.retry.shouldRetry ?? ((e) => isRetrySafe(e)),
        },
      }
    : txForm || config?.retryTransient === false
      ? config?.signal
        ? { signal: config.signal }
        : undefined
      : { signal: config?.signal, retry: DEFAULT_RETRY };

  if (typeof query !== "function" && retryConfig?.retry) warnPromiseForm();

  let attempts = 0;
  const result = await Result.tryPromise(
    {
      try: () => {
        attempts += 1;
        return Promise.resolve(runDbQuery(query));
      },
      catch: (cause: unknown): DbError => withCause(classify(cause), cause),
    },
    retryConfig,
  );

  if (result.isErr() && attempts > 1) markRetried(result.error, attempts);
  return result;
};

/**
 * Runs any database query and resolves the outcome as a `Result<T, DbError>`.
 *
 * The thunk's parameter decides both the error union and the retry policy:
 *   - `tryDb(() => db.insert(...).returning())` — zero-arg: the full driver
 *     union, transient failures auto-retry.
 *   - `tryDb((q) => ...)` — one-arg: the parameter's TYPE is the shape signal
 *     (see `ShapeOf` / `ShapeProven`). A transaction client (Kysely
 *     `Transaction`, Drizzle `PgAsyncTransaction`, Prisma `TransactionClient`)
 *     narrows the union to the connection-bound set and disables statement
 *     auto-retry (a dead transaction can't be revived by re-running one
 *     statement). An ORM query builder or Prisma args type narrows the union
 *     to what that shape provably cannot produce — a select excludes the
 *     constraint tags, a delete keeps only FK, and so on. A one-arg thunk
 *     whose parameter proves nothing fails to compile (fail-loud).
 *
 * Declaring a parameter disables statement auto-retry at runtime (the arity
 * is the only runtime signal); an explicit `retry` still wins.
 */
export function tryDb<T, F extends ParamThunk<T>>(
  query: F & ShapeProven<F>,
  config?: TryDbConfig<DbError>,
): Promise<Result<T, ShapeUnion<DbError, DefaultLedger, F>>>;
export function tryDb<T>(
  query: QueryThunk<T> | PromiseLike<T> | T,
  config?: TryDbConfig<DbError>,
): Promise<Result<T, DbError>>;
export function tryDb<T>(query: any, config?: TryDbConfig<DbError>): Promise<Result<T, DbError>> {
  const txForm = typeof query === "function" && query.length > 0;
  return runDb(query, config, txForm);
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
): Promise<Result<T, DbError>> => runDb(thunk, config, false);

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
    "[db-result] tryDb(promise): retries can't re-invoke a settled promise — the same outcome fails every attempt. " +
      "Pass a thunk: tryDb(() => db.insert(...).returning()) so retries re-run the query.",
  );
};

/**
 * The tag classes, exported as types so per-driver entry points can build
 * narrowed unions with `Exclude<DbError, …>`. The runtime surface stays the
 * guards (`isUniqueViolation`, …) — construct errors via `tryDb`, never by
 * instantiating these.
 */
export type {
  UniqueViolation,
  ForeignKeyViolation,
  NotNullViolation,
  CheckViolation,
  DataError,
  DeadlockError,
  LockTimeoutError,
  TransactionAborted,
  ConnectFailure,
  ConnectionLost,
  AuthenticationFailed,
  AuthorizationFailed,
  SqlSyntaxError,
  QueryFailure,
};
