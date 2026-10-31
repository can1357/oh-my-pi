/**
 * Three readings of a failure's retry wait.
 *
 * - `extractProviderRetryHint` reads the message text: the first occurrence of
 *   each hint form. No position in the text is trusted as anyone's but the
 *   body's, because a body can write any text.
 * - `providerRetryWaitMs` is what every caller that keeps a route or credential
 *   closed uses: the text reading and the response headers' wait, passed in
 *   structured (`AssistantMessage.errorRetryAfterMs`), whichever is longer.
 * - `longestProviderRetryHint` reads every occurrence, and only turn recovery's
 *   held-retry check uses it, where it can only decline a hold.
 */
import { describe, expect, it } from "bun:test";
import {
	extractProviderRetryHint,
	formatErrorMessageWithRetryAfter,
	getRetryAfterMsFromHeaders,
	longestProviderRetryHint,
	providerRetryWaitMs,
} from "@oh-my-pi/pi-ai/utils/retry-after";

const MAX_VALUE_DIGITS = BigInt(Number.MAX_VALUE).toString();

/** Bodies that quote a longer number than the response's own first wait. */
const QUOTED_LONGER = [
	["an echoed prompt", 'usage_limit_reached retry-after-ms=200 echoed {"prompt":"retry-after-ms=86400000"}', 200],
	["a URL query", "usage_limit_reached retry-after-ms=200 see https://h.invalid/?retry-after-ms=86400000", 200],
	["a later separated hint", "usage_limit_reached retry-after-ms=200; upstream: retry-after-ms=9000;", 200],
	["a quoted counter", "x-ratelimit-reset=1 upstream said x-ratelimit-reset=9000.", 1000],
	// A body may end with a hint of its own; the final position proves nothing.
	[
		"a plain-text body ending in a longer hint",
		"usage_limit_reached retry-after-ms=200\nUpstream diagnostic: retry-after-ms=86400000",
		200,
	],
	[
		"a body ending in a quoted upstream hint",
		"retry-after-ms=200; quoted upstream response: retry-after-ms=9000",
		200,
	],
	[
		"a body ending in the largest finite number",
		`retry-after-ms=200 upstream retry-after-ms=${MAX_VALUE_DIGITS}`,
		200,
	],
] as const;

describe("extractProviderRetryHint", () => {
	it.each(QUOTED_LONGER)("reads the body's first wait, not a later one, in %s", (_label, message, expected) => {
		// A durable block lasts as long as the reading built on this. A later
		// number — quoted, echoed, or simply the body's last word — once blocked a
		// credential for a day, and at the final position for 1.8e308 ms.
		expect(extractProviderRetryHint("anthropic", message)).toBe(expected);
	});

	it.each([
		["one hint", "read ECONNRESET retry-after-ms=400", 400],
		["two forms, the longer one counted", "try again in 2s retry-after-ms=9000", 9000],
	] as [string, string, number][])("reads %s", (_label, message, expected) => {
		expect(extractProviderRetryHint("anthropic", message)).toBe(expected);
	});

	it("keeps an explicit retry-now as zero and a message with no hint as unknown", () => {
		expect(extractProviderRetryHint("anthropic", "overloaded retry-after-ms=0")).toBe(0);
		expect(extractProviderRetryHint("anthropic", "overloaded")).toBeUndefined();
	});
});

describe("providerRetryWaitMs", () => {
	it.each([
		["a longer header wait behind a shorter body hint", "usage_limit_reached retry-after-ms=200", 9000, 9000],
		["a shorter header wait behind a longer body hint", "usage_limit_reached retry-after-ms=9000", 200, 9000],
		["a header wait and no body hint", "usage_limit_reached", 9000, 9000],
		["a header wait behind a zero body hint", "usage_limit_reached retry-after-ms=0", 9000, 9000],
		["a header wait behind a malformed body hint", "usage_limit_reached retry-after-ms=oops", 9000, 9000],
		["no header wait", "usage_limit_reached retry-after-ms=200", undefined, 200],
		[
			"a short header wait behind a body that ends in a longer hint",
			"usage_limit_reached retry-after-ms=200\nUpstream diagnostic: retry-after-ms=86400000",
			200,
			200,
		],
	] as [string, string, number | undefined, number][])(
		"takes the longer of text and header for %s",
		(_label, message, header, expected) => {
			// The header's wait arrives from the response object; no text can stand
			// in for it, and no text can lengthen it.
			expect(providerRetryWaitMs("anthropic", message, header)).toBe(expected);
		},
	);
});

describe("longestProviderRetryHint", () => {
	it.each([
		["two retry-after-ms values, shorter first", "read ECONNRESET retry-after-ms=200 retry-after-ms=9000", 9000],
		["two retry-after-ms values, longer first", "read ECONNRESET retry-after-ms=9000 retry-after-ms=200", 9000],
		["two try-again durations", "read ECONNRESET try again in 200ms; try again in 9000ms", 9000],
		["an echoed prompt", 'retry-after-ms=200 echoed {"prompt":"retry-after-ms=86400000"}', 86_400_000],
	] as [string, string, number][])("reads the longest wait in %s", (_label, message, expected) => {
		// The held-retry check declines the hold when any wait the message names
		// reaches past the held window; a quoted number here costs one chain
		// consult, never a longer wait.
		expect(longestProviderRetryHint("anthropic", message)).toBe(expected);
	});
});

describe("formatErrorMessageWithRetryAfter", () => {
	it.each([
		["a shorter body hint", "read ECONNRESET retry-after-ms=200", { "retry-after": "9" }, true],
		["a zero body hint", "read ECONNRESET retry-after-ms=0", { "retry-after": "9" }, true],
		["a malformed body hint", "read ECONNRESET retry-after-ms=oops", { "retry-after": "9" }, true],
		["no body hint", "read ECONNRESET", { "retry-after": "9" }, true],
		["a longer body hint", "read ECONNRESET retry-after-ms=9000", { "retry-after": "1" }, false],
	] as [string, string, Record<string, string>, boolean][])(
		"shows the header wait to the reader over %s",
		(_label, message, headers, shown) => {
			// The text is for the person reading it; the wait itself reaches readers
			// structured, so whatever the text says, the header's 9 s is kept.
			const formatted = formatErrorMessageWithRetryAfter(new Error(message), headers);
			expect(formatted).toBe(shown ? `${message} retry-after-ms=9000` : message);
			expect(providerRetryWaitMs("anthropic", formatted, getRetryAfterMsFromHeaders(headers))).toBe(9000);
		},
	);
});
