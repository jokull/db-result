import { describe, expect, test } from "bun:test";
import type { Result } from "better-result";
import {
  tryDb,
  tryTx,
  ConnectFailure,
  ConnectionLost,
  isRetriedError,
  type DbError,
} from "./db-result.js";

const transientOf = (e: DbError): boolean =>
  (e as { potentiallyTransient?: boolean }).potentiallyTransient ?? false;

describe("retry policy — retryTransient defaults to true, per-error defaults", () => {
  const deadlock = () => {
    throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
  };

  test("transient failures are retried by default with no config", async () => {
    let attempts = 0;
    const result = await tryDb(() => {
      attempts += 1;
      if (attempts < 3) deadlock();
      return "ok";
    });
    expect(result.isOk()).toBe(true);
    expect(attempts).toBe(3);
  });

  test("deterministic errors are never retried by default", async () => {
    let attempts = 0;
    const result = await tryDb(() => {
      attempts += 1;
      throw Object.assign(new Error("UNIQUE constraint failed: users.email"), {
        code: "SQLITE_CONSTRAINT_UNIQUE",
      });
    });
    expect(result.isErr()).toBe(true);
    expect(attempts).toBe(1);
  });

  test("ambiguous mid-query connection loss is never auto-retried", async () => {
    let attempts = 0;
    const result = await tryDb(() => {
      attempts += 1;
      throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    });
    expect(result.isErr()).toBe(true);
    expect(attempts).toBe(1);
    if (result.isErr()) {
      // still a hint: a custom policy may retry it deliberately
      expect((result.error as { potentiallyTransient?: boolean }).potentiallyTransient).toBe(true);
    }
  });

  test("connect-phase failures (ECONNREFUSED) are auto-retried", async () => {
    let attempts = 0;
    await tryDb(() => {
      attempts += 1;
      if (attempts < 2)
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      return "connected";
    });
    expect(attempts).toBe(2);
  });

  test("the split: connect-failure retries, connection-lost never does", async () => {
    let connectAttempts = 0;
    const connect = await tryDb(() => {
      connectAttempts += 1;
      if (connectAttempts < 2)
        throw Object.assign(new Error("connect ENETUNREACH"), { code: "ENETUNREACH" });
      return "ok";
    });
    expect(connect.isOk()).toBe(true);
    expect(connectAttempts).toBe(2);

    let lostAttempts = 0;
    const lost = await tryDb(() => {
      lostAttempts += 1;
      throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    });
    expect(lost.isErr()).toBe(true);
    expect(lostAttempts).toBe(1);
    if (lost.isErr()) {
      expect(lost.error._tag).toBe("db/connection-lost");
      expect(ConnectFailure.is(lost.error)).toBe(false);
      expect(ConnectionLost.is(lost.error)).toBe(true);
    }
  });

  test("retryTransient: false disables auto-retry", async () => {
    let attempts = 0;
    const result = await tryDb(
      () => {
        attempts += 1;
        deadlock();
      },
      { retryTransient: false },
    );
    expect(result.isErr()).toBe(true);
    expect(attempts).toBe(1);
  });

  test("explicit retry overrides the defaults", async () => {
    let attempts = 0;
    const result = await tryDb(
      () => {
        attempts += 1;
        deadlock();
      },
      { retry: { times: 2, delayMs: 1, backoff: "constant" } },
    );
    expect(result.isErr()).toBe(true);
    expect(attempts).toBe(3); // initial + 2 retries
  });

  test("explicit retry without shouldRetry still gets the safe gate", async () => {
    let attempts = 0;
    const result = await tryDb(
      () => {
        attempts += 1;
        throw Object.assign(new Error("UNIQUE constraint failed: users.email"), {
          code: "SQLITE_CONSTRAINT_UNIQUE",
        });
      },
      { retry: { times: 3, delayMs: 1, backoff: "constant" } },
    );
    expect(result.isErr()).toBe(true);
    expect(attempts).toBe(1);
  });

  test("custom shouldRetry is honored verbatim", async () => {
    let attempts = 0;
    const result = await tryDb(
      () => {
        attempts += 1;
        deadlock();
      },
      {
        retry: {
          times: 5,
          delayMs: 1,
          backoff: "constant",
          shouldRetry: (e) => e._tag === "db/deadlock",
        },
      },
    );
    expect(result.isErr()).toBe(true);
    expect(attempts).toBe(6); // initial + 5 retries
  });
});
describe("builder values — the shape carrier and the retry unit", () => {
  test("a builder value retries by re-executing the builder", async () => {
    let attempts = 0;
    // Structural stand-in for a query builder (Kysely/Drizzle emit these);
    // the call is cast because the shape lattice rejects unproven shapes —
    // the runtime path is what's under test.
    const builder = {
      execute: () => {
        attempts += 1;
        if (attempts < 3) {
          return Promise.reject(Object.assign(new Error("deadlock detected"), { code: "40P01" }));
        }
        return Promise.resolve({ rowCount: 1 });
      },
    };
    const result = await (tryDb as unknown as (q: unknown) => Promise<Result<unknown, DbError>>)(
      builder,
    );
    expect(attempts).toBe(3); // re-executed per attempt, like a re-invoked thunk
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value).toEqual({ rowCount: 1 });
  });

  test("a builder value does not retry deterministic failures", async () => {
    let attempts = 0;
    const builder = {
      execute: () => {
        attempts += 1;
        return Promise.reject(
          Object.assign(new Error("UNIQUE constraint failed: users.email"), {
            code: "SQLITE_CONSTRAINT_UNIQUE",
          }),
        );
      },
    };
    const result = await (tryDb as unknown as (q: unknown) => Promise<Result<unknown, DbError>>)(
      builder,
    );
    expect(attempts).toBe(1);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error._tag).toBe("db/unique-violation");
  });

  test("an explicit retry still wins over the default policy", async () => {
    let attempts = 0;
    const builder = {
      execute: () => {
        attempts += 1;
        if (attempts < 2) {
          return Promise.reject(Object.assign(new Error("deadlock detected"), { code: "40P01" }));
        }
        return Promise.resolve("ok");
      },
    };
    const result = await (
      tryDb as unknown as (
        q: unknown,
        c: { retry: { times: number; delayMs: number; backoff: "constant" } },
      ) => Promise<Result<unknown, DbError>>
    )(builder, { retry: { times: 3, delayMs: 1, backoff: "constant" } });
    expect(attempts).toBe(2);
    expect(result.isOk()).toBe(true);
  });
});
describe("promise form — one-shot, no auto-retry", () => {
  test("a settled promise is never re-run", async () => {
    let runs = 0;
    const settled = Promise.resolve().then(() => {
      runs += 1;
      throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
    });
    const result = await tryDb(settled);
    expect(runs).toBe(1); // one-shot: no retry, no re-await
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error._tag).toBe("db/deadlock");
  });
});
describe("tryTx — whole-transaction retry", () => {
  test("deadlock retries the whole thunk (fresh transaction each attempt)", async () => {
    let attempts = 0;
    const result = await tryTx(() => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      return "committed";
    });
    expect(attempts).toBe(3);
    expect(result.isOk()).toBe(true);
  });

  test("ambiguous commit-outcome failures are never auto-retried", async () => {
    let attempts = 0;
    const result = await tryTx(() => {
      attempts += 1;
      throw Object.assign(new Error("Connection terminated unexpectedly"), {
        code: "ECONNRESET",
      });
    });
    expect(attempts).toBe(1);
    if (result.isErr()) {
      expect(result.error._tag).toBe("db/connection-lost");
      expect(transientOf(result.error)).toBe(true); // a hint, never auto-retried
    }
  });

  test("deterministic errors are never retried", async () => {
    let attempts = 0;
    const result = await tryTx(() => {
      attempts += 1;
      throw Object.assign(new Error("UNIQUE constraint failed: users.email"), {
        code: "SQLITE_CONSTRAINT_UNIQUE",
      });
    });
    expect(attempts).toBe(1);
    if (result.isErr()) expect(result.error._tag).toBe("db/unique-violation");
  });

  test("retryTransient: false disables whole-thunk retry", async () => {
    let attempts = 0;
    const result = await tryTx(
      () => {
        attempts += 1;
        throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
      },
      { retryTransient: false },
    );
    expect(attempts).toBe(1);
    expect(result.isErr()).toBe(true);
  });

  test("a failure that survived retries carries the attempt count", async () => {
    const result = await tryTx(() => {
      throw Object.assign(new Error("deadlock detected"), { code: "40P01" });
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(isRetriedError(result.error)).toBe(true);
      if (isRetriedError(result.error)) expect(result.error.retries).toBe(4);
    }
  });
});

