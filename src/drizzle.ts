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
 *     generic builder methods instantiates their type parameters, so the
 *     PROJECTION forms degrade — `returning({ fields })` and relational
 *     `findMany({ columns })`-with-extras can lose per-call row precision
 *     (the zero-arg `returning()` and plain findMany/findFirst/findOne forms
 *     are exact). For row-exact projection types, drop to `tryDb(builder)` —
 *     same retry, same narrowing, Drizzle's own types.
 *   - `$with` and `refreshMaterializedView` pass through raw.
 *   - `values` accepts both the single-value and array forms (Drizzle
 *     overloads it; the mapped type would keep only the array form).
 *
 * The wrapper is structural over the db's own method signatures, so it works
 * for every drizzle database (pg, sqlite/D1, mysql, mssql). Type imports from
 * drizzle's driver-agnostic root modules (`drizzle-orm/relations`,
 * `drizzle-orm/utils`) re-express the relational methods with per-call
 * precision — they are erased at build time, so the runtime bundle has no
 * drizzle dependency.
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
import {
  isBuilder,
  wrapBuilder,
  type BuilderTerminals,
  type SelectSelection,
  type WrappedBuilder,
} from "./wrap.js";
import type { Result } from "better-result";
// Type-only imports from drizzle's driver-agnostic root modules (relations /
// utils — not the pg/sqlite/mysql driver subpaths), used to re-express the
// relational methods with per-call precision. Erased at build time.
import type {
  BuildQueryResult,
  DBQueryConfig,
  DBQueryConfigWithComment,
  TableRelationalConfig,
  TablesRelationalConfig,
} from "drizzle-orm/relations";
import type { KnownKeysOnly } from "drizzle-orm/utils";

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

/** Drizzle's own branded rejection for sync transactions (`DrizzleTypeError`
 * is internal to drizzle-orm — mirrored here so no import is needed). An
 * unconstructable interface: an async callback's `Promise` can never be
 * assignable to it, so the conditional's mismatch is what the caller sees. */
interface SyncTxError<T extends string> {
  readonly __typeError: T;
}

/** The wrapped transaction's callback — mirrors the SOURCE db's async-ness
 * (codex #8, P1). Async backends (pg, mysql, D1) keep the `PromiseLike`
 * surface; SYNC backends (bun:sqlite, better-sqlite3) force a synchronous
 * callback with drizzle's own reject-async mechanic: the source's callback
 * return can never be a `PromiseLike`, so a promise-returning callback fails
 * the check. The wrapped statements are Promise-returning, so nothing real
 * can run synchronously inside a wrapped tx — it is effectively rejected on
 * sync drivers, where the driver would commit before the statements resolve
 * (a mid-tx failure leaves earlier writes committed). */
type TransactionCb<
  D extends AnyDrizzleDb,
  E extends DbError,
  L extends ShapeLedger,
  T,
> = D["transaction"] extends (transaction: (tx: any) => infer R, ...rest: any[]) => any
  ? R extends PromiseLike<unknown>
    ? (tx: DrizzleTryDb<TransactionOf<D>, E, L>) => PromiseLike<T> | T
    : (
        tx: DrizzleTryDb<TransactionOf<D>, E, L>,
      ) => T extends PromiseLike<unknown>
        ? SyncTxError<"Sync drivers can't run async callbacks in transactions — the driver commits before the statements resolve. Use the raw db's transaction on sync drivers.">
        : T
  : (tx: DrizzleTryDb<TransactionOf<D>, E, L>) => PromiseLike<T> | T;

/** The db's relational query surface, resolved BEFORE the mapped wrap — a
 * bare `D["query"]` indexed access inside the object type stays deferred
 * under the native TypeScript compiler (tsgo), which defeats the
 * generic-signature match in `RelationalMethod`; the conditional extraction
 * forces resolution. */
type QuerySurfaceOf<D> = D extends { query: infer Q } ? Q : never;

