import { describe, expect, it } from "bun:test";
import { extractRetryHint, fetchWithRetry } from "@oh-my-pi/pi-utils/fetch-retry";

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
});
