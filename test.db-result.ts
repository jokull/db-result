/**
 * Fixture tests — the exact error shapes the drivers produce, plus real
 * bun:sqlite (built into Bun, zero setup). Real-driver proof lives in the
 * integration files (Docker suite for pg/postgres.js/mysql2/mssql; embedded
 * engines for node:sqlite, better-sqlite3, libsql, D1/miniflare).
 *
 *   bun install
 *   bun test
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createClient } from "@libsql/client";
import {
  tryDb,
  isUniqueViolation,
  isConnectionFailure,
  isAuthenticationFailed,
  isAuthorizationFailed,
  isSqlSyntaxError,
  isQueryFailure,
  type DbError,
} from "./src/db-result.ts";

const constraintOf = (e: DbError): string => (e as { constraint?: string }).constraint ?? "";
const transientOf = (e: DbError): boolean => (e as { potentiallyTransient?: boolean }).potentiallyTransient ?? false;

describe("PostgreSQL protocol (SQLSTATE + constraint field)", () => {
  const pgError = (code: string, message: string, constraint?: string) =>
    Object.assign(new Error(message), { severity: "ERROR", code, constraint, schema: "public" });

  test("23505 → unique violation, constraint from the field", async () => {
    const result = await tryDb(() => {
      throw pgError("23505", 'duplicate key value violates unique constraint "users_email_key"', "users_email_key");
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
      throw pgError("23503", 'insert or update on table "orders" violates foreign key constraint "orders_user_id_fkey"', "orders_user_id_fkey");
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/foreign-key-violation");
  });

  test("23502 → not-null violation", async () => {
    const result = await tryDb(() => {
      throw pgError("23502", 'null value in column "email" of relation "users" violates not-null constraint', "users_email_not_null");
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/not-null-violation");
  });

  test("23514 → check violation", async () => {
    const result = await tryDb(() => {
      throw pgError("23514", 'new row for relation "users" violates check constraint "users_age_check"', "users_age_check");
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

  test("08xxx connection SQLSTATE → connection-failure, transient", async () => {
    const result = await tryDb(() => {
      throw pgError("08006", 'terminating connection due to administrator command');
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/connection-failure");
      expect(transientOf(result.error)).toBe(true);
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
      throw pgError("42501", 'permission denied for table users');
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/authorization-failed");
  });

  test("42601 → sql-syntax-error", async () => {
    const result = await tryDb(() => {
      throw pgError("42601", 'syntax error at or near "SELEC"');
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/sql-syntax-error");
  });

  test("40P01 deadlock → query-failure with transient hint", async () => {
    const result = await tryDb(() => {
      throw pgError("40P01", "deadlock detected");
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/query-failure");
      expect(transientOf(result.error)).toBe(true);
    }
  });

  test("53300 too-many-connections → transient (the one Effect misses)", async () => {
    const result = await tryDb(() => {
      throw pgError("53300", "sorry, too many clients already");
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/query-failure");
      expect(transientOf(result.error)).toBe(true);
    }
  });

  test("unrecognised SQLSTATE → query-failure (still a pg failure)", async () => {
    const result = await tryDb(() => {
      throw pgError("22001", "value too long for type character varying(255)");
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/query-failure");
      expect(transientOf(result.error)).toBe(false);
    }
  });
});

describe("connection layer — Node system codes and pool/client messages", () => {
  test("ECONNREFUSED → connection-failure, transient", async () => {
    const result = await tryDb(() => {
      throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
        code: "ECONNREFUSED", errno: -61, syscall: "connect",
      });
    });
    if (result.isErr()) {
      expect(isConnectionFailure(result.error)).toBe(true);
      expect(transientOf(result.error)).toBe(true);
    }
  });

  test("ETIMEDOUT / ENOTFOUND / EAI_AGAIN → connection-failure", async () => {
    for (const code of ["ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"]) {
      const result = await tryDb(() => {
        throw Object.assign(new Error(`connect ${code}`), { code });
      });
      if (result.isErr()) {
        expect(isConnectionFailure(result.error)).toBe(true);
        expect(transientOf(result.error)).toBe(true);
      }
    }
  });

  test("TLS certificate failure → connection-failure, not transient", async () => {
    const result = await tryDb(() => {
      throw Object.assign(new Error("self-signed certificate"), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    });
    if (result.isErr()) {
      expect(isConnectionFailure(result.error)).toBe(true);
      expect(transientOf(result.error)).toBe(false);
    }
  });

  test("pool timeout message → connection-failure, transient", async () => {
    const result = await tryDb(() => {
      throw new Error("timeout exceeded when trying to connect");
    });
    if (result.isErr()) {
      expect(isConnectionFailure(result.error)).toBe(true);
      expect(transientOf(result.error)).toBe(true);
    }
  });

  test("'Connection terminated unexpectedly' → connection-failure", async () => {
    const result = await tryDb(() => {
      throw new Error("Connection terminated unexpectedly");
    });
    if (result.isErr()) expect(isConnectionFailure(result.error)).toBe(true);
  });
});

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
    const driver = new Error("UNIQUE constraint failed: users.email (code 2067 SQLITE_CONSTRAINT_UNIQUE[2067])");
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
        code: "ERR_SQLITE_ERROR", errcode: 2067, errstr: "constraint failed",
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
        name: "LibsqlError", code: "SQLITE_ERROR", extendedCode: "SQLITE_CONSTRAINT_PRIMARYKEY", rawCode: 1555,
      });
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/unique-violation");
  });

  test("libsql network error → connection-failure", async () => {
    const result = await tryDb(() => {
      throw Object.assign(new Error("CLIENT_NETWORK_ERROR: failed to connect"), {
        name: "LibsqlError", code: "CLIENT_NETWORK_ERROR",
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
        code: "ERR_SQLITE_ERROR", errcode: 787,
      });
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/foreign-key-violation");
  });

  test("not-null (errcode 1299)", async () => {
    const result = await tryDb(() => {
      throw Object.assign(new Error("NOT NULL constraint failed: users.email"), {
        code: "ERR_SQLITE_ERROR", errcode: 1299,
      });
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/not-null-violation");
  });

  test("check (errcode 275)", async () => {
    const result = await tryDb(() => {
      throw Object.assign(new Error("CHECK constraint failed: users.age"), {
        code: "ERR_SQLITE_ERROR", errcode: 275,
      });
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/check-violation");
  });

  test("SQLITE_BUSY → query-failure with transient hint (retry by policy)", async () => {
    const result = await tryDb(() => {
      throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/query-failure");
      expect(transientOf(result.error)).toBe(true);
    }
  });

  test("SQLITE_PERM → authorization-failed (permission, not identity)", async () => {
    const result = await tryDb(() => {
      throw Object.assign(new Error("attempt to write a readonly database"), { code: "SQLITE_PERM" });
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
      throw new Error("UNIQUE constraint failed: users.email, INSERT INTO users VALUES ('admin','hunter2')");
    });
    if (result.isErr()) {
      expect(constraintOf(result.error)).toBe("users.email");
      expect((result.error as { constraint?: string }).constraint).not.toContain("hunter2");
    }
  });
});

describe("guards", () => {
  test("isUniqueViolation narrows correctly", async () => {
    const dupe = await tryDb(() => {
      throw Object.assign(new Error("UNIQUE constraint failed: users.email"), { code: "SQLITE_CONSTRAINT_UNIQUE" });
    });
    const conn = await tryDb(() => {
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    });
    if (dupe.isErr()) {
      expect(isUniqueViolation(dupe.error)).toBe(true);
      expect(isConnectionFailure(dupe.error)).toBe(false);
      if (isUniqueViolation(dupe.error)) expect(dupe.error.constraint).toContain("users");
    }
    if (conn.isErr()) expect(isConnectionFailure(conn.error)).toBe(true);
    for (const g of [isAuthenticationFailed, isAuthorizationFailed, isSqlSyntaxError, isQueryFailure]) {
      expect(g(null)).toBe(false);
    }
  });
});

describe("cause-chain unwrapping", () => {
  test("sees through a DrizzleQueryError-style wrapper", async () => {
    const driverError = Object.assign(new Error("UNIQUE constraint failed: users.email"), {
      code: "ERR_SQLITE_ERROR", errcode: 2067, errstr: "constraint failed",
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
    await expect(tryDb(() => { throw fsError; })).rejects.toBeDefined();
  });

  test("mysql2 errors are not misclassified by the core (driver modules own them)", async () => {
    const mysql = Object.assign(new Error("Duplicate entry 'a@b.com' for key 'users.email'"), {
      code: "ER_DUP_ENTRY", errno: 1062, sqlState: "23000",
    });
    await expect(tryDb(() => { throw mysql; })).rejects.toBeDefined();
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

describe("retry config passthrough (better-result RetryConfig)", () => {
  test("shouldRetry reads the potentiallyTransient hint", async () => {
    let attempts = 0;
    const result = await tryDb(
      () => {
        attempts += 1;
        if (attempts < 3) {
          throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
        }
        return "ok";
      },
      {
        retry: {
          times: 3,
          delayMs: 1,
          backoff: "constant",
          shouldRetry: (e) => e.potentiallyTransient === true,
        },
      },
    );
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toBe("ok");
  });

  test("non-transient errors are not retried", async () => {
    let attempts = 0;
    const result = await tryDb(
      () => {
        attempts += 1;
        throw Object.assign(new Error("UNIQUE constraint failed: users.email"), { code: "SQLITE_CONSTRAINT_UNIQUE" });
      },
      {
        retry: {
          times: 3,
          delayMs: 1,
          backoff: "constant",
          shouldRetry: (e) => e.potentiallyTransient === true,
        },
      },
    );
    expect(result.isErr()).toBe(true);
    expect(attempts).toBe(1);
  });
});
