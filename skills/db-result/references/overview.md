# Overview — the idea in one page

`db-result` is a thin layer between your database driver (or ORM) and
[better-result](https://github.com/dmmulroy/better-result) 3.0. It does three
things:

1. **Classifies** every database failure into one of 14 `db/*` tagged errors —
   the same tag means the same thing on Postgres, SQLite, MySQL, SQL Server,
   D1, Prisma, Kysely, Drizzle. No `error.code === "23505"`, no per-driver
   `instanceof` chains.
2. **Retries** the failures worth retrying, with per-error backoff — and never
   touches the deterministic ones, or the ambiguous ones where retrying could
   double-commit a write.
3. **Composes** — everything is a `Result<T, DbError>` ready for `Result.gen`,
   `matchErrorPartial`, and the tag guards.

```ts
import { Result, matchErrorPartial } from "better-result";
import { tryDb } from "db-result";

const outcome = await Result.gen(async function* () {
  const body = yield* Result.await(parseBody(c.req)); // Err: BodyError
  const [user] = yield* Result.await(
    tryDb(() => db.insert(users).values({ email: body.email }).returning()),
  ); // Err: DbError
  return Result.ok(c.json({ id: user.id }, 201));
});
// outcome: Result<Response, BodyError | DbError> — the union is the contract

if (outcome.isErr()) {
  return matchErrorPartial(
    outcome.error,
    {
      "db/unique-violation": (e) => c.json({ error: "email_taken", constraint: e.constraint }, 409),
    },
    (unhandled) => {
      reportError(unhandled); // tag + cause + stack → observability
      return c.json({ error: "internal" }, 500);
    },
  );
}
```

## The doctrine in one sentence each

- **Attempt the insert is the uniqueness check** — run the write, classify the
  failure. Race-safe.
- **The union is the contract** — the compiler spells out which tags you're
  choosing to ignore in the fold terminal.
- **Retry is classified, not guessed** — deterministic and ambiguous failures
  are never auto-retried.
- **Not-found is data, not a failure** — a missing row is a domain outcome,
  never a `db/*` tag.

## What it does NOT do

- No SQL generation, no query building, no migrations, no pooling.
- No ORM wrappers — it wraps the _outcome_ of any thenable (raw driver call or
  ORM query) and classifies the underlying driver error through cause chains.
- An error matching **no known protocol shape is rethrown**, loudly, as the bug
  it is — never labeled `db/query-failure` to hide it.

Next: [adoption](./adoption.md) to install, or the [task map](../SKILL.md#task-map--jump-to-the-topic) to start writing code.
