/**
 * db-result/mssql — mssql errors classify via tedious's positive integer
 * `number` field (2627/2601 unique, 547 FK, 515 not-null, 1205 deadlock
 * victim, 1222 lock timeout, 18456 login failed, …). `db/transaction-aborted`
 * is excluded: no equivalent abort signal is verified yet — a doomed
 * transaction (`XACT_STATE = -1`) has no stable error number in the current
 * table.
 */
import {
  tryDb as coreTryDb,
  tryTx as coreTryTx,
  type DbError,
  type TransactionAborted,
  type TryDbFor,
  type TryTxFor,
} from "../db-result.js";

export type MssqlDbError = Exclude<DbError, TransactionAborted>;

export const tryDb = coreTryDb as unknown as TryDbFor<MssqlDbError>;
export const tryTx = coreTryTx as unknown as TryTxFor<MssqlDbError>;

export * from "../db-result.js";
