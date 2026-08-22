import { describe, expect, test } from "bun:test";
import { Effort } from "@pk-nerdsaver-ai/pi-catalog/effort";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { CATALOG_PROVIDERS } from "@pk-nerdsaver-ai/pi-catalog/provider-models/descriptors";
import {
	ALIBABA_CODING_PLAN_STATIC_MODELS,
	ALIBABA_TOKEN_PLAN_BASE_URL,
	ALIBABA_TOKEN_PLAN_STATIC_MODELS,
	alibabaTokenPlanModelManagerOptions,
} from "@pk-nerdsaver-ai/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@pk-nerdsaver-ai/pi-catalog/types";
import { serializeAlibabaTokenPlanCredential } from "@pk-nerdsaver-ai/pi-catalog/wire/alibaba-token-plan";

describe("QwenCloud Token Plan provider", () => {
	test("ships the documented Token Plan text-model allowlist", () => {
		expect(ALIBABA_TOKEN_PLAN_STATIC_MODELS.map(model => model.id)).toEqual([
			"qwen3.8-max",
			"qwen3.8-max-preview",
			"qwen3.7-max",
			"qwen3.7-plus",
			"qwen3.6-flash",
			"glm-5.2",
			"deepseek-v4-pro",
			"deepseek-v4-pro-0813",
			"deepseek-v4-flash-0731",
		]);

		const preview = ALIBABA_TOKEN_PLAN_STATIC_MODELS.find(m => m.id === "qwen3.8-max-preview");
		expect(preview).toMatchObject({
			provider: "alibaba-token-plan",
			baseUrl: ALIBABA_TOKEN_PLAN_BASE_URL,
			contextWindow: 983_616,
			maxTokens: 131_072,
			input: ["text", "image"],
			thinking: {
				efforts: [Effort.Low, Effort.High, Effort.XHigh],
				requiresEffort: true,
			},
			compat: {
				supportsDeveloperRole: false,
				supportsReasoningEffort: true,
			},
		});

		expect(ALIBABA_TOKEN_PLAN_STATIC_MODELS.find(model => model.id === "glm-5.2")?.thinking?.efforts).toEqual([
			Effort.Minimal,
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.XHigh,
		]);

		expect(ALIBABA_TOKEN_PLAN_STATIC_MODELS.find(model => model.id === "deepseek-v4-pro-0813")).toMatchObject({
			provider: "alibaba-token-plan",
			baseUrl: ALIBABA_TOKEN_PLAN_BASE_URL,
			contextWindow: 1_000_000,
			maxTokens: 384_000,
			reasoning: true,
			thinking: {
				mode: "effort",
				efforts: [Effort.High, Effort.XHigh],
			},
		});
	});

	test("discovers subscribed chat models from the native models endpoint", async () => {
		let requestedUrl = "";
		let authorization = "";
		const fetchMock: FetchImpl = (input, init) => {
			requestedUrl = String(input);
			authorization = new Headers(init?.headers).get("Authorization") ?? "";
			return Promise.resolve(
				Response.json({
					data: [
						{
							id: "qwen3.7-plus",
							name: "server metadata must not replace curated metadata",
							owned_by: "qwencloud",
							context_length: 262_144,
							max_completion_tokens: 16_384,
						},
						{ id: "deepseek-v4-flash", owned_by: "qwencloud" },
						{ id: "deepseek-v4-flash-0731", owned_by: "qwencloud" },
						{ id: "kimi-k2.7-code", owned_by: "qwencloud" },
						{ id: "MiniMax-M2.5", owned_by: "qwencloud" },
						{ id: "fun-asr", owned_by: "qwencloud" },
						{ id: "qwen-image-2.0-pro", owned_by: "qwencloud" },
						{ id: "qwen-audio-3.0-tts-plus", owned_by: "qwencloud" },
						{ id: "happyhorse-1.1-t2v", owned_by: "qwencloud" },
						{ id: "text-embedding-v4", owned_by: "qwencloud" },
						{ id: "wan2.7-image", owned_by: "qwencloud" },
					],
				}),
			);
		};

		const apiKey = `  ${serializeAlibabaTokenPlanCredential("sk-sp-test", "session_id=test")}  `;
		const options = alibabaTokenPlanModelManagerOptions({ apiKey, fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(requestedUrl).toBe(`${ALIBABA_TOKEN_PLAN_BASE_URL}/models`);
		expect(authorization).toBe("Bearer sk-sp-test");
		expect(models?.map(model => model.id)).toEqual([
			"deepseek-v4-flash",
			"deepseek-v4-flash-0731",
			"kimi-k2.7-code",
			"MiniMax-M2.5",
			"qwen3.7-plus",
		]);
		expect(models?.find(model => model.id === "deepseek-v4-flash")).toMatchObject({
			reasoning: true,
			thinking: {
				mode: "effort",
				efforts: ["high", "xhigh"],
			},
		});
		expect(models?.find(model => model.id === "qwen3.7-plus")).toMatchObject({
			id: "qwen3.7-plus",
			provider: "alibaba-token-plan",
			name: "Qwen3.7 Plus",
			contextWindow: 1_000_000,
			maxTokens: 64_000,
		});
		expect(options.dynamicModelsAuthoritative).toBe(true);
	});

	test("routes discovery to the credential's region when it is China (Beijing)", async () => {
		let requestedUrl = "";
		const fetchMock: FetchImpl = input => {
			requestedUrl = String(input);
			return Promise.resolve(Response.json({ data: [{ id: "qwen3.7-plus", owned_by: "qwencloud" }] }));
		};

		const apiKey = serializeAlibabaTokenPlanCredential(
			"sk-sp-beijing",
			"",
			"https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
		);
		const options = alibabaTokenPlanModelManagerOptions({ apiKey, fetch: fetchMock });
		const models = await options.fetchDynamicModels?.();

		expect(requestedUrl).toBe("https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/models");
		expect(models?.[0]).toMatchObject({
			id: "qwen3.7-plus",
			baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
		});
	});

	test("rejects malformed compound credentials before model discovery", () => {
		let fetched = false;
		const fetchMock: FetchImpl = () => {
			fetched = true;
			return Promise.resolve(Response.json({ data: [] }));
		};

		const options = alibabaTokenPlanModelManagerOptions({
			apiKey: '  {"token":"sk-sp-test","cookie":"session=secret"',
			fetch: fetchMock,
		});
		expect(options.fetchDynamicModels).toBeUndefined();
		expect(fetched).toBe(false);
	});

	test("uses Token Plan-specific environment keys and authoritative discovery", () => {
		const descriptor = CATALOG_PROVIDERS.find(provider => provider.id === "alibaba-token-plan");
		expect(descriptor).toMatchObject({
			defaultModel: "qwen3.7-plus",
			envVars: ["ALIBABA_TOKEN_PLAN_API_KEY", "BAILIAN_TOKEN_PLAN_API_KEY"],
			dynamicModelsAuthoritative: true,
			catalogDiscovery: { label: "QwenCloud Token Plan" },
		});
	});
});

describe("Alibaba Coding Plan static models", () => {
	test("bundles deepseek-v4-pro-0813 with coding-intl endpoint and 1M context", () => {
		expect(ALIBABA_CODING_PLAN_STATIC_MODELS.find(m => m.id === "deepseek-v4-pro-0813")).toMatchObject({
			id: "deepseek-v4-pro-0813",
			provider: "alibaba-coding-plan",
			baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
			contextWindow: 1_000_000,
			maxTokens: 384_000,
			reasoning: true,
		});

		const bundled = getBundledModel<"openai-completions">("alibaba-coding-plan", "deepseek-v4-pro-0813");
		expect(bundled).toMatchObject({
			id: "deepseek-v4-pro-0813",
			provider: "alibaba-coding-plan",
			baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
			contextWindow: 1_000_000,
			maxTokens: 384_000,
			reasoning: true,
		});
	});
});
