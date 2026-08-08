/**
 * Shared wrapper core for the `{orm}TryDb` factories — the type-level
 * `WrappedBuilder` and the runtime builder proxy are ORM-agnostic: any
 * builder whose chain methods return execute-bearing builders gets its
 * terminal E-tracked to `Result<T, E>` with retry (re-execution) and shape
 * narrowing (per-builder `ShapeUnion`). Each factory (`drizzleTryDb`,
 * `kyselyTryDb`, `prismaTryDb`) curates its own client surface on top.
 */
import type { DbError, ShapeLedger, ShapeUnion } from "./db-result.js";
import type { Result } from "better-result";

/** The result type a builder produces, from its own `_` slot (Drizzle's
 * declared result) when present, falling back to its `execute` return.
 * MSSQL builders carry `output` (not `result`) in the slot — the output
 * clause's rows are the executable result (codex #12). */
export type ExecR<B> = B extends { _: { result: infer R } }
  ? R
  : B extends { _: { output: infer O } }
    ? O extends undefined
      ? B extends { execute(...args: any[]): PromiseLike<infer R2> }
        ? R2
        : never
      : O[]
    : B extends { execute(...args: any[]): PromiseLike<infer R> }
      ? R
      : never;

/** Drizzle's zero-arg `returning()` — all columns — reconstructed
 * structurally. The mapped chain sees only the LAST overload of the
 * overloaded `returning` (the `returning(fields)` form), so with no args its
 * fields generic instantiates at the constraint and the `_` result slot
 * degrades to `{[x: string]: unknown}[]`. The table is threaded from the
 * CALL SITE (`insert(table)`) because the intermediate builders' `_` slots
 * drop it (drizzle's `values()` returns a 3-arg `SQLiteInsertBase` whose
 * first generic is the table, not the HKT — the `_` slot no longer
 * resolves). This rebuilds the same builder with the result slot set to the
 * table's `$inferSelect` shape — what drizzle's own
 * `SQLiteInsertReturningAll`/`UpdateReturningAll` compute. */
export type ReturningAll<B, TTable> = TTable extends { $inferSelect: infer S }
  ? Omit<B, "_"> & {
      _: (B extends { _: infer Slot } ? Omit<Slot, "result" | "returning"> : {}) & {
        table: TTable;
        returning: S;
        result: S[];
      };
    }
  : B;

/** Structural stand-in for drizzle's expression types (SQL, Placeholder,
 * Param) as write values: anything with `getSQL()` or `mapWith(...)` is
 * accepted. DELIBERATELY not imported from drizzle-orm — the core package's
 * published types stay drizzle-free, so a real consumer typechecking with
 * `skipLibCheck: false` never pulls drizzle's declaration graph (rc.4's has
 * its own errors — cockroach-core `config`, etc.). */
export type DrizzleExpr =
  | { getSQL: (...args: any[]) => unknown }
  | { mapWith: (...args: any[]) => unknown };

/** INSERT-value expressions exclude COLUMNS: a column also implements
 * `getSQL()`, but raw drizzle rejects columns as insert values (they bind as
 * scalars — `undefined` → NULL), while UPDATE sets allow them. Columns carry
 * a `_` slot with `data`; SQL/Placeholder do not. (`brand` is a shared
 * discriminator so the all-optional `data` exclusion isn't a weak type.) */
export type InsertExpr = DrizzleExpr & { _?: { data?: never; brand?: unknown } };

/** Drizzle's write-object shape: per-column values may be SQL expressions
 * or placeholders (mirrors drizzle's own `SQLiteInsertValue` / update-set
 * shape — the strict `$inferInsert` re-type in the mapped chain rejected
 * expression-valued writes; codex #9). Insert values exclude columns;
 * update sets keep them (a column reference is a valid `set` source). */
export type InsertValueOf<I> = { [K in keyof I]: I[K] | InsertExpr };

/** UPDATE-set shape: same per-column union, but COLUMNS are allowed (a
 * column reference is a valid `set` source — `set({ count: other.count })`). */
export type SetValueOf<I> = { [K in keyof I]: I[K] | DrizzleExpr };

