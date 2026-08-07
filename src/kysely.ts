/**
 * db-result/kysely — the "commit to Result shapes" wrapper for Kysely.
 *
 * `kyselyTryDb(db)` returns a db that behaves like the Kysely db you passed,
 * with the E-track in every return shape: builders execute to
 * `Promise<Result<T, E>>`, whole transactions resolve to
 * `Promise<Result<T, E>>`. No `tryDb` litter at the call site.
 *
 *   - builders: retry re-executes the builder (the builder is the retry unit)
 *   - transaction: retry restarts the whole transaction (tryTx semantics)
 *   - the union narrows per builder shape exactly like `tryDb(builder)`
 *
 * Kysely's chain methods return the same builder class parameters, so the
 * wrapped chains keep Drizzle-style row precision — the mapped type only
 * instantiates method-level generics. Kysely's overloaded chain methods
 * (`where`/`and`/`or`/`orWhere` 3-arg form, `set` object form, join key
 * forms) are re-added explicitly — the mapped type would keep only the last
 * overload.
 *
 * The E-track also covers the convenience terminals: `executeTakeFirst`
 * resolves `Result<T | undefined, E>` (no row is `Ok(undefined)`, matching
 * Kysely's own contract) and `executeTakeFirstOrThrow` resolves
 * `Result<T, E | NoResultError>` — Kysely's only throw becomes a value, and
 * a custom `errorConstructor` is honored. Shape narrowing applies to both.
 *
 * Sharp edges:
 *   - `with(...)` CTE chains, `destroy`, `withPlugin`, and the executor pass
 *     through raw — CTE chains are typed through `tryDb(builder)`.
 *   - transactions resolve to Result at the `transaction().execute(cb)`
 *     terminal.
 *   - `where`'s 1-arg expression form (`where(eb => …)`) and the callback
 *     join forms (`innerJoin(eb => …)`) are dropped on wrapped builders —
 *     the mapped type restores the keyed/3-arg forms only. Use the keyed
 *     forms, or raw chains + `tryDb(builder)` for expression callbacks.
 *
 * The runtime imports only `NoResultError` and `isNoResultErrorConstructor`
 * from kysely (the peer dep is guaranteed present when this entry point is
 * used); everything else is type-only.
 */
import {
  tryDb,
  tryTx,
  type DbError,
  type DefaultLedger,
  type ShapeLedger,
  type ShapeUnion,
  type TryDbConfig,
} from "./db-result.js";
import { ExecR, wrapBuilder, type BuilderTerminals } from "./wrap.js";
import { Result } from "better-result";
import {
  NoResultError,
  isNoResultErrorConstructor,
  type AbortableQueryOptions,
  type ExecuteTakeFirstOrThrowOptions,
  type MergeQueryBuilder,
  type NoResultErrorConstructor,
  type QueryNode,
} from "kysely";
import type {
  ComparisonOperatorExpression,
  OrderByExpression,
  Compilable,
  DeleteQueryBuilder,
  DeleteResult,
  InsertQueryBuilder,
  InsertResult,
  JoinReferenceExpression,
  Kysely,
  MergeResult,
  OperandValueExpressionOrList,
  QueryResult,
  ReferenceExpression,
  SelectQueryBuilder,
  TableExpression,
  UpdateObject,
  UpdateQueryBuilder,
  UpdateResult,
} from "kysely";

// ─── Type-level: the E-tracked surface ──────────────────────────────────────

/** The wrapped db's schema, from its own type parameters. */
type SchemaOf<D> = D extends Kysely<infer S> ? S : never;
/** The wrapped db's transaction client type. */
type TransactionOf<D> = D extends { transaction(): { execute(cb: (tx: infer TX) => any): any } }
  ? TX & Kysely<any>
  : never;

/** The where-family 3-arg form (Kysely overloads it with the expression
 * form; the mapped type keeps only the latter). Returns the wrapped builder
 * itself — Kysely's chain methods return the same class parameters, so rows
 * stay precise. */
