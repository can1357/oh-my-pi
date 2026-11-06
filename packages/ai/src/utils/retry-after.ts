import { retryResetTimezoneOffsetFor } from "@oh-my-pi/pi-catalog/compat/behavior";
import {
	extractRetryHint,
	headerValue,
	type FetchWithRetryOptions,
	getExplicitRetryAfterMsFromHeaders as getExplicitRetryAfterMsFromSharedHeaders,
	getRetryAfterMsFromHeaders as getRetryAfterMsFromSharedHeaders,
	longestRetryHint,
} from "@oh-my-pi/pi-utils";
import {
	markRetryWaitRefused,
	type ProviderRetryPolicy,
	providerRetryPolicy,
	type RefusedRetryWait,
	statedRetryWaitLimit,
} from "./retry-wait";

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
	headerRetryAfterMs?: number,
): number | undefined {
	return extractRetryHint(undefined, message, { ...hintOptions(provider), headerRetryAfterMs });
}

/**
 * The wait a failure names, for every caller that keeps a route or a credential
 * closed for it — a credential block, a usage-limit mark, a one-shot retry, the
 * session's retry delay. The response headers' wait, passed in structured
 * (`AssistantMessage.errorRetryAfterMs`; for a thrown error, read through
 * {@link providerFailureWaitMs}), outranks any date the message's text
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

/** What {@link providerFailureWaitMs} reads beside the failure itself. */
export interface ProviderFailureWaitOptions {
	/** The failure's text, when the caller derives it its own way; `undefined` reads no text. Defaults to {@link errorMessageText}. */
	message?: string | undefined;
	/**
	 * A header wait the caller already holds from the response object (a failed
	 * message's `errorRetryAfterMs`); it is taken over the failure's own headers.
	 */
	retryAfterMs?: number;
	/** An accepted response's headers, when the failure arrived inside one. */
	streamResponseHeaders?: HeadersLike;
}

/**
 * The wait a thrown failure states, read as {@link providerRetryWaitMs} reads
 * it: the header wait (`options.retryAfterMs`, else the failure's own headers
 * and an accepted response's, {@link getFailureRetryAfterMs}) beside the
 * relative waits its text names, the longer winning. For a caller holding a
 * thrown error rather than a failed message: a credential rotation, the auth
 * gateway's usage-limit block, an advisor's retry, and a provider's own retry
 * loop, which passes the accepted response's headers of the attempt it retries.
 */
export function providerFailureWaitMs(
	provider: string | undefined,
	error: unknown,
	options: ProviderFailureWaitOptions = {},
): number | undefined {
	return providerRetryWaitMs(
		provider,
		Object.hasOwn(options, "message") ? options.message : errorMessageText(error),
		options.retryAfterMs ?? getFailureRetryAfterMs(error, { streamResponseHeaders: options.streamResponseHeaders }),
	);
}

/** How a retry loop keeps to the caller's bounds; see {@link retryWaitBounds}. */
export interface RetryWaitBounds {
	/**
	 * The longest sleep a retry may take, and `fetchWithRetry`'s `maxDelayMs`:
	 * the caller's cap, or its smaller ceiling.
	 */
	maxDelayMs: number;
	/**
	 * Whether a stated wait is longer than the caller's bounds allow, so the
	 * failure is handed back at once instead of retried. `wait` is the wait
	 * itself, or the headers that state it, read by
	 * {@link getRetryAfterMsFromHeaders}. When it declines and `failure` is
	 * given, the refusal is recorded on `failure` ({@link markRetryWaitRefused}),
	 * so the surfaced message says so.
	 */
	declines(wait: number | HeadersLike, failure?: unknown): boolean;
	/** The refused wait {@link declines} would see in `wait`, and the bound that refused it. */
	refusal(wait: number | HeadersLike): RefusedRetryWait | undefined;
}

/**
 * The bounds a retry loop takes from the caller's retry policy, read through
 * {@link providerRetryPolicy} so a field a wrapper's rebuilt options dropped
 * comes from the request: a provider's pre-output retry loops and its
 * transport's own `fetchWithRetry` retry a failure exactly alike. A stated
 * wait longer than {@link statedRetryWaitLimit} allows (`maxRetryDelayMs`, or
 * a smaller `providerRetryWaitCeilingMs`) is declined and the failure surfaces
 * at once. Headers are read as `finalize` reads them
 * ({@link getRetryAfterMsFromHeaders}), so the retry and the failed message's
 * `errorRetryAfterMs` judge one wait. A non-positive cap bounds nothing, as
 * the option documents; an absent one keeps the caller's `defaultMaxDelayMs`.
 */
