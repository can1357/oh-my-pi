import { describe, expect, it } from "bun:test";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import { Effort } from "@pk-nerdsaver-ai/pi-catalog/effort";
import {
	clampThinkingLevelForModel,
	getSupportedEfforts,
	mapEffortToAnthropicAdaptiveEffort,
	mapEffortToGoogleThinkingLevel,
	minimumSupportedEffort,
	requireSupportedEffort,
} from "@pk-nerdsaver-ai/pi-catalog/model-thinking";
import type { Api, Model, ModelSpec, Provider } from "@pk-nerdsaver-ai/pi-catalog/types";

function createModel<TApi extends Api>(overrides: {
	id: string;
	api: TApi;
	provider: Provider;
	reasoning?: boolean;
	baseUrl?: string;
	compat?: ModelSpec<TApi>["compat"];
	thinking?: ModelSpec<TApi>["thinking"];
}): Model<TApi> {
	return buildModel({
		id: overrides.id,
		name: overrides.id,
		api: overrides.api,
		provider: overrides.provider,
		baseUrl: overrides.baseUrl ?? "",
		reasoning: overrides.reasoning ?? true,
		compat: overrides.compat,
		thinking: overrides.thinking,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	});
}

describe("model thinking derivation", () => {
	it("stores supported efforts for Codex mini in model metadata", () => {
		const model = createModel({
			id: "gpt-5.1-codex-mini",
			api: "openai-codex-responses",
			provider: "openai-codex",
		});

		expect(model.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Medium, Effort.High],
		});
		expect(() => requireSupportedEffort(model, Effort.Low)).toThrow(/Supported efforts: medium, high/);
		expect(() => requireSupportedEffort(model, Effort.XHigh)).toThrow(/Supported efforts: medium, high/);
	});

	it("stores xhigh support directly in metadata for GPT-5.2", () => {
		const model = createModel({
			id: "gpt-5.2-codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
		});

		expect(model.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		});
		expect(requireSupportedEffort(model, Effort.XHigh)).toBe(Effort.XHigh);
	});

	it("stores MiniMax M2 and GPT-OSS OpenAI-compatible effort limits in model metadata", () => {
		const minimax = createModel({
			id: "minimax-m2.7",
			api: "openai-completions",
			provider: "fireworks",
			baseUrl: "https://api.fireworks.ai/inference/v1",
		});
		const gptOss = createModel({
			id: "gpt-oss-120b",
			api: "openai-completions",
			provider: "fireworks",
			baseUrl: "https://api.fireworks.ai/inference/v1",
		});

		expect(minimax.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High],
			// MiniMax M2 is a reasoning-first architecture — thinking-off clamps.
			requiresEffort: true,
		});
		expect(gptOss.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High],
		});
		expect(minimax.thinking?.effortMap).toBeUndefined();
		expect(gptOss.thinking?.effortMap).toBeUndefined();
	});

	it("stores MiMo OpenAI-compatible effort limits in model metadata", () => {
		const mimo = createModel({
			id: "mimo-v2.5-pro",
			api: "openai-completions",
			provider: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
		});
		const openRouterMimo = createModel({
			id: "xiaomi/mimo-v2.5-pro",
			api: "openrouter",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
		});
		const staleMimo = createModel({
			id: "mimo-v2.5-pro",
			api: "openai-completions",
			provider: "nanogpt",
			baseUrl: "https://nano-gpt.com/api/v1",
			compat: { reasoningEffortMap: {} },
			thinking: {
				mode: "effort",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
				effortMap: { minimal: "low", xhigh: "high" },
			},
		});
		const nativeXiaomi = createModel({
			id: "mimo-v2.5-pro",
			api: "openai-completions",
			provider: "xiaomi",
			baseUrl: "https://api.xiaomimimo.com/v1",
		});

		const expectedThinking = {
			mode: "effort" as const,
			efforts: [Effort.Low, Effort.Medium, Effort.High],
		};
		expect(mimo.thinking).toEqual(expectedThinking);
		expect(openRouterMimo.thinking).toEqual(expectedThinking);
		expect(staleMimo.thinking).toEqual(expectedThinking);
		expect(mimo.compat.reasoningEffortMap).toEqual({ minimal: "low", xhigh: "high" });
		expect(openRouterMimo.compat.reasoningEffortMap).toEqual({ minimal: "low", xhigh: "high" });
		expect(staleMimo.compat.reasoningEffortMap).toEqual({ minimal: "low", xhigh: "high" });
		expect(requireSupportedEffort(mimo, Effort.High)).toBe(Effort.High);
		expect(() => requireSupportedEffort(mimo, Effort.XHigh)).toThrow(/Supported efforts: low, medium, high/);
		expect(clampThinkingLevelForModel(mimo, Effort.Minimal)).toBe(Effort.Low);
		expect(clampThinkingLevelForModel(mimo, Effort.XHigh)).toBe(Effort.High);

		expect(nativeXiaomi.thinking?.efforts).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High]);
	});

	it("normalizes stale explicit MiniMax M2 / GPT-OSS effort metadata from caches", () => {
		const staleMinimax = createModel({
			id: "minimax-m2.7",
			api: "openai-completions",
			provider: "fireworks",
			baseUrl: "https://api.fireworks.ai/inference/v1",
			thinking: {
				mode: "effort",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
				effortMap: { minimal: "none", xhigh: "max" },
			},
		});
		const staleGptOss = createModel({
			id: "gpt-oss-120b",
			api: "openai-completions",
			provider: "fireworks",
			baseUrl: "https://api.fireworks.ai/inference/v1",
			thinking: {
				mode: "effort",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			},
		});

		expect(staleMinimax.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High],
			requiresEffort: true,
		});
		expect(staleGptOss.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High],
		});
	});

	it("stores OpenAI-compatible provider effort maps in thinking metadata", () => {
		const fireworks = createModel({
			id: "glm-5.1",
			api: "openai-completions",
			provider: "fireworks",
			baseUrl: "https://api.fireworks.ai/inference/v1",
		});
		const groqQwen = createModel({
			id: "qwen/qwen3-32b",
			api: "openai-completions",
			provider: "groq",
			baseUrl: "https://api.groq.com/openai/v1",
		});
		const deepseek = createModel({
			id: "deepseek-v4-flash",
			api: "openai-completions",
			provider: "deepseek",
			baseUrl: "https://api.deepseek.com/v1",
			compat: { reasoningEffortMap: { xhigh: "max-plus" } },
		});
		const openRouterAnthropic = createModel({
			id: "anthropic/claude-opus-4.7",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
		});

		expect(fireworks.thinking?.effortMap).toEqual({ minimal: "none" });
		expect(groqQwen.thinking?.effortMap).toEqual({
			minimal: "default",
			low: "default",
			medium: "default",
			high: "default",
		});
		expect(deepseek.thinking?.effortMap).toMatchObject({
			minimal: "high",
			low: "high",
			medium: "high",
			high: "high",
			xhigh: "max-plus",
		});
		expect(openRouterAnthropic.thinking?.effortMap).toEqual({
			minimal: "low",
			low: "medium",
			medium: "high",
			high: "xhigh",
			xhigh: "max",
		});
	});

	it("maps GLM-5.2 reasoning effort per host dialect", () => {
		const zai = createModel({
			id: "glm-5.2",
			api: "openai-completions",
			provider: "zai",
			baseUrl: "https://api.z.ai/api/paas/v4",
		});
		const fireworks = createModel({
			id: "glm-5.2",
			api: "openai-completions",
			provider: "fireworks",
			baseUrl: "https://api.fireworks.ai/inference/v1",
		});
		const openRouter = createModel({
			id: "z-ai/glm-5.2",
			api: "openrouter",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
		});

		// Z.ai dialect: the model only does none/high/max, so the lower tiers
		// collapse and the top `xhigh` tier reaches `max`.
		expect(zai.thinking?.effortMap).toEqual({
			minimal: "none",
			low: "high",
			medium: "high",
			high: "high",
			xhigh: "max",
		});
		// Fireworks keeps its distinct lower tiers and the `minimal -> none` quirk;
		// only the top `xhigh` UI tier remaps onto the genuine `max` budget.
		expect(getSupportedEfforts(fireworks)).toContain(Effort.XHigh);
		expect(fireworks.thinking?.effortMap).toEqual({ minimal: "none", xhigh: "max" });
		// OpenRouter rejects `max` and treats `xhigh` as its max tier: expose the
		// `xhigh` tier and pass it through unmapped.
		expect(getSupportedEfforts(openRouter)).toContain(Effort.XHigh);
		expect(openRouter.thinking?.effortMap).toBeUndefined();
	});

	it("encodes the Gemini 3 Pro effort gap and mandatory reasoning in metadata", () => {
		const model = createModel({
			id: "gemini-3-pro-preview",
			api: "google-generative-ai",
			provider: "google",
		});

		expect(model.thinking).toEqual({
			mode: "google-level",
			efforts: [Effort.Low, Effort.High],
			requiresEffort: true,
		});
		expect(mapEffortToGoogleThinkingLevel(Effort.Low)).toBe("LOW");
		expect(mapEffortToGoogleThinkingLevel(Effort.High)).toBe("HIGH");
		expect(mapEffortToGoogleThinkingLevel(Effort.XHigh)).toBe("HIGH");
		expect(() => requireSupportedEffort(model, Effort.Medium)).toThrow(/not supported/);
	});

	it("bakes requiresEffort for Gemini 3.x on any provider and backfills explicit metadata", () => {
		// Derivation: aggregator-hosted Gemini 3.5 gets the flag, 2.5 does not.
		const openRouterFlash = createModel({
			id: "google/gemini-3.5-flash",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
		});
		expect(openRouterFlash.thinking?.requiresEffort).toBe(true);

		const legacyFlash = createModel({
			id: "gemini-2.5-flash",
			api: "google-generative-ai",
			provider: "google",
		});
		expect(legacyFlash.thinking?.requiresEffort).toBeUndefined();

		// Backfill: explicit (pre-flag) baked thinking gains the wire fact;
		// explicit `false` wins over identity.
		const baked = createModel({
			id: "gemini-3.1-pro-preview",
			api: "google-generative-ai",
			provider: "google",
			thinking: { mode: "google-level", efforts: [Effort.Low, Effort.High] },
		});
		expect(baked.thinking?.requiresEffort).toBe(true);

		const optedOut = createModel({
			id: "gemini-3.1-pro-preview",
			api: "google-generative-ai",
			provider: "google",
			thinking: { mode: "google-level", efforts: [Effort.Low, Effort.High], requiresEffort: false },
		});
		expect(optedOut.thinking?.requiresEffort).toBe(false);

		// Floor selection follows canonical order, not array order.
		expect(minimumSupportedEffort(baked)).toBe(Effort.Low);
		expect(minimumSupportedEffort(openRouterFlash)).toBe(Effort.Minimal);
	});

	it("flags reasoning-only families and thinking-variant orphans", () => {
		expect(
			createModel({
				id: "openai/o3-mini",
				api: "openai-completions",
				provider: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
			}).thinking?.requiresEffort,
		).toBe(true);
		expect(
			createModel({ id: "minimax-m2.7", api: "openai-completions", provider: "fireworks" }).thinking?.requiresEffort,
		).toBe(true);
		expect(
			createModel({ id: "kimi-k2-thinking", api: "openai-completions", provider: "venice" }).thinking
				?.requiresEffort,
		).toBe(true);
		expect(
			createModel({ id: "deepseek-reasoner", api: "openai-completions", provider: "deepseek" }).thinking
				?.requiresEffort,
		).toBe(true);
		// Negated tokens name the NON-thinking SKU.
		expect(
			createModel({ id: "deepseek-non-thinking-v3.2-exp", api: "openai-completions", provider: "aimlapi" }).thinking
				?.requiresEffort,
		).toBeUndefined();
		// Gemini 2.5: Pro floors thinkingBudget at 128; Flash keeps the off switch.
		expect(
			createModel({ id: "gemini-2.5-pro", api: "google-generative-ai", provider: "google" }).thinking
				?.requiresEffort,
		).toBe(true);
	});

	it("encodes anthropic transport mode and adaptive wire maps in metadata", () => {
		const opus45 = createModel({ id: "claude-opus-4-5", api: "anthropic-messages", provider: "anthropic" });
		const opus46 = createModel({ id: "claude-opus-4.6", api: "anthropic-messages", provider: "anthropic" });
		const opus47 = createModel({ id: "claude-opus-4.7", api: "anthropic-messages", provider: "anthropic" });
		const opus47Bedrock = createModel({
			id: "us.anthropic.claude-opus-4-7",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
		});
		const sonnet46 = createModel({ id: "claude-sonnet-4.6", api: "anthropic-messages", provider: "anthropic" });
		const mythos = createModel({ id: "claude-mythos-5", api: "anthropic-messages", provider: "anthropic" });
		const mythosBedrock = createModel({
			id: "global.anthropic.claude-mythos-5",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
		});
		const minimaxM2 = createModel({ id: "MiniMax-M2.7", api: "anthropic-messages", provider: "minimax" });
		const minimaxM3 = createModel({ id: "MiniMax-M3", api: "anthropic-messages", provider: "minimax" });

		// Direct Anthropic Claude 4.5: Opus 4.5 supports `output_config.effort`
		// (sent alongside `thinking.budget_tokens`), Sonnet 4.5 and Haiku 4.5
		// reject the field with HTTP 400 "This model does not support the effort
		// parameter." (#3497). Adaptive (4.6+) classification is exercised below.
		expect(opus45.thinking?.mode).toBe("anthropic-budget-effort");
		const opus45Bedrock = createModel({
			id: "us.anthropic.claude-opus-4-5-20251101",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
		});
		expect(opus45Bedrock.thinking?.mode).toBe("anthropic-budget-effort");
		const sonnet45 = createModel({ id: "claude-sonnet-4-5", api: "anthropic-messages", provider: "anthropic" });
		expect(sonnet45.thinking?.mode).toBe("budget");
		const haiku45 = createModel({ id: "claude-haiku-4-5", api: "anthropic-messages", provider: "anthropic" });
		expect(haiku45.thinking?.mode).toBe("budget");
		const sonnet45Bedrock = createModel({
			id: "us.anthropic.claude-sonnet-4-5-20250929",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
		});
		expect(sonnet45Bedrock.thinking?.mode).toBe("budget");
		expect(opus46.thinking?.mode).toBe("anthropic-adaptive");
		expect(sonnet46.thinking?.mode).toBe("anthropic-adaptive");
		expect(mythosBedrock.thinking?.mode).toBe("anthropic-adaptive");
		expect(minimaxM2.thinking).toEqual({
			mode: "anthropic-adaptive",
			efforts: [Effort.Low, Effort.Medium, Effort.High],
			effortMap: {
				low: "adaptive",
				medium: "adaptive",
				high: "adaptive",
			},
			requiresEffort: true,
		});
		expect(minimaxM3.thinking).toEqual({
			mode: "anthropic-adaptive",
			efforts: [Effort.Low, Effort.Medium, Effort.High],
			effortMap: {
				low: "adaptive",
				medium: "adaptive",
				high: "adaptive",
			},
		});
		expect(mapEffortToAnthropicAdaptiveEffort(minimaxM3, Effort.High)).toBe("adaptive");
		// Opus 4.6 has no real xhigh level — the baked 4-tier map aliases XHigh to "max".
		expect(opus46.thinking?.effortMap).toEqual({ minimal: "low", xhigh: "max" });
		expect(mapEffortToAnthropicAdaptiveEffort(opus46, Effort.XHigh)).toBe("max");
		// Opus 4.7+ on the Messages API exposes the full five-tier scale: the baked
		// map shifts each user-facing effort up one notch so the top tier reaches "max".
		expect(opus47.thinking?.effortMap).toEqual({
			minimal: "low",
			low: "medium",
			medium: "high",
			high: "xhigh",
			xhigh: "max",
		});
		expect(mapEffortToAnthropicAdaptiveEffort(opus47, Effort.Minimal)).toBe("low");
		expect(mapEffortToAnthropicAdaptiveEffort(opus47, Effort.High)).toBe("xhigh");
		expect(mapEffortToAnthropicAdaptiveEffort(opus47, Effort.XHigh)).toBe("max");
		expect(mapEffortToAnthropicAdaptiveEffort(mythos, Effort.High)).toBe("xhigh");
		expect(mapEffortToAnthropicAdaptiveEffort(mythosBedrock, Effort.XHigh)).toBe("max");
		// Bedrock Converse keeps the four-tier legacy mapping; xhigh aliases to "max".
		expect(opus47Bedrock.thinking?.effortMap).toEqual({ minimal: "low", xhigh: "max" });
		expect(mapEffortToAnthropicAdaptiveEffort(opus47Bedrock, Effort.High)).toBe("high");
		expect(() => mapEffortToAnthropicAdaptiveEffort(sonnet46, Effort.XHigh)).toThrow(/not supported/);
	});

	it("bakes adaptive display support for Opus 4.7+ and Fable/Mythos 5", () => {
		const opus46 = createModel({ id: "claude-opus-4.6", api: "anthropic-messages", provider: "anthropic" });
		const opus47 = createModel({ id: "claude-opus-4-7", api: "anthropic-messages", provider: "anthropic" });
		// Dotted and dashed version forms are equivalent; bare dated ids stay Opus 4.0.
		const opus47Dotted = createModel({ id: "claude-opus-4.7", api: "anthropic-messages", provider: "anthropic" });
		const opus4Dated = createModel({
			id: "claude-opus-4-20250514",
			api: "anthropic-messages",
			provider: "anthropic",
		});
		const fable = createModel({ id: "claude-fable-5", api: "anthropic-messages", provider: "anthropic" });
		const fableBedrock = createModel({
			id: "global.anthropic.claude-fable-5",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
		});

		expect(opus46.thinking?.supportsDisplay).toBeUndefined();
		expect(opus47.thinking?.supportsDisplay).toBe(true);
		expect(opus47Dotted.thinking?.supportsDisplay).toBe(true);
		expect(opus4Dated.thinking?.supportsDisplay).toBeUndefined();
		expect(fable.thinking?.supportsDisplay).toBe(true);
		expect(fableBedrock.thinking?.supportsDisplay).toBe(true);
	});

	it("backfills wire facts onto explicit thinking, explicit values winning", () => {
		// Authored capability surface (mode/efforts) keeps identity-derived wire
		// facts: configs never need to know Anthropic's tier tables.
		const filled = createModel({
			id: "claude-opus-4-8",
			api: "anthropic-messages",
			provider: "anthropic",
			thinking: { mode: "anthropic-adaptive", efforts: [Effort.Low, Effort.High] },
		});
		expect(filled.thinking).toEqual({
			mode: "anthropic-adaptive",
			efforts: [Effort.Low, Effort.High],
			effortMap: { low: "medium", high: "xhigh" },
			supportsDisplay: true,
		});

		// Explicit wire facts are authoritative — including `false`.
		const pinned = createModel({
			id: "claude-opus-4-8",
			api: "anthropic-messages",
			provider: "anthropic",
			thinking: {
				mode: "anthropic-adaptive",
				efforts: [Effort.Low, Effort.High],
				effortMap: { xhigh: "max" },
				supportsDisplay: false,
			},
		});
		expect(pinned.thinking?.effortMap).toEqual({ xhigh: "max" });
		expect(pinned.thinking?.supportsDisplay).toBe(false);
	});

	it("infers thinking when explicit metadata omits efforts", () => {
		const model = buildModel(
			JSON.parse(`{
				"id": "gpt-5",
				"name": "gpt-5",
				"api": "openai-completions",
				"provider": "openai",
				"baseUrl": "",
				"reasoning": true,
				"thinking": { "mode": "effort" },
				"input": ["text"],
				"cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
				"contextWindow": 200000,
				"maxTokens": 32000
			}`),
		);

		expect(model.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		});
	});

	it("bakes sampling-param rejection into anthropic compat", () => {
		const sonnet45 = createModel({ id: "claude-sonnet-4-5", api: "anthropic-messages", provider: "anthropic" });
		const opus47 = createModel({ id: "claude-opus-4.7", api: "anthropic-messages", provider: "anthropic" });
		const fable = createModel({ id: "claude-fable-5", api: "anthropic-messages", provider: "anthropic" });

		expect(sonnet45.compat.supportsSamplingParams).toBe(true);
		expect(opus47.compat.supportsSamplingParams).toBe(false);
		expect(fable.compat.supportsSamplingParams).toBe(false);
	});

	it("encodes effort-dial-less reasoners as thinking: undefined", () => {
		const model = createModel({
			id: "grok-build",
			api: "openai-responses",
			provider: "xai-oauth",
			compat: { supportsReasoningEffort: false },
		});

		expect(model.reasoning).toBe(true);
		expect(model.thinking).toBeUndefined();
		expect(getSupportedEfforts(model)).toEqual([]);
		expect(clampThinkingLevelForModel(model, Effort.High)).toBeUndefined();
	});
});

