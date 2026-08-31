import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";
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
		const compat = resolveModelPolicy(zhipuByProvider()).compat;

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
		const compat = resolveModelPolicy(zhipuByBaseUrl()).compat;

		expect(compat.thinkingFormat).toBe("zai");
		expect(compat.supportsReasoningEffort).toBe(false);
	});

	it("enables reasoning_effort for GLM-5.2 on both Zhipu route shapes", () => {
		const codingPlanCompat = resolveModelPolicy(zhipuGlm52ByProvider()).compat;
		const officialCompat = resolveModelPolicy(zhipuGlm52ByOfficialBaseUrl()).compat;

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
		const resolved = resolveModelPolicy(model).compat;

		expect(resolved.supportsDeveloperRole).toBe(true);
		expect(resolved.supportsReasoningEffort).toBe(true);
		expect(resolved.thinkingFormat).toBe("openai");
		// Untouched fields still come from the zhipu branch.
		expect(resolved.reasoningContentField).toBe("reasoning_content");
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
		expect(resolveModelPolicy(glm52("zai", "https://api.z.ai/api/coding/paas/v4")).compat.streamIdleTimeoutMs).toBe(
			600_000,
		);
		expect(
			resolveModelPolicy(glm52("zhipu-coding-plan", "https://open.bigmodel.cn/api/coding/paas/v4")).compat
				.streamIdleTimeoutMs,
		).toBe(600_000);
		expect(resolveModelPolicy(glm52("opencode-go", "https://opencode.ai/zen/go/v1")).compat.streamIdleTimeoutMs).toBe(
			600_000,
		);
		expect(resolveModelPolicy(glm52("opencode-zen", "https://opencode.ai/zen/v1")).compat.streamIdleTimeoutMs).toBe(
			600_000,
		);
	});

	it("does not widen non-GLM models on the OpenCode gateway via the GLM floor", () => {
		const kimi = resolveModelPolicy({
			...baseModel,
			id: "kimi-k2.5",
			name: "Kimi K2.5",
			provider: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
		}).compat;
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

	it("maps glm-5.3-flash as a reasoning model with native image input", async () => {
		const mockFetch: FetchImpl = Object.assign(
			async (): Promise<Response> =>
				new Response(
					JSON.stringify({
						data: [
							{ id: "glm-5.3-flash", name: "GLM-5.3-Flash" },
							{ id: "glm-4.7-flash", name: "GLM-4.7-Flash" },
						],
					}),
					{ headers: { "content-type": "application/json" } },
				),
			{ preconnect: fetch.preconnect },
		);

		const options = zhipuCodingPlanModelManagerOptions({ apiKey: "test-key", fetch: mockFetch });
		const models = await options.fetchDynamicModels?.();
		const flash53 = models?.find(model => model.id === "glm-5.3-flash");
		const flash47 = models?.find(model => model.id === "glm-4.7-flash");

		// GLM-5.3-Flash is the first natively multimodal, mandatory-thinking
		// flash SKU; its id carries no `v` marker.
		expect(flash53?.reasoning).toBe(true);
		// Image input is rule-owned (`providers/zhipu-coding-plan.kdl`
		// input-modalities) and corrected at build time.
		expect(flash53 && buildModel(flash53).input).toEqual(["text", "image"]);
		// Older flash SKUs stay non-reasoning and text-only.
		expect(flash47?.reasoning).toBe(false);
		expect(flash47 && buildModel(flash47).input).toEqual(["text"]);
	});
});
