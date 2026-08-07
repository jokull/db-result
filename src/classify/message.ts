import {
  UniqueViolation,
  ForeignKeyViolation,
  NotNullViolation,
  CheckViolation,
  SqlSyntaxError,
  QueryFailure,
  ConnectFailure,
  ConnectionLost,
  AuthenticationFailed,
  AuthorizationFailed,
  LockTimeoutError,
  mark,
  transient,
  type DbError,
} from "../tags.js";
import { classifySqliteCodeString } from "./sqlite.js";

export const classifyMessage = (raw: string, constraint: string): DbError | undefined => {
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
