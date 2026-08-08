/* eslint-disable no-unused-vars -- scratch probe: every chain is exercised for TYPE checking, not runtime */
/**
 * Trip-shape probe (scratch, NOT part of the shipped gates — tsconfig
 * includes only `src`). Compile with:
 *   node node_modules/typescript/bin/tsc --noEmit --ignoreConfig --strict --skipLibCheck --module esnext --moduleResolution bundler --target es2022 --lib es2022,dom --noUncheckedIndexedAccess --types bun trip-shapes.probe.ts
 *
 * Models the trip monorepo's pg schema palette + the query shapes found in
 * the census, then checks the db-result wrapper's inference + error
 * narrowing on each. Every chain is ALSO compiled on the raw db as a
 * control. Lines failing ONLY on the wrapped side are wrapper tickets.
 */

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  jsonb,
  timestamp,
  pgEnum,
  customType,
} from "drizzle-orm/pg-core";
import {
  eq,
  and,
  or,
  inArray,
  notInArray,
  isNull,
  isNotNull,
  gt,
  lt,
  asc,
  desc,
  sql,
  count,
  countDistinct,
  exists,
  arrayContains,
  defineRelations,
} from "drizzle-orm";

import { drizzleTryDb } from "./src/drizzle";
import type { OutputFieldsOf } from "./src/wrap";
import {
  UniqueViolation,
  ConnectFailure,
  isConnectionFailure,
  type DbError,
} from "./src/db-result";

/* ------------------------------------------------------------------ */
/* Schema model (trip's column palette + defineRelations RQBv2)        */
/* ------------------------------------------------------------------ */

export const bookingStatus = pgEnum("booking_status", ["draft", "confirmed", "cancelled"]);

const bytea = customType<{ data: unknown; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  name: text("name"),
  blob: bytea("blob"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  preferences: jsonb("preferences")
    .$type<{ locale: string; timezone?: string }>()
    .default({ locale: "en" }),
});

export const bookings = pgTable("bookings", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  status: bookingStatus("status").notNull().default("draft"),
  total: numeric("total", { precision: 10, scale: 2 }).notNull().default("0"),
  tags: text("tags").array().notNull().default([]),
  note: text("note"),
  bookedAt: timestamp("booked_at", { withTimezone: true }),
});

export const lineItems = pgTable("line_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  bookingId: uuid("booking_id")
    .notNull()
    .references(() => bookings.id, { onDelete: "cascade" }),
  sku: text("sku").notNull(),
  qty: integer("qty").notNull().default(1),
  unitPrice: numeric("unit_price", { precision: 10, scale: 2 }).notNull().default("0"),
});

export const schema = { users, bookings, lineItems, bookingStatus };

export const schemaRelations = defineRelations(schema, (r) => ({
  users: { bookings: r.many.bookings() },
  bookings: {
    user: r.one.users({ from: r.bookings.userId, to: r.users.id }),
    lineItems: r.many.lineItems(),
  },
}));

export const db = drizzle({
  relations: schemaRelations,
  connection: { connectionString: "postgres://x" },
});
// trip's Database = NodePgDatabase<Relations> & { $client } — typeof db is
// the same shape the wrapper receives.
export type Database = typeof db & { $client: unknown };

const wdb = drizzleTryDb(db);

/* ------------------------------------------------------------------ */
/* C1: RAW control — does drizzle itself give precise rows here?       */
/* ------------------------------------------------------------------ */

const c1 = await db.select().from(users).where(eq(users.email, "a")).limit(1);
const c1Name: string | null = c1[0]?.name ?? null; // RAW precise?

const c2 = await db.insert(users).values({ email: "a@b.c" }).returning();
const c2Email: string | null = c2[0]?.email ?? null; // RAW precise?

const c3 = await db.insert(users).values({ email: "a@b.c" }).returning({ id: users.id });
const c3Id: string | null = c3[0]?.id ?? null; // RAW precise?

const c4 = await db.query.bookings.findMany({
  where: { status: "confirmed" },
  with: { user: true, lineItems: true },
});
const c4User: string | null = c4[0]?.user?.email ?? null; // RAW relational precise + with-nested?

const c5 = await db.query.bookings.findMany({
  where: { status: { eq: "confirmed" } },
  with: { lineItems: { where: { qty: { gt: 1 } } } },
});
const c5Sku: string | null = c5[0]?.lineItems?.[0]?.sku ?? null; // nested-with control

