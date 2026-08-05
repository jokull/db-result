# HANDOFF — db-result

Status: **bootstrapping a package from a proven gist.** Read this first, then
`src/db-result.ts`. Everything in "Current state" is verified; everything in
"Target" is the plan.

---

## Mission

`db-result` — the database adapter for the better-result ecosystem. One
driver-agnostic `tryDb` that classifies database failures into better-result
tagged errors and returns `Result<T, DbError>`, so DB calls compose with the
rest of an errors-as-values app. It fills the **adapter gap**: once you adopt
better-result, everything should produce `Result<T,E>` — and today the only
routes are Effect (heavy) or hand-rolled `instanceof`/code checks (the
status quo in every ORM forum).

**The vision, in one line:** *the overlap of the best of both bridges — Effect
SQL's protocol-level classification breadth, and Drizzle's Effect-adapter
ergonomics (tagged errors, cause-preserving wrappers, per-driver structure) —
made better-result-native.*

---

## Current state (verified)

- **Working code:** this repo's `src/db-result.ts` — extracted from
  result-rpc's `tryDb`, ported to better-result's real API
  (`Result.ok`/`Result.err`, `TaggedError` factory).
- **Tests:** `bun test` → 18 pass (fixtures for pg / D1 / node:sqlite /
  better-sqlite3 / bun:sqlite shapes + real `bun:sqlite`). `bun test
  ./test.integration.ts` with `PGTEST_DSN` → real **node-postgres** proof:
  all four constraint types classify with exact constraint names
  (`users_email_key`, `orders_user_id_fkey`), original `23505` error
  reachable via `cause`. Passed against scratch PostgreSQL 15.
