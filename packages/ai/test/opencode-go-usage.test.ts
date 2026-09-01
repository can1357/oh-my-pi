import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import { opencodeGoRankingStrategy, opencodeGoUsageProvider } from "../src/usage/opencode-go";

const DEFAULT_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

/** Live capture from `GET /zen/go/v1/usage`, 2026-08-12. */
function usagePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		usage: {
			rolling: { status: "ok", percent: 12, resetsAt: "2026-08-12T15:09:04.847Z" },
			weekly: { status: "ok", percent: 8, resetsAt: "2026-08-17T00:00:00.847Z" },
			monthly: { status: "rate-limited", percent: 100, resetsAt: "2026-08-19T00:31:53.847Z" },
			...overrides,
		},
	};
}

function fakeFetch(payload: unknown, status = 200): FetchImpl {
	const fn = async () =>
		new Response(JSON.stringify(payload), {
			status,
			headers: { "content-type": "application/json" },
		});
	return fn as unknown as typeof fetch;
}

function fetchRecorder(
	calls: Array<{ url: string; headers: Record<string, string> }>,
	payload: unknown,
	status = 200,
): FetchImpl {
	const fn = async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({
			url: String(input),
			headers: (init?.headers as Record<string, string>) ?? {},
		});
		return new Response(JSON.stringify(payload), {
			status,
			headers: { "content-type": "application/json" },
		});
	};
	return fn as unknown as typeof fetch;
}

