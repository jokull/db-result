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

/** A builder whose `execute`/`then`/`catch`/`finally` resolve to
 * `Result<T, E>` and whose chain methods keep returning E-tracked builders.
 * The union narrows per builder shape via the ledger — exactly like
 * `tryDb(builder)`. Chain methods that return non-builder values keep their
 * original signatures. `values` is special-cased: Drizzle/Kysely overload it
 * (single value | array), and the mapped type would keep only the last
 * overload — the array-element union restores the single-object form. */
export type WrappedBuilder<B, E extends DbError, L extends ShapeLedger> = {
  [K in keyof B as K extends "execute" | keyof Promise<unknown> ? never : K]: B[K] extends (
    ...args: infer A
  ) => infer R
    ? R extends { execute: (...args: any[]) => PromiseLike<unknown> }
      ? K extends "returning"
        ? // Drizzle overloads `returning()` (zero-arg, all columns) with
          // `returning(columns)`; the mapped type keeps only the last
          // overload, so the zero-arg form is restored explicitly.
          ((...args: A) => WrappedBuilder<R, E, L>) & (() => WrappedBuilder<R, E, L>)
        : K extends "values"
          ? A extends [infer V]
            ? V extends readonly unknown[]
              ? (value: V | V[number]) => WrappedBuilder<R, E, L>
              : (...args: A) => WrappedBuilder<R, E, L>
            : (...args: A) => WrappedBuilder<R, E, L>
          : (...args: A) => WrappedBuilder<R, E, L>
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
