import { afterEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import {
	extractRetryHint,
	fetchWithRetry,
	isUnexpectedSocketCloseMessage,
	longestRetryHint,
} from "@oh-my-pi/pi-utils/fetch-retry";

/** Await a rejection and narrow it to `Error` without asserting a shape. */
async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
	const value = await promise.then(
		() => undefined,
		(err: unknown) => err,
	);
	if (!(value instanceof Error)) throw new Error(`Expected a rejected Error, got ${String(value)}`);
	return value;
}

describe("isUnexpectedSocketCloseMessage", () => {
	it.each(["Socket is closed", "Error: Socket is closed.", "The socket connection was closed unexpectedly"])(
		"recognizes %s",
		message => expect(isUnexpectedSocketCloseMessage(message)).toBe(true),
	);

	it("does not match socket wording embedded in an application error", () => {
		expect(isUnexpectedSocketCloseMessage("validation failed because socket is closed to remote control")).toBe(
			false,
		);
	});
});

describe("fetchWithRetry", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("routes requests through the `fetch` override when provided", async () => {
		const calls: Array<{ input: string | URL | Request; init: RequestInit | undefined }> = [];
		const customFetch = async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ input, init });
			return new Response("ok", { status: 200 });
		};

		const response = await fetchWithRetry("https://example.invalid/x", {
			method: "POST",
			body: "hi",
			fetch: customFetch,
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("ok");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.input).toBe("https://example.invalid/x");
		expect(calls[0]?.init).toMatchObject({ method: "POST", body: "hi" });
	});

	it("retries through the override on transient failures", async () => {
		let attempt = 0;
		const customFetch = async () => {
			attempt += 1;
			if (attempt === 1) return new Response("", { status: 503 });
			return new Response("done", { status: 200 });
		};

		const response = await fetchWithRetry("https://example.invalid/y", {
			fetch: customFetch,
			defaultDelayMs: 1,
			maxAttempts: 3,
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("done");
		expect(attempt).toBe(2);
	});

	it("lets callers stop retries for deterministic response bodies", async () => {
		let attempt = 0;
		const customFetch = async () => {
			attempt += 1;
			return new Response("deterministic provider failure", { status: 500 });
		};

		const response = await fetchWithRetry("https://example.invalid/z", {
			fetch: customFetch,
			defaultDelayMs: 1,
			maxAttempts: 3,
			shouldRetryResponse: (_response, bodyText) => !bodyText.includes("deterministic"),
		});

		expect(response.status).toBe(500);
		expect(await response.text()).toBe("deterministic provider failure");
		expect(attempt).toBe(1);
	});

	it("returns retryable responses immediately when retry hints exceed the delay cap", async () => {
		let attempt = 0;
		const customFetch = async () => {
			attempt += 1;
			return new Response("slow down", { status: 429, headers: { "Retry-After": "3600" } });
		};

		const response = await fetchWithRetry("https://example.invalid/rate-limit", {
			fetch: customFetch,
			defaultDelayMs: 1,
			maxAttempts: 3,
			maxDelayMs: 10,
		});

		expect(response.status).toBe(429);
		expect(await response.text()).toBe("slow down");
		expect(attempt).toBe(1);
	});

	it("normalizes aborts during response backoff", async () => {
		const request = fetchWithRetry("https://example.invalid/response-backoff", {
			fetch: async () => new Response("retry", { status: 503 }),
			signal: AbortSignal.timeout(10),
			defaultDelayMs: 1_000,
			maxAttempts: 2,
		});

		await expect(request).rejects.toMatchObject({
			name: "Error",
			message: "Request was aborted",
		});
	});

	it("normalizes aborts during network-error backoff", async () => {
		const request = fetchWithRetry("https://example.invalid/network-backoff", {
			fetch: async () => {
				throw new TypeError("connection reset");
			},
			signal: AbortSignal.timeout(10),
			defaultDelayMs: 1_000,
			maxAttempts: 2,
		});

		await expect(request).rejects.toMatchObject({
			name: "Error",
			message: "Request was aborted",
		});
	});

	it("keeps the rejected fetch error reachable as the wrapped error's cause", async () => {
		const errno = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8080"), { code: "ECONNREFUSED" });
		const fetchFailed = new TypeError("fetch failed", { cause: new AggregateError([errno]) });

		const error = await rejectionOf(
			fetchWithRetry("http://127.0.0.1:8080/v1/chat/completions", {
				fetch: async () => {
					throw fetchFailed;
				},
				maxAttempts: 1,
			}),
		);

		// The AggregateError carries no message, so the flattened text alone names
		// no failure; downstream classifiers reach ECONNREFUSED only through `cause`.
		expect(error.cause).toBe(fetchFailed);
	});

	it("keeps the flattened `Network error:` wording for a direct cause", async () => {
		const dns = Object.assign(new Error("getaddrinfo ENOTFOUND api.openai.com"), { code: "ENOTFOUND" });
		const error = await rejectionOf(
			fetchWithRetry("https://api.openai.com/v1/chat/completions", {
				fetch: async () => {
					throw new TypeError("fetch failed", { cause: dns });
				},
				maxAttempts: 1,
			}),
		);

		expect(error.message).toBe("Network error: getaddrinfo ENOTFOUND api.openai.com");
	});

	/** `waitMs` from now as an ISO date-time in UTC+02:00 with a decimal comma before its fraction. */
	const isoCommaPlus2 = (waitMs: number) =>
		`${new Date(Date.now() + waitMs + 2 * 3_600_000).toISOString().slice(0, 19)},900+02:00`;

	it("retries a 429 whose Retry-After is an ISO date-time with a decimal comma 1 s out, instead of reading the zone offset as the wait", async () => {
		let calls = 0;
		const response = await fetchWithRetry("https://example.invalid/iso-comma", {
			fetch: async () => {
				calls++;
				return calls === 1
					? new Response("rate limited", { status: 429, headers: { "retry-after": isoCommaPlus2(1_000) } })
					: new Response("ok");
			},
			maxAttempts: 3,
		});

		// Treating the decimal comma as a list separator read the timestamp's
		// UTC+02:00 offset as a two-hour wait, so the default cap suppressed the retry.
		expect(calls).toBe(2);
		expect(response.status).toBe(200);
	});

	it("retries a 429 whose epoch-millisecond x-ratelimit-reset is 1 s out", async () => {
		let calls = 0;
		const response = await fetchWithRetry("https://example.invalid/epoch-ms-reset", {
			fetch: async () => {
				calls++;
				return calls === 1
					? new Response("rate limited", {
							status: 429,
							headers: { "x-ratelimit-reset": String(Date.now() + 1_000) },
						})
					: new Response("ok");
			},
			maxAttempts: 3,
		});

		// Read as epoch seconds, the value was 1.8e15 ms out and the 429 came back.
		expect(calls).toBe(2);
		expect(response.status).toBe(200);
	});

	it.each([
		["0x0", "a number that is no delay-seconds"],
		["0,", "a value no date grammar allows, which the date parser read as 1 Jan 2000"],
	])("returns a 429 at once when Retry-After: %s (%s) sits beside a one-hour window reset", async value => {
		let calls = 0;
		const response = await fetchWithRetry("https://example.invalid/no-wait-stated", {
			fetch: async () => {
				calls++;
				return new Response("rate limited", {
					status: 429,
					headers: { "retry-after": value, "x-ratelimit-reset": "3600" },
				});
			},
			maxAttempts: 3,
		});

		// The value states no wait, so the one-hour reset is the wait: past the cap.
		// Read as an elapsed date, `0,` was "retry now": 3 requests in 5 ms.
		expect(calls).toBe(1);
		expect(response.status).toBe(429);
	});

	it("sleeps the exact retry-after-ms, not the Retry-After beside it rounded up to whole seconds", async () => {
		// The auth gateway states a wait both ways: `retry-after-ms: 200` and
		// `Retry-After: 1`. Taking the longer of the two slept 1 s for 200 ms.
		const wait = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		let calls = 0;
		const response = await fetchWithRetry("https://example.invalid/gateway-wait", {
			fetch: async () => {
				calls++;
				return calls === 1
					? new Response("rate limited", { status: 429, headers: { "retry-after-ms": "200", "retry-after": "1" } })
					: new Response("ok");
			},
			maxAttempts: 3,
		});

		expect(response.status).toBe(200);
		expect(wait.mock.calls.map(([delayMs]) => delayMs)).toEqual([200]);
	});

	it.each([
		["a shorter header beside a longer relative body wait", "1", "busy. Please retry in 15s", 15_000],
		["a header retry-now beside a longer relative body wait", "0", "busy. Please retry in 15s", 15_000],
		["a longer header beside a shorter relative body wait", "15", "busy. Please retry in 1s", 15_000],
		[
			"a header beside a later body date",
			"1",
			`busy. Your limit will reset at ${new Date(Date.now() + 3_600_000).toISOString()}`,
			1_000,
		],
	] as [string, string, string, number][])(
		"sleeps the wait it reads from %s",
		async (_label, retryAfter, body, expected) => {
			// pi-ai's failed-message reader takes the longer of the header's wait and
			// the body's relative waits, never a body date beside a header. The
			// transport took the header alone: `Retry-After: 1` beside `retry in 15s`
			// slept 1 s where the failure read 15 s and a 10 s cap refused it.
			const wait = vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
			let calls = 0;
			await fetchWithRetry("https://example.invalid/header-and-body", {
				fetch: async () => {
					calls++;
					return calls === 1
						? new Response(body, { status: 503, headers: { "retry-after": retryAfter } })
						: new Response("ok");
				},
				maxAttempts: 3,
			});

			expect(wait.mock.calls.map(([delayMs]) => delayMs)).toEqual([expected]);
		},
	);
});

