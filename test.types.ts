/**
 * Type-level tests for the shape lattice — compile-only, checked by
 * `tsc --noEmit`, never executed.
 *
 * The lattice reads a query BUILDER's own type as evidence of what the query
 * can and cannot do, then narrows the error union to the tags that shape
 * provably cannot produce (see `ShapeLedger` — the "no lying types"
 * contract). Every row of the matrix is asserted twice:
 *
 *   1. the probe classifies the REAL ORM type as the right shape
 *   2. `tryDb(builder)`'s return union excludes exactly the ledger's tags for
 *      that shape (union membership / absence asserts)
 *
 * Plus the fail-loud rules: a builder value that proves no shape does not
 * compile, a builder wrapped in a thunk does not compile (pass it directly),
 * and thunks / settled promises keep the full driver union.
 *
 * Imports are the real published ORM types — Kysely 0.29 builders, Drizzle
 * 1.0.0-rc.4 builders as produced by the real `drizzle()` factory, and the
 * generated Prisma 6.19.3 client — so a probe that drifts from an ORM's
 * actual surface fails this file.
 *
 * Assertion pattern: every check is `Assert<…>` — a conditional constrained
 * to `true`, so a failing row is a compile error. Helpers return plain
 * `true | false`; the `Assert` wrapper enforces the result at the use site
 * (a `true | never` helper would fail silently through a `never` alias).
 */
import { tryDb, tryTx, type ShapeOfQuery, type DbError } from "./src/db-result.ts";
import type {
  CheckViolation,
  ConnectFailure,
  ConnectionLost,
  DataError,
  DeadlockError,
  ForeignKeyViolation,
  NotNullViolation,
  TransactionAborted,
  UniqueViolation,
} from "./src/db-result.ts";
import { tryDb as sqliteTryDb, type SqliteDbError } from "./src/drivers/sqlite.ts";
import type {
  Kysely,
  SelectQueryBuilder,
  InsertQueryBuilder,
  UpdateQueryBuilder,
  DeleteQueryBuilder,
  MergeQueryBuilder,
  RawBuilder,
} from "kysely";
import { pgTable, text, integer } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql as drizzleSql } from "drizzle-orm";
import type { Result } from "better-result";

// ─── Assertion helpers ───────────────────────────────────────────────────────

type Assert<T extends true> = T;
/** Probe classification — the library's own `ShapeOfQuery` (no mirror to
 * drift). Plain `true | false`; the use site wraps it in `Assert`. */
type AssertShape<Q, S extends string> = ShapeOfQuery<Q> extends S ? true : false;
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
type Connect = ConnectFailure;
type Lost = ConnectionLost;
type TxAborted = TransactionAborted;
type Deadlock = DeadlockError;
type Data = DataError;

interface DB {
  users: { id: number; email: string };
}

// ─── Kysely 0.29 — every documented builder shape, passed as a VALUE ────────

declare const sel: SelectQueryBuilder<DB, "users", {}>;
declare const ins: InsertQueryBuilder<DB, "users", {}>;
declare const upd: UpdateQueryBuilder<DB, "users", "users", {}>;
declare const del: DeleteQueryBuilder<DB, "users", "users">;
declare const merge: MergeQueryBuilder<DB, "users", unknown>;
declare const raw: RawBuilder<unknown>;
declare const client: Kysely<DB>;

// select: pure reads can't raise constraints; deadlock/lock-timeout stay
// (FOR UPDATE), data errors stay (read conversions), connection tags stay.
// transaction-aborted STAYS: a tx-bound select can raise 25P02 after any prior
// failed statement in the transaction (the tx client's builders are type-identical).
// Footgun: a DML CTE in the select can still violate constraints — the
// runtime classifies it correctly; it just falls to the fold terminal.
const kyselySelect = tryDb(sel);
type KyselyReadErr = ErrOf<typeof kyselySelect>;
type _kS0 = Assert<AssertShape<typeof sel, "read">>;
type _kS1 = Assert<Absent<Unique, KyselyReadErr>>;
type _kS2 = Assert<Absent<Fk, KyselyReadErr>>;
type _kS3 = Assert<Absent<NotNull, KyselyReadErr>>;
type _kS4 = Assert<Absent<Check, KyselyReadErr>>;
type _kS5 = Assert<Member<TxAborted, KyselyReadErr>>; // tx-bound reads can raise 25P02
type _kS6 = Assert<Member<Deadlock, KyselyReadErr>>;
type _kS7 = Assert<Member<Data, KyselyReadErr>>;
type _kS8 = Assert<Member<Connect, KyselyReadErr>>;
type _kS9 = Assert<Member<Lost, KyselyReadErr>>;

