/**
 * Did the provider refuse the *credential* a request carried?
 *
 * This is a **refreshable-failure** signal, not expiry prediction. A qualifying
 * 401 (structured class, existing prose fallback, or bare status) establishes
 * that the credential was refused. A 403 does so only with an explicit expiry
 * signal; permission-only 403s never condemn a credential. The caller records
 * the refused generation as a watermark: never send it or an older generation
 * again. Send a prepared generation above the watermark; otherwise use or join
 * a newer mint, or obtain one. Only failure to obtain usable authentication is
 * an error, not the mere absence of a cached replacement. No clock or JWT claim
 * predicts any of this: a command credential has no trusted client-side expiry.
 *
 * The primary signal is the provider's structured error class (`type`/`code`),
 * not its message wording. The supported classes and their sources are below.
 *
 * By the time a failure reaches the auth-retry driver the body has been
 * flattened into a message string, in one of two renderings this module reads:
 *
 * - `401 {"error":{"message":…,"type":…,"code":…}}` — the raw body, which the
 *   Anthropic-wire provider keeps verbatim.
 * - `401 … (type=auth_error param=Authorization code=401)` — the fields
 *   re-rendered by `formatCapturedHttpErrorParts` for the OpenAI wires.
 *
 * Prose is consulted only when neither rendering yields a class, and the
 * transport's own rendering outranks any JSON embedded in the provider's
 * prose: a provider puts an object inside its message text, and that object
 * is not the envelope the transport rendered.
 */
import { extractHttpStatusFromError, isRecord } from "@oh-my-pi/pi-utils";

/**
 * What a failed request says about the credential it carried.
 *
 * - `structured` — a 401 whose class names a credential refusal, or a 403
 *   with an explicit credential-expiry class. The primary signal.
 * - `text` — a 401 with no readable error class whose message matches
 *   recognized credential-refusal prose. Fallback only.
 * - `status` — a 401 with nothing else to read. HTTP's own meaning, and what
 *   omp acted on before the structured signal existed.
 * - `not-credential` — a 401 whose own error class says it is *not* an
 *   authentication failure. The only verdict that withholds a re-mint, since
 *   re-minting cannot help and a `!command` credential's re-mint is a call to
 *   its issuer.
 * - `unclassified` — neither a qualifying 401 nor an explicit-expiry 403.
 *   This module has nothing to say about the credential.
 */
export type CredentialVerdict = "structured" | "text" | "status" | "not-credential" | "unclassified";

/**
 * Credential-refusal types. LiteLLM emits `auth_error`, `token_not_found_in_db`
 * and `expired_key`: see `proxy/auth/auth_exception_handler.py`,
 * `proxy/auth/resolvers/exceptions.py` and `proxy/auth/user_api_key_auth.py` at
 * BerriAI/litellm 43112547fb9c0a8d482f4fe031e09a6c2cc234e1. Anthropic documents
 * `authentication_error` at https://platform.claude.com/docs/en/api/errors.
 * The remaining compatibility spellings predate this classification update.
 */
const AUTH_ERROR_TYPES: Record<string, true> = {
	auth_error: true,
	token_not_found_in_db: true,
	expired_key: true,
	authentication_error: true,
	invalid_authentication: true,
	invalid_api_key: true,
	unauthenticated: true,
	unauthorized: true,
};

/**
 * `code` values that name an authentication failure. OpenAI reports a rejected
 * key as `type=invalid_request_error` with `code=invalid_api_key`, so the code
 * has to qualify a body on its own.
 */
const AUTH_ERROR_CODES: Record<string, true> = {
	authentication_error: true,
	auth_error: true,
	invalid_api_key: true,
	invalid_authentication: true,
	invalid_token: true,
	token_expired: true,
	expired_token: true,
	unauthenticated: true,
	unauthorized: true,
};

/**
 * Codes that only restate the HTTP status. LiteLLM's `code=401` adds nothing
 * to the status: it must not override an explicit policy failure. Its actual
 * credential-refusal types (`token_not_found_in_db` included) qualify above.
 */
const BARE_STATUS_CODES: Record<string, true> = { "401": true };

/**
 * Credential-refusal prose, used only when a 401 carries no readable error class.
 * Structured classes take precedence over these wording-specific fallbacks.
 */
