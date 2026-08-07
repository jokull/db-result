import { TaggedError } from "better-result";

// ─── Vocabulary ──────────────────────────────────────────────────────────────

export const transient = { potentiallyTransient: true } as const;

/**
 * Attaches an internal, non-enumerable "safe to auto-retry" flag. The public
 * `potentiallyTransient` hint says *retrying may help*; `retrySafe` says the
 * default policy may retry (deterministic and ambiguous-outcome errors never
 * get it).
 */
export const mark = (error: DbError, retrySafe: boolean): DbError => {
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

export class UniqueViolation extends TaggedError("db/unique-violation")<{
  constraint: string;
  potentiallyTransient?: boolean;
}> {}
export class ForeignKeyViolation extends TaggedError("db/foreign-key-violation")<{
  constraint: string;
  potentiallyTransient?: boolean;
}> {}
export class NotNullViolation extends TaggedError("db/not-null-violation")<{
  constraint: string;
  potentiallyTransient?: boolean;
}> {}
export class CheckViolation extends TaggedError("db/check-violation")<{
  constraint: string;
  potentiallyTransient?: boolean;
}> {}
export class DataError extends TaggedError("db/data-error")<{
  potentiallyTransient?: boolean;
}> {}
export class DeadlockError extends TaggedError("db/deadlock")<{
  potentiallyTransient?: boolean;
}> {}
export class LockTimeoutError extends TaggedError("db/lock-timeout")<{
  potentiallyTransient?: boolean;
}> {}
export class TransactionAborted extends TaggedError("db/transaction-aborted")<{
  potentiallyTransient?: boolean;
}> {}
export class ConnectFailure extends TaggedError("db/connect-failure")<{
  potentiallyTransient?: boolean;
}> {}
export class ConnectionLost extends TaggedError("db/connection-lost")<{
  potentiallyTransient?: boolean;
}> {}
export class AuthenticationFailed extends TaggedError("db/authentication-failed")<{
  potentiallyTransient?: boolean;
}> {}
export class AuthorizationFailed extends TaggedError("db/authorization-failed")<{
  potentiallyTransient?: boolean;
}> {}
export class SqlSyntaxError extends TaggedError("db/sql-syntax-error")<{
  potentiallyTransient?: boolean;
}> {}
export class QueryFailure extends TaggedError("db/query-failure")<{
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
