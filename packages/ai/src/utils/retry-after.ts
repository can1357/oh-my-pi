import { retryResetTimezoneOffsetFor } from "@oh-my-pi/pi-catalog/compat/behavior";
import { extractRetryHint, longestRetryHint, parseRetryAfter } from "@oh-my-pi/pi-utils";

export type HeadersLike = Headers | Record<string, string | undefined> | undefined | null;

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
 * session's retry delay: the longer of the response headers' wait, passed in
 * structured (`AssistantMessage.errorRetryAfterMs`, or a thrown error's headers
 * through {@link getRetryAfterMsFromHeaders}), and the first wait the message's
 * text names ({@link extractProviderRetryHint}). The header's wait is taken from
 * the response object, so no text can stand in for it; a body that ends in
 * `retry-after-ms=<n>` is read like any other body.
 */
export function providerRetryWaitMs(
	provider: string | undefined,
	message: string | undefined,
	headerRetryAfterMs: number | undefined,
): number | undefined {
	const text = extractProviderRetryHint(provider, message);
	if (headerRetryAfterMs === undefined) return text;
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

/**
 * `error`'s message text: an Error's `message`, anything else as JSON. The
 * failed response's retry wait is never written into it: it travels
 * structured (`AssistantMessage.errorRetryAfterMs`, {@link getFailureRetryAfterMs})
 * and is rendered for a person only at display (`assistantErrorText`), where no
 * classifier can mistake its digits for a status.
 */
export function errorMessageText(error: unknown): string {
	return error instanceof Error ? error.message : JSON.stringify(error);
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
	return isRetryWaitMs(retryAfterMs) ? new Headers({ "retry-after-ms": String(retryAfterMs) }) : undefined;
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
 * Headers that refused the request come first: the captured non-2xx
 * response's, else the error's own ({@link getHeadersFromError}, which include
 * the structured headers a protocol error event carries, as Codex's do). When
 * they name a wait it wins, a window reset included: on a refusal,
 * `x-ratelimit-reset` says when this request can succeed.
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
		getRetryAfterMsFromHeaders(headers.errorResponseHeaders ?? getHeadersFromError(error)) ??
		getExplicitRetryAfterMsFromHeaders(headers.streamResponseHeaders)
	);
}

/** How a transport's own `fetchWithRetry` loop keeps to the caller's cap; see {@link transportRetryBounds}. */
export interface TransportRetryBounds {
	/** `fetchWithRetry`'s `maxDelayMs`: no retry sleep exceeds it. */
	maxDelayMs: number;
	/** Whether `response`'s headers name a wait longer than {@link maxDelayMs}: hand the refusal back at once. */
	declines(response: Response): boolean;
}

/**
 * The bounds a transport-level retry loop (`fetchWithRetry`) takes from the
 * caller's `maxRetryDelayMs` (`StreamOptions`), so a transport retries a 429 or
 * 5xx exactly when the provider loops above it would. A retry whose response
 * headers name a longer wait than the cap is declined and the refusal surfaces
 * at once; the headers are read as `finalize` reads them
 * ({@link getRetryAfterMsFromHeaders}), so the transport and the failed
 * message's `errorRetryAfterMs` judge one wait. A wait within the cap is
 * honored. A non-positive cap disables the bound, as the option documents; an
 * absent one keeps the transport's own `defaultMaxDelayMs`.
 */
export function transportRetryBounds(
	maxRetryDelayMs: number | undefined,
	defaultMaxDelayMs: number,
): TransportRetryBounds {
	const maxDelayMs =
		maxRetryDelayMs === undefined
			? defaultMaxDelayMs
			: maxRetryDelayMs > 0
				? maxRetryDelayMs
				: Number.POSITIVE_INFINITY;
	return {
		maxDelayMs,
		declines: response => {
			const waitMs = getRetryAfterMsFromHeaders(response.headers);
			return waitMs !== undefined && waitMs > maxDelayMs;
		},
	};
}

export function getRetryAfterMsFromHeaders(headers: HeadersLike): number | undefined {
	if (!headers) return undefined;
	return longestWait(
		getExplicitRetryAfterMsFromHeaders(headers),
		parseResetHeader(getHeaderValue(headers, "x-ratelimit-reset-ms"), "ms"),
		parseResetHeader(getHeaderValue(headers, "x-ratelimit-reset"), "s"),
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

/** The header's wait, read by the shared `parseRetryAfter`; a wait of zero names none here. */
function parseRetryAfterHeader(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const ms = parseRetryAfter(value);
	return ms === undefined || ms <= 0 ? undefined : Math.ceil(ms);
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
