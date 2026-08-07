/**
 * Real-driver integration proof — one suite per engine, each gated on its
 * DSN (skipped when unset):
 *
 *   docker compose up -d --wait
 *   PGTEST_DSN="postgres://postgres:postgres@127.0.0.1:5433/postgres" \
 *   MYSQLTEST_DSN="mysql://root:root@127.0.0.1:3307" \
 *   MSSQLTEST_DSN="mssql://sa:DbResult!Passw0rd@127.0.0.1:1434/master" \
 *   bun run test:integration
 *   docker compose down
 */
import { describe, expect, test } from "bun:test";
import pg from "pg";
import mysql from "mysql2/promise";
import mssql from "mssql";
import { tryDb } from "./src/db-result.ts";
import { pgTable, text, integer } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import { drizzleTryDb } from "./src/drizzle.ts";

const wrapUsers = pgTable("wrap_users", {
  id: integer("id").primaryKey(),
  email: text("email"),
});

// ─── PostgreSQL ──────────────────────────────────────────────────────────────

const describePg = process.env.PGTEST_DSN ? describe : describe.skip;

describePg("real node-postgres", () => {
  test("unique, foreign-key, not-null and check constraints classify correctly", async () => {
    const pool = new pg.Pool({ connectionString: process.env.PGTEST_DSN });
    const client = await pool.connect();
    try {
      await client.query("DROP TABLE IF EXISTS orders");
      await client.query("DROP TABLE IF EXISTS users");
      await client.query(`
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email TEXT NOT NULL UNIQUE,
          age INTEGER CHECK (age >= 0)
        )`);
      await client.query(`
        CREATE TABLE orders (
          id SERIAL PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id)
        )`);

      const first = await tryDb(
        client.query("INSERT INTO users (email, age) VALUES ($1, $2) RETURNING id", [
          "a@b.com",
          30,
        ]),
      );
      expect(first.isOk()).toBe(true);

      const dupe = await tryDb(
        client.query("INSERT INTO users (email, age) VALUES ($1, $2)", ["a@b.com", 40]),
      );
      expect(dupe.isErr()).toBe(true);
      if (dupe.isErr()) {
        expect(dupe.error._tag).toBe("db/unique-violation");
        expect((dupe.error as { constraint?: string }).constraint).toBe("users_email_key");
      }

      const fk = await tryDb(client.query("INSERT INTO orders (user_id) VALUES ($1)", [999999]));
      expect(fk.isErr()).toBe(true);
      if (fk.isErr()) {
        expect(fk.error._tag).toBe("db/foreign-key-violation");
        expect((fk.error as { constraint?: string }).constraint).toBe("orders_user_id_fkey");
      }

      const nn = await tryDb(client.query("INSERT INTO users (age) VALUES (1)"));
      expect(nn.isErr()).toBe(true);
      if (nn.isErr()) expect(nn.error._tag).toBe("db/not-null-violation");

      const chk = await tryDb(
        client.query("INSERT INTO users (email, age) VALUES ($1, $2)", ["c@d.com", -5]),
      );
      expect(chk.isErr()).toBe(true);
      if (chk.isErr()) expect(chk.error._tag).toBe("db/check-violation");

      if (dupe.isErr()) {
        const cause = (dupe.error as Error).cause;
        expect(cause).toBeInstanceOf(Error);
        expect((cause as { code?: string }).code).toBe("23505");
      }
    } finally {
      client.release();
      await pool.end();
    }
  });

  test("data errors, aborted transactions and auth failures classify", async () => {
    const pool = new pg.Pool({ connectionString: process.env.PGTEST_DSN });
    const client = await pool.connect();
    try {
      // 22001 — value too long for the column type
      await client.query("DROP TABLE IF EXISTS short_text");
      await client.query("CREATE TABLE short_text (v VARCHAR(5))");
      const tooLong = await tryDb(
        client.query("INSERT INTO short_text (v) VALUES ($1)", ["x".repeat(10)]),
      );
      expect(tooLong.isErr()).toBe(true);
      if (tooLong.isErr()) {
        expect(tooLong.error._tag).toBe("db/data-error");
        // deterministic tags carry no transient hint at all
        expect((tooLong.error as { potentiallyTransient?: boolean }).potentiallyTransient).toBe(
          undefined,
        );
      }

      // 25P02 — a failed statement aborts the transaction; the next one is dead
      await client.query("BEGIN");
      const poison = await tryDb(
        client.query("INSERT INTO users (email, age) VALUES ($1, $2)", ["x@y.com", -5]),
      );
      expect(poison.isErr()).toBe(true);
      if (poison.isErr()) expect(poison.error._tag).toBe("db/check-violation");
      const aborted = await tryDb(
        client.query("INSERT INTO users (email, age) VALUES ($1, $2)", ["y@z.com", 5]),
      );
      expect(aborted.isErr()).toBe(true);
      if (aborted.isErr()) expect(aborted.error._tag).toBe("db/transaction-aborted");
      await client.query("ROLLBACK");
    } finally {
      client.release();
      await pool.end();
    }

    // 28P01 — bad credentials reject at connect with a SQLSTATE
    const badPool = new pg.Pool({
      connectionString: process.env.PGTEST_DSN!.replace(/:\/\/[^@]+@/, "://postgres:wrong@"),
    });
    const auth = await tryDb(badPool.connect());
    expect(auth.isErr()).toBe(true);
    if (auth.isErr()) expect(auth.error._tag).toBe("db/authentication-failed");
    await badPool.end();
  });
});

