# HANDOFF — db-result

Status: **design resolved (grill session, round 4); implementation in progress.** Read this
first, then `src/db-result.ts`. Everything in "Design decisions locked in" is settled
shared understanding — the roadmap is the implementation order.

---

## Mission

`db-result` — the database adapter for the better-result ecosystem. One driver-agnostic
`tryDb` that classifies database failures into better-result tagged errors and returns
`Result<T, DbError>`, so DB calls compose with the rest of an errors-as-values app.

**Standalone package.** Decoupled from result-rpc: `result-rpc/db` is legacy contrib from
a sunset drizzle schema-entity bridge — no adoption plan, no dependency either way.
(Whether result-rpc deletes its `db` module is result-rpc's own call.)

**The vision, in one line:** *Effect SQL's protocol-level classification breadth +
Drizzle's per-driver ergonomics, made better-result-native — with a decision-complete
taxonomy and a retry hint, not a tag, for transient failures.*

---

## Current state (verified)

- **Working code:** `src/db-result.ts` — 5-tag version extracted from result-rpc's
  `tryDb`, ported to better-result 3.0 (`Result.ok`/`Result.err`, `TaggedError` factory).
- **Tests:** `bun test` → 18 pass (fixtures pg / D1 / node:sqlite / better-sqlite3 /
  bun:sqlite shapes + real `bun:sqlite`). `bun test ./test.integration.ts` with
  `PGTEST_DSN` → real node-postgres proof (constraint names, `cause` reachable).
- **Published gist** (the shareable artifact, linked from better-result issue #108):
  https://gist.github.com/jokull/b7cbc1fb35278443b350c87f67db1afe
- **Governance probe live:** https://github.com/dmmulroy/better-result/issues/108 —
  awaiting dmmulroy's answer on core/contrib/community home. Gist stands alone regardless.
- **Research complete (all facts verified, sources in References):** PG SQLSTATE classes,
  SQLite primary+extended codes, mysql2 `errno` tables, mssql native numbers, connection/
  pool-layer error shapes, D1/libsql/wa-sqlite driver shapes, @effect/sql taxonomy
  (source-read), better-result 3.0 API surface (typings-read), GitHub REST API behavior
  (docs-verified).

---

## Design decisions locked in

### 1. API — `tryDb(query, config?)`

```ts
tryDb(
  query: PromiseLike<T> | (() => PromiseLike<T> | T),
  config?: RetryConfig<DbError>,   // better-result 3.0 shape: times/delayMs/backoff/
                                   // shouldRetry/jitter/signal — passthrough
): Promise<Result<T, DbError>>
```

- Built on better-result 3.0 `Result.tryPromise` (verified API) — retry config and
  `signal`/abort come from the host library, `shouldRetry` reads the `potentiallyTransient`
  hint. Sync drivers (bun:sqlite) go through a `Promise.resolve` wrapper.
- **Name: `tryDb`** — not `safeDb`/`safeQuery` (injection-safety vocabulary collision),
  not `attempt*` (retry vocabulary), not `safeTry` (does not exist). `tryDb` has zero
  precedent collisions and sits in the `Result.try` family.
- No sync variant; no `classify` export. `tryDb` + the nine classes + guards + `DbError`.

### 2. Vocabulary — nine protocol-agnostic tags, `db/*` namespace

Driver identity lives in `cause`, never in the tag (protocol-agnostic: swapping drivers
must not break the fold). All classes exported; `constraint` data only on the constraint
family.

| tag | data | notes |
|---|---|---|
| `db/unique-violation` | `constraint` | incl. primary-key (SQLite 1555 / pg 23505) |
| `db/foreign-key-violation` | `constraint` | 23503 / 787 / mysql2 1216,1217,1451,1452 / mssql 547 |
| `db/not-null-violation` | `constraint` | 23502 / 1299 / 1048,1364 / 515 |
| `db/check-violation` | `constraint` | 23514 / 275 / 3819 / 547 |
| `db/connection-failure` | — | 08xxx, ECONN*/EAI_*/timeouts, pool messages, CANTOPEN, CR_* (2006/2013), mssql 233/10054 |
| `db/authentication-failed` | — | 28P01/28000, mysql2 1045, mssql 18452/18456/4060 |
| `db/authorization-failed` | — | 42501, mysql2 1044/1142/1143/1227, mssql 229/230/262/297/300, SQLITE_PERM(3). (SQLITE_AUTH → here, not auth: it's the authorizer = permission) |
| `db/sql-syntax-error` | — | 42601/42P01/42703, mysql2 1054/1064/1146/1149, mssql 102/207/208/2714 |
| `db/query-failure` | — | terminal; the only tag that also carries the transient hint |

- **Hint:** `potentiallyTransient?: boolean` on **all** nine (uniform-optional so
  `shouldRetry: e => e.potentiallyTransient` type-checks across the union without
  narrowing). Set `true` only on: network connection-failures, pg `40001`/`40P01`/
  `55P03`/`57014`/`53300`, `SQLITE_BUSY`(5)/`SQLITE_LOCKED`(6). Never on constraint/
  auth/authz/syntax. Retry is a *policy*, not a tag — Effect's `isRetryable` is itself a
  hint, not a guarantee.
- **Philosophy — the decision-test:** a tag earns its place iff it changes a caller
  decision real apps make **and** ≥2 drivers give a stable signal. By that test the nine
  are decision-complete on five axes (data fault, channel, identity, permission, program);
  everything else is `query-failure` + `cause`. Growth candidates (deferred, not
  rejected): `db/data-error` (22xxx), `db/statement-timeout` (57014/3024). The growth
  test goes in the README.

### 3. Classification — duck-type with strict shape guards

- Read `code` / `errcode` / `sqlState` / `constraint` / message patterns / cause-chain
  slots (`cause`/`failure`/`error`/`defect`, BFS ≤16 hops, visited-set).
- **Shape guards** so non-DB errors never misclassify: `code` counts as SQLSTATE only if
  it matches `^[0-9A-Z]{5}$`; `code` strings only against enumerated prefixes
  (`SQLITE_*`, `ERR_SQLITE_ERROR`, `ER_*`, `CLIENT_*`, `ECONN*`, TLS codes…); `errcode`
  only in SQLite's numeric ranges; message patterns anchored (dotted identifiers only —
  never captures query params or ORM-appended text).
- Constraint extraction: driver `constraint` field first, then dotted-identifier regex,
  `unknown` fallback. `cause` attached non-enumerable (strip before any wire boundary —
  upstream `TaggedError.toJSON()` spreads `cause` by design).

### 4. Terminal — Variant B: rethrow what we can't classify

An error matching **no** enumerated protocol shape is **rethrown**, not tagged
`query-failure`. `tryDb`'s contract: *classifies database failures; everything else is
not ours to label.* User-code bugs inside the thunk (TypeError etc.) and unknown driver
shapes escape loudly as the defects they are — in `Result.gen`, they surface as
better-result's `Panic`. A novel driver shape crashing is by design: it requests a new
mapping instead of hiding in `query-failure` forever. (Variant C — hybrid DB-ish sniffing
— is the documented fallback if production robustness ever demands it.)

### 5. Structure — one package, subpath exports (drizzle-1.0 ergonomics, not packages)

- Core `db-result` stays protocol-detecting (the 80% case).
- Subpath modules: `db-result/pg`, `db-result/sqlite`, `db-result/d1`, `db-result/libsql`,
  `db-result/mysql2`, `db-result/mssql` — each a code-table registry + driver-bound
  `tryDb` + real tests. Driver-bound entry points remove shape-detection ambiguity
  (mysql2 `errno` vs sqlite `errcode` are both numbers in overlapping ranges).
- Drizzle: **driver-level caller, usable by drizzle 1.0+** — wrap drizzle query promises,
  the cause-chain BFS sees through `DrizzleQueryError` (query/params/cause). NO drizzle
  module in 1.0; no `~0.9` support. Test matrix gains `drizzle@1.0.x` devDep.

### 6. Verification — no CI, no receipts; a local Docker suite

- **No GitHub Actions, no check-runs/statuses/gists/receipts** — dropped.
- `compose.yaml`: `postgres:16`, `mysql:8`, `mcr.microsoft.com/mssql/server:2022-latest`.
- Embedded (no server): `bun:sqlite`, `node:sqlite` (node runner), `better-sqlite3`,
  `wa-sqlite`, libsql (`@libsql/client` `file:` URL), D1 (miniflare, node context).
- DSN-gated integration tests (`PGTEST_DSN`/`MYSQLTEST_DSN`/`MSSQLTEST_DSN`, skip when
  absent) → `bun test` stays green without docker; `bun run test:integration`
  (`docker compose up -d` + DSNs + suite) is the deep pass. Proof story = README + gist/
  issue thread.

### 7. Identity

- npm name **punted** — repo stays private; gist is the artifact; publish under the
  decided name once #108 answers (or independently if it never does).
- README rewrite is part of the roadmap: taxonomy table, `tryDb` contract, rethrow note,
  drizzle 1.0+ note, docker suite run story, growth test.

---

## Roadmap (implementation order)

1. **Package scaffold** — tsdown build, `src/index.ts` re-exports, exports map (core +
   subpaths), devDeps (`tsdown`, `typescript`, `better-sqlite3`, `@libsql/client`,
   `miniflare`, `drizzle-orm@1`, `postgres.js`, `pg`). Repo stays `private: true`.
2. **Core rewrite** — nine tags + hint + guards + strict shape guards + Variant-B rethrow
   + `RetryConfig` passthrough on `Result.tryPromise`.
3. **Test expansion** — connection-layer fixtures (ECONNREFUSED, pool messages, TLS),
   auth/authz/syntax fixtures per protocol, rethrow tests; real tests: node:sqlite,
   better-sqlite3, libsql (`file:`), D1 (miniflare), postgres.js, drizzle-1.0 wrapping.
4. **Per-driver modules + Docker suite** — `compose.yaml`, mysql2/mssql real tests
   against containers.
5. **README rewrite** + publish prep.
6. **Publish** when the name is decided.

---

## Open questions (only these remain)

- **npm package name / scope** — punted until #108's answer.
- **result-rpc `db` removal** — result-rpc's own call; no dependency either way.
- **Query/params retention on errors** — deferred; only matters if drizzle integration
  later demands wrapper observability.

---

## References

- Proven gist: https://gist.github.com/jokull/b7cbc1fb35278443b350c87f67db1afe
- Governance issue: https://github.com/dmmulroy/better-result/issues/108
- better-result 3.0 API: `node_modules/better-result/dist/index.d.mts` (Result.gen /
  Result.await / tryPromise / matchErrorPartial / TaggedError / Panic — verified)
- Effect SQL taxonomy (the ancestor, source-read):
  https://github.com/Effect-TS/effect/blob/main/packages/effect/src/unstable/sql/SqlError.ts
  + dialect classifiers: `packages/sql/pg/src/PgClient.ts`, `packages/sql/mysql2/src/MysqlClient.ts`,
  `packages/sql/mssql/src/MssqlClient.ts`
- Drizzle 1.0 RC Effect adapter: `drizzle-orm/src/effect-core/errors.ts`
- Protocol references: postgresql.org errcodes appendix; sqlite.org/rescode.html;
  pg-protocol/pg-client/pg-pool source; nodejs.org sqlite + `node_sqlite.cc`;
  better-sqlite3 docs; cloudflare/workerd `d1-api.ts` + miniflare `database.worker.ts`;
  libsql-client-ts `libsql-core/src/api.ts`; wa-sqlite `sqlite-api.js`; MySQL 8.0
  server+client error references + mysql2 `lib/constants/errors.js`; mssql error docs +
  ODBC Appendix A
- GitHub REST (doc-verified): commit statuses (plain token, `target_url`, 1000/sha+context),
  check runs (GitHub-App-only to create; fine-grained PATs unsupported in practice),
  artifacts + attestations (require a real Actions run — why the receipt idea died)
- Ecosystem: nektos/act; HN "The End of CI"; GitHub Actions 2026 pricing threads
- Origin (provenance only): result-rpc `src/db.ts` —
  https://github.com/jokull/result-rpc/blob/main/src/db.ts