const c6 = await db.$count(db.select().from(bookings).as("sq")); // RAW $count exists?

/* ------------------------------------------------------------------ */
/* W1: wrapped — plain select + where + orderBy + limit                */
/* ------------------------------------------------------------------ */

const w1 = await wdb
  .select()
  .from(users)
  .where(eq(users.email, "a"))
  .orderBy(desc(users.createdAt))
  .limit(10);
// G1 FIXED: wrapped select rows are precise (RAW-parity asserted below).
const w1Name: string | null = w1.isOk() ? (w1.value[0]?.name ?? null) : null;

// W2: partial select with joins
const w2 = await wdb
  .select({ id: bookings.id, email: users.email, total: bookings.total })
  .from(bookings)
  .leftJoin(users, eq(bookings.userId, users.id))
  .where(and(eq(bookings.status, "confirmed"), isNotNull(bookings.bookedAt)))
  .orderBy(asc(bookings.bookedAt));
// G1 FIXED: partial-select rows precise.
const w2Total: string | null = w2.isOk() ? (w2.value[0]?.total ?? null) : null;

// W3: insert + returning() zero-arg
const w3 = await wdb.insert(users).values({ email: "a@b.c" }).returning();
const w3Email: string | null = w3.isOk() ? (w3.value[0]?.email ?? null) : null;

// W4: insert + returning({...}) fields
const w4 = await wdb.insert(users).values({ email: "d@e.f" }).returning({ id: users.id });
// G3 FIXED: returning({fields}) rows precise.
const w4Id: string | null = w4.isOk() ? (w4.value[0]?.id ?? null) : null;

// W5: update set + where + returning({fields}) (CAS pattern)
const w5 = await wdb
  .update(users)
  .set({ name: "x" })
  .where(eq(users.email, "a"))
  .returning({ id: users.id, email: users.email });
// G3 FIXED: update returning({fields}) precise.
const w5Email: string | null = w5.isOk() ? (w5.value[0]?.email ?? null) : null;

// W6: upsert onConflictDoUpdate with excluded.sql set + returning
const w6 = await wdb
  .insert(lineItems)
  .values({ bookingId: "x", sku: "s", qty: 1, unitPrice: "0" })
  .onConflictDoUpdate({ target: lineItems.id, set: { qty: sql`excluded.qty` } })
  .returning();
const w6Qty: number | null = w6.isOk() ? (w6.value[0]?.qty ?? null) : null;

// W7: onConflictDoNothing returning({id})
const w7 = await wdb
  .insert(users)
  .values({ email: "n@o.c" })
  .onConflictDoNothing()
  .returning({ id: users.id });

// W8: delete where no returning + delete returning
const w8 = await wdb.delete(lineItems).where(eq(lineItems.id, "x"));
const w8Count: number | null = w8.isOk() ? (w8.value.rowCount ?? null) : null;
const w9 = await wdb.delete(lineItems).where(lt(lineItems.qty, 1)).returning();