// insert / update: writes can raise every constraint.
const kyselyInsert = tryDb(ins);
type KyselyInsErr = ErrOf<typeof kyselyInsert>;
type _kI0 = Assert<AssertShape<typeof ins, "write">>;
type _kI1 = Assert<Member<TxAborted, KyselyInsErr>>;
type _kI2 = Assert<Member<Unique, KyselyInsErr>>;
type _kI3 = Assert<Member<Fk, KyselyInsErr>>;
type _kI4 = Assert<Member<NotNull, KyselyInsErr>>;

const kyselyUpdate = tryDb(upd);
type _kU0 = Assert<AssertShape<typeof upd, "write">>;
type _kU1 = Assert<Member<TxAborted, ErrOf<typeof kyselyUpdate>>>;
type _kU2 = Assert<Member<NotNull, ErrOf<typeof kyselyUpdate>>>;

// merge: a Kysely `MergeQueryBuilder` root has no marker that separates it
// from a delete (both carry using/top/returning) — and it can raise
// constraints via `thenInsert` — so it is opaque: full union, fail-loud.
// Honest: no narrowing is safer than a delete claim that would lie.
type _kM0 = Assert<AssertShape<typeof merge, "opaque">>;
// @ts-expect-error — MergeQueryBuilder proves no shape; use the thunk form
const _kyselyMerge = tryDb(merge);

// raw: opaque by definition — the SQL string is arbitrary.
type _kR0 = Assert<AssertShape<typeof raw, "opaque">>;
// @ts-expect-error — RawBuilder proves no shape; use the thunk form
const _kyselyRaw = tryDb(raw);

// the pool/client is not a query.
type _kC0 = Assert<AssertShape<typeof client, "opaque">>;
// @ts-expect-error — a client is not a query; wrap the statement
const _kyselyClient = tryDb(client);

// DDL is not a delete: CreateIndexBuilder has `where` (partial-index
// predicate) and execute but no `returning` — and CREATE UNIQUE INDEX raises
// 23505, which the delete shape would exclude. Opaque, fail-loud.
declare const ddl: ReturnType<Kysely<DB>["schema"]["createIndex"]>;
type _kDdl0 = Assert<AssertShape<typeof ddl, "opaque">>;
// @ts-expect-error — DDL proves no shape; use the thunk form
const _kyselyDdl = tryDb(ddl);

// delete: FK is the only constraint a DELETE can hit.
const kyselyDelete = tryDb(del);
type KyselyDelErr = ErrOf<typeof kyselyDelete>;
type _kD0 = Assert<AssertShape<typeof del, "delete">>;
type _kD1 = Assert<Absent<Unique, KyselyDelErr>>;
type _kD2 = Assert<Absent<NotNull, KyselyDelErr>>;
type _kD3 = Assert<Absent<Check, KyselyDelErr>>;
type _kD4 = Assert<Member<TxAborted, KyselyDelErr>>;
type _kD5 = Assert<Member<Fk, KyselyDelErr>>;

// ─── Drizzle 1.0.0-rc.4 — builders as the real factory produces them ────────

const users = pgTable("users", { id: integer("id").primaryKey(), email: text("email") });
// Type-only: this file is never executed, so no connection is needed.
const db = drizzle({ connection: { connectionString: "postgres://x:x@127.0.0.1:5433/x" } });

const dsel = db.select().from(users);
const dins = db.insert(users).values({ id: 1, email: "a" });
const dinsR = db.insert(users).values({ id: 1, email: "a" }).returning();
const dupd = db.update(users).set({ email: "a" });
const ddel = db.delete(users);

