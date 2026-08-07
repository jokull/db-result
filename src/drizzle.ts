/**
 * db-result/drizzle — the "commit to Result shapes" wrapper.
 *
 * `drizzleTryDb(db)` returns a db that behaves like the drizzle db you passed,
 * with the E-track in every return shape: builders execute to
 * `Promise<Result<T, E>>`, transactions resolve to `Promise<Result<T, E>>`,
 * raw `execute` resolves to `Promise<Result<…, E>>`. No `tryDb` litter at the
 * call site — wrap once, the whole codebase is on Result shapes, with retry
 * and shape narrowing applied internally.
 *
 *   - builders: retry re-executes the builder (the builder is the retry unit)
 *   - raw execute: retry re-invokes the method
 *   - transaction: retry restarts the whole transaction (tryTx semantics)
 *   - the union narrows per builder shape exactly like `tryDb(builder)`
 *   - relational queries (`db.query.<table>.findMany/findFirst/findOne`)
 *     resolve `Result<T, readUnion>` — reads exclude the constraint tags —
 *     with the same retry and classification
 *
 * Sharp edges:
 *   - the wrapped CHAIN types are structural, not literal: mapping Drizzle's
 *     generic builder methods instantiates their type parameters, so chain
 *     row types degrade to `Record<string, any>`-shaped arrays. The union
 *     narrowing, retry, and Result discipline survive; row literals do not.
 *     For row-exact types, drop to `tryDb(builder)` — same retry, same
 *     narrowing, Drizzle's own types.
 *   - `$with` and `refreshMaterializedView` pass through raw.
 *   - `values` accepts both the single-value and array forms (Drizzle
 *     overloads it; the mapped type would keep only the array form).
 *
 * The wrapper is structural over the db's own method signatures — no
 * drizzle-internal imports, so it works for every drizzle database (pg,
 * sqlite/D1, mysql, mssql). Type imports from drizzle are erased at build
 * time — the runtime bundle has no drizzle dependency.
 */
import {
  tryDb,
  tryTx,
  type DbError,
  type DefaultLedger,
  type ShapeExclusions,
  type ShapeLedger,
  type TryDbConfig,
} from "./db-result.js";
import { isBuilder, wrapBuilder, type WrappedBuilder } from "./wrap.js";
import type { Result } from "better-result";

// ─── Type-level: the E-tracked surface ──────────────────────────────────────

/** The structural drizzle db contract — any driver (pg, sqlite, mysql,
 * mssql), so the wrapper types work for every drizzle database without
 * importing driver internals. */
type AnyDrizzleDb = {
  select: (...args: any[]) => any;
  selectDistinct: (...args: any[]) => any;
  selectDistinctOn?: (...args: any[]) => any;
  insert: (table: any) => any;
  update: (table: any) => any;
  delete: (table: any) => any;
  transaction: (...args: any[]) => any;
  execute?: (...args: any[]) => any;
  with?: (...args: any[]) => any;
  query?: object;
};

/** The wrapped db's transaction client type (from its transaction signature),
 * intersected with the db contract so the recursion typechecks. */
type TransactionOf<D> = D extends {
  transaction(cb: (tx: infer TX) => any, ...rest: any[]): any;
}
  ? TX & AnyDrizzleDb
  : never;

/** Relational reads are SELECTs — the read-shape exclusions apply (respecting
 * the driver's ledger). */
type RelationalReadE<E extends DbError, L extends ShapeLedger> = Exclude<
  E,
  ShapeExclusions<L, "read">
>;

/** Wraps a relational query surface: promise-returning methods (`findMany` /
 * `findFirst` / `findOne`) resolve `Result<T, readE>`; `$dynamic`-style
 * methods that return builders are wrapped recursively. */
type WrapRelational<R, E extends DbError, L extends ShapeLedger> = {
  [K in keyof R]: R[K] extends (...args: infer A) => PromiseLike<infer T>
    ? (...args: A) => Promise<Result<Awaited<T>, RelationalReadE<E, L>>>
    : R[K] extends (...args: infer A) => infer RB
      ? (...args: A) => WrapRelational<RB, E, L>
      : R[K];
};

