import { describe, expect, test } from "bun:test";
import { tryDb, type DbError } from "../db-result.js";

const transientOf = (e: DbError): boolean =>
  (e as { potentiallyTransient?: boolean }).potentiallyTransient ?? false;

describe("mssql protocol — number field", () => {
  const mssql = (number: number, message: string) => Object.assign(new Error(message), { number });

  test("2627 duplicate key → unique violation", async () => {
    const result = await tryDb(() => {
      throw mssql(2627, "Violation of UNIQUE KEY constraint 'users_email_key'");
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/unique-violation");
  });

  test("547 → foreign-key violation", async () => {
    const result = await tryDb(() => {
      throw mssql(547, "The INSERT statement conflicted with the FOREIGN KEY constraint");
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/foreign-key-violation");
  });

  test("547 with CHECK message → check violation (mssql reuses 547)", async () => {
    const result = await tryDb(() => {
      throw mssql(547, "The INSERT statement conflicted with the CHECK constraint");
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/check-violation");
  });

  test("515 → not-null violation", async () => {
    const result = await tryDb(() => {
      throw mssql(515, "Cannot insert the value NULL into column 'email'");
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/not-null-violation");
  });

  test("18456 → authentication-failed", async () => {
    const result = await tryDb(() => {
      throw mssql(18456, "Login failed for user 'sa'");
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/authentication-failed");
  });

  test("1205 deadlock victim → db/deadlock, transient", async () => {
    const result = await tryDb(() => {
      throw mssql(1205, "Transaction (Process ID 52) was deadlocked on lock resources");
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/deadlock");
      expect(transientOf(result.error)).toBe(true);
    }
  });

  test("1222 lock request timeout → db/lock-timeout, transient", async () => {
    const result = await tryDb(() => {
      throw mssql(1222, "Lock request time out period exceeded");
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/lock-timeout");
      expect(transientOf(result.error)).toBe(true);
    }
  });

  test("102 → sql-syntax-error", async () => {
    const result = await tryDb(() => {
      throw mssql(102, "Incorrect syntax near 'SELEC'");
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/sql-syntax-error");
  });

  test("8115 → data-error", async () => {
    const result = await tryDb(() => {
      throw mssql(8115, "Arithmetic overflow error converting expression to data type int");
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/data-error");
  });

  test("unmapped number → query-failure", async () => {
    const result = await tryDb(() => {
      throw mssql(4104, "The multi-part identifier could not be bound");
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/query-failure");
  });
});
