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

	it("surfaces monthly aggregate usages without duplicating the 5h limit", async () => {
		const monthlyReset = "2026-10-22T00:00:00Z";
		const report = await kimiUsageProvider.fetchUsage!(
			{ provider: "kimi-code", credential: makeCredential(), signal: undefined },
			makeCtx({
				limits: [
					{
						window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
						detail: { limit: "100", used: "100", resetTime: "2026-09-22T12:22:15.593402Z" },
					},
				],
				usages: {
					limit_5h: { used_ratio: 0, reset_time: "2026-09-22T12:22:15Z" },
					limit_month_total: { used_ratio: 0.0795, reset_time: monthlyReset },
					limit_month_code: { used_ratio: 0, reset_time: monthlyReset },
				},
			}),
		);

		expect(report).not.toBeNull();
		expect(report!.limits.map(limit => limit.label)).toEqual(["5h limit", "Monthly total", "Monthly code"]);

		const monthlyTotal = report!.limits[1]!;
		expect(monthlyTotal.amount.unit).toBe("percent");
		expect(monthlyTotal.amount.used).toBeCloseTo(7.95);
		expect(monthlyTotal.amount.remaining).toBeCloseTo(92.05);
		expect(monthlyTotal.amount.usedFraction).toBe(0.0795);
		expect(monthlyTotal.window?.resetsAt).toBe(Date.parse(monthlyReset));

		const monthlyCode = report!.limits[2]!;
		expect(monthlyCode.amount.unit).toBe("percent");
		expect(monthlyCode.amount.usedFraction).toBe(0);
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