// select narrows; the result type comes from the builder's own `_` slot
// (rc.4 declares `execute` as a this-derived property inference can't
// follow, so the `_` slot is the reliable source):
const drizzleSelect = tryDb(dsel);
type DrizzleReadErr = ErrOf<typeof drizzleSelect>;
type _dS0 = Assert<AssertShape<typeof dsel, "read">>;
type _dS1 = Assert<Absent<Unique, DrizzleReadErr>>;
type _dS2 = Assert<Absent<Fk, DrizzleReadErr>>;
type _dS3 = Assert<Absent<NotNull, DrizzleReadErr>>;
type _dS4 = Assert<Absent<Check, DrizzleReadErr>>;
type _dS5 = Assert<Member<TxAborted, DrizzleReadErr>>;
type _dS6 = Assert<Member<Deadlock, DrizzleReadErr>>; // SELECT … FOR UPDATE

// write builders narrow to the write set (constraints stay, tx-state gone):
const drizzleInsert = tryDb(dins);
type DrizzleInsErr = ErrOf<typeof drizzleInsert>;
type _dI0 = Assert<AssertShape<typeof dins, "write">>;
type _dI1 = Assert<Member<Unique, DrizzleInsErr>>;
type _dI2 = Assert<Member<TxAborted, DrizzleInsErr>>;

const drizzleInsertR = tryDb(dinsR);
type _dI3 = Assert<AssertShape<typeof dinsR, "write">>;
type _dI4 = Assert<Member<Fk, ErrOf<typeof drizzleInsertR>>>;

const drizzleUpdate = tryDb(dupd);
type _dU0 = Assert<AssertShape<typeof dupd, "write">>;
type _dU1 = Assert<Member<TxAborted, ErrOf<typeof drizzleUpdate>>>;
type _dU2 = Assert<Member<NotNull, ErrOf<typeof drizzleUpdate>>>;

const drizzleDelete = tryDb(ddel);
type DrizzleDelErr = ErrOf<typeof drizzleDelete>;
type _dD0 = Assert<AssertShape<typeof ddel, "delete">>;
type _dD1 = Assert<Absent<Unique, DrizzleDelErr>>;
type _dD2 = Assert<Absent<NotNull, DrizzleDelErr>>;
type _dD3 = Assert<Absent<Check, DrizzleDelErr>>;
type _dD4 = Assert<Member<TxAborted, DrizzleDelErr>>;
type _dD5 = Assert<Member<Fk, DrizzleDelErr>>;

// rc.4: calling .where() strips the method from the type (PgDeleteWithout),
// so a where'd delete probes opaque — full union, conservative, never a lie.
const drizzleDeleteW = db.delete(users).where(drizzleSql`id = 1`);
type _dD6 = Assert<AssertShape<typeof drizzleDeleteW, "opaque"> extends true ? true : false>;
const drizzleDeleteWResult = tryDb(drizzleDeleteW);
type _dD7 = Assert<Same<ErrOf<typeof drizzleDeleteWResult>, DbError>>;

// ─── Fail-loud rules ─────────────────────────────────────────────────────────

// A builder wrapped in a thunk is a compile error — pass the builder directly.
// @ts-expect-error — the thunk form is for promises; pass the builder directly
const _fail1 = tryDb(() => sel);

// A bare value is not a query.
// @ts-expect-error — a plain value is not a query
const _fail2 = tryDb(42);

// Promise-returning thunks keep the full driver union.
const zeroArg = tryDb(async () => 1);
type _z0 = Assert<Member<Unique, ErrOf<typeof zeroArg>>>;
type _z1 = Assert<Member<TxAborted, ErrOf<typeof zeroArg>>>;
type _z2 = Assert<Same<ErrOf<typeof zeroArg>, DbError>>;

// Promise form → the same full union.
const promiseForm = tryDb(Promise.resolve(1));
type _z3 = Assert<Same<ErrOf<typeof promiseForm>, DbError>>;

// tryTx is whole-thunk: full union.
const txWhole = tryTx(async () => "committed");
type _z4 = Assert<Same<ErrOf<typeof txWhole>, DbError>>;

// ─── Per-driver ledger — sqlite keeps connect-failure in its union ──────────

// The sqlite driver union already drops authn/deadlock/transaction-aborted.
// A sqlite select value narrows that union further (constraints gone) but
// connect-failure stays — CANTOPEN can fire mid-query even on a read.
const sqliteSelect = sqliteTryDb(sel);
type SqliteReadErr = ErrOf<typeof sqliteSelect>;
type _s0 = Assert<Same<SqliteReadErr, Exclude<SqliteDbError, Unique | Fk | NotNull | Check>>>;
type _s1 = Assert<Member<Connect, SqliteReadErr>>;
type _s2 = Assert<Absent<Unique, SqliteReadErr>>;
type _s3 = Assert<Absent<TxAborted, SqliteReadErr>>;

