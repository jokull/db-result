import {
  UniqueViolation,
  ForeignKeyViolation,
  NotNullViolation,
  CheckViolation,
  AuthenticationFailed,
  AuthorizationFailed,
  ConnectFailure,
  ConnectionLost,
  TransactionAborted,
  DeadlockError,
  LockTimeoutError,
  QueryFailure,
  DataError,
  SqlSyntaxError,
  mark,
  transient,
  type DbError,
} from "../tags.js";

export const classifySQLSTATE = (code: string, constraint: string): DbError => {
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