// ─── drizzleTryDb — the E-tracked wrapper ────────────────────────────────────

describePg("drizzleTryDb — the E-tracked wrapper", () => {
  test("wrapped select/insert execute to Result with retry and narrowing", async () => {
    const pool = new pg.Pool({ connectionString: process.env.PGTEST_DSN });
    const client = await pool.connect();
    try {
      await client.query("DROP TABLE IF EXISTS wrap_users");
      await client.query(`
        CREATE TABLE wrap_users (
          id SERIAL PRIMARY KEY,
          email TEXT NOT NULL UNIQUE
        )`);
      const db = drizzleTryDb(
        drizzle({ connection: { connectionString: process.env.PGTEST_DSN } }),
      );

      // insert through the wrapped builder — Result out, unique violation in
      const ins = await db.insert(wrapUsers).values({ id: 1, email: "a@b.c" }).execute();
      expect(ins.isOk()).toBe(true);
      const dupe = await db.insert(wrapUsers).values({ id: 2, email: "a@b.c" }).execute();
      expect(dupe.isErr()).toBe(true);
      if (dupe.isErr()) expect(dupe.error._tag).toBe("db/unique-violation");

      // select through the wrapped chain — Result out
      const rows = await db.select({ id: wrapUsers.id, email: wrapUsers.email }).from(wrapUsers);
      expect(rows.isOk()).toBe(true);
      if (rows.isOk()) expect(rows.value.length).toBe(1);

      // awaiting the builder directly also resolves a Result
      const awaited = await db.select({ id: wrapUsers.id }).from(wrapUsers);
      expect(awaited.isOk()).toBe(true);

      // whole transaction through the wrapper — Result out, no stray rollback
      const tx = await db.transaction(async (tx) => {
        const r = await tx.insert(wrapUsers).values({ id: 3, email: "b@c.d" }).execute();
        if (r.isErr()) return r;
        return r.value;
      });
      expect(tx.isOk()).toBe(true);
      const count = await client.query("SELECT count(*)::int AS n FROM wrap_users");
      expect(count.rows[0].n).toBe(2); // insert + tx insert

      // a transient failure retries through the wrapper (re-executes the builder)
      let attempts = 0;
      const fake = drizzleTryDb({
        select: () => ({
          from: () => ({
            execute: () => {
              attempts += 1;
              if (attempts < 2) {
                return Promise.reject(
                  Object.assign(new Error("deadlock detected"), { code: "40P01" }),
                );
              }
              return Promise.resolve([{ id: 1 }]);
            },
          }),
        }),
      } as never);
      const retried = await (fake as any).select().from({}).execute();
      expect(attempts).toBe(2);
      expect(retried.isOk()).toBe(true);
    } finally {
      await client.release();
      await pool.end();
    }
  });
});