const CREDENTIAL_REFUSAL_TEXT: readonly RegExp[] = [
	// Recognize "This identity token ..." in classless 401 responses. The text
	// verdict allows static credentials to retry even though their generation
	// cannot advance; a status-only verdict would suppress that retry.
	/\bthis identity token\b/i,
	// PyJWT's expiry message.
	/\bsignature has expired\b/i,
	// LiteLLM's two generic refusals: no usable key reached the proxy at all,
	// and a bearer that is not one it recognises.
	/\bauthentication error\b/i,
	/\bvirtual key expected\b/i,
	// The plain statements of the same condition on other providers.
	/\binvalid[ _-]?api[ _-]?key\b/i,
	/\b(?:token|credential|session)\b[^.\n]{0,40}\bexpired\b/i,
	/\bexpired\b[^.\n]{0,40}\b(?:token|credential|session)\b/i,
];

/** Explicit expiry classes, unlike the permission-only `auth_error` 403. */
const CREDENTIAL_EXPIRY_CLASSES: Record<string, true> = {
	expired_token: true,
	token_expired: true,
	expired_key: true,
};

function namesCredentialExpiry({ type, code }: ErrorClass): boolean {
	return (
		(type !== undefined && CREDENTIAL_EXPIRY_CLASSES[type.toLowerCase()] === true) ||
		(code !== undefined && CREDENTIAL_EXPIRY_CLASSES[code.toLowerCase()] === true)
	);
}

/** The structured error class a provider reported, as far as it is readable. */
interface ErrorClass {
	type?: string;
	code?: string;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	if (typeof value === "string") return value;
	// LiteLLM sends `code` as a string, but a compat host may send the number.
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return undefined;
}

/**
 * Index just past the JSON object that starts at `start`, or `undefined` when
 * the text holds no balanced object there. Scanning rather than parsing the
 * whole tail lets a body survive whatever the transport appended after it.
 */
function endOfJsonObject(text: string, start: number): number | undefined {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return undefined;
}

/** How many `{` positions in one message are tried as the start of an envelope. */
const ENVELOPE_CANDIDATES = 8;

/**
 * Read the error class out of a JSON error envelope embedded in the message.
 *
 * Only an envelope counts: an object with an `error` member. A provider puts
 * JSON inside its own message text (`… failed for claims {"type":"id_token"}`),
 * and that object must never outrank the envelope the transport rendered.
 * Candidate `{` positions are tried in turn, so prose that is not valid JSON
 * does not hide the body behind it, and the count is capped because each
 * candidate costs a scan of the rest of the message.
 */
function readErrorClassFromJson(message: string): ErrorClass | undefined {
	let start = message.indexOf("{");
	for (let tried = 0; start >= 0 && tried < ENVELOPE_CANDIDATES; tried++, start = message.indexOf("{", start + 1)) {
		const end = endOfJsonObject(message, start);
		if (end === undefined) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(message.slice(start, end));
		} catch {
			continue;
		}
		if (!isRecord(parsed) || !("error" in parsed)) continue;
		const nested = isRecord(parsed.error) ? parsed.error : undefined;
		const type = (nested && readString(nested, "type")) ?? readString(parsed, "type");
		const code = (nested && readString(nested, "code")) ?? readString(parsed, "code");
		if (type === undefined && code === undefined) continue;
		return { type, code };
	}
	return undefined;
}

/**
 * `(type=… param=… code=…)`, the form `formatCapturedHttpErrorParts` renders
 * for the OpenAI wires and `withSuffix` appends at the end of the message.
 * The last such group wins: a provider's own message can carry an earlier one,
 * and the transport appends its own after it. Only a parenthesised group
 * counts, so prose that merely contains `type=` is not mistaken for the
 * transport's class.
 *
 * `param` is read as a candidate code only when no `code` is present. Before
 * this module existed that renderer labelled fields by position after dropping
 * the absent ones, so an OpenAI rejected key arrived as
 * `(type=invalid_request_error param=invalid_api_key)`; the renderer is fixed,
 * and a message rendered by an older build still classifies. Only a value in
 * the auth table qualifies, so an ordinary `param=Authorization` says nothing.
 */
const RENDERED_GROUP = /\(([^()]*)\)/g;
const RENDERED_TYPE = /\btype=([^\s)]+)/g;
const RENDERED_PARAM = /\bparam=([^\s)]+)/g;
const RENDERED_CODE = /\bcode=([^\s)]+)/g;

function lastMatch(pattern: RegExp, message: string): string | undefined {
	pattern.lastIndex = 0;
	let found: string | undefined;
	for (let match = pattern.exec(message); match !== null; match = pattern.exec(message)) found = match[1];
	return found;
}

/** The content of the last parenthesised group that carries a rendered field. */
function lastRenderedGroup(message: string): string | undefined {
	RENDERED_GROUP.lastIndex = 0;
	let found: string | undefined;
	for (let match = RENDERED_GROUP.exec(message); match !== null; match = RENDERED_GROUP.exec(message)) {
		const group = match[1];
		if (group !== undefined && /\b(?:type|param|code)=/.test(group)) found = group;
	}
	return found;
}