/** A selected field's row data type — structural extraction from drizzle's
 * shapes (columns carry `_` with `data`/`notNull`, SQL expressions carry
 * `_` with `type`, nested objects recurse, and the literal `true` — the
 * mssql `output({ inserted: true })` / `{ deleted: true }` full-row marker —
 * is the table's select model), so the `output`/`returning` arms rebuild
 * the result from the CALL's fields type instead of drizzle's per-call
 * inference (which degrades through the mapped type under the native
 * compiler; codex #12). `TJoinName`/`TNullable` carry the JOIN nullability
 * (G1): a left/right/full-joined table's columns are nullable regardless of
 * their own `notNull`, by matching the column's `tableName` slot. */
type FieldDataOf<F, TTable, TJoinName = never, TNullable extends boolean = false> = F extends true
  ? TTable extends { $inferSelect: infer S }
    ? S
    : unknown
  : F extends { _: { data: infer D; notNull: infer N; tableName: infer TN } }
    ? N extends true
      ? TJoinName extends never
        ? D
        : TN extends TJoinName
          ? TNullable extends true
            ? D | null
            : D
          : D
      : D | null
    : F extends { _: { type: infer T } }
      ? T
      : F extends Record<string, any>
        ? { [K in keyof F]: FieldDataOf<F[K], TTable, TJoinName, TNullable> }
        : unknown;

/** The row shape a fields-projection produces: one data type per field. */
export type OutputFieldsOf<F, TTable> = { [K in keyof F]: FieldDataOf<F[K], TTable> };

/** E-tracked sqlite/D1 terminals — `run` / `all` / `get` (rc.4 types them
 * `any`; the wrapped surface resolves `Result` with the shape union). The
 * sqlite builders carry `_` with `dialect: "sqlite"` at every chain level
 * (pg/mysql/mssql don't) — the members are `{}` for them, so no fake
 * terminals appear on other drivers. `run` is always valid; `all`/`get` on
 * MUTATION builders are gated on `.returning()` (drizzle's own restriction —
 * without it the terminal executes and yields `null`), while selects keep
 * them unconditionally. `values` stays the insert chain method and is
 * deliberately not a terminal. */
export type SqliteTerminalsOf<B, E extends DbError, L extends ShapeLedger> = B extends {
  _: { dialect: "sqlite" };
}
  ? { run: (...args: any[]) => Promise<Result<unknown, ShapeUnion<E, L, B>>> } & (B extends {
      _: { returning: infer R };
    }
      ? R extends undefined
        ? {}
        : {
            all: (...args: any[]) => Promise<Result<unknown[], ShapeUnion<E, L, B>>>;
            get: (...args: any[]) => Promise<Result<unknown, ShapeUnion<E, L, B>>>;
          }
      : {
          all: (...args: any[]) => Promise<Result<unknown[], ShapeUnion<E, L, B>>>;
          get: (...args: any[]) => Promise<Result<unknown, ShapeUnion<E, L, B>>>;
        })
  : {};

/** The pre-values mssql builder after `output(fields)`: the `_` slot is
 * rebuilt with the projected rows (like `ReturningAll`), so the chain's
 * `values` arm can propagate them into the executable result. */
type OutputAll<B, TTable, TFields> =
  TFields extends Record<string, unknown>
    ? Omit<B, "_"> & {
        _: (B extends { _: infer Slot } ? Omit<Slot, "result" | "output" | "returning"> : {}) & {
          table: TTable;
          output: OutputFieldsOf<TFields, TTable>;
          result: OutputFieldsOf<TFields, TTable>[];
        };
      }
    : B;

/** The rows a select's `from(table)` link produces — rebuilt structurally
 * instead of trusting the mapped `infer R` (the from method's TConfig
 * generic instantiates at its constraint, degrading the row type; G1).
 * The METHODS come from the raw `from` result (the pre-from builder is only
 * a factory — it has no `where`/`orderBy`/joins); the `_` slot is rebuilt
 * with precise rows so downstream `this`-based links still resolve. */
type FromOf<B, TFrom> = B extends { _: infer Slot; from: (...args: any[]) => any }
  ? Slot extends { selection: infer Sel }
    ? B["from"] extends (source: any, ...rest: any[]) => infer R
      ? R extends { _: infer RS }
        ? Omit<R, "_"> & {
            _: Omit<RS, "table" | "selection" | "result"> & {
              table: TFrom;
              selection: Sel;
              result: Sel extends undefined
                ? TFrom extends { $inferSelect: infer S }
                  ? S[]
                  : unknown[]
                : { [K in keyof Sel]: FieldDataOf<Sel[K], TFrom> }[];
            };
          }
        : B
      : B
    : B
  : B;