// ─── MySQL ───────────────────────────────────────────────────────────────────

const describeMysql = process.env.MYSQLTEST_DSN ? describe : describe.skip;

describeMysql("real mysql2", () => {
  test("constraints, data errors and syntax classify correctly", async () => {
    const dsn = process.env.MYSQLTEST_DSN!;
    const admin = await mysql.createConnection(dsn);
    await admin.query("CREATE DATABASE IF NOT EXISTS dbtest");
    await admin.end();

    const pool = mysql.createPool(`${dsn}/dbtest`);
    try {
      await pool.query("DROP TABLE IF EXISTS orders");
      await pool.query("DROP TABLE IF EXISTS users");
      await pool.query(`
        CREATE TABLE users (
          id INT AUTO_INCREMENT PRIMARY KEY,
          email VARCHAR(255) NOT NULL UNIQUE,
          age INT CHECK (age >= 0),
          name VARCHAR(5)
        )`);
      await pool.query(`
        CREATE TABLE orders (
          id INT AUTO_INCREMENT PRIMARY KEY,
          user_id INT NOT NULL,
          CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id)
        )`);

      const first = await tryDb(
        pool.query("INSERT INTO users (email, age, name) VALUES (?, ?, ?)", ["a@b.com", 30, "ab"]),
      );
      expect(first.isOk()).toBe(true);

      const dupe = await tryDb(
        pool.query("INSERT INTO users (email, age, name) VALUES (?, ?, ?)", ["a@b.com", 40, "ab"]),
      );
      expect(dupe.isErr()).toBe(true);
      if (dupe.isErr()) expect(dupe.error._tag).toBe("db/unique-violation");

      const fk = await tryDb(pool.query("INSERT INTO orders (user_id) VALUES (?)", [999999]));
      expect(fk.isErr()).toBe(true);
      if (fk.isErr()) expect(fk.error._tag).toBe("db/foreign-key-violation");

      const nn = await tryDb(
        pool.query("INSERT INTO users (email, age, name) VALUES (NULL, 1, 'ab')"),
      );
      expect(nn.isErr()).toBe(true);
      if (nn.isErr()) expect(nn.error._tag).toBe("db/not-null-violation");

      const chk = await tryDb(
        pool.query("INSERT INTO users (email, age, name) VALUES (?, ?, ?)", ["c@d.com", -5, "ab"]),
      );
      expect(chk.isErr()).toBe(true);
      if (chk.isErr()) expect(chk.error._tag).toBe("db/check-violation");

      const data = await tryDb(
        pool.query("INSERT INTO users (email, age, name) VALUES (?, ?, ?)", [
          "e@f.com",
          1,
          "toolong",
        ]),
      );
      expect(data.isErr()).toBe(true);
      if (data.isErr()) expect(data.error._tag).toBe("db/data-error");

      const syntax = await tryDb(pool.query("SELEC 1"));
      expect(syntax.isErr()).toBe(true);
      if (syntax.isErr()) expect(syntax.error._tag).toBe("db/sql-syntax-error");
    } finally {
      await pool.end();
    }
  });

  test("auth failures classify at connect", async () => {
    const bad = mysql.createPool(
      process.env.MYSQLTEST_DSN!.replace(/:\/\/[^@]+@/, "://root:wrong@"),
    );
    const auth = await tryDb(bad.query("SELECT 1"));
    expect(auth.isErr()).toBe(true);
    if (auth.isErr()) expect(auth.error._tag).toBe("db/authentication-failed");
    await bad.end();
  });
});