/** The E-tracked drizzle db surface — structural over the db's OWN method
 * signatures, so it works for pg/sqlite/mysql/mssql alike. Builder factories
 * return `WrappedBuilder`s; `transaction`, raw `execute`, `with`, and
 * relational `query` resolve to `Result`; everything else passes through raw. */
export type DrizzleTryDb<
  D extends AnyDrizzleDb,
  E extends DbError = DbError,
  L extends ShapeLedger = DefaultLedger,
> = {
  select: (...args: Parameters<D["select"]> | []) => WrappedBuilder<ReturnType<D["select"]>, E, L>;
  selectDistinct: (
    ...args: Parameters<D["selectDistinct"]> | []
  ) => WrappedBuilder<ReturnType<D["selectDistinct"]>, E, L>;
  selectDistinctOn: D["selectDistinctOn"] extends (...args: infer A) => infer B
    ? (...args: A | []) => WrappedBuilder<B, E, L>
    : never;
  insert: <TTable extends { $inferSelect: unknown }>(
    table: TTable,
  ) => WrappedBuilder<ReturnType<D["insert"]>, E, L, TTable>;
  update: <TTable extends { $inferSelect: unknown }>(
    table: TTable,
  ) => WrappedBuilder<ReturnType<D["update"]>, E, L, TTable>;
  delete: <TTable extends { $inferSelect: unknown }>(
    table: TTable,
  ) => WrappedBuilder<ReturnType<D["delete"]>, E, L, TTable>;
  transaction<T>(
    cb: (tx: DrizzleTryDb<TransactionOf<D>, E, L>) => PromiseLike<T> | T,
    ...rest: D["transaction"] extends (cb: any, ...rest2: infer R) => any ? R : never[]
  ): Promise<Result<T, E>>;
  execute: D["execute"] extends (...args: infer A) => infer R
    ? (...args: A | []) => Promise<Result<Awaited<R>, E>>
    : never;
  with: D["with"] extends (...args: infer A) => infer W
    ? (...args: A) => {
        [K in keyof W]: W[K] extends (...args: infer WA) => infer WB
          ? (...args: WA) => WrappedBuilder<WB, E, L>
          : W[K];
      }
    : never;
  query: D["query"] extends object
    ? { [T in keyof D["query"]]: WrapRelational<D["query"][T], E, L> }
    : {};
} & {
  [K in keyof D as K extends
    | "select"
    | "selectDistinct"
    | "selectDistinctOn"
    | "insert"
    | "update"
    | "delete"
    | "transaction"
    | "execute"
    | "with"
    | "query"
    ? never
    : K]: D[K];
};

// ─── Runtime: the proxy ─────────────────────────────────────────────────────

/** True when a value is a Drizzle relational query builder (has `findMany`). */
const looksRelational = (value: unknown): boolean =>
  value !== null &&
  typeof value === "object" &&
  typeof (value as { findMany?: unknown }).findMany === "function";

/** E-tracks a relational query builder: the promise-returning methods
 * (`findMany`/`findFirst`/`findOne`) get classification + retry via the
 * shared wrapExecute; `$dynamic`-style methods return builders — wrapped
 * recursively. */
const wrapRelationalBuilder = (
  builder: object,
  wrapExecute: (run: () => unknown) => unknown,
): unknown =>
  new Proxy(builder, {
    get(target, key) {
      if (key === "findMany" || key === "findFirst" || key === "findOne") {
        // Duck-typed relational surface: the promise-returning methods are
        // the contract — asserted once here.
        const methods = target as Record<string, (...a: unknown[]) => PromiseLike<unknown>>;
        return (...args: unknown[]) => wrapExecute(() => methods[key as string]!(...args));
      }
      const value = Reflect.get(target, key);
      if (typeof value === "function") {
        return (...args: unknown[]) => {
          const result = value.apply(target, args);
          return looksRelational(result) ? wrapRelationalBuilder(result, wrapExecute) : result;
        };
      }
      return value;
    },
  });

