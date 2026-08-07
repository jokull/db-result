import {
  UniqueViolation,
  ForeignKeyViolation,
  NotNullViolation,
  CheckViolation,
  AuthorizationFailed,
  ConnectFailure,
  ConnectionLost,
  LockTimeoutError,
  QueryFailure,
  mark,
  transient,
  type DbError,
} from "../tags.js";

export const classifySqliteCodeString = (code: string, constraint: string): DbError | undefined => {
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

export const classifySqliteNumeric = (n: number, constraint: string): DbError | undefined => {
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
