import { describe, expect, test } from "bun:test";
import { tryDb, ConnectFailure, ConnectionLost, type DbError } from "../db-result.js";

const constraintOf = (e: DbError): string => (e as { constraint?: string }).constraint ?? "";
const transientOf = (e: DbError): boolean =>
  (e as { potentiallyTransient?: boolean }).potentiallyTransient ?? false;

describe("PostgreSQL protocol (SQLSTATE + constraint field)", () => {
  const pgError = (code: string, message: string, constraint?: string) =>
    Object.assign(new Error(message), { severity: "ERROR", code, constraint, schema: "public" });

  test("23505 → unique violation, constraint from the field", async () => {
    const result = await tryDb(() => {
      throw pgError(
        "23505",
        'duplicate key value violates unique constraint "users_email_key"',
        "users_email_key",
      );
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/unique-violation");
      expect(constraintOf(result.error)).toBe("users_email_key");
      expect(transientOf(result.error)).toBe(false);
    }
  });

  test("23503 → foreign-key violation", async () => {
    const result = await tryDb(() => {
      throw pgError(
        "23503",
        'insert or update on table "orders" violates foreign key constraint "orders_user_id_fkey"',
        "orders_user_id_fkey",
      );
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/foreign-key-violation");
  });

  test("23502 → not-null violation", async () => {
    const result = await tryDb(() => {
      throw pgError(
        "23502",
        'null value in column "email" of relation "users" violates not-null constraint',
        "users_email_not_null",
      );
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/not-null-violation");
  });

  test("23514 → check violation", async () => {
    const result = await tryDb(() => {
      throw pgError(
        "23514",
        'new row for relation "users" violates check constraint "users_age_check"',
        "users_age_check",
      );
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/check-violation");
  });

  test("constraint name falls back to the message when the field is absent", async () => {
    const result = await tryDb(() => {
      throw pgError("23505", 'duplicate key value violates unique constraint "users_email_key"');
    });
    if (result.isErr()) expect(constraintOf(result.error)).toBe("users_email_key");
  });

  test("other 23xxx → query-failure, no hint", async () => {
    const result = await tryDb(() => {
      throw pgError("23P01", "exclusion constraint violation");
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/query-failure");
      expect(transientOf(result.error)).toBe(false);
    }
  });

  test("08006 mid-query loss → connection-lost, transient hint", async () => {
    const result = await tryDb(() => {
      throw pgError("08006", "terminating connection due to administrator command");
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/connection-lost");
      expect(transientOf(result.error)).toBe(true);
      expect(ConnectionLost.is(result.error)).toBe(true);
    }
  });

  test("08001 connect refused → connect-failure, retry-safe", async () => {
    const result = await tryDb(() => {
      throw pgError("08001", "could not establish connection");
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/connect-failure");
      expect(transientOf(result.error)).toBe(true);
      expect(ConnectFailure.is(result.error)).toBe(true);
    }
  });

  test("28P01 → authentication-failed", async () => {
    const result = await tryDb(() => {
      throw pgError("28P01", 'password authentication failed for user "app"');
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/authentication-failed");
  });

  test("42501 → authorization-failed (checked before 42* syntax)", async () => {
    const result = await tryDb(() => {
      throw pgError("42501", "permission denied for table users");
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/authorization-failed");
  });

  test("42601 → sql-syntax-error", async () => {
    const result = await tryDb(() => {
      throw pgError("42601", 'syntax error at or near "SELEC"');
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/sql-syntax-error");
  });

  test("40P01 deadlock → db/deadlock, transient", async () => {
    const result = await tryDb(() => {
      throw pgError("40P01", "deadlock detected");
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/deadlock");
      expect(transientOf(result.error)).toBe(true);
    }
  });

  test("53300 too-many-connections → transient (the one Effect misses)", async () => {
    const result = await tryDb(
      () => {
        throw pgError("53300", "sorry, too many clients already");
      },
      { retryTransient: false },
    );
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/query-failure");
      expect(transientOf(result.error)).toBe(true);
    }
  });

  test("22001 → db/data-error (deterministic)", async () => {
    const result = await tryDb(() => {
      throw pgError("22001", "value too long for type character varying(255)");
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/data-error");
      expect(transientOf(result.error)).toBe(false);
    }
  });
});
describe("tag expansion — deadlock, lock-timeout, data-error, transaction-aborted", () => {
  const pgError = (code: string, message: string) =>
    Object.assign(new Error(message), { severity: "ERROR", code, schema: "public" });

  test("40001 serialization folds into db/deadlock (same retry decision)", async () => {
    const result = await tryDb(() => {
      throw pgError("40001", "could not serialize access due to concurrent update");
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/deadlock");
      expect(transientOf(result.error)).toBe(true);
    }
  });

  test("55P03 lock-timeout → db/lock-timeout, transient", async () => {
    const result = await tryDb(() => {
      throw pgError("55P03", "lock_not_available");
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/lock-timeout");
      expect(transientOf(result.error)).toBe(true);
    }
  });

  test("25P02 → db/transaction-aborted, never retried", async () => {
    let attempts = 0;
    const result = await tryDb(() => {
      attempts += 1;
      throw pgError(
        "25P02",
        "current transaction is aborted, commands ignored until end of transaction block",
      );
    });
    expect(attempts).toBe(1);
    if (result.isErr()) expect(result.error._tag).toBe("db/transaction-aborted");
  });

  test("22003/22P02 → db/data-error", async () => {
    for (const code of ["22003", "22P02"]) {
      const result = await tryDb(() => {
        throw pgError(code, `boom ${code}`);
      });
      if (result.isErr()) {
        expect(result.error._tag).toBe("db/data-error");
        expect(transientOf(result.error)).toBe(false);
      }
    }
  });

  test("SQLITE_BUSY → db/lock-timeout, retried by default", async () => {
    let attempts = 0;
    const result = await tryDb(() => {
      attempts += 1;
      if (attempts < 2)
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      return "ok";
    });
    expect(attempts).toBe(2);
    expect(result.isOk()).toBe(true);
  });
});
