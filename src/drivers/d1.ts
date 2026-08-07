/**
 * db-result/d1 — Cloudflare D1 is SQLite at the edge: the classifier already
 * speaks D1's `D1_ERROR: … (code NNNN SQLITE_CONSTRAINT_*)` message shapes
 * through the SQLite protocol, so this entry point is the sqlite surface
 * under its own name — same union (`D1DbError`), same ledger.
 */
import type { SqliteDbError } from "./sqlite.js";

export type D1DbError = SqliteDbError;

export * from "./sqlite.js";
