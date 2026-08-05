# better-result db errors — classify database failures into tagged Results

A driver-agnostic `tryDb` for [better-result](https://github.com/dmmulroy/better-result) 3.0.
Stop hand-writing `instanceof`/`error.code` checks — attempt the insert, get a
`Result<T, DbError>` back, and fold the failure into your domain vocabulary at
the handler boundary.

```ts
import { tryDb } from "./db-result.ts";

const created = await tryDb(
  () => db.insert(users).values({ email }),
);
if (created.isErr() && created.error._tag === "db/unique-violation") {
  return errors.EmailTaken({ email, constraint: created.error.constraint });
}
```

## Why driver-agnostic?

`tryDb` reads the **protocol** error shape, not any ORM's. It walks `Error.cause`
chains (plus the payload slots Effect wrappers use) to reach the driver's error,
then recognizes three independent protocols:

| Protocol | Signal | Drivers |
|---|---|---|
| PostgreSQL SQLSTATE | `code: "23505"` + `constraint` field | `pg`, `postgres.js`, Drizzle over pg |
| SQLite extended result codes | `code: "SQLITE_CONSTRAINT_UNIQUE"`, `errcode: 2067` | better-sqlite3, node:sqlite, libsql, **D1** |
| SQLite native messages | `"UNIQUE constraint failed: t.c"` | D1, wa-sqlite, anything that sets no code |

So the same classifier works at the driver-call level — `client.query(...)`,
`db.prepare(...).run()`, or `db.insert(...)` are all just thenables — and it
sees through wrappers (DrizzleQueryError, Effect-shaped nesting) to the error
that carries the protocol fields.

## The vocabulary

Five tags, all carrying only the constraint name:

- `db/unique-violation` — unique or primary-key constraint hit
- `db/foreign-key-violation` — referenced row does not exist
- `db/not-null-violation` — required value absent
- `db/check-violation` — database check rejected the value
- `db/query-failure` — no more specific classification

The original failure stays reachable as a non-enumerable `Error.cause` for
observability; only `{ constraint }` ever reaches the tagged error's data.
Query text, parameters, and driver internals never do — the constraint-name
regex accepts dotted identifiers only, so ORM-appended text can't be captured.

## The pattern

1. **Compose private failures.** DB errors are composition currency, not wire
   errors — keep them out of your API contract.
2. **Fold at the boundary.** In a handler, `mapError` the `db/*` tag into the
   declared domain error the caller can act on (`EmailTaken`, `OrderInvalid`…).
3. **Attempt the insert is the uniqueness check** — including under races.

## Run

```sh
bun install
bun test                 # fixtures + real bun:sqlite (zero setup)
PGTEST_DSN="postgres://postgres@127.0.0.1:5433/postgres" \
  bun test ./test.integration.ts   # real node-postgres proof
```

## Sharp edge

better-result's upstream `TaggedError.toJSON()` spreads `cause` (with stack) by
design — fine for logs, but strip `cause` before any wire boundary or error
reporting service that serializes the instance.

## Provenance

Classification technique modeled on [Effect SQL's `SqlError` classifier](https://github.com/Effect-TS/effect/blob/main/packages/effect/src/unstable/sql/SqlError.ts)
and the SQLite/Postgres protocol contracts; extracted from result-rpc's `tryDb`
([`result-rpc/db`](https://github.com/jokull/result-rpc/blob/main/src/db.ts)),
which ships the same classifier inside the RPC library. Shared here to answer
"how do community helpers for better-result get shared?" — see the discussion.
