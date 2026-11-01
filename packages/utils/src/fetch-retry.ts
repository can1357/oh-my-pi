import { scheduler } from "node:timers/promises";

// "reset after 1h2m3s" / "10m15s" / "39s"
const QUOTA_RESET_PATTERN = /reset after (?:(\d+)h)?(?:(\d+)m)?(\d+(?:\.\d+)?)s/i;
// "Please retry in 250ms" / "Please retry in 12s"
const PLEASE_RETRY_PATTERN = /Please retry in ([0-9.]+)(ms|s)/i;
// JSON field: "retryDelay": "34.074824224s"
const RETRY_DELAY_FIELD_PATTERN = /"retryDelay":\s*"([0-9.]+)(ms|s)"/i;
// "try again in 250ms" / "try again in 12s" / "try again in 12sec" /
// "try again in 5 min" / "try again in ~158 min." / "try again in 2h" /
// "try again in 90 minutes" / "try again in 1 hour"
const TRY_AGAIN_PATTERN = /try again in\s+~?\s*([0-9.]+)\s*(ms|sec|s|minutes?|mins?|m|hours?|hrs?|h)\b/i;
// "Your limit will reset in 13 minutes" / "reset in 13 minutes" / "will reset in 2h"
// OpenCode Go quota errors use "Resets in …" with day units and compound
// remainders ("Resets in 3 days", "Resets in 2hr 15min", "Resets in 45min").
const WILL_RESET_IN_PATTERN =
	/(?:will\s+)?resets?\s+in\s+~?\s*([0-9.]+)\s*(ms|sec|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/i;
// OpenCode Go compound remainder: "Resets in 2hr 15min".
const RESET_IN_HR_MIN_PATTERN = /resets?\s+in\s+~?\s*(\d+(?:\.\d+)?)\s*hr\s*(\d+(?:\.\d+)?)\s*min\b/i;
// "Your limit will reset at 2026-09-01 09:44:51" / "reset at 2026-09-01T09:44:51Z"
const WILL_RESET_AT_PATTERN =
	/(?:will\s+)?reset at\s+([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:?[0-9]{2})?)/i;
// Both grammars carry a timezone-naive wall clock. The default reading is UTC;
// a provider-specific offset (Z.AI/Zhipu Beijing time) is applied only through
// `RetryHintOptions.naiveResetTimezoneOffset`, never inferred from the language.
const CN_RESET_AT_PATTERN = /将在\s*([0-9]{4}-[0-9]{2}-[0-9]{2}\s+[0-9]{2}:[0-9]{2}:[0-9]{2})\s*重置/;
const RESET_AT_PATTERNS: readonly RegExp[] = [WILL_RESET_AT_PATTERN, CN_RESET_AT_PATTERN];
// "retry-after-ms=98497000" / "retry-after-ms: 7200000" / "retry-after-ms = 7200000"
const RETRY_AFTER_MS_BODY_PATTERN = /\bretry-after-ms\s*[:=]\s*([0-9]+)\b/i;
// Legacy text forms: "retry-after: 30" / "retry-after=<HTTP date>" and the
// `x-ratelimit-reset[-ms]` counters folded into a message.
const RETRY_AFTER_BODY_PATTERN = /retry-after\s*[:=]\s*([^\s,;]+)/i;
const RESET_MS_BODY_PATTERN = /x-ratelimit-reset-ms\s*[:=]\s*(\d+)/i;
const RESET_BODY_PATTERN = /x-ratelimit-reset\s*[:=]\s*(\d+)/i;

// A date with no zone means different things by where it came from. In a
// `Retry-After` header it is an HTTP-date, which RFC 9110 §5.6.7 defines as
// GMT, so it is read as GMT. In a message body nothing says which zone the
// server rendered it in: read as UTC, `reset at 2026-11-01 01:40:17` once gave
// eight hours where the server's own header said 750 ms. A wait that cannot be
// computed is no wait, so a zone-less body date is rejected and the caller
// falls back to its own backoff — unless the provider's catalog declares the
// zone its stamps use (`naiveResetTimezoneOffset`), which makes it explicit.

/** A zone at the end of a date: `GMT`, `UTC`, `UT`, `Z`, a numeric offset, or a US zone name. */
const DATE_ZONE_PATTERN = /(?:\b(?:GMT|UTC|UT|[ECMP][SD]T)|Z|[+-]\d{2}:?\d{2})\s*$/i;
/** An ISO-style date-time: `2099-09-01T09:44:51` or `2099-09-01 09:44:51`. */
const ISO_DATE_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/**
 * Epoch ms of `value` read as a date in its stated zone. A date with no zone
 * is read as GMT when `zoneless` is `"gmt"` (an HTTP header's date) and is
 * `undefined` when it is `"reject"` (a date out of a message body). Not
 * `Date.parse` alone: that reads a zone-less date in this machine's zone.
 */
export function parseRetryDateMs(value: string, zoneless: "gmt" | "reject"): number | undefined {
	const trimmed = value.trim();
	let ms: number;
	if (DATE_ZONE_PATTERN.test(trimmed)) ms = Date.parse(trimmed);
	else if (zoneless === "reject") return undefined;
	else ms = Date.parse(ISO_DATE_TIME_PATTERN.test(trimmed) ? `${trimmed.replace(" ", "T")}Z` : `${trimmed} GMT`);
	return Number.isNaN(ms) ? undefined : ms;
}

/** Provider-specific interpretation for timezone-naive retry timestamps. */
export interface RetryHintOptions {
	/** UTC offset of the provider's zone-less reset stamps; without one they give no wait. */
	naiveResetTimezoneOffset?: string;
	/**
	 * Read no date out of the body (reset-at stamps, a `retry-after` date), only
	 * relative waits and counters. For a caller that already has the response
	 * header's wait: an explicit header outranks any date a body states.
	 */
	excludeDates?: boolean;
}

/**
 * Server-suggested retry delay extraction. Merges the patterns historically used
 *
 * Header sources (checked in order):
 *  - `retry-after-ms` (milliseconds)
 *  - `Retry-After` (numeric seconds, or HTTP date)
 *  - `x-ratelimit-reset-ms` (delta ms, or Unix epoch ms/s for large values)
 *  - `x-ratelimit-reset` (Unix epoch seconds)
 *  - `x-ratelimit-reset-after` (seconds)
 *
 * Body patterns:
 *  - `Your quota will reset after 18h31m10s` / `10m15s` / `39s`
 *  - `Please retry in 250ms` / `Please retry in 12s`
 *  - `"retryDelay": "34.074824224s"` (JSON error detail field)
 *  - `try again in 250ms` / `try again in 12s` / `try again in 5 min` / `try again in ~158 min`
 *  - `retry-after-ms=98497000` / `retry-after-ms: 7200000` / `retry-after-ms = 7200000`
 *  - `Your limit will reset at 2026-09-01 09:44:51+08:00` / `将在 2026-09-01 09:44:51 重置`
 *    (with no zone, only in the provider's declared offset; otherwise no wait)
 *
 * Returns `undefined` if no signal is found, or `0` when the provider
 * explicitly asks for an immediate retry (`retry-after…=0`, or an absolute
 * reset timestamp that has already elapsed).
 */
export function extractRetryHint(
	source: Response | Headers | null | undefined,
	body?: string,
	options?: RetryHintOptions,
): number | undefined {
	const headers = source instanceof Headers ? source : (source?.headers ?? undefined);
	if (headers) {
		const retryAfterMs = parseRetryAfterHeaderMs(headers.get("retry-after-ms"), "ms");
		if (retryAfterMs !== undefined) return retryAfterMs;
		const retryAfter = parseRetryAfterHeaderMs(headers.get("retry-after"), "s");
		if (retryAfter !== undefined) return retryAfter;
		const rateLimitResetMs = headers.get("x-ratelimit-reset-ms");
		if (rateLimitResetMs) {
			const value = Number(rateLimitResetMs);
			if (Number.isFinite(value) && value > 0) {
				// > 1e12 → epoch ms; > 1e9 → epoch s; otherwise a delta in ms.
				const targetMs = value > 1e12 ? value : value > 1e9 ? value * 1000 : undefined;
				if (targetMs === undefined) return value;
				const delta = targetMs - Date.now();
				if (delta > 0) return delta;
			}
		}
		const rateLimitReset = headers.get("x-ratelimit-reset");
		if (rateLimitReset) {
			const resetSeconds = Number.parseInt(rateLimitReset, 10);
			if (!Number.isNaN(resetSeconds)) {
				const delta = resetSeconds * 1000 - Date.now();
				if (delta > 0) return delta;
			}
		}
		const rateLimitResetAfter = headers.get("x-ratelimit-reset-after");
		if (rateLimitResetAfter) {
			const seconds = Number(rateLimitResetAfter);
			if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
		}
	}

	if (!body) return undefined;
	return bodyRetryHint(body, options, false);
}

/**
 * The longest wait a response names, across every retry header it carries and
 * every occurrence of every phrase in `body`. A malformed or shorter hint never
 * hides a longer valid one, and duplicate header lines joined by a comma are
 * each read. `0` when the only signals ask for an immediate retry; `undefined`
 * when nothing names a wait.
 *
 * {@link extractRetryHint} stops at the first recognized header and the first
 * occurrence of each phrase, which is what the retry loop has always slept on.
 * A caller that bounds its retries by a budget needs this reading instead: a
 * retry sent inside a window the server said is closed is a guaranteed failure.
 */
export function longestRetryHint(
	source: Response | Headers | null | undefined,
	body?: string,
	options?: RetryHintOptions,
): number | undefined {
	const headers = source instanceof Headers ? source : (source?.headers ?? undefined);
	const hints = headers ? headerRetryHints(headers) : [];
	const fromBody = body ? bodyRetryHint(body, options, true) : undefined;
	if (fromBody !== undefined) hints.push(fromBody);
	return hints.length === 0 ? undefined : Math.max(...hints);
}

/**
 * The wait a `retry-after-ms` (`unit` `"ms"`) or `Retry-After` (`unit` `"s"`:
 * delta seconds, or an HTTP-date) header value states. Duplicate header lines
 * arrive joined by a comma (`9, 120`): each part is read on its own, and the
 * whole value too, since an HTTP-date holds a comma of its own; the longest
 * wins. An explicit `0`, a negative `Retry-After` and an elapsed date are `0`:
 * the server asked for an immediate retry. A negative `retry-after-ms` names no
 * wait. Every reader of these two headers ({@link extractRetryHint},
 * {@link longestRetryHint}, pi-ai's `getRetryAfterMsFromHeaders`) reads a value
 * through this, so the transport's sleep and the failed message's wait agree.
 */
export function parseRetryAfterHeaderMs(raw: string | null | undefined, unit: "ms" | "s"): number | undefined {
	return longestHeaderWait(raw, unit === "ms" ? value => nonNegative(Number(value)) : retryAfterValueMs);
}

/** One `Retry-After` value: delta seconds (negative is `0`), or an HTTP-date read as GMT when it names no zone. */
function retryAfterValueMs(value: string): number | undefined {
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
	const dateMs = parseRetryDateMs(value, "gmt");
	return dateMs === undefined ? undefined : Math.max(0, dateMs - Date.now());
}

/** The longest wait `parse` reads from a header value and from each of its comma-joined parts. */
function longestHeaderWait(
	raw: string | null | undefined,
	parse: (value: string) => number | undefined,
): number | undefined {
	if (!raw) return undefined;
	let longest: number | undefined;
	for (const value of new Set([raw.trim(), ...raw.split(",").map(part => part.trim())])) {
		if (value === "") continue;
		const ms = parse(value);
		if (ms !== undefined && (longest === undefined || ms > longest)) longest = ms;
	}
	return longest;
}

/** The longest wait each retry header names, each comma-separated value read on its own. */
function headerRetryHints(headers: Headers): number[] {
	const resetAfterMs = (value: string): number | undefined => {
		const seconds = nonNegative(Number(value));
		return seconds === undefined ? undefined : seconds * 1000;
	};
	return [
		parseRetryAfterHeaderMs(headers.get("retry-after-ms"), "ms"),
		parseRetryAfterHeaderMs(headers.get("retry-after"), "s"),
		longestHeaderWait(headers.get("x-ratelimit-reset-ms"), value => resetCounterMs(Number(value), 1)),
		longestHeaderWait(headers.get("x-ratelimit-reset"), value => resetCounterMs(Number(value), 1000)),
		longestHeaderWait(headers.get("x-ratelimit-reset-after"), resetAfterMs),
	].filter(ms => ms !== undefined);
}

function nonNegative(value: number): number | undefined {
	return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** A reset counter: a Unix epoch in ms (> 1e12) or s (> 1e9), otherwise a delta in `unitMs`. */
function resetCounterMs(value: number, unitMs: number): number | undefined {
	if (!Number.isFinite(value) || value <= 0) return undefined;
	const targetMs = value > 1e12 ? value : value > 1e9 ? value * 1000 : undefined;
	if (targetMs === undefined) return value * unitMs;
	const delta = targetMs - Date.now();
	return delta > 0 ? delta : undefined;
}

const GLOBAL_PATTERNS = new Map<RegExp, RegExp>();

/** The first match of `pattern` in `body`, or every match when `everyOccurrence` is set. */
function occurrences(pattern: RegExp, body: string, everyOccurrence: boolean): Iterable<RegExpMatchArray> {
	if (!everyOccurrence) {
		const match = pattern.exec(body);
		return match ? [match] : [];
	}
	let global = GLOBAL_PATTERNS.get(pattern);
	if (!global) {
		global = new RegExp(pattern.source, `${pattern.flags}g`);
		GLOBAL_PATTERNS.set(pattern, global);
	}
	return body.matchAll(global);
}

/** The retry wait `body` names: from the first occurrence of each phrase, or from every occurrence. */
function bodyRetryHint(
	body: string,
	options: RetryHintOptions | undefined,
	everyOccurrence: boolean,
): number | undefined {
	// A body can carry several timing signals at once: the account-reset
	// window plus header timing folded into the message text (already the
	// max across response headers — see getRetryAfterMsFromHeaders in
	// pi-ai). Honor the longest: retrying before either window clears
	// re-hits a still-blocked credential and burns the retry budget.
	let longestMs: number | undefined;
	// A parsed-but-non-positive signal is a provider "retry now": an explicit
	// `retry-after…=0` or an absolute reset that already elapsed. It must
	// survive as 0 rather than collapse into "no hint found" — consumers
	// substitute a heuristic wait (30-minute quota guess, default backoff)
	// when the parse returns undefined, which would sleep a session the
	// provider told to retry immediately.
	let retryNow = false;

	const consider = (ms: number | undefined): void => {
		if (ms !== undefined && ms > 0 && (longestMs === undefined || ms > longestMs)) longestMs = ms;
	};
	const considerClamped = (ms: number | undefined): void => {
		if (ms === undefined) return;
		if (ms > 0) consider(ms);
		else retryNow = true;
	};

	for (const quotaMatch of occurrences(QUOTA_RESET_PATTERN, body, everyOccurrence)) {
		const hours = quotaMatch[1] ? Number.parseInt(quotaMatch[1], 10) : 0;
		const minutes = quotaMatch[2] ? Number.parseInt(quotaMatch[2], 10) : 0;
		const seconds = Number.parseFloat(quotaMatch[3]!);
		if (!Number.isNaN(seconds)) {
			const totalMs = ((hours * 60 + minutes) * 60 + seconds) * 1000;
			consider(totalMs > 0 ? totalMs : undefined);
		}
	}
	for (const pattern of RESET_AT_PATTERNS) {
		for (const match of occurrences(pattern, body, everyOccurrence)) {
			if (!match[1]) continue;
			// A stamp in its own zone, or a zone-less one in the provider's
			// declared offset, is explicit and competes by longest-wins. A
			// zone-less stamp with no declared offset gives no wait (see
			// `parseRetryDateMs`).
			const normalized = match[1].replace(" ", "T");
			const hasOffset = /(?:Z|[+-][0-9]{2}:?[0-9]{2})$/i.test(normalized);
			const configuredOffset = options?.naiveResetTimezoneOffset;
			if (options?.excludeDates || (!hasOffset && configuredOffset === undefined)) continue;
			const parsed = Date.parse(hasOffset ? normalized : `${normalized}${configuredOffset}`);
			if (!Number.isNaN(parsed) && parsed > Date.now()) consider(parsed - Date.now());
		}
	}
	// OpenCode Go compound remainder ("Resets in 2hr 15min"): the generic
	// pattern only captures the leading "2hr", so add the trailing minutes.
	for (const compoundResetMatch of occurrences(RESET_IN_HR_MIN_PATTERN, body, everyOccurrence)) {
		if (!compoundResetMatch[1] || !compoundResetMatch[2]) continue;
		const hours = Number.parseFloat(compoundResetMatch[1]);
		const minutes = Number.parseFloat(compoundResetMatch[2]);
		if (Number.isFinite(hours) && Number.isFinite(minutes) && hours >= 0 && minutes > 0) {
			consider(hours * 60 * 60_000 + minutes * 60_000);
		}
	}
	for (const accountResetMatch of occurrences(WILL_RESET_IN_PATTERN, body, everyOccurrence)) {
		if (!accountResetMatch[1]) continue;
		const value = Number.parseFloat(accountResetMatch[1]);
		if (Number.isFinite(value) && value > 0) {
			const unitMs = unitToMs(accountResetMatch[2]!);
			if (unitMs !== undefined) consider(value * unitMs);
		}
	}

	for (const retryAfterMsMatch of occurrences(RETRY_AFTER_MS_BODY_PATTERN, body, everyOccurrence)) {
		if (!retryAfterMsMatch[1]) continue;
		const ms = Number(retryAfterMsMatch[1]);
		if (Number.isFinite(ms)) considerClamped(ms);
	}

	for (const pattern of [PLEASE_RETRY_PATTERN, RETRY_DELAY_FIELD_PATTERN, TRY_AGAIN_PATTERN]) {
		for (const match of occurrences(pattern, body, everyOccurrence)) {
			if (!match[1]) continue;
			const value = Number.parseFloat(match[1]);
			if (Number.isFinite(value) && value > 0) {
				const unitMs = unitToMs(match[2]!);
				if (unitMs !== undefined) consider(value * unitMs);
			}
		}
	}

	// Legacy text forms (also honored by older local parsers): a plain
	// `retry-after` delta in seconds or as an HTTP date, and
	// `x-ratelimit-reset[-ms]` counters. They compete in the same maximum —
	// a longer legacy hint must not lose to a shorter reset phrase. Their
	// non-positive readings (explicit zero, elapsed epoch/date) are the
	// clamped retry-now signals above.
	for (const retryAfterMatch of occurrences(RETRY_AFTER_BODY_PATTERN, body, everyOccurrence)) {
		const value = retryAfterMatch[1]!;
		const seconds = Number(value);
		if (Number.isFinite(seconds)) {
			considerClamped(seconds * 1000);
		} else {
			const dateMs = options?.excludeDates ? undefined : parseRetryDateMs(value, "reject");
			if (dateMs !== undefined) considerClamped(dateMs - Date.now());
		}
	}

	for (const resetMsMatch of occurrences(RESET_MS_BODY_PATTERN, body, everyOccurrence)) {
		const resetMs = Number(resetMsMatch[1]);
		if (!Number.isNaN(resetMs)) {
			considerClamped(resetMs > 1_000_000_000_000 ? resetMs - Date.now() : resetMs);
		}
	}

	for (const resetMatch of occurrences(RESET_BODY_PATTERN, body, everyOccurrence)) {
		const resetSeconds = Number(resetMatch[1]);
		if (!Number.isNaN(resetSeconds)) {
			considerClamped(resetSeconds > 1_000_000_000 ? resetSeconds * 1000 - Date.now() : resetSeconds * 1000);
		}
	}
	// An elapsed reset stamp is no signal: only an explicit zero or an elapsed
	// relative counter is an authoritative retry-now.
	return longestMs ?? (retryNow ? 0 : undefined);
}

function unitToMs(unit: string): number | undefined {
	switch (unit.toLowerCase()) {
		case "ms":
			return 1;
		case "s":
		case "sec":
			return 1000;
		case "m":
		case "min":
		case "mins":
		case "minute":
		case "minutes":
			return 60_000;
		case "h":
		case "hr":
		case "hrs":
		case "hour":
		case "hours":
			return 60 * 60_000;
		case "d":
		case "day":
		case "days":
			return 24 * 60 * 60_000;
		default:
			return undefined;
	}
}

export interface FetchWithRetryOptions extends RequestInit {
	/** Total fetch attempts (initial + retries). Default `5`. */
	maxAttempts?: number;
	/**
	 * Per-delay cap. Server-provided `Retry-After` hints exceeding this return
	 * the current response immediately — caller deals with the `!response.ok`.
	 * Default `60_000`.
	 */
	maxDelayMs?: number;
	/**
	 * Fallback delay schedule when no server hint is present. Number, array
	 * (indexed by attempt, clamped to last), or function. Default exponential
	 * `500ms * 2 ** attempt` capped at `maxDelayMs`.
	 */
	defaultDelayMs?: number | readonly number[] | ((attempt: number) => number);
	/**
	 * Optional per-attempt overlay merged into the base `RequestInit` each try.
	 * Headers from the overlay shallow-merge over the base. Useful for auth
	 * token refresh or user-agent rotation.
	 */
	prepareInit?: (attempt: number) => RequestInit | Promise<RequestInit>;
	/**
	 * Optional `fetch` implementation override. Defaults to `globalThis.fetch`.
	 * Useful for routing requests through a proxy, instrumented transport, or
	 * mock during tests.
	 */
	fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
	/**
	 * Optional retry gate for HTTP responses whose status is retryable. Receives a
	 * cloned body string so callers can fail fast on deterministic provider
	 * failures that happen to use a 5xx status.
	 */
	shouldRetryResponse?: (response: Response, bodyText: string, attempt: number) => boolean | Promise<boolean>;
	/**
	 * Bun extension forwarded verbatim to the underlying `fetch` call. `false`
	 * disables Bun's native ~300s pre-response timeout (callers that own a
	 * configurable first-event/idle watchdog or an external `AbortSignal`
	 * supply this so the runtime ceiling cannot pre-empt them); a positive
	 * number sets a custom ceiling in ms. Bare browser/Node fetch ignores it.
	 */
	timeout?: number | false;
}

const DEFAULT_MAX_DELAY_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Fetch with bounded retries and sensible defaults. Retries on any
 * `isRetryableStatus` (5xx, 408, 429) and on transient network errors. Server
 * `Retry-After`/quota hints are honoured up to `maxDelayMs`; a hint that exceeds
 * the cap returns the current response so the caller can fail fast. Aborts on
 * `init.signal` propagate as `"Request was aborted"`.
 *
 * The caller is responsible for inspecting `!response.ok` once the call returns.
 */
export async function fetchWithRetry(
	url: string | URL | ((attempt: number) => string | URL),
	options: FetchWithRetryOptions = {},
): Promise<Response> {
	const {
		maxAttempts = DEFAULT_MAX_ATTEMPTS,
		maxDelayMs = DEFAULT_MAX_DELAY_MS,
		defaultDelayMs,
		prepareInit,
		shouldRetryResponse,
		fetch: fetchImpl = fetch,
		timeout = false,
		...baseInit
	} = options;
	const signal = baseInit.signal as AbortSignal | undefined;

	for (let attempt = 0; ; attempt++) {
		if (signal?.aborted) throw new Error("Request was aborted");
		const requestUrl = typeof url === "function" ? url(attempt) : url;
		// `timeout` is destructured out of `baseInit`, so forward it to the underlying
		// fetch on the no-`prepareInit` path too. Without this, callers that pass
		// `timeout: false` (every streaming provider, to disable Bun's native ~300s
		// fetch ceiling in favor of their own first-event/idle watchdog) had it
		// silently dropped, so long-running streams were killed at ~300s (issue #602).
		// Only forward when the caller actually set `timeout`, so callers that never
		// set it keep Bun's default ceiling.
		const init = prepareInit
			? mergeInit(baseInit, await prepareInit(attempt), timeout)
			: "timeout" in options
				? ({ ...baseInit, timeout } as unknown as RequestInit)
				: baseInit;

		let response: Response;
		try {
			response = await fetchImpl(requestUrl, init);
		} catch (error) {
			if (signal?.aborted) throw new Error("Request was aborted");
			const wrapped = wrapNetworkError(error);
			if (attempt + 1 >= maxAttempts) throw wrapped;
			await waitForRetry(resolveDefaultDelay(defaultDelayMs, attempt, maxDelayMs), signal);
			continue;
		}

		if (!isRetryableStatus(response.status)) return response;
		if (attempt + 1 >= maxAttempts) return response;

		const retryBody = await response.clone().text();
		if (shouldRetryResponse && !(await shouldRetryResponse(response, retryBody, attempt))) return response;

		const hint = extractRetryHint(response, retryBody);
		if (hint !== undefined && hint > maxDelayMs) return response;

		const delayMs = Math.min(hint ?? resolveDefaultDelay(defaultDelayMs, attempt, maxDelayMs), maxDelayMs);
		// The retried response is discarded; release its unread tee branch.
		if (!response.bodyUsed) response.body?.cancel().catch(() => {});
		await waitForRetry(delayMs, signal);
	}
}

function mergeInit(base: RequestInit, overlay: RequestInit, timeout: number | false): RequestInit {
	const merged = { ...base, ...overlay, timeout } as unknown as RequestInit;
	if (base.headers || overlay.headers) {
		const baseHeaders = new Headers(base.headers ?? undefined);
		const overlayHeaders = new Headers(overlay.headers ?? undefined);
		overlayHeaders.forEach((value, key) => {
			baseHeaders.set(key, value);
		});
		merged.headers = baseHeaders;
	}
	return merged;
}

async function waitForRetry(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
	try {
		await scheduler.wait(delayMs, { signal });
	} catch (error) {
		if (signal?.aborted) throw new Error("Request was aborted");
		throw error;
	}
}

function wrapNetworkError(error: unknown): Error {
	if (error instanceof Error) {
		if (error.name === "AbortError" || error.message === "Request was aborted") {
			return new Error("Request was aborted");
		}
		if (error.message === "fetch failed" && error.cause instanceof Error) {
			// Keep the original rejection as `cause`: undici nests the errno under
			// `fetch failed` (often through an AggregateError), and
			// classifyNetworkCause (packages/ai/src/error/network-cause.ts) walks
			// `cause`/`errors` off this error. Flattening to text alone loses it.
			return new Error(`Network error: ${error.cause.message}`, { cause: error });
		}
		return error;
	}
	return new Error(String(error));
}

function resolveDefaultDelay(
	option: FetchWithRetryOptions["defaultDelayMs"],
	attempt: number,
	maxDelayMs: number,
): number {
	if (option === undefined) return Math.min(500 * 2 ** attempt, maxDelayMs);
	if (typeof option === "number") return Math.min(option, maxDelayMs);
	if (typeof option === "function") return Math.min(option(attempt), maxDelayMs);
	return Math.min(option[Math.min(attempt, option.length - 1)] ?? 0, maxDelayMs);
}

/**
 * Inspect an arbitrary error value (or its `cause` chain, up to depth 2) for an
 * HTTP status code. Reads `status`, `statusCode`, and `response.status` fields,
 * coerces string values, and falls back to scanning the error message for
 * common patterns like `Error: 401`, `error (429)`, or `HTTP 503`.
 */
export function extractHttpStatusFromError(error: unknown): number | undefined {
	return extractHttpStatusFromErrorInternal(error, 0);
}

type HttpErrorLike = {
	message?: string;
	name?: string;
	status?: number | string;
	statusCode?: number | string;
	response?: { status?: number | string };
	cause?: unknown;
};

function extractHttpStatusFromErrorInternal(error: unknown, depth: number): number | undefined {
	if (!error || typeof error !== "object" || depth > 2) return undefined;
	const info = error as HttpErrorLike;
	const rawStatus = info.status ?? info.statusCode ?? info.response?.status;

	let status: number | undefined;
	if (typeof rawStatus === "number" && Number.isFinite(rawStatus)) {
		status = rawStatus;
	} else if (typeof rawStatus === "string") {
		const parsed = Number(rawStatus);
		if (Number.isFinite(parsed)) status = parsed;
	}
	if (status !== undefined && status >= 100 && status <= 599) return status;

	if (info.message) {
		const extracted = extractStatusFromMessage(info.message);
		if (extracted !== undefined) return extracted;
	}
	if (info.cause) return extractHttpStatusFromErrorInternal(info.cause, depth + 1);
	return undefined;
}

const STATUS_MESSAGE_PATTERNS = [
	/\berror\s*[:=]\s*(\d{3})\b/i,
	/error\s*\((\d{3})\)/i,
	/status\s*[:=]?\s*(\d{3})/i,
	/\bhttp\s*(\d{3})\b/i,
	/\b(\d{3})\s*(?:status|error)\b/i,
] as const;

function extractStatusFromMessage(message: string): number | undefined {
	for (const pattern of STATUS_MESSAGE_PATTERNS) {
		const match = pattern.exec(message);
		if (!match) continue;
		const value = Number(match[1]);
		if (Number.isFinite(value) && value >= 100 && value <= 599) return value;
	}
	return undefined;
}

/**
 * `true` if the given HTTP status code is one we treat as transient: 408
 * (Request Timeout), 429 (Too Many Requests), or any 5xx (server error).
 */
export function isRetryableStatus(status: number): boolean {
	return status >= 500 || status === 408 || status === 429;
}

/**
 * `true` if the message describes an unexpected socket closure — Bun and some
 * proxies surface these for any HTTP/2 stream reset.
 */
export function isUnexpectedSocketCloseMessage(message: string): boolean {
	return (
		/\b(?:the\s+)?socket connection (?:was )?closed unexpectedly\b/i.test(message) ||
		/^(?:error:\s*)?socket is closed\.?$/i.test(message.trim())
	);
}

const TRANSIENT_MESSAGE_PATTERN =
	/overloaded|rate.?limit|too many requests|service.?unavailable|server error|internal error|connection.?error|unable to connect|fetch failed|network error|stream stall|other side closed|HTTP2(?:StreamReset|RefusedStream|EnhanceYourCalm)/i;

const VALIDATION_MESSAGE_PATTERN =
	/invalid|validation|bad request|unsupported|schema|missing required|not found|unauthorized|forbidden/i;

/**
 * Identify errors that should be retried: aborts/timeouts in the error name or
 * message, retryable HTTP statuses (see `isRetryableStatus`), unexpected socket
 * closes, and the standard transient phrases. 4xx statuses other than 408/429
 * and validation-shaped messages short-circuit to `false`.
 */
export function isRetryableError(error: unknown): boolean {
	const info = error as { message?: string; name?: string } | null;
	const message = info?.message ?? "";
	const name = info?.name ?? "";
	if (name === "AbortError" || /timeout|timed out|aborted/i.test(message)) return true;

	const status = extractHttpStatusFromError(error);
	if (status !== undefined) {
		if (isRetryableStatus(status)) return true;
		if (status >= 400 && status < 500) return false;
	}

	if (VALIDATION_MESSAGE_PATTERN.test(message)) return false;
	return isUnexpectedSocketCloseMessage(message) || TRANSIENT_MESSAGE_PATTERN.test(message);
}