describe("opencode-go usage provider", () => {
	it("parses the three windows into percent limits with canonical window ids", async () => {
		const report = await opencodeGoUsageProvider.fetchUsage(
			{ provider: "opencode-go", credential: { type: "api_key", apiKey: "sk-test" } },
			{ fetch: fakeFetch(usagePayload()) },
		);
		expect(report).not.toBeNull();
		expect(report?.limits.map(limit => [limit.id, limit.scope.windowId, limit.amount.used])).toEqual([
			["rolling-5h", "5h", 12],
			["weekly", "7d", 8],
			["monthly", "monthly", 100],
		]);
		const rolling = report?.limits.find(limit => limit.id === "rolling-5h");
		expect(rolling?.amount.usedFraction).toBeCloseTo(0.12, 5);
		expect(rolling?.amount.unit).toBe("percent");
		expect(rolling?.window?.durationMs).toBe(5 * 3_600_000);
		expect(rolling?.window?.resetsAt).toBe(Date.parse("2026-08-12T15:09:04.847Z"));
		// Monthly anchors on the subscription anniversary, not a 30d span.
		const monthly = report?.limits.find(limit => limit.id === "monthly");
		expect(monthly?.window?.durationMs).toBeUndefined();
		expect(monthly?.window?.resetsAt).toBe(Date.parse("2026-08-19T00:31:53.847Z"));
	});

	it("maps rate-limited windows to exhausted and high usage to warning", async () => {
		const report = await opencodeGoUsageProvider.fetchUsage(
			{ provider: "opencode-go", credential: { type: "api_key", apiKey: "sk-test" } },
			{
				fetch: fakeFetch(
					usagePayload({
						rolling: { status: "ok", percent: 85, resetsAt: "2026-08-12T15:09:04.847Z" },
					}),
				),
			},
		);
		expect(report?.limits.find(limit => limit.id === "rolling-5h")?.status).toBe("warning");
		expect(report?.limits.find(limit => limit.id === "weekly")?.status).toBe("ok");
		expect(report?.limits.find(limit => limit.id === "monthly")?.status).toBe("exhausted");
	});

	it("sends Authorization: Bearer <key> to the fixed usage route", async () => {
		const calls: Array<{ url: string; headers: Record<string, string> }> = [];
		await opencodeGoUsageProvider.fetchUsage(
			{ provider: "opencode-go", credential: { type: "api_key", apiKey: "sk-test" } },
			{ fetch: fetchRecorder(calls, usagePayload()) },
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(DEFAULT_USAGE_URL);
		expect(calls[0]?.headers.authorization).toBe("Bearer sk-test");
	});

	it("normalizes both catalog baseUrl forms onto the usage route", async () => {
		for (const baseUrl of ["https://opencode.ai/zen/go", "https://opencode.ai/zen/go/v1"]) {
			const calls: Array<{ url: string; headers: Record<string, string> }> = [];
			await opencodeGoUsageProvider.fetchUsage(
				{ provider: "opencode-go", credential: { type: "api_key", apiKey: "sk-test" }, baseUrl },
				{ fetch: fetchRecorder(calls, usagePayload()) },
			);
			expect(calls[0]?.url).toBe(DEFAULT_USAGE_URL);
		}
	});

	it("throws on 401 with the upstream error message so checkCredentials flags the key", async () => {
		await expect(
			opencodeGoUsageProvider.fetchUsage(
				{ provider: "opencode-go", credential: { type: "api_key", apiKey: "sk-test" } },
				{
					fetch: fakeFetch({ type: "error", error: { type: "AuthError", message: "Unauthorized" } }, 401),
				},
			),
		).rejects.toThrow(/401.*Unauthorized/);
	});

	it("throws on 403 so lapsed Go subscriptions surface in credential health", async () => {
		await expect(
			opencodeGoUsageProvider.fetchUsage(
				{ provider: "opencode-go", credential: { type: "api_key", apiKey: "sk-test" } },
				{
					fetch: fakeFetch(
						{ type: "error", error: { type: "EntitlementError", message: "OpenCode Go subscription required." } },
						403,
					),
				},
			),
		).rejects.toThrow(/403.*subscription required/);
	});

	it("returns null on a transient non-auth HTTP failure (500)", async () => {
		const report = await opencodeGoUsageProvider.fetchUsage(
			{ provider: "opencode-go", credential: { type: "api_key", apiKey: "sk-test" } },
			{ fetch: fakeFetch({ message: "internal server error" }, 500) },
		);
		expect(report).toBeNull();
	});

	it("rejects the whole payload unless all three windows decode", async () => {
		// A partial report would overwrite the complete last-good report in the
		// usage cache, so one malformed window must fail the entire payload.
		const partial = await opencodeGoUsageProvider.fetchUsage(
			{ provider: "opencode-go", credential: { type: "api_key", apiKey: "sk-test" } },
			{
				fetch: fakeFetch(usagePayload({ rolling: { status: "ok", percent: "abc" }, weekly: null })),
			},
		);
		expect(partial).toBeNull();

		for (const malformedRolling of [
			{ status: "unknown", percent: 12, resetsAt: "2026-08-12T15:09:04.847Z" },
			{ status: "ok", percent: 101, resetsAt: "2026-08-12T15:09:04.847Z" },
			{ status: "ok", percent: 12, resetsAt: "not-a-timestamp" },
		]) {
			const malformed = await opencodeGoUsageProvider.fetchUsage(
				{ provider: "opencode-go", credential: { type: "api_key", apiKey: "sk-test" } },
				{ fetch: fakeFetch(usagePayload({ rolling: malformedRolling })) },
			);
			expect(malformed).toBeNull();
		}

		const empty = await opencodeGoUsageProvider.fetchUsage(
			{ provider: "opencode-go", credential: { type: "api_key", apiKey: "sk-test" } },
			{ fetch: fakeFetch({ usage: {} }) },
		);
		expect(empty).toBeNull();

		const noUsage = await opencodeGoUsageProvider.fetchUsage(
			{ provider: "opencode-go", credential: { type: "api_key", apiKey: "sk-test" } },
			{ fetch: fakeFetch({}) },
		);
		expect(noUsage).toBeNull();
	});
});

describe("opencode-go ranking strategy", () => {
	it("ranks on rolling/weekly and keeps the monthly window display-only", async () => {
		const report = await opencodeGoUsageProvider.fetchUsage(
			{ provider: "opencode-go", credential: { type: "api_key", apiKey: "sk-test" } },
			{ fetch: fakeFetch(usagePayload()) },
		);
		if (!report) throw new Error("expected report");

		const windows = opencodeGoRankingStrategy.findWindowLimits(report);
		expect(windows.primary?.id).toBe("rolling-5h");
		expect(windows.secondary?.id).toBe("weekly");

		// Exhausted monthly (recoverable via the console "Use balance"
		// fallback) must not enter credential-wide exhaustion checks.
		const scoped = opencodeGoRankingStrategy.scopeLimits?.(report);
		expect(scoped?.map(limit => limit.id)).toEqual(["rolling-5h", "weekly"]);
	});
});
