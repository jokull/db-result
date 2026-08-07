# db-result

> Database failures as better-result tagged errors — `Result<T, DbError>`, **retry-safe**,
> driver-agnostic. Stop hand-writing `instanceof` / `error.code` checks and hand-rolling
> retry loops. **Attempt the insert — that _is_ the uniqueness check** — we classify the
> failure and decide what's worth retrying.

```sh
bun add better-result db-result
```

## Docs for coding agents

The skill at [`skills/db-result/SKILL.md`](skills/db-result/SKILL.md) is the
starting point for agents: an escalation ladder (new to better-result → install →
migrate → reference) and a task map. The canonical, maintained documentation —
the full 14-tag vocabulary, per-driver unions, the shape lattice, retry doctrine,
and transaction guide — lives in
[`skills/db-result/references/`](skills/db-result/references/).

**The hard work, done for you:**

- **Classify** every database failure into fourteen `db/*` tags — any driver, any ORM.
- **Narrow** the error union from the thunk's parameter type — declare a Kysely
  `Transaction`, a Drizzle `PgSelect`, a Prisma `UserFindManyArgs`, and the
  impossible tags compile out of your union.
- **Retry** the failures worth retrying, with per-error backoff — and never touch the
  deterministic ones or the ambiguous ones where retrying could double-commit a write.
- **Compose** — `Result<T, DbError>` out of any thenable or thunk, ready for
  `Result.gen`, `matchErrorPartial`, and guards.

---

## The DX dream

```ts
import { Result, matchErrorPartial } from "better-result";
import { tryDb } from "db-result";

const handleSignup = async (c: Context) => {
  const outcome = await Result.gen(async function* () {
    // yield* short-circuits on Err; the error union accumulates across yields
    const body = yield* Result.await(parseBody(c.req)); // Err: BodyError
    const [user] = yield* Result.await(
      tryDb(() =>
        // Err: DbError
        db.insert(users).values({ email: body.email }).returning(),
      ),
    );
    return Result.ok(c.json({ id: user.id }, 201));
  });
  // outcome: Result<Response, BodyError | DbError> — hover it and see the full union

  if (outcome.isOk()) return outcome.value;

  // Fold only what you care about. The remainder is typed, not implicit:
  return matchErrorPartial(
    outcome.error,
    {
      "db/unique-violation": (e) => c.json({ error: "email_taken", constraint: e.constraint }, 409),
      "body/invalid": (e) => c.json({ error: "invalid_body", issues: e.issues }, 422),
    },
    (unhandled) => {
      // the compiler spells out what you're choosing to ignore:
      //   db/foreign-key-violation | db/not-null-violation | db/check-violation |
      //   db/connect-failure | db/connection-lost | db/authentication-failed |
      //   db/authorization-failed | db/sql-syntax-error | db/query-failure
      reportError(unhandled); // tag + cause + stack → your observability
      return c.json({ error: "internal" }, 500);
    },
  );
};
```

No `instanceof`, no `error.code === "23505"`, no try/catch. The union is the contract,
not the work: unhandled tags default to 500, logged with their `cause`, and the types
tell you exactly what you're choosing to ignore.

Retry lives below — the short version: **on by default, and safe**.

---

## Retry — the hard part, done

Retrying a database call sounds easy. It isn't:

- Retry **everything** and you double-commit writes — the classic "the connection died
  mid-INSERT, was it committed?" problem.
- Retry **nothing** and deadlocks, lock contention and a busy database crash your app
  for no reason.
- Get the **backoff** wrong and you hammer a sick database into the ground.

`db-result` makes these calls for you. `retryTransient` defaults to `true`:

| error                                                                                       | auto-retry?                                 | default backoff                                                  |
| ------------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------- |
| deadlock `40P01` / serialization `40001` / lock-timeout `55P03` / statement-timeout `57014` | ✅                                          | 50ms × 2ⁿ                                                        |
| too-many-connections `53300`                                                                | ✅                                          | 50ms × 2ⁿ                                                        |
| `SQLITE_BUSY` / `SQLITE_LOCKED`                                                             | ✅                                          | 50ms × 2ⁿ                                                        |
| connect-refused / DNS / connect-timeout (`ECONNREFUSED`, `ENOTFOUND`, …)                    | ✅                                          | 200ms × 2ⁿ                                                       |
| unique / foreign-key / not-null / check / auth / authz / syntax                             | ❌ deterministic — retrying is theater      | —                                                                |
| connection lost **mid-query** (`08006`, `ECONNRESET`, …)                                    | ❌ ambiguous — the write may have committed | — (still flagged `potentiallyTransient` for a deliberate policy) |

