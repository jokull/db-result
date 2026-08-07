# ISSUES

Release-blocking ledger for db-result. Severity: **blocks release** /
**should fix** / **follow-up**. Statuses updated as work lands.

---

## 1. `drizzleTryDb` write chains lose `.returning()` row precision

**Status: FIXED** — commit `faf7613` (on `main`, folded into the `v0.1.1`
tag). Verified by repo type asserts (insert/update/delete) and the real blog
(`db.insert(Comment)...returning()` → `Result<Comment[], SqliteDbError>`).

**Root cause** (confirmed against the drizzle-orm fork source): the mapped
`WrappedBuilder` inferred `R`/`A` from drizzle's overloaded `returning()`
method and the inference was doubly unusable —

1. `A` came back `[]` (inference from the first overload), so **zero-arg
   calls matched the fields arm** instead of the all-columns arm.
2. `R` carried **unresolved polymorphic `this`** (`SQLiteInsertReturning<this,
…>`), so `ExecR`'s `_`-slot branch failed and it fell through to the
   `execute` return (the run result: `Changes` / `{[x: string]: unknown}[]`).

Worse, the intermediate builders' `_` slots **don't carry the table at all**:
drizzle's `values()` returns a 3-arg
`SQLiteInsertBase<TTable, TResultType, TRunResult>` whose first generic is
the _table_, not the HKT (a constraint-violating instantiation), so a
builder-side `ReturningAll<B>` reconstruction also failed — `B extends
{ _: { table: … } }` never matched.

**Fix:** thread the table from the call site — `insert`/`update`/`delete`
take `<TTable extends { $inferSelect: unknown }>(table)` and pass it through
`WrappedBuilder<…, TTable>`; the zero-arg `returning()` arm rebuilds the
all-columns result from `TTable["$inferSelect"]`:

```ts
const rows = await db.insert(Comment).values({ … }).returning();
// Promise<Result<Comment[], SqliteDbError>> — drizzle's exact rows
```

The blog's 14 `tryDb(rawDb…)` row-exact writes can now collapse to the
wrapped `db` (not yet migrated).

---

## 2. Relational projections claim runtime-absent fields (codex P1)

**Status: FIXED** — the relational methods re-express drizzle's generic
signature so `columns`/`with` projections resolve per-call (verified in the
repo's `types.test-d.ts` and on the blog's real D1 surface:
`findMany({ columns: { slug, publishedAt, modifiedAt } })` →
`Result<{ slug: string; publishedAt: Date; modifiedAt: Date | null }[], E>`).

**Root cause:** the mapped conditional `R[K] extends (...args: infer A) =>
PromiseLike<infer T>` captures `T` from the generic method **instantiated at
its constraint** — the per-call config never reaches the Ok type.

**Fix** (`src/drizzle.ts`, `RelationalMethod`): a generic method's type
parameter cannot be inferred from its constraint position (`infer C` comes
back `unknown`), but the params' `KnownKeysOnly<TConfig, C>` captures the
EXACT constraint with its type arguments concrete. Extract TSchema/TFields
and the many/one mode from it, re-declare the generic, and recompute
`BuildQueryResult` per call:

```ts
A extends KnownKeysOnly<infer C, any>
  ? C extends DBQueryConfig<infer Mode, infer TSchema, infer TFields>
    ? <TConfig extends C>(config?: KnownKeysOnly<TConfig, C>) => Promise<
        Result<
          Mode extends "one"
            ? BuildQueryResult<TSchema, TFields, TConfig> | undefined
            : BuildQueryResult<TSchema, TFields, TConfig>[],
          RelationalReadE<E, L>
        >
      >
    : never
  : never
```

The mapping lives in a top-level `RelationalQueryOf<Q, E, L>` over the
extracted `QuerySurfaceOf<D>` — under the native TS compiler (tsgo) an inline
per-key mapping inside the instantiated db object keeps the per-table indexed
access deferred and the generic-signature match fails.

