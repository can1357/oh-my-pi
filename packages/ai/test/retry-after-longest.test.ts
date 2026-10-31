/**
 * `extractProviderRetryHint` is how long a route or credential stays closed for
 * every caller that reads an error's text: credential blocks, usage-limit
 * marks, and turn recovery's held retry, which declines a hint longer than its
 * window. A message can name its wait more than once; the longest counts.
 */
import { describe, expect, it } from "bun:test";
import { extractProviderRetryHint } from "@oh-my-pi/pi-ai/utils/retry-after";

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
