import { describe, expect, test } from "bun:test";
import {
  tryDb,
  isDbError,
  isUniqueViolation,
  isConnectionFailure,
  isRetriedError,
  isAuthenticationFailed,
  isAuthorizationFailed,
  isSqlSyntaxError,
  isQueryFailure,
} from "./db-result.js";

describe("guards", () => {
  test("isUniqueViolation narrows correctly", async () => {
    const dupe = await tryDb(() => {
      throw Object.assign(new Error("UNIQUE constraint failed: users.email"), {
        code: "SQLITE_CONSTRAINT_UNIQUE",
      });
    });
    const conn = await tryDb(
      () => {
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      },
      { retryTransient: false },
    );
    if (dupe.isErr()) {
      expect(isUniqueViolation(dupe.error)).toBe(true);
      expect(isConnectionFailure(dupe.error)).toBe(false);
      if (isUniqueViolation(dupe.error)) expect(dupe.error.constraint).toContain("users");
    }
    if (conn.isErr()) expect(isConnectionFailure(conn.error)).toBe(true);
    for (const g of [
      isAuthenticationFailed,
      isAuthorizationFailed,
      isSqlSyntaxError,
      isQueryFailure,
    ]) {
      expect(g(null)).toBe(false);
    }
  });

  test("isDbError is the boundary check across the whole union", async () => {
    const dupe = await tryDb(() => {
      throw Object.assign(new Error("UNIQUE constraint failed: users.email"), {
        code: "SQLITE_CONSTRAINT_UNIQUE",
      });
    });
    const conn = await tryDb(
      () => {
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      },
      { retryTransient: false },
    );
    const qf = await tryDb(() => {
      throw Object.assign(new Error("database or disk is full"));
    });
    if (dupe.isErr()) expect(isDbError(dupe.error)).toBe(true);
    if (conn.isErr()) expect(isDbError(conn.error)).toBe(true);
    if (qf.isErr()) expect(isDbError(qf.error)).toBe(true);
    // non-db failures are not db errors; guards are tag-based, so unknown tags aren't either
    expect(isDbError(null)).toBe(false);
    expect(isDbError(new TypeError("boom"))).toBe(false);
    expect(isDbError({ _tag: "db/unique-violation" })).toBe(true); // guards read the tag
    expect(isDbError({ _tag: "db/whatever" })).toBe(false);
  });

  test("survived retries expose the attempt count via isRetriedError", async () => {
    const result = await tryDb(() => {
      throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(isRetriedError(result.error)).toBe(true);
      if (isRetriedError(result.error)) expect(result.error.retries).toBe(4); // initial + 3 retries
      expect(Object.keys(result.error)).not.toContain("retries"); // non-enumerable
    }
  });

  test("first-try failures carry no retry metadata", async () => {
    const result = await tryDb(() => {
      throw Object.assign(new Error("UNIQUE constraint failed: users.email"), {
        code: "SQLITE_CONSTRAINT_UNIQUE",
      });
    });
    if (result.isErr()) expect(isRetriedError(result.error)).toBe(false);
  });

  test("thenable form still classifies (retry is inert on a settled promise)", async () => {
    const settled = Promise.resolve().then(() => {
      throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
    });
    const result = await tryDb(settled);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error._tag).toBe("db/deadlock");
  });
});
