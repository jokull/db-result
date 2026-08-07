# Adversarial ledger — "make the shape lattice tell type lies"

Target: `tryDb` builder-value shape narrowing in db-result (repo /Users/jokull/Code/db-result).
Contract under attack: **a tag excluded from a shape's narrowed union must be genuinely
impossible for that shape on that driver** ("no lying types").

Method: three independent adversarial agents (Kysely, Drizzle, Prisma), each attacking one ORM.
Every attack was compile-verified (`bunx tsc -p tsconfig.scratch-<orm>.json`, Assert-based
`Absent<...>` checks) and reachability was proven from the ORM source forks (~/Forks/kysely
0.29.4, ~/Forks/drizzle-orm) + the classifier mapping in `src/db-result.ts`.

## Verdicts

| ORM     | lies | verdict  | root cause                                                                                     |
| ------- | ---- | -------- | ---------------------------------------------------------------------------------------------- |
| Kysely  | 2    | **LIES** | tx-bound builders exclude `transaction-aborted` (25P02 reachable); DDL misclassified as delete |
| Drizzle | 3    | **LIES** | same tx-bound root cause (three shapes)                                                        |
| Prisma  | 0    | HONEST   | no narrowing path exists — every call is full-union                                            |

**Both real lies were fixed** (see [Fix log](#fix-log)): `transaction-aborted` is no longer
excluded from any shape, and the delete probe now requires `where` AND `returning` (DDL has
`where` but no `returning`).

---

# Kysely (24 attacks — 2 LIES)

Fork: ~/Forks/kysely (0.29.4). Compile ground truth: node_modules/kysely (0.29).

| #     | attack                                                                  | probed shape               | union excludes                                 | tag reachable? (mechanism)                                                                                                             | verdict             |
| ----- | ----------------------------------------------------------------------- | -------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 1     | `tx.insertInto(...).values(...)` (tx-bound)                             | write                      | `transaction-aborted`                          | YES — 25P02: (a) the library's own deadlock-retry re-executes the builder into an aborted tx; (b) any prior failed statement in the tx | **LIE**             |
| 2     | `tx.selectFrom(...).selectAll()` (tx-bound)                             | read                       | 4 constraints + `transaction-aborted`          | YES — 25P02 same mechanism                                                                                                             | **LIE**             |
| 3     | `tx.deleteFrom(...).where(...)` (tx-bound)                              | delete                     | unique\|not-null\|check\|`transaction-aborted` | YES — 25P02                                                                                                                            | **LIE**             |
| 4     | `db.insertInto(...)` standalone                                         | write                      | `transaction-aborted`                          | NO — standalone                                                                                                                        | HONEST              |
| 5     | `db.selectFrom(...)` standalone                                         | read                       | 4 constraints + tx-aborted                     | NO (reads-that-write footgun excepted)                                                                                                 | HONEST              |
| 6     | `db.deleteFrom(...)` standalone                                         | delete                     | unique\|not-null\|check\|tx-aborted; FK stays  | NO — bare DELETE can only FK-fail                                                                                                      | HONEST              |
| 7     | `db.with("x", eb => eb.insertInto(...).returningAll()).selectFrom("x")` | read                       | 4 constraints                                  | YES but DOCUMENTED — reads-that-write footgun                                                                                          | DOCUMENTED-CEILING  |
| 8     | `deleteFrom("a").using("b")`                                            | delete                     | same as 6                                      | NO                                                                                                                                     | HONEST              |
| 9     | `updateTable(...).set(...).from(...)`                                   | write                      | tx-aborted                                     | NO                                                                                                                                     | HONEST              |
| 10    | `insertInto(...).onConflict(oc => ...)`                                 | write                      | tx-aborted                                     | NO (note: `onConflictDo*` keys are Drizzle-only)                                                                                       | HONEST              |
| 11    | `selectFrom(...).forUpdate()`                                           | read                       | constraints; deadlock STAYS                    | NO                                                                                                                                     | HONEST              |
| 12    | `mergeInto(...)`                                                        | opaque (fail-loud)         | —                                              | documented ceiling (thenInsert)                                                                                                        | DOCUMENTED-CEILING  |
| 13    | `RawBuilder`                                                            | opaque (fail-loud)         | —                                              | documented ceiling                                                                                                                     | DOCUMENTED-CEILING  |
| 14    | `withRecursive(...).selectFrom(...)`                                    | read                       | constraints                                    | NO — brand survives                                                                                                                    | HONEST              |
| 15    | `selectNoFrom(...)`                                                     | read                       | constraints                                    | NO                                                                                                                                     | HONEST              |
| 16-18 | `JoinBuilder` / `ExpressionBuilder` / `OnConflictBuilder`               | opaque; no `execute`       | —                                              | unreachable (BuilderQuery gate)                                                                                                        | NOT-A-LIE           |
| 19    | `with(...).deleteFrom(...)` DML CTE                                     | delete                     | unique\|not-null\|check\|tx-aborted            | YES but DOCUMENTED — same footgun family                                                                                               | DOCUMENTED-CEILING  |
| 20    | `db.schema.createIndex(...).unique().where(...)` (DDL)                  | **delete (misclassified)** | unique\|not-null\|check\|tx-aborted            | YES — `CREATE UNIQUE INDEX` raises 23505; 25P02 in an aborted tx                                                                       | **LIE**             |
| 21    | other DDL (`createTable`, `alterTable`, `dropIndex`, `createView`)      | opaque (fail-loud)         | —                                              | no probe keys                                                                                                                          | NOT-A-LIE           |
| 22-23 | aggregate / `WithBuilder` intermediates                                 | opaque                     | —                                              | not executable                                                                                                                         | NOT-A-LIE           |
| 24    | `db.startTransaction().execute()` → `ControlledTransaction` builders    | same as 1-3                | tx-aborted                                     | YES — `ControlledTransaction extends Transaction`                                                                                      | **LIE** (same root) |

### Lie repros (before the fix)

```ts
declare const tx: Transaction<DB>; // extends Kysely<DB> — same builder types
const q = tx.insertInto("users").values({ id: 1, email: "a", name: "n", tenant_id: 1 });
const r = tryDb(q);
type _excl_txaborted = Assert<Absent<TxAborted, ErrOf<typeof r>>>; // compiled: the lie

const ddl = db.schema.createIndex("users_email_uniq").on("users").column("email").unique();
const d = tryDb(ddl); // probed "delete" — CREATE UNIQUE INDEX raises 23505, excluded
```

Reachability citations: `~/Forks/kysely/src/kysely.ts:645` (`Transaction extends Kysely`, no
builder overrides), `create-index-builder.ts:289` (`where` partial-index predicate), `:343`
(`execute`); `src/db-result.ts:315` (25P02 → TransactionAborted), `:316-317` (40P01
retry-safe), `:286` (23505 → UniqueViolation).

---

# Drizzle (18 attacks — 3 LIES, same root cause)

Compile ground truth: node_modules/drizzle-orm 1.0.0-rc.4 — the real `drizzle()` factory
(drizzle-orm/node-postgres) returns ASYNC builders. Fork: ~/Forks/drizzle-orm.

| #   | vector                                                                                        | probed                      | excluded                                | verdict                                      |
| --- | --------------------------------------------------------------------------------------------- | --------------------------- | --------------------------------------- | -------------------------------------------- |
| V1  | `db.transaction(async tx => tryDb(tx.insert(users).values(...)))`                             | write                       | `transaction-aborted`                   | **LIE**                                      |
| V2  | `tryDb(tx.select().from(users))` (tx-bound)                                                   | read                        | constraints + tx-aborted                | **LIE**                                      |
| V3  | `tryDb(tx.delete(users))` (tx-bound)                                                          | delete                      | unique\|not-null\|check + tx-aborted    | **LIE**                                      |
| V4  | `$with().as()` DML CTE select                                                                 | read                        | constraints                             | DOCUMENTED-CEILING                           |
| V5  | volatile function in SELECT list                                                              | read                        | constraints                             | DOCUMENTED-CEILING                           |
| V5b | volatile fn in DELETE WHERE                                                                   | opaque (where strips probe) | nothing                                 | NOT-A-LIE                                    |
| V6  | relational `db.query.users.findMany`                                                          | opaque (thenable)           | nothing                                 | NOT-A-LIE                                    |
| V7  | `.for("update")`                                                                              | read                        | constraints; deadlock/lock-timeout stay | HONEST                                       |
| V8  | `update().set().returning()`                                                                  | write                       | tx-aborted only                         | HONEST                                       |
| V9  | `delete().where().returning()`                                                                | opaque (where strips probe) | nothing                                 | NOT-A-LIE                                    |
| V10 | `db.execute(sql\`...\`)` / PgRaw                                                              | opaque (thenable)           | nothing                                 | NOT-A-LIE                                    |
| V11 | `.prepare("p")`                                                                               | opaque (fail-loud)          | —                                       | HONEST                                       |
| V12 | `db.$count(users)`                                                                            | opaque (thenable)           | nothing                                 | NOT-A-LIE                                    |
| V13 | probe-key collisions (db, tx, subquery, sql, insert-no-values, update-no-set, select-no-from) | opaque — all fail-loud      | —                                       | HONEST                                       |
| V14 | `insert().values().onConflictDoUpdate()`                                                      | opaque (both keys stripped) | nothing                                 | NOT-A-LIE                                    |
| V15 | `refreshMaterializedView(mv)`                                                                 | opaque (thenable)           | nothing                                 | NOT-A-LIE                                    |
| V16 | select chains (`.where`/`.limit`/`.groupBy`/`.union`)                                         | read (probes survive)       | constraints                             | HONEST                                       |
| V17 | non-returning write `_`-slot result types                                                     | write                       | tx-aborted                              | HONEST — `QueryResult<never>`, never `never` |
| V18 | INSERT…SELECT                                                                                 | write                       | tx-aborted                              | HONEST                                       |

### Lie repro (before the fix)

```ts
db.transaction(async (tx) => {
  await tx.insert(users).values({ id: 1, email: "a" }); // ok
  await tx.insert(users).values({ id: 1, email: "b" }); // 23505 → tx aborted
  const r = await tryDb(tx.insert(users).values({ id: 2, email: "c" })); // 25P02 → excluded
});
```

Reachability: PostgreSQL 25P02 — after ANY prior statement error inside a transaction,
every subsequent command fails "current transaction is aborted". `PgAsyncTransaction extends
PgAsyncDatabase` (pg-core/async/session.d.ts:42) — tx builders are type-identical, so no
probe can detect binding.

### Systematic observations

- **OBS-1 — the delete probe self-cancels.** `where` is both the delete evidence and a
  method that removes itself (`PgDeleteWithout<…,'where'>`): the common `db.delete(t).where(...)`
  never probes delete — only the bare `db.delete(t)` does.
- **OBS-2 — thenables defeat the fail-loud gate.** rc.4 async builders are all
  `QueryPromise` thenables; opaque thenables (PgRaw, `$count`, relational, onConflict,
  matview refresh) match the PromiseLike overload → full union, promise semantics, silently.
  Conservative, never a lie — but "fail-loud, never silent" applies only to non-thenable
  opaques (prepared statements, db/tx roots, subqueries, sql fragments).
- **OBS-3 — the tx-bound lie is structural** (same root as Kysely).

---

# Prisma (18 attacks — 0 LIES)

Ground truth: @prisma/client 6.19.3 (generated node_modules/.prisma) + runtime TS source in
client.js.map. No narrowing path exists: every delegate method returns a `PrismaPromise`
(`Promise<T> & { [Symbol.toStringTag]: 'PrismaPromise' }`, library.d.ts:2720 — no `execute`,
no probe keys) → promise overload → FULL `DbError` union everywhere. `tryDb(prisma.user.findMany(args))`,
all writes, `$transaction` (batch + interactive), `$queryRaw`, groupBy/aggregate/count,
`$extends` clients, fluent API: all `Same<ErrOf, DbError>` asserted. Fail-loud verified for
`prisma.user`/`tx`/`Prisma.sql` values (probe keys present but no `execute` → overload 1
param `never`). Two near-misses: the delegate probes `read` via `groupBy`, `Prisma.Sql`
probes `write` via `values` — both neutralized by the missing `execute`. One expectation
disproven: `tryDb(prisma.user.findMany)` (bare method, optional args) compiles as a THUNK —
full union, runtime-safe, retry-safe.

Verdict: **HONEST** — Prisma cannot lie because it never narrows.

---

# Fix log

Commit: (this round). Two fixes, both driven by the ledger:

1. **`transaction-aborted` is no longer excluded from ANY shape** (read/write/delete
   ledgers). Root cause (OBS-3): tx clients return type-identical builders, so no probe can
   detect transaction binding; a tx-bound statement of any shape raises 25P02 after any
   prior failed statement — including through the library's own deadlock-retry loop, which
   re-executes the builder into the aborted transaction. The `write` shape now excludes
   nothing (writes can raise every tag); `read` excludes the four constraints; `delete`
   excludes unique/not-null/check (FK stays). The exclusion's premise ("transaction-aborted
   is impossible without a transaction") was false for tx-bound builders.
2. **The delete probe now requires `where` AND `returning`** (Kysely row 20). DDL
   (`CreateIndexBuilder`) has a `where` partial-index predicate and `execute` but no
   `returning`, and `CREATE UNIQUE INDEX` raises 23505 — the delete claim excluded it. DDL
   now probes opaque → fail-loud → thunk form.

Docs updated: `src/db-result.ts` ledger/probe comments, `test.types.ts` (tx-aborted flips
to Member + DDL fail-loud row + where'd-delete opaque row), README, shapes.md,
transactions.md, SKILL.md.

Post-fix re-verification: full suite green (111 unit + 6 integration, tsc, lint, fmt,
build, publint+attw, TS 5.4.5 consumer). The exact repros above now fail to compile
(`Absent<TxAborted, …>` no longer holds) or probe opaque — the lies are closed.