type WhereFn<B, S, TB extends keyof S, E extends DbError, L extends ShapeLedger> = <
  RE extends ReferenceExpression<S, TB>,
  VE extends OperandValueExpressionOrList<S, TB, RE>,
>(
  lhs: RE,
  op: ComparisonOperatorExpression,
  rhs: VE,
) => WrappedKyselyBuilder<B, E, L>;

/** The join key form (table, k1, k2) — Kysely overloads joins with the
 * callback form; the mapped type keeps only the latter. */
type JoinFn<B, S, TB extends keyof S, E extends DbError, L extends ShapeLedger> = <
  TE extends TableExpression<S, TB>,
  K1 extends JoinReferenceExpression<S, TB, TE>,
  K2 extends JoinReferenceExpression<S, TB, TE>,
>(
  table: TE,
  k1: K1,
  k2: K2,
) => WrappedKyselyBuilder<B, E, L>;

/** The single-result a `takeFirst`-family terminal produces, from the
 * builder's EXECUTE result — the O slot is seeded `{}` by the wrapper and
 * chain methods like `values` never update it, so it is unusable for
 * mutations. `ExecR[number]` reproduces Kysely's `SimplifySingleResult`
 * semantics (minus the absent-row `undefined`). */
type SingleResultOf<B> = ExecR<B> extends readonly unknown[] ? ExecR<B>[number] : ExecR<B>;

/** E-tracked `executeTakeFirst`, mirroring Kysely's `SimplifySingleResult`:
 * the four mutation result types are never `undefined` — only row-shaped
 * outputs can be absent. */
type TakeFirstFn<B, E extends DbError, L extends ShapeLedger> = (
  options?: AbortableQueryOptions,
) => Promise<
  Result<
    SingleResultOf<B> extends InsertResult | UpdateResult | DeleteResult | MergeResult
      ? SingleResultOf<B>
      : SingleResultOf<B> | undefined,
    ShapeUnion<E, L, B>
  >
>;

/** Instance/return type of an `errorConstructor` value (constructor or
 * callback), distributing over unions — `undefined` (the optional property
 * absent) resolves to `NoResultError`. */
type ErrorFromCtor<C> = C extends NoResultErrorConstructor
  ? InstanceType<C>
  : C extends (node: QueryNode) => infer R
    ? R
    : NoResultError;

/** The no-result error a call can produce: the caller's `errorConstructor`
 * return/instance type when supplied, else `NoResultError` — the union is
 * honest about custom constructors so exhaustive consumers never treat a
 * custom error as a `NoResultError`. The options-object form matches the
 * OPTIONAL property (a variable typed `ExecuteTakeFirstOrThrowOptions`
 * carries it optionally), so the broad type resolves to the union of both
 * possibilities rather than silently falling back to `NoResultError`. */
type NoResultErrorFor<O> = [O] extends [never | undefined]
  ? NoResultError
  : O extends NoResultErrorConstructor
    ? InstanceType<O>
    : O extends (node: QueryNode) => infer R
      ? R
      : O extends { errorConstructor?: infer C }
        ? ErrorFromCtor<NonNullable<C>> | (undefined extends C ? NoResultError : never)
        : NoResultError;

/** E-tracked `executeTakeFirstOrThrow`: no row resolves `Err(NoResultError)`
 * — or the caller's `errorConstructor` — instead of throwing. Mutation
 * builders (non-returning insert/update/delete/merge) can never yield the
 * no-result error — their terminals always produce the mutation result — so
 * the union omits it for them. */
type TakeFirstOrThrowFn<B, E extends DbError, L extends ShapeLedger> = <
  O2 extends
    | ExecuteTakeFirstOrThrowOptions
    | ExecuteTakeFirstOrThrowOptions["errorConstructor"]
    | undefined = undefined,
