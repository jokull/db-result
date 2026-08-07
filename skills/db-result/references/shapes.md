# Shapes — the query's own type narrows the union

The type-level lattice is the "no lying types" contract: `tryDb` reads the
**query builder's own type** as structural evidence of what the query can and
cannot do, then narrows the error union to the tags that shape provably cannot
produce. Zero runtime cost — the probes compile away; classification stays
exact. Nothing to declare, nothing to sync: the ORM emitted the builder type,
so the evidence is verified by construction.

```ts
// builder value: the shape IS the type — constraints are write-only
tryDb(db.selectFrom("users").selectAll()); // union: constraints + transaction-aborted gone

// thunk: no shape evidence (Prisma, raw SQL, custom executors) — full union
tryDb(() => prisma.user.findMany({ where: { id } }));
```

## The rules

1. **A probe firing is evidence; a non-match falls through.** Each probe is a
   structural marker an ORM actually emits (verified against Kysely 0.29 and
   Drizzle 1.0.0-rc.4 as produced by the real `drizzle()` factory in
   `src/types.test-d.ts` — the type tests are the contract).
2. **A tag stays unless a shape proves it impossible.** The union only shrinks.
   An unproven tag staying is safe (conservative); a wrongly-removed tag is a
   lie.
3. **Fail-loud for builder values, never silent.** A builder value that
   proves no shape (raw SQL, Kysely `mergeInto`, DDL) is a compile error —
   the lattice never silently degrades to the full union. A builder wrapped
   in a thunk is also a compile error: pass it directly. Thenables without
   `execute` (Drizzle `$count`, relational queries, `db.execute` raw) match
   the promise overload instead — full union, no narrowing, never a lie.
4. **The ledger is per driver.** The default exclusions hold on every driver;
   a driver's union is narrower where its protocol differs (`db-result/sqlite`
   drops `authentication-failed`, `deadlock`, `transaction-aborted` outright).

## The shape lattice

| shape    | what the builder proves                         | probes (structural markers)                                                                               | excluded tags (default ledger)                                                                                                                                      |
| -------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`   | a select builder                                | `isSelectQueryBuilder: true` (Kysely); `groupBy\|having\|offset\|union\|intersect\|except\|for` (Drizzle) | the four constraints. `deadlock`/`lock-timeout` stay (`SELECT … FOR UPDATE`), `data-error` stays (read conversions), connection tags and `transaction-aborted` stay |
| `write`  | an insert/update builder                        | `values` / `onConflictDo*` (insert), `set` / `from` (update)                                              | nothing — writes can raise every tag, including `transaction-aborted` when the builder is bound to a transaction                                                    |
| `delete` | a delete builder                                | `where` AND `returning` — after the insert/update probes ruled `values`/`set`/`from` out                  | `unique`, `not-null`, `check` — a DELETE can only FK-fail; `transaction-aborted` stays                                                                              |
| `opaque` | no evidence (`any`, `unknown`, raw, DDL, merge) | —                                                                                                         | nothing — the full driver union; opaque builder values fail loudly                                                                                                  |

## Why `transaction-aborted` is never excluded

A tx-bound builder — `tx.insertInto(...)` inside `db.transaction(tx => …)`,
Kysely or Drizzle — can raise `25P02` after **any** prior failed statement in
the transaction, or after an in-transaction deadlock (and the library's own
retry re-executes the builder, so a retried deadlock lands on `25P02`). The
tx client returns the _same builder types_ as the root client — verified
against the ORM sources (Kysely `Transaction<DB> extends Kysely<DB>`, Drizzle
`PgAsyncTransaction extends PgAsyncDatabase`) — so no probe can detect
transaction binding. Excluding `transaction-aborted` from any shape would be
a compile-time lie in every transaction; the tag stays in every union
(conservative for standalone statements, honest for tx-bound ones). This was
found adversarially — see `adversarial-ledger.md` (Kysely rows 1-3/24,
Drizzle rows V1-V3).

## The footgun: "reads that write"

A read-shaped query can still raise a constraint when it carries write side
effects:

- data-modifying CTEs — Kysely `with(…).insertInto(…)`, Drizzle `db.$with(x).as(db.insert(…).returning())`
- volatile functions in a `SELECT` (e.g. a user-defined function that writes)
- `INSTEAD OF` triggers on views

**The runtime never lies**: such a failure still classifies exactly
(`db/unique-violation`, …) and lands in the fold terminal — the narrowed union
just doesn't list it, so `matchErrorPartial`'s `(unhandled)` branch reports it
as unexpected. That is the honest cost of the narrowing. Codebases that run
reads-with-writes use the thunk form (`tryDb(() => …)`) and keep the full
union.

## Retry, per form

- **Builder values** retry by re-executing the builder (re-invoking
  `execute()`). A transient failure on a select re-runs the select.
- **Thunks** retry by re-invoking the thunk. This is the only form that can
  retry a one-shot call (Prisma, raw SQL).
- **Settled promises** never auto-retry — they can't be re-run (a dev warning
  fires once). Wrap in a thunk to get retry.
- An explicit `retry` config always wins; `retryTransient: false` disables
  auto-retry.

## Per-driver ledgers

| subpath            | union/ledger                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| `db-result/pg`     | full `DbError`, default ledger — the full lattice applies                                                    |
| `db-result/sqlite` | union drops `authentication-failed`, `deadlock`, `transaction-aborted`; the ledger is default for the shapes |
| `db-result/d1`     | same as sqlite (D1 is SQLite at the edge)                                                                    |
| `db-result/mysql2` | union drops `transaction-aborted`; default ledger                                                            |
| `db-result/mssql`  | union drops `transaction-aborted`; default ledger                                                            |

## Honest ceilings (verified, not laziness)

- **Kysely `MergeQueryBuilder`** — the root has no marker separating it from a
  delete, and it can raise constraints via `thenInsert` → opaque (compile
  error; use the thunk form).
- **Kysely `RawBuilder` / `db.executeQuery(Compilable)`** — the SQL is
  arbitrary → opaque.
- **Kysely DDL builders (`CreateIndexBuilder`, …)** — `CreateIndexBuilder` has
  a `where` (partial-index predicate) and `execute`, so it would probe as a
  delete — but `CREATE UNIQUE INDEX` raises 23505. The delete probe requires
  `where` AND `returning`; DDL has no `returning` → opaque (compile error; use
  the thunk form). Found adversarially (Kysely ledger row 20).
- **Drizzle rc.4 `.where()` strips the delete probe** — Drizzle's
  method-exclusion typing removes `where` from the builder after it is called,
  so a where'd delete probes opaque (full union). The delete shape only fires
  on the bare `db.delete(t)`. Conservative, never a lie.
- **Drizzle rc.4 write builders** declare `execute` as a `this`-derived
  property; the result type is read from the builder's own `_` slot
  (`QueryResultOf`). The probes still fire — writes narrow to the (now empty)
  write exclusion = full union, with the correct result type.
- **Prisma** — every delegate method is one-shot (its `PrismaPromise`
  memoizes the executed query; re-awaiting never re-executes), so there is no
  builder value to pass and nothing to probe. All Prisma calls use the thunk
  form: full union, retry via re-invocation.
- **Drizzle 0.9 builders** — the probes are verified against 1.0+; on ~0.9
  use the thunk form (`tryDb(() => db.select().from(users).execute())`).
