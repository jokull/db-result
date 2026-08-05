/**
 * db-result — classify database failures into tagged better-result errors.
 *
 * Core entry point: the protocol-detecting `tryDb` plus the full `DbError`
 * vocabulary and guards. Per-driver entry points (`db-result/pg`,
 * `db-result/mysql2`, …) register their code tables and export driver-bound
 * `tryDb` variants.
 */
export * from "./db-result.js";
