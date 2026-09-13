import { describe, expect, test } from "bun:test";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { isExcludedModel } from "@oh-my-pi/pi-catalog/compat/behavior";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import {
	deepseekModelManagerOptions,
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	type ModelsDevModel,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl, ModelSpec, OpenAICompat } from "@oh-my-pi/pi-catalog/types";

describe("deepseek built-in provider (issue #830)", () => {
	test("registers built-in runtime descriptor with DEEPSEEK_API_KEY env discovery", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "deepseek");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("deepseek-v4-pro");
		expect(descriptor?.catalogDiscovery?.envVars).toContain("DEEPSEEK_API_KEY");
		expect(DEFAULT_MODEL_PER_PROVIDER.deepseek).toBe("deepseek-v4-pro");
	});

	test("V4.1 Flash ids declare image input even when discovery seeds text-only", () => {
		// DeepSeek-V4.1-Flash is natively multimodal and also serves the retired
		// `deepseek-v4-flash` alias; live `/models` discovery seeds `input: ["text"]`,
		// so the modality and the strip opt-out are rule-owned.
		const seed = (id: string): ModelSpec<"openai-completions"> => ({
			id,
			provider: "deepseek",
			name: id,
			api: "openai-completions",
			baseUrl: "https://api.deepseek.com",
			reasoning: true,
			input: ["text"],
			contextWindow: 1_000_000,
			maxTokens: 384_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
		for (const id of ["deepseek-flash", "deepseek-v4-flash"]) {
			const model = buildModel(seed(id));
			expect(model.input).toEqual(["text", "image"]);
			expect(model.compat?.stripImageInput).toBe(false);
		}
		const pro = buildModel(seed("deepseek-v4-pro"));
		expect(pro.input).toEqual(["text"]);
		expect(pro.compat?.stripImageInput).toBe(true);
	});

	test("V4.1 Flash migration (issue #11508) retires deepseek-v4-flash-vision-exp by policy", () => {
		expect(isExcludedModel("deepseek", "deepseek-v4-flash-vision-exp")).toBe(true);
		expect(isExcludedModel("deepseek", "deepseek-flash")).toBe(false);
		expect(isExcludedModel("deepseek", "deepseek-v4-flash")).toBe(false);
	});

	test("models.dev admission covers the bare V4.1 ids and still rejects pre-V4 chat", () => {
		const descriptor = MODELS_DEV_PROVIDER_DESCRIPTORS.find(item => item.providerId === "deepseek");
		const filterModel = descriptor?.filterModel;
		expect(filterModel).toBeDefined();
		// models.dev rows only need `tool_call` for the DeepSeek gate; the rest of
		// the admission decision comes from the taxonomy family.
		const row: ModelsDevModel = { tool_call: true };
		expect(filterModel?.("deepseek-flash", row)).toBe(true);
		expect(filterModel?.("deepseek-v4-flash", row)).toBe(true);
		expect(filterModel?.("deepseek-v4-pro", row)).toBe(true);
		expect(filterModel?.("deepseek-chat", row)).toBe(false);
	});

	test("manager drops the retired vision-exp id from caches and from live discovery", async () => {
		const options = deepseekModelManagerOptions({ apiKey: "k" });
		expect(options.dropCachedModelIdsOnStaticMismatch).toContain("deepseek-v4-flash-vision-exp");

		// The upstream roster keeps answering for the retired alias while it is
		// routed to V4.1 Flash; discovery must not re-list it.
		const fetch: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					data: [
						{ id: "deepseek-flash", object: "model" },
						{ id: "deepseek-v4-flash", object: "model" },
						{ id: "deepseek-v4-flash-vision-exp", object: "model" },
					],
				}),
				{ status: 200 },
			);
		const models = await deepseekModelManagerOptions({ apiKey: "k", fetch }).fetchDynamicModels?.();
		const ids = (models ?? []).map(model => model.id);
		expect(ids).toContain("deepseek-flash");
		expect(ids).toContain("deepseek-v4-flash");
		expect(ids).not.toContain("deepseek-v4-flash-vision-exp");
	});

	test("registers DeepSeek as an API-key login provider", () => {
		const provider = getOAuthProviders().find(item => item.id === "deepseek");
		expect(provider?.name).toBe("DeepSeek");
		expect(provider?.available).toBe(true);
	});

	test("resolves DEEPSEEK_API_KEY via env", () => {
		const previous = Bun.env.DEEPSEEK_API_KEY;
		Bun.env.DEEPSEEK_API_KEY = "deepseek-test-key";
		try {
			expect(getEnvApiKey("deepseek")).toBe("deepseek-test-key");
		} finally {
			if (previous === undefined) {
				delete Bun.env.DEEPSEEK_API_KEY;
			} else {
				Bun.env.DEEPSEEK_API_KEY = previous;
			}
		}
	});

	test("stencil.so mapping descriptor uses api.deepseek.com and forces reasoning_content + no tool_choice", () => {
		const descriptor = MODELS_DEV_PROVIDER_DESCRIPTORS.find(d => d.providerId === "deepseek");
		expect(descriptor).toBeDefined();
		expect(descriptor?.modelsDevKey).toBe("deepseek");
		expect(descriptor?.api).toBe("openai-completions");
		expect(descriptor?.baseUrl).toBe("https://api.deepseek.com");
		// Per-model compat: DeepSeek V4 supports thinking-mode tool calls, but only
		// with no explicit `tool_choice`, max_tokens, and reasoning_content replay.
		const compat =
			descriptor?.api === "openai-completions" ? (descriptor.compat as OpenAICompat | undefined) : undefined;
		expect(compat?.supportsDeveloperRole).toBe(false);
		expect(compat?.supportsReasoningEffort).toBe(true);
		expect(compat?.supportsToolChoice).toBe(false);
		expect(compat?.maxTokensField).toBe("max_tokens");
		expect(compat?.requiresReasoningContentForToolCalls).toBe(true);
		expect(compat?.requiresAssistantContentForToolCalls).toBe(true);
		expect(compat?.reasoningContentField).toBe("reasoning_content");
		expect(compat?.extraBody).toEqual({ thinking: { type: "enabled" } });
	});
});
