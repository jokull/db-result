# db-result

> Database failures as better-result tagged errors (`Result<T, DbError>`), retry-safe,
> driver-agnostic. **Attempt the insert — that _is_ the uniqueness check.** We classify
> the failure and decide what's worth retrying.

```sh
bun add better-result db-result
```

Built on [better-result](https://github.com/dmmulroy/better-result). You adopt its
`Result` model too: `tryDb` returns `Result<T, DbError>`, folds with
`matchErrorPartial`, composes in `Result.gen`.

- **Classify** every driver failure into one of 14 `db/*` tags, the same across every
  driver and ORM (pg, SQLite incl. D1, mysql, mssql, Prisma, Kysely, Drizzle):

  ```ts
  // constraints         data          contention            connection
  unique-violation       data-error    deadlock              connect-failure
  foreign-key-violation                lock-timeout          connection-lost
  not-null-violation                   transaction-aborted
  check-violation        // identity   // other
                         authentication-failed   sql-syntax-error
                         authorization-failed    query-failure
  ```

  No `instanceof`, no `error.code === "23505"`.

- **Narrow** the error union from the thunk's parameter type: declare a
  `Transaction`, a `PgSelect`, a `UserFindManyArgs`, and the impossible tags compile out.
- **Retry** only what's provably safe, with per-error backoff; never the deterministic
  errors, never the ambiguous mid-query connection loss (the write may have committed).
- **Fold** at your handler boundary: match the tags you care about with
  `matchErrorPartial` (the better-result fold helper), and its terminal arm handles
  whatever you don't fold: 500 + observability, with the compiler listing what you're
  ignoring.

## Example

```ts
import { matchErrorPartial } from "better-result";
import { tryDb } from "db-result/pg"; // or /sqlite /mysql2 /mssql /d1: subpath per driver

const outcome = await tryDb(() => db.insert(users).values({ email }).returning());

if (outcome.isErr()) {
  return matchErrorPartial(
    outcome.error,
    {
      "db/unique-violation": (e) => c.json({ error: "email_taken", constraint: e.constraint }, 409),
    },
    (unhandled) => {
      reportError(unhandled); // the compiler spells out the remaining tags here
      return c.json({ error: "internal" }, 500);
    },
  );
}
```

**Pass a thunk, not a promise.** A settled promise can't re-run, so retries would
re-await the same outcome and can never succeed (dev builds warn once). Pass
`tryDb(() => …)`. Opt-in per call site: wrap one endpoint, leave the rest throwing.
Transactions: wrap the whole `db.transaction()` in `tryTx` (whole-thunk retry) or
statements in `tryDb((tx) => …)`. Details: [transactions](./skills/db-result/references/transactions.md).

## The retry doctrine, in one breath

Deterministic failures (constraints, auth, syntax) never retry; it's theater. The
transient set (deadlock incl. serialization `40001` and Prisma's `P2034`,
lock-timeout, busy, connect-refused, too-many-connections) auto-retries with
per-error backoff. **Connection lost mid-query never auto-retries**: the write may
have committed; retrying could double it. An explicit `retry` config always wins;
`isRetriedError(e)` tells you a failure survived N attempts. If your ORM has its own
retry layer underneath (Prisma's pool acquisition), db-result's retries stack on top;
set `retryTransient: false` to keep only the ORM's, or disable the ORM's to keep only
ours. Details: [retry](./skills/db-result/references/retry.md).

## Shape-aware types: the union narrows itself

Declare the thunk's parameter; its type is evidence of what the query can and cannot
do, and the impossible tags compile out of the union. **Probes** are declared
parameters that double as type evidence. The thunk closes over the real client, so
the parameter is never used at runtime:

```ts
import type { SelectQueryBuilder, Transaction, DeleteQueryBuilder } from "kysely";
import type { PgSelect } from "drizzle-orm/pg-core";
import type { Prisma } from "@prisma/client";

interface DB {
  users: { id: number; email: string; name: string };
}

// zero-arg: the happy path; no evidence, all 14 tags, retry on
tryDb(() => db.selectFrom("users").selectAll().execute());

// select builder: constraints are write-only; unique/fk/not-null/check + tx-aborted gone
tryDb((q: SelectQueryBuilder<DB, "users", {}>) => db.selectFrom("users").selectAll().execute());
//   ^? Result<User[], DbError minus { unique | fk | not-null | check | transaction-aborted }>
//   deadlock stays (SELECT … FOR UPDATE); data-error stays (read conversions)

// transaction client (any ORM): begin succeeded; authn/connect-failure gone,
// statement retry off
tryDb((tx: Transaction<DB>) => db.insertInto("users").values({ email }).execute());

// drizzle and prisma probe the same way; plain calls classify without a probe
tryDb((q: PgSelect) => db.select().from(users));
tryDb((args: Prisma.UserFindManyArgs) => prisma.user.findMany({ where: { id } }));
tryDb(() => prisma.user.create({ data: { email } })); // P2002 → db/unique-violation

// delete builder: FK is the only constraint a DELETE can hit
tryDb((q: DeleteQueryBuilder<DB, "users", {}>) =>
  db.deleteFrom("users").where("id", "=", id).execute(),
);
```

`tryDb` never passes an argument: the parameter is `undefined` at runtime; its type
is the only signal. Every example closes over the real client (`db`, `prisma`);
declare the parameter, ignore it. Name it `_q` if your lint flags unused parameters.

Then the fold terminal lists only what's left for the select shape above:

```ts
(unhandled) => {
  // db/deadlock | db/lock-timeout | db/data-error | db/connect-failure |
  // db/connection-lost | db/authentication-failed | db/authorization-failed |
  // db/sql-syntax-error | db/query-failure
  reportError(unhandled);
  return c.json({ error: "internal" }, 500);
};
```

Structural probes only: no ORM imports, zero runtime cost (the probes compile away).
Chained queries keep the probe: joins, `where`, `orderBy` aren't probe keys, so a
realistic select still narrows. The zero-arg form is the happy path; reach for the
probe when you want the terminal (the `matchErrorPartial` unhandled arm) to list
exactly what's left. A one-arg thunk whose parameter proves no shape is a compile
error, never a silent widening to the full union. The narrowing is an optimization
you opt into by declaring the shape; a wrong declaration widens the union, never lies
at runtime (the classifier stays honest regardless). Full lattice, footguns, and
per-driver ledgers: [shapes](./skills/db-result/references/shapes.md).

## Drivers

One package, subpath entry points per protocol: `db-result/pg`, `/sqlite`, `/d1`,
`/mysql2`, `/mssql`. Every driver Drizzle and Kysely support maps to one of them (the
classifier reads protocol signals: SQLSTATE, SQLite codes, mysql errno, mssql number,
Prisma P-codes). Your ORM name is not an entry point: Kysely-on-Postgres imports from
`db-result/pg`, Drizzle-on-SQLite from `db-result/sqlite`. Drizzle: classification is
wrapper-transparent (the cause chain reaches the driver error regardless of version);
the narrowing probes are verified against 1.0+ (currently `1.0.0-rc.4`); on ~0.9
use the zero-arg form. Full map: [adoption](./skills/db-result/references/adoption.md).

## Docs for agents (and humans who want details)

The skill at [`skills/db-result/SKILL.md`](skills/db-result/SKILL.md) is the map: an
escalation ladder and a task index into [`references/`](skills/db-result/references/):
[overview](skills/db-result/references/overview.md) (the idea in one page),
[vocabulary](skills/db-result/references/vocabulary.md) (the 14 tags, per-driver
unions), [retry](skills/db-result/references/retry.md), [transactions](skills/db-result/references/transactions.md),
[patterns](skills/db-result/references/patterns.md) (upsert, idempotency keys, not-found).

## The sharp edges, up front

- **Rethrown, not labeled.** An error that matches no known protocol shape is
  rethrown as a real exception; your existing try/catch still works (inside
  `Result.gen` it surfaces as a `Panic`). Never tagged `db/query-failure`. That
  includes errors you throw inside the thunk: only driver-originated failures are
  classified. `db/query-failure` is for _known-but-unspecific_ shapes. Unknown shapes
  are a request for a new mapping, not a catch-all.
- **Not-found is data, not a tag.** A missing row is `null` / your domain error,
  never a `db/*` tag. Kysely's `NoResultError` has no protocol shape, so it's
  rethrown, not labeled. Prisma's `P2025` is a known-but-unspecific shape, so it
  lands in `db/query-failure`: reachable, but deliberately not
  tag-distinguished: prefer `findFirst`/`findUnique` and check `null`.
- **`constraint` is the driver's identifier**, not a normalized key; SQLite gives
  `table.column`, Postgres gives the constraint name. Match on the tag, disambiguate
  by `constraint` inside the arm (`users_email_key` vs an unexpected index), and use
  it for observability.
- **Fold arms read `_tag`, `constraint`, `potentiallyTransient`, and the driver
  error on `cause`.** Strip `cause` at wire boundaries: better-result's `toJSON()`
  spreads it (with stack) by design.

## Verification

Runs on Node ≥ 18 and Bun (D1/miniflare targets Workers). ESM only; TypeScript ≥ 5.4.
Real-driver tests run locally against a Docker suite (pg 16, mysql 8, mssql 2022) and
embedded engines (bun:sqlite, node:sqlite, better-sqlite3, libsql, D1/miniflare):

```sh
bun test                          # fixtures + embedded, zero setup
docker compose up -d --wait       # + the three DSNs (see package.json) →
bun run test:integration
```

Status: `0.0.1`, MIT, pre-1.0. Every release runs the full suite above first.

Classification modeled on [Effect SQL](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/unstable/sql/SqlError.ts),
finer on the constraint family (FK/not-null/check stay separate for the fold),
corrected where Effect falls short (masks SQLite extended codes, misses transient
`53300`). Extracted from [result-rpc](https://github.com/jokull/result-rpc/blob/main/src/db.ts).