/** The pre-from select builder after the factory call — drizzle's
 * `PgSelectBuilder` carries NO `_` slot (its selection lives in a private
 * field), so the mapped `from` arm has nothing to rebuild from. Synthesize
 * the slot with the CALL's selection (G1); the `from` arm then produces the
 * rows. `result: never[]` marks the pre-from state — a select is not
 * executable before `.from()` (drizzle's own restriction). */
export type SelectSelection<B0, TSelection> = Omit<B0, "_"> & {
  _: {
    selection: TSelection;
    table: undefined;
    result: never[];
  };
};

/** The rows a join link produces: the current builder's rows extended with
 * the joined table's columns — nullable for left/right/full joins, inner
 * keeps the columns' own nullability (G1). For partial selects the joined
 * columns already sit in the selection; `FieldDataOf` applies the join
 * nullability by matching the column's `tableName` against the joined
 * table's name. Methods come from the raw join result (constraint-
 * instantiated but methodful). */
type JoinOf<B, TJoined, K extends "leftJoin" | "rightJoin" | "innerJoin" | "fullJoin"> = B extends {
  _: infer Slot;
} & { [P in K]: (table: any, on: any) => any }
  ? Slot extends { selection: infer Sel; table: infer TBase }
    ? B[K] extends (table: any, on: any) => infer R
      ? R extends { _: infer RS }
        ? Omit<R, "_"> & {
            _: Omit<RS, "result"> & {
              result: Sel extends undefined
                ? TBase extends { $inferSelect: infer S }
                  ? TJoined extends { $inferSelect: infer JS }
                    ? K extends "innerJoin"
                      ? (S & { [K2 in keyof JS]: JS[K2] })[]
                      : (S & { [K2 in keyof JS]: JS[K2] | null })[]
                    : S[]
                  : unknown[]
                : TJoined extends { _: { name: infer JN } }
                  ? {
                      [K2 in keyof Sel]: FieldDataOf<
                        Sel[K2],
                        TBase,
                        JN,
                        K extends "innerJoin" ? false : true
                      >;
                    }[]
                  : { [K2 in keyof Sel]: FieldDataOf<Sel[K2], TBase> }[];
            };
          }
        : B
      : B
    : B
  : B;

/** A builder whose `execute`/`then`/`catch`/`finally` resolve to
 * `Result<T, E>` and whose chain methods keep returning E-tracked builders.
 * The union narrows per builder shape via the ledger — exactly like
 * `tryDb(builder)`. Chain methods that return non-builder values keep their
 * original signatures. `values` is special-cased: Drizzle/Kysely overload it
 * (single value | array), and the mapped type would keep only the last
 * overload — the array-element union restores the single-object form. */
export type WrappedBuilder<
  B,
  E extends DbError,
  L extends ShapeLedger,
  TTable = B extends { _: { table: infer T } } ? T : never,