/** The E-tracked relational query surface. `Q` is the db's query surface
 * ALREADY extracted (`QuerySurfaceOf<D>`) — under tsgo, mapping over the db
 * type directly (`keyof D["query"]` with D generic) keeps the per-key
 * indexed access deferred, and the generic-signature match in
 * `RelationalMethod` fails against the deferred type; mapping over the
 * resolved surface forces eager per-key resolution. */
type RelationalQueryOf<Q, E extends DbError, L extends ShapeLedger> = {
  [T in keyof Q]: WrapRelational<Q[T], E, L>;
};

/** Relational reads are SELECTs — the read-shape exclusions apply (respecting
 * the driver's ledger). */
type RelationalReadE<E extends DbError, L extends ShapeLedger> = Exclude<
  E,
  ShapeExclusions<L, "read">
>;

/** Wraps a relational query surface: promise-returning methods (`findMany` /
 * `findFirst` / `findOne`) resolve `Result<T, readE>`; `$dynamic`-style
 * methods that return builders are wrapped recursively. */

/** Per-call relational precision. Drizzle's generic methods compute the
 * result from the CALL's config (`BuildQueryResult<TSchema, TFields,
 * TConfig>`), so the mapped capture — which instantiates the generic at its
 * constraint — would claim the FULL row for `columns`/`with` projections.
 * The generic's constraint cannot be inferred bare under the native
 * compiler (`infer C` comes back `unknown`), and inferring through
 * `KnownKeysOnly<TConfig, C>` binds the UNBOUND `TConfig` — both paths dead.
 * The method's PARAM type is `KnownKeysOnly<TConfig, C0>` where C0 is the
 * CONCRETE class-bound constraint — extract the SECOND arg and match it
 * against the exact `DBQueryConfigWithComment` pattern (the bare
 * `DBQueryConfig` pattern fails against the `& { comment }` intersection;
 * G2). The mode comes from C0 ('many'/'one'), and the re-declared generic
 * recomputes `BuildQueryResult` per call. Non-matching methods (duck
 * surfaces, `$dynamic`) resolve to `never` and fall back to the mapped arms
 * below. */
type RelationalMethod<R, E extends DbError, L extends ShapeLedger> =
  R extends <_TConfig extends any>(config?: infer A) => PromiseLike<infer _R>
    ? A extends KnownKeysOnly<any, infer C0>
      ? // sqlite/mysql constrain with the bare `DBQueryConfig`, pg/mssql add
        // `& { comment? }` (DBQueryConfigWithComment) — accept both
        C0 extends DBQueryConfigWithComment<infer Mode, infer TSchema, infer TFields>
        ? RebuiltRelational<Mode, TSchema, TFields, C0, E, L>
        : C0 extends DBQueryConfig<infer Mode, infer TSchema, infer TFields>
          ? RebuiltRelational<Mode, TSchema, TFields, C0, E, L>
          : never
      : never
    : never;

/** The per-call relational method: the config keeps the RAW constraint's
 * shape (`KnownKeysOnly<TConfig, C0>`), the result is recomputed from the
 * CALL's TConfig via drizzle's own `BuildQueryResult` — `with`/`columns`
 * projections resolve exactly (G2). */
type RebuiltRelational<
  Mode,
  TSchema extends TablesRelationalConfig,
  TFields extends TableRelationalConfig,
  C0,
  E extends DbError,
  L extends ShapeLedger,
> = <TConfig extends C0 & Record<string, unknown>>(
  config?: KnownKeysOnly<TConfig, C0>,
) => Promise<
  Result<
    Mode extends "one"
      ? BuildQueryResult<TSchema, TFields, TConfig> | undefined
      : BuildQueryResult<TSchema, TFields, TConfig>[],
    RelationalReadE<E, L>
  >
>;

