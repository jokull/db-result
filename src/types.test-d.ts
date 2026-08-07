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
import { tryDb, tryTx, type ShapeOfQuery, type DbError } from "./db-result.ts";
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
} from "./db-result.ts";
import { tryDb as sqliteTryDb, type SqliteDbError } from "./drivers/sqlite.ts";
import type {
  Kysely,
  SelectQueryBuilder,
  InsertQueryBuilder,
  InsertResult,
  UpdateQueryBuilder,
  DeleteQueryBuilder,
  MergeQueryBuilder,
  RawBuilder,
  NoResultError,
  QueryNode,
  ExecuteTakeFirstOrThrowOptions,
  UpdateResult,
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

/** The error union of a Result promise VALUE (already-called method). */
type ErrOfPromise<R> = R extends Promise<Result<unknown, infer E>> ? E : never;

/** The ok value of a Result promise VALUE (already-called method). */
type OkOfPromise<R> = R extends Promise<Result<infer T, unknown>> ? T : never;

/** The ok value of a `Result` promise: `Promise<Result<T, E>>` → `T`. */
type OkOf<R> = R extends Promise<Result<infer T, unknown>> ? T : never;

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

import { drizzleTryDb } from "./drizzle.ts";

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

// codex #10: selectDistinctOn keeps BOTH pg overloads — the 1-arg (select
// all) and the 2-arg (fields projection) — with no zero-arg form. The
// pre-`.from()` builder has no select-clause evidence, so the shape is read
// on the executed chain (same sharp edge as `wrapped.select(...)`).
const wsd1 = wrapped.selectDistinctOn([users.id]).from(users);
type _wsd0 = Assert<
  Absent<Unique, ErrOf<ReturnType<typeof wsd1.execute>>> extends true ? true : false
>;
type _wsd1 = Assert<
  Member<TxAborted, ErrOf<ReturnType<typeof wsd1.execute>>> extends true ? true : false
>;
type WSD1Row =
  Awaited<ReturnType<typeof wsd1.execute>> extends Result<infer V, unknown> ? V : never;
type _wsd2 = Assert<WSD1Row extends unknown[] ? true : false>;
const wsd2 = wrapped.selectDistinctOn([users.id], { id: users.id, email: users.email }).from(users);
type _wsd3 = Assert<
  Absent<Unique, ErrOf<ReturnType<typeof wsd2.execute>>> extends true ? true : false
>;
// @ts-expect-error — selectDistinctOn has no zero-arg form
const _wsdBad = wrapped.selectDistinctOn();

// codex #11: the with surface re-expresses the factories — zero-arg
// `.select()` works, and `.insert(table).values(...)` re-types from the
// called table (the mapped capture instantiated the table generic at its
// constraint — values came back `never`).
const cte = db.$with("recent").as(db.select().from(users));
const ww = wrapped.with(cte);
const wwSel = ww.select().from(users);
type _ww0 = Assert<
  Absent<Unique, ErrOf<ReturnType<typeof wwSel.execute>>> extends true ? true : false
>;
const wwSel2 = ww.select({ id: users.id }).from(users);
type _ww1 = Assert<
  Absent<Unique, ErrOf<ReturnType<typeof wwSel2.execute>>> extends true ? true : false
>;
const wwIns = ww.insert(users).values({ id: 1, email: "a" });
type _ww2 = Assert<
  Member<Unique, ErrOf<ReturnType<typeof wwIns.execute>>> extends true ? true : false
>;
// @ts-expect-error — bogus values column rejected in the with insert too
const _wwBad = ww.insert(users).values({ bogus: 1 });
const wwDel = ww.delete(users);
type _ww3 = Assert<
  Absent<Unique, ErrOf<ReturnType<typeof wwDel.execute>>> extends true ? true : false
>;
type _ww4 = Assert<Member<Fk, ErrOf<ReturnType<typeof wwDel.execute>>> extends true ? true : false>;

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

// ─── codex #8: sync backends reject async callbacks in wrapped transactions

// A sync driver's transaction callback return is never a PromiseLike, so the
// wrapped callback is forced synchronous — the mirror rejects async callbacks
// with drizzle's own mechanic (the branded SyncTxError). A sync no-op
// callback stays valid, and the whole-tx Result shape is unchanged.
declare const syncDbs: {
  select: (...args: any[]) => any;
  selectDistinct: (...args: any[]) => any;
  insert: (table: any) => any;
  update: (table: any) => any;
  delete: (table: any) => any;
  transaction<T>(cb: (tx: { tag: "tx" }) => T, config?: { behavior: "defer" }): T;
};
const wrappedSync = drizzleTryDb(syncDbs);
// @ts-expect-error — sync drivers can't run async callbacks (the driver
// commits before the wrapped statements resolve — atomicity would be lost)
const _wsyncBad = wrappedSync.transaction(async (tx) => {
  void tx;
  return "committed";
});
// a synchronous no-op callback is still valid and keeps the Result shape:
const wsyncOk = wrappedSync.transaction(() => "committed" as const);
type _wsync0 = Assert<Same<ErrOf<typeof wsyncOk>, DbError> extends true ? true : false>;
type _wsync1 = Assert<
  Same<
    Awaited<typeof wsyncOk> extends Result<infer V, unknown> ? V : never,
    "committed"
  > extends true
    ? true
    : false
>;
// async backends keep the PromiseLike surface (covered above by `wtx`).

// raw execute: full union.
const wraw = wrapped.execute(drizzleSql`select 1`);
type _w12 = Assert<Same<ErrOf<typeof wraw>, DbError> extends true ? true : false>;

// pass-through members stay raw.
type _w13 = Assert<Same<typeof wrapped.query, typeof db.query> extends true ? true : false>;
type _w14 = Assert<Same<typeof wrapped.$with, typeof db.$with> extends true ? true : false>;

// protocol-tight E is available via the explicit generic.
import type { DrizzleTryDb } from "./drizzle.ts";
type _w15 = Assert<DrizzleTryDb<typeof db, SqliteDbError> extends unknown ? true : false>;

// ─── codex #12: mssql `output` — result tracking through the wrapped chain ──

// The pre-values insert builder's output() returns a builder WITHOUT
// `execute`, so the mapped chain would pass it through raw and the E-track
// died there (the execute resolved `Result<never, …>`). The `output` arm
// wraps both forms and reconstructs the zero-arg (all-columns) result from
// the threaded table — mirroring `returning`.
import { mssqlTable as mTable, int as mInt, varchar as mVarChar } from "drizzle-orm/mssql-core";
import type { MsSqlDatabase } from "drizzle-orm/mssql-core";

const mUsers = mTable("m_users", {
  id: mInt("id").identity().primaryKey(),
  name: mVarChar("name", { length: 50 }).notNull(),
});
declare const mdb: MsSqlDatabase<any, any, {}>;
const mw = drizzleTryDb(mdb);
const mIns = mw.insert(mUsers).output().values({ name: "a" });
type MInsOk = OkOfPromise<typeof mIns>;
type _m0 = Assert<Same<MInsOk, { id: number; name: string }[]> extends true ? true : false>;
type _m1 = Assert<Member<Unique, ErrOfPromise<typeof mIns>> extends true ? true : false>;
const mInsF = mw.insert(mUsers).output({ id: mUsers.id }).values({ name: "a" });
type MInsFOk = OkOfPromise<typeof mInsF>;
type _m2 = Assert<Same<MInsFOk, { id: number }[]> extends true ? true : false>;
// the delete base overloads output the same way (zero-arg | fields):
const mDel = mw
  .delete(mUsers)
  .output()
  .where(drizzleSql`id = 1`);
type MDelOk = OkOfPromise<typeof mDel>;
type _m3 = Assert<Same<MDelOk, { id: number; name: string }[]> extends true ? true : false>;
type _m4 = Assert<Member<Fk, ErrOfPromise<typeof mDel>> extends true ? true : false>;
// @ts-expect-error — bogus values column rejected in the output insert too
const _mBad = mw.insert(mUsers).output().values({ bogus: 1 });

// ─── kyselyTryDb — the E-tracked wrapper ────────────────────────────────────

import { kyselyTryDb } from "./kysely.ts";

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

// takeFirst family: E-tracked terminals — executeTakeFirst → Ok(row |
// undefined), executeTakeFirstOrThrow → Err(NoResultError) on no row.
// Shape narrowing applies to both (select excludes the constraint tags;
// delete keeps FK only; write shapes keep everything).
type _kt1 = Assert<
  Member<undefined, OkOf<ReturnType<typeof ksel.executeTakeFirst>>> extends true ? true : false
>;
type _kt2 = Assert<
  Absent<Unique, ErrOf<ReturnType<typeof ksel.executeTakeFirst>>> extends true ? true : false
>;
type _kt3 = Assert<
  Absent<undefined, OkOf<ReturnType<typeof ksel.executeTakeFirstOrThrow>>> extends true
    ? true
    : false
>;
// takeFirstOrThrow is generic over the options, so `ReturnType` on the method
// degrades the union (O2 uninstantiated) — assert on REAL calls instead.
const ktfoSel = ksel.executeTakeFirstOrThrow();
const ktfoIns = kins.executeTakeFirstOrThrow();
const ktfoDel = kdel.executeTakeFirstOrThrow();
const ktfoUpd = kupd.executeTakeFirstOrThrow();
type _kt4 = Assert<Member<NoResultError, ErrOfPromise<typeof ktfoSel>> extends true ? true : false>;
type _kt5 = Assert<Member<Unique, ErrOfPromise<typeof ktfoIns>> extends true ? true : false>;
type _kt6 = Assert<Absent<NoResultError, ErrOfPromise<typeof ktfoIns>> extends true ? true : false>;
type _kt7 = Assert<Absent<Unique, ErrOfPromise<typeof ktfoDel>> extends true ? true : false>;
type _kt8 = Assert<Member<Fk, ErrOfPromise<typeof ktfoDel>> extends true ? true : false>;
type _kt9 = Assert<Absent<NoResultError, ErrOfPromise<typeof ktfoUpd>> extends true ? true : false>;

// write families keep `executeTakeFirst` too (raw Kysely has it on every
// executable builder — the mapped type must not remove it). ISSUES.md #5:
// non-returning mutation terminals resolve the MUTATION result — never
// `undefined` (Kysely's SimplifySingleResult excludes it for the four
// result types).
type _kt10 = Assert<
  Absent<undefined, OkOf<ReturnType<typeof kins.executeTakeFirst>>> extends true ? true : false
>;
type _kt10b = Assert<
  Same<OkOf<ReturnType<typeof kins.executeTakeFirst>>, InsertResult> extends true ? true : false
>;
type _kt11 = Assert<
  Member<Unique, ErrOf<ReturnType<typeof kins.executeTakeFirst>>> extends true ? true : false
>;
type _kt12 = Assert<
  Member<Fk, ErrOf<ReturnType<typeof kdel.executeTakeFirst>>> extends true ? true : false
>;
type _kt13 = Assert<
  Absent<Unique, ErrOf<ReturnType<typeof kdel.executeTakeFirst>>> extends true ? true : false
>;

// a custom errorConstructor replaces NoResultError in the error union — the
// union is honest about the constructor's own error type.
class Gone extends Error {
  readonly kind = "gone" as const; // structural marker: bare Error subclasses
  // are assignable to each other, which would defeat the Absent asserts
}
const ktfGone = ksel.executeTakeFirstOrThrow({ errorConstructor: () => new Gone("gone") });
// soundness (codex finding): the custom ctor's own error type IS in the
// union (and NoResultError is not — the union is precise), so exhaustive
// consumers narrow to it instead of assuming NoResultError.
type _kt14 = Assert<Member<Gone, ErrOfPromise<typeof ktfGone>> extends true ? true : false>;
type _kt15 = Assert<Absent<Unique, ErrOfPromise<typeof ktfGone>> extends true ? true : false>;
class Missing extends Error {
  readonly node: unknown = null;
  constructor(node: QueryNode) {
    super("no result");
    this.node = node;
  }
}
const ktfClass = ksel.executeTakeFirstOrThrow({ errorConstructor: Missing });
type _kt16 = Assert<Member<Missing, ErrOfPromise<typeof ktfClass>> extends true ? true : false>;

// ISSUES.md #3 (codex P2): a variable TYPED `ExecuteTakeFirstOrThrowOptions`
// carries the optional errorConstructor — the union must resolve honestly to
// the broad Error contract instead of silently falling back to NoResultError.
const ktOpts: ExecuteTakeFirstOrThrowOptions = { errorConstructor: () => new Gone("gone") };
const ktfVar = ksel.executeTakeFirstOrThrow(ktOpts);
type _kt17 = Assert<Same<ErrOfPromise<typeof ktfVar>, Error> extends true ? true : false>;

// ISSUES.md #5 (codex P2): the update terminal's Ok is the RESULT type, not
// the table union — UpdateQueryBuilder has FOUR type params, and the mapped
// type must not bind the 3rd (table) into the result slot.
type _kt18 = Assert<
  Same<OkOf<ReturnType<typeof kupd.executeTakeFirst>>, UpdateResult> extends true ? true : false
>;
type _kt19 = Assert<
  Absent<undefined, OkOf<ReturnType<typeof kupd.executeTakeFirst>>> extends true ? true : false
>;

// codex follow-up (P2): an ABSENT optional errorConstructor falls back to
// NoResultError at runtime — the union must keep it (not just the custom
// error) when the options type carries the property optionally.
const ktOptsNarrow: { errorConstructor?: typeof Missing } = {};
const ktfNarrow = ksel.executeTakeFirstOrThrow(ktOptsNarrow);
type _kt20 = Assert<Member<Missing, ErrOfPromise<typeof ktfNarrow>> extends true ? true : false>;
type _kt21 = Assert<
  Member<NoResultError, ErrOfPromise<typeof ktfNarrow>> extends true ? true : false
>;

// codex follow-up (P2): mutation builders can never yield the no-result
// error — non-returning insert/update/delete/merge terminals always produce
// their result — so the takeFirstOrThrow union omits it for them.
type _kt22 = Assert<
  Absent<NoResultError, ErrOfPromise<typeof ktfoIns>> extends true ? true : false
>;
type _kt23 = Assert<
  Absent<NoResultError, ErrOfPromise<typeof ktfoUpd>> extends true ? true : false
>;
type _kt24 = Assert<
  Absent<NoResultError, ErrOfPromise<typeof ktfoDel>> extends true ? true : false
>;
// codex fifth-pass P2: a SELECT whose row structurally matches a mutation
// result (DeleteResult) must still be treated as a select — the builder
// brand decides, not the row shape: `undefined` stays, NoResultError stays.
declare const kdbDel: Kysely<{ users: { numDeletedRows: bigint } }>;
const kDelShaped = kyselyTryDb(kdbDel).selectFrom("users").selectAll();
type _kt25 = Assert<
  Member<undefined, OkOf<ReturnType<typeof kDelShaped.executeTakeFirst>>> extends true
    ? true
    : false
>;
const ktfoDelShaped = kDelShaped.executeTakeFirstOrThrow();
type _kt26 = Assert<
  Member<NoResultError, ErrOfPromise<typeof ktfoDelShaped>> extends true ? true : false
>;

// ─── relational queries — the read-shape E-track (sqlite db, blog pattern) ─

import { defineRelations } from "drizzle-orm";
import { sqliteTable as rTable, text as rText, integer as rInteger } from "drizzle-orm/sqlite-core";
import { drizzle as bunDrizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";

const rPosts = rTable("r_posts", { slug: rText("slug").primaryKey(), title: rText("title") });
const rComments = rTable("r_comments", {
  id: rInteger("id").primaryKey(),
  postSlug: rText("post_slug"),
});
const rRelations = defineRelations({ rPosts, rComments }, (r) => ({
  rPosts: {
    comments: r.many.rComments({ from: r.rPosts.slug, to: r.rComments.postSlug }),
  },
}));
declare const rClient: Database;
const sdb = bunDrizzle({ client: rClient, relations: rRelations });
const wrappedSqlite = drizzleTryDb(sdb);

// builders on a sqlite db work too (the wrapper is driver-agnostic)…
const sIns = wrappedSqlite.insert(rPosts).values({ slug: "a", title: "b" });
type _rel0 = Assert<
  Member<Unique, ErrOf<ReturnType<typeof sIns.execute>>> extends true ? true : false
>;
// codex follow-up (P1): values/set re-typed from the threaded table's
// $inferInsert — invalid columns are rejected like the unwrapped client.
// @ts-expect-error — bogus values column rejected
const _sInsBad = wrappedSqlite.insert(rPosts).values({ bogus: 1 });
// @ts-expect-error — bogus set column rejected
const _sUpdBad = wrappedSqlite.update(rPosts).set({ bogus: 1 });
// codex #9: expression-valued writes stay allowed — per-column SQL /
// placeholder values union into the write object like drizzle's own
// `SQLiteInsertValue` (the strict $inferInsert re-type must not lose them).
const sInsExpr = wrappedSqlite.insert(rPosts).values({ slug: drizzleSql`lower('A')`, title: "b" });
type _relExpr0 = Assert<
  Member<Unique, ErrOf<ReturnType<typeof sInsExpr.execute>>> extends true ? true : false
>;
const sUpdExpr = wrappedSqlite
  .update(rPosts)
  .set({ title: drizzleSql`'c'` })
  .where(undefined)
  .returning();
type _relExpr1 = Assert<
  Same<OkOfPromise<typeof sUpdExpr>, { slug: string; title: string | null }[]> extends true
    ? true
    : false
>;
const sInsPh = wrappedSqlite
  .insert(rPosts)
  .values({ slug: drizzleSql.placeholder("s"), title: "b" });
type _relExpr2 = Assert<
  Member<Unique, ErrOf<ReturnType<typeof sInsPh.execute>>> extends true ? true : false
>;
// codex fifth-pass P1: a COLUMN is not a valid insert value (it implements
// getSQL — the expression stand-in must exclude it; raw drizzle rejects it)
// @ts-expect-error — columns are not insert values
const _sInsCol = wrappedSqlite.insert(rPosts).values({ slug: rPosts.slug });
// …but a column reference IS a valid update set source:
const sUpdCol = wrappedSqlite.update(rPosts).set({ title: rPosts.title }).where(undefined);
type _relExpr3 = Assert<
  Member<Unique, ErrOf<ReturnType<typeof sUpdCol.execute>>> extends true ? true : false
>;
// ISSUES.md #1: wrapped chains must keep drizzle's precise rows through
// zero-arg `.returning()` — not the degraded Record<string, unknown>[].
const sInsRet = wrappedSqlite.insert(rPosts).values({ slug: "a", title: "b" }).returning();
type _relRetOk = OkOfPromise<typeof sInsRet>;
type _relRet0 = Assert<
  Same<_relRetOk, { slug: string; title: string | null }[]> extends true ? true : false
>;
type _relRet1 = Assert<Record<string, unknown>[] extends _relRetOk ? false : true>;
const sUpdRet = wrappedSqlite.update(rPosts).set({ title: "c" }).where(undefined).returning();
type _relUpdOk = OkOfPromise<typeof sUpdRet>;
type _relUpd0 = Assert<
  Same<_relUpdOk, { slug: string; title: string | null }[]> extends true ? true : false
>;
const sDelRet = wrappedSqlite.delete(rPosts).where(undefined).returning();
type _relDelOk = OkOfPromise<typeof sDelRet>;
type _relDel0 = Assert<
  Same<_relDelOk, { slug: string; title: string | null }[]> extends true ? true : false
>;
// …and relational reads E-track with the READ union (constraints excluded).
const relMany = wrappedSqlite.query.rPosts.findMany({ orderBy: { title: "asc" } });
type _rel1 = Assert<Absent<Unique, ErrOfPromise<typeof relMany>> extends true ? true : false>;
type _rel2 = Assert<Member<Data, ErrOfPromise<typeof relMany>> extends true ? true : false>;
type _rel3 = Assert<Member<undefined, OkOfPromise<typeof relMany>> extends true ? false : true>;
const relOne = wrappedSqlite.query.rPosts.findFirst({ where: { slug: "x" } });
type _rel4 = Assert<Member<undefined, OkOfPromise<typeof relOne>> extends true ? true : false>;
type _rel5 = Assert<Absent<Unique, ErrOfPromise<typeof relOne>> extends true ? true : false>;

// ISSUES.md #2 (codex P1): projections keep per-call precision — the wrapped
// surface matches drizzle's own BuildQueryResult for columns/with, and
// findFirst carries the absent-row undefined.
const relProjRaw = sdb.query.rPosts.findMany({ columns: { slug: true } });
type _relProjRaw = Assert<
  Same<Awaited<typeof relProjRaw>, { slug: string }[]> extends true ? true : false
>;
const relProj = wrappedSqlite.query.rPosts.findMany({ columns: { slug: true } });
type _relProj0 = Assert<
  Same<OkOfPromise<typeof relProj>, { slug: string }[]> extends true ? true : false
>;
type _relProj1 = Assert<
  Member<{ title: string | null }, OkOfPromise<typeof relProj>> extends true ? false : true
>;
const relWith = wrappedSqlite.query.rPosts.findMany({ with: { comments: true } });
type _relWith0 = Assert<
  Same<
    OkOfPromise<typeof relWith>,
    { slug: string; title: string | null; comments: { id: number; postSlug: string | null }[] }[]
  > extends true
    ? true
    : false
>;
const relFirstProj = wrappedSqlite.query.rPosts.findFirst({ columns: { slug: true } });
type _relFirst0 = Assert<
  Same<OkOfPromise<typeof relFirstProj>, { slug: string } | undefined> extends true ? true : false
>;

// ─── prismaTryDb — the E-tracked wrapper ────────────────────────────────────
import { prismaTryDb } from "./prisma.ts";
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