- **Published gist** (the shareable artifact, linked from better-result
  issue #108):
  https://gist.github.com/jokull/b7cbc1fb35278443b350c87f67db1afe
- **Governance probe live:** https://github.com/dmmulroy/better-result/issues/108
  — asks dmmulroy: batteries in core, contrib namespace, or community
  figures it out. Awaiting his read; gist stands alone regardless.

### Design decisions locked in

1. **better-result API:** `Result.ok(value)` / `Result.err(error)` namespace
   functions — there is **no top-level `ok`/`err`** in better-result
   (result-rpc's are its own aliases). Tagged errors via the
   `TaggedError("db/tag")<{...}>` factory; **props sit directly on the
   instance** (`err.constraint`, not `err.data.constraint`).
2. **Vocabulary:** five tags — `db/unique-violation`,
   `db/foreign-key-violation`, `db/not-null-violation`,
   `db/check-violation`, `db/query-failure`. Constraint family first (the
   fold-at-boundary use case); growth path below.
3. **Three recognition paths:** PostgreSQL SQLSTATE codes (`23505`…), SQLite
   extended result codes (`code: "SQLITE_CONSTRAINT_UNIQUE"`, `errcode:
   2067/1555/787/1299/275`), SQLite native message shapes
   (`"UNIQUE constraint failed: t.c"`).
4. **Cause-chain BFS** (≤16 hops) following `cause`/`failure`/`error`/
   `defect` slots — sees through DrizzleQueryError and Effect-shaped
   nesting to the driver error.
5. **Constraint extraction:** driver's `constraint` field first, then a
   dotted-identifier regex (`table.column[, table.column]`) that can never
   capture ORM-appended text or query parameters. `unknown` fallback.
6. **Cause retained** as a non-enumerable `Error.cause` for observability;
   only `{ constraint }` reaches the tagged error's data.
7. **Sharp edge:** upstream `TaggedError.toJSON()` spreads `cause` (with
   stack) by design — fine for logs, **strip `cause` before any wire
   boundary** (this is why result-rpc keeps its own TaggedError).

---

## Target — great driver coverage, best of both bridges

### The two bridges (research findings, links in References)

- **Effect SQL (`@effect/sql`)** gives *breadth*: per-dialect classifiers
  (`classifySqliteError`, pg's code mapping), a rich taxonomy
  (`UniqueViolation`, `ConstraintError`, `AuthenticationError`,
  `AuthorizationError`, `SqlSyntaxError`, `DeadlockError`,
  `SerializationError`, `LockTimeoutError`, `StatementTimeoutError`,
  `ConnectionError`, `UnknownError`), constraint-name normalization, and
  real `SqlErrorClassification.test.ts` coverage.
- **Drizzle's Effect adapter (1.0 RC, `effect-*`)** gives *ergonomics*:
  tagged errors as the error model (`EffectDrizzleError`,
  `EffectDrizzleQueryError` with `query`+`params` retained for diagnostics),
  per-driver structure (`effect-libsql`, `effect-pglite`, `effect-postgres`,
  `effect-d1`, `effect-sqlite-node/wasm/bun/do`, `effect-mysql2`), and
  message construction with query context. Note: it preserves the cause but
  does **not** classify constraints — classification is Effect SQL's job.
- **The overlap db-result owns:** better-result `TaggedError` classes +
  `Result<T,E>` returns (not Effect `Schema`/`Effect`), cause-chain
  unwrapping, query/params retained *locally* for observability (Drizzle
  style), classification taxonomy that starts with the constraint family
  and grows toward Effect's breadth (auth/lock/syntax) where it earns it.

### Driver coverage matrix (target)

| Driver | Protocol signal | Status | To verify |
|---|---|---|---|
| `pg` (node-postgres) | SQLSTATE + `constraint` field | ✅ real-tested | — |
| `postgres.js` | SQLSTATE (same) | ⚠️ unverified | same path; quick add |
| `bun:sqlite` | code strings / errcodes | ✅ real-tested | confirm exact `code` shape |
| `node:sqlite` | `errcode` 2067/1555/787/1299/275 | ✅ fixture | real test (node, not bun) |
| `better-sqlite3` | `code: "SQLITE_CONSTRAINT_*"` | ✅ fixture | real test |
| D1 | SQLite message shapes | ⚠️ fixture only | **real test in wrangler/miniflare** — the stated #2 priority |
| `libsql` | extended codes? | ⬜ TODO | check `@libsql/client` error shape |
| `mysql2` | `ER_DUP_ENTRY`-family | ⬜ TODO | pull codes from Effect's mysql classification |
| `mssql` | 2627/2601/547/515 | ⬜ TODO | verify numbers against `@effect/sql-mssql` |
| wa-sqlite | `"Unexpected step result: 2067"` | ⬜ TODO | pattern from Thunderbird's classifier (see References) |

### Roadmap

1. **Package scaffold** — tsdown build, `src/index.ts` re-exports, exports
   map, `bun test` wired in CI. (Repo is git-init'd; package.json exists.)
2. **Real-driver proof expansion** — D1 (miniflare), node:sqlite under Node,
   better-sqlite3, postgres.js. Each driver = one fixture test + one real
   test where feasible.
3. **Taxonomy growth, Effect-informed** — decide which non-constraint
   classes (lock/timeout/auth) belong in `db-result` vs. stay app-side.
   Constraint family is the 80/20; don't bloat early.
4. **Publish** — npm name TBD (`db-result`? scoped?). README already
   documents the pattern; add migration-from-result-rpc note.
5. **Adopt back into result-rpc** — replace `src/db.ts` with a dependency
   on `db-result`; remove `result-rpc/db` in 0.4.0 (pre-1.0 breaking).
6. **Announce** — the gist/issue thread is the launch surface; blog post
   on the pattern + ecosystem question.

---

## Open questions

- **Naming / npm scope** — `db-result` is the repo name; package name and
  whether #108's answer moves it toward a `better-result/*` home.
- **Taxonomy ceiling** — stop at the constraint family, or grow toward
  Effect's full `SqlError` breadth? (Recommendation: constraints now, grow
  on demand — the "attempt the insert is the uniqueness check" use case
  needs nothing more.)
- **D1 real verification** — needs a Workers/miniflare environment; the
  user's stated priority after pg.
- **Query/params retention** — Drizzle's adapter keeps them on the error;
  db-result keeps them out of the tagged error's data. Decide if a
  *local-only* `query`/`params` field (non-enumerable, like `cause`) is
  worth adding for observability.

---

## References

- Proven gist: https://gist.github.com/jokull/b7cbc1fb35278443b350c87f67db1afe
- Governance issue: https://github.com/dmmulroy/better-result/issues/108
- Effect SQL classifier (the technique's ancestor):
  https://github.com/Effect-TS/effect/blob/main/packages/effect/src/unstable/sql/SqlError.ts
  and pg mapping:
  https://github.com/Effect-TS/effect/blob/main/packages/sql/pg/src/PgClient.ts
- Drizzle 1.0 RC Effect adapter (tagged-error ergonomics):
  https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.4/drizzle-orm/src/effect-core/errors.ts
  (per-driver sessions: `drizzle-orm/src/effect-libsql/session.ts` etc.)
- Cousin classifier (wa-sqlite pattern): thunderbird/thunderbolt
  `src/lib/sqlite-errors.ts`
- Origin: result-rpc `src/db.ts` (`tryDb`, `dbErrors`) —
  https://github.com/jokull/result-rpc/blob/main/src/db.ts
- better-result `TaggedError` factory + `Result` namespace:
  `node_modules/better-result/dist/index.d.mts` in any consuming repo
