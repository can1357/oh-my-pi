import { describe, expect, test } from "bun:test";
import type { UsageFetchParams, UsageReport } from "@pk-nerdsaver-ai/pi-ai/usage";
import {
	alibabaTokenPlanRankingStrategy,
	alibabaTokenPlanUsageProvider,
} from "@pk-nerdsaver-ai/pi-ai/usage/alibaba-token-plan";
import { serializeAlibabaTokenPlanCredential } from "@pk-nerdsaver-ai/pi-catalog/wire/alibaba-token-plan";

const USAGE_URL_PREFIX = "https://cs-data.qwencloud.com/data/api.json";

function params(credential: string): UsageFetchParams {
	return {
		provider: "alibaba-token-plan",
		credential: { type: "api_key", apiKey: credential },
	};
}

function mockConsoleFetch(userPayload: unknown, usagePayload: unknown): typeof fetch {
	return (input => {
		const url = String(input);
		if (url.includes("/tool/user/info.json")) {
			return Promise.resolve(Response.json(userPayload));
		}
		if (url.startsWith(USAGE_URL_PREFIX)) {
			return Promise.resolve(Response.json(usagePayload));
		}
		throw new Error(`unexpected url ${url}`);
	}) as typeof fetch;
}

describe("alibaba-token-plan usage provider", () => {
	test("supports only cookie-bearing api_key credentials", () => {
		const withCookie = params(serializeAlibabaTokenPlanCredential("sk-sp-test", "session_id=x"));
		const bare = params("sk-sp-test");
		expect(alibabaTokenPlanUsageProvider.supports?.(withCookie)).toBe(true);
		expect(alibabaTokenPlanUsageProvider.supports?.(bare)).toBe(false);
	});

	test("fetches 5-hour and 7-day quota from the console gateway", async () => {
		const fetchMock = mockConsoleFetch(
			{ data: { secToken: "sec-token", accountId: "1234" } },
			{
				successResponse: true,
				data: {
					data: {
						per5HourPercentage: 42,
						per5HourResetTime: 1_750_000_000,
						per1WeekPercentage: 10,
						per1WeekResetTime: 1_750_500_000,
					},
				},
			},
		);
		const credential = serializeAlibabaTokenPlanCredential("sk-sp-test", "login_aliyunid_csrf=csrf; other=1");
		const report = await alibabaTokenPlanUsageProvider.fetchUsage(params(credential), { fetch: fetchMock });
		expect(report).not.toBeNull();
		if (!report) return;
		expect(report.provider).toBe("alibaba-token-plan");
		const fiveHour = report.limits.find(limit => limit.id === "credits:5h");
		const week = report.limits.find(limit => limit.id === "credits:7d");
		expect(fiveHour?.amount.usedFraction).toBe(0.42);
		expect(fiveHour?.status).toBe("ok");
		expect(fiveHour?.window?.resetsAt).toBe(1_750_000_000_000);
		expect(week?.amount.usedFraction).toBe(0.1);
	});

	test("returns null when the console session is expired", async () => {
		const fetchMock = () => Promise.resolve(new Response(null, { status: 401 }));
		const credential = serializeAlibabaTokenPlanCredential("sk-sp-test", "session_id=expired");
		expect(await alibabaTokenPlanUsageProvider.fetchUsage(params(credential), { fetch: fetchMock })).toBeNull();
	});

	test("ranking strategy exposes the 5-hour primary and 7-day secondary windows", () => {
		const report: UsageReport = {
			provider: "alibaba-token-plan",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "credits:5h",
					label: "5 Hour Credits",
					scope: { provider: "alibaba-token-plan" },
					window: { id: "5h", label: "5 Hour Credits", durationMs: 5 * 60 * 60 * 1000 },
					amount: { used: 42, usedFraction: 0.42, unit: "percent" },
					status: "ok",
				},
				{
					id: "credits:7d",
					label: "7 Day Credits",
					scope: { provider: "alibaba-token-plan" },
					window: { id: "7d", label: "7 Day Credits", durationMs: 7 * 24 * 60 * 60 * 1000 },
					amount: { used: 10, usedFraction: 0.1, unit: "percent" },
					status: "ok",
				},
			],
			metadata: { source: "qwencloud-console" },
		};
		const windows = alibabaTokenPlanRankingStrategy.findWindowLimits(report);
		expect(windows.primary?.id).toBe("credits:5h");
		expect(windows.secondary?.id).toBe("credits:7d");
		expect(alibabaTokenPlanRankingStrategy.windowDefaults.primaryMs).toBe(5 * 60 * 60 * 1000);
		expect(alibabaTokenPlanRankingStrategy.windowDefaults.secondaryMs).toBe(7 * 24 * 60 * 60 * 1000);
	});
});
