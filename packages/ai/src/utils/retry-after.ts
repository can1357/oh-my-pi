import { retryResetTimezoneOffsetFor } from "@oh-my-pi/pi-catalog/compat/behavior";
import { extractRetryHint, longestRetryHint, parseRetryDateMs } from "@oh-my-pi/pi-utils";
import { type RefusedRetryWait, statedRetryWaitLimit } from "./retry-wait";

export type HeadersLike = Headers | Record<string, string | undefined> | undefined | null;

const RETRY_AFTER_HINT = "retry-after-ms=";

function hintOptions(provider: string | undefined) {
	return { naiveResetTimezoneOffset: provider === undefined ? undefined : retryResetTimezoneOffsetFor(provider) };
}

/**
 * The retry wait `message`'s text names, read in the provider's
 * catalog-declared timestamp timezone: the first occurrence of each hint form,
 * the longest across forms ({@link extractRetryHint}). Text only: no position
 * in it is trusted as anyone's but the body's, because a body can write any
 * text. A header's wait reaches readers as a structured value instead
 * (`AssistantMessage.errorRetryAfterMs`, a thrown error's headers); see
 * {@link providerRetryWaitMs}, which every caller that keeps a route or a
 * credential closed uses.
 *
 * It deliberately does not search every occurrence: a body can quote other
 * text, and a number inside an echoed prompt or a quoted upstream body is not
 * this response's wait. Only turn recovery's held-retry check reads every
 * occurrence, and it can only decline a hold ({@link longestProviderRetryHint}).
 */
export function extractProviderRetryHint(
	provider: string | undefined,
	message: string | undefined,
): number | undefined {
	return extractRetryHint(undefined, message, hintOptions(provider));
}

/**
 * The wait a failure names, for every caller that keeps a route or a credential
 * closed for it — a credential block, a usage-limit mark, a one-shot retry, the
 * session's retry delay. The response headers' wait, passed in structured
 * (`AssistantMessage.errorRetryAfterMs`, or a thrown error's headers through
 * {@link getRetryAfterMsFromHeaders}), outranks any date the message's text
 * states: beside it, only the text's relative waits count, and the longer of
 * the two wins. Without a header wait, the first wait the text names
 * ({@link extractProviderRetryHint}). The header's wait is taken from the
 * response object, so no text can stand in for it; a body that ends in
 * `retry-after-ms=<n>` is read like any other body.
 */
export function providerRetryWaitMs(
	provider: string | undefined,
	message: string | undefined,
	headerRetryAfterMs: number | undefined,
): number | undefined {
	if (headerRetryAfterMs === undefined) return extractProviderRetryHint(provider, message);
	const text = extractRetryHint(undefined, message, { ...hintOptions(provider), excludeDates: true });
	return text === undefined ? headerRetryAfterMs : Math.max(text, headerRetryAfterMs);
}

/**
 * The longest wait `message` names across every occurrence of every hint form
 * ({@link longestRetryHint}). For one caller only: turn recovery's held retry,
 * which declines the hold when any wait the message names reaches past the held
 * window. Reading a quoted or echoed number there costs one chain consult in
 * place of a held retry; it never lengthens a wait or a block, so it must not
 * be used for one.
 */
export function longestProviderRetryHint(
	provider: string | undefined,
	message: string | undefined,
): number | undefined {
	return longestRetryHint(undefined, message, hintOptions(provider));
}

/** `error`'s message text: an Error's `message`, anything else as JSON. */
export function errorMessageText(error: unknown): string {
	return error instanceof Error ? error.message : JSON.stringify(error);
}

/**
 * `message` with the response headers' retry wait appended as
 * `retry-after-ms=<n>`, for the person reading it, when the first wait the
 * message itself names is shorter or absent. No consumer reads the header's
 * wait back out of this text — it takes it structured
 * ({@link providerRetryWaitMs}) — so the text is free to say it and a body is
 * unable to forge it, and the text never shows a shorter wait than the field.
 */
export function appendRetryAfterHint(message: string, headers: HeadersLike): string {
	const retryAfterMs = getRetryAfterMsFromHeaders(headers);
	if (retryAfterMs === undefined) return message;
	const named = extractProviderRetryHint(undefined, message);
	if (named !== undefined && named >= retryAfterMs) return message;
	return `${message} ${RETRY_AFTER_HINT}${retryAfterMs}`;
}

/** `error`'s message with its own response headers' retry wait appended ({@link appendRetryAfterHint}). */
export function formatErrorMessageWithRetryAfter(error: unknown): string {
	return appendRetryAfterHint(errorMessageText(error), getHeadersFromError(error));
}

/**
 * Whether `value` can be an `AssistantMessage.errorRetryAfterMs`: a finite
 * number of milliseconds, zero or more. A relay carries the field as untrusted
 * JSON (the proxy's terminal frame, the pi-native failure frame), and nothing
 * else may be restated as a header.
 */
