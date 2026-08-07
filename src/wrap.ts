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
 * declared result) when present, falling back to its `execute` return. */
export type ExecR<B> = B extends { _: { result: infer R } }
  ? R
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
  [K in keyof B as K extends "execute" | keyof Promise<unknown> ? never : K]: B[K] extends (
    ...args: infer A
  ) => infer R
    ? R extends { execute: (...args: any[]) => PromiseLike<unknown> }
      ? K extends "returning"
        ? // Drizzle overloads `returning()`: zero-arg (all columns) and
          // `returning(fields)`. The mapped conditional infers `R`/`A` from
          // the overloaded method and the inference is unusable: `A` comes
          // back `[]` (matching zero-arg calls) and `R` carries polymorphic
          // `this` unresolved, so `ExecR` falls through to the execute
          // branch. The zero-arg arm therefore reconstructs from the
          // CURRENT builder `B` (concrete): all columns from B's table via
          // `ReturningAll`. The fields arm keeps the wrapped-but-degraded
          // inference (drizzle's per-call fields projection can't be
          // reconstructed structurally — tracked as a follow-up).
          ((fields: any) => WrappedBuilder<R, E, L, TTable>) &
            (() => WrappedBuilder<ReturningAll<B, TTable>, E, L, TTable>)
        : K extends "values"
          ? TTable extends { $inferInsert: infer I }
            ? // re-type from the threaded table — the mapped `infer V`
              // instantiates drizzle's values param at its constraint, which
              // accepts invalid columns
              (value: I | I[]) => WrappedBuilder<R, E, L, TTable>
            : A extends [infer V]
              ? V extends readonly unknown[]
                ? (value: V | V[number]) => WrappedBuilder<R, E, L, TTable>
                : (...args: A) => WrappedBuilder<R, E, L, TTable>
              : (...args: A) => WrappedBuilder<R, E, L, TTable>
          : K extends "set"
            ? TTable extends { $inferInsert: infer I }
              ? // same re-typing for the update set — the constraint
                // instantiation accepts invalid update objects
                (update: Partial<I>) => WrappedBuilder<R, E, L, TTable>
              : (...args: A) => WrappedBuilder<R, E, L, TTable>
            : (...args: A) => WrappedBuilder<R, E, L, TTable>
      : B[K]
    : B[K];
} & Promise<Result<ExecR<B>, ShapeUnion<E, L, B>>> & {
    execute: (...args: any[]) => Promise<Result<ExecR<B>, ShapeUnion<E, L, B>>>;
  };

export const isBuilder = (value: unknown): boolean =>
  !!value && typeof (value as { execute?: unknown }).execute === "function";

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
