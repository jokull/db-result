/**
 * Type-level tests for the shape lattice — compile-only, checked by
 * `tsc --noEmit`, never executed.
 *
 * The lattice reads the thunk's *parameter type* as evidence of what the
 * query can and cannot do, then narrows the error union to the tags that
 * shape provably cannot produce (see `ShapeLedger` — the "no lying types"
 * contract). Every row of the matrix is asserted twice:
 *
 *   1. the probe classifies the REAL ORM type as the right shape
 *   2. `tryDb`'s return union excludes exactly the ledger's tags for that
 *      shape (union membership / absence asserts)
 *
 * Plus the fail-loud rules: a one-arg thunk whose parameter proves no shape
 * does not compile, and zero-arg thunks keep the full driver union.
 *
 * Imports are the real published ORM types — Kysely 0.29 builders, Drizzle
 * 1.0.0-rc.4 pg-core builders, and the generated Prisma 6.19.3 client
 * (`bunx prisma generate`, schema in ./prisma) — so a probe that drifts from
 * an ORM's actual surface fails this file.
 *
 * Assertion pattern: every check is `Assert<…>` — a conditional constrained
 * to `true`, so a failing row is a compile error. Helpers return plain
 * `true | false`; the `Assert` wrapper enforces the result at the use site
 * (a `true | never` helper would fail silently through a `never` alias).
 */
import { tryDb, tryTx, type ShapeOf, type ShapeOfParam, type DbError } from "./src/db-result.ts";
import type {
  AuthenticationFailed,
  CheckViolation,
  ConnectFailure,
  ConnectionLost,
  DataError,
  DeadlockError,
  ForeignKeyViolation,
  NotNullViolation,
  QueryFailure,
  TransactionAborted,
  UniqueViolation,
} from "./src/db-result.ts";
import {
  tryDb as sqliteTryDb,
  type SqliteDbError,
  type SqliteLedger,
} from "./src/drivers/sqlite.ts";
import type {
  Kysely,
  SelectQueryBuilder,
  InsertQueryBuilder,
  UpdateQueryBuilder,
  DeleteQueryBuilder,
  MergeQueryBuilder,
  Transaction,
  RawBuilder,
} from "kysely";
import type {
  PgAsyncTransaction,
  PgQueryResultHKT,
  PgSelect,
  PgInsert,
  PgUpdate,
  PgDelete,
} from "drizzle-orm/pg-core";
import type { Prisma } from "@prisma/client";
import type { Result } from "better-result";

// ─── Assertion helpers ───────────────────────────────────────────────────────

type Assert<T extends true> = T;
/** Probe classification — the library's own `ShapeOfParam` (no mirror to
 * drift). Plain `true | false`; the use site wraps it in `Assert`. */
type AssertShape<P, S extends string> = ShapeOfParam<P> extends S ? true : false;
/** `T` is a member of the union `U`. */
type Member<T, U> = [T] extends [U] ? true : false;
/** `T` is NOT a member of the union `U`. */
type Absent<T, U> = [T] extends [U] ? false : true;
/** `U` and `V` are the same union. */
type Same<U, V> = [U] extends [V] ? ([V] extends [U] ? true : false) : false;

/** The error union of a `tryDb` call: `Promise<Result<T, E>>` → `E`. */
type ErrOf<R> = R extends Promise<Result<unknown, infer E>> ? E : never;

// The tag classes, for readable asserts.
type Unique = UniqueViolation;
type Fk = ForeignKeyViolation;
type NotNull = NotNullViolation;
type Check = CheckViolation;
type Authn = AuthenticationFailed;
type Connect = ConnectFailure;
type Lost = ConnectionLost;
type TxAborted = TransactionAborted;
type Deadlock = DeadlockError;
type Data = DataError;
type QueryFail = QueryFailure;

interface DB {
  users: { id: number; email: string };
}

// ─── Kysely 0.29 — every documented builder shape ────────────────────────────

// transaction: begin succeeded → authn + connect-failure impossible; the tx
// can still abort (25P02) and the channel can still die mid-query.
const kyselyTx = tryDb((tx: Transaction<DB>) => {
  void tx;
  return 1;
});
type KyselyTxErr = ErrOf<typeof kyselyTx>;
type _kT0 = Assert<AssertShape<Transaction<DB>, "transaction">>;
type _kT1 = Assert<Absent<Authn, KyselyTxErr>>;
type _kT2 = Assert<Absent<Connect, KyselyTxErr>>;
type _kT3 = Assert<Member<TxAborted, KyselyTxErr>>;
type _kT4 = Assert<Member<Lost, KyselyTxErr>>;