describe("classified errors are self-describing (ISSUES #2)", () => {
  test("message carries the driver text and cause is the standard enumerable Error.cause", async () => {
    const driverError = Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    const result = await tryDb(
      () => {
        throw driverError;
      },
      { retryTransient: false },
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      const e = result.error;
      // the real driver message — String(error) and logs are self-describing
      expect(e.message).toBe("database is locked");
      expect(String(e)).toContain("database is locked");
      // standard Error.cause machinery (non-enumerable per the Error spec —
      // the hand-rolled hidden property is gone); toJSON serializes it
      expect(e.cause).toBe(driverError);
      expect(JSON.parse(JSON.stringify(e)).cause.message).toBe("database is locked");
      expect(JSON.parse(JSON.stringify(e)).message).toBe("database is locked");
    }
  });

  test("classification props survive the rebuild (constraint, transient, retrySafe)", async () => {
    const result = await tryDb(
      () => {
        throw Object.assign(new Error("UNIQUE constraint failed: users.email"), {
          code: "SQLITE_CONSTRAINT_UNIQUE",
        });
      },
      { retryTransient: false },
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      const e = result.error;
      expect(e.message).toBe("UNIQUE constraint failed: users.email");
      expect(e._tag).toBe("db/unique-violation");
      expect((e as { constraint?: string }).constraint).toBeDefined();
    }
  });

  test("retrySafe survives the rebuild — transient errors still retry", async () => {
    let attempts = 0;
    const result = await tryDb(() => {
      attempts += 1;
      if (attempts < 3)
        throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      return "connected";
    });
    expect(result.isOk()).toBe(true);
    expect(attempts).toBe(3);
    if (result.isOk()) expect(result.value).toBe("connected");
  });
});