// ─── SQL Server ──────────────────────────────────────────────────────────────

const describeMssql = process.env.MSSQLTEST_DSN ? describe : describe.skip;

describeMssql("real mssql", () => {
  // describe.skip still runs this callback (bun collects test names), so no
  // collection-time work may touch the (possibly unset) DSN.
  const baseConfig = () => {
    const url = new URL(process.env.MSSQLTEST_DSN!);
    return {
      server: url.hostname,
      port: Number(url.port || 1433),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      options: { trustServerCertificate: true } as const,
    };
  };

  test("constraints, data errors and syntax classify correctly", async () => {
    const master = await mssql.connect({ ...baseConfig(), database: "master" });
    await master.request().query("IF DB_ID(N'dbtest') IS NULL CREATE DATABASE dbtest");
    await master.close();

    const pool = await mssql.connect({ ...baseConfig(), database: "dbtest" });
    try {
      await pool
        .request()
        .query("IF OBJECT_ID(N'dbo.orders', N'U') IS NOT NULL DROP TABLE dbo.orders");
      await pool
        .request()
        .query("IF OBJECT_ID(N'dbo.users', N'U') IS NOT NULL DROP TABLE dbo.users");
      await pool.request().query(`
        CREATE TABLE dbo.users (
          id INT IDENTITY PRIMARY KEY,
          email NVARCHAR(255) NOT NULL UNIQUE,
          age INT CHECK (age >= 0),
          n INT
        )`);
      await pool.request().query(`
        CREATE TABLE dbo.orders (
          id INT IDENTITY PRIMARY KEY,
          user_id INT NOT NULL,
          CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES dbo.users(id)
        )`);

      const first = await tryDb(
        pool.request().query("INSERT INTO dbo.users (email, age, n) VALUES ('a@b.com', 30, 1)"),
      );
      expect(first.isOk()).toBe(true);

      const dupe = await tryDb(
        pool.request().query("INSERT INTO dbo.users (email, age, n) VALUES ('a@b.com', 40, 1)"),
      );
      expect(dupe.isErr()).toBe(true);
      if (dupe.isErr()) expect(dupe.error._tag).toBe("db/unique-violation");

      const fk = await tryDb(
        pool.request().query("INSERT INTO dbo.orders (user_id) VALUES (999999)"),
      );
      expect(fk.isErr()).toBe(true);
      if (fk.isErr()) expect(fk.error._tag).toBe("db/foreign-key-violation");

      const nn = await tryDb(pool.request().query("INSERT INTO dbo.users (age, n) VALUES (1, 1)"));
      expect(nn.isErr()).toBe(true);
      if (nn.isErr()) expect(nn.error._tag).toBe("db/not-null-violation");

      const chk = await tryDb(
        pool.request().query("INSERT INTO dbo.users (email, age, n) VALUES ('c@d.com', -5, 1)"),
      );
      expect(chk.isErr()).toBe(true);
      if (chk.isErr()) expect(chk.error._tag).toBe("db/check-violation");

      const data = await tryDb(
        pool
          .request()
          .query("INSERT INTO dbo.users (email, age, n) VALUES ('e@f.com', 1, 2147483648)"),
      );
      expect(data.isErr()).toBe(true);
      if (data.isErr()) expect(data.error._tag).toBe("db/data-error");

      const syntax = await tryDb(pool.request().query("SELEC * FROM dbo.users"));
      expect(syntax.isErr()).toBe(true);
      if (syntax.isErr()) expect(syntax.error._tag).toBe("db/sql-syntax-error");
    } finally {
      await pool.close();
    }
  });

  test("auth failures classify at connect", async () => {
    const auth = await tryDb(() => mssql.connect({ ...baseConfig(), password: "Wrong!Passw0rd" }));
    expect(auth.isErr()).toBe(true);
    if (auth.isErr()) expect(auth.error._tag).toBe("db/authentication-failed");
  });
});
