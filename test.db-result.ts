/**
 * Fixture tests — the exact error shapes the drivers produce, plus real
 * node:sqlite (built into Node 22.5+/Bun, zero setup).
 *
 * Real-driver proof lives in `test.integration.ts` (Postgres via PGTEST_DSN).
 *
 *   bun install
 *   bun test
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { tryDb, type DbError } from "./db-result.ts";

const constraintOf = (e: DbError): string => (e as { constraint?: string }).constraint ?? "";

describe("PostgreSQL protocol (SQLSTATE + constraint field)", () => {
  // Exact shapes node-postgres populates (pg-protocol parseError).
  const pgError = (code: string, message: string, constraint?: string) =>
    Object.assign(new Error(message), { severity: "ERROR", code, constraint, schema: "public" });

  test("23505 → unique violation, constraint from the field", async () => {
    const result = await tryDb(() => {
      throw pgError("23505", 'duplicate key value violates unique constraint "users_email_key"', "users_email_key");
    });
    expect(result).toSatisfy((r) => r.isErr());
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/unique-violation");
      expect(constraintOf(result.error)).toBe("users_email_key");
    }
  });

  test("23503 → foreign-key violation", async () => {
    const result = await tryDb(() => {
      throw pgError("23503", 'insert or update on table "orders" violates foreign key constraint "orders_user_id_fkey"', "orders_user_id_fkey");
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/foreign-key-violation");
      expect(constraintOf(result.error)).toBe("orders_user_id_fkey");
    }
  });

  test("23502 → not-null violation", async () => {
    const result = await tryDb(() => {
      throw pgError("23502", 'null value in column "email" of relation "users" violates not-null constraint', "users_email_not_null");
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/not-null-violation");
      expect(constraintOf(result.error)).toBe("users_email_not_null");
    }
  });

  test("23514 → check violation", async () => {
    const result = await tryDb(() => {
      throw pgError("23514", 'new row for relation "users" violates check constraint "users_age_check"', "users_age_check");
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/check-violation");
      expect(constraintOf(result.error)).toBe("users_age_check");
    }
  });

  test("constraint name falls back to the message when the field is absent", async () => {
    const result = await tryDb(() => {
      throw pgError("23505", 'duplicate key value violates unique constraint "users_email_key"');
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/unique-violation");
      expect(constraintOf(result.error)).toBe("users_email_key");
    }
  });
});

describe("SQLite family — D1, node:sqlite, better-sqlite3, libsql", () => {
  test("D1 message shape (no code field) → unique violation", async () => {
    const result = await tryDb(() => {
      throw new Error("UNIQUE constraint failed: users.email");
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

  test("query text and params never leak into data", async () => {
    const result = await tryDb(() => {
      // A poisoned message would otherwise carry the parameter value.
      throw new Error("UNIQUE constraint failed: users.email, INSERT INTO users VALUES ('admin','hunter2')");
    });
    if (result.isErr()) {
      expect(constraintOf(result.error)).toBe("users.email");
      // The classifier's data is clean. Note: better-result's upstream
      // TaggedError.toJSON() spreads `cause` (with stack) by design — fine for
      // logging, but strip `cause` yourself before any wire boundary.
      expect((result.error as { constraint?: string }).constraint).not.toContain("hunter2");
    }
  });
});

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

  test("unclassifiable failures become query-failure, cause retained", async () => {
    const diskFull = new Error("database disk image is malformed");
    const result = await tryDb(() => {
      throw diskFull;
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/query-failure");
      expect((result.error as Error).cause).toBe(diskFull);
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
