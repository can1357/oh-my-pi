/**
 * `extractProviderRetryHint` is how long a route or credential stays closed for
 * every caller that reads an error's text: credential blocks, usage-limit
 * marks, and turn recovery's held retry, which declines a hint longer than its
 * window. A message can name its wait more than once; the longest counts.
 */
import { describe, expect, it } from "bun:test";
import { extractProviderRetryHint, formatErrorMessageWithRetryAfter } from "@oh-my-pi/pi-ai/utils/retry-after";

describe("extractProviderRetryHint", () => {
	it.each([
		["two retry-after-ms values, shorter first", "read ECONNRESET retry-after-ms=200 retry-after-ms=9000", 9000],
		["two retry-after-ms values, longer first", "read ECONNRESET retry-after-ms=9000 retry-after-ms=200", 9000],
		["two try-again durations", "read ECONNRESET try again in 200ms; try again in 9000ms", 9000],
		["a try-again duration and a longer retry-after-ms", "try again in 2s retry-after-ms=9000", 9000],
		["one hint", "read ECONNRESET retry-after-ms=400", 400],
	] as [string, string, number][])("takes the longest wait in %s", (_label, message, expected) => {
		expect(extractProviderRetryHint("anthropic", message)).toBe(expected);
	});

	it("keeps an explicit retry-now as zero and a message with no hint as unknown", () => {
		expect(extractProviderRetryHint("anthropic", "overloaded retry-after-ms=0")).toBe(0);
		expect(extractProviderRetryHint("anthropic", "overloaded")).toBeUndefined();
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
