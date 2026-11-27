import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import {
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	mapModelsDevToModels,
	zaiModelManagerOptions,
	zhipuCodingPlanModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { removeWithRetries } from "../../utils/src/temp";

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

	it("keeps FlashX reasoning and image support across bundled and discovered coding-plan models", async () => {
		const mockFetch: FetchImpl = Object.assign(
			async (): Promise<Response> =>
				new Response(
					JSON.stringify({
						data: [
							{ id: "glm-5.3-flash", name: "GLM-5.3-Flash" },
							{ id: "glm-5.3-flashx", name: "GLM-5.3-FlashX" },
							{ id: "glm-4.7-flashx", name: "GLM-4.7-FlashX" },
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
		const flashx53 = models?.find(model => model.id === "glm-5.3-flashx");
		const flashx47 = models?.find(model => model.id === "glm-4.7-flashx");
		const bundled = getBundledModel<"openai-completions">("zhipu-coding-plan", "glm-5.3-flashx");

		expect(bundled).toMatchObject({
			api: "openai-completions",
			baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
			contextWindow: 1_000_000,
			maxTokens: 131_072,
			input: ["text", "image"],
			thinking: { mode: "effort", efforts: ["low", "high", "max"], defaultLevel: "max", requiresEffort: true },
		});
		expect(flashx53 && buildModel(flashx53)).toMatchObject({
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_000_000,
			maxTokens: 131_072,
			thinking: { mode: "effort", efforts: ["low", "high", "max"], defaultLevel: "max", requiresEffort: true },
		});
		const flash47 = models?.find(model => model.id === "glm-4.7-flash");

		expect(flash53?.reasoning).toBe(true);
		expect(flash53 && buildModel(flash53).input).toEqual(["text", "image"]);
		// Older flash SKUs claim no reasoning identity and stay text-only.
		expect(flash47?.reasoning).toBeUndefined();
		expect(flash47 && buildModel(flash47).input).toEqual(["text"]);
		expect(flashx47?.reasoning).toBeUndefined();
		expect(flashx47 && buildModel(flashx47).input).toEqual(["text"]);
	});

	it("ships GLM-5.4 with vision, 1M context, and the mandatory-thinking ladder on both coding plans", async () => {
		const mockFetch: FetchImpl = Object.assign(
			async (): Promise<Response> =>
				new Response(JSON.stringify({ data: [{ id: "glm-5.4", name: "GLM-5.4" }] }), {
					headers: { "content-type": "application/json" },
				}),
			{ preconnect: fetch.preconnect },
		);
		const discovered = (
			await zhipuCodingPlanModelManagerOptions({ apiKey: "test-key", fetch: mockFetch }).fetchDynamicModels?.()
		)?.find(model => model.id === "glm-5.4");
		const expected = {
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 1_000_000,
			maxTokens: 131_072,
			thinking: { efforts: ["low", "high", "max"], defaultLevel: "max", requiresEffort: true },
		};

		expect(discovered && buildModel(discovered)).toMatchObject(expected);
		expect(getBundledModel("zhipu-coding-plan", "glm-5.4")).toMatchObject(expected);
		expect(getBundledModel("zai", "glm-5.4")).toMatchObject(expected);
	});
});

// The stencil.so `zai-coding-plan` key reports all-$0 subscription rates; the
// `zai` (pay-as-you-go) key carries the real per-token rates for the identical
// GLM ids, matching how other subscription providers surface comparison pricing.
describe("zai GLM pricing sources the PAYG stencil.so key", () => {
	it("mapped zai models carry the PAYG per-token costs, not the coding-plan $0 rates", () => {
		const payload = {
			zai: {
				models: {
					"glm-5.2": {
						name: "GLM-5.2",
						reasoning: true,
						tool_call: true,
						modalities: { input: ["text"], output: ["text"] },
						cost: { input: 1.4, output: 4.4, cache_read: 0.26, cache_write: 0 },
						limit: { context: 1_000_000, output: 131_072 },
					},
				},
			},
			"zai-coding-plan": {
				models: {
					"glm-5.2": {
						name: "GLM-5.2",
						reasoning: true,
						tool_call: true,
						modalities: { input: ["text"], output: ["text"] },
						cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
						limit: { context: 1_000_000, output: 131_072 },
					},
				},
			},
		};

		const zai = mapModelsDevToModels(payload, MODELS_DEV_PROVIDER_DESCRIPTORS).filter(
			model => model.provider === "zai",
		);
		const glm52 = zai.find(model => model.id === "glm-5.2");
		expect(glm52).toBeDefined();
		expect(glm52?.cost).toEqual({ input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 });
	});
});

describe("zai API routing", () => {
	it("routes GLM-5.3-Flash through the native API without moving supported Anthropic models", () => {
		const payload = {
			zai: {
				models: {
					"glm-5.2": {
						name: "GLM-5.2",
						tool_call: true,
					},
					"glm-5.3-flash": {
						name: "GLM-5.3-Flash",
						tool_call: true,
					},
				},
			},
		};

		const models = mapModelsDevToModels(payload, MODELS_DEV_PROVIDER_DESCRIPTORS);
		const glm52 = models.find(model => model.provider === "zai" && model.id === "glm-5.2");
		const glm53Flash = models.find(model => model.provider === "zai" && model.id === "glm-5.3-flash");

		expect(glm52).toMatchObject({
			api: "anthropic-messages",
			baseUrl: "https://api.z.ai/api/anthropic",
		});
		expect(glm53Flash).toMatchObject({
			api: "openai-completions",
			baseUrl: "https://api.z.ai/api/coding/paas/v4",
		});
	});
});

describe("zai model discovery", () => {
	it("surfaces newly listed GLM ids on their route while keeping bundled-only SKUs and metadata", async () => {
		const requests: string[] = [];
		const fetchImpl: FetchImpl = Object.assign(
			async (input: string | Request | URL, init?: RequestInit): Promise<Response> => {
				const headers = new Headers(init?.headers);
				requests.push(`${String(input)} ${headers.get("authorization")}`);
				return Response.json({
					object: "list",
					data: ["glm-5.3", "glm-5.3-flash", "glm-5.4"].map(id => ({ id, object: "model", owned_by: "z-ai" })),
				});
			},
			{ preconnect: fetch.preconnect },
		);
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-zai-discovery-"));
		try {
			const { models } = await resolveProviderModels(
				{
					...zaiModelManagerOptions({ apiKey: "zai-key", fetch: fetchImpl }),
					cacheDbPath: path.join(tempDir, "models.db"),
				},
				"online",
			);
			const byId = new Map(models.map(model => [model.id, model]));

			expect(requests).toEqual(["https://api.z.ai/api/coding/paas/v4/models Bearer zai-key"]);
			expect(byId.get("glm-5.4")).toMatchObject({
				api: "anthropic-messages",
				baseUrl: "https://api.z.ai/api/anthropic",
				reasoning: true,
			});
			expect(byId.get("glm-5.3-flash")).toMatchObject({
				api: "openai-completions",
				baseUrl: "https://api.z.ai/api/coding/paas/v4",
			});
			// The id-only listing must not erase bundled limits and PAYG pricing.
			const bundled = getBundledModel("zai", "glm-5.3");
			expect(byId.get("glm-5.3")).toMatchObject({
				name: bundled.name,
				contextWindow: bundled.contextWindow,
				cost: bundled.cost,
			});
			// Live SKUs the listing omits stay selectable.
			expect(byId.has("glm-5v-turbo")).toBe(true);
		} finally {
			await removeWithRetries(tempDir);
		}
	});
});
