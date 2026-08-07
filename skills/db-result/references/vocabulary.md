# Vocabulary — the 14 tags

`DbError` is the union of fourteen tagged errors. Protocol-agnostic: the tag
means the same thing on any database; the driver identity stays in `cause`,
never in the tag.

| tag                        | carries      | meaning                                                                   | auto-retry?             |
| -------------------------- | ------------ | ------------------------------------------------------------------------- | ----------------------- |
| `db/unique-violation`      | `constraint` | unique or primary-key conflict                                            | never                   |
| `db/foreign-key-violation` | `constraint` | referenced row doesn't exist                                              | never                   |
| `db/not-null-violation`    | `constraint` | required value absent                                                     | never                   |
| `db/check-violation`       | `constraint` | a check rejected the value                                                | never                   |
| `db/data-error`            | —            | value too long, numeric overflow, invalid text input                      | never                   |
| `db/deadlock`              | —            | deadlock or serialization failure                                         | ✅ whole-tx / statement |
| `db/lock-timeout`          | —            | waited too long for a lock (incl. `SQLITE_BUSY`)                          | ✅ whole-tx / statement |
| `db/transaction-aborted`   | —            | the transaction is dead (`25P02`, `P2028`) — roll back                    | never                   |
| `db/connect-failure`       | —            | the channel never established (refused, DNS, pool timeout, TLS)           | ✅ auto-retried         |
| `db/connection-lost`       | —            | channel died mid-query (`08006`, `ECONNRESET`, `P1017`) — outcome unknown | never (ambiguous)       |
| `db/authentication-failed` | —            | credentials rejected                                                      | never                   |
| `db/authorization-failed`  | —            | insufficient permission                                                   | never                   |
| `db/sql-syntax-error`      | —            | the SQL (or schema reference) is wrong                                    | never                   |
| `db/query-failure`         | —            | everything else that is a database failure                                | transient subset only   |

Guards for every tag (`isUniqueViolation(e)`, `isDeadlock(e)`, …), plus the
boundary check `isDbError(e)` (the whole union) and `isRetriedError(e)` (the
failure survived retries — carries `e.retries`). `isConnectionFailure(e)` is
the family guard for either connection tag (`isConnectFailure` /
`isConnectionLost` narrow individually). Every error carries
`potentiallyTransient?: boolean` — a hint, never a policy; the retry policy
owns what actually retries (see [retry.md](./retry.md)).

## Per-driver union matrix

The subpath entry points narrow the union by protocol. `db-result` (bare)
carries all 14; the per-driver subpaths exclude what that protocol can't
produce. On top of the driver union, the thunk's parameter shape narrows
further — see [shapes.md](./shapes.md).

| subpath            | excluded tags                                                                                                                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db-result/pg`     | — (every tag is reachable)                                                                                                                               |
| `db-result/sqlite` | `authentication-failed` (no server auth), `deadlock` (BUSY is contention, not deadlock), `transaction-aborted` (SQLite keeps the tx open after an error) |
| `db-result/mysql2` | `transaction-aborted` (InnoDB rolls back the statement, not the tx)                                                                                      |
| `db-result/mssql`  | `transaction-aborted` (no verified abort signal yet)                                                                                                     |

## Protocol signals

| Protocol                | Signal                                                                                | Examples                                                                                            |
| ----------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| PostgreSQL SQLSTATE     | `code: "23505"` + `constraint`                                                        | pg, postgres.js, Drizzle over pg                                                                    |
| SQLite extended codes   | `code: "SQLITE_CONSTRAINT_UNIQUE"`, `errcode: 2067`                                   | better-sqlite3, node:sqlite, libsql, bun:sqlite                                                     |
| SQLite message shapes   | `"UNIQUE constraint failed: t.c"`                                                     | D1, wa-sqlite, Turso Database (JS binding), anything code-less                                      |
| MySQL                   | `code: "ER_DUP_ENTRY"` / `errno: 1062` + `sqlState`                                   | mysql2                                                                                              |
| SQL Server              | `number: 2627`; login failures carry `code: "ELOGIN"` instead                         | mssql / tedious                                                                                     |
| Prisma P-codes          | `code: "P2002"` + `clientVersion`                                                     | any Prisma engine (ORM-level, works over any driver)                                                |
| Connection layer        | `code: "ECONNREFUSED"`, pool messages                                                 | every driver — Node system errors                                                                   |
| PG/MySQL message shapes | `"duplicate key value violates unique constraint …"`, `"Duplicate entry … for key …"` | code-stripping paths: aws-data-api, xata-http, netlify-db, planetscale, tidb, the `*-proxy` drivers |

mssql notes (verified against a real SQL Server 2022): error `547` is shared by
FK _and_ CHECK conflicts — the message ("FOREIGN KEY constraint" vs "CHECK
constraint") picks the tag; login failures carry no `number` at all, only
`code: "ELOGIN"` → `db/authentication-failed`.

The classifier walks `Error.cause` chains (plus Effect's payload slots
`cause`/`failure`/`error`/`defect`, max 16 hops, cycle-safe), so Drizzle's
`DrizzleQueryError` wrapper and Effect-shaped nesting are transparent.

Classification is duck-typed but strictly guarded: only `^[0-9A-Z]{5}$` codes
count as SQLSTATE; only enumerated prefixes (`SQLITE_*`, `ER_*`, `CLIENT_*`)
and exact errno/number tables count as driver codes; `meta.target`/`field_name`
and message text feed `constraint` only as dotted identifiers — query text and
parameters can never leak into the error data.

## Not-found is data, not a failure

A missing row is a legitimate outcome — represent it with your own domain
error (or a `null`/`undefined` result), never a `db/*` tag:

```ts
const row = await tryDb(() => sql`SELECT * FROM users WHERE id = ${id}`);
if (row.isErr()) return row; // real failure — propagate
const user = row.value[0];
if (!user) return Result.err(new NotFound({ id })); // your domain error
```

Prisma's `P2025` ("record required but not found") is the same call: it folds
to `db/query-failure`, not a tag — the caller owns the not-found decision.

## Adding a driver or protocol shape

A tag earns its place when it changes a caller decision real apps make **and**
≥2 drivers give it a stable signal. Parked candidates: `db/serialization-failure`
(`40001` currently folds into `db/deadlock` — same decision: retry the whole
transaction), `db/statement-timeout` (`57014` currently folds into transient
`db/query-failure`).

To add a signal, extend `classifyNode` in `src/classify/index.ts` (the protocol
tables are structural — no registration, no imports), then prove it with a
fixture in the per-protocol test file next to it (`src/classify/*.test.ts` —
the fixtures are the contract) and a real-driver test in
`src/integration.test.ts`.