/** Wraps the db's `query` surface: table-name → relational query builder. */
const wrapRelational = (
  querySurface: unknown,
  wrapExecute: (run: () => unknown) => unknown,
): unknown => {
  if (querySurface === null || typeof querySurface !== "object") return querySurface;
  return new Proxy(querySurface as object, {
    get(target, key) {
      const value = Reflect.get(target, key);
      return looksRelational(value) ? wrapRelationalBuilder(value, wrapExecute) : value;
    },
  });
};

/** Wraps a drizzle db: the curated entry methods return E-tracked builders /
 * Results; everything else passes through raw. */
const wrapDrizzle = (db: unknown, config: TryDbConfig<DbError> | undefined): unknown => {
  if (db === null || typeof db !== "object") return db;
  const wrapExecute = (run: () => unknown) => tryDb(run, config);
  return new Proxy(db as object, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (key === "query") {
        return wrapRelational(value, wrapExecute);
      }
      if (typeof value !== "function") return value;
      if (key === "transaction") {
        return (...args: unknown[]) => {
          const cb = args[0] as (tx: unknown) => unknown;
          const txConfig = args[1] as { [k: string]: unknown } | undefined;
          return tryTx(
            () =>
              (
                target as {
                  transaction: (
                    cb: (tx: unknown) => unknown,
                    c?: { [k: string]: unknown },
                  ) => PromiseLike<unknown>;
                }
              ).transaction((tx) => cb(wrapDrizzle(tx, config)), txConfig),
            config,
          );
        };
      }
      if (key === "execute") {
        return (...args: unknown[]) =>
          tryDb(() => value.apply(target, args) as PromiseLike<unknown>, config);
      }
      if (key === "with") {
        return (...args: unknown[]) => {
          const object = value.apply(target, args) as Record<string, unknown>;
          const wrapped: Record<string, unknown> = {};
          for (const k of Object.keys(object)) {
            const method = object[k] as (...a: unknown[]) => unknown;
            wrapped[k] = (...a: unknown[]) => {
              const result = method.apply(object, a);
              return isBuilder(result) ? wrapBuilder(result, wrapExecute) : result;
            };
          }
          return wrapped;
        };
      }
      // builder factories: the entry builder may not expose `execute` yet
      // (insert() before .values(), select() before .from()) — wrap it
      // unconditionally; the chain proxy re-wraps every execute-bearing
      // result from there on.
      if (
        key === "select" ||
        key === "selectDistinct" ||
        key === "selectDistinctOn" ||
        key === "insert" ||
        key === "update" ||
        key === "delete"
      ) {
        return (...args: unknown[]) => wrapBuilder(value.apply(target, args), wrapExecute);
      }
      return value;
    },
  });
};

/**
 * Wraps a drizzle db so every return shape carries the E-track:
 *
 * ```ts
 * import { drizzle } from "drizzle-orm/node-postgres";
 * import { drizzleTryDb } from "db-result/drizzle";
 *
 * const db = drizzleTryDb(drizzle({ connection, schema }));
 * const [row] = await db.select({ id: users.id }).from(users).execute();
 * //            ^? Result<{ id: number }[], …> — no tryDb at the call site
 * ```
 *
 * `E` defaults to the full `DbError` union (sound on every protocol); tighten
 * per protocol with the explicit generic:
 * `drizzleTryDb<typeof db, SqliteDbError>(db)`.
 */
export function drizzleTryDb<D extends AnyDrizzleDb, E extends DbError = DbError>(
  db: D,
  config?: TryDbConfig<E>,
): DrizzleTryDb<D, E> {
  return wrapDrizzle(db, config as TryDbConfig<DbError> | undefined) as DrizzleTryDb<D, E>;
}