That last row is the one everyone gets wrong: retrying a mid-query connection loss can
duplicate the write you thought failed. We flag it, we don't retry it — you still can,
on purpose.

```ts
const created = await tryDb(() => db.insert(users).values({ email }).returning());
// transient failures auto-retry with the backoffs above — zero config

await tryDb(q, { retryTransient: false }); // never auto-retry
await tryDb(q, {
  // take over: you own times/delay/shouldRetry
  retry: { times: 5, delayMs: 50, backoff: "exponential" },
});
```

An explicit `retry` always wins — and the safe gate is injected even then: a custom
policy without `shouldRetry` still won't retry a unique violation.

**The thunk form is required for retry to function.** `tryDb(promise)` works, but a
settled promise can't re-run — retries would re-await the same outcome and can never
succeed. Pass a thunk: `tryDb(() => db.insert(...).returning())` (dev builds warn once
when you pass a promise with retry active). Keep the thunk to the SQL statement — it
runs once per attempt, so hoist async work (`await`-ed values) and any narrowed
variables out of it.

**Did a retry actually happen?** A failure that survived its retries carries a
non-enumerable attempt count — `isRetriedError(err)` narrows to `err.retries` — so a
handler can log _"deadlock retried 3× before failing"_ differently from a first-try
error.

---

## The vocabulary

Fourteen tags. Protocol-agnostic: the tag means the same thing on any database — the
driver identity stays in `cause`, never in the tag.

| tag                        | carries      | meaning                                                |
| -------------------------- | ------------ | ------------------------------------------------------ |
| `db/unique-violation`      | `constraint` | unique or primary-key conflict                         |
| `db/foreign-key-violation` | `constraint` | referenced row doesn't exist                           |
| `db/not-null-violation`    | `constraint` | required value absent                                  |
| `db/check-violation`       | `constraint` | a check rejected the value                             |
| `db/data-error`            | —            | value too long, numeric overflow, invalid text input   |
| `db/deadlock`              | —            | deadlock or serialization failure                      |
| `db/lock-timeout`          | —            | waited too long for a lock (incl. `SQLITE_BUSY`)       |
| `db/transaction-aborted`   | —            | the transaction is dead (`25P02`, `P2028`)             |
| `db/connect-failure`       | —            | channel never established (refused, DNS, pool timeout) |
| `db/connection-lost`       | —            | channel died mid-query — outcome unknown               |
| `db/authentication-failed` | —            | credentials rejected                                   |
| `db/authorization-failed`  | —            | insufficient permission                                |
| `db/sql-syntax-error`      | —            | the SQL (or schema reference) is wrong                 |
| `db/query-failure`         | —            | everything else that's a database failure              |

All fourteen classes are exported, plus a guard per tag (`isUniqueViolation(e)`,
`isDeadlock(e)`, `isConnectFailure(e)`, `isConnectionLost(e)`, …), the family guard
`isConnectionFailure(e)` (either connection tag), and the boundary check
`isDbError(e)` (true for the whole union) plus `isRetriedError(e)` (true when a
failure survived retries, exposing `error.retries` as the attempt count). `DbError`
is the union.

