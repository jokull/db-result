/**
 * db-result/prisma — the "commit to Result shapes" wrapper for Prisma.
 *
 * `prismaTryDb(client)` returns a client that behaves like the Prisma client
 * you passed, with the E-track in every return shape: delegate calls
 * (`findMany`, `create`, …) resolve to `Promise<Result<T, E>>`,
 * `$transaction` (interactive and batch) resolves to
 * `Promise<Result<…, E>>`, raw `$queryRaw`/`$executeRaw` resolve to
 * `Promise<Result<…, E>>`. No `tryDb` litter and no thunks at the call site —
 * the wrapper owns the re-invocation (a PrismaPromise memoizes after its
 * first `then`, so retry must re-call the delegate method, never re-await).
 *
 *   - delegate calls: retry re-invokes the method (fresh PrismaPromise per
 *     attempt)
 *   - interactive `$transaction`: retry restarts the whole transaction
 *   - batch `$transaction`: retry re-creates the batch's promises
 *   - the union stays FULL for every Prisma call — Prisma has no builder
 *     types to probe, so nothing is narrowed (honest; the classifier still
 *     tags every failure exactly)
 *
 * Sharp edges:
 *   - `$extends` passes through raw: wrap the client AFTER extending, or the
 *     extension's methods bypass the E-track.
 *   - lifecycle members (`$on`, `$use`, `$connect`, `$disconnect`) resolve to
 *     `Result` too (a `$connect` failure is a classified error, which is the
 *     point).
 *
 * Type imports from @prisma/client are erased at build time — the runtime
 * bundle has no prisma dependency.
 */
import { tryDb, tryTx, type DbError, type TryDbConfig } from "./db-result.js";
import type { Result } from "better-result";
import type { Prisma } from "@prisma/client";

// ─── Type-level: the E-tracked surface ──────────────────────────────────────

/** Wraps a member: functions resolve to `Promise<Result<…, E>>`, objects
 * (model delegates) recurse, everything else passes through. Generic delegate
 * methods instantiate at their args constraint — Prisma's args ARE the
 * constraint, so the wrapped signatures stay fully usable. */
type WrapMember<M, E extends DbError> = M extends (...args: any[]) => any
  ? M extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Result<Awaited<R>, E>>
    : never
  : M extends object
    ? { [K2 in keyof M]: WrapMember<M[K2], E> }
    : M;

/** The wrapped `$transaction`: interactive (whole-tx retry, tx client
 * E-tracked) and batch (elements are the wrapper's own Result-promises). */
export type WrapTransaction<E extends DbError> = {
  <T>(
    interactive: (tx: PrismaTryDb<Prisma.TransactionClient, E>) => PromiseLike<T> | T,
    options?: { maxWait?: number; timeout?: number; isolationLevel?: unknown },
  ): Promise<Result<T, E>>;
  <T>(
    batch: PromiseLike<Result<T, E>>[],
    options?: { maxWait?: number; timeout?: number },
  ): Promise<Result<T[], E>>;
};

/** The E-tracked Prisma client surface: every member function resolves to
 * `Result`, model delegates recurse, `$transaction` is special-cased. */
export type PrismaTryDb<P, E extends DbError = DbError> = {
  [K in keyof P as K extends "$transaction" ? never : K]: WrapMember<P[K], E>;
} & { $transaction: WrapTransaction<E> };

// ─── Runtime: the proxy ─────────────────────────────────────────────────────

/** Wraps a Prisma client: every member function resolves to Result (retry
 * re-invokes the method — a fresh PrismaPromise per attempt), model delegate
 * objects recurse, `$transaction` is special-cased. */
const wrapPrisma = (client: unknown, config: TryDbConfig<DbError> | undefined): unknown => {
  if (client === null || typeof client !== "object") return client;
  /** The re-invocation factory behind each wrapped call, for batch
   * `$transaction` to rebuild its promises per attempt. */
  const factories = new WeakMap<object, () => unknown>();
  const wrapResult = (factory: () => unknown): unknown => {
    const wrapped = tryDb(factory, config);
    factories.set(wrapped as unknown as object, factory);
    return wrapped;
  };
  const wrapClient = (target: object): unknown =>
    new Proxy(target, {
      get(t, key) {
        const value = Reflect.get(t, key);
        if (key === "$transaction") {
          return (...args: unknown[]) => {
            const arg = args[0];
            const options = args[1];
            if (typeof arg === "function") {
              return tryTx(
                () =>
                  (
                    t as unknown as {
                      $transaction: (
                        cb: (tx: unknown) => unknown,
                        o?: unknown,
                      ) => PromiseLike<unknown>;
                    }
                  ).$transaction(
                    (tx) => (arg as (tx: unknown) => unknown)(wrapClient(tx as object)),
                    options,
                  ),
                config,
              );
            }
            if (Array.isArray(arg)) {
              return tryTx(
                () =>
                  (
                    t as unknown as {
                      $transaction: (
                        batch: PromiseLike<unknown>[],
                        o?: unknown,
                      ) => PromiseLike<unknown>;
                    }
                  ).$transaction(
                    (arg as unknown[]).map((element) => {
                      const factory = factories.get(element as object);
                      return factory
                        ? (factory() as PromiseLike<unknown>)
                        : (element as PromiseLike<unknown>);
                    }),
                    options,
                  ),
                config,
              );
            }
            return tryDb(
              () =>
                (
                  t as unknown as { $transaction: (a: unknown) => PromiseLike<unknown> }
                ).$transaction(arg),
              config,
            );
          };
        }
        if (typeof value === "function") {
          // every member resolves to Result via the wrapper's own retry;
          // non-thenable members ($on, $use) resolve to Result.ok(value)
          return (...args: unknown[]) => wrapResult(() => value.apply(t, args));
        }
        if (value !== null && typeof value === "object") {
          // model delegates (user, post, …) recurse so their methods E-track
          return wrapClient(value as object);
        }
        return value;
      },
    });
  return wrapClient(client as object);
};

/**
 * Wraps a Prisma client so every return shape carries the E-track:
 *
 * ```ts
 * import { prismaTryDb } from "db-result/prisma";
 *
 * const db = prismaTryDb(new PrismaClient());
 * const outcome = await db.user.findMany({ where: { id } });
 * //            ^? Promise<Result<…, DbError>> — no tryDb, no thunk
 * const tx = await db.$transaction(async (tx) => {
 *   const r = await tx.user.create({ data: { email } });
 *   return r.value;
 * });
 * ```
 *
 * `E` defaults to the full `DbError` union (Prisma never narrows — no builder
 * types to probe).
 */
export function prismaTryDb<P, E extends DbError = DbError>(
  client: P,
  config?: TryDbConfig<E>,
): PrismaTryDb<P, E> {
  return wrapPrisma(client, config as TryDbConfig<DbError> | undefined) as PrismaTryDb<P, E>;
}
