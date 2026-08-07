import {
  type DbError,
  type UniqueViolation,
  type ForeignKeyViolation,
  type NotNullViolation,
  type CheckViolation,
} from "./tags.js";

// ─── Type-level shape lattice ────────────────────────────────────────────────

/** `any` proves nothing — guards the lattice against untyped values. */
type IsAny<T> = 0 extends 1 & T ? true : false;

/** `never` proves nothing. */
type IsNever<T> = [T] extends [never] ? true : false;

/** Kysely `SelectQueryBuilder` — literal brand, exact for selects. */
export type IsSelectBuilder<T> = "isSelectQueryBuilder" extends keyof T ? true : false;

/** Drizzle select — the select-only clause surface. `limit` is deliberately
 * absent: it is shared with the delete builder, so it is not evidence. */
export type IsDrizzleSelect<T> = "groupBy" extends keyof T
  ? true
  : "having" extends keyof T
    ? true
    : "offset" extends keyof T
      ? true
      : "union" extends keyof T
        ? true
        : "intersect" extends keyof T
          ? true
          : "except" extends keyof T
            ? true
            : "for" extends keyof T
              ? true
              : false;

/** Insert builders — `values()` (Kysely Insert, Drizzle `PgInsertBuilder`),
 * or the on-conflict surface that only the post-`values` Drizzle insert
 * carries (`PgInsertBase` / `PgInsert`). */
export type IsInsertBuilder<T> = "values" extends keyof T
  ? true
  : "onConflictDoUpdate" extends keyof T
    ? true
    : "onConflictDoNothing" extends keyof T
      ? true
      : false;

/** Update builders — `set()` (Kysely Update, Drizzle `PgUpdateBuilder`), or
 * `from()` — the Drizzle post-`set` update (`PgUpdateBase`/`PgUpdate`). The
 * select probe already claimed `PgSelect` (which also has `from`), so a
 * bare `from` here is a write. */
export type IsUpdateBuilder<T> = "set" extends keyof T
  ? true
  : "from" extends keyof T
    ? true
    : false;

/** Delete builders — `where()` AND `returning()`, once `values`/`set`/`from`
 * are ruled out by the pipeline order. `returning` is what separates a real
 * delete from DDL: Kysely's `CreateIndexBuilder` has a `where` (partial-index
 * predicate) and `execute` but no `returning`, and `CREATE UNIQUE INDEX`
 * raises 23505 — a delete claim would exclude it. A DELETE can only FK-fail
 * among the constraints, so `Fk` stays while the others go. `RawBuilder` and
 * Kysely `MergeQueryBuilder` (which can raise constraints via `thenInsert`)
 * have no `where`/`returning` → fall to opaque. */
export type IsDeleteBuilder<T> = "where" extends keyof T
  ? "returning" extends keyof T
    ? true
    : false
  : false;

/** Every shape the lattice can prove. */
export type DbShape = "read" | "write" | "delete" | "opaque";

/**
 * The shape a query value proves, in lattice order (most specific first). A
 * probe firing is structural evidence the ORM emitted; a non-match falls
 * through to the next. `any`/unknown prove nothing — `"opaque"` — which the
 * caller turns into a compile error (fail-loud), never a silent full union.
 *
 * Order notes: the delete probe's `where` is only honest after the insert
 * and update probes claimed `values`/`set`/`from`. The update probe's `from`
 * is only honest after the select probe claimed Drizzle `PgSelect` (which
 * also has `from`).
 */
export type ShapeOfQuery<T> =
  IsAny<T> extends true
    ? "opaque"
    : IsNever<T> extends true
      ? "opaque"
      : IsSelectBuilder<T> extends true
        ? "read"
        : IsDrizzleSelect<T> extends true
          ? "read"
          : IsInsertBuilder<T> extends true
            ? "write"
            : IsUpdateBuilder<T> extends true
              ? "write"
              : IsDeleteBuilder<T> extends true
                ? "delete"
                : "opaque";

/**
 * The exclusion ledger — the "no lying types" contract. Each key lists the
 * tags that shape provably cannot produce **on this driver**, with the reason
 * inline. A tag stays in the union unless a shape proves it impossible; the
 * runtime classifier is never affected (narrowing is type-level only).
 * Drivers override entries where their protocol differs.
 *
 * `transaction-aborted` is excluded from NO shape: a tx-bound builder (the
 * tx client returns the same builder types as the root client, so the type
 * cannot tell) raises 25P02 after any prior failed statement in the
 * transaction — the exclusion would be a lie in every shape.
 */
export interface ShapeLedger {
  /** Pure reads cannot raise constraints. Footgun: "reads that write" (DML
   * CTEs, volatile functions, INSTEAD-OF triggers) CAN — the runtime still
   * classifies them correctly, the tag just falls to the fold terminal; use
   * the thunk form for reads-with-writes. */
  read: DbError;
  /** Writes can raise every tag — including `transaction-aborted` when the
   * builder is bound to a transaction — so nothing is excluded. */
  write: DbError;
  /** A DELETE can only FK-fail among the constraints. */
  delete: DbError;
}

/** The ledger every driver starts from. */
export interface DefaultLedger extends ShapeLedger {
  read: UniqueViolation | ForeignKeyViolation | NotNullViolation | CheckViolation;
  write: never;
  delete: UniqueViolation | NotNullViolation | CheckViolation;
}

/** Tags a shape excludes, per the ledger. `"opaque"` excludes nothing. */
export type ShapeExclusions<L extends ShapeLedger, S extends DbShape> = S extends "read"
  ? L["read"]
  : S extends "write"
    ? L["write"]
    : S extends "delete"
      ? L["delete"]
      : never;

/** The driver union `E` narrowed by what the query value provably cannot do. */
export type ShapeUnion<E extends DbError, L extends ShapeLedger, F> = Exclude<
  E,
  ShapeExclusions<L, ShapeOfQuery<F>>
>;

/** A query value that proves a shape — else `never` (fail-loud). */
export type ShapeProven<F> = ShapeOfQuery<F> extends "opaque" ? never : F;
