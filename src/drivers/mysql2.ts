/**
 * db-result/mysql2 — mysql2 errors classify via `code: "ER_*"` (stable) with
 * `errno` fallback, gated on `sqlState`. MySQL has no `25P02`-style abort —
 * InnoDB rolls back the failed statement, not the transaction — so
 * `db/transaction-aborted` is excluded from the union.
 */
import {
  tryDb as coreTryDb,
  tryTx as coreTryTx,
  type DbError,
  type TransactionAborted,
  type TryDbFor,
  type TryTxFor,
} from "../db-result.js";

export type Mysql2DbError = Exclude<DbError, TransactionAborted>;

export const tryDb = coreTryDb as unknown as TryDbFor<Mysql2DbError>;
export const tryTx = coreTryTx as unknown as TryTxFor<Mysql2DbError>;

export * from "../db-result.js";
