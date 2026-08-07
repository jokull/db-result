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

- **Narrow** the error union from the query's own type: pass the builder value
  (`db.select().from(users)`) and the impossible tags compile out. Nothing to
  declare, nothing to sync — the ORM emitted the type, so the evidence is verified.
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

const outcome = await tryDb(db.insert(users).values({ email }).returning());

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

Three forms, one retry engine:

- **Builder value** — `tryDb(db.select().from(users))`. The builder is both the
  shape and the retry unit: the union narrows to what that shape provably cannot
  raise, and retry re-executes the builder.
- **Promise-returning thunk** — `tryDb(() => prisma.user.findMany(args))`. Full
  union, retry re-invokes the thunk. The form for one-shot calls (Prisma, raw SQL,
  `client.query`) that can't be re-executed.
- **Settled promise** — `tryDb(promise)`. One-shot: full union, no auto-retry (dev
  builds warn once; wrap in a thunk to get retry).

Opt in per call site: wrap one endpoint, leave the rest throwing. Transactions:
wrap the whole `db.transaction()` in `tryTx` (whole-thunk retry). Details:
[transactions](./skills/db-result/references/transactions.md).

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

Pass the query builder itself. Its type is evidence of what the query can and cannot
do, and the impossible tags compile out of the union. No declared types, no matching
by hand: the ORM emitted the builder type, so the evidence is verified by
construction.

```ts
import { tryDb, tryTx } from "db-result/pg";
import type { Kysely } from "kysely";

interface DB {
  users: { id: number; email: string; name: string };
}
declare const db: Kysely<DB>;

// builder value: the shape IS the type — constraints are write-only
const rows = await tryDb(db.selectFrom("users").selectAll());
//   ^? Result<User[], DbError minus { unique | fk | not-null | check }>
//   deadlock stays (SELECT … FOR UPDATE); data-error stays (read conversions);
//   transaction-aborted stays (a tx-bound select can raise 25P02)

// write builders: every constraint stays in the union
await tryDb(db.insertInto("users").values({ email }).returningAll());

// delete builder: FK is the only constraint a DELETE can hit
await tryDb(db.deleteFrom("users").where("id", "=", id));

// one-shot calls (Prisma, raw SQL): the thunk form — full union, retry on
await tryDb(() => prisma.user.create({ data: { email } })); // P2002 → db/unique-violation

// transactions: wrap the whole thing — BEGIN can fail, so the full union is honest
await tryTx(() =>
  db.transaction().execute(async (tx) => {
    /* … */
  }),
);
```

Then the fold terminal lists only what's left for the select shape above:

```ts
(unhandled) => {
  // db/deadlock | db/lock-timeout | db/data-error | db/connect-failure |
  // db/connection-lost | db/transaction-aborted | db/authentication-failed |
  // db/authorization-failed | db/sql-syntax-error | db/query-failure
  reportError(unhandled);
  return c.json({ error: "internal" }, 500);
};
```

Chained queries keep the shape: joins, `where`, `orderBy` aren't probe keys, so a
realistic select still narrows. A builder that proves no shape (raw SQL, Kysely's
`mergeInto`) is a compile error — use the thunk form rather than guessing; the
lattice never silently widens. Narrowing is structural only: no ORM imports, zero
runtime cost (the probes compile away), and the runtime classifier is never
affected — it stays honest for every shape, including the reads-that-write
footgun. Full lattice, footguns, and per-driver ledgers:
[shapes](./skills/db-result/references/shapes.md).

## Commit to Result shapes: `drizzleTryDb`

If you want the whole codebase on Result shapes — no `tryDb` at every call site,
no thunks — wrap the drizzle client once:

```ts
import { drizzle } from "drizzle-orm/node-postgres";
import { drizzleTryDb } from "db-result/drizzle";

const db = drizzleTryDb(drizzle({ connection, schema }));

const outcome = await db.select({ id: users.id }).from(users).execute();
//            ^? Promise<Result<…, readUnion>> — unwrap with isOk()/isErr()
if (outcome.isErr()) return outcome; // the fold terminal lists what's left
const [user] = outcome.value;
```

One config, everywhere: builders re-execute on retry, `transaction` restarts
whole, raw `execute` re-invokes. The wrapper owns the re-invocation, so there
are no thunks at the call site. Two honest caveats: the wrapped chain types are
structural, not literal — Drizzle's builder generics can't survive the type
mapping, so rows degrade to `Record<string, any>`-shaped arrays while the union
narrowing stays exact (drop to `tryDb(builder)` where row literals matter), and
`query`/`$with` pass through raw. Tighten the union per protocol with the
explicit generic: `drizzleTryDb<typeof db, SqliteDbError>(db)`.

## Drivers

One package, subpath entry points per protocol: `db-result/pg`, `/sqlite`, `/d1`,
`/mysql2`, `/mssql`. Every driver Drizzle and Kysely support maps to one of them (the
classifier reads protocol signals: SQLSTATE, SQLite codes, mysql errno, mssql number,
Prisma P-codes). Your ORM name is not an entry point: Kysely-on-Postgres imports from
`db-result/pg`, Drizzle-on-SQLite from `db-result/sqlite`. Drizzle: classification is
wrapper-transparent (the cause chain reaches the driver error regardless of version);
the narrowing probes are verified against 1.0+ (currently `1.0.0-rc.4`); on ~0.9 use
the thunk form. Full map: [adoption](./skills/db-result/references/adoption.md).

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
