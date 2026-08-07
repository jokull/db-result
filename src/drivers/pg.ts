/**
 * db-result/pg — Postgres is the reference protocol: every tag in the union
 * is reachable (SQLSTATE covers constraints, auth, data errors, deadlocks,
 * lock timeouts, and `25P02` transaction aborts), so the union is the full
 * `DbError`. The narrow unions exist on the other subpaths. Shape narrowing
 * (query-builder probes) applies on top via the default ledger.
 */
import {
  tryDb as coreTryDb,
  tryTx as coreTryTx,
  type DbError,
  type TryDbFor,
  type TryTxFor,
} from "../db-result.js";

export type PgDbError = DbError;

export const tryDb = coreTryDb as unknown as TryDbFor<PgDbError>;
export const tryTx = coreTryTx as unknown as TryTxFor<PgDbError>;

export * from "../db-result.js";
