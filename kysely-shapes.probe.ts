/* eslint-disable no-unused-vars -- scratch probe: every chain is exercised for TYPE checking, not runtime */
/**
 * Kysely-shape probe (scratch, NOT part of the shipped gates — tsconfig
 * includes only `src`). Compile with:
 *   node node_modules/typescript/bin/tsc --noEmit --ignoreConfig --strict --skipLibCheck --module esnext --moduleResolution bundler --target es2022 --lib es2022,dom --noUncheckedIndexedAccess --types bun kysely-shapes.probe.ts
 *
 * The trip drizzle census translated to kysely syntax (kysely@0.29.4): every
 * shape the trip repo uses with drizzle has a kysely equivalent. Each chain
 * is compiled on the RAW kysely db as a control; wrapped-only failures are
 * wrapper tickets. Same<rows, rawRows> pins precision.
 */

import { Kysely, sql } from "kysely";

import { kyselyTryDb } from "./src/kysely";
import {
  UniqueViolation,
  ConnectFailure,
  isConnectionFailure,
  type DbError,
} from "./src/db-result";

/* ------------------------------------------------------------------ */
/* Schema model — trip's pg column palette as a kysely DB interface    */
/* ------------------------------------------------------------------ */

interface UsersTable {
  id?: string; // uuid — DB default
  email: string;
  name: string | null;
  createdAt?: Date; // DB default
  preferences: { locale: string; timezone?: string } | null; // jsonb
}

interface BookingsTable {
  id?: string; // DB default
  userId: string;
  status: "draft" | "confirmed" | "cancelled";
  total: string; // numeric
  tags: string[]; // text[]
  note: string | null;
  bookedAt: Date | null;
}

interface LineItemsTable {
  id?: string; // DB default
  bookingId: string;
  sku: string;
  qty: number;
  unitPrice: string;
}

interface DB {
  users: UsersTable;
  bookings: BookingsTable;
  line_items: LineItemsTable;
}

declare const db: Kysely<DB>;
const wdb = kyselyTryDb(db);

/* ------------------------------------------------------------------ */
/* RAW controls — kysely itself must give precise rows here            */
/* ------------------------------------------------------------------ */

const c1 = await db
  .selectFrom("users")
  .selectAll()
  .where("email", "=", "a")
  .orderBy("createdAt", "desc")
  .limit(10)
  .execute();
const c1Name: string | null = c1[0]?.name ?? null;

const c2 = await db
  .selectFrom("bookings")
  .leftJoin("users", "users.id", "bookings.userId")
  .select(["bookings.id", "users.email", "bookings.total"])
  .where("status", "=", "confirmed")
  .orderBy("bookedAt", "asc")
  .execute();
const c2Total: string | undefined = c2[0]?.total;

const c3 = await db
  .insertInto("users")
  .values({ email: "a@b.c" })
  .returning(["id", "email"])
  .execute();
const c3Id: string | undefined = c3[0]?.id;

const c4 = await db.insertInto("users").values({ email: "d@e.f" }).returningAll().execute();
const c4Email: string | undefined = c4[0]?.email;

const c5 = await db
  .updateTable("users")
  .set({ name: "x" })
  .where("email", "=", "a")
  .returning(["id"])
  .execute();
const c5Id: string | undefined = c5[0]?.id;

const c6 = await db.deleteFrom("line_items").where("qty", "<", 1).returningAll().execute();
const c6Qty: number | undefined = c6[0]?.qty;

/* ------------------------------------------------------------------ */
/* W — wrapped shapes (trip census translated)                        */
/* ------------------------------------------------------------------ */

// W1: select-all + where + orderBy + limit (the most common read)
const w1 = await wdb
  .selectFrom("users")
  .selectAll()
  .where("email", "=", "a")
  .orderBy("createdAt", "desc")
  .limit(10);
const w1Name: string | null = w1.isOk() ? (w1.value[0]?.name ?? null) : null;

// W2: partial select + leftJoin
const w2 = await wdb
  .selectFrom("bookings")
  .leftJoin("users", "users.id", "bookings.userId")
  .select(["bookings.id", "users.email", "bookings.total"])
  .where("status", "=", "confirmed")
  .orderBy("bookedAt", "asc")
  .execute();
const w2Total: string | null = w2.isOk() ? (w2.value[0]?.total ?? null) : null;

// W3: insert + returning(fields)
const w3 = await wdb.insertInto("users").values({ email: "a@b.c" }).returning(["id", "email"]);
const w3Id: string | null = w3.isOk() ? (w3.value[0]?.id ?? null) : null;

// W4: insert + returningAll
const w4 = await wdb.insertInto("users").values({ email: "d@e.f" }).returningAll();
const w4Email: string | null = w4.isOk() ? (w4.value[0]?.email ?? null) : null;

