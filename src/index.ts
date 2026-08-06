/**
 * db-result — classify database failures into tagged better-result errors.
 *
 * Core entry point: the protocol-detecting `tryDb` with shape-aware types,
 * the whole-transaction `tryTx`, the full 14-tag `DbError` vocabulary and
 * guards, and the shape lattice (`IsTxParam` + probes + `ShapeLedger`) that
 * narrows the error union from the thunk's parameter type.
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
