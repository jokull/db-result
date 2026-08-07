import {
  UniqueViolation,
  CheckViolation,
  ForeignKeyViolation,
  NotNullViolation,
  DeadlockError,
  LockTimeoutError,
  AuthenticationFailed,
  SqlSyntaxError,
  DataError,
  QueryFailure,
  mark,
  transient,
  type DbError,
} from "../tags.js";

export const classifyMssql = (
  n: number,
  message: string,
  constraint: string,
): DbError | undefined => {
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
