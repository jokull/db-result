# Changelog

All notable changes to db-result. This project adheres to [Semantic Versioning](https://semver.org).

## [0.3.0] — 2026-08-07

Breaking (0.x minor): `prismaTryDb` and the `db-result/prisma` entry point are
removed — no bandwidth to keep a live Prisma integration suite honest.

### Removed

- **`prismaTryDb` / `db-result/prisma`** — the wrapper, its export entry, the
  optional `@prisma/client` peer dependency, the `prisma` + `@prisma/client`
  dev dependencies, the `db:generate` script, and the schema fixture. Migrate:
  `prismaTryDb(client)` calls become thunks — `tryDb(() => prisma.user.findMany(args))`
  (full union, retry by re-invocation); interactive `$transaction` becomes
  `tryTx(() => prisma.$transaction(async (tx) => { … }))`.
- The `prisma` keyword from package metadata.

### Unchanged

- **Prisma P-code classification stays.** The classifier's P-code protocol
  branch (`P2002` → unique, `P2034` → deadlock, `P2028` → transaction-aborted,
  …) is pure string classification over fabricated fixtures — unit-tested, no
  live client required — and `tryDb`/`tryTx` still classify Prisma errors
  exactly. Prisma apps use the thunk form on the driver entry point.

## [0.2.0] — 2026-08-07

Breaking (0.x minor): the per-tag guard migration (below) removes the
`isXxx` predicate functions.

Dogfooded against a real D1 + drizzle 1.0.0-rc.4 codebase (the blog), which surfaced and fixed the wrapper's gaps.

### Added

- **Per-tag guards are the classes' own static `is`** — the tag classes export
  as values, so `UniqueViolation.is(e)` narrows exactly like
  `isUniqueViolation(e)` did (the better-result `TaggedError.is` idiom); the
  `isXxx` predicate functions are gone. Family guards stay as functions:
  `isConstraintViolation`, `isConnectionFailure`, `isDbError`, `isRetriedError`.
- **Relational query E-track in `drizzleTryDb`** — `db.query.<table>.findMany/findFirst/findOne` resolve `Result<T, readUnion>` (constraint tags excluded per the driver's ledger) with the same classification and retry; `$dynamic` builders are wrapped recursively. The blog's relational-first surface is now fully on Result shapes.
- **Driver-agnostic drizzle wrapper types** — the wrapper is structural over the db's own method signatures (it was `PgAsyncDatabase`-only), so pg, sqlite/D1, mysql, and mssql drizzle databases all typecheck with no drizzle-internal imports.
- **Zero-arg `.returning()` restored** on wrapped drizzle chains — the mapped type kept only the overloaded columns form, breaking `.values(...).returning()`.
- **`executeTakeFirst` on every Kysely builder family** — the mapped type no longer drops it on insert/update/delete/merge.
- **postgres.js integration tests** — real-Docker coverage beside pg, mysql2, and mssql.
- **`kyselyTryDb` convenience-terminal E-track** — `executeTakeFirst` resolves `Result<T | undefined, E>`, `executeTakeFirstOrThrow` resolves `Result<T, E | NoResultError>` with a custom `errorConstructor` honored (Kysely's only throw becomes a value).
- **`isConstraintViolation` family guard** — one predicate for the four constraint tags (`unique`/`foreign-key`/`not-null`/`check`), beside the existing `isConnectionFailure` grouping — the canonical "input broke a schema rule" fold collapses to one check.

### Fixed

- **Sync-backend transaction atomicity** (release blocker, codex P1): the
  wrapped `transaction` mirrors the source db's async-ness — sync backends
  (bun:sqlite, better-sqlite3) force a synchronous callback with drizzle's
  branded-rejection mechanic, and a runtime guard throws when a sync driver
  returns a promise callback by identity (it had committed before the
  wrapped statements resolved).
- **SQLite/D1 terminals E-tracked** — `run`/`all`/`get` on wrapped chains
  resolve `Result` (a duplicate-key `.run()` is an `Err`, retried) instead
  of throwing raw, including through `with(...)` CTE chains; `all`/`get`
  are gated on `.returning()` for mutation builders like drizzle.
- **Codex review findings**: the runtime proxy now wraps pre-execute builder
  shapes (`with().insert(t)`, mssql `output()`), so the E-track survives
  intermediate chain steps; family guards read `_tag` again (serialized /
  cross-realm tagged errors match the boundary); the minimum-TS consumer
  uses `UniqueViolation.is(e)`; a column is no longer accepted as an insert
  value (it bound as a scalar → NULL); the kysely `takeFirst` family detects
  selects by builder brand, not row shape; `$call` arrays / URLSearchParams
  / FormData are no longer mistaken for builders; mssql's `_query`
  relational surface is E-tracked like `query`.
- **Wrapped builders no longer execute on property inspection** — `.then` /
  `.catch` reads are lazy (merely checking thenability never runs the
  query); terminal dispatch uses own-property checks so
  `.constructor`/`.hasOwnProperty` pass through; the custom-`errorConstructor`
  union is honest (`Result<T, E | YourError>`, never a claimed
  `NoResultError`).
- **Write chains re-typed from the threaded table**: `values` accepts
  `SQL`/`Placeholder` expressions, `set` also accepts column references,
  `onConflictDoUpdate`'s `set` rejects unknown columns — bogus keys never
  typecheck, expression-valued writes do.
- **`selectDistinctOn` keeps its 1-arg form** (top-level and `with`
  surface); the `with` factories thread the table generic and restore
  zero-arg `select`/`selectDistinct`.
- **MSSQL `output` chains resolve the projected rows** — the fields arm
  rebuilds the result from the call's fields type (including the
  `{ inserted: true }` full-row form), propagated through `values`.
- **Kysely `mergeInto` completed** — aliased targets (`mergeInto("users as u")`),
  `MergeResult` seeding (no spurious `undefined`/`NoResultError`), and the
  overloaded merge stages (`using` join keys, `whenMatchedAnd`, the `then*`
  object forms).
- **Docs**: README vocabulary matches the shipped 14 tags (connect-failure/connection-lost split, data-error, deadlock, lock-timeout, transaction-aborted); the `matchErrorPartial` example uses the real 3-arg form with annotated handlers; stale lattice doc references removed.
- **Test organization**: suites colocated with their modules (`src/*.test.ts`, `src/classify/*.test.ts`), compile-only type matrix at `src/types.test-d.ts`, live integration at `src/integration.test.ts` — `bun test` runs with zero config.

## [0.2.1] — 2026-08-08

### Fixed

- **Classified errors are self-describing** (ISSUES #2): the original driver
  failure now lands on the classified error as the real `message` plus the
  standard `Error.cause` (constructed through the tag classes — `String(error)`,
  logs, and `toJSON` show the driver text; the blog's incident peel no longer
  needs to walk hidden properties). Classification props survive; `retrySafe`
  is preserved so the transient retry policy is unchanged.

## [0.1.0] — 2026-08-06

First public release. Database failures as better-result tagged errors — `Result<T, DbError>`, retry-safe, driver-agnostic.

### Added

- **`tryDb`**, three forms:
  - `tryDb(builder)` — shape and retry unit come from the query builder's own type; the error union narrows per builder shape (select / insert / update / delete) and per driver protocol.
  - `tryDb(() => promise)` — full protocol union; retry re-invokes the thunk.
  - `tryDb(promise)` — full protocol union, no retry, dev warning.
- **`tryTx(cb)`** — whole-transaction retry; `BEGIN` failures stay in the union.
- **Driver subpath entry points** — `db-result/pg`, `db-result/sqlite`, `db-result/d1`, `db-result/mysql2`, `db-result/mssql` — each exposing the protocol-tightened classifier and ledger for that driver. 30+ Drizzle drivers map onto these five protocols.
- **`{orm}TryDb` factories** — `db-result/drizzle`, `db-result/kysely`, `db-result/prisma` — commit-to-Result wrappers that E-track every builder chain, transaction, and delegate call without thunks at the call site. Kysely chains keep precise row types; Prisma delegate calls resolve with the full union (no builder types to probe). The Kysely convenience terminals are E-tracked too: `executeTakeFirst` resolves `Result<T | undefined, E>`, `executeTakeFirstOrThrow` resolves `Result<T, E | NoResultError>` (custom `errorConstructor` honored) — Kysely's only throw becomes a value on the wrapped surface.
- **Retry doctrine** — transient tags (`db/deadlock` incl. serialization failure, `db/lock-timeout`, `db/connect-failure` — reconnectable, `db/query-failure` for statement-timeout / too-many-connections) auto-retry with jittered backoff; one-shot tags (`db/unique-violation`, `db/foreign-key-violation`, `db/not-null-violation`, `db/check-violation`, `db/data-error`, `db/authentication-failed`, `db/authorization-failed`, `db/sql-syntax-error`) never retry, and neither do the ambiguous `db/connection-lost` (mid-query) nor `db/transaction-aborted`. Override per call or per driver.
- **Type-level shape lattice** — "no lying types": a tag excluded from a shape's union is genuinely impossible for that shape on that driver, verified adversarially (61 probe attacks; five lattice lies found and closed before release).

### Verified

- 111 unit tests (classifier, retry doctrine, lattice), 9 live integration tests against Postgres, MySQL, and SQL Server, and compile-time type tests against real ORM types.
- Build gates: `tsc --noEmit`, oxlint, oxfmt, tsdown build, publint, arethetypeswrong (9 entry points, ESM-only), TypeScript 5.4.5 consumer check, packed-tarball isolated-consumer smoke.

### Known limitations

- ESM-only (Node ≥ 18).
- Wrapped Drizzle chains degrade to structurally-typed rows — use `tryDb(builder)` for exact row literals.
- D1 and SQLite are unit-tested; no live integration (D1 is a cloud product; SQLite uses the shared classifier).
- `db/write-conflict` tag deferred until Turso MVCC semantics stabilize; `db-result/turso` subpath when the Rust engine matures.