export function isRetryWaitMs(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * `retryAfterMs` restated as a `retry-after-ms` header, for an Error rebuilt
 * from a failed message, so a reader of the Error's headers
 * ({@link getHeadersFromError}) sees the message's structured wait. The text
 * never stands in for it. `undefined` unless {@link isRetryWaitMs}.
 */
export function retryWaitHeaders(retryAfterMs: number | undefined): Headers | undefined {
	return isRetryWaitMs(retryAfterMs)
		? new Headers({ "retry-after-ms": retryWaitHeaderValue(retryAfterMs) })
		: undefined;
}

/**
 * `ms` as an HTTP header integer: rounded up, and at most
 * `Number.MAX_SAFE_INTEGER` so it never prints in exponent form (`1e+300`),
 * which no header reader takes as a number.
 */
export function retryWaitHeaderValue(ms: number): string {
	return String(Math.min(Math.ceil(ms), Number.MAX_SAFE_INTEGER));
}

/** The response headers a failed attempt can read its wait from; see {@link getFailureRetryAfterMs}. */
export interface FailureResponseHeaders {
	/** Headers of the non-2xx response that refused the request, when the provider captured it. */
	errorResponseHeaders?: HeadersLike;
	/**
	 * Headers of the accepted (2xx) response whose body the failure arrived in:
	 * an in-band error event, or a stream cut after the response arrived.
	 */
	streamResponseHeaders?: HeadersLike;
}

/**
 * The retry wait a failed attempt's own response headers name. `AIError.finalize`
 * returns it as `retryAfterMs` (the message's `errorRetryAfterMs`), and a
 * provider's pre-output retry loop checks it against `maxRetryDelayMs`, so the
 * layer that retries and the layers that read the failed message see one wait.
 *
 * Headers that refused the request come first, each set read for its own wait
 * ({@link getRetryAfterMsFromHeaders}): the captured non-2xx response's, then
 * the error's own ({@link getHeadersFromError}, which include the structured
 * headers a protocol error event carries, as Codex's do). A set that names no
 * wait never hides one the next set names.
 *
 * Otherwise the accepted response's headers, and from those only explicit wait
 * instructions: `retry-after-ms` and `Retry-After`. Never
 * `x-ratelimit-reset[-ms]` there: on a response the server accepted, a window
 * reset says when a rate window that did not refuse this request resets, not
 * that the client must wait. A provider that sends it on every response would
 * otherwise turn every stream cut into a held-retry veto, or a credential block
 * as long as the window.
 */
export function getFailureRetryAfterMs(error: unknown, headers: FailureResponseHeaders = {}): number | undefined {
	return (
		getRetryAfterMsFromHeaders(headers.errorResponseHeaders) ??
		getRetryAfterMsFromHeaders(getHeadersFromError(error)) ??
		getExplicitRetryAfterMsFromHeaders(headers.streamResponseHeaders)
	);
}

/**
 * The wait a provider stated for a thrown failure, for a provider's pre-output
 * retry loop, read as every layer above reads the failed message
 * ({@link providerRetryWaitMs}): the failed attempt's header wait
 * ({@link getFailureRetryAfterMs}: the error's own headers, which include a
 * protocol error event's structured headers, then the explicit wait the
 * accepted response's headers name), with only the message's relative waits
 * beside it; without a header wait, the message's text. A zone-less date in the
 * text therefore never outranks a stated header wait. Pass the headers of the
 * attempt being retried, the ones `AIError.finalize` reads for it.
 */
export function getStatedRetryAfterMs(
	provider: string | undefined,
	error: unknown,
	headers: FailureResponseHeaders = {},
): number | undefined {
	return providerRetryWaitMs(provider, errorMessageText(error), getFailureRetryAfterMs(error, headers));
}

/** How a transport's own `fetchWithRetry` loop keeps to the caller's bounds; see {@link transportRetryBounds}. */
export interface TransportRetryBounds {
	/** `fetchWithRetry`'s `maxDelayMs`: no retry sleep exceeds it. */
	maxDelayMs: number;
	/** Whether `response`'s headers name a wait the caller's bounds refuse: hand the refusal back at once. */
	declines(response: Response): boolean;
	/** The refused wait {@link declines} saw on `response`, for the error the transport surfaces. */
	refusal(response: Response): RefusedRetryWait | undefined;
}

/**
 * The bounds a transport-level retry loop (`fetchWithRetry`) takes from the
 * caller's `StreamOptions`, so a transport retries a 429 or 5xx exactly when
 * the provider loops above it would. A retry whose response headers name a
 * longer wait than {@link statedRetryWaitLimit} allows (`maxRetryDelayMs`, or a
 * smaller `providerRetryWaitCeilingMs`) is declined and the refusal surfaces at
 * once; the headers are read as `finalize` reads them
 * ({@link getRetryAfterMsFromHeaders}), so the transport and the failed
 * message's `errorRetryAfterMs` judge one wait. `maxDelayMs`, the bound on any
 * retry sleep, stays the cap alone: a non-positive cap disables it, as the
 * option documents, and an absent one keeps the transport's own
 * `defaultMaxDelayMs`.
 */
export function transportRetryBounds(
	maxRetryDelayMs: number | undefined,
	defaultMaxDelayMs: number,
	providerRetryWaitCeilingMs?: number,
): TransportRetryBounds {
	const maxDelayMs = statedRetryWaitLimit({ maxRetryDelayMs }, defaultMaxDelayMs).limitMs;
	const limit = statedRetryWaitLimit({ maxRetryDelayMs, providerRetryWaitCeilingMs }, defaultMaxDelayMs);
	const refusal = (response: Response): RefusedRetryWait | undefined => {
		const waitMs = getRetryAfterMsFromHeaders(response.headers);
		return waitMs !== undefined && waitMs > limit.limitMs ? { ...limit, waitMs } : undefined;
	};
	return { maxDelayMs, declines: response => refusal(response) !== undefined, refusal };
}

/**
 * The wait a response's headers state. `retry-after-ms` and `Retry-After` are
 * the server telling the client how long to wait, and when either is present
 * it is the answer. `x-ratelimit-reset[-ms]` says when a rate window ends — a
 * bound on when capacity returns, not an instruction — and is read only when
 * no explicit wait is stated: a "retry in 1 second" beside a window that ends
 * in an hour is one second.
 */
export function getRetryAfterMsFromHeaders(headers: HeadersLike): number | undefined {
	if (!headers) return undefined;
	return (
		getExplicitRetryAfterMsFromHeaders(headers) ??
		longestWait(
			parseResetHeader(getHeaderValue(headers, "x-ratelimit-reset-ms"), "ms"),
			parseResetHeader(getHeaderValue(headers, "x-ratelimit-reset"), "s"),
		)
	);
}

/** `retry-after-ms` and `Retry-After`: the headers that tell the client to wait. */
function getExplicitRetryAfterMsFromHeaders(headers: HeadersLike): number | undefined {
	if (!headers) return undefined;
	return longestWait(
		parseRetryAfterMsHeader(getHeaderValue(headers, "retry-after-ms")),
		parseRetryAfterHeader(getHeaderValue(headers, "retry-after")),
	);
}

function longestWait(...waits: (number | undefined)[]): number | undefined {
	let longest: number | undefined;
	for (const wait of waits) {
		if (wait !== undefined && (longest === undefined || wait > longest)) longest = wait;
	}
	return longest;
}

export function getHeadersFromError(error: unknown): HeadersLike {
	if (!error || typeof error !== "object") return undefined;
	const record = error as { headers?: unknown; response?: { headers?: unknown }; cause?: unknown };
	const direct = extractHeaders(record.headers) ?? extractHeaders(record.response?.headers);
	if (direct) return direct;
	if (record.cause) return getHeadersFromError(record.cause);
	return undefined;
}

function extractHeaders(value: unknown): HeadersLike {
	if (!value) return undefined;
	if (value instanceof Headers) return value;
	if (typeof value === "object") return value as Record<string, string | undefined>;
	return undefined;
}

function getHeaderValue(headers: Headers | Record<string, string | undefined>, name: string): string | undefined {
	if (headers instanceof Headers) {
		const value = headers.get(name);
		return value ?? undefined;
	}

	const target = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLowerCase() === target && typeof value === "string") {
			return value;
		}
	}
	return undefined;
}

