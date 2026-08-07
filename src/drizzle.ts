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
 *
 * Sharp edges:
 *   - the wrapped CHAIN types are structural, not literal: mapping Drizzle's
 *     generic builder methods instantiates their type parameters, so chain
 *     row types degrade to `Record<string, any>`-shaped arrays. The union
 *     narrowing, retry, and Result discipline survive; row literals do not.
 *     For row-exact types, drop to `tryDb(builder)` — same retry, same
 *     narrowing, Drizzle's own types.
 *   - `query` (relational), `$with`, and `refreshMaterializedView` pass
 *     through raw — relational results are promise-shaped; wrap them with
 *     `tryDb` if you want them E-tracked.
 *   - `values` accepts both the single-value and array forms (Drizzle
 *     overloads it; the mapped type would keep only the array form).
 *
 * Type imports from drizzle are erased at build time — the runtime bundle has
 * no drizzle dependency; the wrapper works on any drizzle db (pg, sqlite,
 * mysql, mssql) regardless of driver.
 */
import {
  tryDb,
  tryTx,
  type DbError,
  type DefaultLedger,
  type ShapeLedger,
  type TryDbConfig,
} from "./db-result.js";
import { isBuilder, wrapBuilder, type WrappedBuilder } from "./wrap.js";
import type { Result } from "better-result";
import type {
  PgAsyncDatabase,
  PgAsyncDeleteBase,
  PgAsyncInsertHKT,
  PgAsyncSelectBuilder,
  PgAsyncUpdateHKT,
} from "drizzle-orm/pg-core/async";
import type {
  PgColumn,
  PgInsertBuilder,
  PgQueryResultHKT,
  PgTable,
  PgTransactionConfig,
  PgUpdateBuilder,
  SelectedFields,
} from "drizzle-orm/pg-core";
import type { SQLWrapper, WithSubquery } from "drizzle-orm";

// ─── Type-level: the E-tracked surface ──────────────────────────────────────

/** The wrapped db's query result kind (from the db's own type parameters). */
type QueryResultOf<D> = D extends PgAsyncDatabase<infer TQR, any> ? TQR : PgQueryResultHKT;
/** The wrapped db's transaction client type (from its transaction signature),
 * intersected with the db constraint so it can feed `DrizzleTryDb`. */
type TransactionOf<D> = D extends {
  transaction(cb: (tx: infer TX) => any, ...rest: any[]): any;
}
  ? TX & PgAsyncDatabase<any, any>
  : never;

/** The E-tracked drizzle db surface. Every builder-returning method returns a
 * `WrappedBuilder`; `transaction` and raw `execute` resolve to `Result`.
 * Everything else on the db (`query`, `$with`, `refreshMaterializedView`)
 * passes through with its original type. */
export type DrizzleTryDb<
  D extends PgAsyncDatabase<any, any>,
  E extends DbError = DbError,
  L extends ShapeLedger = DefaultLedger,
> = {
  select<TSelection extends SelectedFields | undefined = undefined>(
    fields?: TSelection,
  ): WrappedBuilder<PgAsyncSelectBuilder<TSelection>, E, L>;
  selectDistinct<TSelection extends SelectedFields | undefined = undefined>(
    fields?: TSelection,
  ): WrappedBuilder<PgAsyncSelectBuilder<TSelection>, E, L>;
  selectDistinctOn<TSelection extends SelectedFields | undefined = undefined>(
    on: (PgColumn | SQLWrapper)[],
    fields?: TSelection,
  ): WrappedBuilder<PgAsyncSelectBuilder<TSelection>, E, L>;
  update<TTable extends PgTable>(
    table: TTable,
  ): WrappedBuilder<PgUpdateBuilder<TTable, QueryResultOf<D>, PgAsyncUpdateHKT>, E, L>;
  insert<TTable extends PgTable>(
    table: TTable,
  ): WrappedBuilder<PgInsertBuilder<TTable, QueryResultOf<D>, false, PgAsyncInsertHKT>, E, L>;
  delete<TTable extends PgTable>(
    table: TTable,
  ): WrappedBuilder<PgAsyncDeleteBase<TTable, QueryResultOf<D>>, E, L>;
  transaction<T>(
    cb: (tx: DrizzleTryDb<TransactionOf<D>, E, L>) => PromiseLike<T> | T,
    config?: PgTransactionConfig,
  ): Promise<Result<T, E>>;
  execute(query: SQLWrapper | string): Promise<Result<Awaited<ReturnType<D["execute"]>>, E>>;
  with(...queries: WithSubquery[]): {
    select: <TSelection extends SelectedFields | undefined = undefined>(
      fields?: TSelection,
    ) => WrappedBuilder<PgAsyncSelectBuilder<TSelection>, E, L>;
    selectDistinct: <TSelection extends SelectedFields | undefined = undefined>(
      fields?: TSelection,
    ) => WrappedBuilder<PgAsyncSelectBuilder<TSelection>, E, L>;
    selectDistinctOn: <TSelection extends SelectedFields | undefined = undefined>(
      on: (PgColumn | SQLWrapper)[],
      fields?: TSelection,
    ) => WrappedBuilder<PgAsyncSelectBuilder<TSelection>, E, L>;
    update: <TTable extends PgTable>(
      table: TTable,
    ) => WrappedBuilder<PgUpdateBuilder<TTable, QueryResultOf<D>, PgAsyncUpdateHKT>, E, L>;
    insert: <TTable extends PgTable>(
      table: TTable,
    ) => WrappedBuilder<PgInsertBuilder<TTable, QueryResultOf<D>, false, PgAsyncInsertHKT>, E, L>;
    delete: <TTable extends PgTable>(
      table: TTable,
    ) => WrappedBuilder<PgAsyncDeleteBase<TTable, QueryResultOf<D>>, E, L>;
  };
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
    ? never
    : K]: D[K];
};

// ─── Runtime: the proxy ─────────────────────────────────────────────────────

/** Wraps a drizzle db: the curated entry methods return E-tracked builders /
 * Results; everything else passes through raw. */
const wrapDrizzle = (db: unknown, config: TryDbConfig<DbError> | undefined): unknown => {
  if (db === null || typeof db !== "object") return db;
  const wrapExecute = (run: () => unknown) => tryDb(run, config);
  return new Proxy(db as object, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      if (key === "transaction") {
        return (...args: unknown[]) => {
          const cb = args[0] as (tx: unknown) => unknown;
          const txConfig = args[1] as PgTransactionConfig | undefined;
          return tryTx(
            () =>
              (
                target as {
                  transaction: (
                    cb: (tx: unknown) => unknown,
                    c?: PgTransactionConfig,
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
export function drizzleTryDb<D extends PgAsyncDatabase<any, any>, E extends DbError = DbError>(
  db: D,
  config?: TryDbConfig<E>,
): DrizzleTryDb<D, E> {
  return wrapDrizzle(db, config as TryDbConfig<DbError> | undefined) as DrizzleTryDb<D, E>;
}
