/**
 * In-band provider failures: upstream 429/5xx payloads that arrive inside an
 * HTTP 200 response body, or mid-stream after the SSE headers were already sent.
 *
 * Providers that front a retry/queue layer — Azure OpenAI, LiteLLM-style
 * aggregators, Bedrock-compatible shims — answer a throttled request with
 * `200 OK` + `text/event-stream` and put the real status in the payload:
 * `data: {"error":{"type":"rate_limit_error"}}`, `data: {"code":429}`, or a bare
 * non-JSON frame such as `data: 429 Too Many Requests` / an nginx throttle page.
 * Those bodies used to be either dropped silently (the stream then looked like a
 * successful empty completion) or surfaced as an unclassified
 * {@link ProviderResponseError} whose `errorId` stayed 0 — so `AIError.retriable`
 * answered "terminal" and `retry.fallbackChains` never advanced, pinning the
 * session on a provider that was merely busy.
 *
 * Both probes hand the classifier the structured signal it already trusts for an
 * out-of-band failure: a {@link ProviderHttpError} carrying a status the upstream
 * *reported*, so the two routes reach one code path. The invariants that make
 * that safe, and that callers rely on:
 *
 *  - **No invented HTTP metadata.** A status is taken only from an error
 *    `status`/`code` *field* (numeric, or a 3-digit string as compat hosts send)
 *    or from {@link RETRYABLE_STATUS_BY_CODE}, and only for `429`/`5xx`. A status
 *    mentioned inside error prose is never promoted to a status: 401/403 wording
 *    stays text and cannot route the failure into the auth-retry lane.
 *  - **No credential rotation on an unreadable body.** A `429` whose body is
 *    empty, `{}`, or framing-only is opaque, and an opaque 429 is the conservative
 *    rotate-to-a-sibling-credential signal. That verdict belongs to a body the
 *    server actually sent, not to a payload we synthesised, so
 *    {@link formatInBandMessage} substitutes {@link IN_BAND_DETAIL_PLACEHOLDER}
 *    and the composed message always stays informative.
 *  - **Unknown envelopes fall through.** Anything without a retryable status
 *    field, a retryable code, or unambiguous throttle wording returns
 *    `undefined` and keeps its pre-existing handling and message.
 *
 * Where no numeric status exists, the returned error keeps the upstream wording
 * and code visible in its message instead of asserting HTTP metadata the provider
 * never sent, and carries {@link Flag.Transient} directly: throttle spellings like
 * `Throttled` / `Please retry` are what this probe recognises but the transport
 * text pattern is not required to match, so the retry decision is stated rather
 * than hoped for.
 */
import { ProviderHttpError } from "./classes";
import { attach, create, Flag } from "./flags";
import { isOpaqueStatusBody } from "./rate-limit";
import { ProviderResponseError } from "./provider";

/** Cap on synthesized message length, mirroring the transport-level `MAX_DETAIL_CHARS`. */
const MAX_IN_BAND_DETAIL_CHARS = 4096;

/**
 * Filler used when an in-band failure frame carries no readable detail. It has
 * to be informative prose on purpose: an opaque message on a `429` is read as
 * "the server gave us nothing" and rotates a credential, and that judgement must
 * never be triggered by wording of ours.
 */
const IN_BAND_DETAIL_PLACEHOLDER = "Provider returned an in-band provider error";

/**
 * Machine error codes that mean "shed this request and back off", mapped to the
 * HTTP status the upstream would have used had it not wrapped the failure in a
 * 200. Keys are compared after lower-casing, splitting camel/Pascal word
 * boundaries, and collapsing `_`/`-`/`.`/spaces, so `Throttling.AllocationQuota`
 * and `ThrottlingAllocationQuota` both resolve. The list is deliberately limited
 * to throttle/overload spellings so an unlisted code keeps its pre-existing
 * classification: request-validation failures (`invalid_request_error`) and
 * account caps (`insufficient_quota`, `usage_limit_reached`) are never
 * reinterpreted as retries.
 */
const RETRYABLE_STATUS_BY_CODE: Record<string, number> = {
	rate_limit_error: 429,
	rate_limit_exceeded: 429,
	rate_limit: 429,
	rate_limit_reached: 429,
	rate_limited: 429,
	ratelimit: 429,
	too_many_requests: 429,
	request_throttled: 429,
	throttled: 429,
	throttling: 429,
	throttling_error: 429,
	throttling_exception: 429,
	throttling_allocation_quota: 429,
	request_limit_exceeded: 429,
	retry_later: 429,
	overloaded_error: 503,
	server_overloaded: 503,
	model_overloaded: 503,
	overloaded: 503,
	service_unavailable: 503,
	server_busy: 503,
	high_demand: 503,
	capacity_exceeded: 503,
};

/**
 * Wording that identifies a throttle/overload in an error code or body. Kept as
 * an explicit list rather than reusing the classifier's pattern, so this probe
 * stays independent of the text rules it feeds.
 */