/** `retry-after-ms` (Anthropic-style): a plain millisecond delta. */
function parseRetryAfterMsHeader(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const ms = Number(value.trim());
	if (!Number.isFinite(ms) || ms <= 0) return undefined;
	return Math.ceil(ms);
}

function parseRetryAfterHeader(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;

	const numeric = Number(trimmed);
	if (Number.isFinite(numeric)) {
		if (numeric <= 0) return undefined;
		return Math.ceil(numeric * 1000);
	}

	// An HTTP-date is GMT by definition; a zone-less one is read as GMT, not in this machine's zone.
	const dateMs = parseRetryDateMs(trimmed, "gmt");
	if (dateMs !== undefined) {
		const delay = dateMs - Date.now();
		return delay > 0 ? Math.ceil(delay) : undefined;
	}

	return undefined;
}

function parseResetHeader(value: string | undefined, unit: "ms" | "s"): number | undefined {
	if (!value) return undefined;
	const numeric = Number(value);
	if (!Number.isFinite(numeric) || numeric <= 0) return undefined;

	const nowMs = Date.now();
	let targetMs: number | undefined;

	if (unit === "ms") {
		if (numeric > 1e12) {
			targetMs = numeric;
		} else if (numeric > 1e9) {
			targetMs = numeric * 1000;
		} else {
			return Math.ceil(numeric);
		}
	} else {
		if (numeric > 1e12) {
			targetMs = numeric;
		} else if (numeric > 1e9) {
			targetMs = numeric * 1000;
		} else {
			return Math.ceil(numeric * 1000);
		}
	}

	if (targetMs <= nowMs) return undefined;
	return Math.ceil(targetMs - nowMs);
}
