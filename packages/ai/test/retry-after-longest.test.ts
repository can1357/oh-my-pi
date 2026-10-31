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
	appendRetryAfterHint,
	getFailureRetryAfterMs,
	getRetryAfterMsFromHeaders,
	retryWaitHeaders,
	transportRetryBounds,
	longestProviderRetryHint,
	providerRetryWaitMs,
} from "@oh-my-pi/pi-ai/utils/retry-after";
import { type RefusedRetryWait, refusedRetryWaitNote } from "@oh-my-pi/pi-ai/utils/retry-wait";

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

	it("does not let a zone-less date in the body outrank the header's wait", () => {
		// A date with no zone in a body is a wall clock in a zone nothing names;
		// read as UTC it gave eight hours where the header said 750 ms. It is no
		// wait at all.
		const naive = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
		const message = `Service temporarily unavailable; reset at ${naive}`;
		expect(providerRetryWaitMs("openai-codex", message, 750)).toBe(750);
		expect(extractProviderRetryHint("openai-codex", message)).toBeUndefined();
		// An explicit relative wait in the body still counts, the longer one winning.
		expect(providerRetryWaitMs("openai-codex", `${message}. Please try again in 9s.`, 750)).toBe(9000);
	});

	it("ranks the header's wait above a zoned date in the body", () => {
		// The two are not equally trustworthy: the header is the response's own
		// instruction, the date is text the server may have rendered in any way.
		const zoned = new Date(Date.now() + 8 * 3_600_000).toISOString();
		const message = `Service temporarily unavailable; reset at ${zoned}`;
		expect(providerRetryWaitMs("openai-codex", message, 750)).toBe(750);
		// With no header, the zoned date is the wait.
		expect(providerRetryWaitMs("openai-codex", message, undefined)).toBeGreaterThan(7 * 3_600_000);
	});
});

describe("getRetryAfterMsFromHeaders", () => {
	it("reads a zone-less Retry-After date as GMT, not in this machine's zone", () => {
		const originalTz = process.env.TZ;
		process.env.TZ = "America/Los_Angeles";
		try {
			const expected = Date.UTC(2099, 8, 1, 9, 44, 51) - Date.now();
			for (const value of ["Tue, 01 Sep 2099 09:44:51", "2099-09-01T09:44:51", "Tue, 01 Sep 2099 09:44:51 GMT"]) {
				const wait = getRetryAfterMsFromHeaders({ "retry-after": value });
				expect(Math.abs(wait! - expected)).toBeLessThan(1000);
			}
		} finally {
			process.env.TZ = originalTz;
		}
	});

	it.each([
		["an epoch x-ratelimit-reset", () => ({ "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600) })],
		["an epoch x-ratelimit-reset-ms", () => ({ "x-ratelimit-reset-ms": String(Date.now() + 3_600_000) })],
		["a relative x-ratelimit-reset-ms", () => ({ "x-ratelimit-reset-ms": "86400000" })],
	] as [string, () => Record<string, string>][])(
		"takes an explicit Retry-After over %s on the same response",
		(_label, reset) => {
			// "Retry in 1 second" is an instruction; a window reset is when capacity
			// returns. Taking the longer turned the 1 s into hours and a dead turn.
			expect(getRetryAfterMsFromHeaders({ "retry-after": "1", ...reset() })).toBe(1000);
			expect(getRetryAfterMsFromHeaders({ "retry-after-ms": "750", ...reset() })).toBe(750);
			// With nothing telling the client to wait, the reset is the fallback.
			expect(getRetryAfterMsFromHeaders(reset())).toBeGreaterThan(3_000_000);
		},
	);
});

describe("getFailureRetryAfterMs", () => {
	it("reads the error's own wait when the captured response's headers name none", () => {
		const error = Object.assign(new Error("429"), { headers: { "retry-after-ms": "30000" } });
		expect(getFailureRetryAfterMs(error, { errorResponseHeaders: { "content-type": "application/json" } })).toBe(
			30000,
		);
		// And the error's own wait outranks the accepted response's.
		expect(
			getFailureRetryAfterMs(error, {
				errorResponseHeaders: { "content-type": "application/json" },
				streamResponseHeaders: { "retry-after-ms": "5000" },
			}),
		).toBe(30000);
	});
});

describe("wire restatement guards", () => {
	it("never restates a wait in exponent form", () => {
		expect(retryWaitHeaders(1e300)?.get("retry-after-ms")).toBe(String(Number.MAX_SAFE_INTEGER));
		expect(retryWaitHeaders(9000.5)?.get("retry-after-ms")).toBe("9001");
	});

	it("keeps the transport default when the cap is NaN", () => {
		expect(transportRetryBounds(Number.NaN, 60_000).maxDelayMs).toBe(60_000);
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

describe("appendRetryAfterHint", () => {
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
			const formatted = appendRetryAfterHint(message, headers);
			expect(formatted).toBe(shown ? `${message} retry-after-ms=9000` : message);
			expect(providerRetryWaitMs("anthropic", formatted, getRetryAfterMsFromHeaders(headers))).toBe(9000);
		},
	);
});

describe("a refused wait's note", () => {
	it.each([
		["the caller's ceiling", { option: "providerRetryWaitCeilingMs", limitMs: 10_000, waitMs: 15_000 }],
		["maxRetryDelayMs", { option: "maxRetryDelayMs", limitMs: 600_000, waitMs: 900_000 }],
	] as [string, RefusedRetryWait][])("names no wait the session's readers take, refused by %s", (_label, refused) => {
		// Turn recovery reads a wait out of the failed message's text. The note
		// restates the wait and names the bound; neither number may become one,
		// or the session would sleep the bound instead of the server's wait.
		const message = `429 Too many requests ${refusedRetryWaitNote(refused)}`;
		expect(providerRetryWaitMs("anthropic", message, undefined)).toBeUndefined();
		expect(longestProviderRetryHint("anthropic", message)).toBeUndefined();
	});
});
