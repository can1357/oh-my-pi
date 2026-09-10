import { describe, expect, it } from "bun:test";
import { extractRetryHint, fetchWithRetry, isUnexpectedSocketCloseMessage } from "@oh-my-pi/pi-utils/fetch-retry";

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
});

describe("extractRetryHint", () => {
	// Devin returns HTTP 403 with "Your limit will reset in 13 minutes" for an
	// account-scoped message rate cap. Without recognizing "will reset in", the
	// credential is blocked for the 1-minute default instead of 13 minutes and
	// can be reselected and hammered while the cap remains active.
	it("parses Devin 'Your limit will reset in 13 minutes' as 13 minutes", () => {
		expect(extractRetryHint(undefined, "Your limit will reset in 13 minutes")).toBe(13 * 60_000);
	});

	it("parses bare 'reset in 13 minutes' phrasing", () => {
		expect(extractRetryHint(undefined, "reset in 13 minutes")).toBe(13 * 60_000);
	});

	it("parses 'will reset in 2h' phrasing", () => {
		expect(extractRetryHint(undefined, "will reset in 2h")).toBe(2 * 60 * 60_000);
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

	it.each([
		["space-separated UTC", "2099-09-01 09:44:51", Date.UTC(2099, 8, 1, 9, 44, 51)],
		["ISO-separated UTC", "2099-09-01T09:44:51", Date.UTC(2099, 8, 1, 9, 44, 51)],
		["explicit offset", "2099-09-01 09:44:51+08:00", Date.parse("2099-09-01T09:44:51+08:00")],
	])("parses %s absolute reset timestamp", (_label, timestamp, targetMs) => {
		const expected = targetMs - Date.now();
		const hint = extractRetryHint(undefined, `Your limit will reset at ${timestamp}`);
		expect(hint).toBeDefined();
		expect(Math.abs(hint! - expected)).toBeLessThan(100);
	});

	it("prefers an absolute account reset over retry-after-ms", () => {
		const future = new Date(Date.now() + 3_600_000).toISOString();
		const hint = extractRetryHint(undefined, `Your limit will reset at ${future} retry-after-ms=5000`);
		expect(hint).toBeGreaterThan(3_500_000);
		expect(hint).toBeLessThanOrEqual(3_600_000);
	});

	it("parses Chinese '将在 YYYY-MM-DD HH:MM:SS 重置' reset timestamp in error body", () => {
		const future = new Date(Date.now() + 3_600_000).toISOString().replace("T", " ").slice(0, 19);
		const hint = extractRetryHint(undefined, `已达到使用上限。您的限额将在 ${future} 重置。`);
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
});
