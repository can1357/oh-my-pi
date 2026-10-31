/**
 * Two readings of the retry wait an error's text names. `extractProviderRetryHint`
 * is how long a route or credential stays closed — credential blocks,
 * usage-limit marks, one-shot retries, the session's retry delay — and reads
 * the first occurrence of each hint form plus the header wait the formatter
 * appended last. `longestProviderRetryHint` reads every occurrence, and only
 * turn recovery's held-retry check uses it, where it can only decline a hold.
 */
import { describe, expect, it } from "bun:test";
import {
	extractProviderRetryHint,
	formatErrorMessageWithRetryAfter,
	longestProviderRetryHint,
} from "@oh-my-pi/pi-ai/utils/retry-after";

/** Bodies that quote a longer number than the response's own wait. */
const QUOTED_LONGER = [
	["an echoed prompt", 'usage_limit_reached retry-after-ms=200 echoed {"prompt":"retry-after-ms=86400000"}'],
	["a URL query", "usage_limit_reached retry-after-ms=200 see https://h.invalid/?retry-after-ms=86400000"],
	["a later separated hint", "usage_limit_reached retry-after-ms=200; upstream: retry-after-ms=9000;"],
	["a quoted upstream counter", "x-ratelimit-reset=1 upstream said x-ratelimit-reset=9000."],
	["a later absurd value", "retry-after-ms=200 upstream said retry-after-ms=999999999999999999999999."],
] as const;

describe("extractProviderRetryHint", () => {
	it.each(QUOTED_LONGER)("does not take a quoted number for the wait in %s", (_label, message) => {
		// A durable block lasts as long as this reading. Searching every occurrence
		// read the echoed prompt's 86,400,000 ms and blocked a credential for a day.
		expect(extractProviderRetryHint("anthropic", message)).toBe(message.startsWith("x-ratelimit") ? 1000 : 200);
	});

	it.each([
		["one hint", "read ECONNRESET retry-after-ms=400", 400],
		["two forms, the longer one counted", "try again in 2s retry-after-ms=9000", 9000],
		[
			"the formatter's trailing header wait after a shorter body hint",
			"read ECONNRESET retry-after-ms=200 retry-after-ms=9000",
			9000,
		],
	] as [string, string, number][])("reads %s", (_label, message, expected) => {
		expect(extractProviderRetryHint("anthropic", message)).toBe(expected);
	});

	it("keeps an explicit retry-now as zero and a message with no hint as unknown", () => {
		expect(extractProviderRetryHint("anthropic", "overloaded retry-after-ms=0")).toBe(0);
		expect(extractProviderRetryHint("anthropic", "overloaded")).toBeUndefined();
	});
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
		["a zero body hint and a Retry-After", "read ECONNRESET retry-after-ms=0", { "retry-after": "9" }, 9000],
		["a malformed body hint and a Retry-After", "read ECONNRESET retry-after-ms=oops", { "retry-after": "9" }, 9000],
	] as [string, string, Record<string, string>, number][])(
		"keeps the header wait over %s",
		(_label, message, headers, expected) => {
			// A zero or unreadable body hint names no wait the header could stand
			// behind; the header's wait is the one the server gave.
			const formatted = formatErrorMessageWithRetryAfter(new Error(message), headers);
			expect(extractProviderRetryHint("anthropic", formatted)).toBe(expected);
		},
	);

	it.each([
		[
			"a shorter body hint and a longer Retry-After",
			"read ECONNRESET retry-after-ms=200",
			{ "retry-after": "9" },
			9000,
		],
		[
			"a shorter body hint and a longer retry-after-ms header",
			"usage_limit_reached retry-after-ms=200",
			{ "retry-after-ms": "9000" },
			9000,
		],
		["a longer body hint and a shorter header", "read ECONNRESET retry-after-ms=9000", { "retry-after": "1" }, 9000],
		["no body hint", "read ECONNRESET", { "retry-after": "9" }, 9000],
	] as [string, string, Record<string, string>, number][])(
		"keeps the longest wait for %s",
		(_label, message, headers, expected) => {
			// A hint already in the message used to end the formatting, so a longer
			// header wait never reached the readers and every consumer — credential
			// blocks, one-shot retries, turn recovery — retried at the shorter one.
			const formatted = formatErrorMessageWithRetryAfter(new Error(message), headers);
			expect(extractProviderRetryHint("anthropic", formatted)).toBe(expected);
		},
	);

	it("does not repeat a header wait the message already covers", () => {
		const message = "read ECONNRESET retry-after-ms=9000";
		expect(formatErrorMessageWithRetryAfter(new Error(message), { "retry-after": "9" })).toBe(message);
	});
});
