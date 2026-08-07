import { describe, expect, test } from "bun:test";
import { tryDb, type DbError } from "../db-result.js";

const constraintOf = (e: DbError): string => (e as { constraint?: string }).constraint ?? "";
const transientOf = (e: DbError): boolean =>
  (e as { potentiallyTransient?: boolean }).potentiallyTransient ?? false;

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
