import { describe, expect, it } from "bun:test";
import { buildOpenAICompat } from "@oh-my-pi/pi-catalog/compat/openai";
import { DEFAULT_MODEL_PER_PROVIDER } from "@oh-my-pi/pi-catalog/provider-models";
import { zhipuCodingPlanModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";

/**
 * Resolver-branch coverage for the `isZhipu` path added by the
 * `zhipu-coding-plan` provider. GLM-5.2+ additionally accepts
 * `reasoning_effort`; older BigModel thinking SKUs keep the binary Z.AI-shaped
 * toggle only.
 */

const baseModel: Omit<ModelSpec<"openai-completions">, "provider" | "baseUrl"> = {
	api: "openai-completions",
	id: "glm-4.7",
	name: "GLM-4.7",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	maxTokens: 32_000,
	contextWindow: 200_000,
	reasoning: true,
};

function zhipuByProvider(): ModelSpec<"openai-completions"> {
	return {
		...baseModel,
		provider: "zhipu-coding-plan",
		baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
	};
}

function zhipuByBaseUrl(): ModelSpec<"openai-completions"> {
	return {
		...baseModel,
		// Provider intentionally not "zhipu-coding-plan" — exercises the
		// URL-based fallback branch.
		provider: "custom",
		baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
	};
}

function zhipuGlm52ByProvider(): ModelSpec<"openai-completions"> {
	return {
		...baseModel,
		id: "glm-5.2",
		name: "GLM-5.2",
		provider: "zhipu-coding-plan",
		baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
	};
}

function zhipuGlm52ByOfficialBaseUrl(): ModelSpec<"openai-completions"> {
	return {
		...baseModel,
		id: "glm-5.2",
		name: "GLM-5.2",
		provider: "custom",
		baseUrl: "https://open.bigmodel.cn/api/paas/v4",
	};
}

describe("zhipu-coding-plan descriptor", () => {
	it("defaults to the same Zhipu-hosted model used by login validation", () => {
		expect(DEFAULT_MODEL_PER_PROVIDER["zhipu-coding-plan"]).toBe("glm-5.1");
		expect(DEFAULT_MODEL_PER_PROVIDER.zai).toBe("glm-5.3");
	});
});

describe("openai-completions compat — zhipu-coding-plan branch", () => {
	it("forces zai thinking format and disables reasoning_effort before GLM-5.2", () => {
		const compat = buildOpenAICompat(zhipuByProvider());

		expect(compat.thinkingFormat).toBe("zai");
		expect(compat.supportsReasoningEffort).toBe(false);
		expect(compat.supportsDeveloperRole).toBe(false);
		expect(compat.reasoningContentField).toBe("reasoning_content");
		// Zhipu shares the multi-system-message tolerance of Z.AI.
		expect(compat.supportsMultipleSystemMessages).toBe(true);
		// `isZhipu` participates in the non-standard set, so `store` is off.
		expect(compat.supportsStore).toBe(false);
	});

	it("detects zhipu by baseUrl when provider id is custom", () => {
		const compat = buildOpenAICompat(zhipuByBaseUrl());

		expect(compat.thinkingFormat).toBe("zai");
		expect(compat.supportsReasoningEffort).toBe(false);
	});

	it("enables reasoning_effort for GLM-5.2 on both Zhipu route shapes", () => {
		const codingPlanCompat = buildOpenAICompat(zhipuGlm52ByProvider());
		const officialCompat = buildOpenAICompat(zhipuGlm52ByOfficialBaseUrl());

		expect(codingPlanCompat.thinkingFormat).toBe("zai");
		expect(codingPlanCompat.supportsReasoningEffort).toBe(true);
		expect(officialCompat.thinkingFormat).toBe("zai");
		expect(officialCompat.supportsReasoningEffort).toBe(true);
		expect(officialCompat.reasoningContentField).toBe("reasoning_content");
		expect(codingPlanCompat.maxTokensField).toBe("max_tokens");
		expect(officialCompat.maxTokensField).toBe("max_tokens");
	});

	it("lets explicit model.compat overrides win at the resolver layer", () => {
		const model: ModelSpec<"openai-completions"> = {
			...zhipuByProvider(),
			compat: {
				supportsDeveloperRole: true,
				supportsReasoningEffort: true,
				thinkingFormat: "openai",
			},
		};
		const resolved = buildOpenAICompat(model);

		expect(resolved.supportsDeveloperRole).toBe(true);
		expect(resolved.supportsReasoningEffort).toBe(true);
		expect(resolved.thinkingFormat).toBe("openai");
		// Untouched fields still come from the zhipu branch.
		expect(resolved.reasoningContentField).toBe("reasoning_content");
	});
});

describe("openai-completions compat — Z.AI GLM-5.3-Flash", () => {
	it("keeps the global Coding Plan endpoint on the existing Z.AI reasoning dialect", () => {
		const compat = buildOpenAICompat({
			...zhipuGlm52ByProvider(),
			id: "glm-5.3-flash",
			name: "GLM-5.3-Flash",
			provider: "zai",
			baseUrl: "https://api.z.ai/api/coding/paas/v4",
			input: ["text", "image"],
		});

		expect(compat.thinkingFormat).toBe("zai");
		expect(compat.supportsReasoningEffort).toBe(true);
		expect(compat.reasoningContentField).toBe("reasoning_content");
		expect(compat.streamIdleTimeoutMs).toBe(600_000);
	});
});

describe("openai-completions compat — GLM coding-plan stream idle timeout", () => {
	function glm52(provider: string, baseUrl: string): ModelSpec<"openai-completions"> {
		return { ...baseModel, id: "glm-5.2", name: "GLM-5.2", provider, baseUrl };
	}

	// GLM coding-plan SKUs idle for minutes mid-reasoning; the 600s watchdog
	// floor must apply on every gateway that fronts them, not just the native
	// Z.AI/Zhipu hosts (issue #4758: GLM-5.2 via opencode-go stalled with
	// "OpenAI completions stream stalled while waiting for the next event").
	it("widens the idle timeout to 600s for GLM-5.x on Z.AI, Zhipu, and OpenCode gateways", () => {
		expect(buildOpenAICompat(glm52("zai", "https://api.z.ai/api/coding/paas/v4")).streamIdleTimeoutMs).toBe(600_000);
		expect(
			buildOpenAICompat(glm52("zhipu-coding-plan", "https://open.bigmodel.cn/api/coding/paas/v4"))
				.streamIdleTimeoutMs,
		).toBe(600_000);
		expect(buildOpenAICompat(glm52("opencode-go", "https://opencode.ai/zen/go/v1")).streamIdleTimeoutMs).toBe(
			600_000,
		);
		expect(buildOpenAICompat(glm52("opencode-zen", "https://opencode.ai/zen/v1")).streamIdleTimeoutMs).toBe(600_000);
	});

	it("does not widen non-GLM models on the OpenCode gateway via the GLM floor", () => {
		const kimi = buildOpenAICompat({
			...baseModel,
			id: "kimi-k2.5",
			name: "Kimi K2.5",
			provider: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
		});
		expect(kimi.streamIdleTimeoutMs).toBeUndefined();
	});
});

describe("zhipu-coding-plan model discovery", () => {
	it("uses the dedicated Coding Plan endpoint by default", async () => {
		let requestedUrl = "";
		const mockFetch: FetchImpl = Object.assign(
			async (input: string | Request | URL): Promise<Response> => {
				requestedUrl = input instanceof Request ? input.url : String(input);
				return new Response(JSON.stringify({ data: [{ id: "glm-5.1", name: "GLM-5.1" }] }), {
					headers: { "content-type": "application/json" },
				});
			},
			{ preconnect: fetch.preconnect },
		);

		const options = zhipuCodingPlanModelManagerOptions({ apiKey: "test-key", fetch: mockFetch });
		expect(typeof options.fetchDynamicModels).toBe("function");
		expect(options.dynamicModelsAuthoritative).toBe(true);
		const models = await options.fetchDynamicModels?.();

		expect(requestedUrl).toBe("https://open.bigmodel.cn/api/coding/paas/v4/models");
		expect(models?.[0]?.id).toBe("glm-5.1");
		expect(models?.[0]?.baseUrl).toBe("https://open.bigmodel.cn/api/coding/paas/v4");
	});
});

describe("zhipu-coding-plan GLM-5.3-Flash discovery", () => {
	it("preserves native image input and Z.AI reasoning compatibility", async () => {
		const mockFetch: FetchImpl = Object.assign(
			async (): Promise<Response> => {
				return new Response(JSON.stringify({ data: [{ id: "glm-5.3-flash", name: "GLM-5.3-Flash" }] }), {
					headers: { "content-type": "application/json" },
				});
			},
			{ preconnect: fetch.preconnect },
		);

		const options = zhipuCodingPlanModelManagerOptions({ apiKey: "test-key", fetch: mockFetch });
		const model = (await options.fetchDynamicModels?.())?.[0];

		expect(model).toMatchObject({
			id: "glm-5.3-flash",
			input: ["text", "image"],
			reasoning: true,
			compat: {
				thinkingFormat: "zai",
				reasoningContentField: "reasoning_content",
				supportsDeveloperRole: false,
			},
		});
		expect(buildOpenAICompat(model as ModelSpec<"openai-completions">).supportsReasoningEffort).toBe(true);
	});
});
