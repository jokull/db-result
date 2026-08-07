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
import type { Result } from "better-result";
import {
  tryDb,
  tryTx,
  isDbError,
  isUniqueViolation,
  isConnectionFailure,
  isConnectFailure,
  isConnectionLost,
  isRetriedError,
  isAuthenticationFailed,
  isAuthorizationFailed,
  isSqlSyntaxError,
  isQueryFailure,
  type DbError,
} from "./src/db-result.ts";

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
      expect(isConnectionLost(result.error)).toBe(true);
    }
  });

  test("08001 connect refused → connect-failure, retry-safe", async () => {
    const result = await tryDb(() => {
      throw pgError("08001", "could not establish connection");
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/connect-failure");
      expect(transientOf(result.error)).toBe(true);
      expect(isConnectFailure(result.error)).toBe(true);
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

describe("connection layer — Node system codes and pool/client messages", () => {
  test("ECONNREFUSED → connection-failure, transient", async () => {
    const result = await tryDb(
      () => {
        throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
          code: "ECONNREFUSED",
          errno: -61,
          syscall: "connect",
        });
      },
      { retryTransient: false },
    );
    if (result.isErr()) {
      expect(isConnectionFailure(result.error)).toBe(true);
      expect(transientOf(result.error)).toBe(true);
    }
  });

  test("ETIMEDOUT / ENOTFOUND / EAI_AGAIN → connection-failure", async () => {
    for (const code of ["ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"]) {
      const result = await tryDb(
        () => {
          throw Object.assign(new Error(`connect ${code}`), { code });
        },
        { retryTransient: false },
      );
      if (result.isErr()) {
        expect(isConnectionFailure(result.error)).toBe(true);
        expect(transientOf(result.error)).toBe(true);
      }
    }
  });

  test("TLS certificate failure → connection-failure, not transient", async () => {
    const result = await tryDb(() => {
      throw Object.assign(new Error("self-signed certificate"), {
        code: "DEPTH_ZERO_SELF_SIGNED_CERT",
      });
    });
    if (result.isErr()) {
      expect(isConnectionFailure(result.error)).toBe(true);
      expect(transientOf(result.error)).toBe(false);
    }
  });

  test("pool timeout message → connection-failure, transient", async () => {
    const result = await tryDb(
      () => {
        throw new Error("timeout exceeded when trying to connect");
      },
      { retryTransient: false },
    );
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

describe("message-only drivers — the code-stripping paths", () => {
  // aws-data-api (RDS Data API), xata-http, netlify-db, pg-proxy, neon-http:
  // the SQLSTATE code never reaches the error — only the PG message text.
  test("aws-data-api shape: message-only unique violation", async () => {
    const result = await tryDb(() => {
      throw Object.assign(
        new Error('duplicate key value violates unique constraint "users_email_key"'),
        {
          code: "BadRequestException",
          name: "BadRequestException",
        },
      );
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/unique-violation");
      expect(constraintOf(result.error)).toBe("users_email_key");
    }
  });

  test("message-only FK / not-null / check", async () => {
    const fk = await tryDb(() => {
      throw new Error(
        'insert or update on table "orders" violates foreign key constraint "orders_user_id_fkey"',
      );
    });
    if (fk.isErr()) {
      expect(fk.error._tag).toBe("db/foreign-key-violation");
      expect(constraintOf(fk.error)).toBe("orders_user_id_fkey");
    }

    const nn = await tryDb(() => {
      throw new Error(
        'null value in column "email" of relation "users" violates not-null constraint',
      );
    });
    if (nn.isErr()) expect(nn.error._tag).toBe("db/not-null-violation");

    const chk = await tryDb(() => {
      throw new Error('new row for relation "users" violates check constraint "users_age_check"');
    });
    if (chk.isErr()) {
      expect(chk.error._tag).toBe("db/check-violation");
      expect(constraintOf(chk.error)).toBe("users_age_check");
    }
  });

  test("message-only pg auth / authz / syntax / missing object", async () => {
    const authn = await tryDb(() => {
      throw new Error('password authentication failed for user "app"');
    });
    if (authn.isErr()) expect(authn.error._tag).toBe("db/authentication-failed");

    const authz = await tryDb(() => {
      throw new Error("permission denied for table users");
    });
    if (authz.isErr()) expect(authz.error._tag).toBe("db/authorization-failed");

    const syntax = await tryDb(() => {
      throw new Error('syntax error at or near "SELEC"');
    });
    if (syntax.isErr()) expect(syntax.error._tag).toBe("db/sql-syntax-error");

    const missing = await tryDb(() => {
      throw new Error('relation "users" does not exist');
    });
    if (missing.isErr()) expect(missing.error._tag).toBe("db/sql-syntax-error");
  });

  // planetscale-serverless / tidb-serverless / mysql-proxy: vitess/TiDB strip
  // the ER_* code; the mysql message text survives.
  test("planetscale shape: message-only duplicate entry", async () => {
    const result = await tryDb(() => {
      throw new Error("Duplicate entry 'a@b.com' for key 'users.email'");
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/unique-violation");
      expect(constraintOf(result.error)).toBe("users.email");
    }
  });

  test("message-only mysql FK / not-null / syntax / auth", async () => {
    const fk = await tryDb(() => {
      throw new Error("Cannot add or update a child row: a foreign key constraint fails");
    });
    if (fk.isErr()) expect(fk.error._tag).toBe("db/foreign-key-violation");

    const nn = await tryDb(() => {
      throw new Error("Column 'email' cannot be null");
    });
    if (nn.isErr()) expect(nn.error._tag).toBe("db/not-null-violation");

    const syntax = await tryDb(() => {
      throw new Error("You have an error in your SQL syntax; check the manual");
    });
    if (syntax.isErr()) expect(syntax.error._tag).toBe("db/sql-syntax-error");

    const authn = await tryDb(() => {
      throw new Error("Access denied for user 'app'@'localhost'");
    });
    if (authn.isErr()) expect(authn.error._tag).toBe("db/authentication-failed");
  });
});

describe("Turso Database (Rust engine) — message-only JS binding", () => {
  // `drizzle-orm/tursodatabase*` wraps the new Turso Database (codename
  // Limbo), not the libsql C fork. Its JS binding surfaces errors as plain
  // messages — MVCC write-write conflicts and plain busy are both transient
  // contention: retry the WHOLE transaction (tryTx); statement retry is
  // futile (the conflict aborted the tx), which the tx-shape's retry-off
  // already assumes.
  test("MVCC write-write conflict → db/lock-timeout, transient", async () => {
    const result = await tryDb(() => {
      throw new Error("Write-write conflict");
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/lock-timeout");
      expect(transientOf(result.error)).toBe(true);
    }
  });

  test("BusySnapshot → db/lock-timeout, transient", async () => {
    const result = await tryDb(() => {
      throw new Error(
        "Database snapshot is stale. You must rollback and retry the whole transaction.",
      );
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/lock-timeout");
      expect(transientOf(result.error)).toBe(true);
    }
  });

  test("message-only 'database is locked' → db/lock-timeout", async () => {
    const result = await tryDb(
      () => {
        throw new Error("database is locked");
      },
      { retryTransient: false },
    );
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/lock-timeout");
      expect(transientOf(result.error)).toBe(true);
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

describe("retry policy — retryTransient defaults to true, per-error defaults", () => {
  const deadlock = () => {
    throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
  };

  test("transient failures are retried by default with no config", async () => {
    let attempts = 0;
    const result = await tryDb(() => {
      attempts += 1;
      if (attempts < 3) deadlock();
      return "ok";
    });
    expect(result.isOk()).toBe(true);
    expect(attempts).toBe(3);
  });

  test("deterministic errors are never retried by default", async () => {
    let attempts = 0;
    const result = await tryDb(() => {
      attempts += 1;
      throw Object.assign(new Error("UNIQUE constraint failed: users.email"), {
        code: "SQLITE_CONSTRAINT_UNIQUE",
      });
    });
    expect(result.isErr()).toBe(true);
    expect(attempts).toBe(1);
  });

  test("ambiguous mid-query connection loss is never auto-retried", async () => {
    let attempts = 0;
    const result = await tryDb(() => {
      attempts += 1;
      throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    });
    expect(result.isErr()).toBe(true);
    expect(attempts).toBe(1);
    if (result.isErr()) {
      // still a hint: a custom policy may retry it deliberately
      expect((result.error as { potentiallyTransient?: boolean }).potentiallyTransient).toBe(true);
    }
  });

  test("connect-phase failures (ECONNREFUSED) are auto-retried", async () => {
    let attempts = 0;
    await tryDb(() => {
      attempts += 1;
      if (attempts < 2)
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      return "connected";
    });
    expect(attempts).toBe(2);
  });

  test("the split: connect-failure retries, connection-lost never does", async () => {
    let connectAttempts = 0;
    const connect = await tryDb(() => {
      connectAttempts += 1;
      if (connectAttempts < 2)
        throw Object.assign(new Error("connect ENETUNREACH"), { code: "ENETUNREACH" });
      return "ok";
    });
    expect(connect.isOk()).toBe(true);
    expect(connectAttempts).toBe(2);

    let lostAttempts = 0;
    const lost = await tryDb(() => {
      lostAttempts += 1;
      throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    });
    expect(lost.isErr()).toBe(true);
    expect(lostAttempts).toBe(1);
    if (lost.isErr()) {
      expect(lost.error._tag).toBe("db/connection-lost");
      expect(isConnectFailure(lost.error)).toBe(false);
      expect(isConnectionLost(lost.error)).toBe(true);
    }
  });

  test("retryTransient: false disables auto-retry", async () => {
    let attempts = 0;
    const result = await tryDb(
      () => {
        attempts += 1;
        deadlock();
      },
      { retryTransient: false },
    );
    expect(result.isErr()).toBe(true);
    expect(attempts).toBe(1);
  });

  test("explicit retry overrides the defaults", async () => {
    let attempts = 0;
    const result = await tryDb(
      () => {
        attempts += 1;
        deadlock();
      },
      { retry: { times: 2, delayMs: 1, backoff: "constant" } },
    );
    expect(result.isErr()).toBe(true);
    expect(attempts).toBe(3); // initial + 2 retries
  });

  test("explicit retry without shouldRetry still gets the safe gate", async () => {
    let attempts = 0;
    const result = await tryDb(
      () => {
        attempts += 1;
        throw Object.assign(new Error("UNIQUE constraint failed: users.email"), {
          code: "SQLITE_CONSTRAINT_UNIQUE",
        });
      },
      { retry: { times: 3, delayMs: 1, backoff: "constant" } },
    );
    expect(result.isErr()).toBe(true);
    expect(attempts).toBe(1);
  });

  test("custom shouldRetry is honored verbatim", async () => {
    let attempts = 0;
    const result = await tryDb(
      () => {
        attempts += 1;
        deadlock();
      },
      {
        retry: {
          times: 5,
          delayMs: 1,
          backoff: "constant",
          shouldRetry: (e) => e._tag === "db/deadlock",
        },
      },
    );
    expect(result.isErr()).toBe(true);
    expect(attempts).toBe(6); // initial + 5 retries
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

describe("prisma protocol — engine P-codes", () => {
  const prisma = (code: string, message: string, meta?: Record<string, unknown>) =>
    Object.assign(new Error(message), { code, clientVersion: "6.19.3", meta });

  test("P2002 → unique violation, constraint from meta.target", async () => {
    const result = await tryDb(() => {
      throw prisma("P2002", "Unique constraint failed on the fields: (`email`)", {
        target: ["email"],
      });
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/unique-violation");
      expect(constraintOf(result.error)).toBe("email");
    }
  });

  test("P2003 → foreign-key violation", async () => {
    const result = await tryDb(() => {
      throw prisma("P2003", "Foreign key constraint failed on the field: `userId`");
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/foreign-key-violation");
  });

  test("P2034 write conflict → db/deadlock, transient (Prisma says retry)", async () => {
    const result = await tryDb(() => {
      throw prisma(
        "P2034",
        "Transaction failed due to a write conflict or a deadlock. Please retry your transaction",
      );
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/deadlock");
      expect(transientOf(result.error)).toBe(true);
    }
  });

  test("P2028 interactive tx closed → transaction-aborted", async () => {
    const result = await tryDb(() => {
      throw prisma("P2028", "Transaction API error: Transaction already closed");
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/transaction-aborted");
  });

  test("P1001 → connect-failure, transient", async () => {
    const result = await tryDb(() => {
      throw prisma("P1001", "Can't reach database server at `localhost`");
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/connect-failure");
      expect(transientOf(result.error)).toBe(true);
    }
  });

  test("P2024 pool timeout / P2037 too-many-connections → connect-failure", async () => {
    for (const [code, message] of [
      ["P2024", "Timed out fetching a new connection from the connection pool"],
      ["P2037", "Too many database connections opened"],
    ] as const) {
      const result = await tryDb(() => {
        throw prisma(code, message);
      });
      if (result.isErr()) {
        expect(result.error._tag).toBe("db/connect-failure");
        expect(transientOf(result.error)).toBe(true);
      }
    }
  });

  test("P1017 server closed connection → connection-lost, never auto-retried", async () => {
    const result = await tryDb(() => {
      throw prisma("P1017", "Server has closed the connection");
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/connection-lost");
      expect(transientOf(result.error)).toBe(true);
    }
  });

  test("P1000 authentication failed / P1010 access denied", async () => {
    const authn = await tryDb(() => {
      throw prisma("P1000", "Authentication failed against database server");
    });
    if (authn.isErr()) expect(authn.error._tag).toBe("db/authentication-failed");

    const authz = await tryDb(() => {
      throw prisma("P1010", "User was denied access on the database");
    });
    if (authz.isErr()) expect(authz.error._tag).toBe("db/authorization-failed");
  });

  test("P2025 record-not-found → query-failure (not a tag; the caller's domain)", async () => {
    const result = await tryDb(() => {
      throw prisma("P2025", "An operation failed because it depends on one or more records");
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/query-failure");
  });
});

describe("builder values — the shape carrier and the retry unit", () => {
  test("a builder value retries by re-executing the builder", async () => {
    let attempts = 0;
    // Structural stand-in for a query builder (Kysely/Drizzle emit these);
    // the call is cast because the shape lattice rejects unproven shapes —
    // the runtime path is what's under test.
    const builder = {
      execute: () => {
        attempts += 1;
        if (attempts < 3) {
          return Promise.reject(Object.assign(new Error("deadlock detected"), { code: "40P01" }));
        }
        return Promise.resolve({ rowCount: 1 });
      },
    };
    const result = await (tryDb as unknown as (q: unknown) => Promise<Result<unknown, DbError>>)(
      builder,
    );
    expect(attempts).toBe(3); // re-executed per attempt, like a re-invoked thunk
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toEqual({ rowCount: 1 });
  });

  test("a builder value does not retry deterministic failures", async () => {
    let attempts = 0;
    const builder = {
      execute: () => {
        attempts += 1;
        return Promise.reject(
          Object.assign(new Error("UNIQUE constraint failed: users.email"), {
            code: "SQLITE_CONSTRAINT_UNIQUE",
          }),
        );
      },
    };
    const result = await (tryDb as unknown as (q: unknown) => Promise<Result<unknown, DbError>>)(
      builder,
    );
    expect(attempts).toBe(1);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error._tag).toBe("db/unique-violation");
  });

  test("an explicit retry still wins over the default policy", async () => {
    let attempts = 0;
    const builder = {
      execute: () => {
        attempts += 1;
        if (attempts < 2) {
          return Promise.reject(Object.assign(new Error("deadlock detected"), { code: "40P01" }));
        }
        return Promise.resolve("ok");
      },
    };
    const result = await (
      tryDb as unknown as (
        q: unknown,
        c: { retry: { times: number; delayMs: number; backoff: "constant" } },
      ) => Promise<Result<unknown, DbError>>
    )(builder, { retry: { times: 3, delayMs: 1, backoff: "constant" } });
    expect(attempts).toBe(2);
    expect(result.isOk()).toBe(true);
  });
});

describe("promise form — one-shot, no auto-retry", () => {
  test("a settled promise is never re-run", async () => {
    let runs = 0;
    const settled = Promise.resolve().then(() => {
      runs += 1;
      throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
    });
    const result = await tryDb(settled);
    expect(runs).toBe(1); // one-shot: no retry, no re-await
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error._tag).toBe("db/deadlock");
  });
});

describe("tryTx — whole-transaction retry", () => {
  test("deadlock retries the whole thunk (fresh transaction each attempt)", async () => {
    let attempts = 0;
    const result = await tryTx(() => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      return "committed";
    });
    expect(attempts).toBe(3);
    expect(result.isOk()).toBe(true);
  });

  test("ambiguous commit-outcome failures are never auto-retried", async () => {
    let attempts = 0;
    const result = await tryTx(() => {
      attempts += 1;
      throw Object.assign(new Error("Connection terminated unexpectedly"), {
        code: "ECONNRESET",
      });
    });
    expect(attempts).toBe(1);
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/connection-lost");
      expect(transientOf(result.error)).toBe(true); // a hint, never auto-retried
    }
  });

  test("deterministic errors are never retried", async () => {
    let attempts = 0;
    const result = await tryTx(() => {
      attempts += 1;
      throw Object.assign(new Error("UNIQUE constraint failed: users.email"), {
        code: "SQLITE_CONSTRAINT_UNIQUE",
      });
    });
    expect(attempts).toBe(1);
    if (result.isErr()) expect(result.error._tag).toBe("db/unique-violation");
  });

  test("retryTransient: false disables whole-thunk retry", async () => {
    let attempts = 0;
    const result = await tryTx(
      () => {
        attempts += 1;
        throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      },
      { retryTransient: false },
    );
    expect(attempts).toBe(1);
    expect(result.isErr()).toBe(true);
  });

  test("a failure that survived retries carries the attempt count", async () => {
    const result = await tryTx(() => {
      throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(isRetriedError(result.error)).toBe(true);
      if (isRetriedError(result.error)) expect(result.error.retries).toBe(4);
    }
  });
});
