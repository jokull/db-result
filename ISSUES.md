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

**Severity: should fix before release** (unsound exhaustive handling).

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

**Severity: should fix before release** (forces consumers to handle an
impossible no-row case).

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
