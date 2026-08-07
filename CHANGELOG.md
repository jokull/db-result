# Changelog

All notable changes to db-result. This project adheres to [Semantic Versioning](https://semver.org).

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
