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
 *
 * Implementation is split by concern — the vocabulary + guards live in
 * `./tags.js`, protocol classification in `./classify/`, the type-level shape
 * lattice in `./lattice.js`, and the retry engine + `tryDb`/`tryTx` in
 * `./retry.js`. This file is the public surface.
 */

// Vocabulary + guards (the 14-tag `DbError` union, `isXxx` guards).
export {
  type DbError,
  type RetriedDbError,
  isUniqueViolation,
  isForeignKeyViolation,
  isNotNullViolation,
  isCheckViolation,
  isDataError,
  isDeadlock,
  isLockTimeout,
  isTransactionAborted,
  isConnectFailure,
  isConnectionLost,
  isConnectionFailure,
  isAuthenticationFailed,
  isAuthorizationFailed,
  isSqlSyntaxError,
  isQueryFailure,
  isDbError,
  isRetriedError,
} from "./tags.js";

// Tag classes as types only — per-driver entry points build narrowed unions
// with `Exclude<DbError, …>`; construct errors via `tryDb`, never by
// instantiating these.
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
} from "./tags.js";

// Type-level shape lattice — probes + `ShapeLedger` narrowing.
export {
  type IsSelectBuilder,
  type IsDrizzleSelect,
  type IsInsertBuilder,
  type IsUpdateBuilder,
  type IsDeleteBuilder,
  type DbShape,
  type ShapeOfQuery,
  type ShapeLedger,
  type DefaultLedger,
  type ShapeExclusions,
  type ShapeUnion,
} from "./lattice.js";

// The retry engine and entry points.
export {
  tryDb,
  tryTx,
  type TryDbConfig,
  type TryDbFor,
  type TryTxFor,
  type QueryThunk,
} from "./retry.js";
