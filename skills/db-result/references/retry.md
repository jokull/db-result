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

## The thunk rule

**The thunk form is required for retry to function.** `tryDb(promise)` can't
re-run a settled promise — retries would re-await the same outcome forever (dev
builds warn once). Keep the thunk to the SQL statement; it runs once per
attempt, so hoist `await`-ed work and narrowed variables out of it:

```ts
// ✅ retries re-run the INSERT
await tryDb(() => db.insert(users).values({ email }).returning());

// ❌ retries re-await the SAME settled promise — can never succeed
const p = db.insert(users).values({ email }).returning();
await tryDb(p);
```

## In-transaction statements

A thunk that declares a transaction-client parameter is an _in-transaction
statement_, and **statement-level auto-retry turns off** — retrying a statement
inside an aborted transaction fights `25P02` ("current transaction is
aborted"). An explicit `retry` still wins. Retrying the whole transaction is
`tryTx`'s job: see [transactions.md](./transactions.md).

## Observability

- **Did a retry happen?** A failure that survived retries carries a
  non-enumerable attempt count: `isRetriedError(e)` narrows to `e.retries`
  (initial attempt + retries, so `retries === 4` means 3 retries).
- **Why did it fail?** `e._tag` + `e.constraint` (when present) + the original
  driver error on `e.cause` (non-enumerable).
- **Wire boundaries:** strip `cause` before serializing — better-result's
  `TaggedError.toJSON()` spreads it (with stack) by design.
