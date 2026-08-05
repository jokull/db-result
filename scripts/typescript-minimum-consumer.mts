/**
 * Minimum-supported-TypeScript smoke test, consumed by
 * `tsconfig.typescript-minimum.json` (typechecked against typescript@5.4.5).
 * If this compiles, the published types work for the oldest TS we claim to
 * support. Run after `bun run build` (types are read from dist via the
 * package self-reference).
 */
import { Result } from "better-result";
import { tryDb, isUniqueViolation, type DbError } from "db-result";

const r: Promise<Result<number, DbError>> = tryDb(() => 1, { retryTransient: false });
const r2: Promise<Result<number, DbError>> = tryDb(() => 1, {
  retry: {
    times: 2,
    delayMs: 10,
    backoff: "exponential",
    shouldRetry: (e) => e.potentiallyTransient === true,
  },
});
const g = (e: unknown) => (isUniqueViolation(e) ? e.constraint : "nope");

void r;
void r2;
void g;
