import { Result, TaggedError } from "better-result";

//#region src/db-result.ts
const transient = { potentiallyTransient: true };
var UniqueViolation = class extends TaggedError("db/unique-violation") {};
var ForeignKeyViolation = class extends TaggedError("db/foreign-key-violation") {};
var NotNullViolation = class extends TaggedError("db/not-null-violation") {};
var CheckViolation = class extends TaggedError("db/check-violation") {};
var ConnectionFailure = class extends TaggedError("db/connection-failure") {};
var AuthenticationFailed = class extends TaggedError("db/authentication-failed") {};
var AuthorizationFailed = class extends TaggedError("db/authorization-failed") {};
var SqlSyntaxError = class extends TaggedError("db/sql-syntax-error") {};
var QueryFailure = class extends TaggedError("db/query-failure") {};
const tagOf = (e) => {
	if (typeof e !== "object" || e === null) return void 0;
	const tag = Reflect.get(e, "_tag");
	return typeof tag === "string" ? tag : void 0;
};
const isUniqueViolation = (e) => tagOf(e) === "db/unique-violation";
const isForeignKeyViolation = (e) => tagOf(e) === "db/foreign-key-violation";
const isNotNullViolation = (e) => tagOf(e) === "db/not-null-violation";
const isCheckViolation = (e) => tagOf(e) === "db/check-violation";
const isConnectionFailure = (e) => tagOf(e) === "db/connection-failure";
const isAuthenticationFailed = (e) => tagOf(e) === "db/authentication-failed";
const isAuthorizationFailed = (e) => tagOf(e) === "db/authorization-failed";
const isSqlSyntaxError = (e) => tagOf(e) === "db/sql-syntax-error";
const isQueryFailure = (e) => tagOf(e) === "db/query-failure";
const DEFAULT_CONSTRAINT = "unknown";
const MAX_HOPS = 16;
const SLOTS = [
	"cause",
	"failure",
	"error",
	"defect"
];
/** Only 5-char alphanumeric codes count as SQLSTATE. */
const SQLSTATE_RE = /^[0-9A-Z]{5}$/;
/** Node system-error codes that mean the connection layer failed. */
const CONNECTION_CODES_RE = /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EHOSTDOWN|EPIPE|ECONNABORTED|EPROTO)$/;
/** TLS/crypto failure codes — connection realm, but not transient (config). */
const TLS_CODES_RE = /^(DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_HAS_EXPIRED|ERR_TLS_CERT_ALTNAME_INVALID|ERR_TLS_PROTOCOL_VERSION|ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED)$/;
/** Message markers that say "this is SQLite", so numeric errcodes count. */
const SQLITE_MESSAGE_RE = /constraint failed|database is locked|table is locked|is not a database|disk image is malformed|attempt to write a readonly database|malformed|no such (table|column|function)|database or disk is full|out of memory/i;
const isString = (v) => typeof v === "string";
const isNumber = (v) => typeof v === "number";
const get = (obj, key) => Reflect.get(obj, key);
/**
* Constraint name, taken from the driver's own field when present, else from
* the message text. Both stop at the constraint identifier and never run past
* it — a looser match could capture whatever the driver or ORM appended
* (including query parameters, which must never reach `data`).
*/
const constraintFrom = (node) => {
	const field = get(node, "constraint");
	if (isString(field) && field.trim().length > 0) return field.trim();
	const message = get(node, "message");
	if (!isString(message)) return DEFAULT_CONSTRAINT;
	const sqlite = /constraint failed: ([\w]+(?:\.[\w]+)+)(?:,\s*[\w]+(?:\.[\w]+)+)*/i.exec(message);
	if (sqlite?.[1]) return sqlite[1].trim();
	const pg = /constraint "([^"]+)"/.exec(message);
	return pg?.[1]?.trim() ?? DEFAULT_CONSTRAINT;
};
const classifySQLSTATE = (code, constraint) => {
	switch (code) {
		case "23505": return new UniqueViolation({ constraint });
		case "23503": return new ForeignKeyViolation({ constraint });
		case "23502": return new NotNullViolation({ constraint });
		case "23514": return new CheckViolation({ constraint });
		case "28P01":
		case "28000": return new AuthenticationFailed({});
		case "42501": return new AuthorizationFailed({});
	}
	if (code.startsWith("08")) return new ConnectionFailure(transient);
	if (code.startsWith("23")) return new QueryFailure({});
	if (code.startsWith("42")) return new SqlSyntaxError({});
	if (code === "40001" || code === "40P01" || code === "55P03" || code === "57014" || code === "53300") return new QueryFailure(transient);
	return new QueryFailure({});
};
const classifySqliteCodeString = (code, constraint) => {
	if (code.startsWith("SQLITE_CONSTRAINT_UNIQUE") || code.startsWith("SQLITE_CONSTRAINT_PRIMARYKEY")) return new UniqueViolation({ constraint });
	if (code.startsWith("SQLITE_CONSTRAINT_FOREIGNKEY")) return new ForeignKeyViolation({ constraint });
	if (code.startsWith("SQLITE_CONSTRAINT_NOTNULL")) return new NotNullViolation({ constraint });
	if (code.startsWith("SQLITE_CONSTRAINT_CHECK")) return new CheckViolation({ constraint });
	if (code.startsWith("SQLITE_CONSTRAINT")) return new QueryFailure({});
	if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")) return new QueryFailure(transient);
	if (code.startsWith("SQLITE_PERM") || code.startsWith("SQLITE_AUTH")) return new AuthorizationFailed({});
	if (code.startsWith("SQLITE_CANTOPEN")) return new ConnectionFailure({});
	if (code.startsWith("SQLITE_")) return new QueryFailure({});
	if (code.startsWith("CLIENT_NETWORK")) return new ConnectionFailure(transient);
	return void 0;
};
const classifySqliteNumeric = (n, constraint) => {
	switch (n) {
		case 2067:
		case 1555: return new UniqueViolation({ constraint });
		case 787: return new ForeignKeyViolation({ constraint });
		case 1299: return new NotNullViolation({ constraint });
		case 275: return new CheckViolation({ constraint });
		case 5:
		case 261:
		case 517:
		case 773:
		case 6: return new QueryFailure(transient);
		case 3:
		case 23: return new AuthorizationFailed({});
		case 14: return new ConnectionFailure({});
		default: return new QueryFailure({});
	}
};
const classifyNodeCode = (code) => {
	if (CONNECTION_CODES_RE.test(code)) return new ConnectionFailure(transient);
	if (TLS_CODES_RE.test(code)) return new ConnectionFailure({});
	return void 0;
};
/** SQLite / D1 message shapes, and the pg pool/client bare messages. */
const classifyMessage = (raw, constraint) => {
	const message = raw.replace(/^D1_ERROR:\s*/i, "");
	const d1 = /\(code (\d+) (SQLITE_[A-Z_]+)/i.exec(message);
	if (d1) {
		const classified = classifySqliteCodeString(d1[2], constraint);
		if (classified) return classified;
	}
	if (/^UNIQUE constraint failed:/i.test(message) || /^PRIMARY KEY constraint failed:/i.test(message)) return new UniqueViolation({ constraint });
	if (/^FOREIGN KEY constraint failed/i.test(message)) return new ForeignKeyViolation({ constraint });
	if (/^NOT NULL constraint failed:/i.test(message)) return new NotNullViolation({ constraint });
	if (/^CHECK constraint failed:/i.test(message)) return new CheckViolation({ constraint });
	if (/no such (table|column|function)/i.test(message)) return new SqlSyntaxError({});
	if (/database or disk is full|disk image is malformed|file is not a database|attempt to write a readonly database|out of memory|disk I\/O error|unable to open database file/i.test(message)) return new QueryFailure({});
	if (/timeout exceeded when trying to connect/i.test(message)) return new ConnectionFailure(transient);
	if (/Connection terminated unexpectedly/i.test(message)) return new ConnectionFailure(transient);
	if (/Connection terminated due to connection timeout/i.test(message)) return new ConnectionFailure(transient);
	if (/^Connection terminated$/i.test(message.trim())) return new ConnectionFailure(transient);
	if (/Client was closed and is not queryable/i.test(message)) return new ConnectionFailure({});
	if (/Client has encountered a connection error/i.test(message)) return new ConnectionFailure({});
	return void 0;
};
/** True when a node carries a SQLite-ish signal, so numeric codes count. */
const hasSqliteSignal = (node) => {
	const code = get(node, "code");
	const extended = get(node, "extendedCode");
	if (isString(code) && (code.startsWith("SQLITE") || code.startsWith("ERR_SQLITE"))) return true;
	if (isString(extended)) return true;
	const message = get(node, "message");
	return isString(message) && SQLITE_MESSAGE_RE.test(message);
};
const classifyNode = (node) => {
	const code = get(node, "code");
	const message = get(node, "message");
	const constraint = constraintFrom(node);
	if (isString(code) && SQLSTATE_RE.test(code)) return classifySQLSTATE(code, constraint);
	const extendedCode = get(node, "extendedCode");
	const sqliteCode = isString(extendedCode) ? extendedCode : isString(code) ? code : void 0;
	if (sqliteCode) {
		const classified = classifySqliteCodeString(sqliteCode, constraint);
		if (classified) return classified;
	}
	const errcode = get(node, "errcode");
	const rawCode = get(node, "rawCode");
	const numeric = isNumber(errcode) ? errcode : isNumber(rawCode) ? rawCode : isNumber(code) ? code : void 0;
	if (numeric !== void 0 && hasSqliteSignal(node)) {
		const classified = classifySqliteNumeric(numeric, constraint);
		if (classified) return classified;
	}
	if (isString(code)) {
		const classified = classifyNodeCode(code);
		if (classified) return classified;
	}
	if (isString(message)) {
		const classified = classifyMessage(message, constraint);
		if (classified) return classified;
	}
	return void 0;
};
/**
* Classifies an unknown failure into a `DbError`, or — when no known protocol
* shape matches — rethrows the original. `tryDb` classifies database
* failures; anything else is not ours to label.
*/
const classify = (cause) => {
	const pending = [cause];
	const visited = /* @__PURE__ */ new Set();
	for (let inspected = 0; inspected < MAX_HOPS && pending.length > 0; inspected += 1) {
		const current = pending.shift();
		if (typeof current !== "object" || current === null) continue;
		if (visited.has(current)) continue;
		visited.add(current);
		const classified = classifyNode(current);
		if (classified) return classified;
		pending.push(...SLOTS.map((slot) => get(current, slot)));
	}
	throw cause;
};
/** Attaches the original failure as a non-enumerable cause for observability. */
const withCause = (error, cause) => {
	try {
		Object.defineProperty(error, "cause", {
			value: cause,
			enumerable: false,
			writable: true,
			configurable: true
		});
	} catch {}
	return error;
};
/** Runs any database query and resolves the outcome as a thenable. */
const runDbQuery = (query) => typeof query === "function" ? query() : query;
/**
* Runs any database query and resolves the outcome as a `Result<T, DbError>`.
*
* Built on better-result's `Result.tryPromise`, so the config is the host
* library's `RetryConfig`: `{ signal?, retry: { times, delayMs, backoff,
* shouldRetry, jitter } }`. `shouldRetry` reads the `potentiallyTransient`
* hint — the transient realm (connection loss, deadlock, busy, timeouts) is
* handled by policy, never enumerated at every call site.
*
* Errors that match no known protocol shape are **rethrown** (as a `Panic` in
* `Result.gen` contexts) — they are not ours to label.
*/
const tryDb = async (query, config) => Result.tryPromise({
	try: () => Promise.resolve(runDbQuery(query)),
	catch: (cause) => withCause(classify(cause), cause)
}, config);

//#endregion
export { isAuthenticationFailed, isAuthorizationFailed, isCheckViolation, isConnectionFailure, isForeignKeyViolation, isNotNullViolation, isQueryFailure, isSqlSyntaxError, isUniqueViolation, tryDb };