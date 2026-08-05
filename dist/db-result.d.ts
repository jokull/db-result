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
import { Result } from "better-result";
type TryPromiseContext = {
    attempt: number;
    signal?: AbortSignal;
};
type RetryOptions<E> = {
    times: number;
    delayMs: number;
    backoff: "linear" | "constant" | "exponential";
    shouldRetry?: (error: E, context: TryPromiseContext) => boolean;
    jitter?: boolean | number;
} | {
    times: number;
    delayMs: (error: E, context: TryPromiseContext) => number;
    shouldRetry?: (error: E, context: TryPromiseContext) => boolean;
};
type RetryConfig<E> = {
    signal?: AbortSignal;
    retry?: RetryOptions<E>;
};
declare const UniqueViolation_base: import("better-result").TaggedErrorClass<"db/unique-violation">;
declare class UniqueViolation extends UniqueViolation_base<{
    constraint: string;
    potentiallyTransient?: boolean;
}> {
}
declare const ForeignKeyViolation_base: import("better-result").TaggedErrorClass<"db/foreign-key-violation">;
declare class ForeignKeyViolation extends ForeignKeyViolation_base<{
    constraint: string;
    potentiallyTransient?: boolean;
}> {
}
declare const NotNullViolation_base: import("better-result").TaggedErrorClass<"db/not-null-violation">;
declare class NotNullViolation extends NotNullViolation_base<{
    constraint: string;
    potentiallyTransient?: boolean;
}> {
}
declare const CheckViolation_base: import("better-result").TaggedErrorClass<"db/check-violation">;
declare class CheckViolation extends CheckViolation_base<{
    constraint: string;
    potentiallyTransient?: boolean;
}> {
}
declare const ConnectionFailure_base: import("better-result").TaggedErrorClass<"db/connection-failure">;
declare class ConnectionFailure extends ConnectionFailure_base<{
    potentiallyTransient?: boolean;
}> {
}
declare const AuthenticationFailed_base: import("better-result").TaggedErrorClass<"db/authentication-failed">;
declare class AuthenticationFailed extends AuthenticationFailed_base<{
    potentiallyTransient?: boolean;
}> {
}
declare const AuthorizationFailed_base: import("better-result").TaggedErrorClass<"db/authorization-failed">;
declare class AuthorizationFailed extends AuthorizationFailed_base<{
    potentiallyTransient?: boolean;
}> {
}
declare const SqlSyntaxError_base: import("better-result").TaggedErrorClass<"db/sql-syntax-error">;
declare class SqlSyntaxError extends SqlSyntaxError_base<{
    potentiallyTransient?: boolean;
}> {
}
declare const QueryFailure_base: import("better-result").TaggedErrorClass<"db/query-failure">;
declare class QueryFailure extends QueryFailure_base<{
    potentiallyTransient?: boolean;
}> {
}
export type DbError = UniqueViolation | ForeignKeyViolation | NotNullViolation | CheckViolation | ConnectionFailure | AuthenticationFailed | AuthorizationFailed | SqlSyntaxError | QueryFailure;
export declare const isUniqueViolation: (e: unknown) => e is UniqueViolation;
export declare const isForeignKeyViolation: (e: unknown) => e is ForeignKeyViolation;
export declare const isNotNullViolation: (e: unknown) => e is NotNullViolation;
export declare const isCheckViolation: (e: unknown) => e is CheckViolation;
export declare const isConnectionFailure: (e: unknown) => e is ConnectionFailure;
export declare const isAuthenticationFailed: (e: unknown) => e is AuthenticationFailed;
export declare const isAuthorizationFailed: (e: unknown) => e is AuthorizationFailed;
export declare const isSqlSyntaxError: (e: unknown) => e is SqlSyntaxError;
export declare const isQueryFailure: (e: unknown) => e is QueryFailure;
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
export declare const tryDb: <T>(query: PromiseLike<T> | (() => PromiseLike<T> | T), config?: RetryConfig<DbError>) => Promise<Result<T, DbError>>;
export {};