const sqliteZeroArg = sqliteTryDb(async () => 1);
type _s4 = Assert<Same<ErrOf<typeof sqliteZeroArg>, SqliteDbError>>;

// ─── drizzleTryDb — the E-tracked wrapper ───────────────────────────────────

import { drizzleTryDb } from "./src/drizzle.ts";

const wrapped = drizzleTryDb(db);

// select chain (explicit selection): read shape — constraints gone,
// transaction-aborted stays. Rows degrade to structurally-typed arrays
// (documented sharp edge: the mapped chain can't preserve Drizzle's
// generics — the union narrowing is what survives).
const wsel = wrapped.select({ id: users.id, email: users.email }).from(users);
type WSelErr = ErrOf<ReturnType<typeof wsel.execute>>;
type _w1 = Assert<Absent<Unique, WSelErr> extends true ? true : false>;
type _w2 = Assert<Member<TxAborted, WSelErr> extends true ? true : false>;
type WRow = Awaited<ReturnType<typeof wsel.execute>> extends Result<infer V, unknown> ? V : never;
type _w3 = Assert<WRow extends unknown[] ? true : false>;

// zero-arg select: the mapped chain degrades rows to structurally-typed
// arrays (documented sharp edge) — the union narrowing still applies.
const wsel0 = wrapped.select().from(users);
type WRow0 = Awaited<ReturnType<typeof wsel0.execute>> extends Result<infer V, unknown> ? V : never;
type _w4 = Assert<WRow0 extends unknown[] ? true : false>;

// awaiting the builder directly resolves the Result (then path).
type _w5 = Assert<Awaited<typeof wsel> extends Result<unknown, unknown> ? true : false>;

// insert: write shape — constraints stay.
const wins = wrapped.insert(users).values({ id: 1, email: "a" });
type _w6 = Assert<
  Member<Unique, ErrOf<ReturnType<typeof wins.execute>>> extends true ? true : false
>;
type _w7 = Assert<
  Member<TxAborted, ErrOf<ReturnType<typeof wins.execute>>> extends true ? true : false
>;

// delete (bare): delete shape — FK stays, unique gone.
const wdel = wrapped.delete(users);
type WDelErr = ErrOf<ReturnType<typeof wdel.execute>>;
type _w8 = Assert<Absent<Unique, WDelErr> extends true ? true : false>;
type _w9 = Assert<Member<Fk, WDelErr> extends true ? true : false>;

// transaction: whole-tx Result, full union.
const wtx = wrapped.transaction(async (_tx) => "committed");
type _w10 = Assert<Same<ErrOf<typeof wtx>, DbError> extends true ? true : false>;
/** The error union of a Result: `Result<T, E>` → `E`. */
type ErrOfResult<R> = R extends Result<unknown, infer E> ? E : never;

// statements inside the tx callback are E-tracked too:
const wtxInner = wrapped.transaction(async (tx) => {
  const r = await tx.insert(users).values({ id: 1, email: "a" }).execute();
  type _w11 = Assert<Member<Unique, ErrOfResult<typeof r>> extends true ? true : false>;
  return r;
});
void wtxInner;

// raw execute: full union.
const wraw = wrapped.execute(drizzleSql`select 1`);
type _w12 = Assert<Same<ErrOf<typeof wraw>, DbError> extends true ? true : false>;

// pass-through members stay raw.
type _w13 = Assert<Same<typeof wrapped.query, typeof db.query> extends true ? true : false>;
type _w14 = Assert<Same<typeof wrapped.$with, typeof db.$with> extends true ? true : false>;

// protocol-tight E is available via the explicit generic.
import type { DrizzleTryDb } from "./src/drizzle.ts";
type _w15 = Assert<DrizzleTryDb<typeof db, SqliteDbError> extends unknown ? true : false>;

// ─── kyselyTryDb — the E-tracked wrapper ────────────────────────────────────

import { kyselyTryDb } from "./src/kysely.ts";

declare const kdb: Kysely<DB>;
const kw = kyselyTryDb(kdb);

