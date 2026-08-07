export const DEFAULT_CONSTRAINT = "unknown";
export const MAX_HOPS = 16;
export const SLOTS = ["cause", "failure", "error", "defect", "originalError"] as const;

/** Only 5-char alphanumeric codes count as SQLSTATE. */
export const SQLSTATE_RE = /^[0-9A-Z]{5}$/;

/** Connect-phase failures — the channel was never established; safe to retry. */
export const SAFE_CONNECT_CODES = new Set([
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ECONNABORTED",
]);
/** Mid-query channel loss — the outcome is unknown; hint, not auto-retry. */
export const AMBIGUOUS_CONNECT_CODES = new Set(["ECONNRESET", "EPIPE"]);
/** TLS/crypto failure codes — connection realm, but not transient (config). */
export const TLS_CODES_RE =
  /^(DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_HAS_EXPIRED|ERR_TLS_CERT_ALTNAME_INVALID|ERR_TLS_PROTOCOL_VERSION|ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED)$/;

/** Message markers that say "this is SQLite", so numeric errcodes count. */
export const SQLITE_MESSAGE_RE =
  /constraint failed|database is locked|table is locked|is not a database|disk image is malformed|attempt to write a readonly database|malformed|no such (table|column|function)|database or disk is full|out of memory/i;

export const isString = (v: unknown): v is string => typeof v === "string";
export const isNumber = (v: unknown): v is number => typeof v === "number";
export const get = (obj: object, key: string): unknown => Reflect.get(obj, key);

/**
 * Constraint name, taken from the driver's own field when present, else from
 * the message text. Both stop at the constraint identifier and never run past
 * it — a looser match could capture whatever the driver or ORM appended
 * (including query parameters, which must never reach `data`).
 */
export const constraintFrom = (node: object): string => {
  const field = get(node, "constraint");
  if (isString(field) && field.trim().length > 0) return field.trim();

  // Prisma P-coded errors: `meta.target: ["email"]` / `meta.field_name`.
  const meta = get(node, "meta");
  if (meta !== null && typeof meta === "object") {
    const target = get(meta as object, "target");
    if (Array.isArray(target) && target.length > 0 && target.every((x) => typeof x === "string"))
      return (target as string[]).join(".");
    const fieldName = get(meta as object, "field_name");
    if (isString(fieldName) && fieldName.trim().length > 0) return fieldName.trim();
  }

  const message = get(node, "message");
  if (!isString(message)) return DEFAULT_CONSTRAINT;

  // SQLite: `UNIQUE constraint failed: table.column[, table.column …]`
  const sqlite = /constraint failed: ([\w]+(?:\.[\w]+)+)(?:,\s*[\w]+(?:\.[\w]+)+)*/i.exec(message);
  if (sqlite?.[1]) return sqlite[1].trim();
  // Postgres: `duplicate key value violates unique constraint "name"`
  const pg = /constraint "([^"]+)"/.exec(message);
  if (pg?.[1]) return pg[1].trim();
  // MySQL / vitess: `Duplicate entry 'x' for key 'name'`
  const mysql = /for key '([^']+)'/.exec(message);
  return mysql?.[1]?.trim() ?? DEFAULT_CONSTRAINT;
};
