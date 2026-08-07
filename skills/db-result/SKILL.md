---
name: db-result
description: Database access with better-result — classify failures into 14 db/* tagged errors, retry only what is safe, run whole transactions, and let the query builder's own type narrow the error union per ORM shape. Use when writing code that touches a SQL driver or ORM (pg, postgres.js, mysql2, mssql, better-sqlite3, node:sqlite, bun:sqlite, libsql, D1, Drizzle, Kysely, Prisma) in a TypeScript project that uses or is adopting better-result — wrapping queries with tryDb, handling unique/foreign-key/connection/deadlock failures, writing ON CONFLICT or upsert logic, choosing retry behavior, starting or joining transactions, or deciding how not-found should be represented.
---

# db-result

`db-result` turns every database failure into a `better-result` tagged error —
`Result<T, DbError>` — and makes the retry decision for you, safely. Driver- and
ORM-agnostic: it reads the _protocol_ error shape (SQLSTATE, SQLite codes,
mysql2 errno, mssql number, Prisma P-codes), never any ORM's API.

**This file is a map, not the documentation.** The reference pages in
[`references/`](./references/) are the single source of truth; they describe the
shipped API, and this file only routes you to them. When a reference conflicts
with this file, the reference wins — it is maintained; this map is not.

## Escalation ladder

Start at the rung that matches where you are, then follow the links. Don't read
everything — each rung loads only what it needs.

| Rung             | You are here                                           | Read                                                                                                                                   |
| ---------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| **What is this** | Never seen db-result or better-result                  | [`references/overview.md`](./references/overview.md) — the idea in one page                                                            |
| **0**            | Using better-result or not — deciding whether to adopt | [`references/adoption.md`](./references/adoption.md) — the case, the cost, the alternative                                             |
| **1**            | Installing                                             | [`references/adoption.md#install`](./references/adoption.md#install) — `bun add better-result db-result` + subpath entry points        |
| **2**            | Migrating an existing codebase                         | [`references/adoption.md#migrate`](./references/adoption.md#migrate) — boundary-first strategy, error classification, fold-at-boundary |
| **3**            | Writing database code                                  | The task map below — jump to the topic                                                                                                 |

## Task map — jump to the topic

Fetch the linked reference page for the task at hand:

| When you're…                                | Read                                                                                          |
| ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Wrapping any query / statement              | [`references/patterns.md`](./references/patterns.md)                                          |
| Handling a unique / FK / constraint failure | [`references/vocabulary.md`](./references/vocabulary.md)                                      |
| Choosing retry behavior                     | [`references/retry.md`](./references/retry.md)                                                |
| Starting a whole transaction                | [`references/transactions.md`](./references/transactions.md)                                  |
| Writing a statement _inside_ a transaction  | [`references/transactions.md#in-transaction`](./references/transactions.md#in-transaction)    |
| Narrowing the union from the thunk's shape  | [`references/shapes.md`](./references/shapes.md)                                              |
| Upsert / `ON CONFLICT` / idempotency        | [`references/patterns.md#upsert`](./references/patterns.md#upsert)                            |
| Deciding what a not-found should be         | [`references/vocabulary.md#not-found`](./references/vocabulary.md#not-found)                  |
| Adding a driver / protocol shape            | [`references/vocabulary.md#adding-a-driver`](./references/vocabulary.md#adding-a-driver)      |
| "Which subpath for my driver/ORM?"          | [`references/adoption.md#install`](./references/adoption.md#install) — the Drizzle driver map |
| Observability (tags, cause, retries)        | [`references/retry.md#observability`](./references/retry.md#observability)                    |

## The one rule that is a correctness bug if broken

**Attempt the insert — that _is_ the uniqueness check.** Never SELECT-then-INSERT
to "check first"; run the write and classify the failure (`db/unique-violation`).
It is race-safe where check-then-act is not, and it is what the retry doctrine
assumes.

## Non-negotiables

- **Wrap with `tryDb`, fold with `matchErrorPartial`.** DB tags are private
  composition currency — never wire errors. Fold them into domain errors at the
  handler boundary.
- **Pass the query builder, or a thunk.** A builder value
  (`tryDb(db.selectFrom("users").selectAll())`) is both the retry unit and the
  shape: the union narrows to what that shape provably cannot raise, and retry
  re-executes the builder. A thunk (`tryDb(() => prisma.user.findMany(args))`)
  gets the full union and retry by re-invoking — the form for one-shot calls
  (Prisma, raw SQL). A settled promise never auto-retries (it can't re-run; a
  dev warning fires once — wrap in a thunk to get retry).
- **The builder's own type is the shape signal.** Nothing to declare, nothing
  to sync: the ORM emitted the type, so the evidence is verified by
  construction — a select drops the constraint tags, a delete keeps only FK;
  `transaction-aborted` is never excluded (tx-bound builders raise 25P02).
  A builder that proves no shape (raw SQL, Kysely `mergeInto`) is a compile
  error on purpose (fail-loud, never a silent full union); a builder wrapped
  in a thunk is a compile error too (pass it directly). See
  [`references/shapes.md`](./references/shapes.md) — the lattice, the footgun,
  the honest ceilings.
- **Retrying is classified, not guessed.** Deterministic errors (constraints,
  auth, data) and ambiguous outcomes (connection lost mid-query, unknown commit
  outcome) are never auto-retried. The transient set is small and per-error.
- **Strip `cause` before any wire boundary.** `TaggedError.toJSON()` spreads
  `cause` (with stack) by design.