describe("extractRetryHint", () => {
	// Devin returns HTTP 403 with "Your limit will reset in 13 minutes" for an
	// account-scoped message rate cap. Without recognizing "will reset in", the
	// credential is blocked for the 1-minute default instead of 13 minutes and
	// can be reselected and hammered while the cap remains active.
	it("parses Devin 'Your limit will reset in 13 minutes' as 13 minutes", () => {
		expect(extractRetryHint(undefined, "Your limit will reset in 13 minutes")).toBe(13 * 60_000);
	});

	it("parses 'will reset in 2h' phrasing", () => {
		expect(extractRetryHint(undefined, "will reset in 2h")).toBe(2 * 60 * 60_000);
	});
	// OpenCode Go quota errors use "Resets in …" with day units and compound
	// remainders (upstream `formatRetryTime`: "2hr 15min", "3 days", "45min").
	// Without these the exhausted credential falls back to the 60s heuristic
	// and is reselected while the cap is still active.
	it("parses OpenCode Go 'Resets in 45min' as 45 minutes", () => {
		expect(
			extractRetryHint(
				undefined,
				"429 5-hour usage limit reached. Resets in 45min. To continue using this model now, enable usage from your available balance: https://opencode.ai/workspace/wrk_1/go",
			),
		).toBe(45 * 60_000);
	});

	it("parses OpenCode Go compound 'Resets in 2hr 15min' as 2h15m", () => {
		expect(
			extractRetryHint(
				undefined,
				"429 5-hour usage limit reached. Resets in 2hr 15min. To continue using this model now, enable usage from your available balance: https://opencode.ai/workspace/wrk_1/go",
			),
		).toBe((2 * 60 + 15) * 60_000);
	});

	it("parses OpenCode Go day-unit resets", () => {
		expect(extractRetryHint(undefined, "429 Weekly usage limit reached. Resets in 3 days.")).toBe(
			3 * 24 * 60 * 60_000,
		);
		expect(extractRetryHint(undefined, "429 Monthly usage limit reached. Resets in 1 day.")).toBe(24 * 60 * 60_000);
	});

	// A quota body can carry both a generic retry hint and the account reset
	// window ("Please retry in 5s. Your limit will reset in 13 minutes"). The
	// account-reset hint must take precedence so the exhausted credential stays
	// blocked for the full stated window instead of the short generic retry.
	it("prefers the account reset window over a shorter retry hint", () => {
		expect(extractRetryHint(undefined, "Please retry in 5s. Your limit will reset in 13 minutes")).toBe(13 * 60_000);
	});
	// The appended header hint is already the max across response headers
	// (getRetryAfterMsFromHeaders in pi-ai). When it outlasts the textual
	// account reset, it must win so the retry honors the provider's retry
	// window instead of re-hitting a blocked credential.
	it("prefers a longer appended retry hint over a shorter account reset", () => {
		expect(
			extractRetryHint(undefined, "429 quota exceeded. Your limit will reset in 5 minutes. retry-after-ms=3600000"),
		).toBe(3600000);
	});

	it("prefers a longer legacy retry-after over a shorter reset phrase", () => {
		expect(extractRetryHint(undefined, "429 quota exceeded. reset in 5 minutes; retry-after=3600")).toBe(3_600_000);
	});

	it("parses x-ratelimit-reset epoch seconds in the body", () => {
		const hint = extractRetryHint(undefined, "rate limited, x-ratelimit-reset=9999999999");
		expect(hint).toBeDefined();
		expect(hint!).toBeGreaterThan(8_000_000_000_000);
	});

	it("parses retry-after-ms in error body", () => {
		expect(
			extractRetryHint(
				undefined,
				'429 {"type":"error","error":{"type":"rate_limit_error","code":"1310"}} retry-after-ms=98497000',
			),
		).toBe(98_497_000);
	});

	it("parses colon-delimited and spaced retry-after-ms forms", () => {
		expect(extractRetryHint(undefined, "429 quota exceeded. retry-after-ms: 7200000")).toBe(7_200_000);
		expect(extractRetryHint(undefined, "429 quota exceeded. retry-after-ms = 7200000")).toBe(7_200_000);
	});

	it("keeps a longer colon-delimited retry-after-ms over a shorter reset phrase", () => {
		expect(extractRetryHint(undefined, "429 quota exceeded. reset in 5 minutes. retry-after-ms: 3600000")).toBe(
			3_600_000,
		);
	});

	it("parses an offset-bearing absolute reset timestamp", () => {
		const expected = Date.parse("2099-09-01T09:44:51+08:00") - Date.now();
		const hint = extractRetryHint(undefined, "Your limit will reset at 2099-09-01 09:44:51+08:00");
		expect(hint).toBeDefined();
		expect(Math.abs(hint! - expected)).toBeLessThan(100);
	});

	// A date with no zone in a body is the server's wall clock in a zone
	// nothing names; read as UTC it once gave eight hours where the server's
	// header said 750 ms. A wait that cannot be computed is no wait at all.
	it.each([
		["a space-separated reset stamp", "Your limit will reset at 2099-09-01 09:44:51"],
		["an ISO-separated reset stamp", "Your limit will reset at 2099-09-01T09:44:51"],
		["a Chinese reset stamp", "已达到使用上限。您的限额将在 2099-09-01 09:44:51 重置。"],
		["a legacy retry-after ISO date", "rate limited; retry-after: 2099-09-01T09:44:51"],
	])("reads no wait from %s with no zone and no provider offset", (_label, body) => {
		expect(extractRetryHint(undefined, body)).toBeUndefined();
		expect(longestRetryHint(undefined, body)).toBeUndefined();
	});

	it("reads a legacy retry-after date in a body in its stated zone", () => {
		const expected = Date.parse("2099-09-01T09:44:51Z") - Date.now();
		const hint = extractRetryHint(undefined, "rate limited; retry-after: 2099-09-01T09:44:51Z");
		expect(Math.abs(hint! - expected)).toBeLessThan(100);
	});

	it("reads no wait from a legacy retry-after in a body that is no date", () => {
		// `Date.parse("0-1Z")` is 1 Jan 2000, an elapsed date: the body read as
		// "retry now", which a caller takes over its own heuristic wait.
		const body = "rate limited; retry-after: 0-1Z";
		expect(extractRetryHint(undefined, body)).toBeUndefined();
		expect(longestRetryHint(undefined, body)).toBeUndefined();
	});

	it("prefers an absolute account reset over retry-after-ms", () => {
		const future = new Date(Date.now() + 3_600_000).toISOString();
		const hint = extractRetryHint(undefined, `Your limit will reset at ${future} retry-after-ms=5000`);
		expect(hint).toBeGreaterThan(3_500_000);
		expect(hint).toBeLessThanOrEqual(3_600_000);
	});

	it("yields to the relative retry hint over a longer naive reset-at stamp", () => {
		// A naive stamp is the provider's wall clock in an unknown zone: it
		// cannot disambiguate against a conflicting relative signal without
		// guessing the zone, so the unambiguous signal wins regardless of
		// which is longer.
		const naiveWall = new Date(Date.now() + 3_600_000).toISOString().slice(0, 19).replace("T", " ");
		expect(extractRetryHint(undefined, `Your limit will reset at ${naiveWall} retry-after-ms=5000`)).toBe(5000);
	});

	it("still reads the relative hint beside a zone-less stamp", () => {
		expect(
			extractRetryHint(undefined, "已达到使用上限。您的限额将在 2099-09-01 09:44:51 重置。 retry-after-ms=5000"),
		).toBe(5000);
	});

	it("applies naiveResetTimezoneOffset to a naive Chinese reset stamp", () => {
		const targetMs = Date.parse("2099-09-01T09:44:51+08:00");
		const expected = targetMs - Date.now();
		const hint = extractRetryHint(undefined, "已达到使用上限。您的限额将在 2099-09-01 09:44:51 重置。", {
			naiveResetTimezoneOffset: "+08:00",
		});
		expect(hint).toBeDefined();
		expect(Math.abs(hint! - expected)).toBeLessThan(100);
	});

	it("keeps a configured reset over a shorter retry-after-ms", () => {
		const future = new Date(Date.now() + 3_600_000 + 8 * 60 * 60_000).toISOString().slice(0, 19).replace("T", " ");
		const hint = extractRetryHint(undefined, `Your limit will reset at ${future} retry-after-ms=5000`, {
			naiveResetTimezoneOffset: "+08:00",
		});
		expect(hint).toBeGreaterThan(3_500_000);
		expect(hint).toBeLessThanOrEqual(3_600_000);
	});

	// Zero-valued and elapsed signals are authoritative "retry now" replies:
	// collapsing them into `undefined` lets callers substitute a heuristic
	// wait (30-minute quota guess) for a provider that said retry immediately.
	it("preserves an explicit zero retry-after-ms as retry-now", () => {
		expect(extractRetryHint(undefined, "429 quota exceeded. retry-after-ms=0")).toBe(0);
	});

	it("preserves an explicit zero legacy retry-after as retry-now", () => {
		expect(extractRetryHint(undefined, "rate limited; retry-after=0")).toBe(0);
	});

	it("treats elapsed x-ratelimit-reset epochs as retry-now", () => {
		expect(extractRetryHint(undefined, `rate limited, x-ratelimit-reset-ms=${Date.now() - 60_000}`)).toBe(0);
		expect(extractRetryHint(undefined, `rate limited, x-ratelimit-reset=${Math.floor(Date.now() / 1000) - 60}`)).toBe(
			0,
		);
	});

	it("lets a longer reset phrase win over a zero retry hint", () => {
		expect(extractRetryHint(undefined, "429 quota exceeded. reset in 5 minutes. retry-after-ms=0")).toBe(5 * 60_000);
	});

	it("still returns undefined when only elapsed account resets are present", () => {
		const past = new Date(Date.now() - 60_000).toISOString();
		expect(extractRetryHint(undefined, `Your limit will reset at ${past}`)).toBeUndefined();
	});

	describe("a zone-less date in a Retry-After header", () => {
		// An HTTP-date is GMT by definition (RFC 9110 §5.6.7), so a header date
		// without a zone is read as GMT, never in this machine's zone.
		const originalTz = process.env.TZ;
		afterEach(() => {
			process.env.TZ = originalTz;
		});
		it.each([
			["an IMF-fixdate without GMT", "Tue, 01 Sep 2099 09:44:51"],
			["an asctime date", "Tue Sep  1 09:44:51 2099"],
			["an ISO date-time without a zone", "2099-09-01T09:44:51"],
		])("reads %s as GMT", (_label, value) => {
			process.env.TZ = "America/Los_Angeles";
			const expected = Date.UTC(2099, 8, 1, 9, 44, 51) - Date.now();
			for (const hint of [
				extractRetryHint(new Headers({ "retry-after": value })),
				longestRetryHint(new Headers({ "retry-after": value })),
			]) {
				expect(hint).toBeDefined();
				expect(Math.abs(hint! - expected)).toBeLessThan(1000);
			}
		});
		it.each([
			["an IMF-fixdate in GMT", "Tue, 01 Sep 2099 09:44:51 GMT", Date.UTC(2099, 8, 1, 9, 44, 51)],
			["an IMF-fixdate at a numeric offset", "Tue, 01 Sep 2099 11:44:51 +0200", Date.UTC(2099, 8, 1, 9, 44, 51)],
			["an RFC 850 date", "Tuesday, 01-Sep-43 09:44:51 GMT", Date.UTC(2043, 8, 1, 9, 44, 51)],
		] as [string, string, number][])("reads %s in its zone", (_label, value, instant) => {
			process.env.TZ = "America/Los_Angeles";
			const hint = extractRetryHint(new Headers({ "retry-after": value }));
			expect(Math.abs(hint! - (instant - Date.now()))).toBeLessThan(1000);
		});
	});

	it.each([
		["two joined delay-seconds", "9, 120", 120_000],
		["a decimal delay-seconds part", "9.125, 9", 9_125],
	] as [string, string, number][])("reads Retry-After %s at its longest delay", (_label, value, expected) => {
		const headers = new Headers({ "retry-after": value });
		expect(extractRetryHint(headers)).toBe(expected);
		expect(longestRetryHint(headers)).toBe(expected);
	});
});
