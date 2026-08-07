/**
 * Runtime tests for the drizzleTryDb wrapper — builder chains, transaction,
 * raw execute, `with`, and the relational query surface (`db.query.*`).
 *
 * The mock is a structural drizzle db: every method the proxy intercepts by
 * name, plus the `query` relational surface (table → RelationalQueryBuilder
 * with findMany/findFirst/findOne/$dynamic).
 */
import { describe, expect, test } from "bun:test";
import { drizzleTryDb } from "./drizzle.js";

const pgError = (code: string, message: string) =>
  Object.assign(new Error(message), { severity: "ERROR", code, schema: "public" });

const makeDb = (queryOverrides: Record<string, unknown> = {}) => {
  const relational = {
    Post: {
      findMany: async () => [{ id: 1 }],
      findFirst: async () => undefined,
      findOne: async () => undefined,
      $dynamic: () => ({ findMany: async () => [{ id: 2 }] }),
      ...queryOverrides,
    },
  };
  return {
    select: () => ({ from: () => ({ execute: async () => [{ id: 1 }] }) }),
    insert: () => ({
      values: () => ({
        returning: () => ({ execute: async () => [{ id: 1 }] }),
        execute: async () => [{ id: 1 }],
      }),
      execute: async () => [{ id: 1 }],
    }),
    update: () => ({
      set: () => ({ where: () => ({ execute: async () => [] }), execute: async () => [] }),
      execute: async () => [],
    }),
    delete: () => ({ where: () => ({ execute: async () => [] }), execute: async () => [] }),
    transaction: async (cb: (tx: unknown) => unknown) => cb({}),
    execute: async () => ({ rows: [] }),
    with: () => ({
      select: () => ({ from: () => ({ execute: async () => [] }), execute: async () => [] }),
    }),
    query: relational,
    $with: () => ({}),
    refreshMaterializedView: async () => ({}),
  };
};

describe("drizzleTryDb — builders, transaction, execute", () => {
  test("select chain resolves Ok(rows)", async () => {
    const wrapped = drizzleTryDb(makeDb() as never) as any;
    const result = await wrapped.select().from("posts").execute();
    expect(result.isOk()).toBe(true);
    expect(result.value).toEqual([{ id: 1 }]);
  });

  test("insert chain resolves Ok(rows)", async () => {
    const wrapped = drizzleTryDb(makeDb() as never) as any;
    const result = await wrapped.insert("posts").values({}).returning().execute();
    expect(result.isOk()).toBe(true);
    expect(result.value).toEqual([{ id: 1 }]);
  });

  test("update and delete chains resolve Ok", async () => {
    const wrapped = drizzleTryDb(makeDb() as never) as any;
    const upd = await wrapped.update("posts").set({}).where().execute();
    expect(upd.isOk()).toBe(true);
    const del = await wrapped.delete("posts").where().execute();
    expect(del.isOk()).toBe(true);
  });

  test("rejections classify into DbError", async () => {
    const db = makeDb();
    db.select = () => ({
      from: () => ({
        execute: async () => {
          throw pgError("23505", "duplicate key");
        },
      }),
    });
    const wrapped = drizzleTryDb(db as never) as any;
    const result = await wrapped.select().from("posts").execute();
    expect(result.isErr()).toBe(true);
    expect(result.error._tag).toBe("db/unique-violation");
  });

  test("transaction resolves Ok and hands an E-tracked tx", async () => {
    let txSeen = false;
    const db = makeDb();
    db.transaction = async (cb: (tx: unknown) => unknown) => cb({ select: () => 1 });
    const wrapped = drizzleTryDb(db as never) as any;
    const result = await wrapped.transaction(async (tx: any) => {
      txSeen = typeof tx.select === "function";
      return "committed";
    });
    expect(result.isOk()).toBe(true);
    expect(result.value).toBe("committed");
    expect(txSeen).toBe(true);
  });

  test("raw execute resolves Ok", async () => {
    const wrapped = drizzleTryDb(makeDb() as never) as any;
    const result = await wrapped.execute("select 1");
    expect(result.isOk()).toBe(true);
  });

  test("with surface E-tracks its builder factories", async () => {
    const wrapped = drizzleTryDb(makeDb() as never) as any;
    const result = await wrapped.with("x").select().from("posts").execute();
    expect(result.isOk()).toBe(true);
  });

  test("$with and refreshMaterializedView pass through raw", async () => {
    const wrapped = drizzleTryDb(makeDb() as never) as any;
    expect(typeof wrapped.$with).toBe("function");
    expect(typeof wrapped.refreshMaterializedView).toBe("function");
  });
});

describe("drizzleTryDb — relational query surface (db.query.*)", () => {
  test("findMany resolves Ok(rows)", async () => {
    const wrapped = drizzleTryDb(makeDb() as never) as any;
    const result = await wrapped.query.Post.findMany({ orderBy: { id: "asc" } });
    expect(result.isOk()).toBe(true);
    expect(result.value).toEqual([{ id: 1 }]);
  });

  test("findFirst no row resolves Ok(undefined)", async () => {
    const wrapped = drizzleTryDb(makeDb() as never) as any;
    const result = await wrapped.query.Post.findFirst({ where: { id: 1 } });
    expect(result.isOk()).toBe(true);
    expect(result.value).toBeUndefined();
  });

  test("relational rejections classify into DbError", async () => {
    const wrapped = drizzleTryDb(
      makeDb({
        findMany: async () => {
          throw pgError("08001", "could not establish connection");
        },
      }) as never,
    ) as any;
    const result = await wrapped.query.Post.findMany();
    expect(result.isErr()).toBe(true);
    expect(result.error._tag).toBe("db/connect-failure");
  });

  test("transient relational failures retry by re-running the query", async () => {
    let attempts = 0;
    const wrapped = drizzleTryDb(
      makeDb({
        findMany: async () => {
          attempts += 1;
          if (attempts < 3) throw pgError("40P01", "deadlock detected");
          return [{ id: 1 }];
        },
      }) as never,
    ) as any;
    const result = await wrapped.query.Post.findMany();
    expect(result.isOk()).toBe(true);
    expect(attempts).toBe(3);
  });

  test("$dynamic returns an E-tracked builder", async () => {
    const wrapped = drizzleTryDb(makeDb() as never) as any;
    const result = await wrapped.query.Post.$dynamic().findMany();
    expect(result.isOk()).toBe(true);
    expect(result.value).toEqual([{ id: 2 }]);
  });

  test("non-relational members of the query surface pass through", async () => {
    const wrapped = drizzleTryDb(makeDb() as never) as any;
    // `query` is a plain object surface — a non-builder property stays raw.
    expect(wrapped.query.Post).toBeDefined();
  });
});