>(
  options?: O2,
) => Promise<
  Result<
    SingleResultOf<B>,
    SingleResultOf<B> extends InsertResult | UpdateResult | DeleteResult | MergeResult
      ? ShapeUnion<E, L, B>
      : ShapeUnion<E, L, B> | NoResultErrorFor<O2>
  >
>;

/** Re-adds the overloaded chain forms the mapped type drops, per builder
 * family. Returns `WrappedKyselyBuilder<B>` (self) — the shape is unchanged
 * and the recursion keeps the overrides at every chain level. */
type KyselyChainOverrides<B, E extends DbError, L extends ShapeLedger> =
  B extends SelectQueryBuilder<infer S, infer TB, infer O>
    ? {
        where: WhereFn<B, S, TB & keyof S, E, L>;
        and: WhereFn<B, S, TB & keyof S, E, L>;
        or: WhereFn<B, S, TB & keyof S, E, L>;
        orWhere: WhereFn<B, S, TB & keyof S, E, L>;
        leftJoin: JoinFn<B, S, TB & keyof S, E, L>;
        rightJoin: JoinFn<B, S, TB & keyof S, E, L>;
        innerJoin: JoinFn<B, S, TB & keyof S, E, L>;
        fullJoin: JoinFn<B, S, TB & keyof S, E, L>;
        orderBy: <OE extends OrderByExpression<S, TB & keyof S, O>>(
          expr: OE,
        ) => WrappedKyselyBuilder<B, E, L>;
        executeTakeFirst: TakeFirstFn<B, E, L>;
        executeTakeFirstOrThrow: TakeFirstOrThrowFn<B, E, L>;
      }
    : B extends UpdateQueryBuilder<infer S, infer _UT, infer TB, infer _O>
      ? {
          where: WhereFn<B, S, TB & keyof S, E, L>;
          and: WhereFn<B, S, TB & keyof S, E, L>;
          or: WhereFn<B, S, TB & keyof S, E, L>;
          orWhere: WhereFn<B, S, TB & keyof S, E, L>;
          set: (update: UpdateObject<S, TB & keyof S>) => WrappedKyselyBuilder<B, E, L>;
          leftJoin: JoinFn<B, S, TB & keyof S, E, L>;
          rightJoin: JoinFn<B, S, TB & keyof S, E, L>;
          innerJoin: JoinFn<B, S, TB & keyof S, E, L>;
          fullJoin: JoinFn<B, S, TB & keyof S, E, L>;
          executeTakeFirst: TakeFirstFn<B, E, L>;
          executeTakeFirstOrThrow: TakeFirstOrThrowFn<B, E, L>;
        }
      : B extends DeleteQueryBuilder<infer S, infer TB, infer _O>
        ? {
            where: WhereFn<B, S, TB & keyof S, E, L>;
            and: WhereFn<B, S, TB & keyof S, E, L>;
            or: WhereFn<B, S, TB & keyof S, E, L>;
            orWhere: WhereFn<B, S, TB & keyof S, E, L>;
            executeTakeFirst: TakeFirstFn<B, E, L>;
            executeTakeFirstOrThrow: TakeFirstOrThrowFn<B, E, L>;
          }
        : B extends InsertQueryBuilder<any, any, infer _O>
          ? {
              executeTakeFirst: TakeFirstFn<B, E, L>;
              executeTakeFirstOrThrow: TakeFirstOrThrowFn<B, E, L>;
            }
          : B extends MergeQueryBuilder<any, any, infer _O>
            ? {
                executeTakeFirst: TakeFirstFn<B, E, L>;
                executeTakeFirstOrThrow: TakeFirstOrThrowFn<B, E, L>;
              }
            : {};

/** A Kysely builder with its terminal E-tracked and the overloaded chain
 * forms restored at every chain level. The mapping instantiates only
 * method-level generics — Kysely's chain methods return the same class
 * parameters, so row types stay precise. */
