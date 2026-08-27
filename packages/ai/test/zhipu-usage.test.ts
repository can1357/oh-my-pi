import { describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageFetchContext, UsageFetchParams } from "@oh-my-pi/pi-ai/usage";
import { zhipuUsageProvider } from "@oh-my-pi/pi-ai/usage/zhipu";

const PROVIDER = "zhipu-coding-plan";

function makeCredential(): UsageFetchParams["credential"] {
	return {
		type: "api_key",
		apiKey: "zhipu-test-key",
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

function makeRecordingCtx(payload: unknown, sink: { authorization?: string; url?: string }): UsageFetchContext {
	const fetch: FetchImpl = async (input, init) => {
		const url = String(input);
		sink.authorization = new Headers(init?.headers).get("Authorization") ?? undefined;
		if (!url.includes("/api/monitor/usage/model-usage")) sink.url = url;
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

describe("zhipu usage provider", () => {
	it("queries the domestic BigModel endpoint and parses credit-pool windows", async () => {
		const sink: { authorization?: string; url?: string } = {};
		const report = await zhipuUsageProvider.fetchUsage!(
			{ provider: PROVIDER, credential: makeCredential(), signal: undefined },
			makeRecordingCtx(
				{
					success: true,
					code: 200,
					msg: "操作成功",
					data: {
						level: "lite",
						limits: [
							{
								type: "CREDIT_LIMIT",
								unit: 3,
								number: 5,
								usage: 2000,
								currentValue: 30,
								remaining: 1969,
								percentage: 1,
								nextResetTime: 1786736436792,
							},
							{
								type: "CREDIT_LIMIT",
								unit: 6,
								number: 1,
								usage: 10000,
								currentValue: 30,
								remaining: 9969,
								percentage: 1,
								nextResetTime: 1787323156998,
							},
						],
					},
				},
				sink,
			),
		);

		expect(report).not.toBeNull();
		expect(report!.provider).toBe(PROVIDER);
		expect(sink.url).toBe("https://open.bigmodel.cn/api/monitor/usage/quota/limit");
		// Raw id.secret key sent verbatim (no Bearer prefix), same as the Z.AI path.
		expect(sink.authorization).toBe("zhipu-test-key");
		expect(report!.metadata?.planType).toBe("lite");
		expect(report!.limits.map(limit => limit.id)).toEqual(["zhipu:credits:5h", "zhipu:credits:1w"]);
		expect(report!.limits.map(limit => limit.label)).toEqual([
			"Zhipu 5 Hours Credit Quota",
			"Zhipu Weekly Credit Quota",
		]);
		expect(report!.limits.map(limit => limit.amount)).toEqual([
			{
				used: 30,
				limit: 2000,
				remaining: 1969,
				usedFraction: 0.01,
				remainingFraction: 0.99,
				unit: "unknown",
			},
			{
				used: 30,
				limit: 10000,
				remaining: 9969,
				usedFraction: 0.01,
				remainingFraction: 0.99,
				unit: "unknown",
			},
		]);
		expect(report!.limits.map(limit => limit.scope.windowId)).toEqual(["5h", "1w"]);
		expect(report!.limits.map(limit => limit.scope.shared)).toEqual([true, true]);
		expect(report!.limits.map(limit => limit.window?.resetsAt)).toEqual([1786736436792, 1787323156998]);
	});

	it("also parses the Z.AI-shape token/request limits on the domestic endpoint", async () => {
		const report = await zhipuUsageProvider.fetchUsage!(
			{ provider: PROVIDER, credential: makeCredential(), signal: undefined },
			makeCtx({
				success: true,
				data: {
					level: "pro",
					limits: [
						{ type: "TOKENS_LIMIT", percentage: 41, nextResetTime: 1784547608994, unit: 6, number: 1 },
						{
							type: "TIME_LIMIT",
							usage: 100,
							currentValue: 42,
							percentage: 42,
							remaining: 58,
							nextResetTime: 1784547608994,
							unit: 3,
							number: 5,
						},
					],
				},
			}),
		);

		expect(report).not.toBeNull();
		expect(report!.limits.map(limit => limit.id)).toEqual(["zhipu:tokens:1w", "zhipu:requests:5h"]);
		expect(report!.limits.map(limit => limit.label)).toEqual(["Zhipu Weekly Token Quota", "Zhipu Request Quota"]);
	});

	it("normalizes a coding-plan base URL down to the monitor host origin", async () => {
		const sink: { authorization?: string; url?: string } = {};
		const report = await zhipuUsageProvider.fetchUsage!(
			{
				provider: PROVIDER,
				credential: makeCredential(),
				baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
				signal: undefined,
			},
			makeRecordingCtx(
				{ success: true, data: { limits: [{ type: "TOKENS_LIMIT", percentage: 10, unit: 6 }] } },
				sink,
			),
		);

		expect(report).not.toBeNull();
		expect(sink.url).toBe("https://open.bigmodel.cn/api/monitor/usage/quota/limit");
	});

	it("supports api-key and oauth credentials, rejecting oauth rows with no access token", () => {
		expect(
			zhipuUsageProvider.supports!({ provider: PROVIDER, credential: makeCredential(), signal: undefined }),
		).toBe(true);
		expect(
			zhipuUsageProvider.supports!({
				provider: PROVIDER,
				credential: { type: "oauth", accessToken: "minted-id.minted-secret" },
				signal: undefined,
			}),
		).toBe(true);
		expect(
			zhipuUsageProvider.supports!({ provider: PROVIDER, credential: { type: "oauth" }, signal: undefined }),
		).toBe(false);
	});

	it("returns null for a non-success payload", async () => {
		const report = await zhipuUsageProvider.fetchUsage!(
			{ provider: PROVIDER, credential: makeCredential(), signal: undefined },
			makeCtx({ success: false, code: 401, msg: "unauthorized" }),
		);
		expect(report).toBeNull();
	});
});