**tsgo + symlinked packages:** a separate landmine found during verification —
with the blog's `file:` symlink to the repo, tsgo resolves the dist's
`drizzle-orm/relations` imports from the dist's REALPATH (the repo's install)
instead of the symlink path (the consumer's install), producing a different
module identity than the consumer's method types and silently defeating the
constraint match (`tsc` 5.9 resolves via the symlink path and is unaffected).
Consumers on tsgo need a REAL install (tarball or `install-links`) — the
blog's `file:` dev link must be replaced once the migration settles.

---

## 3. `errorConstructor` from a typed options object omitted from the union (codex P2)

**Status: FIXED** — `NoResultErrorFor` now matches the OPTIONAL property; a
variable typed `ExecuteTakeFirstOrThrowOptions` resolves the honest union.
Follow-up refinement (second codex pass): when the options type's
`errorConstructor` is optional AND the value is absent, the runtime falls
back to `NoResultError` — the union keeps it (`ErrorFromCtor<NonNullable<C>>
| (undefined extends C ? NoResultError : never)`).

**Symptom** (`src/kysely.ts`, `NoResultErrorFor` ~lines 120-127): when the
options are stored in a variable typed `ExecuteTakeFirstOrThrowOptions`, its
**optional** `errorConstructor` does not satisfy the required
`{ errorConstructor: infer C }` shape in the conditional, so the union falls
back to `NoResultError`. At runtime the caller's custom error is returned —
the Result union omits it, so an exhaustive consumer treats the custom error
as a `NoResultError`.

**Fix direction:** account for the optional property
(`{ errorConstructor?: infer C }`) or the broad options type; the inline
`{ errorConstructor: … }` literal form already works — only the variable form
lies.

---

## 4. Zero-arg `selectDistinctOn` / `execute` accepted though drizzle requires args (codex P2)

**Severity: should fix before release** (forwards a TypeError instead of a
classified Result).

**Symptom** (`src/drizzle.ts` ~lines 104-106): the `| []` union on the
mapped args makes `wrapped.selectDistinctOn()` and `wrapped.execute()`
typecheck with no arguments, though drizzle requires the DISTINCT ON
expressions / a query. The zero-arg call is forwarded unchanged and throws an
unclassified TypeError instead of resolving `Result`.

**Fix direction:** only preserve zero-arg overloads for methods that actually
provide them (`select`/`selectDistinct` do via `Parameters<…> | []` for the
drizzle zero-arg forms); drop `| []` where drizzle has no zero-arg overload.

---

## 5. Kysely mutation `executeTakeFirst` always adds `undefined` (codex P2)

**Status: FIXED** — the takeFirst family computes the Ok from `ExecR` (the O
slot is seeded `{}` and `values`/`set` never update it) and the factory
signatures seed the real result types (`InsertResult`/`UpdateResult`/
`DeleteResult`); `executeTakeFirstOrThrow` on mutation builders omits the
impossible no-result error from its union (follow-up refinement from the
second codex pass).

**Symptom** (`src/kysely.ts` `TakeFirstFn` ~lines 111-114): the terminal
resolves `Result<O | undefined, E>` unconditionally. Kysely's own
`SimplifySingleResult<O>` excludes `undefined` for non-returning
insert/update/delete/merge builders — those terminals always produce their
result object. Wrapped mutation calls therefore force `undefined` handling
that can never happen at runtime.

**Fix direction:** mirror Kysely's conditional terminal result instead of
`O | undefined` — the `| undefined` belongs only on select-shaped builders
(and on returning-less mutations the _run_ result, not `undefined`).

---

## 6. `returning({ fields })` projections still degrade (follow-up from #1)

**Status: OPEN — follow-up** (blog + README use the zero-arg form only).
**Symptom:** `db.insert(t).values({…}).returning({ slug: true })` resolves a
wrapped-but-degraded rows type instead of `{ slug: string }[]`.

**Root cause:** same overloaded-inference poison as #1 — the fields arm's `R`
is constraint-instantiated (and polymorphic-`this`), so the Ok degrades to
`Record<string, unknown>[]`-ish. `SelectResultFields` is drizzle-internal and
not structurally reconstructible.

**Fix direction:** re-select drizzle's own generic fields overload at the
call (per-call inference), or thread the fields through like the table in #1.
Consumers: use `tryDb(rawDb…)` for fields projections until fixed.

---

## 8. Sync-backend transactions break atomicity (codex P1, third pass)

**Status: FIXED (`64f0236`) — was the release blocker.** The wrapped `transaction` accepts a
`PromiseLike` callback unconditionally (`src/drizzle.ts` runtime passes an
async callback). On SYNCHRONOUS backends (bun:sqlite, better-sqlite3) the
driver commits when the callback returns its promise — the wrapped
statements inside resolve AFTER the commit — a mid-transaction failure
produces an outer `Err` with the earlier writes committed. The fix mirrors
the source db's transaction callback return: async backends keep
`PromiseLike`; sync backends force a sync callback with drizzle's own
branded-rejection mechanic (`SyncTxError` — the wrapped surface's
Promise-returning statements are unusable inside a wrapped tx, effectively
rejecting it on sync drivers), plus a runtime guard that throws when a sync
driver returns a promise callback by identity (it committed before the
statements resolved). The blog (D1, async) is unaffected.

## 9. Expression-valued writes rejected (codex P2, third pass)

**Status: FIXED (`64f0236`).** The #7 `$inferInsert`/`Partial<I>` re-typing accepts only
model values — raw drizzle's insert/update sources also permit
`SQL | Placeholder` (and columns for update). `values({ id: sql\`...\` })`/`set({ count: sql\`...\` })`now fail. Fix: union each column type with
drizzle's`SQL`/`Placeholder` while still filtering unknown keys.

## 10. `selectDistinctOn` one-arg overload lost (codex P2, third pass)

**Status: FIXED (`64f0236`).** The #4 fix dropped `| []`, but the mapped `infer A`
captures the LAST overload (the 2-arg pg form), so the valid
`selectDistinctOn([users.id])` errors "Expected 2 arguments". Fix: preserve
both overloads (make `fields` optional) without the zero-arg form.

## 11. `with` surface drops overloads and the table generic (codex P2, third pass)

**Status: FIXED (`64f0236`).** The mapped `with` surface erases drizzle's overloads and
the call-site table generic: `wrapped.with(cte).select()` requires fields;
`wrapped.with(cte).insert(table).values(...)` exposes `values` as `never`
(no `TTable` reaches `WrappedBuilder`). Fix: re-express the with factories
and thread the table like the top-level methods.

## 12. SQL Server `output` result types (codex P2, third pass)

**Status: FIXED (`64f0236`).** `db.insert(t).output().values(...)` resolves
`Result<never, …>` — only `returning` is reconstructed; mssql's `output`
chain loses its executable result type. Fix: result tracking for `output`.

---

# Third-pass codex verdict (2026-08-07)

The mapped-chain wrapper has a long regression tail: three codex passes over
the same base surfaced 12 findings total (all type-surface except #8, which
was a runtime atomicity issue on sync backends). **All 12 are FIXED** —
#1-#7 in `faf7613`/`bcb4ece`/`bdfb5d7`, #8-#12 in `64f0236`. The release
blocker (#8, sync-tx atomicity) is resolved: the wrapped transaction mirrors
the source db's async-ness, so wrapped tx on sync drivers is rejected at
compile time (and guarded at runtime) instead of silently committing early.
The blog (D1, async) is unaffected. Pending: re-run `codex review --base
54bb02a` to confirm the closures before publish.

---

## 7. Wrapped write-chain args (`values`/`set`) were constraint-instantiated (codex P1, second pass)

**Status: FIXED** — the `values` arm re-types from the threaded table's
`$inferInsert` (`value: I | I[]`) and the update `set` arm from
`Partial<I>`; invalid columns are rejected exactly like the unwrapped
client. Root cause: `ReturnType<D["insert"]>` instantiates drizzle's
generic factory without `TTable`, so the mapped chain's `values`/`set`
params degraded to the constraint — the `TTable` threading only reached
the zero-arg `returning()` arm. Same family as #1/#2.

---

## 7. Wrapped `set()` payload rejects SQL expressions (blog dogfood)

**Status: OPEN — follow-up** (blog now uses a value-based revision instead).

**Symptom:** `db.update(t).set({ revision: sql\`${t.revision} + 1\` })` fails to
typecheck — `Type 'SQL<unknown>' is not assignable to type 'number'`. Drizzle's
raw `UpdateSet` accepts SQL expressions for any column; the wrapped builder's
`set` arm (`K extends "set" ? (update: Partial<I>) => …`) types the payload as
`Partial<TTable["$inferInsert"]>`, which drops that allowance.

**Fix direction:** the `set` arm should accept drizzle's own update payload
shape (`UpdateSet`-ish — column value or `SQL`), not `Partial<I>`. The blog
worked around it with a value-based `existing.revision + 1`, which is
equivalent under the WHERE revision guard but lost the atomic SQL increment in
the one place without a guard.

**Note:** only surfaced under `yield* Result.await(db.update(...).set(...))`;
the same chain under `Result.unwrap(await ...)` inferred through a different
path and accepted it. Inference into the wrapped builder is fragile — worth a
look while touching `set`.

---

# What we learned (2026-08-07)

The dogfood port + this fix run produced the durable lessons below — worth
keeping visible for the next wrapper, not just this repo.

## The mapped-type-over-overloaded-method trap

`B[K] extends (...args: infer A) => infer R` over an **overloaded** method is
a coin flip: `infer A`/`infer R` pick one overload (empirically the first for
`A` — which can come back `[]` and silently match zero-arg calls), and a
**generic** method's type params instantiate at their **constraint**, not the
call site. The result is a type that lies about the runtime shape. Drizzle's
`returning()`/`values()` are the poster child — verify every overloaded
surface with per-call probes.

## Polymorphic `this` poisons inferred returns

A method returning `SQLiteInsertReturning<this, …>` captured via `infer R`
_outside the class_ keeps `this` unresolved, so every `this`-indexed member
(`_` slot included) is inaccessible and conditional branches silently fall
through (our `ExecR` fell to the execute branch). Reconstruction must come
from a **concrete** type — thread the table from the call site, never re-derive
it from the builder's internals.

## Drizzle rc.4's intermediate builders drop their `_` slots

`values()` returns a 3-arg `SQLiteInsertBase<TTable, TResultType, TRunResult>`
— the HKT slot is filled with the _table_ (a constraint-violating
instantiation), so `B["_"]` no longer resolves on intermediates. Only the
entry builder and the final returning builder have usable slots. Never assume
an intermediate's `_` survives.

## Probe methodology (the debugging loop)

- **`Same<X, Y>` (mutual assignability) is the only decisive probe.** A
  one-directional `X extends Y` passes whenever X is a supertype — our
  fields-form probe "passed" because all-columns ⊇ `{slug}`, hiding the bug.
- **An unimported type in a probe turns it `any`** — `Same<X, any>` = true, so
  every assert passes spuriously. Two hours of "passes" were poison from a
  missing `WrappedBuilder` import. Check probe symbols resolve before trusting
  a green run.
- **`const r: string = null as unknown as T` prints the real type** in the
  error — the fastest alias-free reveal (when it actually errors).
- Ground truth in order: repo type asserts → the REAL consumer (blog tsc) →
  LSP hover on the call site → the ORM's source (the fork, not the minified
  d.ts).

## The constraint-capture trick (generic-method precision)

A generic method's type parameter cannot be inferred from its constraint
position (`F extends <T extends infer C>(...) => ...` gives `C = unknown`),
but the params often reference the constraint in a wrapper type —
drizzle's `config?: KnownKeysOnly<TConfig, Constraint>` — and the SECOND type
argument captures the constraint EXACTLY, with its type arguments concrete.
Extract the schema args and the result mode from it, re-declare the generic,
and recompute the result per call. This is the general form of the #1
"thread what the call site knows" lesson, for methods you cannot re-express
structurally.

## tsgo resolves symlinked packages from the realpath

The native TS compiler resolves a symlinked package's import of a
peer-dependency from the DIST FILE'S REALPATH (the linked repo's install),
not the symlink path (the consumer's install). Same package version, byte
-identical d.ts — but a DIFFERENT MODULE IDENTITY — so structural matches
that depend on the type's origin (generic-signature inference through an
imported type) silently fail while `tsc` 5.9 (symlink-path resolution) and
any real install pass. Symptom: a lib's types degrade to fallbacks only
under `tsgo` + `file:`-linked deps. Fix: real installs (`npm pack` + install,
or `install-links`); verify consumer typechecks with a tarball, not a link.

## Fold idiom judgment

better-result has **no multi-tag primitive** (full API scan: `matchError` /
`matchErrorPartial` / `isTaggedError` / `TaggedError.is` / `isPanic`).
Divergent arms or arms that read the error → `matchErrorPartial(error, folds,
onUnhandled)` (3-arg, annotated handlers, terminal narrowed to the remainder).
Convergent arms (any-of-N tags → one outcome) → a **family guard**
(`isConstraintViolation`, beside `isConnectionFailure`) — one check + `throw
cause` beats N identical arms.

## Release discipline

- The ISSUES.md ledger is the paranoid checklist: anything typed here as OPEN
  is a "don't publish" or "documented sharp edge" decision, made explicit.
- Don't tag/publish until the user says the work is done — a premature tag
  gets force-moved, but the noise costs a reset cycle.
- The LSP hover verification of the blog's wrapped chains is what _surfaced_
  this blocker — the "verify the heavy lifting" exercise earns its keep.