// where-family 3-arg + rows stay precise (Kysely's chain methods return the
// same class parameters):
const ksel = kw.selectFrom("users").selectAll().where("id", "=", 1).orderBy("id");
type KSelErr = ErrOf<ReturnType<typeof ksel.execute>>;
type _kq1 = Assert<Absent<Unique, KSelErr> extends true ? true : false>;
type _kq2 = Assert<Member<TxAborted, KSelErr> extends true ? true : false>;
type KRow = Awaited<ReturnType<typeof ksel.execute>> extends Result<infer V, unknown> ? V : never;
type _kq3 = Assert<KRow extends { id: number; email: string }[] ? true : false>;

// insert (both values forms) + update set object:
const kins = kw.insertInto("users").values({ id: 1, email: "a" });
type _kq4 = Assert<
  Member<Unique, ErrOf<ReturnType<typeof kins.execute>>> extends true ? true : false
>;
const kins2 = kw.insertInto("users").values([{ id: 1, email: "a" }]);
type _kq5 = Assert<
  Member<Unique, ErrOf<ReturnType<typeof kins2.execute>>> extends true ? true : false
>;
const kupd = kw.updateTable("users").set({ email: "x" }).where("id", "=", 1);
type _kq6 = Assert<
  Member<Unique, ErrOf<ReturnType<typeof kupd.execute>>> extends true ? true : false
>;

// delete: FK stays, unique gone.
const kdel = kw.deleteFrom("users").where("id", "=", 1);
type KDelErr = ErrOf<ReturnType<typeof kdel.execute>>;
type _kq7 = Assert<Absent<Unique, KDelErr> extends true ? true : false>;
type _kq8 = Assert<Member<Fk, KDelErr> extends true ? true : false>;

// join key form:
const kjoin = kw.selectFrom("users").leftJoin("users", "users.id", "users.id");
type _kq9 = Assert<
  Absent<Unique, ErrOf<ReturnType<typeof kjoin.execute>>> extends true ? true : false
>;

// transaction + raw executeQuery: full union.
const ktx = kw.transaction().execute(async (_tx) => "committed");
type _kq10 = Assert<Same<ErrOf<typeof ktx>, DbError> extends true ? true : false>;
const kraw = kw.executeQuery({ compile: () => ({ sql: "select 1", parameters: [] }) } as never);
type _kq11 = Assert<Same<ErrOf<typeof kraw>, DbError> extends true ? true : false>;

// ─── prismaTryDb — the E-tracked wrapper ────────────────────────────────────

import { prismaTryDb } from "./src/prisma.ts";
import { PrismaClient } from "@prisma/client";

// Type-only: never executed, so no DATABASE_URL is needed at construction.
const pclient = new PrismaClient();
const pw = prismaTryDb(pclient);

// delegate calls: full union (Prisma never narrows), correct value types.
const pfind = pw.user.findMany({ where: { email: "a" } });
type _pq1 = Assert<Same<ErrOf<typeof pfind>, DbError> extends true ? true : false>;
type _pq2 = Assert<Member<Unique, ErrOf<typeof pfind>> extends true ? true : false>;
type PFindVal = Awaited<typeof pfind> extends Result<infer V, unknown> ? V : never;
type _pq3 = Assert<PFindVal extends { id: number; email: string }[] ? true : false>;
const pcreate = pw.user.create({ data: { email: "a" } });
type _pq4 = Assert<Member<Unique, ErrOf<typeof pcreate>> extends true ? true : false>;

// interactive transaction: whole-tx Result, inner statements E-tracked.
const ptx = pw.$transaction(async (tx) => {
  const r = await tx.user.create({ data: { email: "b" } });
  type _pq5 = Assert<Member<Unique, ErrOfResult<typeof r>> extends true ? true : false>;
  if (r.isErr()) return r;
  return r.value;
});
type _pq6 = Assert<Same<ErrOf<typeof ptx>, DbError> extends true ? true : false>;

// batch transaction + raw queries: full union.
const pbatch = pw.$transaction([pcreate]);
type _pq7 = Assert<Same<ErrOf<typeof pbatch>, DbError> extends true ? true : false>;
const praw = pw.$queryRaw`SELECT 1`;
type _pq8 = Assert<Same<ErrOf<typeof praw>, DbError> extends true ? true : false>;

export {};
