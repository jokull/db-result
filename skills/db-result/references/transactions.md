# Transactions

One surface: **`tryTx` — the whole transaction is the unit**. There is no
in-transaction statement form; see below for why.

## Whole transaction — `tryTx`

Classification-only: **your thunk owns the transaction lifecycle** — write your
own BEGIN…COMMIT, or call your ORM's transaction API inside the thunk:

```ts
// raw driver — you own BEGIN/COMMIT
const outcome = await tryTx(async () => {
  await sql`BEGIN`;
  try {
    await sql`UPDATE accounts SET balance = balance - $1 WHERE id = ${from}`;
    await sql`UPDATE accounts SET balance = balance + $1 WHERE id = ${to}`;
    return await sql`COMMIT`;
  } catch (e) {
    await sql`ROLLBACK`.catch(() => {});
    throw e;
  }
});

// ORM — the ORM owns the lifecycle, you own the retry
const outcome = await tryTx(() =>
  db.transaction(async (tx) => {
    /* … */
  }),
);
// Kysely:        tryTx(() => db.transaction().execute(async (trx) => { /* … */ }))
// Prisma:        tryTx(() => prisma.$transaction(async (tx) => { /* … */ }))
```

**Retrying re-runs the WHOLE thunk**, which starts a fresh transaction. This is
safe by construction: a transaction that failed before COMMIT left nothing
committed (the server rolls back on error and on disconnect). The one ambiguity
is **failure at COMMIT** — connection died mid-COMMIT, did it land? Those
failures are never auto-retried (flagged `potentiallyTransient` for a deliberate
policy), exactly like mid-query loss in `tryDb`.

Doctrine recap:

1. **Never statement-retry inside a transaction.** Postgres aborts the whole
   transaction on error; a "retried" statement then fails with `25P02`. Retry
   the _whole_ transaction instead.
2. **Deferrable constraints surface at COMMIT.** `DEFERRABLE INITIALLY
DEFERRED` constraints report `23505`/`23503` on `COMMIT`, not on the INSERT —
   so keep the COMMIT inside the thunk and let `tryTx` classify it.
3. **A `db/transaction-aborted` error means stop.** The transaction is dead;
   roll back, don't continue. `25P02` (Postgres) and Prisma `P2028` both map to
   it.
4. **Write conflicts retry as a whole transaction.** Prisma's `P2034` ("write
   conflict or deadlock") is the transient to expect from interactive
   `$transaction` under contention — retried by `tryTx`'s whole-thunk policy.

## Statements inside a transaction you already own

Inside an ORM transaction callback, statements run through the ORM's own `tx`
client. There is **no one-arg `tryDb` form anymore** — the declared-parameter
shape signal was unverifiable (the parameter is never passed, so a mismatched
declaration narrowed the union against a query that never matched it). The
honest options:

```ts
const result = await db.transaction(async (tx) => {
  // wrap the WHOLE transaction — retry restarts BEGIN (recommended)
  return tryTx(() =>
    db.transaction(async (tx) => {
      await tx.insert(accounts).values({ id: from, amount: -x });
      await tx.insert(accounts).values({ id: to, amount: x });
    }),
  );
});
```

Per-statement `tryDb` inside a transaction still works via the thunk form
(`tryDb(() => tx.insert(accounts).values({ … }))`), but statement retry is
pointless there: a failed statement aborts the transaction, so a retried
statement fails again with `db/transaction-aborted` (deterministic, no retry).
Harmless, but not useful — retry the whole transaction instead.

## Savepoints

No public API — Postgres savepoints are raw SQL (`SAVEPOINT` / `ROLLBACK TO`),
Drizzle exposes them only as nested `tx.transaction()`. A `ROLLBACK TO` clears
the aborted state, so statements after it classify normally again; a nested
`tx.transaction()` that fails aborts its own scope — classify it with
`tryTx(() => tx.transaction(async (inner) => { /* … */ }))`.
