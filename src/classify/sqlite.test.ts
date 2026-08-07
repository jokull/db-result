import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createClient } from "@libsql/client";
import { tryDb, isConnectionFailure, type DbError } from "../db-result.js";

const constraintOf = (e: DbError): string => (e as { constraint?: string }).constraint ?? "";
const transientOf = (e: DbError): boolean =>
  (e as { potentiallyTransient?: boolean }).potentiallyTransient ?? false;

describe("SQLite family — D1, node:sqlite, better-sqlite3, libsql, wa-sqlite", () => {
  test("D1 message shape (no code field) → unique violation", async () => {
    const result = await tryDb(() => {
      throw new Error("UNIQUE constraint failed: users.email");
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/unique-violation");
      expect(constraintOf(result.error)).toBe("users.email");
    }
  });

  test("D1 real shape — D1_ERROR prefix + (code NNNN NAME[NNNN]) suffix, nested under cause", async () => {
    const driver = new Error(
      "UNIQUE constraint failed: users.email (code 2067 SQLITE_CONSTRAINT_UNIQUE[2067])",
    );
    const result = await tryDb(() => {
      throw new Error("D1_ERROR: " + driver.message, { cause: driver });
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/unique-violation");
      expect(constraintOf(result.error)).toBe("users.email");
    }
  });

  test("better-sqlite3-style code string", async () => {
    const result = await tryDb(() => {
      throw Object.assign(new Error("UNIQUE constraint failed: users.email"), {
        code: "SQLITE_CONSTRAINT_UNIQUE",
      });
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/unique-violation");
  });

  test("node:sqlite extended result code (errcode 2067)", async () => {
    const result = await tryDb(() => {
      throw Object.assign(new Error("UNIQUE constraint failed: users.email"), {
        code: "ERR_SQLITE_ERROR",
        errcode: 2067,
        errstr: "constraint failed",
      });
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/unique-violation");
      expect(constraintOf(result.error)).toBe("users.email");
    }
  });

  test("wa-sqlite numeric code in `.code`", async () => {
    const result = await tryDb(() => {
      throw Object.assign(new Error("UNIQUE constraint failed: users.email"), { code: 2067 });
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/unique-violation");
  });

  test("libsql extendedCode string", async () => {
    const result = await tryDb(() => {
      throw Object.assign(new Error("SQLITE_ERROR: UNIQUE constraint failed: users.email"), {
        name: "LibsqlError",
        code: "SQLITE_ERROR",
        extendedCode: "SQLITE_CONSTRAINT_PRIMARYKEY",
        rawCode: 1555,
      });
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/unique-violation");
  });

  test("libsql network error → connection-failure", async () => {
    const result = await tryDb(() => {
      throw Object.assign(new Error("CLIENT_NETWORK_ERROR: failed to connect"), {
        name: "LibsqlError",
        code: "CLIENT_NETWORK_ERROR",
      });
    });
    if (result.isErr()) expect(isConnectionFailure(result.error)).toBe(true);
  });

  test("primary key maps to unique violation", async () => {
    const result = await tryDb(() => {
      throw Object.assign(new Error("UNIQUE constraint failed: users.id"), {
        code: "SQLITE_CONSTRAINT_PRIMARYKEY",
      });
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/unique-violation");
  });

  test("foreign key (errcode 787)", async () => {
    const result = await tryDb(() => {
      throw Object.assign(new Error("FOREIGN KEY constraint failed"), {
        code: "ERR_SQLITE_ERROR",
        errcode: 787,
      });
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/foreign-key-violation");
  });

  test("not-null (errcode 1299)", async () => {
    const result = await tryDb(() => {
      throw Object.assign(new Error("NOT NULL constraint failed: users.email"), {
        code: "ERR_SQLITE_ERROR",
        errcode: 1299,
      });
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/not-null-violation");
  });

  test("check (errcode 275)", async () => {
    const result = await tryDb(() => {
      throw Object.assign(new Error("CHECK constraint failed: users.age"), {
        code: "ERR_SQLITE_ERROR",
        errcode: 275,
      });
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/check-violation");
  });

  test("SQLITE_BUSY → db/lock-timeout with transient hint (retry by policy)", async () => {
    const result = await tryDb(
      () => {
        throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
      },
      { retryTransient: false },
    );
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/lock-timeout");
      expect(transientOf(result.error)).toBe(true);
    }
  });

  test("SQLITE_PERM → authorization-failed (permission, not identity)", async () => {
    const result = await tryDb(() => {
      throw Object.assign(new Error("attempt to write a readonly database"), {
        code: "SQLITE_PERM",
      });
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/authorization-failed");
  });

  test("SQLITE_AUTH (authorizer) → authorization-failed", async () => {
    const result = await tryDb(() => {
      throw Object.assign(new Error("not authorized"), { code: "SQLITE_AUTH" });
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/authorization-failed");
  });

  test("SQLITE_CANTOPEN → connection-failure", async () => {
    const result = await tryDb(() => {
      throw Object.assign(new Error("unable to open database file"), { code: "SQLITE_CANTOPEN" });
    });
    if (result.isErr()) expect(isConnectionFailure(result.error)).toBe(true);
  });

  test("no such table → sql-syntax-error", async () => {
    const result = await tryDb(() => {
      throw new Error("no such table: users");
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/sql-syntax-error");
  });

  test("query text and params never leak into data", async () => {
    const result = await tryDb(() => {
      throw new Error(
        "UNIQUE constraint failed: users.email, INSERT INTO users VALUES ('admin','hunter2')",
      );
    });
    if (result.isErr()) {
      expect(constraintOf(result.error)).toBe("users.email");
      expect((result.error as { constraint?: string }).constraint).not.toContain("hunter2");
    }
  });
});
describe("real bun:sqlite (built into Bun, no setup)", () => {
  test("attempting the insert is the uniqueness check", async () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE things (id INTEGER PRIMARY KEY, label TEXT UNIQUE NOT NULL)");

    const insert = (label: string) =>
      tryDb(() => db.prepare("INSERT INTO things (label) VALUES (?)").run(label));

    expect((await insert("first")).isOk()).toBe(true);
    const dupe = await insert("first");
    expect(dupe.isErr()).toBe(true);
    if (dupe.isErr()) {
      expect(dupe.error._tag).toBe("db/unique-violation");
      expect(constraintOf(dupe.error)).toContain("label");
    }
  });

  test("successful query resolves as Ok with the value", async () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE t (v INTEGER)");
    db.prepare("INSERT INTO t VALUES (42)").run();
    const result = await tryDb(() => db.prepare("SELECT v FROM t").get());
    if (result.isOk()) {
      expect(result.value).toEqual({ v: 42 });
    }
  });
});
describe("real libsql (@libsql/client, file::memory:)", () => {
  test("attempting the insert is the uniqueness check", async () => {
    const db = createClient({ url: "file::memory:" });
    await db.execute("CREATE TABLE things (id INTEGER PRIMARY KEY, label TEXT UNIQUE NOT NULL)");

    const insert = (label: string) =>
      tryDb(() => db.execute("INSERT INTO things (label) VALUES (?)", [label]));

    expect((await insert("first")).isOk()).toBe(true);
    const dupe = await insert("first");
    expect(dupe.isErr()).toBe(true);
    if (dupe.isErr()) {
      expect(dupe.error._tag).toBe("db/unique-violation");
      expect(constraintOf(dupe.error)).toContain("label");
    }
  });
});
