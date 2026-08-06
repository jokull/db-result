# Shapes — the thunk's parameter narrows the union

The type-level lattice is the "no lying types" contract: `tryDb` reads the
thunk's **parameter type** as structural evidence of what the query can and
cannot do, then narrows the error union to the tags that shape provably cannot
produce. Zero runtime cost — the probes compile away; classification stays
exact.

```ts
// zero-arg: no evidence — the full driver union
tryDb(() => db.selectFrom("users").selectAll().execute());

// param declared: the parameter's TYPE is the signal
tryDb((q: SelectQueryBuilder<DB, "users", {}>) => db.selectFrom("users").selectAll().execute()); // union: constraints + transaction-aborted gone
```

The parameter is a type-level declaration only — `tryDb` never passes an
argument (it is `undefined` at runtime). Close over the real client/builder in
the thunk body; the declared parameter is what the lattice reads.

## The rules

1. **A probe firing is evidence; a non-match falls through.** Each probe is a
   structural marker an ORM actually emits (verified against Kysely 0.29,
   Drizzle 1.0.0-rc.4, Prisma 6.19.3 in `test.types.ts` — the type tests are
   the contract).
2. **A tag stays unless a shape proves it impossible.** The union only shrinks.
   An unproven tag staying is safe (conservative); a wrongly-removed tag is a
   lie.
3. **Fail-loud, never silent.** A one-arg thunk whose parameter proves no
   shape is a compile error — the lattice never silently degrades to the full
   union. Use the zero-arg form instead.
4. **The ledger is per driver.** The default exclusions hold on every driver;
   a driver overrides where its protocol differs (`db-result/sqlite` keeps
   `connect-failure` inside transactions — `ATTACH DATABASE` can still fire
   CANTOPEN mid-query).

## The shape lattice

| shape         | what the parameter proves                                                | probes (structural markers)                                                                                                                                                                                                               | excluded tags (default ledger)                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transaction` | a transaction client — the callback ran after acquire + BEGIN            | `isTransaction: true` (Kysely), `rollback(): never` (Drizzle), `$queryRaw` ∧ ¬`$transaction` (Prisma `TransactionClient`)                                                                                                                 | `authentication-failed`, `connect-failure` — authn already succeeded, the channel is established. `transaction-aborted` stays (it can happen inside).             |
| `pool`        | a pool client, never in a transaction                                    | `isTransaction: boolean` (Kysely `Kysely<DB>`)                                                                                                                                                                                            | `transaction-aborted` only                                                                                                                                        |
| `read`        | a read-only builder / provably-read args                                 | `isSelectQueryBuilder: true` (Kysely select); `groupBy\|having\|offset\|union\|intersect\|except\|for` (Drizzle select); Prisma args with `take\|skip\|cursor\|distinct\|by\|_count\|_avg\|_sum\|_min\|_max` (findMany/groupBy/aggregate) | the four constraints + `transaction-aborted`. `deadlock`/`lock-timeout` stay (`SELECT … FOR UPDATE`), `data-error` stays (read conversions), connection tags stay |
| `write`       | an insert/update/upsert builder or write args                            | `values` / `onConflictDo*` (insert), `set` / `from` (update), Prisma `data` or `create`+`update` args                                                                                                                                     | `transaction-aborted` only — writes can raise every constraint                                                                                                    |
| `delete`      | a delete builder, or Prisma where-only args                              | `where` — after the write/read probes ruled everything else out                                                                                                                                                                           | `unique`, `not-null`, `check`, `transaction-aborted` — a DELETE can only FK-fail                                                                                  |
| `opaque`      | no evidence (`any`, `unknown`, unannotated, RawBuilder, Kysely Merge, …) | —                                                                                                                                                                                                                                         | nothing — the full driver union, and one-arg opaque thunks fail loudly                                                                                            |

### Why `where`-only Prisma args narrow to `delete`

`{ where }` args are shared by `findUnique`/`findFirst` (reads) and
`delete`/`deleteMany` (deletes). The intersection is honest: constraints are
write-only, so reads can't raise them; deletes can only FK-fail. `unique`,
`not-null`, `check`, `transaction-aborted` are impossible for the whole family;
`foreign-key-violation` stays (delete/deleteMany CAN FK-fail). Reads and
deletes genuinely share that error surface, so one narrowed union serves both.

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
reads-with-writes use the zero-arg form (`tryDb(() => …)`) and keep the full
union.

## Retry, per shape

Declaring any parameter disables statement auto-retry at runtime (arity is the
only runtime signal; a transaction context MUST not re-run one statement on a
dead transaction). An explicit `retry` config still wins. Want auto-retry on a
read shape? Pass `retry`, or drop the parameter (full union, retry on).

## Per-driver ledgers

| subpath            | ledger override                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `db-result/pg`     | default — the full lattice applies                                                                                                 |
| `db-result/sqlite` | `transaction` keeps `connect-failure` (ATTACH); the union already lacks `authentication-failed`, `deadlock`, `transaction-aborted` |
| `db-result/mysql2` | default; the union already lacks `transaction-aborted`                                                                             |
| `db-result/mssql`  | default; the union already lacks `transaction-aborted`                                                                             |

## Honest ceilings (verified, not laziness)

- **Kysely `MergeQueryBuilder`** — the root has no marker separating it from a
  delete, and it can raise constraints via `thenInsert` → opaque (full union).
- **Kysely `RawBuilder` / `db.executeQuery(Compilable)`** — the SQL is
  arbitrary → opaque.
- **Prisma `$queryRaw`** — P2010 absorbs every driver code into
  `db/query-failure`; the narrowest Prisma union is real but unreachable from
  a param (raw and delegate methods share one client object) → opaque.
- **Drizzle relational `findMany` args** — carry `limit` but none of the select
  probes (`limit` is shared with deletes) → the delete shape (conservative).
- **Prisma pool clients** — `PrismaClient` is always pool-backed and
  reconnects; `P1000` (authn) can resurface on any operation → no connection
  narrowing on the client itself, only on `TransactionClient`.