Every classified error carries `potentiallyTransient?: boolean` — `true` for the
retryable set, never for constraints or auth. It's a hint, not a policy: the
[retry section](#retry--the-hard-part-done) owns the policy and auto-retries only
the safe subset.

---

## Shape-aware types — the union narrows itself

`tryDb` reads the thunk's **parameter type** as structural evidence of what the
query can and cannot do — and narrows the error union to exactly what that shape
can produce. Declare the parameter; the impossible tags compile out. Hover the
result: the compiler spells out a different union per shape, for free:

```ts
import type { SelectQueryBuilder, Transaction, DeleteQueryBuilder } from "kysely";
import { tryDb, matchErrorPartial } from "db-result"; // + better-result

interface DB {
  users: { id: number; email: string; name: string };
}

// 1. zero-arg thunk: no evidence — everything is possible
tryDb(() => db.selectFrom("users").selectAll().execute());
//   ^? Promise<Result<User[], DbError>>           — all 14 tags

// 2. a select builder: constraints are write-only — four tags + tx-aborted gone
tryDb((q: SelectQueryBuilder<DB, "users", {}>) => db.selectFrom("users").selectAll().execute());
//   ^? Promise<Result<User[], DbError minus {
//        db/unique-violation | db/foreign-key-violation | db/not-null-violation
//      | db/check-violation | db/transaction-aborted }>
//   deadlock stays (SELECT … FOR UPDATE); data-error stays (read conversions)

// 3. a transaction client: the callback ran after acquire + BEGIN —
//    authn/connect-failure are impossible, and statement auto-retry turns off
tryDb((tx: Transaction<DB>) => tx.insertInto("users").values({ email }).execute());
//   ^? Promise<Result<…, DbError minus {
//        db/authentication-failed | db/connect-failure }>

// 4. a delete builder: FK is the only constraint a DELETE can hit
tryDb((q: DeleteQueryBuilder<DB, "users", {}>) =>
  q.deleteFrom("users").where("id", "=", id).execute(),
);
//   ^? Promise<Result<…, DbError minus {
//        db/unique-violation | db/not-null-violation | db/check-violation
//      | db/transaction-aborted }>                 — foreign-key-violation survives
```

Then fold it — and the terminal only lists what's genuinely left:

```ts
return matchErrorPartial(
  outcome.error, // the narrowed union from shape 2 above
  { "db/unique-violation": (e) => c.json({ error: "email_taken" }, 409) },
  (unhandled) => {
    // the compiler's exhaustive list, nothing more:
    //   db/deadlock | db/lock-timeout | db/data-error | db/connect-failure |
    //   db/connection-lost | db/authentication-failed | db/authorization-failed |
    //   db/sql-syntax-error | db/query-failure
    reportError(unhandled);
    return c.json({ error: "internal" }, 500);
  },
);
```

The lattice knows your ORM _and_ your driver. Kysely builders, Drizzle
builders, Prisma args objects — each probed structurally, no imports, zero
runtime cost (the probes compile away). Prisma args are the subtle one:
`{ take, orderBy }` is provably a read, while `{ where }`-only args (shared by
`findUnique` and `delete`) narrow to the delete set — FK stays, because
delete/deleteMany can FK-fail. And `db-result/sqlite` keeps `connect-failure`
inside transactions on purpose: a SQLite tx can still `ATTACH DATABASE`, which
fires CANTOPEN mid-query — the lattice refuses to lie.

**It refuses to guess.** A one-arg thunk whose parameter proves no shape is a
compile error — no silent widening to the full union:

```ts
tryDb((client: { selectFrom(): unknown }) => …); // ✗ no overload matches
// use the zero-arg form instead of guessing
```

The full lattice — every probe, the per-driver ledgers, the "reads that write"
footgun (DML CTEs can still violate constraints — the runtime classifies them
correctly, they just fall to the terminal), the honest ceilings — lives in
[`references/shapes.md`](skills/db-result/references/shapes.md).

---

## How it works — protocol detection

`tryDb` reads the **protocol** error shape, not any ORM's. It walks `Error.cause` chains
(plus the payload slots Effect wrappers use — `cause`/`failure`/`error`/`defect`) to reach
the error that carries the protocol fields:

| Protocol              | Signal                                              | Drivers                                         |
| --------------------- | --------------------------------------------------- | ----------------------------------------------- |
| PostgreSQL SQLSTATE   | `code: "23505"` + `constraint` field                | `pg`, `postgres.js`, Drizzle over pg            |
| SQLite extended codes | `code: "SQLITE_CONSTRAINT_UNIQUE"`, `errcode: 2067` | better-sqlite3, node:sqlite, libsql, bun:sqlite |
| SQLite message shapes | `"UNIQUE constraint failed: t.c"`                   | D1, wa-sqlite, anything that sets no code       |
| MySQL protocol        | `errno: 1062` / `code: "ER_DUP_ENTRY"`              | mysql2                                          |
| SQL Server            | `number: 2627`                                      | mssql                                           |
| Connection layer      | `code: "ECONNREFUSED"`, pool messages               | every driver — Node system errors               |

So the same classifier works at the driver-call level — `client.query(...)`,
`db.prepare(...).run()`, `db.insert(...)` are all just thenables — and it sees through
wrappers (DrizzleQueryError, Effect-shaped nesting) to the driver error. Classification
is duck-typed but strictly guarded: only `^[0-9A-Z]{5}$` codes count as SQLSTATE, only
enumerated prefixes count as driver codes, and constraint extraction accepts dotted
identifiers only — query text and parameters can never leak into the error data.

## What `tryDb` does _not_ classify

`tryDb` classifies **database failures** — nothing else. An error that matches no known
protocol shape is **rethrown**, loudly, as the bug it is. A `TypeError` from your own
callback is not a database failure and will not be labeled `db/query-failure`; in
`Result.gen` it surfaces as better-result's `Panic` — the defect channel, separate from
the tag union. Unknown driver shapes crash on purpose: they're a request for a new
mapping, not something to hide in the catch-all.

---

## Drivers & verification

One package, subpath entry points per driver. Real tests run locally — **no CI, ever** —
against a Docker suite and embedded engines.

```sh
docker compose up -d     # postgres:16, mysql:8, mssql 2022
bun run test:integration # the full real-driver pass
docker compose down
```

| Driver           | Signal                 | Proof                       |
| ---------------- | ---------------------- | --------------------------- |
| `pg`             | SQLSTATE + constraint  | real — Docker postgres      |
| `postgres.js`    | SQLSTATE               | real — Docker postgres      |
| `mysql2`         | `errno`                | real — Docker mysql         |
| `mssql`          | `number`               | real — Docker sqlserver     |
| `bun:sqlite`     | codes / errcode        | real — embedded             |
| `node:sqlite`    | `errcode`              | real — Node runner          |
| `better-sqlite3` | code strings           | real — embedded             |
| D1               | message shapes + cause | real — miniflare            |
| `libsql`         | extended codes         | real — `file:` embedded     |
| `wa-sqlite`      | numeric code           | fixtures                    |
| Drizzle 1.0+     | wrapper chain          | real — wrapping its queries |

## Drizzle

db-result is a **caller, not a wrapper**. It wraps the _outcome_ of any thenable —
including a drizzle 1.0+ query — and classifies the underlying driver error through
drizzle's wrapper via the cause chain. Drizzle's API is untouched; you keep building
queries your way:

```ts
const created = await tryDb(() => db.insert(users).values({ email }).returning());
if (created.isErr() && isUniqueViolation(created.error)) {
  return errors.EmailTaken({ email, constraint: created.error.constraint });
}
```

Requires drizzle **1.0+** — currently `1.0.0-rc.4`, which is exactly what we target and test against; `~0.9` error shapes are not supported.

---

## The pattern

1. **Compose private failures.** DB errors are composition currency, not wire errors —
   keep them out of your API contract.
2. **Fold at the boundary.** In a handler, fold the `db/*` tags you care about into your
   domain errors (`EmailTaken`, `OrderInvalid`…); let `matchErrorPartial`'s terminal turn
   the rest into 500 + observability.
3. **Attempt the insert is the uniqueness check** — including under races.

> **Typing the fold terminal:** `matchErrorPartial`'s terminal slot is contravariant —
> when your app's declared errors are stricter, wire-shaped tagged errors (e.g.
> result-rpc's), type the terminal's parameter as the _wider_ better-result
> `TaggedErrorLike`, or the 3-arg `matchErrorPartial(error, folds, terminal)` call stops
> typechecking.

## Growth test

A tag earns its place when it changes a caller decision real apps make, **and** ≥2
drivers give it a stable signal. Waiting in the wings, unearned so far: `db/data-error`
(value too long, numeric overflow) and `db/statement-timeout` — when a real fold needs
them and the signals stabilize, they'll earn the tag.

## Sharp edge

better-result's upstream `TaggedError.toJSON()` spreads `cause` (with stack) by design —
fine for logs, but **strip `cause` before any wire boundary** or error-reporting service
that serializes the instance.

---

## Running the suite

```sh
bun install
bun test                  # fixtures + embedded drivers — zero setup
docker compose up -d --wait
PGTEST_DSN="postgres://postgres:postgres@127.0.0.1:5433/postgres" \
MYSQLTEST_DSN="mysql://root:root@127.0.0.1:3307" \
MSSQLTEST_DSN="mssql://sa:DbResult!Passw0rd@127.0.0.1:1434/master" \
bun run test:integration  # real pg, mysql2, mssql (DSN-less engines skip)
docker compose down
```

## Provenance

Classification technique modeled on [Effect SQL's `SqlError` classifier](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/unstable/sql/SqlError.ts),
finer on the constraint family (Effect collapses FK/not-null/check into one
`ConstraintError` — the fold-at-boundary case needs them separate), and corrected where
Effect falls short (it masks SQLite extended codes, misses transient `53300`, and has no
mssql statement-timeout). Extracted from result-rpc's `tryDb`
([`result-rpc/db`](https://github.com/jokull/result-rpc/blob/main/src/db.ts)), which ships
the same classifier inside the RPC library. Shared here to answer "how do community
helpers for better-result get shared?" — see [the discussion](https://github.com/dmmulroy/better-result/issues/108).
