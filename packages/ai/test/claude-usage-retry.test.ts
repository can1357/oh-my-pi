import { afterEach, describe, expect, it, vi } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageFetchContext } from "@oh-my-pi/pi-ai/usage";
import { claudeUsageProvider } from "@oh-my-pi/pi-ai/usage/claude";

const VALID_PAYLOAD = {
	five_hour: { utilization: 42, resets_at: new Date(Date.now() + 5 * 60_000).toISOString() },
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...headers },
	});
}

function makeContext(fetchImpl: FetchImpl, retryWait?: UsageFetchContext["retryWait"]): UsageFetchContext {
	return { fetch: fetchImpl, retryWait };
}

function baseParams() {
	return {
		provider: "anthropic" as const,
		credential: {
			type: "oauth" as const,
			accessToken: "oat-test",
			accountId: "account_test",
			email: "user@example.com",
			expiresAt: Date.now() + 60_000,
		},
	};
}

describe("claudeUsageProvider retry contract", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const instantRetryWait: UsageFetchContext["retryWait"] = async () => {};

	it("does NOT retry a 429 — rate_limit_error is terminal for this poll", async () => {
		let attempt = 0;
		const retryWait = vi.fn(async (_delayMs: number, _signal?: AbortSignal) => {});
		const fetchMock = (async () => {
			attempt += 1;
			// A 429 must end the poll immediately: no backoff, no second attempt.
			// The 200 below must never be reached.
			if (attempt === 1) return jsonResponse(429, { error: "rate_limited" }, { "retry-after": "1" });
			return jsonResponse(200, VALID_PAYLOAD);
		}) as FetchImpl;

		const report = await claudeUsageProvider.fetchUsage(baseParams(), makeContext(fetchMock, retryWait));
		expect(report).toBeNull();
		expect(attempt).toBe(1);
		expect(retryWait).not.toHaveBeenCalled();
	});

	it("retries on 503 then succeeds", async () => {
		let attempt = 0;
		const fetchMock = (async () => {
			attempt += 1;
			if (attempt === 1) return jsonResponse(503, { error: "unavailable" });
			return jsonResponse(200, VALID_PAYLOAD);
		}) as FetchImpl;

		const report = await claudeUsageProvider.fetchUsage(baseParams(), makeContext(fetchMock, instantRetryWait));
		expect(report).not.toBeNull();
		expect(attempt).toBe(2);
	});

	it("does not treat the organization response header as account identity", async () => {
		const fetchMock = (async () =>
			jsonResponse(200, VALID_PAYLOAD, { "anthropic-organization-id": "org_header" })) as FetchImpl;

		const report = await claudeUsageProvider.fetchUsage(baseParams(), makeContext(fetchMock));

		expect(report?.metadata?.accountId).toBe("account_test");
		expect(report?.metadata?.orgId).toBeUndefined();
	});

	it("does NOT retry on 401 — permanent for this credential", async () => {
		let attempt = 0;
		const fetchMock = (async () => {
			attempt += 1;
			return jsonResponse(401, { error: "unauthorized" });
		}) as FetchImpl;

		const report = await claudeUsageProvider.fetchUsage(baseParams(), makeContext(fetchMock));
		expect(report).toBeNull();
		expect(attempt).toBe(1);
	});

	it("does NOT retry on 404 — permanent for this credential", async () => {
		let attempt = 0;
		const fetchMock = (async () => {
			attempt += 1;
			return jsonResponse(404, { error: "not_found" });
		}) as FetchImpl;

		const report = await claudeUsageProvider.fetchUsage(baseParams(), makeContext(fetchMock));
		expect(report).toBeNull();
		expect(attempt).toBe(1);
	});

	it("honours Retry-After when retrying a 503", async () => {
		let attempt = 0;
		const retryWait = vi.fn(async (_delayMs: number, _signal?: AbortSignal) => {});
		const fetchMock = (async () => {
			attempt += 1;
			if (attempt === 1) {
				// Retry-After: 1 second. Provider must compute a 1s backoff before re-attempting.
				return jsonResponse(503, { error: "unavailable" }, { "retry-after": "1" });
			}
			return jsonResponse(200, VALID_PAYLOAD);
		}) as FetchImpl;

		const report = await claudeUsageProvider.fetchUsage(baseParams(), makeContext(fetchMock, retryWait));
		expect(report).not.toBeNull();
		expect(attempt).toBe(2);
		expect(retryWait).toHaveBeenCalledTimes(1);
		expect(retryWait.mock.calls[0]?.[0]).toBe(1000);
	});

	it("aborts the retry sleep when the signal fires mid-backoff", async () => {
		let attempt = 0;
		const fetchMock = (async (_url: string | URL, init?: RequestInit) => {
			attempt += 1;
			if (init?.signal?.aborted) throw new Error("AbortError");
			if (attempt === 1) {
				// Pretend Anthropic wants us to back off for 60s. Without
				// `scheduler.wait({ signal })` the provider would stall through
				// the timeout; with it, the abort rejects the sleep promptly.
				return jsonResponse(503, { error: "unavailable" }, { "retry-after": "60" });
			}
			return jsonResponse(200, VALID_PAYLOAD);
		}) as FetchImpl;

		const controller = new AbortController();
		const retryWait = vi.fn(async (delayMs: number, signal?: AbortSignal) => {
			expect(delayMs).toBe(60_000);
			if (signal?.aborted) throw new Error("AbortError");
			const { promise, reject } = Promise.withResolvers<void>();
			const onAbort = () => reject(new Error("AbortError"));
			signal?.addEventListener("abort", onAbort, { once: true });
			queueMicrotask(() => controller.abort());
			try {
				await promise;
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}
		});

		const report = await claudeUsageProvider.fetchUsage(
			{ ...baseParams(), signal: controller.signal },
			makeContext(fetchMock, retryWait),
		);
		expect(report).toBeNull();
		expect(retryWait).toHaveBeenCalledTimes(1);
		expect(attempt).toBe(1);
	});

	it("falls back to lastPayload when retries exhausted with stale-but-valid data", async () => {
		// Provider keeps lastPayload across attempts — if the upstream returns
		// a 200 with a recognized shape but no usage data, we keep iterating.
		// If we then 503 forever, we return what we have (null in this case).
		let attempt = 0;
		const fetchMock = (async () => {
			attempt += 1;
			if (attempt === 1) {
				// 200 OK but no usage payload — provider continues to next attempt
				// (waiting for fresh data) rather than returning immediately.
				return jsonResponse(200, {});
			}
			return jsonResponse(503, { error: "unavailable" });
		}) as FetchImpl;

		const report = await claudeUsageProvider.fetchUsage(baseParams(), makeContext(fetchMock, instantRetryWait));
		// The 200 set lastPayload but had no usage data; 503s mean no further
		// successes. lastPayload survives but has no usage data → no limits.
		// Specifically: report is null (since lastPayload has nothing to expose).
		expect(report).toBeNull();
		expect(attempt).toBe(3);
	});
});
