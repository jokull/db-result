import {
  UniqueViolation,
  ForeignKeyViolation,
  DeadlockError,
  TransactionAborted,
  ConnectFailure,
  ConnectionLost,
  AuthenticationFailed,
  AuthorizationFailed,
  QueryFailure,
  mark,
  transient,
  type DbError,
} from "../tags.js";

/** Prisma engine P-codes: exactly `P` + four digits. */
export const PRISMA_CODE_RE = /^P\d{4}$/;

/**
 * Prisma protocol — engine P-codes are ORM-level (same codes over any
 * driver), so they classify structurally: `code: "P2002"` + `clientVersion`.
 * The classic engine path strips the driver cause; `meta` carries the fields.
 */
export const classifyPrisma = (code: string, constraint: string): DbError => {
  switch (code) {
    case "P2002":
      return new UniqueViolation({ constraint });
    case "P2003":
      return new ForeignKeyViolation({ constraint });
    // P2034 — write conflict / deadlock; Prisma's own message says to retry.
    case "P2034":
      return mark(new DeadlockError(transient), true);
    // P2028 — interactive transaction closed / unusable; the tx is dead.
    case "P2028":
      return new TransactionAborted({});
    // Connect-phase: reach / pool / timeout — the channel never established,
    // safe to auto-retry. `P1003` (database missing) is deterministic.
    case "P1001":
    case "P1002":
    case "P1008":
    case "P2024":
    case "P2037":
      return mark(new ConnectFailure(transient), true);
    case "P1003":
    case "P1011": // TLS error — deterministic
    case "P1013": // invalid connection string — deterministic
      return mark(new ConnectFailure({}), false);
    // P1017 — server closed the connection: ambiguous mid-query loss.
    case "P1017":
      return mark(new ConnectionLost(transient), false);
    case "P1000":
      return new AuthenticationFailed({});
    case "P1010":
      return new AuthorizationFailed({});
    // P2025 (record required but not found) is a not-found semantic — the
    // caller's domain — so it folds into the generic failure, not a tag.
    default:
      return new QueryFailure({});
  }
};
