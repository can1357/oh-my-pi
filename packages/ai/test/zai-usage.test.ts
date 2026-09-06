import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageFetchContext, UsageFetchParams } from "@oh-my-pi/pi-ai/usage";
import { zaiRankingStrategy, zaiUsageProvider } from "@oh-my-pi/pi-ai/usage/zai";

function makeCredential(): UsageFetchParams["credential"] {
	return {
		type: "api_key",
		apiKey: "zai-test-key",
	};
}

function makeCtx(payload: unknown): UsageFetchContext {
	const fetch: FetchImpl = async input => {
		const url = String(input);
		if (url.includes("/api/monitor/usage/model-usage")) {
			return new Response(JSON.stringify({ success: true, data: {} }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	return { fetch };
}

function makeOAuthCredential(): UsageFetchParams["credential"] {
	return {
		type: "oauth",
		accessToken: "minted-id.minted-secret",
		accountId: "acc-1",
		email: "user@example.com",
	};
}

function makeRecordingCtx(payload: unknown, sink: { authorization?: string }): UsageFetchContext {
	const fetch: FetchImpl = async (input, init) => {
		const url = String(input);
		sink.authorization = new Headers(init?.headers).get("Authorization") ?? undefined;
		if (url.includes("/api/monitor/usage/model-usage")) {
			return new Response(JSON.stringify({ success: true, data: {} }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	return { fetch };
}

describe("zai usage provider", () => {
	it("preserves Z.AI token quota windows instead of treating them as separate accounts", async () => {
		const report = await zaiUsageProvider.fetchUsage!(
			{ provider: "zai", credential: makeCredential(), signal: undefined },
			makeCtx({
				success: true,
				data: {
					limits: [
						{
							type: "TIME_LIMIT",
							usage: 100,
							currentValue: 0,
							percentage: 0,
							remaining: 100,
							nextResetTime: 1784547608994,
							unit: 5,
							number: 1,
							usageDetails: [
								{ modelCode: "search-prime", usage: 0 },
								{ modelCode: "web-reader", usage: 0 },
								{ modelCode: "zread", usage: 0 },
							],
						},
						{ type: "TOKENS_LIMIT", percentage: 82, nextResetTime: 1782656863894, unit: 3, number: 5 },
						{ type: "TOKENS_LIMIT", percentage: 38, nextResetTime: 1783165208993, unit: 6, number: 7 },
					],
				},
			}),
		);

		expect(report).not.toBeNull();
		expect(report!.limits.map(limit => limit.id)).toEqual([
			"zai:features:zread:1mo",
			"zai:tokens:5h",
			"zai:tokens:1w",
		]);
		expect(report!.limits.map(limit => limit.label)).toEqual([
			"ZAI Zread Quota",
			"ZAI 5 Hours Token Quota",
			"ZAI Weekly Token Quota",
		]);
		expect(report!.limits.map(limit => limit.scope.windowId)).toEqual(["1mo", "5h", "1w"]);
		expect(report!.limits.map(limit => limit.scope.shared)).toEqual([false, true, true]);
		expect(report!.limits[0]?.scope.tier).toBe("zread");
		expect(report!.limits.map(limit => limit.window?.durationMs)).toEqual([
			30 * 24 * 60 * 60 * 1000,
			5 * 60 * 60 * 1000,
			7 * 24 * 60 * 60 * 1000,
		]);
	});

	it("supports both api-key and oauth credentials, rejecting oauth rows with no access token", () => {
		expect(zaiUsageProvider.supports!({ provider: "zai", credential: makeCredential(), signal: undefined })).toBe(
			true,
		);
		expect(
			zaiUsageProvider.supports!({ provider: "zai", credential: makeOAuthCredential(), signal: undefined }),
		).toBe(true);
		expect(zaiUsageProvider.supports!({ provider: "zai", credential: { type: "oauth" }, signal: undefined })).toBe(
			false,
		);
	});

	it("fetches quota for an oauth sign-in credential using the minted key as the auth header", async () => {
		const sink: { authorization?: string } = {};
		const report = await zaiUsageProvider.fetchUsage!(
			{ provider: "zai", credential: makeOAuthCredential(), signal: undefined },
			makeRecordingCtx(
				{
					success: true,
					data: {
						limits: [{ type: "TOKENS_LIMIT", percentage: 82, nextResetTime: 1782656863894, unit: 3, number: 5 }],
					},
				},
				sink,
			),
		);

		expect(report).not.toBeNull();
		expect(report!.limits[0]?.id).toBe("zai:tokens:5h");
		expect(report!.metadata?.accountId).toBe("acc-1");
		// Minted id.secret key sent verbatim (no Bearer prefix), same as the paste path.
		expect(sink.authorization).toBe("minted-id.minted-secret");
	});

	it("parses GLM Coding Plan credit windows (5h + weekly) and the plan tier", async () => {
		// Shape captured from a live `GET /api/monitor/usage/quota/limit` response
		// on the credit-based GLM Coding Plan (2026-08).
		const report = await zaiUsageProvider.fetchUsage!(
			{ provider: "zai", credential: makeCredential(), signal: undefined },
			makeCtx({
				success: true,
				data: {
					limits: [
						{
							type: "CREDIT_LIMIT",
							unit: 3,
							number: 5,
							usage: 12000,
							currentValue: 1438,
							remaining: 10561,
							percentage: 11,
							nextResetTime: 1787804173065,
						},
						{
							type: "CREDIT_LIMIT",
							unit: 6,
							number: 1,
							usage: 60000,
							currentValue: 2254,
							remaining: 57745,
							percentage: 3,
							nextResetTime: 1788223121997,
						},
					],
					level: "pro",
				},
			}),
		);

		expect(report).not.toBeNull();
		expect(report!.limits.map(limit => limit.id)).toEqual(["zai:credits:5h", "zai:credits:1w"]);
		expect(report!.limits.map(limit => limit.label)).toEqual(["ZAI 5 Hours Credit Quota", "ZAI Weekly Credit Quota"]);
		expect(report!.limits.map(limit => limit.amount.unit)).toEqual(["credits", "credits"]);
		expect(report!.limits[0]?.amount.used).toBe(1438);
		expect(report!.limits[0]?.amount.limit).toBe(12000);
		// Exact ratio wins over the server-rounded integer percentage (11).
		expect(report!.limits[0]?.amount.usedFraction).toBeCloseTo(1438 / 12000, 5);
		expect(report!.limits.map(limit => limit.status)).toEqual(["ok", "ok"]);
		expect(report!.metadata?.planType).toBe("pro");
		expect(report!.limits.map(limit => limit.window?.durationMs)).toEqual([
			5 * 60 * 60 * 1000,
			7 * 24 * 60 * 60 * 1000,
		]);
		// Ranking treats the credit windows as the credential's primary (5h) and
		// secondary (weekly) meters, matching `windowDefaults`.
		const windows = zaiRankingStrategy.findWindowLimits(report!);
		expect(windows.primary?.id).toBe("zai:credits:5h");
		expect(windows.secondary?.id).toBe("zai:credits:1w");
	});

	it("falls back to the rounded percentage when the credit meter omits absolutes", async () => {
		const report = await zaiUsageProvider.fetchUsage!(
			{ provider: "zai", credential: makeCredential(), signal: undefined },
			makeCtx({
				success: true,
				data: {
					limits: [{ type: "CREDIT_LIMIT", percentage: 97, nextResetTime: 1787804173065, unit: 3, number: 5 }],
				},
			}),
		);

		expect(report).not.toBeNull();
		const limit = report!.limits[0]!;
		expect(limit.id).toBe("zai:credits:5h");
		expect(limit.amount.used).toBeUndefined();
		expect(limit.amount.usedFraction).toBeCloseTo(0.97, 5);
		expect(limit.status).toBe("warning");
	});

	it("keeps one ranked limit per window when tokens and credits meters coexist", async () => {
		const report = await zaiUsageProvider.fetchUsage!(
			{ provider: "zai", credential: makeCredential(), signal: undefined },
			makeCtx({
				success: true,
				data: {
					limits: [
						{ type: "TOKENS_LIMIT", percentage: 82, nextResetTime: 1787804173065, unit: 3, number: 5 },
						{ type: "CREDIT_LIMIT", usage: 12000, currentValue: 1438, percentage: 11, unit: 3, number: 5 },
						{ type: "TOKENS_LIMIT", percentage: 38, nextResetTime: 1788223121997, unit: 6 },
						{ type: "CREDIT_LIMIT", usage: 60000, currentValue: 2254, percentage: 3, unit: 6 },
					],
				},
			}),
		);

		// Both meters repeat each window; ranking must still surface a 5h
		// primary and a weekly secondary instead of two 5h rows (most-binding
		// meter per window: tokens 82% for 5h, tokens 38% for the week).
		const ranked = zaiRankingStrategy.findWindowLimits(report!);
		expect(ranked.primary?.id).toBe("zai:tokens:5h");
		expect(ranked.secondary?.id).toBe("zai:tokens:1w");
	});
});