describe("model thinking runtime helpers", () => {
	it("clamps from explicit metadata instead of inferring from model id", () => {
		const model = createModel({
			id: "custom-reasoner",
			api: "openai-codex-responses",
			provider: "custom",
			baseUrl: "https://example.com",
			thinking: { mode: "effort", efforts: [Effort.Medium, Effort.High] },
		});

		// `-reasoner` ids are thinking-only SKUs — the wire fact is backfilled
		// onto explicit metadata like effortMap.
		expect(model.thinking).toEqual({ mode: "effort", efforts: [Effort.Medium, Effort.High], requiresEffort: true });
		expect(clampThinkingLevelForModel(model, Effort.Minimal)).toBe(Effort.Medium);
		expect(clampThinkingLevelForModel(model, Effort.XHigh)).toBe(Effort.High);
		expect(clampThinkingLevelForModel(model, Effort.High)).toBe(Effort.High);
	});

	it('forces "off" for non-reasoning models', () => {
		const model = createModel({
			id: "plain-model",
			api: "openai-responses",
			provider: "openai",
			reasoning: false,
		});

		expect(clampThinkingLevelForModel(model, Effort.High)).toBeUndefined();
	});

	it("enables xhigh for openai-completions API (custom models)", () => {
		const model = createModel({
			id: "custom-model",
			api: "openai-completions",
			provider: "custom",
		});

		expect(model.thinking?.efforts.at(-1)).toBe(Effort.XHigh);
		expect(requireSupportedEffort(model, Effort.XHigh)).toBe(Effort.XHigh);
	});

	it("does not expose xhigh for binary-thinking openai-compat transports", () => {
		const model = createModel({
			id: "glm-4.7",
			api: "openai-completions",
			provider: "zai",
			baseUrl: "https://api.z.ai/v1",
			compat: { thinkingFormat: "zai" },
		});

		expect(model.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		});
		expect(requireSupportedEffort(model, Effort.High)).toBe(Effort.High);
		expect(() => requireSupportedEffort(model, Effort.XHigh)).toThrow(
			/Supported efforts: minimal, low, medium, high/,
		);
	});

	it("maps GLM-5.2 xhigh to Z.AI provider-native max", () => {
		const model = createModel({
			id: "glm-5.2",
			api: "openai-completions",
			provider: "zhipu-coding-plan",
			baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
			compat: { thinkingFormat: "zai" },
		});

		expect(model.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			effortMap: {
				minimal: "none",
				low: "high",
				medium: "high",
				high: "high",
				xhigh: "max",
			},
		});
		expect(requireSupportedEffort(model, Effort.XHigh)).toBe(Effort.XHigh);
	});

	it("maps Ollama Cloud GLM-5.2 xhigh to max and hides unsupported lower efforts", () => {
		const model = createModel({
			id: "glm-5.2",
			api: "ollama-chat",
			provider: "ollama-cloud",
			baseUrl: "https://ollama.com",
		});

		expect(model.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.High, Effort.XHigh],
			effortMap: {
				xhigh: "max",
			},
		});
		expect(requireSupportedEffort(model, Effort.High)).toBe(Effort.High);
		expect(requireSupportedEffort(model, Effort.XHigh)).toBe(Effort.XHigh);
		expect(() => requireSupportedEffort(model, Effort.Medium)).toThrow(/Supported efforts: high, xhigh/);
	});

	it("derives binary-thinking fallback from resolved compat when catalog compat is partial", () => {
		const model = createModel({
			id: "qwen/qwen3-32b",
			api: "openai-completions",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			compat: { supportsToolChoice: true },
		});

		expect(model.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		});
		expect(requireSupportedEffort(model, Effort.High)).toBe(Effort.High);
		expect(() => requireSupportedEffort(model, Effort.XHigh)).toThrow(
			/Supported efforts: minimal, low, medium, high/,
		);
	});

	it("exposes xhigh for OpenRouter-hosted Anthropic adaptive models", () => {
		const fable = createModel({
			id: "anthropic/claude-fable-5",
			api: "openai-completions",
			provider: "openrouter",
		});
		const opus46 = createModel({
			id: "anthropic/claude-opus-4.6",
			api: "openai-completions",
			provider: "openrouter",
		});
		const sonnet46 = createModel({
			id: "anthropic/claude-sonnet-4.6",
			api: "openai-completions",
			provider: "openrouter",
		});

		expect(fable.thinking?.efforts.at(-1)).toBe(Effort.XHigh);
		expect(opus46.thinking?.efforts.at(-1)).toBe(Effort.XHigh);
		expect(sonnet46.thinking?.efforts.at(-1)).toBe(Effort.High);
		expect(requireSupportedEffort(fable, Effort.XHigh)).toBe(Effort.XHigh);
	});

	it("enables xhigh for openai-responses and openai-codex-responses APIs", () => {
		const responsesModel = createModel({ id: "custom-responses", api: "openai-responses", provider: "custom" });
		const codexModel = createModel({ id: "custom-codex", api: "openai-codex-responses", provider: "custom" });

		expect(responsesModel.thinking?.efforts.at(-1)).toBe(Effort.XHigh);
		expect(codexModel.thinking?.efforts.at(-1)).toBe(Effort.XHigh);
		expect(requireSupportedEffort(responsesModel, Effort.XHigh)).toBe(Effort.XHigh);
		expect(requireSupportedEffort(codexModel, Effort.XHigh)).toBe(Effort.XHigh);
	});

	it("rejects effort requests against un-built reasoning specs", () => {
		const spec = {
			id: "broken-reasoner",
			name: "Broken Reasoner",
			api: "openai-responses",
			provider: "custom",
			baseUrl: "https://example.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 32000,
		} as ModelSpec<"openai-responses">;

		expect(() => requireSupportedEffort(spec, Effort.High)).toThrow(/not supported/);
	});

	it("drops authored thinking on non-reasoning models and re-derives empty efforts", () => {
		const nonReasoning = createModel({
			id: "plain-model",
			api: "openai-responses",
			provider: "custom",
			baseUrl: "https://example.com",
			reasoning: false,
			thinking: { mode: "effort", efforts: [Effort.High] },
		});
		expect(nonReasoning.thinking).toBeUndefined();

		// Empty explicit efforts are treated as absent metadata: infer instead.
		const emptyEfforts = createModel({
			id: "gpt-5.2-codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			thinking: { mode: "effort", efforts: [] },
		});
		expect(emptyEfforts.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		});
	});
});
