import { describe, expect, test } from "bun:test";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import { getEnvApiKey } from "@oh-my-pi/pi-ai/stream";
import { DEFAULT_MODEL_PER_PROVIDER, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { MODELS_DEV_PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { OpenAICompat } from "@oh-my-pi/pi-catalog/types";

describe("deepseek built-in provider (issue #830)", () => {
	test("registers built-in runtime descriptor with DEEPSEEK_API_KEY env discovery", () => {
		const descriptor = PROVIDER_DESCRIPTORS.find(item => item.providerId === "deepseek");
		expect(descriptor).toBeDefined();
		expect(descriptor?.defaultModel).toBe("deepseek-v4-pro");
		expect(descriptor?.catalogDiscovery?.envVars).toContain("DEEPSEEK_API_KEY");
		expect(DEFAULT_MODEL_PER_PROVIDER.deepseek).toBe("deepseek-v4-pro");
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