// W5: update set + where + returning (CAS pattern)
const w5 = await wdb
  .updateTable("users")
  .set({ name: "x" })
  .where("email", "=", "a")
  .returning(["id"]);
const w5Id: string | null = w5.isOk() ? (w5.value[0]?.id ?? null) : null;

// W6: delete returning (CAS delete)
const w6 = await wdb.deleteFrom("line_items").where("qty", "<", 1).returningAll();
const w6Qty: number | null = w6.isOk() ? (w6.value[0]?.qty ?? null) : null;

// W7: upsert — onConflict doUpdateSet with excluded refs
const w7 = await wdb
  .insertInto("line_items")
  .values({ id: "x", bookingId: "b", sku: "s", qty: 1, unitPrice: "0" })
  .onConflict((oc) =>
    oc.column("id").doUpdateSet({
      qty: (eb) => eb.ref("excluded.qty"),
      unitPrice: (eb) => eb.ref("excluded.unitPrice"),
    }),
  )
  .returningAll();
const w7Qty: number | null = w7.isOk() ? (w7.value[0]?.qty ?? null) : null;

// W8: upsert — onConflict doNothing
const w8 = await wdb
  .insertInto("users")
  .values({ id: "n", email: "n@o.c" })
  .onConflict((oc) => oc.column("id").doNothing())
  .returning(["id"]);
const w8Id: string | null = w8.isOk() ? (w8.value[0]?.id ?? null) : null;

// W9: transaction — tx-scoped queries + raw advisory lock + FOR UPDATE
const w9 = await wdb.transaction().execute(async (tx) => {
  await sql`SELECT pg_advisory_xact_lock(1)`.execute(tx);
  const rows = await tx
    .selectFrom("bookings")
    .selectAll()
    .where("id", "=", "x")
    .forUpdate()
    .execute();
  const r = await tx.insertInto("users").values({ email: "tx@x.com" }).returning(["id"]).execute();
  return r.isOk() ? (r.value[0]?.id ?? null) : null;
});
const w9Id: string | null = w9.isOk() ? (w9.value ?? null) : null;

// W10: CTE — single, CTE-as-from, multi-CTE + unionAll inside a CTE
const recent = db
  .with("recent", (qb) =>
    qb.selectFrom("bookings").select("id").where("bookedAt", ">", new Date("2026-01-01")),
  )
  .selectFrom("recent")
  .selectAll();
const w10 = await wdb
  .with("recent", (qb) =>
    qb.selectFrom("bookings").select("id").where("bookedAt", ">", new Date("2026-01-01")),
  )
  .selectFrom("recent")
  .selectAll();
const w10Id: string | null = w10.isOk() ? (w10.value[0]?.id ?? null) : null;

const w11 = await wdb
  .with("c1", (qb) => qb.selectFrom("bookings").select("id"))
  .with("c2", (qb) => qb.selectFrom("bookings").select(["id", "userId"]))
  .selectFrom("bookings")
  .selectAll()
  .where("status", "=", "draft");
const w11Status: string | null = w11.isOk() ? (w11.value[0]?.status ?? null) : null;

const w12 = await wdb
  .selectFrom("line_items")
  .select(["id", "sku"])
  .unionAll((qb) => qb.selectFrom("line_items").select(["id", "sku"]))
  .execute();
const w12Sku: string | null = w12.isOk() ? (w12.value[0]?.sku ?? null) : null;

// W13: aggregates — array_agg / countAll + groupBy
const w13 = await wdb
  .selectFrom("bookings")
  .select((eb) => [
    "bookings.userId",
    sql<string[]>`array_agg(${sql.ref("line_items.sku")})`.as("skus"),
    eb.fn.countAll<number>().as("n"),
  ])
  .leftJoin("line_items", "line_items.bookingId", "bookings.id")
  .groupBy("bookings.userId")
  .execute();
// FIXED (ISSUES #4): the callback select keeps the E-track — kysely's own
// CallbackSelection/Selection rows.
const w13N: number | null = w13.isOk() ? (w13.value[0]?.n ?? null) : null;
const w13Sku: string[] | null = w13.isOk() ? (w13.value[0]?.skus ?? null) : null;

// W14: distinct / distinctOn
const w14 = await wdb.selectFrom("bookings").select("userId").distinct().execute();
const w14U: string | null = w14.isOk() ? (w14.value[0]?.userId ?? null) : null;
const w15 = await wdb
  .selectFrom("bookings")
  .selectAll()
  .distinctOn(["userId"])
  .orderBy("userId", "asc")
  .execute();
const w15S: string | null = w15.isOk() ? (w15.value[0]?.status ?? null) : null;

// W16: exists() subquery in where
const w16 = await wdb
  .selectFrom("bookings")
  .selectAll()
  .where((eb) =>
    eb.exists((qb) =>
      qb.selectFrom("line_items").select("id").where("line_items.bookingId", "=", "bookings.id"),
    ),
  )
  .execute();
