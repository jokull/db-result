/**
 * Minimum-supported-TypeScript smoke test, consumed by
 * `tsconfig.typescript-minimum.json` (typechecked against typescript@5.4.5).
 * If this compiles, the published types work for the oldest TS we claim to
 * support. Run after `bun run build` (types are read from dist via the
 * package self-reference).
 */
import { Result } from "better-result";
import { tryDb, isDbError, isUniqueViolation, isRetriedError, type DbError } from "db-result";

const r: Promise<Result<number, DbError>> = tryDb(() => 1, { retryTransient: false });
const r2: Promise<Result<number, DbError>> = tryDb(() => 1, {
  retry: {
    times: 2,
    delayMs: 10,
    backoff: "exponential",
    shouldRetry: (e) => e.potentiallyTransient === true,
  },
});

// the shape lattice compiles on the minimum TS: a builder value narrows the
// union (assignable to the full Result, so this is a compile smoke)
const r3 = tryDb({ execute: () => Promise.resolve([1]) } as unknown as {
  execute(): PromiseLike<number[]>;
  groupBy(): unknown;
});
const r4 = tryDb(Promise.resolve("read"));

const g = (e: unknown) =>
  isDbError(e)
    ? isUniqueViolation(e)
      ? e.constraint
      : "db"
    : isRetriedError(e)
      ? `retried ${e.retries}x`
      : "other";

void r;
void r2;
void r3;
void r4;
void g;
