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
import { describe, expect, it, vi } from "bun:test";
import { withRetryAfterHeaders } from "@oh-my-pi/pi-ai/auth-gateway/http";
import { extractRetryHint, longestRetryHint } from "@oh-my-pi/pi-utils";
import {
	extractProviderRetryHint,
	appendRetryAfterHint,
	getFailureRetryAfterMs,
	getRetryAfterMsFromHeaders,
	retryWaitHeaders,
	retryWaitBounds,
	longestProviderRetryHint,
	providerFailureWaitMs,
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
		expect(retryWaitBounds(Number.NaN, 60_000).maxDelayMs).toBe(60_000);
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

describe("providerFailureWaitMs", () => {
	it("reads a thrown failure's own header wait beside its message's relative wait, the longer winning", () => {
		const error = Object.assign(new Error("429 rate limited, try again in 2s"), { headers: { "retry-after": "9" } });
		expect(providerFailureWaitMs("anthropic", error)).toBe(9_000);
		expect(providerFailureWaitMs("anthropic", error, { message: "429 rate limited, try again in 20s" })).toBe(20_000);
	});

	it("takes a header wait the caller already holds over the failure's own headers", () => {
		// A credential rotation or an advisor holding the failed message's
		// `errorRetryAfterMs` passes it; the thrown error's headers do not override it.
		const error = Object.assign(new Error("429"), { headers: { "retry-after": "9" } });
		expect(providerFailureWaitMs("anthropic", error, { retryAfterMs: 1_000 })).toBe(1_000);
	});
});

/** What each of the three header readers takes from `headers`: `fetchWithRetry`'s, the held-retry check's, and the failed message's. */
function threeReaders(headers: Record<string, string>): (number | undefined)[] {
	return [
		extractRetryHint(new Headers(headers)),
		longestRetryHint(new Headers(headers)),
		getRetryAfterMsFromHeaders(headers),
	];
}

const DECIMAL_COMMA_ISO = "2026-10-21T09:27:00,900+02:00";

function withFixedNow<T>(now: string, read: () => T): T {
	const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(now));
	try {
		return read();
	} finally {
		clock.mockRestore();
	}
}

describe("an explicit zero wait beside a window reset", () => {
	it("is read as retry now, not as the window's end", () => {
		// `fetchWithRetry` reads `Retry-After: 0` as an immediate retry; the
		// failed message and the transport's decline must read the same.
		const headers = { "retry-after": "0", "x-ratelimit-reset": "7200" };
		expect(getRetryAfterMsFromHeaders(headers)).toBe(0);
		expect(extractRetryHint(new Headers(headers))).toBe(0);
		expect(getRetryAfterMsFromHeaders({ "retry-after-ms": "0", "x-ratelimit-reset-ms": "7200000" })).toBe(0);
		expect(retryWaitBounds(undefined, 60_000).declines(headers)).toBe(false);
	});

	it.each([
		["a radix prefix", "0x0"],
		["a sign", "-0"],
		["an exponent", "0e0"],
		["a blank value", " "],
		["a trailing empty part", "0,"],
		["two numbers and a slash", "0/1"],
	])("is not stated by %s (%j), so the window reset stands", (_label, value) => {
		// RFC 9110 §10.2.3: delay-seconds is digits, and a date is an HTTP-date
		// or an ISO date-time. Each row breaks one of those rules a reader once
		// let through: `Number()` reads the first three as zero, and the date
		// parser read `0,` and `0/1` as 1 Jan 2000, an elapsed date. Either way
		// the value read as "retry now" and hid a one-hour reset.
		for (const name of ["retry-after", "retry-after-ms"]) {
			const headers = { [name]: value, "x-ratelimit-reset": "3600" };
			expect(threeReaders(headers)).toEqual([3_600_000, 3_600_000, 3_600_000]);
			expect(retryWaitBounds(undefined, 60_000).declines(headers)).toBe(true);
		}
	});
});