/** Read the error class out of the re-rendered `(type=… code=…)` suffix. */
function readErrorClassFromRendering(message: string): ErrorClass | undefined {
	const group = lastRenderedGroup(message);
	if (group === undefined) return undefined;
	const type = lastMatch(RENDERED_TYPE, group);
	const code = lastMatch(RENDERED_CODE, group) ?? lastMatch(RENDERED_PARAM, group);
	if (type === undefined && code === undefined) return undefined;
	return { type, code };
}

/**
 * Whether an error class names an authentication failure.
 *
 * A `code` qualifies a body on its own only when it names a class of its own.
 * A code that merely restates the status does not override a `type` the body
 * did state: the provider named the failure, and a differing name is its
 * answer, not noise to be talked over.
 */
function namesAuthFailure({ type, code }: ErrorClass): boolean {
	if (type !== undefined && AUTH_ERROR_TYPES[type.toLowerCase()] === true) return true;
	if (code === undefined) return false;
	const normalized = code.toLowerCase();
	if (AUTH_ERROR_CODES[normalized] === true) return true;
	return type === undefined && BARE_STATUS_CODES[normalized] === true;
}

/**
 * The class carried on the error object itself. `ProviderHttpError` keeps the
 * provider's machine code there, and the Codex decoder keeps it when it
 * reduces the message to prose.
 *
 * Read only to *qualify* a 401, never to disqualify one: plenty of error
 * objects carry a `code` that has nothing to do with a credential, and
 * withholding a re-mint on one of those is the failure this signal exists to
 * avoid.
 */
function readErrorClassFromObject(error: unknown): ErrorClass | undefined {
	if (!isRecord(error)) return undefined;
	const type = readString(error, "type");
	const code = readString(error, "code");
	if (type === undefined && code === undefined) return undefined;
	return { type, code };
}

/** The message a failure carries, from an `Error`, a string, or an assistant-message shape. */
function errorText(error: unknown): string | undefined {
	if (typeof error === "string") return error;
	if (error instanceof Error) return error.message;
	if (isRecord(error) && typeof error.errorMessage === "string") return error.errorMessage;
	return undefined;
}

/** The HTTP status a failure carries, including the assistant-message `errorStatus` form. */
function errorStatus(error: unknown): number | undefined {
	const status = extractHttpStatusFromError(error);
	if (status !== undefined) return status;
	if (isRecord(error) && typeof error.errorStatus === "number") return error.errorStatus;
	const message = errorText(error);
	return message === undefined ? undefined : extractHttpStatusFromError({ message });
}

/**
 * Classify what a failed request says about the credential it carried. See
 * {@link CredentialVerdict}; the module doc has the measurements behind it.
 */
export function credentialRejectionVerdict(error: unknown): CredentialVerdict {
	const status = errorStatus(error);
	if (status !== 401 && status !== 403) return "unclassified";
	const onObject = readErrorClassFromObject(error);
	if (status === 403) {
		const message = errorText(error);
		const errorClass =
			message === undefined ? undefined : (readErrorClassFromRendering(message) ?? readErrorClassFromJson(message));
		return (onObject && namesCredentialExpiry(onObject)) || (errorClass && namesCredentialExpiry(errorClass))
			? "structured"
			: "unclassified";
	}
	if (onObject && namesAuthFailure(onObject)) return "structured";
	const message = errorText(error);
	if (message === undefined) return "status";
	const errorClass = readErrorClassFromRendering(message) ?? readErrorClassFromJson(message);
	if (errorClass) return namesAuthFailure(errorClass) ? "structured" : "not-credential";
	return CREDENTIAL_REFUSAL_TEXT.some(pattern => pattern.test(message)) ? "text" : "status";
}

/**
 * Whether the provider refused the credential the request carried. False for
 * a failure other than a qualifying 401 or explicit-expiry 403, and for a 401
 * whose own error class says it is not an authentication failure.
 */
export function isCredentialRejection(error: unknown): boolean {
	const verdict = credentialRejectionVerdict(error);
	return verdict === "structured" || verdict === "text" || verdict === "status";
}

/**
 * Whether the provider *said* the credential was refused — structurally, or in
 * one of the documented wordings. Stronger than {@link isCredentialRejection}:
 * a bare 401 with an unreadable body does not qualify.
 */
export function statesCredentialRejection(error: unknown): boolean {
	const verdict = credentialRejectionVerdict(error);
	return verdict === "structured" || verdict === "text";
}
