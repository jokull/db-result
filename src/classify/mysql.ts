import {
  UniqueViolation,
  ForeignKeyViolation,
  NotNullViolation,
  CheckViolation,
  DeadlockError,
  LockTimeoutError,
  AuthenticationFailed,
  AuthorizationFailed,
  SqlSyntaxError,
  DataError,
  QueryFailure,
  mark,
  transient,
  type DbError,
} from "../tags.js";
import { isString } from "./helpers.js";

export const classifyMysql = (
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
