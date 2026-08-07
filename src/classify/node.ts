import { ConnectFailure, ConnectionLost, mark, transient, type DbError } from "../tags.js";
import { SAFE_CONNECT_CODES, AMBIGUOUS_CONNECT_CODES, TLS_CODES_RE } from "./helpers.js";

export const classifyNodeCode = (code: string): DbError | undefined => {
  if (SAFE_CONNECT_CODES.has(code)) return mark(new ConnectFailure(transient), true);
  if (AMBIGUOUS_CONNECT_CODES.has(code)) return mark(new ConnectionLost(transient), false);
  if (TLS_CODES_RE.test(code)) return mark(new ConnectFailure({}), false);
  return undefined;
};
