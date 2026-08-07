# ISSUES

## 1. `drizzleTryDb` write chains lose `.returning()` row precision

**Status: FIXED** (commit on db-result main, pre-0.1.1).

**Root cause (found with the drizzle-orm fork source):** the mapped
`WrappedBuilder` inferred `R`/`A` from drizzle's overloaded `returning()`
method, and the inference was unusable — `A` came back `[]` (matching
zero-arg calls) and `R` carried polymorphic `this` unresolved, so `ExecR`
fell through to the execute branch (the run result, e.g. `Changes` or
`{[x: string]: unknown}[]`). Worse: the intermediate builders' `_` slots
don't carry the table at all (drizzle's `values()` returns a 3-arg
`SQLiteInsertBase<TTable, TResultType, TRunResult>` whose first generic is
the table, not the HKT — the `_` slot no longer resolves), so a
`ReturningAll<B>` reconstruction from the builder also failed.

**Fix:** thread the table from the call site — `insert/update/delete` take
`<TTable extends { $inferSelect: unknown }>(table)` and pass it through
`WrappedBuilder<..., TTable>`; the zero-arg `returning()` arm reconstructs
the all-columns result from `TTable["$inferSelect"]`:

```ts
const rows = await db.insert(Comment).values({ ... }).returning();
// Promise<Result<Comment[], SqliteDbError>> — drizzle's exact rows
```

Verified in `src/types.test-d.ts` (insert/update/delete zero-arg returning
asserts) and against the real blog (`db.insert(Comment)...returning()` now
types `Result<Comment[], SqliteDbError>`).

**Known follow-up (NOT fixed):** the `returning({ fields })` projection
form still resolves the wrapped-but-degraded inference — drizzle's
`SelectResultFields` can't be reconstructed structurally, so per-call
fields precision needs drizzle's own generic (same family as the relational
`findMany({ columns })` projection issue). The blog and README use the
zero-arg form only. Consumers using fields projections should use
`tryDb(rawDb...)` for now (row-exact) or await the fix.