const IN_BAND_RETRYABLE_TEXT_PATTERN =
	/\brate.?limit|too many requests|too\s+many\s+concurren|service.{0,20}unavailable|temporarily\s+unavailable|server.?error|internal.?error|overloaded|capacity|throttl|retry\s+(?:your\s+)?request|please\s+retry/i;

/**
 * A status in the position a proxy error page puts it: the very first token,
 * optionally after an `HTTP/1.1 ` prefix. Delimited by a non-digit so
 * identifiers (`chatcmpl-500321`, `gpt-500x`, `req500502`) cannot fabricate a
 * status — the same hazard `error-transient-status-boundary.test.ts` guards.
 * Prose that merely *mentions* a number (`Too many requests (401 from …)`) is
 * deliberately not read as status metadata.
 */
const LEADING_STATUS_PATTERN = /^\s*(?:HTTP[/.]\d(?:\.\d)?\s+)?([45]\d{2})(?:\D|$)/i;

/** Codes that mean a persistent account/billing cap or a bad request; never shed-and-retry. */
const NON_RETRYABLE_CODE_PATTERN =
	/insufficient.?quota|usage.?limit|quota.?(?:exceeded|reached|insufficient)|invalid_request|content_filter|context_length|context_window|billing|balance/i;

/** Flags this module asserts for a body it has itself recognised as shed-and-retry. */
const IN_BAND_FLAGS = create(Flag.Transient);

function normalizeCodeToken(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value !== "string") return undefined;
	const spaced = value.trim().replace(/([a-z0-9])([A-Z])/g, "$1_$2");
	const collapsed = spaced
		.toLowerCase()
		.replace(/[-.\s]+/g, "_")
		.replace(/_+/g, "_");
	return collapsed.length > 0 ? collapsed : undefined;
}

function readInBandDetail(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	// SSE joins multi-line `data:` values with `\n`, and proxy failures arrive as
	// HTML: flatten to one line of visible text so a synthesized message cannot
	// smuggle markup or framing into the classifier or the terminal.
	const flattened = value
		.replace(/<[^>]*>/g, " ")
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (flattened.length === 0) return undefined;
	return flattened.length > MAX_IN_BAND_DETAIL_CHARS ? flattened.slice(0, MAX_IN_BAND_DETAIL_CHARS) : flattened;
}

/** A numeric HTTP status field, accepting the `"429"` string form compat hosts emit. */
function readStatusField(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) return value;
	if (typeof value === "string" && /^\d{3}$/.test(value.trim())) {
		const parsed = Number(value.trim());
		return Number.isInteger(parsed) && parsed >= 100 && parsed <= 599 ? parsed : undefined;
	}
	return undefined;
}

/** Only `429` and genuine server faults are shed-and-retry; 4xx of any other kind is not. */
function isRetryableStatus(status: number | undefined): status is number {
	return status === 429 || (status !== undefined && status >= 500 && status <= 599);
}

function readLeadingStatus(text: string | undefined): number | undefined {
	if (text === undefined) return undefined;
	const match = LEADING_STATUS_PATTERN.exec(text);
	return match?.[1] ? Number(match[1]) : undefined;
}

interface InBandSignal {
	/** Numeric HTTP status the upstream reported, or implied by its error code. */
	status?: number;
	/** Machine code from the body (`error.code` preferred over `error.type`). */
	code?: string;
	/** Human-readable detail from the body. */
	detail?: string;
}

/**
 * Pull the failure signal out of an OpenAI-wire frame. Accepts the nested
 * `{ error: { code, type, status, message } }` shape, the `response.error`
 * position of Responses-API terminal events, the flat `{ code, status, message }`
 * bodies compat hosts emit, and string envelopes (`{ error: "..." }`).
 *
 * `undefined` means "not an in-band failure worth retrying". The probe is
 * intentionally narrow: a bare `type` is present on every Responses event and so
 * never counts as a signal by itself, statuses come only from fields (never from
 * prose), and a frame with neither a retryable status nor throttle wording is
 * left to the caller's existing handling.
 */