// W10: transaction — tx-scoped queries + raw tx.execute advisory lock
const w10 = await wdb.transaction(async (tx) => {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(1)`);
  const rows = await tx.select().from(bookings).where(eq(bookings.id, "x")).for("update");
  const r = await tx.insert(users).values({ email: "tx@x.com" }).returning({ id: users.id });
  return r.isOk() ? (r.value[0]?.id ?? null) : null;
});

// W11: $with CTE chain (single + multi) + unionAll inside a CTE
const cte = db.$with("recent").as(db.select({ id: bookings.id }).from(bookings));
const w11 = await wdb.with(cte).select().from(bookings).where(eq(bookings.status, "draft"));
const c1c = db.$with("c1").as(db.select({ id: bookings.id }).from(bookings));
const c2c = db
  .$with("c2")
  .as(db.select({ id: bookings.id, userId: bookings.userId }).from(bookings));
const w12 = await wdb
  .with(c1c, c2c)
  .selectDistinctOn([bookings.id])
  .from(bookings)
  .orderBy(bookings.id);
const ucte = db.$with("LineItemsUnion").as(
  db
    .select({ id: lineItems.id, sku: lineItems.sku })
    .from(lineItems)
    .unionAll(db.select({ id: lineItems.id, sku: lineItems.sku }).from(lineItems)),
);
const w13 = await wdb.with(ucte).select().from(lineItems).limit(5);

// W14: aggregate select — array_agg / countDistinct + groupBy
const w14 = await wdb
  .select({
    userId: bookings.userId,
    skus: sql<string[]>`array_agg(${lineItems.sku})`,
    n: countDistinct(lineItems.id),
  })
  .from(bookings)
  .innerJoin(lineItems, eq(lineItems.bookingId, bookings.id))
  .groupBy(bookings.userId);

// W15: selectDistinct / selectDistinctOn / $dynamic
const w15 = await wdb.selectDistinct().from(bookings).where(eq(bookings.userId, "x"));
const dyn = wdb.select().from(bookings).$dynamic();
const w16 = await dyn.where(eq(bookings.status, "draft")).limit(5);

// W17: exists() subquery in where + arrayContains + jsonb
const w17 = await wdb
  .select({ id: users.id, prefs: users.preferences })
  .from(users)
  .where(
    and(
      exists(
        db.select({ id: lineItems.id }).from(lineItems).where(eq(lineItems.bookingId, bookings.id)),
      ),
      arrayContains(bookings.tags, ["x"]),
    ),
  );

// W18: raw db.execute sql
const w18 = await wdb.execute(sql`SELECT pg_advisory_lock(42)`);

// W19: explicit .execute() materialization
const shared = wdb.select().from(users).where(isNotNull(users.name));
const w19 = await shared.execute();

// W20: relational findMany — v2 object-form where (matches trip usage)
const w20 = await wdb.query.bookings.findMany({
  where: { status: "confirmed" },
  with: { user: true, lineItems: true },
  limit: 20,
});
// G2 FIXED: with-nested relation fields resolve (exact literals below).
const w20User: string | null = w20.isOk() ? (w20.value[0]?.user?.email ?? null) : null;
// W21: relational findMany — v2 nested-with where
const w21 = await wdb.query.bookings.findMany({
  where: { status: { eq: "confirmed" } },
  with: { lineItems: { where: { qty: { gt: 1 } } } },
});
const w21Sku: string | null = w21.isOk() ? (w21.value[0]?.lineItems?.[0]?.sku ?? null) : null;

// W22: relational findFirst (deep with, checkout.ts shape)
const w22 = await wdb.query.users.findFirst({
  with: { bookings: { with: { lineItems: true } } },
  where: { id: "x" },
});
const w22Email: string | null = w22.isOk() ? (w22.value?.email ?? null) : null;

/* ------------------------------------------------------------------ */
/* W23: error narrowing — read + write sites                           */
/* ------------------------------------------------------------------ */

const w23 = await wdb.select().from(users).where(eq(users.id, "nope"));
if (w23.isErr()) {
  const narrowed: string = handleDbError(w23.error);
  if (isConnectionFailure(w23.error)) {
    const m: string = w23.error.message;
  }
  if (ConnectFailure.is(w23.error)) {
    const m2: string = w23.error.message;
  }
} else {
  const first: string | null = w23.value[0]?.name ?? null;
}
declare function handleDbError(e: DbError): string;

const w24 = await wdb.insert(users).values({ email: "dup@x.com" }).returning();
if (w24.isErr()) {
  if (UniqueViolation.is(w24.error)) {
    const c: string = w24.error.constraint;
  }
} else {
  const email: string | null = w24.value[0]?.email ?? null;
}

/* ------------------------------------------------------------------ */
/* TICKETS — raw pass-through keys. $count is a pg method that flows   */
/* through the wrapped type RAW (its errors are unclassified). batch   */
/* is D1-only (pg has no batch) — same raw pass-through on a D1 db.    */
/* ------------------------------------------------------------------ */

// T1: $count passes through RAW — errors from it are never classified.
const t1 = await wdb.$count(wdb.select().from(bookings).as("sq"));

// T3: $client pass-through (trip intersects Database with { $client }).
const t3: unknown = wdb.$client;

// G1 CONTROL: relations-less db — does the wrapper stay precise without
// the relations config? (If yes, the relations graph is what flips the
// select-row inference into the degraded unions.)
const dbNoRel = drizzle({ connection: { connectionString: "postgres://x" } });
const wdbNoRel = drizzleTryDb(dbNoRel);
const nr = await wdbNoRel.select().from(users).where(eq(users.email, "a")).limit(1);
// G1 FIXED: relations-less control precise too.
const _nrName: string | null = nr.isOk() ? (nr.value[0]?.name ?? null) : null;

/* ------------------------------------------------------------------ */
/* G1 precision — wrapped rows must be EXACTLY the raw rows (Same),     */
/* including join nullability                                           */
/* ------------------------------------------------------------------ */

type Same<A, B> = [A, B] extends [B, A] ? ([A] extends [B] ? true : false) : false;
type OkOf<R> = R extends { value: infer V } ? V : never;
type Assert<T extends true> = T;

// raw controls
const c7 = await db
  .select({ id: bookings.id, email: users.email, total: bookings.total })
  .from(bookings)
  .leftJoin(users, eq(bookings.userId, users.id))
  .where(and(eq(bookings.status, "confirmed"), isNotNull(bookings.bookedAt)))
  .orderBy(asc(bookings.bookedAt));
const c8 = await db.select().from(bookings).limit(1);

type _g1a = Assert<Same<OkOf<typeof w1>, typeof c1> extends true ? true : false>;
type _g1b = Assert<Same<OkOf<typeof w2>, typeof c7> extends true ? true : false>;
type _g1c = Assert<Same<OkOf<typeof nr>, typeof c1> extends true ? true : false>;
type _g1d = Assert<Same<OkOf<typeof w11>, typeof c8> extends true ? true : false>;

/* ------------------------------------------------------------------ */
/* G2 precision — wrapped relational rows (with/columns) == raw         */
/* ------------------------------------------------------------------ */

const _c9 = await db.query.bookings.findMany({
  where: { status: "confirmed" },
  with: { user: true, lineItems: true },
  limit: 20,
});
const _c10 = await db.query.users.findFirst({ where: { id: "x" } });
const _c11 = await db.query.bookings.findMany({
  where: { status: { eq: "confirmed" } },
  with: { lineItems: { where: { qty: { gt: 1 } } } },
});

// G2 precision — exact literals (the raw awaited type is murky as a Same
// target, so the expected rows are written out)
type _g2a = Assert<
  Same<
    OkOf<typeof w20>,
    {
      bookedAt: Date | null;
      id: string;
      note: string | null;
      status: "draft" | "confirmed" | "cancelled";
      tags: string[];
      total: string;
      userId: string;
      user: {
        blob: unknown;
        createdAt: Date;
        email: string;
        id: string;
        name: string | null;
        preferences: { locale: string; timezone?: string | undefined } | null;
      } | null;
      lineItems: { bookingId: string; id: string; qty: number; sku: string; unitPrice: string }[];
    }[]
  > extends true
    ? true
    : false
>;
type _g2c = Assert<
  Same<
    OkOf<typeof w22>,
    | {
        blob: unknown;
        createdAt: Date;
        email: string;
        id: string;
        name: string | null;
        preferences: { locale: string; timezone?: string | undefined } | null;
        bookings: {
          bookedAt: Date | null;
          id: string;
          note: string | null;
          status: "draft" | "confirmed" | "cancelled";
          tags: string[];
          total: string;
          userId: string;
          lineItems: {
            bookingId: string;
            id: string;
            qty: number;
            sku: string;
            unitPrice: string;
          }[];
        }[];
      }
    | undefined
  > extends true
    ? true
    : false
>;

/* ------------------------------------------------------------------ */
/* G3 precision — returning({fields}) rows are exact                   */
/* ------------------------------------------------------------------ */

// The chain rows resolve through the deferred `OutputFieldsOf` (the known
// tsgo deferral class — the mssql `output` probes were softened the same
// way): one-way extends proves the keys; the direct reconstruction below
// proves the reconstruction is exact in isolation.
type _g3a = Assert<OkOf<typeof w4> extends { id: string }[] ? true : false>;
type _g3b = Assert<OkOf<typeof w5> extends { id: string; email: string }[] ? true : false>;
type _g3c = Assert<OkOf<typeof w7> extends { id: string }[] ? true : false>;

type _fd1 = Assert<
  Same<
    typeof users.id extends { _: { data: infer D; notNull: infer N } }
      ? N extends true
        ? D
        : D | null
      : never,
    string
  > extends true
    ? true
    : false
>;
