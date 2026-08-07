import { AuthenticationFailed, type DbError } from "../tags.js";
import {
  MAX_HOPS,
  SLOTS,
  SQLSTATE_RE,
  SQLITE_MESSAGE_RE,
  constraintFrom,
  get,
  isNumber,
  isString,
} from "./helpers.js";
import { classifySQLSTATE } from "./sqlstate.js";
import { classifySqliteCodeString, classifySqliteNumeric } from "./sqlite.js";
import { classifyNodeCode } from "./node.js";
import { classifyMysql } from "./mysql.js";
import { classifyMssql } from "./mssql.js";
import { classifyPrisma, PRISMA_CODE_RE } from "./prisma.js";
import { classifyMessage } from "./message.js";

const hasSqliteSignal = (node: Classifiable): boolean => {
  const code = get(node, "code");
  const extended = get(node, "extendedCode");
  if (isString(code) && (code.startsWith("SQLITE") || code.startsWith("ERR_SQLITE"))) return true;
  if (isString(extended)) return true;
  const message = get(node, "message");
  return isString(message) && SQLITE_MESSAGE_RE.test(message);
};

const classifyNode = (node: Classifiable): DbError | undefined => {
  const code = get(node, "code");
  const message = get(node, "message");
  const constraint = constraintFrom(node);

  // 0. Prisma protocol — engine P-codes (`code: "P2002"` + `clientVersion`).
  //    Structurally most specific: `P` + four digits also matches the SQLSTATE
  //    shape, so this must run before the SQLSTATE branch.
  if (isString(code) && PRISMA_CODE_RE.test(code) && isString(get(node, "clientVersion"))) {
    return classifyPrisma(code, constraint);
  }

  // 1. PostgreSQL SQLSTATE (strict 5-char shape)
  if (isString(code) && SQLSTATE_RE.test(code)) {
    return classifySQLSTATE(code, constraint);
  }

  // 2. SQLite code strings — libsql's specific `extendedCode` first, so a
  //    generic `SQLITE_ERROR` code never shadows it, then the `code` itself.
  const extendedCode = get(node, "extendedCode");
  const sqliteCode = isString(extendedCode)
    ? (extendedCode as string)
    : isString(code)
      ? code
      : undefined;
  if (sqliteCode) {
    const classified = classifySqliteCodeString(sqliteCode, constraint);
    if (classified) return classified;
  }

  // 3. SQLite numeric errcodes (wa-sqlite puts the number in `code`)
  const errcode = get(node, "errcode");
  const rawCode = get(node, "rawCode");
  const numeric = isNumber(errcode)
    ? errcode
    : isNumber(rawCode)
      ? rawCode
      : isNumber(code)
        ? code
        : undefined;
  if (numeric !== undefined && hasSqliteSignal(node)) {
    const classified = classifySqliteNumeric(numeric, constraint);
    if (classified) return classified;
  }

  // 4. mysql2 protocol — `code: "ER_*"` or `errno` + SQLSTATE `sqlState`.
  const sqlState = get(node, "sqlState");
  const errno = get(node, "errno");
  if (
    (isString(code) && code.startsWith("ER_")) ||
    (isNumber(errno) && isString(sqlState) && SQLSTATE_RE.test(sqlState))
  ) {
    const classified = classifyMysql(code, isNumber(errno) ? errno : undefined, constraint);
    if (classified) return classified;
  }

  // 5. mssql protocol — tedious's positive integer `number` field; login
  //    failures carry the code `ELOGIN` instead of a number.
  const mssqlNumber = get(node, "number");
  if (code === "ELOGIN") return new AuthenticationFailed({});
  if (isNumber(mssqlNumber) && mssqlNumber > 0) {
    const classified = classifyMssql(mssqlNumber, isString(message) ? message : "", constraint);
    if (classified) return classified;
  }

  // 6. Node system codes (connection layer) — never SQLSTATE-shaped
  if (isString(code)) {
    const classified = classifyNodeCode(code);
    if (classified) return classified;
  }

  // 7. Message shapes (SQLite/D1/pg-pool bare errors)
  if (isString(message)) {
    const classified = classifyMessage(message, constraint);
    if (classified) return classified;
  }

  return undefined;
};

/**
 * Classifies an unknown failure into a `DbError`, or — when no known protocol
 * shape matches — rethrows the original. `tryDb` classifies database
 * failures; anything else is not ours to label.
 */
type Classifiable = object;

export const classify = (cause: unknown): DbError => {
  const pending: unknown[] = [cause];
  const visited = new Set<object>();

  for (let inspected = 0; inspected < MAX_HOPS && pending.length > 0; inspected += 1) {
    const current = pending.shift();
    if (typeof current !== "object" || current === null) continue;
    if (visited.has(current)) continue;
    visited.add(current);

    const classified = classifyNode(current);
    if (classified) return classified;

    pending.push(...SLOTS.map((slot) => get(current, slot)));
  }

  throw cause; // Variant B: not ours to label
};