function readInBandSignal(frame: unknown): InBandSignal | undefined {
	if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return undefined;
	const root = frame as Record<string, unknown>;
	const nested = root.error ?? (root.response as Record<string, unknown> | undefined)?.error;
	// Azure-compatible gates double-wrap (`{ error: { error: { code, message } } }`).
	// Walk at most two levels so a deep payload cannot extend the parse.
	let error: Record<string, unknown> | undefined;
	if (typeof nested === "object" && nested !== null) {
		error = nested as Record<string, unknown>;
		for (let depth = 0; depth < 2; depth++) {
			const inner = error.error;
			if (typeof inner !== "object" || inner === null) break;
			error = inner as Record<string, unknown>;
		}
	}
	const code = normalizeCodeToken(error?.code ?? root.code) ?? normalizeCodeToken(error?.type ?? root.type);
	if (code !== undefined && NON_RETRYABLE_CODE_PATTERN.test(code)) return undefined;
	// A flat retryable code/type is itself an in-band failure: Responses-API
	// `error` events expose `{ type: "rate_limit_error" }` with no `error` member,
	// and their handler passes the inner error object (not the whole event).
	const retryableCode = code !== undefined && IN_BAND_RETRYABLE_TEXT_PATTERN.test(code);
	// Only an explicit error member, a top-level status/code/message field, or a
	// standalone throttle type can qualify a frame as a failure; ordinary chunks
	// carry none of these. A bare `type` is present on every Responses event, so
	// it only counts when it is itself retryable wording.
	if (
		!retryableCode &&
		nested === undefined &&
		root.status === undefined &&
		root.code === undefined &&
		root.message === undefined
	) {
		return undefined;
	}
	const detail =
		readInBandDetail(error?.message) ??
		readInBandDetail(root.message) ??
		(typeof nested === "string" ? readInBandDetail(nested) : undefined);
	const holder = error ?? root;
	// Reported statuses come from fields only: the error member's `status`, its
	// numeric `code`, then the same on the root (the flat `{ code: 429 }` /
	// `{ status: 429 }` bodies compat hosts emit). Anything outside 429/5xx is
	// ignored outright — an in-band `400`/`401`/`403` field must not become a
	// synthetic HTTP contract, or a body that merely names an auth problem would
	// route into the credential lane.
	const reported = holder === root ? [root.status, root.code] : [holder.status, holder.code, root.status, root.code];
	const status =
		reported.map(readStatusField).find(isRetryableStatus) ??
		(code !== undefined && Object.hasOwn(RETRYABLE_STATUS_BY_CODE, code)
			? readStatusField(RETRYABLE_STATUS_BY_CODE[code])
			: undefined);
	if (status !== undefined) return { status, code, detail };
	// No reported status: classify only when the upstream *message* is itself
	// unambiguous throttle wording. A generic code alone must not qualify —
	// Azure uses `server_error` for terminal backend failures whose
	// `"<code>: <message>"` envelope the caller already reports (and whose text
	// the shared transient rule already matches), so intercepting it would
	// change an established error format without adding retry information.
	if (detail === undefined || !IN_BAND_RETRYABLE_TEXT_PATTERN.test(detail)) return undefined;
	return { code, detail };
}

/**
 * Compose the message for a status-bearing in-band failure. The numeric status
 * leads (matching `captureOpenAIHttpError`'s `"<status> <detail>"` phrasing)
 * unless the detail already carries it as its leading token; the machine code is
 * appended only when it adds information the text classifier or a human reader
 * can use. A detail that leaves the whole line opaque is replaced by the
 * placeholder, so a body we generated can never be read as "the server said
 * nothing".
 */
function formatInBandMessage(status: number, detail: string | undefined, code: string | undefined): string {
	const body = detail ?? IN_BAND_DETAIL_PLACEHOLDER;
	const suffix =
		code !== undefined && !/^\d+$/.test(code) && !body.toLowerCase().includes(code.toLowerCase()) ? ` (${code})` : "";
	let message = readLeadingStatus(body) === status ? body : `${status} ${body}`;
	if (isOpaqueStatusBody(message)) message = `${status} ${IN_BAND_DETAIL_PLACEHOLDER}`;
	return `${message}${suffix}`;
}

/**
 * Build the classified error for an in-band failure frame, or `undefined` when
 * the frame is not a retryable in-band failure (in which case the caller keeps
 * its existing handling and message).
 *
 * @param frame decoded SSE `data:` payload, or the `{ error, response }` subset of one
 */
export function createInBandProviderError(frame: unknown): Error | undefined {
	const signal = readInBandSignal(frame);
	if (!signal) return undefined;
	const { status, code, detail } = signal;
	if (isRetryableStatus(status)) {
		return attach(new ProviderHttpError(formatInBandMessage(status, detail, code), status, { code }), IN_BAND_FLAGS);
	}
	if (detail === undefined && code === undefined) return undefined;
	// Keep the upstream code visible (`(<code>)`) — it is real provider data and
	// the same convention the Anthropic provider already uses for its
	// `(<errorType>)` suffix.
	return attach(
		new ProviderResponseError(`${detail ?? IN_BAND_DETAIL_PLACEHOLDER}${code ? ` (${code})` : ""}`, {
			kind: "runtime",
		}),
		IN_BAND_FLAGS,
	);
}

/**
 * Build the classified error for a non-JSON SSE frame: gateways and reverse
 * proxies that answer `data: 429 Too Many Requests` or an HTML throttle page
 * instead of an OpenAI envelope. `undefined` when the text is not recognisable
 * as a throttle, so genuinely malformed payloads keep failing loudly.
 */
export function createInBandProviderErrorFromText(text: string): Error | undefined {
	const detail = readInBandDetail(text);
	if (detail === undefined || !IN_BAND_RETRYABLE_TEXT_PATTERN.test(detail)) return undefined;
	const status = readLeadingStatus(detail);
	if (isRetryableStatus(status)) {
		return attach(new ProviderHttpError(formatInBandMessage(status, detail, undefined), status), IN_BAND_FLAGS);
	}
	// A proxy status line with no machine code to preserve: report the upstream
	// text verbatim rather than padding it with wording of ours.
	return attach(new ProviderResponseError(detail, { kind: "runtime" }), IN_BAND_FLAGS);
}
