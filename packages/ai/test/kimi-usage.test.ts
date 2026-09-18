import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageFetchContext, UsageFetchParams } from "@oh-my-pi/pi-ai/usage";
import { kimiUsageProvider } from "@oh-my-pi/pi-ai/usage/kimi";

function makeCredential(accountId?: string): UsageFetchParams["credential"] {
	return {
		type: "oauth",
		accessToken: "kimi-test-token",
		accountId,
	};
}

function makeCtx(payload: unknown): UsageFetchContext {
	const fetch: FetchImpl = async () =>
		new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	return { fetch };
}

describe("kimi usage provider", () => {
	it("fetches usage with an API key as a bearer token", async () => {
		const requests: Array<{ url: string; authorization: string | null }> = [];
		const credential: UsageFetchParams["credential"] = {
			type: "api_key",
			apiKey: "sk-kimi-test",
		};
		const params: UsageFetchParams = {
			provider: "kimi-code",
			credential,
			baseUrl: "https://api.kimi.com/coding/v1/",
			signal: undefined,
		};
		const fetch: FetchImpl = async (input, init) => {
			requests.push({
				url: String(input),
				authorization: new Headers(init?.headers).get("Authorization"),
			});
			return new Response(
				JSON.stringify({
					usage: { limit: "100", used: "2", remaining: "98", resetTime: "2026-08-20T07:05:56Z" },
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		};

		expect(kimiUsageProvider.supports!(params)).toBe(true);
		const report = await kimiUsageProvider.fetchUsage!(params, { fetch });

		expect(requests).toEqual([
			{
				url: "https://api.kimi.com/coding/v1/usages",
				authorization: "Bearer sk-kimi-test",
			},
		]);
		expect(report?.limits[0]?.amount.remainingFraction).toBe(0.98);
	});

	it("supports populated API-key and OAuth credentials only", () => {
		expect(
			kimiUsageProvider.supports!({
				provider: "kimi-code",
				credential: { type: "api_key", apiKey: "sk-kimi-test" },
			}),
		).toBe(true);
		expect(
			kimiUsageProvider.supports!({
				provider: "kimi-code",
				credential: { type: "oauth", accessToken: "kimi-oauth-token" },
			}),
		).toBe(true);
		expect(kimiUsageProvider.supports!({ provider: "kimi-code", credential: { type: "api_key" } })).toBe(false);
		expect(kimiUsageProvider.supports!({ provider: "kimi-code", credential: { type: "oauth" } })).toBe(false);
	});

	it("surfaces the 5h limit reset time from the limit detail onto the window", async () => {
		// Live payload shape: `resetTime` lives on `detail`, while `window`
		// carries only duration/timeUnit. The 5h row must still render
		// "resets in …" in `omp usage`.
		const detailReset = "2026-07-18T05:43:35.355947Z";
		const usageReset = "2026-07-21T07:43:35.355947Z";
		const report = await kimiUsageProvider.fetchUsage!(
			{ provider: "kimi-code", credential: makeCredential(), signal: undefined },
			makeCtx({
				usage: { limit: "100", used: "28", remaining: "72", resetTime: usageReset },
				limits: [
					{
						window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
						detail: { limit: "100", remaining: "100", resetTime: detailReset },
					},
				],
			}),
		);

		expect(report).not.toBeNull();
		expect(report!.limits).toHaveLength(2);

		const weekly = report!.limits[0]!;
		expect(weekly.label).toBe("Weekly limit");
		expect(weekly.window?.resetsAt).toBe(Date.parse(usageReset));
		// The aggregate quota is the weekly subscription window; canonical id
		// lets the status-line usage segment pick it up.
		expect(weekly.window?.id).toBe("7d");
		expect(weekly.scope?.windowId).toBe("7d");
		const fiveHour = report!.limits[1]!;
		expect(fiveHour.label).toBe("5h limit");
		expect(fiveHour.window?.durationMs).toBe(5 * 60 * 60 * 1000);
		expect(fiveHour.window?.resetsAt).toBe(Date.parse(detailReset));
		// 300 minutes canonicalizes to "5h" so the status-line usage segment
		// recognizes the burst window.
		expect(fiveHour.window?.id).toBe("5h");
		expect(fiveHour.scope?.windowId).toBe("5h");
	});

	it("keeps an explicit window resetTime authoritative over the detail one", async () => {
		const windowReset = "2026-07-18T06:00:00.000Z";
		const detailReset = "2026-07-18T05:43:35.355947Z";
		const report = await kimiUsageProvider.fetchUsage!(
			{ provider: "kimi-code", credential: makeCredential(), signal: undefined },
			makeCtx({
				limits: [
					{
						window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE", resetTime: windowReset },
						detail: { limit: "100", remaining: "40", resetTime: detailReset },
					},
				],
			}),
		);

		expect(report).not.toBeNull();
		expect(report!.limits).toHaveLength(1);
		expect(report!.limits[0]!.window?.resetsAt).toBe(Date.parse(windowReset));
	});

	it("canonicalizes whole-day and non-standard window durations", async () => {
		const report = await kimiUsageProvider.fetchUsage!(
			{ provider: "kimi-code", credential: makeCredential(), signal: undefined },
			makeCtx({
				limits: [
					{
						window: { duration: 7, timeUnit: "TIME_UNIT_DAY" },
						detail: { limit: "100", remaining: "50" },
					},
					{
						window: { duration: 90, timeUnit: "TIME_UNIT_MINUTE" },
						detail: { limit: "100", remaining: "50" },
					},
				],
			}),
		);

		expect(report).not.toBeNull();
		expect(report!.limits).toHaveLength(2);
		expect(report!.limits[0]!.window?.id).toBe("7d");
		expect(report!.limits[1]!.window?.id).toBe("90m");
	});

	it("attaches the credential account id used by stable usage labels", async () => {
		const report = await kimiUsageProvider.fetchUsage!(
			{ provider: "kimi-code", credential: makeCredential("kimi-user-42"), signal: undefined },
			makeCtx({ usage: { limit: "100", used: "28", remaining: "72" } }),
		);

		expect(report?.metadata?.accountId).toBe("kimi-user-42");
	});

	it("parses totalQuota when extra purchased quota is present", async () => {
		const report = await kimiUsageProvider.fetchUsage!(
			{ provider: "kimi-code", credential: makeCredential(), signal: undefined },
			makeCtx({
				usage: { limit: "100", used: "28", remaining: "72", resetTime: "2026-07-21T07:43:35.355947Z" },
				totalQuota: {
					limit: "500",
					used: "100",
					remaining: "400",
					window: { duration: 30, timeUnit: "TIME_UNIT_DAY", resetTime: "2026-08-20T00:00:00.000Z" },
				},
			}),
		);

		expect(report).not.toBeNull();
		expect(report!.limits).toHaveLength(2);
		expect(report!.limits[0]!.label).toBe("Weekly limit");
		expect(report!.limits[1]!.label).toBe("Total quota");
		expect(report!.limits[1]!.amount.limit).toBe(500);
		expect(report!.limits[1]!.amount.remaining).toBe(400);
		expect(report!.limits[1]!.window?.id).toBe("30d");
		expect(report!.limits[1]!.window?.resetsAt).toBe(Date.parse("2026-08-20T00:00:00.000Z"));
	});

	it("cleanly ignores empty totalQuota objects", async () => {
		const report = await kimiUsageProvider.fetchUsage!(
			{ provider: "kimi-code", credential: makeCredential(), signal: undefined },
			makeCtx({
				usage: { limit: "100", remaining: "100" },
				totalQuota: {},
			}),
		);

		expect(report).not.toBeNull();
		expect(report!.limits).toHaveLength(1);
		expect(report!.limits[0]!.label).toBe("Weekly limit");
	});
});
