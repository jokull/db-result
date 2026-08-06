/**
 * db-result/sqlite — the narrowest union. SQLite has no server authentication
 * (`db/authentication-failed` is impossible), no deadlock protocol (BUSY /
 * LOCKED are contention → `db/lock-timeout`, which is kept), and no
 * `25P02`-style transaction abort (SQLite keeps the transaction open after a
 * statement error — you must roll back yourself).
 *
 * Ledger override: the default transaction shape drops `connect-failure`
 * (connect-phase is impossible inside a transaction) — but a SQLite tx
 * callback can still `ATTACH DATABASE`, which fires CANTOPEN mid-query, so
 * `connect-failure` STAYS possible inside SQLite transactions. The shape
 * lattice is honest per driver, never generic.
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

/** SQLite keeps `connect-failure` inside transactions — see the header. */
export type SqliteLedger = Omit<DefaultLedger, "transaction"> & {
  transaction: AuthenticationFailed;
};

export const tryDb = coreTryDb as unknown as TryDbFor<SqliteDbError, SqliteLedger>;
export const tryTx = coreTryTx as unknown as TryTxFor<SqliteDbError>;

export * from "../db-result.js";