const w16N: string | null = w16.isOk() ? (w16.value[0]?.note ?? null) : null;

// W17: jsonb / array containment via raw sql
const w17 = await wdb
  .selectFrom("users")
  .selectAll()
  .where(sql`${sql.ref("users.preferences")} @> ${sql`'{"locale":"is"}'`}`)
  .execute();
const w17E: string | null = w17.isOk() ? (w17.value[0]?.email ?? null) : null;

// W18: raw db.execute(sql)
const w18 = await sql`SELECT pg_advisory_lock(42)`.execute(wdb);
// TICKET (documented): sql\`...\`.execute(db) types as kysely's own
// QueryResult — the wrapped executeQuery returns Result at runtime, but the
// sql builder's signature is kysely's (the E-track is invisible in the type).
// @ts-expect-error -- raw sql execute: kysely's own return type
const w18Ok: number | null = w18.isOk() ? (w18.value.rows.length ?? null) : null;

// W19: executeTakeFirst / executeTakeFirstOrThrow (the wrapper terminals)
const w19 = await wdb.selectFrom("users").selectAll().where("email", "=", "a").executeTakeFirst();
const w19E: string | null = w19.isOk() ? (w19.value?.email ?? null) : null;
const w20 = await wdb
  .selectFrom("users")
  .selectAll()
  .where("email", "=", "a")
  .executeTakeFirstOrThrow();
const w20E: string | null = w20.isOk() ? (w20.value.email ?? null) : null;

// W21: mergeInto (aliased target + stages)
const w21 = await wdb
  .mergeInto("users as u")
  .using("users", "users.id", "users.id")
  .whenMatched((wb) => wb.thenUpdateSet({ name: "x" }))
  .execute();
const w21Ok: unknown = w21.isOk() ? w21.value : null;

// W22: error narrowing — read + write sites
const w22 = await wdb.selectFrom("users").selectAll().where("id", "=", "nope").execute();
if (w22.isErr()) {
  const narrowed: string = handleDbError(w22.error);
  if (isConnectionFailure(w22.error)) {
    const m: string = w22.error.message;
  }
  if (ConnectFailure.is(w22.error)) {
    const m2: string = w22.error.message;
  }
} else {
  const first: string | null = w22.value[0]?.name ?? null;
}
declare function handleDbError(e: DbError): string;

const w23 = await wdb
  .insertInto("users")
  .values({ email: "dup@x.com" })
  .returning(["id"])
  .execute();
if (w23.isErr()) {
  if (UniqueViolation.is(w23.error)) {
    const c: string = w23.error.constraint;
  }
} else {
  const email: string | null = w23.value[0]?.id ?? null;
}

/* ------------------------------------------------------------------ */
/* Precision — wrapped rows must be EXACTLY the raw rows (Same)        */
/* ------------------------------------------------------------------ */

type Same<A, B> = [A, B] extends [B, A] ? ([A] extends [B] ? true : false) : false;
type OkOf<R> = R extends { value: infer V } ? V : never;
type Assert<T extends true> = T;

type _k1 = Assert<Same<OkOf<typeof w1>, typeof c1> extends true ? true : false>;
type _k2 = Assert<Same<OkOf<typeof w2>, typeof c2> extends true ? true : false>;
type _k3 = Assert<Same<OkOf<typeof w3>, typeof c3> extends true ? true : false>;
type _k4 = Assert<Same<OkOf<typeof w4>, typeof c4> extends true ? true : false>;
type _k5 = Assert<Same<OkOf<typeof w5>, typeof c5> extends true ? true : false>;
type _k6 = Assert<Same<OkOf<typeof w6>, typeof c6> extends true ? true : false>;

/* ------------------------------------------------------------------ */
/* ISSUES #4 — generic chain methods keep the E-track (the issue's      */
/* exact repro shapes)                                                 */
/* ------------------------------------------------------------------ */

const i4a = await wdb.selectFrom("users").select("email").execute();
const i4aOk: string | null = i4a.isOk() ? (i4a.value[0]?.email ?? null) : null;
const i4b = await wdb.selectFrom("users").select(["id", "email"]).execute();
const i4bOk: string | null = i4b.isOk() ? (i4b.value[0]?.email ?? null) : null;
const i4c = await wdb
  .selectFrom("users")
  .select(({ fn }) => fn.countAll<number>().as("count"))
  .executeTakeFirst();
const i4cOk: number | null = i4c.isOk() ? (i4c.value?.count ?? null) : null;
const i4d = await wdb.selectFrom("users").select(["email"]).groupBy("email").execute();
const i4dOk: string | null = i4d.isOk() ? (i4d.value[0]?.email ?? null) : null;

type _i4a = Assert<Same<OkOf<typeof i4a>, { email: string }[]> extends true ? true : false>;
type _i4c = Assert<
  Same<OkOf<typeof i4c>, { count: number } | undefined> extends true ? true : false
>;
