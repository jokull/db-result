import { describe, expect, test } from "bun:test";
import { tryDb, isConnectionFailure, type DbError } from "../db-result.js";

const transientOf = (e: DbError): boolean =>
  (e as { potentiallyTransient?: boolean }).potentiallyTransient ?? false;

describe("connection layer — Node system codes and pool/client messages", () => {
  test("ECONNREFUSED → connection-failure, transient", async () => {
    const result = await tryDb(
      () => {
        throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), {
          code: "ECONNREFUSED",
          errno: -61,
          syscall: "connect",
        });
      },
      { retryTransient: false },
    );
    if (result.isErr()) {
      expect(isConnectionFailure(result.error)).toBe(true);
      expect(transientOf(result.error)).toBe(true);
    }
  });

  test("ETIMEDOUT / ENOTFOUND / EAI_AGAIN → connection-failure", async () => {
    for (const code of ["ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"]) {
      const result = await tryDb(
        () => {
          throw Object.assign(new Error(`connect ${code}`), { code });
        },
        { retryTransient: false },
      );
      if (result.isErr()) {
        expect(isConnectionFailure(result.error)).toBe(true);
        expect(transientOf(result.error)).toBe(true);
      }
    }
  });

  test("TLS certificate failure → connection-failure, not transient", async () => {
    const result = await tryDb(() => {
      throw Object.assign(new Error("self-signed certificate"), {
        code: "DEPTH_ZERO_SELF_SIGNED_CERT",
      });
    });
    if (result.isErr()) {
      expect(isConnectionFailure(result.error)).toBe(true);
      expect(transientOf(result.error)).toBe(false);
    }
  });

  test("pool timeout message → connection-failure, transient", async () => {
    const result = await tryDb(
      () => {
        throw new Error("timeout exceeded when trying to connect");
      },
      { retryTransient: false },
    );
    if (result.isErr()) {
      expect(isConnectionFailure(result.error)).toBe(true);
      expect(transientOf(result.error)).toBe(true);
    }
  });

  test("'Connection terminated unexpectedly' → connection-failure", async () => {
    const result = await tryDb(() => {
      throw new Error("Connection terminated unexpectedly");
    });
    if (result.isErr()) expect(isConnectionFailure(result.error)).toBe(true);
  });
});
