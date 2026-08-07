# Adoption — the case, install, and migration

## The case (rung 0)

You don't need db-result if your database layer is happy today. You do need it
when any of these are true:

- you hand-write `error.code === "23505"` / `errno === 1062` / message-regex
  checks, and they drift per driver;
- you've retried a failed write and accidentally double-committed (or avoided
  retrying entirely and let deadlocks crash requests);
- handlers swallow connection/auth/constraint failures into a generic 500 and
  the logs can't tell them apart;
- you want the error _union_ (not the catch block) to be the contract.

The cost: one dependency (`better-result` is the peer), and DB errors become
`Result` values you fold at boundaries instead of exceptions you catch.

## Install (rung 1)

```sh
bun add better-result db-result
```

Import from the generic entry point or a per-driver subpath. The subpaths only
narrow the _error union_ by protocol — same classifier, same retry engine:

| Import             | Union excludes                                             | Use when                                            |
| ------------------ | ---------------------------------------------------------- | --------------------------------------------------- |
| `db-result`        | — (all 14 tags)                                            | driver-agnostic / generic code                      |
| `db-result/pg`     | — (Postgres produces every tag)                            | node-postgres, postgres.js, Drizzle over pg         |
| `db-result/sqlite` | `authentication-failed`, `deadlock`, `transaction-aborted` | better-sqlite3, node:sqlite, bun:sqlite, libsql, D1 |
| `db-result/d1`     | same as `sqlite` (D1 is SQLite at the edge)                | Cloudflare D1                                       |
| `db-result/mysql2` | `transaction-aborted`                                      | mysql2                                              |
| `db-result/mssql`  | `transaction-aborted`                                      | mssql / tedious                                     |

ORMs (Drizzle, Kysely, Prisma) have **no entry point of their own** for the
classifier — import the driver subpath and wrap their queries; the classifier
sees through their wrappers and P-codes structurally. One exception: the
**`{orm}TryDb` factories** (`db-result/drizzle`, `db-result/kysely`,
`db-result/prisma`) are per-ORM DX layers that wrap an ORM client so every
return shape carries the E-track — they are not union entry points (the
protocol still comes from your driver import). A query builder passed as a
value narrows the union further per ORM (Kysely, Drizzle) — see
[shapes](./shapes.md). Prisma delegate methods are one-shot (its
`PrismaPromise` memoizes the executed query), so Prisma calls use the thunk
form — see [transactions](./transactions.md).

**Drizzle driver → import** — the classifier speaks _protocols_, so every
driver Drizzle supports maps to one of the five subpaths:

| Drizzle driver package                                                        | Protocol                             | Import from        |
| ----------------------------------------------------------------------------- | ------------------------------------ | ------------------ |
| `drizzle-orm/node-postgres`                                                   | postgres                             | `db-result/pg`     |
| `drizzle-orm/postgres-js`                                                     | postgres                             | `db-result/pg`     |
| `drizzle-orm/neon-http`, `neon-serverless`, `neon`                            | postgres                             | `db-result/pg`     |
| `drizzle-orm/vercel-postgres`                                                 | postgres                             | `db-result/pg`     |
| `drizzle-orm/supabase`                                                        | postgres                             | `db-result/pg`     |
| `drizzle-orm/pglite`                                                          | postgres                             | `db-result/pg`     |
| `drizzle-orm/cockroach`                                                       | postgres                             | `db-result/pg`     |
| `drizzle-orm/bun-postgres`                                                    | postgres                             | `db-result/pg`     |
| `drizzle-orm/aws-data-api`                                                    | postgres                             | `db-result/pg`     |
| `drizzle-orm/xata-http`                                                       | postgres                             | `db-result/pg`     |
| `drizzle-orm/netlify-db`                                                      | postgres                             | `db-result/pg`     |
| `drizzle-orm/pg-proxy`                                                        | postgres                             | `db-result/pg`     |
| `drizzle-orm/mysql2`                                                          | mysql                                | `db-result/mysql2` |
| `drizzle-orm/planetscale-serverless`                                          | mysql                                | `db-result/mysql2` |
| `drizzle-orm/tidb-serverless`                                                 | mysql                                | `db-result/mysql2` |
| `drizzle-orm/singlestore`                                                     | mysql                                | `db-result/mysql2` |
| `drizzle-orm/mysql-proxy`                                                     | mysql                                | `db-result/mysql2` |
| `drizzle-orm/better-sqlite3`                                                  | sqlite                               | `db-result/sqlite` |
| `drizzle-orm/libsql` (+ `tursodatabase*`)                                     | sqlite                               | `db-result/sqlite` |
| `drizzle-orm/bun-sqlite`                                                      | sqlite                               | `db-result/sqlite` |
| `drizzle-orm/node-sqlite`                                                     | sqlite                               | `db-result/sqlite` |
| `drizzle-orm/expo-sqlite`                                                     | sqlite                               | `db-result/sqlite` |
| `drizzle-orm/op-sqlite`                                                       | sqlite                               | `db-result/sqlite` |
| `drizzle-orm/sql-js`                                                          | sqlite                               | `db-result/sqlite` |
| `drizzle-orm/sqlite-proxy`, `sqlite-cloud`                                    | sqlite                               | `db-result/sqlite` |
| `drizzle-orm/d1`                                                              | sqlite                               | `db-result/d1`     |
| `drizzle-orm/durable-sqlite`                                                  | sqlite                               | `db-result/d1`     |
| `drizzle-orm/tursodatabase`, `tursodatabase-serverless`, `tursodatabase-sync` | sqlite (Turso Database, Rust engine) | `db-result/sqlite` |
| `drizzle-orm/mssql`                                                           | mssql                                | `db-result/mssql`  |