// pool client: no transaction state → transaction-aborted impossible.
const kyselyPool = tryDb((db: Kysely<DB>) => {
  void db;
  return 1;
});
type KyselyPoolErr = ErrOf<typeof kyselyPool>;
type _kP0 = Assert<AssertShape<Kysely<DB>, "pool">>;
type _kP1 = Assert<Absent<TxAborted, KyselyPoolErr>>;
type _kP2 = Assert<Member<Unique, KyselyPoolErr>>;

// select: pure reads can't raise constraints; deadlock/lock-timeout stay
// (FOR UPDATE), data errors stay (read conversions), connection tags stay.
// Footgun: a DML CTE in the select can still violate constraints — the
// runtime classifies it correctly; it just falls to the fold terminal.
const kyselySelect = tryDb((q: SelectQueryBuilder<DB, "users", {}>) => {
  void q;
  return 1;
});
type KyselyReadErr = ErrOf<typeof kyselySelect>;
type _kS0 = Assert<AssertShape<SelectQueryBuilder<DB, "users", {}>, "read">>;
type _kS1 = Assert<Absent<Unique, KyselyReadErr>>;
type _kS2 = Assert<Absent<Fk, KyselyReadErr>>;
type _kS3 = Assert<Absent<NotNull, KyselyReadErr>>;
type _kS4 = Assert<Absent<Check, KyselyReadErr>>;
type _kS5 = Assert<Absent<TxAborted, KyselyReadErr>>;
type _kS6 = Assert<Member<Deadlock, KyselyReadErr>>;
type _kS7 = Assert<Member<Data, KyselyReadErr>>;
type _kS8 = Assert<Member<Connect, KyselyReadErr>>;

// insert / update / merge: writes can raise every constraint.
const kyselyInsert = tryDb((q: InsertQueryBuilder<DB, "users", {}>) => {
  void q;
  return 1;
});
type KyselyInsErr = ErrOf<typeof kyselyInsert>;
type _kI0 = Assert<AssertShape<InsertQueryBuilder<DB, "users", {}>, "write">>;
type _kI1 = Assert<Absent<TxAborted, KyselyInsErr>>;
type _kI2 = Assert<Member<Unique, KyselyInsErr>>;

const kyselyUpdate = tryDb((q: UpdateQueryBuilder<DB, "users", "users", {}>) => {
  void q;
  return 1;
});
type _kU0 = Assert<AssertShape<UpdateQueryBuilder<DB, "users", "users", {}>, "write">>;
type _kU1 = Assert<Absent<TxAborted, ErrOf<typeof kyselyUpdate>>>;
type _kU2 = Assert<Member<NotNull, ErrOf<typeof kyselyUpdate>>>;

// merge: a Kysely `MergeQueryBuilder` root has no marker that separates it
// from a delete (both carry using/top/returning) — and it can raise
// constraints via `thenInsert` — so it is opaque: full union, fail-loud
// thunk. Honest: no narrowing is safer than a delete claim that would lie.
type _kM0 = Assert<AssertShape<MergeQueryBuilder<DB, "users", {}>, "opaque">>;
// @ts-expect-error — MergeQueryBuilder proves no shape; use the zero-arg form
const _kyselyMerge = tryDb((q: MergeQueryBuilder<DB, "users", {}>) => {
  void q;
  return 1;
});

// delete: FK is the only constraint a DELETE can hit.
const kyselyDelete = tryDb((q: DeleteQueryBuilder<DB, "users", {}>) => {
  void q;
  return 1;
});
type KyselyDelErr = ErrOf<typeof kyselyDelete>;
type _kD0 = Assert<AssertShape<DeleteQueryBuilder<DB, "users", {}>, "delete">>;
type _kD1 = Assert<Absent<Unique, KyselyDelErr>>;
type _kD2 = Assert<Absent<NotNull, KyselyDelErr>>;
type _kD3 = Assert<Absent<Check, KyselyDelErr>>;
type _kD4 = Assert<Absent<TxAborted, KyselyDelErr>>;
type _kD5 = Assert<Member<Fk, KyselyDelErr>>;

// raw: opaque by definition — the SQL string is arbitrary, so a raw thunk
// proves nothing and fails loudly (the honest ceiling, like every opaque
// one-arg thunk).
type _kR0 = Assert<AssertShape<RawBuilder<unknown>, "opaque">>;
// @ts-expect-error — RawBuilder proves no shape; use the zero-arg form
const _kyselyRaw = tryDb((r: RawBuilder<unknown>) => {
  void r;
  return 1;
});

// ─── Drizzle 1.0.0-rc.4 — pg-core builders ───────────────────────────────────

