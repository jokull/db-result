/**
 * db-result — classify database failures into tagged better-result errors.
 *
 * Core entry point: the protocol-detecting `tryDb` with shape-aware types,
 * the whole-transaction `tryTx`, the full 14-tag `DbError` vocabulary and
 * guards, and the shape lattice — structural probes of the query value's own
 * type (Kysely's builder surface, Drizzle's clause surface) classify it as
 * read / write / delete / opaque, and `ShapeLedger` narrows the error union
 * to the tags that shape provably cannot produce (see `ShapeOfQuery` /
 * `ShapeUnion` in db-result.ts).
 *
 * Per-driver entry points narrow the error union by protocol and export
 * driver-typed `tryDb` / `tryTx` variants, each with its own ledger:
 *
 *   db-result/pg       — full union (Postgres can produce every tag)
 *   db-result/sqlite   — no authentication-failed / deadlock / transaction-
 *                        aborted; keeps connect-failure inside transactions
 *                        (ATTACH) via `SqliteLedger`
 *   db-result/d1       — Cloudflare D1: the sqlite surface under its own name
 *   db-result/mysql2   — no transaction-aborted
 *   db-result/mssql    — no transaction-aborted (unverified abort signal)
 */
export * from "./db-result.js";
