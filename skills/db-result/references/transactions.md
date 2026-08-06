# Transactions

Two shapes, distinguished by the **thunk's parameter** — the same signal the
type system uses (see below).

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

## In-transaction statement — `tryDb((tx) => …)`

Inside a transaction you already own (your own BEGIN…COMMIT, or an ORM
transaction callback), wrap each statement with the parameter form. The
parameter is your ORM's transaction client — the union carries
`db/transaction-aborted` where the driver can produce it, and statement-level
auto-retry is off:

```ts
const result = await db.transaction(async (tx) => {
  const a = await tryDb((tx) => tx.insert(accounts).values({ id: from, amount: -x }).returning());
  if (a.isErr()) return a; // rollback happens in db.transaction's catch
  const b = await tryDb((tx) => tx.insert(accounts).values({ id: to, amount: x }).returning());
  if (b.isErr()) return b;
  return Result.ok(await tx.select().from(accounts).where(eq(accounts.id, from)));
});
```

Raw-driver equivalent: pass the transaction client you got from your pool's
`connect()` + `BEGIN` — the parameter type is your signal, the runtime behavior
(retry off) follows the declared arity.

## Type-level detection — the duck-typed probe

One function (`tryDb`), two overloads; the **thunk's parameter type** selects.
Whole-function assignability cannot dispatch (arity variance), so the probe
tests the _inferred parameter type_ structurally — zero ORM imports, works for
any ORM:

```ts
export type IsTxParam<T> = T extends { isTransaction: true }
  ? true // Kysely  Transaction<DB>
  : T extends { rollback(): never }
    ? true // Drizzle PgAsyncTransaction
    : "$queryRaw" extends keyof T // Prisma: has raw surface…
      ? "$transaction" extends keyof T
        ? false
        : true // …and lacks $transaction
      : false;
```

- `tryDb(() => …)` — zero-arg → **query**: full union, transient retry on.
- `tryDb((tx) => …)` — tx-client param → **in-transaction**: union +
  `transaction-aborted` (per driver), statement retry off.
- A one-arg thunk whose parameter is **not** a transaction client is a **compile
  error** — no silent query misclassification. A new ORM's transaction client
  that matches no probe branch fails the same way: add its marker to
  `IsTxParam`.

`tryTx` is the whole-transaction surface; it takes a zero-arg thunk.

## Savepoints

No public API — Postgres savepoints are raw SQL (`SAVEPOINT` / `ROLLBACK TO`),
Drizzle exposes them only as nested `tx.transaction()`. When you use them,
classify each statement with `tryDb((tx) => …)` as above; a `ROLLBACK TO`
clears the aborted state, so statements after it classify normally again.