const drizzleTx = tryDb((tx: PgAsyncTransaction<PgQueryResultHKT>) => {
  void tx;
  return 1;
});
type DrizzleTxErr = ErrOf<typeof drizzleTx>;
type _dT0 = Assert<AssertShape<PgAsyncTransaction<PgQueryResultHKT>, "transaction">>;
type _dT1 = Assert<Absent<Authn, DrizzleTxErr>>;
type _dT2 = Assert<Absent<Connect, DrizzleTxErr>>;
type _dT3 = Assert<Member<TxAborted, DrizzleTxErr>>;

const drizzleSelect = tryDb((q: PgSelect) => {
  void q;
  return 1;
});
type DrizzleReadErr = ErrOf<typeof drizzleSelect>;
type _dS0 = Assert<AssertShape<PgSelect, "read">>;
type _dS1 = Assert<Absent<Unique, DrizzleReadErr>>;
type _dS2 = Assert<Absent<Fk, DrizzleReadErr>>;
type _dS3 = Assert<Absent<NotNull, DrizzleReadErr>>;
type _dS4 = Assert<Absent<Check, DrizzleReadErr>>;
type _dS5 = Assert<Absent<TxAborted, DrizzleReadErr>>;
type _dS6 = Assert<Member<Deadlock, DrizzleReadErr>>; // SELECT … FOR UPDATE

const drizzleInsert = tryDb((q: PgInsert) => {
  void q;
  return 1;
});
type _dI0 = Assert<AssertShape<PgInsert, "write">>;
type _dI1 = Assert<Absent<TxAborted, ErrOf<typeof drizzleInsert>>>;
type _dI2 = Assert<Member<Unique, ErrOf<typeof drizzleInsert>>>;

const drizzleUpdate = tryDb((q: PgUpdate) => {
  void q;
  return 1;
});
type _dU0 = Assert<AssertShape<PgUpdate, "write">>;
type _dU1 = Assert<Absent<TxAborted, ErrOf<typeof drizzleUpdate>>>;
type _dU2 = Assert<Member<Fk, ErrOf<typeof drizzleUpdate>>>;

const drizzleDelete = tryDb((q: PgDelete) => {
  void q;
  return 1;
});
type DrizzleDelErr = ErrOf<typeof drizzleDelete>;
type _dD0 = Assert<AssertShape<PgDelete, "delete">>;
type _dD1 = Assert<Absent<Unique, DrizzleDelErr>>;
type _dD2 = Assert<Absent<NotNull, DrizzleDelErr>>;
type _dD3 = Assert<Absent<Check, DrizzleDelErr>>;
type _dD4 = Assert<Absent<TxAborted, DrizzleDelErr>>;
type _dD5 = Assert<Member<Fk, DrizzleDelErr>>;

// ─── Prisma 6.19.3 — generated client (delegates take args objects) ─────────

const prismaTx = tryDb((tx: Prisma.TransactionClient) => {
  void tx;
  return 1;
});
type PrismaTxErr = ErrOf<typeof prismaTx>;
type _pT0 = Assert<AssertShape<Prisma.TransactionClient, "transaction">>;
type _pT1 = Assert<Absent<Authn, PrismaTxErr>>;
type _pT2 = Assert<Absent<Connect, PrismaTxErr>>;
type _pT3 = Assert<Member<TxAborted, PrismaTxErr>>; // P2028 lives on the tx shape

// findMany/groupBy/aggregate args: provably read (take/orderBy/by keys).
const prismaRead = tryDb((args: Prisma.UserFindManyArgs) => {
  void args;
  return 1;
});
type PrismaReadErr = ErrOf<typeof prismaRead>;
type _pR0 = Assert<AssertShape<Prisma.UserFindManyArgs, "read">>;
type _pR1 = Assert<Absent<Unique, PrismaReadErr>>;
type _pR2 = Assert<Absent<Fk, PrismaReadErr>>;
type _pR3 = Assert<Absent<NotNull, PrismaReadErr>>;
type _pR4 = Assert<Absent<TxAborted, PrismaReadErr>>;
type _pR5 = Assert<Member<Deadlock, PrismaReadErr>>; // conservative: Serializable-tx reads
type _pR6 = Assert<Member<QueryFail, PrismaReadErr>>; // P2025 / P2021 / P2022 folds here

// create/update/upsert args: provably write (data / create+update keys).
const prismaWrite = tryDb((args: Prisma.UserCreateArgs) => {
  void args;
  return 1;
});
type PrismaWriteErr = ErrOf<typeof prismaWrite>;
type _pW0 = Assert<AssertShape<Prisma.UserCreateArgs, "write">>;
type _pW1 = Assert<Absent<TxAborted, PrismaWriteErr>>;
type _pW2 = Assert<Member<Unique, PrismaWriteErr>>;

