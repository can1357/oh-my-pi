import { describe, expect, test } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { UsageFetchParams } from "@oh-my-pi/pi-ai/usage";
import {
	alibabaTokenPlanRankingStrategy,
	alibabaTokenPlanUsageProvider,
} from "@oh-my-pi/pi-ai/usage/alibaba-token-plan";
import {
	ALIBABA_TOKEN_PLAN_CN_BASE_URL,
	serializeAlibabaTokenPlanCredential,
} from "@oh-my-pi/pi-catalog/wire/alibaba-token-plan";

function params(apiKey: string): UsageFetchParams {
	return {
		provider: "alibaba-token-plan",
		credential: { type: "api_key", apiKey },
		accountKey: "account-1",
	};
}

describe("QwenCloud Token Plan opt-in usage", () => {
	test("fetches quota windows with the Cookie stored during login", async () => {
		const requests: { url: string; init?: RequestInit }[] = [];
		const fetchMock: FetchImpl = (input, init) => {
			requests.push({ url: String(input), init });
			if (requests.length === 1) {
				return Promise.resolve(
					Response.json({ code: "200", data: { secToken: "sec-token", accountId: "account-1" } }),
				);
			}
			return Promise.resolve(
				Response.json({
					data: {
						DataV2: {
							data: {
								data: {
									per5HourPercentage: 0.25,
									per5HourResetTime: 1_800_000_000_000,
									per1WeekPercentage: 0.5,
									per1WeekResetTime: 1_800_100_000_000,
								},
							},
						},
					},
				}),
			);
		};
		const cookie = "session_id=test; login_aliyunid_csrf=csrf-token; locale=en-US";
		const credential = serializeAlibabaTokenPlanCredential("sk-sp-test", cookie);

		const report = await alibabaTokenPlanUsageProvider.fetchUsage(params(credential), { fetch: fetchMock });

		expect(requests).toHaveLength(2);
		expect(requests[0]?.url).toBe("https://home.qwencloud.com/tool/user/info.json");
		expect(new Headers(requests[0]?.init?.headers).get("Cookie")).toBe(cookie);
		expect(requests[0]?.init?.redirect).toBe("manual");
		expect(requests[1]?.url).toBe(
			"https://cs-data.qwencloud.com/data/api.json?product=sfm_bailian&action=IntlBroadScopeAspnGateway&api=zeldaHttp.apikeyMgr.%2Ftokenplan%2Fpersonal%2Fapi%2Fv2%2Fusage",
		);
		const usageHeaders = new Headers(requests[1]?.init?.headers);
		expect(usageHeaders.get("Cookie")).toBe(cookie);
		expect(usageHeaders.get("Origin")).toBe("https://home.qwencloud.com");
		expect(usageHeaders.get("Referer")).toBe("https://home.qwencloud.com/billing/subscription/token-plan-individual");
		expect(usageHeaders.get("X-Requested-With")).toBe("XMLHttpRequest");
		expect(usageHeaders.get("x-xsrf-token")).toBe("csrf-token");
		expect(usageHeaders.get("x-csrf-token")).toBe("csrf-token");
		expect(requests[1]?.init?.redirect).toBe("manual");
		const body = new URLSearchParams(String(requests[1]?.init?.body));
		expect(body.get("sec_token")).toBe("sec-token");
		expect(body.get("params")).toBe(
			JSON.stringify({
				Api: "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage",
				Data: {
					cornerstoneParam: {
						domain: "home.qwencloud.com",
						consoleSite: "QWENCLOUD",
						console: "ONE_CONSOLE",
						xsp_lang: "en-US",
						protocol: "V2",
						productCode: "p_efm",
					},
				},
				V: "1.0",
			}),
		);
		expect(report).toMatchObject({
			provider: "alibaba-token-plan",
			metadata: { source: "qwencloud-console", accountId: "account-1" },
			limits: [
				{
					id: "credits:5h",
					window: { id: "5h", durationMs: 18_000_000, resetsAt: 1_800_000_000_000 },
					amount: { used: 25, usedFraction: 0.25, unit: "percent" },
				},
				{
					id: "credits:7d",
					window: { id: "7d", durationMs: 604_800_000, resetsAt: 1_800_100_000_000 },
					amount: { used: 50, usedFraction: 0.5, unit: "percent" },
				},
			],
		});
		if (!report) throw new Error("expected QwenCloud usage report");
		const windows = alibabaTokenPlanRankingStrategy.findWindowLimits(report, { modelId: "qwen3.7-plus" });
		expect(windows.primary?.id).toBe("credits:5h");
		expect(windows.secondary?.id).toBe("credits:7d");
	});

	test("fetches China quota through the Beijing console gateway", async () => {
		const requests: { url: string; init?: RequestInit }[] = [];
		const fetchMock: FetchImpl = (input, init) => {
			requests.push({ url: String(input), init });
			if (requests.length === 1) {
				return Promise.resolve(
					new Response('<script>window.ALIYUN_CONSOLE_CONFIG = { SEC_TOKEN: "cn-sec-token" };</script>'),
				);
			}
			return Promise.resolve(
				Response.json({
					code: "200",
					data: {
						DataV2: {
							data: {
								data: {
									per1WeekPercentage: 0.7913113,
									per1WeekResetTime: 1_786_716_480_000,
								},
							},
						},
					},
					successResponse: true,
				}),
			);
		};
		const cookie = "login_aliyunid_csrf=cn-csrf; aliyun_lang=zh";
		const credential = serializeAlibabaTokenPlanCredential("sk-sp-beijing", cookie, ALIBABA_TOKEN_PLAN_CN_BASE_URL);

		const report = await alibabaTokenPlanUsageProvider.fetchUsage(params(credential), { fetch: fetchMock });

		expect(requests).toHaveLength(2);
		expect(requests[0]?.url).toBe("https://bailian.console.aliyun.com/cn-beijing?tab=plan");
		expect(new Headers(requests[0]?.init?.headers).get("Cookie")).toBe(cookie);
		expect(requests[1]?.url).toBe(
			"https://bailian-cs.console.aliyun.com/data/api.json?action=BroadScopeAspnGateway&product=sfm_bailian&api=zeldaHttp.apikeyMgr.%2Ftokenplan%2Fpersonal%2Fapi%2Fv2%2Fusage",
		);
		const usageHeaders = new Headers(requests[1]?.init?.headers);
		expect(usageHeaders.get("Origin")).toBe("https://bailian.console.aliyun.com");
		expect(usageHeaders.get("Referer")).toBe("https://bailian.console.aliyun.com/cn-beijing?tab=plan");
		const body = new URLSearchParams(String(requests[1]?.init?.body));
		expect(body.get("action")).toBe("BroadScopeAspnGateway");
		expect(body.get("region")).toBe("cn-beijing");
		expect(body.get("sec_token")).toBe("cn-sec-token");
		const gatewayParams: unknown = JSON.parse(body.get("params") ?? "null");
		expect(gatewayParams).toMatchObject({
			Api: "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage",
			Data: {
				cornerstoneParam: {
					feTraceId: expect.any(String),
					feURL: "https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan/personal",
					protocol: "V2",
					console: "ONE_CONSOLE",
					productCode: "p_efm",
					switchAgent: 12608464,
					switchUserType: 3,
					domain: "bailian.console.aliyun.com",
					consoleSite: "BAILIAN_ALIYUN",
					userNickName: "",
					userPrincipalName: "",
					xsp_lang: "zh-CN",
				},
			},
			V: "1.0",
		});
		expect(report).toMatchObject({
			provider: "alibaba-token-plan",
			limits: [
				{
					id: "credits:7d",
					window: { id: "7d", durationMs: 604_800_000, resetsAt: 1_786_716_480_000 },
					amount: { usedFraction: 0.7913113, unit: "percent" },
				},
			],
		});
		expect(report?.limits).toHaveLength(1);
	});

	test("does not claim quota support for API-key-only credentials", async () => {
		let fetched = false;
		const fetchMock: FetchImpl = () => {
			fetched = true;
			return Promise.resolve(Response.json({}));
		};
		const request = params("sk-sp-test");

		expect(alibabaTokenPlanUsageProvider.supports?.(request)).toBe(false);
		expect(await alibabaTokenPlanUsageProvider.fetchUsage(request, { fetch: fetchMock })).toBeNull();
		expect(fetched).toBe(false);
	});

	test("fails closed when the stored console session has expired", async () => {
		let requestCount = 0;
		const fetchMock: FetchImpl = () => {
			requestCount++;
			return Promise.resolve(
				requestCount === 1
					? Response.json({ code: "200", data: { secToken: "sec-token" } })
					: Response.json({ code: "ConsoleNeedLogin", message: "You need to log in.", successResponse: false }),
			);
		};
		const credential = serializeAlibabaTokenPlanCredential("sk-sp-test", "session_id=expired");

		expect(await alibabaTokenPlanUsageProvider.fetchUsage(params(credential), { fetch: fetchMock })).toBeNull();
		expect(requestCount).toBe(2);
	});
});
