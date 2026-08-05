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
export const isQueryFailure = (e: unknown): e is QueryFailure =>
  tagOf(e) === "db/query-failure";

// ─── Classification ──────────────────────────────────────────────────────────

const DEFAULT_CONSTRAINT = "unknown";
const MAX_HOPS = 16;
const SLOTS = ["cause", "failure", "error", "defect"] as const;

/** Only 5-char alphanumeric codes count as SQLSTATE. */
const SQLSTATE_RE = /^[0-9A-Z]{5}$/;

/** Node system-error codes that mean the connection layer failed. */
const CONNECTION_CODES_RE =
  /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EHOSTDOWN|EPIPE|ECONNABORTED|EPROTO)$/;
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
  const sqlite =
    /constraint failed: ([\w]+(?:\.[\w]+)+)(?:,\s*[\w]+(?:\.[\w]+)+)*/i.exec(message);
  if (sqlite?.[1]) return sqlite[1].trim();
  // Postgres: `duplicate key value violates unique constraint "name"`
  const pg = /constraint "([^"]+)"/.exec(message);
  return pg?.[1]?.trim() ?? DEFAULT_CONSTRAINT;
};

const classifySQLSTATE = (code: string, constraint: string): DbError => {
  switch (code) {
    case "23505": return new UniqueViolation({ constraint }); // incl. primary key
    case "23503": return new ForeignKeyViolation({ constraint });
    case "23502": return new NotNullViolation({ constraint });
    case "23514": return new CheckViolation({ constraint });
    case "28P01": case "28000": return new AuthenticationFailed({});
    case "42501": return new AuthorizationFailed({}); // before the 42* catch-all
  }
  if (code.startsWith("08")) return new ConnectionFailure(transient);
  if (code.startsWith("23")) return new QueryFailure({});
  if (code.startsWith("42")) return new SqlSyntaxError({});
  // Transient set — the ones Effect's pg classifier misses (53300).
  if (code === "40001" || code === "40P01" || code === "55P03" || code === "57014" || code === "53300") {
    return new QueryFailure(transient);
  }
  return new QueryFailure({});
};

const classifySqliteCodeString = (code: string, constraint: string): DbError | undefined => {
  if (code.startsWith("SQLITE_CONSTRAINT_UNIQUE") || code.startsWith("SQLITE_CONSTRAINT_PRIMARYKEY")) {
    return new UniqueViolation({ constraint });
  }
  if (code.startsWith("SQLITE_CONSTRAINT_FOREIGNKEY")) return new ForeignKeyViolation({ constraint });
  if (code.startsWith("SQLITE_CONSTRAINT_NOTNULL")) return new NotNullViolation({ constraint });
  if (code.startsWith("SQLITE_CONSTRAINT_CHECK")) return new CheckViolation({ constraint });
  if (code.startsWith("SQLITE_CONSTRAINT")) return new QueryFailure({});
  // BUSY/LOCKED are transient contention, not a tag — retry by policy.
  if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")) return new QueryFailure(transient);
  // The authorizer denies *permissions*; SQLITE_AUTH is a permission signal.
  if (code.startsWith("SQLITE_PERM") || code.startsWith("SQLITE_AUTH")) return new AuthorizationFailed({});
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
    case 2067: case 1555: return new UniqueViolation({ constraint }); // unique, PK
    case 787: return new ForeignKeyViolation({ constraint });
    case 1299: return new NotNullViolation({ constraint });
    case 275: return new CheckViolation({ constraint });
    case 5: case 261: case 517: case 773: case 6: return new QueryFailure(transient); // BUSY/LOCKED
    case 3: case 23: return new AuthorizationFailed({}); // PERM, AUTH
    case 14: return new ConnectionFailure({}); // CANTOPEN
    default: return new QueryFailure({});
  }
};

const classifyNodeCode = (code: string): DbError | undefined => {
  if (CONNECTION_CODES_RE.test(code)) return new ConnectionFailure(transient);
  if (TLS_CODES_RE.test(code)) return new ConnectionFailure({});
  return undefined;
};

/** SQLite / D1 message shapes, and the pg pool/client bare messages. */
const classifyMessage = (raw: string, constraint: string): DbError | undefined => {
  const message = raw.replace(/^D1_ERROR:\s*/i, "");

  // D1 appends the extended code: `(code 2067 SQLITE_CONSTRAINT_UNIQUE[2067])`
  const d1 = /\(code (\d+) (SQLITE_[A-Z_]+)/i.exec(message);
  if (d1) {
    const classified = classifySqliteCodeString(d1[2], constraint);
    if (classified) return classified;
  }

  if (/^UNIQUE constraint failed:/i.test(message) || /^PRIMARY KEY constraint failed:/i.test(message)) {
    return new UniqueViolation({ constraint });
  }
  if (/^FOREIGN KEY constraint failed/i.test(message)) return new ForeignKeyViolation({ constraint });
  if (/^NOT NULL constraint failed:/i.test(message)) return new NotNullViolation({ constraint });
  if (/^CHECK constraint failed:/i.test(message)) return new CheckViolation({ constraint });
  if (/no such (table|column|function)/i.test(message)) return new SqlSyntaxError({});

  // Common SQLite failure messages that carry no code — clearly sqlite, no tag.
  if (
    /database or disk is full|disk image is malformed|file is not a database|attempt to write a readonly database|out of memory|disk I\/O error|unable to open database file/i.test(message)
  ) {
    return new QueryFailure({});
  }

  // pg-pool / pg-client bare errors (no code property):
  if (/timeout exceeded when trying to connect/i.test(message)) return new ConnectionFailure(transient);
  if (/Connection terminated unexpectedly/i.test(message)) return new ConnectionFailure(transient);
  if (/Connection terminated due to connection timeout/i.test(message)) return new ConnectionFailure(transient);
  if (/^Connection terminated$/i.test(message.trim())) return new ConnectionFailure(transient);
  if (/Client was closed and is not queryable/i.test(message)) return new ConnectionFailure({});
  if (/Client has encountered a connection error/i.test(message)) return new ConnectionFailure({});

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
  const sqliteCode = isString(extendedCode) ? (extendedCode as string) : isString(code) ? code : undefined;
  if (sqliteCode) {
    const classified = classifySqliteCodeString(sqliteCode, constraint);
    if (classified) return classified;
  }

  // 3. SQLite numeric errcodes (wa-sqlite puts the number in `code`)
  const errcode = get(node, "errcode");
  const rawCode = get(node, "rawCode");
  const numeric = isNumber(errcode) ? errcode : isNumber(rawCode) ? rawCode : isNumber(code) ? code : undefined;
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

/**
 * Runs any database query and resolves the outcome as a `Result<T, DbError>`.
 *
 * Built on better-result's `Result.tryPromise`, so the config is the host
 * library's `RetryConfig`: `{ signal?, retry: { times, delayMs, backoff,
 * shouldRetry, jitter } }`. `shouldRetry` reads the `potentiallyTransient`
 * hint — the transient realm (connection loss, deadlock, busy, timeouts) is
 * handled by policy, never enumerated at every call site.
 *
 * Errors that match no known protocol shape are **rethrown** (as a `Panic` in
 * `Result.gen` contexts) — they are not ours to label.
 */
export const tryDb = async <T>(
  query: PromiseLike<T> | (() => PromiseLike<T> | T),
  config?: RetryConfig<DbError>,
): Promise<Result<T, DbError>> =>
  Result.tryPromise(
    {
      try: () => Promise.resolve(runDbQuery(query)),
      catch: (cause: unknown): DbError => withCause(classify(cause), cause),
    },
    config,
  );