type WrapRelational<R, E extends DbError, L extends ShapeLedger> = {
  [K in keyof R]: RelationalMethod<R[K], E, L> extends never
    ? R[K] extends (...args: infer A) => PromiseLike<infer T>
      ? (...args: A) => Promise<Result<Awaited<T>, RelationalReadE<E, L>>>
      : R[K] extends (...args: infer A) => infer RB
        ? (...args: A) => WrapRelational<RB, E, L>
        : R[K]
    : RelationalMethod<R[K], E, L>;
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
  select: D["select"] extends { (): infer B0 }
    ? // G1: re-declare the overloads so the call's selection lands in a
      // synthesized `_` slot (the raw pre-from builder carries none); the
      // chain's `from` arm then rebuilds precise rows. The mapped
      // `ReturnType<D["select"]>` kept only the last (fields) overload with
      // its generic unbound — every call form inherited the degraded rows.
      (() => WrappedBuilder<SelectSelection<B0, undefined>, E, L>) &
        (<TSelection extends Record<string, unknown>>(
          fields: TSelection,
        ) => WrappedBuilder<SelectSelection<B0, TSelection>, E, L>)
    : never;
  selectDistinct: D["selectDistinct"] extends { (): infer B0 }
    ? (() => WrappedBuilder<SelectSelection<B0, undefined>, E, L>) &
        (<TSelection extends Record<string, unknown>>(
          fields: TSelection,
        ) => WrappedBuilder<SelectSelection<B0, TSelection>, E, L>)
    : never;
  selectDistinctOn: D["selectDistinctOn"] extends (on: infer On, fields?: infer F) => infer B
    ? // pg overloads `selectDistinctOn` (1-arg select-all | 2-arg fields);
      // the mapped `infer A` capture keeps only the LAST overload, so the
      // valid 1-arg form errored "Expected 2 arguments". `fields` optional
      // restores both call forms (codex #10). The selection lands in the
      // synthesized slot (G1) — select-all when `fields` is omitted.
      (
        on: On,
        fields?: F,
      ) => WrappedBuilder<SelectSelection<B, F extends undefined ? undefined : F>, E, L>
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
    cb: TransactionCb<D, E, L, T>,
    ...rest: D["transaction"] extends (cb: any, ...rest2: infer R) => any ? R : never[]
  ): Promise<Result<T, E>>;
  execute: D["execute"] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Result<Awaited<R>, E>>
    : never;
  with: D["with"] extends (...args: infer A) => infer W
    ? (...args: A) => {
        [K in keyof W]: W[K] extends (...args: infer WA) => infer WB
          ? K extends "insert" | "update" | "delete"
            ? // the with-factories are generic over the table like the
              // top-level methods — re-declare the generic so the chain's
              // values/set re-type from the CALLED table (the mapped
              // capture instantiates it at the constraint — `values` came
              // back `never`; codex #11)
              <TTable extends { $inferSelect: unknown }>(
                table: TTable,
              ) => WrappedBuilder<WB, E, L, TTable>
            : K extends "select" | "selectDistinct"
              ? // both are overloaded (zero-arg select-all | fields) — the
                // mapped capture keeps only the fields form, so the valid
                // zero-arg call errored; re-declare both and land the call's
                // selection in the synthesized slot (G1)
                (() => WrappedBuilder<SelectSelection<WB, undefined>, E, L>) &
                  (<TSelection extends Record<string, unknown>>(
                    fields: TSelection,
                  ) => WrappedBuilder<SelectSelection<WB, TSelection>, E, L>)
              : K extends "selectDistinctOn"
                ? // pg's with-surface selectDistinctOn is overloaded
                  // (1-arg on | 2-arg on+fields) — restore the optional
                  // fields form like the top-level factory (codex P2); the
                  // selection lands in the synthesized slot (G1)
                  W[K] extends (on: infer On, fields?: infer F) => infer WB2
                  ? (
                      on: On,
                      fields?: F,
                    ) => WrappedBuilder<
                      SelectSelection<WB2, F extends undefined ? undefined : F>,
                      E,
                      L
                    >
                  : never
                : (...args: WA) => WrappedBuilder<WB, E, L>
          : W[K];
      }
    : never;
  query: RelationalQueryOf<QuerySurfaceOf<D>, E, L>;
  // mssql (rc.4) exposes the relational surface as `_query` — same E-track
  // (codex P1); other drivers don't have it, so it's `never` for them.
  _query: D extends { _query: infer Q } ? RelationalQueryOf<Q, E, L> : never;
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
    | "_query"
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
  // E-tracked terminals for the sqlite/D1 builder surface — `run`, `all`,
  // `get` (the sqlite READ/WRITE terminals; `values` stays the insert chain
  // method and is deliberately not a terminal). A duplicate-key `run`
  // resolves `Err` (with retry) instead of throwing raw.
  const sqliteTerminals: BuilderTerminals = {
    run: (target, args) => {
      const t = target as { run(...a: unknown[]): unknown };
      return wrapExecute(() => t.run(...args));
    },
    all: (target, args) => {
      const t = target as { all(...a: unknown[]): unknown };
      return wrapExecute(() => t.all(...args));
    },
    get: (target, args) => {
      const t = target as { get(...a: unknown[]): unknown };
      return wrapExecute(() => t.get(...args));
    },
  };
  return new Proxy(db as object, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (key === "query" || key === "_query") {
        return wrapRelational(value, wrapExecute);
      }
      if (typeof value !== "function") return value;
      if (key === "transaction") {
        return (...args: unknown[]) => {
          const cb = args[0] as (tx: unknown) => unknown;
          const txConfig = args[1] as { [k: string]: unknown } | undefined;
          let cbResult: unknown;
          let cbRan = false;
          const wrappedCb = (tx: unknown) => {
            cbRan = true;
            cbResult = cb(wrapDrizzle(tx, config));
            return cbResult;
          };
          return tryTx(() => {
            cbRan = false;
            const out = (
              target as {
                transaction: (
                  cb: (tx: unknown) => unknown,
                  c?: { [k: string]: unknown },
                ) => unknown;
              }
            ).transaction(wrappedCb, txConfig);
            // Sync drivers (bun:sqlite, better-sqlite3) return the callback's
            // OWN value unwrapped; async drivers always return a fresh
            // promise. A promise callback coming back BY IDENTITY means the
            // driver committed before the wrapped statements resolved — the
            // writes already escaped the transaction (codex #8).
            if (
              cbRan &&
              cbResult !== null &&
              typeof cbResult === "object" &&
              typeof (cbResult as { then?: unknown }).then === "function" &&
              out === cbResult
            ) {
              throw new Error(
                "db-result: sync transaction backends can't run async callbacks — the driver commits before the statements resolve. Use the raw db's transaction on sync drivers.",
              );
            }
            return out;
          }, config);
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
              // the known factory keys wrap unconditionally (their entry
              // builders may lack `execute` — insert() before .values(),
              // update() before .set()) — mirroring the top-level factories;
              // anything else wraps when builder-shaped. The sqlite
              // terminals ride along so `with(...).insert(t).values(...).run()`
              // stays E-tracked (codex P1).
              return k === "select" ||
                k === "selectDistinct" ||
                k === "insert" ||
                k === "update" ||
                k === "delete"
                ? wrapBuilder(result, wrapExecute, sqliteTerminals)
                : isBuilder(result)
                  ? wrapBuilder(result, wrapExecute, sqliteTerminals)
                  : result;
            };
          }
          return wrapped;
        };
      }
      // builder factories: the entry builder may not expose `execute` yet
      // (insert() before .values(), select() before .from()) — wrap it
      // unconditionally; the chain proxy re-wraps every execute-bearing
      // result from there on. sqlite/D1 builders also expose the `run` /
      // `all` / `get` terminals — E-tracked so a duplicate-key `run`
      // resolves `Err` (and retries) instead of throwing raw.
      if (
        key === "select" ||
        key === "selectDistinct" ||
        key === "selectDistinctOn" ||
        key === "insert" ||
        key === "update" ||
        key === "delete"
      ) {
        return (...args: unknown[]) =>
          wrapBuilder(value.apply(target, args), wrapExecute, sqliteTerminals);
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