export function retryWaitBounds(policy: ProviderRetryPolicy | undefined, defaultMaxDelayMs: number): RetryWaitBounds {
	const limit = statedRetryWaitLimit(providerRetryPolicy(policy), defaultMaxDelayMs);
	const refusal = (wait: number | HeadersLike): RefusedRetryWait | undefined => {
		const waitMs = typeof wait === "number" ? wait : getRetryAfterMsFromHeaders(wait);
		return waitMs !== undefined && waitMs > limit.limitMs ? { ...limit, waitMs } : undefined;
	};
	return {
		maxDelayMs: limit.limitMs,
		declines: (wait, failure) => {
			const refused = refusal(wait);
			if (refused !== undefined && failure !== undefined) markRetryWaitRefused(failure, refused);
			return refused !== undefined;
		},
		refusal,
	};
}

/** A transport's `fetchWithRetry` options under the caller's retry policy; see {@link transportRetry}. */
export interface TransportRetry {
	/** Spread into `fetchWithRetry`: the bound, the retry-wait hook, and where a refused wait is noted. */
	fetchOptions: Pick<FetchWithRetryOptions, "maxDelayMs" | "retryWait" | "onRefusedWait">;
	/** Records on `failure`, the error the refused response became, the wait `fetchWithRetry` refused, if it refused one. */
	markRefusal(failure: unknown): void;
}

/**
 * What a transport hands `fetchWithRetry` so its sleeps keep to the same
 * bound as every other provider sleep: `maxDelayMs` is the caller's cap or
 * smaller ceiling ({@link retryWaitBounds}), so a wait the response states
 * anywhere `fetchWithRetry` reads one (a header, `x-ratelimit-reset-after`,
 * the body's `Please retry in 15s`) past it returns the response unslept; the
 * sleep goes through the request's retry-wait hook; and the surfaced failure
 * says which wait was refused, only when `fetchWithRetry` refused one.
 */
export function transportRetry(policy: ProviderRetryPolicy | undefined, defaultMaxDelayMs: number): TransportRetry {
	const bounds = retryWaitBounds(policy, defaultMaxDelayMs);
	let refused: RefusedRetryWait | undefined;
	return {
		fetchOptions: {
			maxDelayMs: bounds.maxDelayMs,
			retryWait: providerRetryPolicy(policy).providerRetryWait,
			onRefusedWait: waitMs => {
				refused = bounds.refusal(waitMs);
			},
		},
		markRefusal: failure => {
			if (refused !== undefined) markRetryWaitRefused(failure, refused);
		},
	};
}

/**
 * The wait a response's headers state, read by the same pi-utils reader that
 * `fetchWithRetry` and `longestRetryHint` use, rounded up to whole
 * milliseconds. An explicit retry instruction, including a literal `0`, wins
 * over a rate-window reset. It never reaches a person or a classifier as
 * text: the wait travels structured, as `AssistantMessage.errorRetryAfterMs`.
 */
export function getRetryAfterMsFromHeaders(headers: HeadersLike): number | undefined {
	const waitMs = getRetryAfterMsFromSharedHeaders(headers);
	return waitMs === undefined ? undefined : Math.ceil(waitMs);
}

/**
 * `retry-after-ms`, else `Retry-After`: the headers that tell the client to
 * wait, read by the same pi-utils reader, rounded up to whole milliseconds.
 */
function getExplicitRetryAfterMsFromHeaders(headers: HeadersLike): number | undefined {
	const waitMs = getExplicitRetryAfterMsFromSharedHeaders(headers);
	return waitMs === undefined ? undefined : Math.ceil(waitMs);
}

/**
 * The server's explicit `x-should-retry` verdict: `true`/`false` when the
 * header says so, `undefined` when absent or unrecognised. Non-standard
 * (Stainless-SDK convention) but emitted by OpenAI, Anthropic, and retrying
 * gateways; when present it overrides status/text retry heuristics.
 */
export function getShouldRetryFromHeaders(headers: HeadersLike): boolean | undefined {
	if (!headers) return undefined;
	const value = headerValue(headers, "x-should-retry");
	if (value === "true") return true;
	if (value === "false") return false;
	return undefined;
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
