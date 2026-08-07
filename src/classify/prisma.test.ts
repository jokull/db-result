import { describe, expect, test } from "bun:test";
import { tryDb, type DbError } from "../db-result.js";

const constraintOf = (e: DbError): string => (e as { constraint?: string }).constraint ?? "";
const transientOf = (e: DbError): boolean =>
  (e as { potentiallyTransient?: boolean }).potentiallyTransient ?? false;

describe("prisma protocol — engine P-codes", () => {
  const prisma = (code: string, message: string, meta?: Record<string, unknown>) =>
    Object.assign(new Error(message), { code, clientVersion: "6.19.3", meta });

  test("P2002 → unique violation, constraint from meta.target", async () => {
    const result = await tryDb(() => {
      throw prisma("P2002", "Unique constraint failed on the fields: (`email`)", {
        target: ["email"],
      });
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/unique-violation");
      expect(constraintOf(result.error)).toBe("email");
    }
  });

  test("P2003 → foreign-key violation", async () => {
    const result = await tryDb(() => {
      throw prisma("P2003", "Foreign key constraint failed on the field: `userId`");
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/foreign-key-violation");
  });

  test("P2034 write conflict → db/deadlock, transient (Prisma says retry)", async () => {
    const result = await tryDb(() => {
      throw prisma(
        "P2034",
        "Transaction failed due to a write conflict or a deadlock. Please retry your transaction",
      );
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/deadlock");
      expect(transientOf(result.error)).toBe(true);
    }
  });

  test("P2028 interactive tx closed → transaction-aborted", async () => {
    const result = await tryDb(() => {
      throw prisma("P2028", "Transaction API error: Transaction already closed");
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/transaction-aborted");
  });

  test("P1001 → connect-failure, transient", async () => {
    const result = await tryDb(() => {
      throw prisma("P1001", "Can't reach database server at `localhost`");
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/connect-failure");
      expect(transientOf(result.error)).toBe(true);
    }
  });

  test("P2024 pool timeout / P2037 too-many-connections → connect-failure", async () => {
    for (const [code, message] of [
      ["P2024", "Timed out fetching a new connection from the connection pool"],
      ["P2037", "Too many database connections opened"],
    ] as const) {
      const result = await tryDb(() => {
        throw prisma(code, message);
      });
      if (result.isErr()) {
        expect(result.error._tag).toBe("db/connect-failure");
        expect(transientOf(result.error)).toBe(true);
      }
    }
  });

  test("P1017 server closed connection → connection-lost, never auto-retried", async () => {
    const result = await tryDb(() => {
      throw prisma("P1017", "Server has closed the connection");
    });
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/connection-lost");
      expect(transientOf(result.error)).toBe(true);
    }
  });

  test("P1000 authentication failed / P1010 access denied", async () => {
    const authn = await tryDb(() => {
      throw prisma("P1000", "Authentication failed against database server");
    });
    if (authn.isErr()) expect(authn.error._tag).toBe("db/authentication-failed");

    const authz = await tryDb(() => {
      throw prisma("P1010", "User was denied access on the database");
    });
    if (authz.isErr()) expect(authz.error._tag).toBe("db/authorization-failed");
  });

  test("P2025 record-not-found → query-failure (not a tag; the caller's domain)", async () => {
    const result = await tryDb(() => {
      throw prisma("P2025", "An operation failed because it depends on one or more records");
    });
    if (result.isErr()) expect(result.error._tag).toBe("db/query-failure");
  });
});
