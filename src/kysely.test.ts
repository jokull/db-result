import { describe, expect, test } from "bun:test";
import { NoResultError } from "kysely";
import { kyselyTryDb } from "./kysely.js";
import type { DbError } from "./db-result.js";

const constraintOf = (e: DbError): string => (e as { constraint?: string }).constraint ?? "";

describe("kyselyTryDb — E-tracked takeFirst terminals", () => {
  // Structural stand-in for a Kysely db: only the surface the wrapped
  // takeFirst terminals touch (selectFrom → executeTakeFirst/toOperationNode).
  const node = {} as never;
  const makeDb = (row?: unknown, rejectWith?: unknown) => ({
    selectFrom: () => ({
      execute: async () => (row === undefined ? [] : [row]),
      executeTakeFirst: async () => {
        if (rejectWith !== undefined) throw rejectWith;
        return row;
      },
      toOperationNode: () => node,
    }),
  });
  // The wrapper is typed against real Kysely, so the mock crosses as `never`;
  // the runtime path is what's under test.
  const wrapped = (db: unknown) => kyselyTryDb(db as never) as any;
  // pgError in the PostgreSQL describe is scoped to that block; the wrapped
  // terminals need the same shape here.
  const makePgError = (code: string, message: string, constraint?: string) =>
    Object.assign(new Error(message), { severity: "ERROR", code, constraint, schema: "public" });

  test("executeTakeFirst resolves Ok(row)", async () => {
    const result = await wrapped(makeDb({ id: 1 }))
      .selectFrom("users")
      .executeTakeFirst();
    expect(result.isOk()).toBe(true);
    expect(result.value).toEqual({ id: 1 });
  });

  test("executeTakeFirst resolves Ok(undefined) on no row", async () => {
    const result = await wrapped(makeDb()).selectFrom("users").executeTakeFirst();
    expect(result.isOk()).toBe(true);
    expect(result.value).toBeUndefined();
  });

  test("executeTakeFirstOrThrow resolves Err(NoResultError) on no row", async () => {
    const result = await wrapped(makeDb()).selectFrom("users").executeTakeFirstOrThrow();
    expect(result.isErr()).toBe(true);
    expect(result.error).toBeInstanceOf(NoResultError);
  });

  test("executeTakeFirstOrThrow classifies DB rejections into DbError", async () => {
    const result = await wrapped(makeDb(undefined, makePgError("23505", "dup", "users_email_key")))
      .selectFrom("users")
      .executeTakeFirstOrThrow();
    expect(result.isErr()).toBe(true);
    expect(result.error._tag).toBe("db/unique-violation");
    expect(constraintOf(result.error)).toBe("users_email_key");
  });

  test("executeTakeFirstOrThrow honors a custom errorConstructor", async () => {
    class Gone extends Error {}
    const result = await wrapped(makeDb())
      .selectFrom("users")
      .executeTakeFirstOrThrow({ errorConstructor: () => new Gone("no user") });
    expect(result.isErr()).toBe(true);
    expect(result.error).toBeInstanceOf(Gone);
  });

  test("transient failures retry by re-running the takeFirst call", async () => {
    let attempts = 0;
    const db = {
      selectFrom: () => ({
        execute: async () => [],
        executeTakeFirst: async () => {
          attempts += 1;
          if (attempts < 3) throw makePgError("40P01", "deadlock detected");
          return { id: 1 };
        },
        toOperationNode: () => node,
      }),
    };
    const result = await wrapped(db).selectFrom("users").executeTakeFirst();
    expect(result.isOk()).toBe(true);
    expect(attempts).toBe(3);
  });

  test("inspecting then/catch/finally does NOT execute the query", async () => {
    let executed = 0;
    const db = {
      selectFrom: () => ({
        execute: async () => {
          executed += 1;
          return [];
        },
        executeTakeFirst: async () => undefined,
        toOperationNode: () => node,
      }),
    };
    const builder = wrapped(db).selectFrom("users");
    // property inspection only — thenability checks, spreads, util.inspect
    expect(typeof builder.then).toBe("function");
    expect(typeof builder.catch).toBe("function");
    expect(executed).toBe(0);
    await builder; // invoking the promise protocol is what executes
    expect(executed).toBe(1);
  });

  test("Object.prototype members pass through (no terminal dispatch on inherited keys)", async () => {
    const builder = wrapped(makeDb({ id: 1 })).selectFrom("users");
    expect(typeof builder.constructor).toBe("function");
    expect(typeof builder.hasOwnProperty).toBe("function");
    expect(builder.hasOwnProperty("execute")).toBe(true);
    expect(Object.hasOwn(builder, "then")).toBe(false);
    const result = await builder.executeTakeFirst();
    expect(result.isOk()).toBe(true); // terminals still dispatch on own keys
  });

  test("$call returning an array stays a plain array (no synthetic thenable)", async () => {
    // arrays inherit Array.prototype.values — the builder detection must
    // not wrap them, or the proxy synthesizes a thenable that calls a
    // nonexistent execute (codex P2)
    const db = makeDb();
    const arr = wrapped({ ...db, selectFrom: () => ({ ...db.selectFrom(), $call: () => [1, 2] }) })
      .selectFrom("users")
      .$call(() => [1, 2]);
    expect(Array.isArray(arr)).toBe(true);
    expect(typeof (arr as unknown as Record<string, unknown>).then).toBe("undefined");
  });
});
