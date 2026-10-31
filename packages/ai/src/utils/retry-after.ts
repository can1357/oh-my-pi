import { retryResetTimezoneOffsetFor } from "@oh-my-pi/pi-catalog/compat/behavior";
import { extractRetryHint, longestRetryHint } from "@oh-my-pi/pi-utils";

export type HeadersLike = Headers | Record<string, string | undefined> | undefined | null;

const RETRY_AFTER_HINT = "retry-after-ms=";

/**
 * The header wait {@link formatErrorMessageWithRetryAfter} carries: the final
 * token of the message, `<message> retry-after-ms=<n>`. Only that position is
 * read as the formatter's, so a `retry-after-ms=` inside a quoted body or a URL
 * is not taken for it.
 */
const FORMATTED_HEADER_WAIT_PATTERN = /\sretry-after-ms=(\d+(?:\.\d+)?)$/;

function formattedHeaderWaitMs(message: string): number | undefined {
	const match = FORMATTED_HEADER_WAIT_PATTERN.exec(message);
	if (!match) return undefined;
	const ms = Number(match[1]);
	return Number.isFinite(ms) ? ms : undefined;
}

function hintOptions(provider: string | undefined) {
	return { naiveResetTimezoneOffset: provider === undefined ? undefined : retryResetTimezoneOffsetFor(provider) };
}

/**
 * The retry wait `message` names, read in the provider's catalog-declared
 * timestamp timezone: the first occurrence of each hint form, the longest
 * across forms ({@link extractRetryHint}), and the header wait the formatter
 * appended as the message's final token, whichever is longer.
 *
 * This is the reading for every caller that keeps a route or credential closed
 * for the wait — a credential block, a usage-limit mark, a one-shot retry, the
 * session's retry delay. It deliberately does not search every occurrence: a
 * body can quote other text, and a number inside an echoed prompt or a quoted
 * upstream body is not this response's wait. Read as one, `retry-after-ms=200`
 * followed by an echoed `retry-after-ms=86400000` blocked a credential for a
 * day. Only turn recovery's held-retry check needs every occurrence, and it can
 * only decline a hold ({@link longestProviderRetryHint}).
 */
export function extractProviderRetryHint(
	provider: string | undefined,
	message: string | undefined,
): number | undefined {
	const first = extractRetryHint(undefined, message, hintOptions(provider));
	const header = message === undefined ? undefined : formattedHeaderWaitMs(message);
	if (header === undefined) return first;
	return first === undefined ? header : Math.max(first, header);
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
 * `error`'s message with the response headers' retry wait appended as its final
 * token, `retry-after-ms=<n>`, so {@link extractProviderRetryHint} reads the
 * header timing from the text. A hint the message already carries does not
 * stand in for a longer header wait: it is appended unless the message's own
 * reading is already at least as long. Returning early on any `retry-after-ms=`
 * dropped `Retry-After: 9` behind a body's `retry-after-ms=200`, and every
 * consumer retried at 200 ms.
 */
export function formatErrorMessageWithRetryAfter(error: unknown, headers?: HeadersLike): string {
	const message = error instanceof Error ? error.message : JSON.stringify(error);
	const retryAfterMs = getRetryAfterMsFromHeaders(headers ?? getHeadersFromError(error));
	if (retryAfterMs === undefined) return message;
	const named = extractProviderRetryHint(undefined, message);
	if (named !== undefined && named >= retryAfterMs) return message;
	return `${message} ${RETRY_AFTER_HINT}${retryAfterMs}`;
}

export function getRetryAfterMsFromHeaders(headers: HeadersLike): number | undefined {
	if (!headers) return undefined;

	const retryAfterMs = parseRetryAfterMsHeader(getHeaderValue(headers, "retry-after-ms"));
	const retryAfter = parseRetryAfterHeader(getHeaderValue(headers, "retry-after"));
	const resetMs = parseResetHeader(getHeaderValue(headers, "x-ratelimit-reset-ms"), "ms");
	const resetSeconds = parseResetHeader(getHeaderValue(headers, "x-ratelimit-reset"), "s");

	const candidates = [retryAfterMs, retryAfter, resetMs, resetSeconds].filter(
		(value): value is number => value !== undefined,
	);
	if (candidates.length === 0) return undefined;
	return Math.max(...candidates);
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

	const dateMs = Date.parse(trimmed);
	if (!Number.isNaN(dateMs)) {
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
