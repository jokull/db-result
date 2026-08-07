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

/** The four SQL constraint-violation tags — the "your input broke a schema rule" family. */
export type ConstraintViolation =
  | UniqueViolation
  | ForeignKeyViolation
  | NotNullViolation
  | CheckViolation;

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

// Per-tag checks are the classes' OWN static `is` (inherited from
// `TaggedErrorClass`) — `UniqueViolation.is(e)` narrows to `UniqueViolation`,
// the same better-result idiom as `TaggedError.is` / `err.match`. Only the
// FAMILY predicates (unions of tags) stay as functions, built on the statics.

/** Family guard — any of the four constraint tags. */
export const isConstraintViolation = (e: unknown): e is ConstraintViolation =>
  UniqueViolation.is(e) ||
  ForeignKeyViolation.is(e) ||
  NotNullViolation.is(e) ||
  CheckViolation.is(e);

/** Family guard — either connection tag. `db/connect-failure` is a
 * connect-phase failure (safe to retry); `db/connection-lost` is ambiguous
 * mid-query loss (never auto-retried). */
export const isConnectionFailure = (e: unknown): e is ConnectFailure | ConnectionLost =>
  ConnectFailure.is(e) || ConnectionLost.is(e);

/** True when `e` is any of the fourteen `DbError` tags — the boundary check. */
export const isDbError = (e: unknown): e is DbError =>
  UniqueViolation.is(e) ||
  ForeignKeyViolation.is(e) ||
  NotNullViolation.is(e) ||
  CheckViolation.is(e) ||
  DataError.is(e) ||
  DeadlockError.is(e) ||
  LockTimeoutError.is(e) ||
  TransactionAborted.is(e) ||
  ConnectFailure.is(e) ||
  ConnectionLost.is(e) ||
  AuthenticationFailed.is(e) ||
  AuthorizationFailed.is(e) ||
  SqlSyntaxError.is(e) ||
  QueryFailure.is(e);

/** A `DbError` that survived its retries — carries the attempt count. */
export type RetriedDbError = DbError & { retries: number };

/** True when the error went through ≥1 retry; `error.retries` is the attempt count. */
export const isRetriedError = (e: unknown): e is RetriedDbError =>
  typeof e === "object" && e !== null && typeof Reflect.get(e, "retries") === "number";
