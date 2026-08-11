/**
 * Type test — better-result 3.0.1 regression guard: a multi-branch
 * `tryRecover` fold (two `err(...)` returns plus a `throw`, the constraint-fold
 * shape the blog uses) must leave the wrapped terminal's success lane intact.
 *
 * The `err` helper mirrors result-rpc's signature — it returns the public
 * `Result<never, E>` (an Ok|Err union with a phantom `never` success lane),
 * not `Err<never, E>`. That is the shape that collapsed to `unknown` in
 * better-result 3.0.1's reworked `TryRecoverReturn` when the fold runs on a
 * wrapped builder terminal.
 */
import { Kysely } from "kysely";
import { Err, type InferErr, type InferOk, type Result } from "better-result";
import { kyselyTryDb } from "./kysely.ts";
import type { SqliteDbError } from "./drivers/sqlite.ts";

interface DB {
	post: { slug: string; title: string };
}

declare class SlugTaken extends Error {
	declare readonly _tag: "slug-taken";
}
declare class PostNotFound extends Error {
	declare readonly _tag: "post-not-found";
}

import { ForeignKeyViolation, UniqueViolation } from "./tags.ts";

declare function slugTaken(): SlugTaken;
declare function notFound(): PostNotFound;

/** Mirrors result-rpc's `err`: public Result, phantom never success lane. */
const err = <E extends { _tag: string }>(error: E): Result<never, E> =>
	new Err<never, E>(error);

const rawDb = new Kysely<DB>({ dialect: {} as never });
const db = kyselyTryDb<typeof rawDb, SqliteDbError>(rawDb);

// The blog's createPost shape: constraint codes fold to domain errors,
// everything else falls through as a panic.
const folded = (
	await db
		.insertInto("post")
		.values({ slug: "x", title: "t" })
		.returningAll()
		.executeTakeFirstOrThrow()
).tryRecover((e) => {
	if (UniqueViolation.is(e)) return err(slugTaken());
	if (ForeignKeyViolation.is(e)) return err(notFound());
	throw e;
});

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
	? true
	: false;
type Assert<T extends true> = T;

// The success lane must survive the fold so callers can chain on the row.
type OkLane = InferOk<typeof folded>;
type A1 = Assert<Equal<OkLane, { slug: string; title: string }>>;

// The error lane must carry exactly the declared domain errors.
type ErrLane = InferErr<typeof folded>;
type A2 = Assert<Equal<ErrLane, SlugTaken | PostNotFound>>;

// Genuinely useful chaining must type-check off the fold result.
const chained: Result<string, SlugTaken | PostNotFound> = folded.andThen((row) =>
	err(slugTaken()),
);
