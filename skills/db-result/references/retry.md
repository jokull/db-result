# Retry — the doctrine

Retrying a database call sounds easy. It isn't:

- Retry **everything** and you double-commit writes (the classic "the connection
  died mid-INSERT, was it committed?").
- Retry **nothing** and deadlocks, lock contention and a busy database crash
  your app for no reason.
- Get the **backoff** wrong and you hammer a sick database into the ground.

`db-result` makes these calls for you. The gate is per-error and encoded at
classification time; the policy defaults are per-error.

## The three classes

| Class             | Examples                                                                                                                                                    | Default policy                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Deterministic** | unique / FK / not-null / check / data / auth / authz / syntax                                                                                               | never retried — retrying is theater                                                                              |
| **Transient**     | deadlock `40P01`/`40001`/`1213`/`1205`, lock-timeout `55P03`/`1222`/`SQLITE_BUSY`, too-many-connections `53300`, connect-refused `ECONNREFUSED`/`ENOTFOUND` | auto-retried, per-error backoff                                                                                  |
| **Ambiguous**     | connection lost mid-query (`08006`, `ECONNRESET`, `EPIPE`, "Connection terminated unexpectedly")                                                            | never auto-retried — the write may have committed (still flagged `potentiallyTransient` for a deliberate policy) |

## Defaults

`tryDb` auto-retries the transient set by default (`retryTransient: true`),
with per-error backoff:

| failure                                               | backoff    |
| ----------------------------------------------------- | ---------- |
| deadlock / lock-timeout / busy / too-many-connections | 50ms × 2ⁿ  |
| connect-refused / DNS / connect-timeout               | 200ms × 2ⁿ |

Statement-timeout (`57014`) has no distinct tag yet — it folds into transient
`db/query-failure` (auto-retried, matched as `db/query-failure`).

## Config

```ts
await tryDb(q, { retryTransient: false }); // never auto-retry

await tryDb(q, { retry: { times: 5, delayMs: 50, backoff: "exponential" } }); // you own it

await tryDb(q, { signal }); // AbortSignal forwarded to every attempt + delay
```

An explicit `retry` always wins — and the safe gate is injected even then: a
custom policy without `shouldRetry` still won't retry a unique violation.

## What can be retried

Retry re-runs the query once per attempt:

- **Builder values re-execute** — `tryDb(db.selectFrom("users").selectAll())`
  re-runs the builder on each attempt. The builder is the retry unit.
- **Thunks re-invoke** — `tryDb(() => db.insert(users).values({ email }).returning())`
  re-runs the closure. This is the form for one-shot calls (Prisma, raw SQL)
  that can't be re-executed.
- **Settled promises never retry** — a promise can't be re-run (dev builds
  warn once). Wrap in a thunk to get retry.

```ts
// ✅ builder values and thunks retry
await tryDb(db.selectFrom("users").selectAll());
await tryDb(() => prisma.user.findMany({ where: { id } }));

// ❌ a settled promise is one-shot — no auto-retry
const p = prisma.user.findMany({ where: { id } });
await tryDb(p); // warns once; wrap in a thunk to get retry
```

Keep the thunk to the SQL statement; it runs once per attempt, so hoist
`await`-ed work and narrowed variables out of it.

## In-transaction statements

There is no in-transaction statement form — statement retry inside a
transaction is pointless (a failed statement aborts the transaction, so a
"retried" statement fails again with `db/transaction-aborted`). Retry the whole
transaction with `tryTx`, which restarts BEGIN: see
[transactions.md](./transactions.md).

## Observability

- **Did a retry happen?** A failure that survived retries carries a
  non-enumerable attempt count: `isRetriedError(e)` narrows to `e.retries`
  (initial attempt + retries, so `retries === 4` means 3 retries).
- **Why did it fail?** `e._tag` + `e.constraint` (when present) + the original
  driver error on `e.cause` (non-enumerable).
- **Wire boundaries:** strip `cause` before serializing — better-result's
  `TaggedError.toJSON()` spreads it (with stack) by design.