Code-stripping paths (aws-data-api, xata-http, netlify-db, planetscale,
tidb, the `*-proxy` drivers) classify from their message text — the
constraint/auth/syntax patterns in the classifier cover them (fixtures in
`src/classify/message.test.ts`).

**Turso Database vs libsql** — two different engines. `libsql` (what
`@libsql/client`, `drizzle-orm/libsql`, and the hosted Turso product use) is
Turso's genuine fork of SQLite C — same `SQLITE_*` error surface as vanilla
SQLite, plus libsql client network errors. `Turso Database` (the `tursodb`
binary / `drizzle-orm/tursodatabase*`) is a separate **Rust rewrite**
(compatible-with-SQLite, beta, no triggers/views/savepoints yet) whose MVCC
concurrent writes (`--experimental-mvcc`, `BEGIN CONCURRENT`) replace
`SQLITE_BUSY` contention with commit-time **write-write conflicts** — the JS
binding surfaces them as messages, which classify as `db/lock-timeout`
(transient): retry the whole transaction (`tryTx`); the conflict already
aborted it, so statement retry is futile.

## Migrate (rung 2)

Boundary-first, one module at a time — the same strategy as adopting
better-result itself:

1. **Start at I/O boundaries.** Database access, HTTP clients, file systems.
2. **Classify the failures you already handle:**

   | Today                                              | Becomes                                                 |
   | -------------------------------------------------- | ------------------------------------------------------- |
   | `err.code === "23505"` / `1062` / `2627` / `P2002` | `isUniqueViolation(e)` / `"db/unique-violation"`        |
   | `"deadlock detected"` / `1213` / `1205`            | `"db/deadlock"` (auto-retried)                          |
   | `ECONNREFUSED` / pool-timeout messages             | `"db/connect-failure"` (auto-retried)                   |
   | `SQLITE_BUSY` / `1205` / `55P03`                   | `"db/lock-timeout"` (auto-retried)                      |
   | everything else you catch                          | rethrown — a request for a new mapping, not a catch-all |

3. **Wrap the boundary:** `tryDb(() => db.insert(users).values({ email }).returning())`.
   Callers now receive `Result<T, DbError>`.
4. **Fold at the handler:** convert the `db/*` tags you care about into your
   domain errors (`EmailTaken`, `OrderInvalid`, …) with `matchErrorPartial`;
   let the terminal turn the rest into 500 + observability. Don't let `db/*`
   tags cross the wire.
5. **Keep `cause` for logs, strip it for wire boundaries** (better-result's
   `TaggedError.toJSON()` spreads `cause` with stack by design).

### What NOT to do

- Don't convert the whole codebase at once — boundaries only.
- Don't wrap `try/catch` around `Result.gen` to "catch" DB errors — `Result.gen`
  short-circuits on `Err`; the union accumulates across yields.
- Don't map a missing row to a `db/*` tag. Not-found is a domain outcome —
  return `Result.err(new NotFound({ id }))` yourself. See
  [vocabulary.md#not-found](./vocabulary.md#not-found).
