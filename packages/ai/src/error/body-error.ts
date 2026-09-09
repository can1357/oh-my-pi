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
 * out-of-band failure: a {@link ProviderHttpError} carrying the status the
 * upstream *reported*, so the two routes reach one code path. `classify`'s
 * `ProviderHttpError` arm turns `429`/`>=500` into {@link Flag.Transient}, and
 * the credential-rotation lane stays untouched because an informative body fails
 * {@link isUsageLimitOutcome}'s opaque/quota tests.
 *
 * Where no numeric status exists, the returned error keeps the upstream wording
 * and code visible in its message instead of inventing HTTP metadata the
 * provider never sent — {@link isTransientErrorText} matches the throttle
 * phrasing, so the ladder still advances.
 */
import type { ProviderHttpError } from "./classes";
import { ProviderHttpError as HttpError } from "./classes";
import { ProviderResponseError } from "./provider";

/** Cap on synthesized message length, mirroring the transport-level `MAX_DETAIL_CHARS`. */
const MAX_IN_BAND_DETAIL_CHARS = 4096;

/**
 * Machine error codes that mean "shed this request and back off", mapped to the
 * HTTP status the upstream would have used had it not wrapped the failure in a
 * 200. Keys are compared after lower-casing and collapsing `_`/`-`/`.`/spaces,
 * and the list is deliberately limited to throttle/overload spellings so an
 * unlisted code keeps its pre-existing classification: request-validation
 * failures (`invalid_request_error`) and account caps (`insufficient_quota`,
 * `usage_limit_reached`) are never reinterpreted as retries.
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
	throttling_allocationquota: 429,
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
	/\brate.?limit|too many requests|too\s+many\s+concurren|service.?unavailable|server.?error|internal.?error|overloaded|capacity|throttl|retry\s+(?:your\s+)?request|please\s+retry/i;

/**
 * Standalone 4xx/5xx status token. Delimited on both sides by non-digits so
 * identifiers (`chatcmpl-500321`, `gpt-500x`, `req500502`) cannot fabricate a
 * status — the same hazard `error-transient-status-boundary.test.ts` guards.
 */
const STATUS_TOKEN_PATTERN = /(?:^|\D)([45]\d{2})(?:\D|$)/;

/** Codes that mean a persistent account/billing cap or a bad request; never shed-and-retry. */
const NON_RETRYABLE_CODE_PATTERN =
	/insufficient.?quota|usage.?limit|quota.?(?:exceeded|reached|insufficient)|invalid_request|content_filter|context_length|context_window|billing|balance/i;

function normalizeCodeToken(value: unknown): string | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value !== "string") return undefined;
	const collapsed = value.trim().toLowerCase().replace(/[-.\s]+/g, "_").replace(/_+/g, "_");
	return collapsed.length > 0 ? collapsed : undefined;
}

function readInBandDetail(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	return trimmed.length > MAX_IN_BAND_DETAIL_CHARS ? trimmed.slice(0, MAX_IN_BAND_DETAIL_CHARS) : trimmed;
}

/** First standalone 4xx/5xx token in error prose, or `undefined`. */
function readStatusToken(text: string | undefined): number | undefined {
	if (!text) return undefined;
	const match = STATUS_TOKEN_PATTERN.exec(text);
	return match?.[1] ? Number(match[1]) : undefined;
}

function isServerStatus(status: unknown): status is number {
	return typeof status === "number" && status >= 400 && status <= 599;
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
 * never counts as a signal by itself, status digits are read only from error
 * prose, and a frame with neither a resolvable status nor throttle wording is
 * left to the caller's existing handling.
 */
function readInBandSignal(frame: unknown): InBandSignal | undefined {
	if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return undefined;
	const root = frame as Record<string, unknown>;
	const nested = root.error ?? (root.response as Record<string, unknown> | undefined)?.error;
	const error = typeof nested === "object" && nested !== null ? (nested as Record<string, unknown>) : undefined;
	const holder = error ?? root;
	const code = normalizeCodeToken(holder.code ?? root.code) ?? normalizeCodeToken(holder.type ?? root.type);
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
		readInBandDetail(holder.message) ??
		readInBandDetail(root.message) ??
		(typeof nested === "string" ? readInBandDetail(nested) : undefined);
	const reportedStatus = isServerStatus(holder.status)
		? holder.status
		: isServerStatus(holder.code)
			? holder.code
			: isServerStatus(root.status)
				? root.status
				: undefined;
	const status = reportedStatus ?? (code !== undefined ? RETRYABLE_STATUS_BY_CODE[code] : undefined);
	if (status !== undefined) return { status, code, detail };
	// No status: only surface the frame when the upstream wording is itself an
	// unambiguous throttle, so unrelated error envelopes keep their old message.
	if (nested === undefined && !IN_BAND_RETRYABLE_TEXT_PATTERN.test(detail ?? "")) return undefined;
	if (!IN_BAND_RETRYABLE_TEXT_PATTERN.test(code ?? "") && !IN_BAND_RETRYABLE_TEXT_PATTERN.test(detail ?? "")) {
		return undefined;
	}
	return { status: readStatusToken(detail), code, detail };
}

/**
 * Compose the message for a status-bearing in-band failure. The numeric status
 * leads (matching `captureOpenAIHttpError`'s `"<status> <detail>"` phrasing)
 * unless the detail already carries it; the machine code is appended only when
 * it adds information the text classifier or a human reader can use.
 */
function formatInBandMessage(status: number, detail: string | undefined, code: string | undefined): string {
	const body = detail ?? "Provider returned an in-band provider error";
	const suffix =
		code !== undefined && !/^\d+$/.test(code) && !body.toLowerCase().includes(code.toLowerCase())
			? ` (${code})`
			: "";
	return body.startsWith(`${status}`) ? `${body}${suffix}` : `${status} ${body}${suffix}`;
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
	if (isServerStatus(status)) return new HttpError(formatInBandMessage(status, detail, code), status, { code });
	if (detail === undefined && code === undefined) return undefined;
	// Keep the upstream code visible (`(<code>)`) so the transient-text classifier
	// still recognises the throttle — the same convention the Anthropic provider
	// already uses for its `(<errorType>)` suffix.
	return new ProviderResponseError(
		`${detail ?? "Provider returned an in-band provider error"}${code ? ` (${code})` : ""}`,
		{ kind: "runtime" },
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
	const status = readStatusToken(detail);
	if (isServerStatus(status)) return new HttpError(formatInBandMessage(status, detail, undefined), status);
	return new ProviderResponseError(`${detail} (in-band provider error)`, { kind: "runtime" });
}

/** Type guard for the status-bearing variant, so callers can widen to the HTTP contract. */
export function isInBandHttpError(error: Error): error is ProviderHttpError {
	return error instanceof HttpError;
}