export type WrappedKyselyBuilder<B, E extends DbError, L extends ShapeLedger> = {
  [K in keyof B as K extends
    | "execute"
    | "executeTakeFirst"
    | "executeTakeFirstOrThrow"
    | keyof Promise<unknown>
    ? never
    : K]: B[K] extends (...args: infer A) => infer R
    ? R extends { execute: (...args: any[]) => PromiseLike<unknown> }
      ? (...args: A) => WrappedKyselyBuilder<R, E, L>
      : B[K]
    : B[K];
} & Promise<Result<ExecR<B>, ShapeUnion<E, L, B>>> & {
    execute: (...args: any[]) => Promise<Result<ExecR<B>, ShapeUnion<E, L, B>>>;
  } & KyselyChainOverrides<B, E, L>;

/** The wrapped transaction builder: `execute(cb)` resolves to Result;
 * access-mode/isolation setters return the same wrapped shape. */
export type WrappedTransaction<D, E extends DbError, L extends ShapeLedger> = {
  execute<T>(
    cb: (tx: KyselyTryDb<TransactionOf<D>, E, L>) => PromiseLike<T> | T,
  ): Promise<Result<T, E>>;
  setAccessMode(accessMode: "read only" | "read write"): WrappedTransaction<D, E, L>;
  setIsolationLevel(
    isolationLevel: "read uncommitted" | "read committed" | "repeatable read" | "serializable",
  ): WrappedTransaction<D, E, L>;
};

/** The E-tracked Kysely db surface. Builder factories return
 * `WrappedKyselyBuilder`s (union narrowing per builder shape, precise rows);
 * `transaction().execute(cb)` and raw `executeQuery` resolve to `Result`.
 * Everything else passes through raw. */
export type KyselyTryDb<
  D extends Kysely<any>,
  E extends DbError = DbError,
  L extends ShapeLedger = DefaultLedger,
> = {
  selectFrom<TB extends keyof SchemaOf<D>>(
    table: TB,
  ): WrappedKyselyBuilder<SelectQueryBuilder<SchemaOf<D>, TB, {}>, E, L>;
  insertInto<TB extends keyof SchemaOf<D>>(
    table: TB,
  ): WrappedKyselyBuilder<InsertQueryBuilder<SchemaOf<D>, TB, InsertResult>, E, L>;
  updateTable<TB extends keyof SchemaOf<D>>(
    table: TB,
  ): WrappedKyselyBuilder<UpdateQueryBuilder<SchemaOf<D>, TB, TB, UpdateResult>, E, L>;
  deleteFrom<TB extends keyof SchemaOf<D>>(
    table: TB,
  ): WrappedKyselyBuilder<DeleteQueryBuilder<SchemaOf<D>, TB, DeleteResult>, E, L>;
  transaction(): WrappedTransaction<D, E, L>;
  executeQuery<T>(compilable: Compilable<T>): Promise<Result<QueryResult<T>, E>>;
} & {
  [K in keyof D as K extends
    | "selectFrom"
    | "insertInto"
    | "updateTable"
    | "deleteFrom"
    | "transaction"
    | "executeQuery"
    ? never
    : K]: D[K];
};

// ─── Runtime: the proxy ─────────────────────────────────────────────────────

/** Wraps a Kysely db: the curated entry methods return E-tracked builders /
 * Results; everything else passes through raw. */
