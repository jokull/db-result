# Patterns — write, upsert, idempotency

## P1 — Wrap any query

Drivers, raw SQL, and ORMs are all just thenables; the classifier sees through
wrapper cause-chains (Drizzle, Effect-shaped nesting) to the driver error.

```ts
// raw pg / postgres.js / mysql2 / mssql / sqlite — same shape
const [user] = await tryDb(() => sql`select * from users where id = ${id}`);

// drizzle / kysely / prisma — API untouched, outcome wrapped
const created = await tryDb(() => db.insert(users).values({ email }).returning());
if (created.isErr() && isUniqueViolation(created.error)) {
  return errors.EmailTaken({ email, constraint: created.error.constraint });
}
```

## P2 — Fold at the boundary

DB tags are private composition currency. In a handler, fold the tags you care
about into your domain errors; let `matchErrorPartial`'s terminal turn the rest
into 500 + observability:

```ts
return matchErrorPartial(
  outcome.error,
  {
    "db/unique-violation": (e) => c.json({ error: "email_taken", constraint: e.constraint }, 409),
    "body/invalid": (e) => c.json({ error: "invalid_body", issues: e.issues }, 422),
  },
  (unhandled) => {
    reportError(unhandled); // the compiler spells out what you're ignoring
    return c.json({ error: "internal" }, 500);
  },
);
```

## P3 — Attempt the insert is the uniqueness check

Check-then-act races; insert-then-classify does not. Canonical signup, safe
under concurrent requests for the same email:

```ts
const outcome = await tryDb(() => db.insert(users).values({ email }).returning());
if (outcome.isOk()) return ok(outcome.value[0]);
if (isUniqueViolation(outcome.error)) {
  return errors.EmailTaken({ email, constraint: outcome.error.constraint });
}
return internal(outcome.error); // connection, syntax, … — report, don't guess
```

## P4 — Upsert recipes

Upsert is the _avoidance_ strategy — the write never fails with a conflict, so
the classifier never sees it. Use it when a conflict is not an error; use P3
when it is (different status code).

**Postgres / SQLite — `ON CONFLICT` (true upsert):**

```sql
INSERT INTO users (email, name) VALUES ($1, $2)
ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
RETURNING *;
-- EXCLUDED = the rejected insert row. NOT `VALUES(...)` — syntax error.
```

- Conflict target: `ON CONFLICT (col, col)` or `ON CONFLICT ON CONSTRAINT name`.
  Partial unique indexes need their predicate: `ON CONFLICT (workspace_id, slug) WHERE deleted_at IS NULL`.
- `DO NOTHING` returns nothing for conflicting rows — you can't tell inserted
  from skipped. `DO UPDATE ... RETURNING (xmax = 0) AS inserted` can.
- Conditional update: add `WHERE EXCLUDED.updated_at > users.updated_at` to the `DO UPDATE`.
- Counter increment: `views = page_views.views + 1` — NOT `EXCLUDED.views + …`.
- JSONB merge: `attrs = product_attrs.attrs || EXCLUDED.attrs`.
- **Not a free pass:** concurrent upserts on the same key can still surface
  `23505` and deadlocks. Classify the rare failure; don't assume `ON CONFLICT`
  makes conflicts impossible.

**SQLite:** `ON CONFLICT(col) DO UPDATE/NOTHING` works (≥ 3.24). Avoid the
older forms: `INSERT OR IGNORE` swallows _every_ constraint violation (FK, NOT
NULL, CHECK silently vanish — not just unique), and `INSERT OR REPLACE` is a
delete-then-insert: it fires DELETE triggers, cascades to children, resets
auto-increment. Seeing either in a codebase is a bug hunt.

**MySQL:** `INSERT ... ON DUPLICATE KEY UPDATE name = new.name` (row alias form;
the old `VALUES(col)` function is deprecated in 8.0.20+). Caveats: it burns
auto*increment ids even when it updates, and with multiple unique keys it may
update a row that collided on a \_different* key than the one you meant.

**SQL Server:** avoid `MERGE` (notorious concurrency bugs). The reliable shape
is P3: try the `INSERT`, classify `2627`/`2601` as `db/unique-violation`, and
`UPDATE` in that branch.

## P5 — Idempotency keys (make ambiguous retries safe)

`tryDb` refuses to retry mid-query connection loss because the write may have
committed. The fix isn't "retry anyway" — it's making the write idempotent by
construction, then re-attempting is safe:

```sql
CREATE TABLE idempotency_keys (
  key           TEXT PRIMARY KEY,          -- the client's request key
  response_body JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

```ts
// attempt the insert — the PK *is* the uniqueness check
const out = await tryDb(
  () =>
    sql`INSERT INTO idempotency_keys (key, response_body)
      VALUES (${key}, ${body})
      ON CONFLICT (key) DO UPDATE SET response_body = EXCLUDED.response_body
      RETURNING response_body, (xmax = 0) AS inserted`,
);
// inserted === true  → first run: do the work
// inserted === false → replay: return the stored response_body
```

## P6 — Not-found is data

A missing row is a legitimate outcome, not a `db/*` error:

```ts
const row = await tryDb(() => sql`SELECT * FROM users WHERE id = ${id}`);
if (row.isErr()) return row; // real failure — propagate
const user = row.value[0];
if (!user) return Result.err(new NotFound({ id })); // your domain error
```

## P7 — Declare the shape, narrow the union

The thunk's parameter type is evidence of what the query can and cannot do —
`tryDb` narrows the error union to the tags that shape provably cannot produce
(full lattice, probes, footgun and honest ceilings in
[shapes.md](./shapes.md)). The parameter is a type-level declaration only:
`tryDb` never passes an argument, so close over the real client in the body.

```ts
// zero-arg: no evidence — full driver union, auto-retry on
tryDb(() => db.selectFrom("users").selectAll().execute());

// read shape: constraints + transaction-aborted gone from the union
tryDb((q: SelectQueryBuilder<DB, "users", {}>) => db.selectFrom("users").selectAll().execute());

// transaction shape: authn/connect-failure gone, retry off, tx-aborted stays
tryDb((tx: Transaction<DB>) => tx.insertInto("users").values({ email }).execute());

// Prisma args: findMany args are provably read; where-only args narrow to
// the delete set (FK stays — delete/deleteMany can FK-fail)
tryDb((args: Prisma.UserFindManyArgs) => prisma.user.findMany(args));
```

A one-arg thunk whose parameter proves nothing fails to compile on purpose —
use the zero-arg form rather than guessing. Declaring any parameter turns
statement auto-retry off (a transaction context must not re-run one statement
on a dead transaction); an explicit `retry` still wins.

## Pitfalls

- **Passing a promise instead of a thunk** — retries re-await the same outcome.
- **`constraint` is for observability, never control flow** — match on the tag.
- **`INSERT OR IGNORE` / `INSERT OR REPLACE`** — swallow-everything and
  delete-then-insert traps; prefer `ON CONFLICT ... DO UPDATE`.
- **`EXCLUDED` not `VALUES`** in Postgres `DO UPDATE`.
- **Statement-level retry inside a transaction** — roll back and retry the whole
  thing, or you'll fight `25P02`.
- **Wire boundaries** — strip `cause` (better-result's `toJSON()` spreads it).
