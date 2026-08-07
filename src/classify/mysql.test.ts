import { describe, expect, test } from "bun:test";
import { tryDb, type DbError } from "../db-result.js";

const transientOf = (e: DbError): boolean =>
  (e as { potentiallyTransient?: boolean }).potentiallyTransient ?? false;

describe("mysql2 protocol — ER_* / errno tables", () => {
  const mysql = (code: string, errno: number, message: string) =>
    Object.assign(new Error(message), { code, errno, sqlState: "23000" });

  test("1062 duplicate → unique violation", async () => {
    const result = await tryDb(() => {
      throw mysql("ER_DUP_ENTRY", 1062, "Duplicate entry 'a@b.com' for key 'users.email'");
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/unique-violation");
  });

  test("1452 missing parent → foreign-key violation", async () => {
    const result = await tryDb(() => {
      throw mysql("ER_NO_REFERENCED_ROW_2", 1452, "Cannot add or update a child row");
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/foreign-key-violation");
  });

  test("1048 → not-null violation", async () => {
    const result = await tryDb(() => {
      throw mysql("ER_BAD_NULL_ERROR", 1048, "Column 'email' cannot be null");
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/not-null-violation");
  });

  test("3819 → check violation", async () => {
    const result = await tryDb(() => {
      throw mysql("ER_CHECK_CONSTRAINT_VIOLATED", 3819, "Check constraint violated");
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/check-violation");
  });

  test("1213 deadlock → db/deadlock, transient", async () => {
    const result = await tryDb(() => {
      throw mysql("ER_LOCK_DEADLOCK", 1213, "Deadlock found when trying to get lock");
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/deadlock");
      expect(transientOf(result.error)).toBe(true);
    }
  });

  test("1205 lock wait timeout → db/lock-timeout, transient", async () => {
    const result = await tryDb(() => {
      throw mysql("ER_LOCK_WAIT_TIMEOUT", 1205, "Lock wait timeout exceeded");
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/lock-timeout");
      expect(transientOf(result.error)).toBe(true);
    }
  });

  test("1045 → authentication-failed", async () => {
    const result = await tryDb(() => {
      throw mysql("ER_ACCESS_DENIED_ERROR", 1045, "Access denied for user");
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/authentication-failed");
  });

  test("1064 → sql-syntax-error", async () => {
    const result = await tryDb(() => {
      throw mysql("ER_PARSE_ERROR", 1064, "You have an error in your SQL syntax");
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/sql-syntax-error");
  });

  test("1406 → data-error", async () => {
    const result = await tryDb(() => {
      throw mysql("ER_DATA_TOO_LONG", 1406, "Data too long for column 'name'");
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/data-error");
  });

  test("unmapped errno → query-failure", async () => {
    const result = await tryDb(() => {
      throw mysql("ER_UNKNOWN_STORAGE_ENGINE", 1286, "Unknown storage engine");
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/query-failure");
  });
});