describe("retry-after-ms beside Retry-After", () => {
	it("reads the auth gateway's exact retry-after-ms, not its Retry-After rounded up to whole seconds", () => {
		// The gateway restates a 200 ms wait as `retry-after-ms: 200` and
		// `Retry-After: 1`. The two state one wait; the longer of them is 1 s.
		const headers = Object.fromEntries(withRetryAfterHeaders(new Response(null, { status: 429 }), 200).headers);
		expect(threeReaders(headers)).toEqual([200, 200, 200]);
		expect(getFailureRetryAfterMs(new Error("socket closed"), { streamResponseHeaders: headers })).toBe(200);
	});

	it("reads Retry-After when retry-after-ms states no wait", () => {
		const headers = { "retry-after-ms": "0x0", "retry-after": "9" };
		expect(threeReaders(headers)).toEqual([9_000, 9_000, 9_000]);
		expect(getFailureRetryAfterMs(new Error("socket closed"), { streamResponseHeaders: headers })).toBe(9_000);
	});
});

describe("Retry-After comma values", () => {
	it("reads an ISO date-time's decimal comma as its 900 ms fraction in all three readers", () => {
		// An ISO date-time is not a joined delay list. Its decimal comma is read
		// as a decimal point: 900 ms, not the UTC+02:00 offset (two hours).
		const waits = withFixedNow("2026-10-21T07:27:00.000Z", () => threeReaders({ "retry-after": DECIMAL_COMMA_ISO }));
		expect(waits).toEqual([900, 900, 900]);
	});

	it("reads an HTTP-date, which holds a comma of its own, in all three readers", () => {
		const date = new Date(Math.ceil((Date.now() + 60_000) / 1_000) * 1_000).toUTCString();
		for (const ms of threeReaders({ "retry-after": date })) {
			expect(ms).toBeGreaterThan(55_000);
			expect(ms).toBeLessThanOrEqual(61_000);
		}
	});

	it.each([
		["two joined delay-seconds", "retry-after", "9, 120", 120_000],
		["a decimal delay-seconds part", "retry-after", "9.125, 9", 9_125],
		["two joined retry-after-ms values", "retry-after-ms", "100, 9000", 9_000],
	] as [string, string, string, number][])("%s reads the longest part", (_label, name, value, expected) => {
		// Two joined header lines contradict each other; conservatively wait for the longer one.
		expect(threeReaders({ [name]: value })).toEqual([expected, expected, expected]);
	});

	it.each([
		["Retry-After", "1761038820, 900"],
		["retry-after-ms", "1761038820000, 900"],
	])("does not split %s %j, whose epoch-sized part is no delay, and reads no wait", (name, value) => {
		// A bare epoch with a decimal comma has all-digit parts. Split, it read
		// as 55.8 years, which `errorRetryAfterMs` carried into a seven-day
		// credential block. Main reads it as no wait, and so does this reader.
		expect(threeReaders({ [name]: value })).toEqual([undefined, undefined, undefined]);
	});

	it("does not partly split a comma value when one part is not delay-seconds", () => {
		expect(threeReaders({ "retry-after": "9, 120ms" })).toEqual([undefined, undefined, undefined]);
	});
});

describe("a window reset is read in one unit by all three readers", () => {
	it("reads x-ratelimit-reset: 9 as 9 s", () => {
		expect(threeReaders({ "x-ratelimit-reset": "9" })).toEqual([9_000, 9_000, 9_000]);
	});

	it("reads an epoch-millisecond x-ratelimit-reset nine seconds out as about 9 s", () => {
		const epochMs = String(Date.now() + 9_000);
		for (const ms of threeReaders({ "x-ratelimit-reset": epochMs })) {
			expect(ms).toBeGreaterThan(8_000);
			expect(ms).toBeLessThanOrEqual(9_000);
		}
	});

	it("reads an epoch-second x-ratelimit-reset as the time left to it", () => {
		const epochSeconds = String(Math.ceil((Date.now() + 9_000) / 1_000));
		for (const ms of threeReaders({ "x-ratelimit-reset": epochSeconds })) {
			expect(ms).toBeGreaterThan(7_000);
			expect(ms).toBeLessThanOrEqual(10_000);
		}
	});
});
