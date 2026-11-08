/**
 * Did the provider refuse the *credential* a request carried?
 *
 * A credential minted by a `!command` has no trustworthy expiry a client can
 * read: a JWT's `exp` is a wall-clock instant, and a process has no trusted
 * wall clock. The provider, on the other hand, answers the question exactly —
 * with a 401. This module reads that answer.
 *
 * **The signal is the provider's own structured error class, not its prose.**
 * An error body's `type`/`code` is a contract; its `message` is wording that
 * changes. Measured 2026-11-08 against Theorem's model gateway (a LiteLLM
 * proxy) with a locally minted junk token, on `/v1/models`, `/v1/messages`,
 * `/v1/chat/completions` and `/v1/responses` alike:
 *
 * ```json
 * {"error":{"message":"…","type":"auth_error","param":"Authorization","code":"401"}}
 * ```
 *
 * Every refusal carried `type=auth_error` and `code=401`; the `message`
 * differed per sub-reason ("This identity token is signed by no key Google
 * publishes." for a bad signature, "This identity token is not one this
 * gateway accepts" for one past its `exp`, "Authentication Error, No api key
 * passed in." with no bearer at all). A non-auth failure on the same host (404
 * on an unknown route) carried no `error.type` at all, so the match stays
 * narrow.
 *
 * By the time a failure reaches the auth-retry driver the body has been
 * flattened into a message string, in one of two renderings this module reads:
 *
 * - `401 {"error":{"message":…,"type":…,"code":…}}` — the raw body, which the
 *   Anthropic-wire provider keeps verbatim.
 * - `401 … (type=auth_error param=Authorization code=401)` — the fields
 *   re-rendered by `formatCapturedHttpErrorParts` for the OpenAI wires.
 *
 * Prose is consulted only when neither rendering yields a class.
 */
import { extractHttpStatusFromError, isRecord } from "@oh-my-pi/pi-utils";

/**
 * What a failed request says about the credential it carried.
 *
 * - `structured` — a 401 whose own error class names an authentication
 *   failure. The primary signal.
 * - `text` — a 401 with no readable error class whose message is one of the
 *   documented credential refusals. Fallback only.
 * - `status` — a 401 with nothing else to read. HTTP's own meaning, and what
 *   omp acted on before the structured signal existed.
 * - `not-credential` — a 401 whose own error class says it is *not* an
 *   authentication failure. The only verdict that withholds a re-mint, since
 *   re-minting cannot help and a `!command` credential's re-mint is a call to
 *   its issuer.
 * - `unclassified` — not a 401 at all. This module has nothing to say about
 *   the credential, and a caller keeps whatever policy it had.
 */
export type CredentialVerdict = "structured" | "text" | "status" | "not-credential" | "unclassified";

/**
 * `type` values that name an authentication failure. `auth_error` is LiteLLM's
 * (and therefore Theorem's model gateway's); the rest are the spellings the
 * other wires omp speaks use.
 */
const AUTH_ERROR_TYPES: Record<string, true> = {
	auth_error: true,
	authentication_error: true,
	invalid_authentication: true,
	invalid_api_key: true,
	unauthenticated: true,
	unauthorized: true,
};

/**
 * `code` values that name an authentication failure. OpenAI reports a rejected
 * key as `type=invalid_request_error` with `code=invalid_api_key`, so the code
 * has to qualify a body on its own; LiteLLM sends the bare status as the code.
 */
const AUTH_ERROR_CODES: Record<string, true> = {
	"401": true,
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
 * Documented credential refusals, used only when a 401 carries no error class.
 * Each is a measured or provider-documented wording, never a guess — and the
 * length of this list is itself why the structured class above is the primary
 * signal: one gateway has four spellings for one condition.
 */
const CREDENTIAL_REFUSAL_TEXT: readonly RegExp[] = [
	// Theorem's model gateway, identity-token hook (agent-infra
	// `model-gateway/vm/ossv_box_auth.py`): "This identity token is signed by no
	// key Google publishes." (measured) and "This identity token is not one this
	// gateway accepts" (its owner's wording for one past its `exp`).
	/\bthis identity token\b/i,
	// PyJWT's own expiry message, which that hook passes through.
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
 * for the OpenAI wires. The last occurrence wins: a provider's own message can
 * carry an earlier one, and the transport appends its own at the end.
 *
 * `param` is read as a candidate code only when no `code` is present. Before
 * this module existed that renderer labelled fields by position after dropping
 * the absent ones, so an OpenAI rejected key arrived as
 * `(type=invalid_request_error param=invalid_api_key)`; the renderer is fixed,
 * and a message rendered by an older build still classifies. Only a value in
 * the auth table qualifies, so an ordinary `param=Authorization` says nothing.
 */
const RENDERED_TYPE = /\btype=([^\s)]+)/g;
const RENDERED_PARAM = /\bparam=([^\s)]+)/g;
const RENDERED_CODE = /\bcode=([^\s)]+)/g;

function lastMatch(pattern: RegExp, message: string): string | undefined {
	pattern.lastIndex = 0;
	let found: string | undefined;
	for (let match = pattern.exec(message); match !== null; match = pattern.exec(message)) found = match[1];
	return found;
}

/** Read the error class out of the re-rendered `(type=… code=…)` suffix. */
function readErrorClassFromRendering(message: string): ErrorClass | undefined {
	const type = lastMatch(RENDERED_TYPE, message);
	const code = lastMatch(RENDERED_CODE, message) ?? lastMatch(RENDERED_PARAM, message);
	if (type === undefined && code === undefined) return undefined;
	return { type, code };
}

function namesAuthFailure({ type, code }: ErrorClass): boolean {
	return (
		(type !== undefined && AUTH_ERROR_TYPES[type.toLowerCase()] === true) ||
		(code !== undefined && AUTH_ERROR_CODES[code.toLowerCase()] === true)
	);
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
	if (errorStatus(error) !== 401) return "unclassified";
	const onObject = readErrorClassFromObject(error);
	if (onObject && namesAuthFailure(onObject)) return "structured";
	const message = errorText(error);
	if (message === undefined) return "status";
	const errorClass = readErrorClassFromJson(message) ?? readErrorClassFromRendering(message);
	if (errorClass) return namesAuthFailure(errorClass) ? "structured" : "not-credential";
	return CREDENTIAL_REFUSAL_TEXT.some(pattern => pattern.test(message)) ? "text" : "status";
}

/**
 * Whether the provider refused the credential the request carried. False for
 * a failure that is not a 401, and for a 401 whose own error class says it is
 * not an authentication failure.
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
