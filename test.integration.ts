/**
 * Real-driver integration proof — node-postgres (pg) against a scratch
 * Postgres. Requires PGTEST_DSN:
 *
 *   PGTEST_DSN="postgres://postgres@127.0.0.1:5433/postgres" bun test test.integration.ts
 */
import { describe, expect, test } from "bun:test";
import pg from "pg";
import { tryDb } from "./db-result.ts";

const dsn = process.env.PGTEST_DSN;
const describeReal = dsn ? describe : describe.skip;

describeReal("real node-postgres", () => {
  test("unique, foreign-key, not-null and check constraints classify correctly", async () => {
    const pool = new pg.Pool({ connectionString: dsn });
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

      // Baseline: a clean insert is Ok with the row.
      const first = await tryDb(client.query("INSERT INTO users (email, age) VALUES ($1, $2) RETURNING id", ["a@b.com", 30]));
      expect(first.isOk()).toBe(true);

      // Unique violation — the canonical "attempt the insert" race check.
      const dupe = await tryDb(client.query("INSERT INTO users (email, age) VALUES ($1, $2)", ["a@b.com", 40]));
      expect(dupe.isErr()).toBe(true);
      if (dupe.isErr()) {
        expect(dupe.error._tag).toBe("db/unique-violation");
        expect((dupe.error as { constraint?: string }).constraint).toBe("users_email_key");
      }

      // Foreign key — referenced row does not exist.
      const fk = await tryDb(client.query("INSERT INTO orders (user_id) VALUES ($1)", [999999]));
      expect(fk.isErr()).toBe(true);
      if (fk.isErr()) {
        expect(fk.error._tag).toBe("db/foreign-key-violation");
        expect((fk.error as { constraint?: string }).constraint).toBe("orders_user_id_fkey");
      }

      // Not-null.
      const nn = await tryDb(client.query("INSERT INTO users (age) VALUES (1)"));
      expect(nn.isErr()).toBe(true);
      if (nn.isErr()) {
        expect(nn.error._tag).toBe("db/not-null-violation");
      }

      // Check.
      const chk = await tryDb(client.query("INSERT INTO users (email, age) VALUES ($1, $2)", ["c@d.com", -5]));
      expect(chk.isErr()).toBe(true);
      if (chk.isErr()) {
        expect(chk.error._tag).toBe("db/check-violation");
      }

      // The original driver error stays reachable via cause for observability.
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
});
