import { describe, expect, test } from "bun:test";
import { tryDb, type DbError } from "../db-result.js";

const transientOf = (e: DbError): boolean =>
  (e as { potentiallyTransient?: boolean }).potentiallyTransient ?? false;

describe("cause-chain unwrapping", () => {
  test("sees through a DrizzleQueryError-style wrapper", async () => {
    const driverError = Object.assign(new Error("UNIQUE constraint failed: users.email"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 2067,
      errstr: "constraint failed",
    });
    const wrapper = Object.assign(new Error("Query failed"), { cause: driverError });
    const result = await tryDb(() => {
      throw wrapper;
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/unique-violation");
  });

  test("follows Effect payload slots (failure/error/defect)", async () => {
    const driverError = new Error("UNIQUE constraint failed: users.email");
    const effectShaped = { defect: driverError };
    const result = await tryDb(() => {
      throw effectShaped;
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/unique-violation");
  });

  test("classifies mssql ELOGIN login failures (no number field)", async () => {
    // mssql ConnectionError: code ELOGIN, tedious originalError carries no number
    const wrapper = Object.assign(new Error("Login failed for user 'sa'"), {
      code: "ELOGIN",
      originalError: Object.assign(new Error("Login failed for user 'sa'"), {
        code: "ELOGIN",
      }),
    });
    const result = await tryDb(() => {
      throw wrapper;
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/authentication-failed");
  });

  test("original driver error retained as non-enumerable cause", async () => {
    const diskFull = new Error("database or disk is full");
    const result = await tryDb(() => {
      throw diskFull;
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/query-failure");
      expect((result.error as Error).cause).toBe(diskFull);
      expect(Object.keys(result.error)).not.toContain("cause"); // non-enumerable
    }
  });
});
describe("the contract — errors that are not database failures are rethrown", () => {
  test("a TypeError from user code is never tagged db/*", async () => {
    const boom = new TypeError("users is not defined");
    let caught: unknown;
    try {
      await tryDb(() => {
        throw boom;
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    // surfaces as a defect (better-result Panic) whose cause is the original
    expect((caught as { cause?: unknown }).cause).toBe(boom);
  });

  test("fs-style codes (ENOENT) are not misclassified as connection failures", async () => {
    const fsError = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });
    await expect(
      tryDb(() => {
        throw fsError;
      }),
    ).rejects.toBeDefined();
  });

  test("mysql2 ER_DUP_ENTRY → unique violation (tables live in core)", async () => {
    const mysql = Object.assign(new Error("Duplicate entry 'a@b.com' for key 'users.email'"), {
      code: "ER_DUP_ENTRY",
      errno: 1062,
      sqlState: "23000",
    });
    const result = await tryDb(() => {
      throw mysql;
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/unique-violation");
      expect(transientOf(result.error)).toBe(false);
    }
  });
});