const wrapKysely = (db: unknown, config: TryDbConfig<DbError> | undefined): unknown => {
  if (db === null || typeof db !== "object") return db;
  const wrapExecute = (run: () => unknown) => tryDb(run, config);
  const wrapTransaction = (builder: unknown): unknown => {
    if (builder === null || typeof builder !== "object") return builder;
    return new Proxy(builder as object, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        if (key === "execute") {
          return (cb: unknown) =>
            tryTx(
              () =>
                (
                  target as { execute: (cb: (tx: unknown) => unknown) => PromiseLike<unknown> }
                ).execute((tx) => (cb as (tx: unknown) => unknown)(wrapKysely(tx, config))),
              config,
            );
        }
        if (key === "setAccessMode" || key === "setIsolationLevel") {
          return (...args: unknown[]) => wrapTransaction(value.apply(target, args));
        }
        return value;
      },
    });
  };

  /** The `executeTakeFirst` family: same classification + retry as `execute`,
   * via the underlying `executeTakeFirst` (which never throws for no row).
   * `executeTakeFirstOrThrow` maps the no-row case to `Err(NoResultError)`
   * — or the caller's `errorConstructor` — so Kysely's only throw becomes a
   * value on the wrapped surface. */
  const takeFirstTerminals: BuilderTerminals = {
    executeTakeFirst: (target, args) => {
      const takeFirstTarget = target as { executeTakeFirst(...a: unknown[]): PromiseLike<unknown> };
      const run = () => takeFirstTarget.executeTakeFirst(...args);
      return wrapExecute(run);
    },
    executeTakeFirstOrThrow: (target, args) => {
      const takeFirstTarget = target as { executeTakeFirst(...a: unknown[]): PromiseLike<unknown> };
      const resultPromise = wrapExecute(() => takeFirstTarget.executeTakeFirst(...args)) as Promise<
        Result<unknown, DbError>
      >;
      return resultPromise.then((result) => {
        if (result.isOk() && result.value === undefined) {
          const first = args[0];
          // `errorConstructor` may be passed directly (Kysely's overload) or
          // inside options; the shape is Kysely's own — asserted once here.
          const errorConstructor: ExecuteTakeFirstOrThrowOptions["errorConstructor"] | undefined =
            typeof first === "function"
              ? (first as ExecuteTakeFirstOrThrowOptions["errorConstructor"])
              : first !== null && typeof first === "object" && "errorConstructor" in first
                ? (first as ExecuteTakeFirstOrThrowOptions).errorConstructor
                : undefined;
          const ctor = errorConstructor ?? NoResultError;
          const nodeProvider = target as { toOperationNode(): QueryNode };
          const error = isNoResultErrorConstructor(ctor)
            ? new ctor(nodeProvider.toOperationNode())
            : ctor(nodeProvider.toOperationNode());
          return Result.err(error);
        }
        return result;
      });
    },
  };

  return new Proxy(db as object, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      if (key === "transaction") {
        return () => wrapTransaction(value.apply(target, []));
      }
      if (key === "executeQuery") {
        return (...args: unknown[]) =>
          tryDb(() => value.apply(target, args) as PromiseLike<unknown>, config);
      }
      if (
        key === "selectFrom" ||
        key === "insertInto" ||
        key === "updateTable" ||
        key === "deleteFrom"
      ) {
        return (...args: unknown[]) =>
          wrapBuilder(value.apply(target, args), wrapExecute, takeFirstTerminals);
      }
      return value;
    },
  });
};

/**
 * Wraps a Kysely db so every return shape carries the E-track:
 *
 * ```ts
 * import { kyselyTryDb } from "db-result/kysely";
 *
 * const db = kyselyTryDb(new Kysely<DB>({ dialect }));
 * const outcome = await db.selectFrom("users").selectAll().where("id", "=", id).execute();
 * //            ^? Promise<Result<…, readUnion>> — no tryDb at the call site
 * const tx = await db.transaction().execute(async (tx) => { ... });
 * ```
 *
 * `E` defaults to the full `DbError` union; tighten per protocol with the
 * explicit generic: `kyselyTryDb<typeof db, SqliteDbError>(db)`.
 */
export function kyselyTryDb<D extends Kysely<any>, E extends DbError = DbError>(
  db: D,
  config?: TryDbConfig<E>,
): KyselyTryDb<D, E> {
  return wrapKysely(db, config as TryDbConfig<DbError> | undefined) as KyselyTryDb<D, E>;
}
