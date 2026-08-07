/**
 * db-result/sqlite — the narrowest union. SQLite has no server authentication
 * (`db/authentication-failed` is impossible), no deadlock protocol (BUSY /
 * LOCKED are contention → `db/lock-timeout`, which is kept), and no
 * `25P02`-style transaction abort (SQLite keeps the transaction open after a
 * statement error — you must roll back yourself).
 */
import {
  tryDb as coreTryDb,
  tryTx as coreTryTx,
  type DbError,
  type AuthenticationFailed,
  type DeadlockError,
  type TransactionAborted,
  type DefaultLedger,
  type TryDbFor,
  type TryTxFor,
} from "../db-result.js";

export type SqliteDbError = Exclude<
  DbError,
  AuthenticationFailed | DeadlockError | TransactionAborted
>;

/** The sqlite union is the default ledger — no overrides needed. */
export type SqliteLedger = DefaultLedger;

export const tryDb = coreTryDb as unknown as TryDbFor<SqliteDbError, SqliteLedger>;
export const tryTx = coreTryTx as unknown as TryTxFor<SqliteDbError>;

export * from "../db-result.js";
