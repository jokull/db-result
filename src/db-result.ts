/**
 * db-result — classify database failures into tagged errors, as better-result
 * Results.
 *
 * Driver-agnostic: reads the *protocol* error shape, not any ORM's. It walks
 * `Error.cause` chains (plus the payload slots Effect wrappers use) to reach
 * the driver's error, then recognizes three independent protocols:
 *
 *   1. PostgreSQL SQLSTATE codes   — `code: "23505"` (pg, postgres.js, …)
 *   2. SQLite extended result codes — `code: "SQLITE_CONSTRAINT_UNIQUE"`,
 *      `errcode: 2067` (better-sqlite3, node:sqlite, libsql, D1, …)
 *   3. SQLite native message shapes — `"UNIQUE constraint failed: t.c"` for
 *      drivers that expose neither code field
 *
 * Works at the driver-call level: pass any thenable or thunk
 * (`db.prepare(...).run()`, `client.query(...)`, `db.insert(...)`) and get a
 * `Result<T, DbError>` back. Constraint outcomes become tags a handler can
 * fold into its domain vocabulary — attempting the insert *is* the uniqueness
 * check, including under races.
 *
 * The original failure stays attached as a non-enumerable `Error.cause` for
 * observability; only `{ constraint }` ever reaches the tagged error's data.
 *
 *   bun add better-result
 *   bun test
 */

import { Result, TaggedError } from "better-result";

/** Tagged-error vocabulary. Five tags, all carrying only the constraint name. */
class UniqueViolation extends TaggedError("db/unique-violation")<{
  constraint: string;
}> {}
class ForeignKeyViolation extends TaggedError("db/foreign-key-violation")<{
  constraint: string;
}> {}
class NotNullViolation extends TaggedError("db/not-null-violation")<{
  constraint: string;
}> {}
class CheckViolation extends TaggedError("db/check-violation")<{
  constraint: string;
}> {}
class QueryFailure extends TaggedError("db/query-failure")<{}> {}

export type DbError =
  | UniqueViolation
  | ForeignKeyViolation
  | NotNullViolation
  | CheckViolation
  | QueryFailure;

const DEFAULT_CONSTRAINT = "unknown";

/** The constraint name, taken from the driver's own field when present. */
const constraintFromField = (error: object): string | undefined => {
  const value = Reflect.get(error, "constraint");
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
};

/**
 * Constraint name from the driver's message text.
 *
 * SQLite:  `UNIQUE constraint failed: table.column[, table.column ...]`
 * Postgres: `duplicate key value violates unique constraint "name"`
 *
 * Both stop at the constraint identifier and never run past it — a looser
 * match could capture whatever the driver or ORM appended (including query
 * parameters, which must never reach `data`).
 */
const constraintFromMessage = (message: string): string | undefined => {
  // Dotted identifiers only (table.column[, table.column]) — a bare word like
  // an ORM-appended "INSERT …" has no dot and is never captured.
  const sqlite = /constraint failed: ([\w]+(?:\.[\w]+)+)(?:,\s*[\w]+(?:\.[\w]+)+)*/i.exec(message);
  if (sqlite?.[1]) return sqlite[1].trim();
  const pg = /constraint "([^"]+)"/.exec(message);
  return pg?.[1]?.trim();
};

const classify = (cause: unknown): DbError => {
  // Breadth-first walk of the cause chain (bounded), following the payload
  // slots Effect wrappers use, so ORM and driver nesting is transparent.
  const pending: unknown[] = [cause];
  const visited = new Set<object>();

  for (let inspected = 0; inspected < 16 && pending.length > 0; inspected += 1) {
    const current = pending.shift();
    if (typeof current !== "object" || current === null) continue;
    if (visited.has(current)) continue;
    visited.add(current);

    const message = typeof Reflect.get(current, "message") === "string"
      ? (Reflect.get(current, "message") as string)
      : "";
    const code = Reflect.get(current, "code");
    const errcode = Reflect.get(current, "errcode");
    const constraint = constraintFromField(current) ?? constraintFromMessage(message) ?? DEFAULT_CONSTRAINT;

    const is = (sqlitePrefix: string, sqliteCode: number, pgCode: string, messageRe: RegExp): boolean =>
      (typeof code === "string" && (code.startsWith(sqlitePrefix) || code === pgCode)) ||
      (typeof errcode === "number" && errcode === sqliteCode) ||
      messageRe.test(message);

    if (is("SQLITE_CONSTRAINT_UNIQUE", 2067, "23505", /^UNIQUE constraint failed:/i)) {
      return new UniqueViolation({ constraint });
    }
    if (is("SQLITE_CONSTRAINT_PRIMARYKEY", 1555, "23505", /^PRIMARY KEY constraint failed:/i)) {
      return new UniqueViolation({ constraint });
    }
    if (is("SQLITE_CONSTRAINT_FOREIGNKEY", 787, "23503", /^FOREIGN KEY constraint failed/i)) {
      return new ForeignKeyViolation({ constraint });
    }
    if (is("SQLITE_CONSTRAINT_NOTNULL", 1299, "23502", /^NOT NULL constraint failed:/i)) {
      return new NotNullViolation({ constraint });
    }
    if (is("SQLITE_CONSTRAINT_CHECK", 275, "23514", /^CHECK constraint failed:/i)) {
      return new CheckViolation({ constraint });
    }

    pending.push(
      ...["cause", "failure", "error", "defect"].map((key) => Reflect.get(current, key)),
    );
  }

  return new QueryFailure({});
};

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

/** Runs any database query and resolves the outcome as a Result. */
function runDbQuery<T>(query: PromiseLike<T> | (() => PromiseLike<T> | T)): PromiseLike<T> | T {
  return typeof query === "function" ? query() : query;
}

export const tryDb = async <T>(
  query: PromiseLike<T> | (() => PromiseLike<T> | T),
): Promise<Result<T, DbError>> => {
  try {
    return Result.ok(await runDbQuery(query));
  } catch (cause) {
    return Result.err(withCause(classify(cause), cause));
  }
};