const prismaUpsert = tryDb((args: Prisma.UserUpsertArgs) => {
  void args;
  return 1;
});
type _pU0 = Assert<AssertShape<Prisma.UserUpsertArgs, "write">>;
type _pU1 = Assert<Absent<TxAborted, ErrOf<typeof prismaUpsert>>>;
type _pU2 = Assert<Member<Unique, ErrOf<typeof prismaUpsert>>>;

// where-only args: SHARED by findUnique/findFirst AND delete/deleteMany.
// The intersection is honest: reads and deletes can neither raise the
// non-FK constraints (constraints are write-only; deletes only FK-fail),
// so the union narrows to the delete set — FK stays, the rest of the
// constraint family goes.
const prismaDeleteArgs = tryDb((args: Prisma.UserDeleteArgs) => {
  void args;
  return 1;
});
type PrismaDelArgsErr = ErrOf<typeof prismaDeleteArgs>;
type _pD0 = Assert<AssertShape<Prisma.UserDeleteArgs, "delete">>;
type _pF0 = Assert<AssertShape<Prisma.UserFindUniqueArgs, "delete">>;
type _pD1 = Assert<Absent<Unique, PrismaDelArgsErr>>;
type _pD2 = Assert<Absent<NotNull, PrismaDelArgsErr>>;
type _pD3 = Assert<Absent<Check, PrismaDelArgsErr>>;
type _pD4 = Assert<Absent<TxAborted, PrismaDelArgsErr>>;
type _pD5 = Assert<Member<Fk, PrismaDelArgsErr>>; // delete/deleteMany CAN FK-fail

// ─── Fail-loud rules ─────────────────────────────────────────────────────────

// A one-arg thunk whose parameter proves no shape does not compile — the
// lattice never silently degrades to the full union.
// @ts-expect-error — non-shape parameter is not a valid thunk shape
const _fail1 = tryDb(async (client: { selectFrom(): unknown }) => {
  void client;
  return 1;
});

// An unannotated parameter gets no contextual type (the shape lives in F,
// which is what's being inferred) — implicit `any` errors under strict, so
// untyped thunks fail loudly too.
// @ts-expect-error — unannotated parameter is an implicit any
const _fail2 = tryDb(async (client) => {
  void client;
  return 1;
});

// Zero-arg thunks keep the full driver union.
const zeroArg = tryDb(async () => 1);
type _z0 = Assert<Member<Unique, ErrOf<typeof zeroArg>>>;
type _z1 = Assert<Member<TxAborted, ErrOf<typeof zeroArg>>>;
type _z2 = Assert<Same<ErrOf<typeof zeroArg>, DbError>>;

// Promise form → the same full union.
const promiseForm = tryDb(Promise.resolve(1));
type _z3 = Assert<Same<ErrOf<typeof promiseForm>, DbError>>;

// tryTx is whole-thunk (zero-arg): full union.
const txWhole = tryTx(async () => "committed");
type _z4 = Assert<Same<ErrOf<typeof txWhole>, DbError>>;

// ShapeOf exposes the classification of a THUNK (param extraction included).
declare const shapedTx: (tx: Transaction<DB>) => number;
declare const shapedRead: (q: SelectQueryBuilder<DB, "users", {}>) => number;
declare const shapedPrismaRead: (args: Prisma.UserFindManyArgs) => number;
type _z5 = Assert<ShapeOf<typeof shapedTx> extends "transaction" ? true : false>;
type _z6 = Assert<ShapeOf<typeof shapedRead> extends "read" ? true : false>;
type _z7 = Assert<ShapeOf<typeof shapedPrismaRead> extends "read" ? true : false>;

// ─── Per-driver ledger — sqlite keeps connect-failure inside transactions ────

// The sqlite driver union already drops authn/deadlock/transaction-aborted.
// The ledger override keeps connect-failure possible in tx callbacks: a
// SQLite transaction can still `ATTACH DATABASE`, which fires CANTOPEN
// mid-query — a union that excluded it would be a lying type.
const sqliteTx = sqliteTryDb((tx: { rollback(): never }) => {
  void tx;
  return 1;
});
type SqliteTxErr = ErrOf<typeof sqliteTx>;
type _s0 = Assert<Member<Connect, SqliteTxErr>>; // ATTACH keeps it possible
type _s1 = Assert<Absent<Authn, SqliteTxErr>>;
type _s2 = Assert<Absent<TxAborted, SqliteTxErr>>;
type _s3 = Assert<Absent<Deadlock, SqliteTxErr>>;

const sqliteZeroArg = sqliteTryDb(async () => 1);
type _s4 = Assert<Same<ErrOf<typeof sqliteZeroArg>, SqliteDbError>>;
type _s5 = Assert<Same<SqliteLedger["transaction"], Authn>>;

export {};