> = {
  // `run`/`all`/`get` are the sqlite terminals — the mapped type would keep
  // them raw (non-builder results); `SqliteTerminalsOf` re-owns them at
  // each chain level.
  [K in keyof B as K extends "execute" | "run" | "all" | "get" | keyof Promise<unknown>
    ? never
    : K]: B[K] extends (...args: infer A) => infer R
    ? K extends "output"
      ? // mssql's `output` — the pre-values insert builder's output() returns
        // an Omit'd builder WITHOUT `execute`, so the generic chain arm
        // below would pass it through raw and the E-track dies there; the
        // fields overload's result is drizzle's per-call `SelectResultFields`
        // which never instantiates through the mapped type. Re-declare the
        // generic and rebuild the result from the CALL's fields type;
        // delete/update bases overload it the same way (codex #12).
        (<TFields extends Record<string, unknown>>(
          fields: TFields,
        ) => WrappedBuilder<OutputAll<B, TTable, TFields>, E, L, TTable>) &
          (() => WrappedBuilder<ReturningAll<B, TTable>, E, L, TTable>)
      : R extends { execute: (...args: any[]) => PromiseLike<unknown> }
        ? K extends "returning"
          ? // Drizzle overloads `returning()`: zero-arg (all columns) and
            // `returning(fields)`. The mapped conditional infers `R`/`A` from
            // the overloaded method and the inference is unusable: `A` comes
            // back `[]` (matching zero-arg calls) and `R` carries polymorphic
            // `this` unresolved, so `ExecR` falls through to the execute
            // branch. The zero-arg arm therefore reconstructs from the
            // CURRENT builder `B` (concrete): all columns from B's table via
            // `ReturningAll`. The fields arm rebuilds the rows from the
            // CALL's fields type via `OutputAll` (the same per-call
            // reconstruction as the mssql `output` arm — the mapped `R`
            // degraded the rows to `{}`/`{[x:string]: unknown}`; G3).
            (<TFields extends Record<string, unknown>>(
              fields: TFields,
            ) => WrappedBuilder<OutputAll<B, TTable, TFields>, E, L, TTable>) &
              (() => WrappedBuilder<ReturningAll<B, TTable>, E, L, TTable> &
                SqliteTerminalsOf<B, E, L>)
          : K extends "onConflictDoUpdate"
            ? // the conflict handler's config is generic over the builder's
              // table — the mapped capture instantiates it at the
              // constraint, so the `set` object accepts invalid columns.
              // Re-type the set from the threaded table's insert model
              // (the target/where keep the raw types; codex P2).
              TTable extends { $inferInsert: infer I }
              ? B[K] extends (config: infer C) => any
                ? C extends { set: unknown }
                  ? (
                      config: Omit<C, "set"> & { set: Partial<SetValueOf<I>> },
                    ) => WrappedBuilder<R, E, L, TTable>
                  : (...args: A) => WrappedBuilder<R, E, L, TTable>
                : (...args: A) => WrappedBuilder<R, E, L, TTable>
              : (...args: A) => WrappedBuilder<R, E, L, TTable>
            : K extends "values"
              ? TTable extends { $inferInsert: infer I }
                ? // re-type from the threaded table — the mapped `infer V`
                  // instantiates drizzle's values param at its constraint, which
                  // accepts invalid columns; per-column values keep the
                  // expression form (`SQL` / `Placeholder`) drizzle allows.
                  // When the pre-values builder already carries the projected
                  // rows in its `_` slot (mssql `output`), the values result
                  // keeps them — drizzle's own chain loses them (the raw
                  // values result's slot has `output: undefined`)
                  (
                    value: InsertValueOf<I> | InsertValueOf<I>[],
                  ) => B extends { _: { result: infer Rows } }
                    ? WrappedBuilder<R, E, L, TTable> &
                        SqliteTerminalsOf<R, E, L> & { _: { result: Rows } }
                    : WrappedBuilder<R, E, L, TTable>
                : A extends [infer V]
                  ? V extends readonly unknown[]
                    ? (value: V | V[number]) => WrappedBuilder<R, E, L, TTable>
                    : (...args: A) => WrappedBuilder<R, E, L, TTable>
                  : (...args: A) => WrappedBuilder<R, E, L, TTable>
              : K extends "set"
                ? TTable extends { $inferInsert: infer I }
                  ? // same re-typing for the update set — the constraint
                    // instantiation accepts invalid update objects; per-column
                    // expressions AND column references stay allowed
                    (update: Partial<SetValueOf<I>>) => WrappedBuilder<R, E, L, TTable>
                  : (...args: A) => WrappedBuilder<R, E, L, TTable>
                : K extends "from"
                  ? // G1: the select chain's `from` — the mapped `infer R`
                    // instantiates drizzle's TConfig generic at its
                    // constraint, degrading the row type. Re-declare the
                    // generic and rebuild the `_` slot rows structurally.
                    <TFrom extends object>(
                      source: TFrom,
                    ) => WrappedBuilder<
                      FromOf<B, TFrom>,
                      E,
                      L,
                      TFrom extends { $inferSelect: infer _ } ? TFrom : never
                    >
                  : K extends "leftJoin" | "rightJoin" | "innerJoin" | "fullJoin"
                    ? // same story for the join links — the joined table's
                      // generic instantiates at its constraint. The rows
                      // extend the CURRENT rows with the joined columns
                      // (nullable for left/right/full).
                      <TJoined extends object>(
                        table: TJoined,
                        on: any,
                      ) => WrappedBuilder<JoinOf<B, TJoined, K>, E, L, TTable>
                    : K extends
                          | "where"
                          | "orderBy"
                          | "limit"
                          | "offset"
                          | "groupBy"
                          | "having"
                          | "for"
                          | "$dynamic"
                          | "distinct"
                          | "distinctOn"
                      ? // G1: these links don't change the projection, but
                        // their `this`-based returns reference the RAW
                        // builder's slot — re-instantiating the generics
                        // and re-degrading the rows. Return the CURRENT
                        // builder so the slot rebuilt at `from`/joins
                        // survives to the terminal.
                        (...args: any[]) => WrappedBuilder<B, E, L, TTable>
                      : (...args: A) => WrappedBuilder<R, E, L, TTable>
        : B[K]
    : B[K];
} & Promise<Result<ExecR<B>, ShapeUnion<E, L, B>>> & {
    execute: (...args: any[]) => Promise<Result<ExecR<B>, ShapeUnion<E, L, B>>>;
  } & SqliteTerminalsOf<B, E, L>;

/** A builder-shaped value: has `execute` (executable) or one of the known
 * pre-execute entry methods (`from` / `output` — Drizzle's pre-from select
 * and the mssql `output()` result), or `set` (update builders) PAIRED with
 * a builder marker (`getSQL` / `compile`). Chain results must be wrapped
 * even before they're executable, or the E-track dies at the first
 * intermediate and the rest of the chain runs raw (codex P1). Collections
 * and `values`/`set`-bearing non-builders are excluded — arrays inherit
 * `Array.prototype.values`, and URLSearchParams/FormData/Maps expose both
 * `values` (the iterator) and `set` — wrapping one would synthesize a
 * thenable that calls a nonexistent `execute` (codex P2: `$call(() => [])`).
 * Pre-values insert builders never need to match here: the db and `with`
 * factories wrap them unconditionally, and their chain results carry
 * `execute`. */
export const isBuilder = (value: unknown): boolean => {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return false;
  if (
    value instanceof Map ||
    value instanceof Set ||
    value instanceof WeakMap ||
    value instanceof WeakSet
  ) {
    return false;
  }
  const v = value as Record<string, unknown>;
  const entry =
    typeof v.execute === "function" ||
    typeof v.from === "function" ||
    typeof v.output === "function";
  const setWithMarker =
    typeof v.set === "function" &&
    (typeof (v as { getSQL?: unknown }).getSQL === "function" ||
      typeof (v as { compile?: unknown }).compile === "function");
  return entry || setWithMarker;
};

/** Optional per-method terminals: methods whose results are NOT builders but
 * still need the E-track (e.g. Kysely's `executeTakeFirst` family). Each
 * terminal receives the target builder and the call args and returns the
 * wrapped outcome. */
export type BuilderTerminals = Record<string, (target: object, args: unknown[]) => unknown>;

/** Wraps a builder so `execute`/`then`/`catch`/`finally` resolve to
 * `Result`, chain methods keep returning wrapped builders, and any
 * `terminals` methods get the E-track instead of passing through raw. */
export const wrapBuilder = (
  builder: unknown,
  wrapExecute: (execute: (...args: unknown[]) => unknown) => unknown,
  terminals?: BuilderTerminals,
): unknown => {
  if (builder === null || typeof builder !== "object") return builder;
  return new Proxy(builder as object, {
    get(target, key) {
      // Duck-typed proxy internals: the target is `object` here and the
      // builder contract is exactly "has an execute function" — asserted
      // once per branch into a named const instead of per member access.
      const executable = target as { execute: (...a: unknown[]) => unknown };
      if (key === "execute") {
        return (...args: unknown[]) => wrapExecute(() => executable.execute(...args));
      }
      if (key === "then" || key === "catch" || key === "finally") {
        // The wrapped Result is promise-shaped; re-route the protocol method.
        // Construction is deferred to the CALL: property inspection alone
        // (thenability checks, spreads, util.inspect) must never execute the
        // query — only invoking the promise method may.
        return (...args: unknown[]) => {
          const resultPromise = wrapExecute(() => executable.execute()) as unknown as Record<
            string,
            (...a: unknown[]) => unknown
          >;
          return resultPromise[key]!(...args);
        };
      }
      if (terminals && typeof key === "string" && Object.hasOwn(terminals, key)) {
        return (...args: unknown[]) => terminals[key]!(target, args);
      }
      const value = Reflect.get(target, key);
      if (typeof value === "function") {
        return (...args: unknown[]) => {
          const result = value.apply(target, args);
          return isBuilder(result) ? wrapBuilder(result, wrapExecute, terminals) : result;
        };
      }
      return value;
    },
  });
};
