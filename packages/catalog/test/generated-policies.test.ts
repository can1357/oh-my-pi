import { describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { Api, ModelSpec, Provider } from "@oh-my-pi/pi-catalog/types";
import {
	applyAntigravityPricingFallback,
	applyGeneratedModelPolicies,
	applyOllamaCloudOutputCap,
	linkOpenAIPromotionTargets,
} from "../scripts/generated-policies";

function createSpec<TApi extends Api>(overrides: {
	id: string;
	api: TApi;
	provider: Provider;
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	priority?: number;
	applyPatchToolType?: "freeform" | "function";
	cost?: ModelSpec<TApi>["cost"];
	compat?: ModelSpec<TApi>["compat"];
	thinking?: ModelSpec<TApi>["thinking"];
}): ModelSpec<TApi> {
	return {
		id: overrides.id,
		name: overrides.id,
		api: overrides.api,
		provider: overrides.provider,
		baseUrl: "https://example.com",
		reasoning: overrides.reasoning ?? true,
		compat: overrides.compat,
		thinking: overrides.thinking,
		input: ["text"],
		cost: overrides.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: overrides.contextWindow ?? 200000,
		maxTokens: overrides.maxTokens ?? 32000,
		priority: overrides.priority,
		applyPatchToolType: overrides.applyPatchToolType,
	};
}

describe("generated model policies", () => {
	it("re-bakes thinking metadata and applies parsed catalog corrections", () => {
		const models: ModelSpec<Api>[] = [
			createSpec({
				id: "claude-opus-4-5",
				api: "anthropic-messages",
				provider: "anthropic",
				// Stale baked metadata must be replaced by the deriver's output.
				thinking: { mode: "budget", efforts: [Effort.High] },
				cost: { input: 0, output: 0, cacheRead: 1.5, cacheWrite: 18.75 },
				contextWindow: 1000000,
			}),
			createSpec({
				id: "anthropic.claude-opus-4-6-v1:0",
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				cost: { input: 0, output: 0, cacheRead: 1.5, cacheWrite: 18.75 },
				contextWindow: 1000000,
			}),
			createSpec({
				id: "gpt-5.2-codex",
				api: "openai-codex-responses",
				provider: "openai-codex",
				contextWindow: 400000,
			}),
			createSpec({
				id: "gpt-5.4-mini",
				api: "openai-codex-responses",
				provider: "openai-codex",
				contextWindow: 400000,
				priority: 2,
			}),
		];

		applyGeneratedModelPolicies(models);

		expect(models[0]?.thinking).toEqual({
			mode: "anthropic-budget-effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		});
		expect(models[0]?.cost.cacheRead).toBe(0.5);
		expect(models[0]?.cost.cacheWrite).toBe(6.25);
		expect(models[1]?.thinking).toEqual({
			mode: "anthropic-adaptive",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.Max],
		});
		expect(models[1]?.cost.cacheRead).toBe(0.5);
		expect(models[1]?.cost.cacheWrite).toBe(6.25);
		expect(models[1]?.contextWindow).toBe(1000000);
		expect(models[2]?.contextWindow).toBe(272000);
		expect(models[3]?.contextWindow).toBe(272000);
		expect(models[3]?.priority).toBe(1);
	});

	it("preserves OpenRouter's mandatory provider-authored effort ladder", () => {
		const models: ModelSpec<Api>[] = [
			createSpec({
				id: "mandatory-model",
				api: "openrouter",
				provider: "openrouter",
				thinking: {
					mode: "effort",
					efforts: [Effort.Low, Effort.High, Effort.Max],
					defaultLevel: Effort.Max,
					requiresEffort: true,
				},
			}),
		];

		applyGeneratedModelPolicies(models);

		expect(models[0]?.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.High, Effort.Max],
			defaultLevel: Effort.Max,
			requiresEffort: true,
		});
	});

	it("preserves generic chat-template provider-authored effort mappings", () => {
		const thinking = {
			mode: "effort" as const,
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			effortMap: {
				[Effort.Minimal]: "low",
				[Effort.Low]: "low",
				[Effort.Medium]: "high",
				[Effort.High]: "high",
				[Effort.XHigh]: "max",
				[Effort.Max]: "max",
			},
		};
		const models: ModelSpec<Api>[] = [
			createSpec({
				id: "deepseek-flash-v4",
				api: "openai-completions",
				provider: "yolo-auto",
				compat: { thinkingFormat: "chat-template", supportsReasoningEffort: true },
				thinking,
			}),
		];

		applyGeneratedModelPolicies(models);

		expect(models[0]?.thinking).toEqual(thinking);
	});

	it("applies GPT-5.6 off and long-context pricing through request-model aliases", () => {
		const models: ModelSpec<Api>[] = [
			createSpec({ id: "gpt-5.6", api: "openai-responses", provider: "openai" }),
			createSpec({ id: "gpt-5.6-luna", api: "openai-responses", provider: "openai" }),
			{
				...createSpec({ id: "gpt-5.6-sol-pro", api: "openai-responses", provider: "openai" }),
				requestModelId: "gpt-5.6-sol",
			},
			{
				...createSpec({ id: "gpt-5.6-terra-pro", api: "openai-responses", provider: "openai" }),
				requestModelId: "gpt-5.6-terra",
			},
			createSpec({ id: "gpt-5.6", api: "openai-responses", provider: "openrouter" }),
		];

		applyGeneratedModelPolicies(models);

		for (const model of models.slice(0, 4)) {
			expect(model.compat).toMatchObject({ reasoningDisableMode: "none-effort" });
			expect(model.cost.longContext?.inputThreshold).toBe(272_000);
		}
		expect(models[0]?.cost.longContext).toMatchObject({ input: 10, output: 45 });
		expect(models[1]?.cost.longContext).toMatchObject({ input: 0.4, output: 1.8 });
		expect(models[2]?.cost.longContext).toMatchObject({ input: 10, output: 45 });
		expect(models[3]?.cost.longContext).toMatchObject({ input: 4, output: 18 });
		expect(models[4]?.compat).toBeUndefined();
		expect(models[4]?.cost.longContext).toBeUndefined();
	});

	it("floors GPT-5.6 Codex-transport context windows at 1M (openai/codex#38917)", () => {
		const models: ModelSpec<Api>[] = [
			// Codex discovery/registry still reports the stale 272000 for these.
			createSpec({
				id: "gpt-5.6-luna",
				api: "openai-codex-responses",
				provider: "openai-codex",
				contextWindow: 272000,
			}),
			createSpec({
				id: "gpt-5.6-sol",
				api: "openai-codex-responses",
				provider: "openai-codex",
				contextWindow: 272000,
			}),
			createSpec({
				id: "gpt-5.6-terra",
				api: "openai-codex-responses",
				provider: "openai-codex",
				contextWindow: 272000,
			}),
			// The first-party API-key entry uses openai-responses and is untouched.
			createSpec({ id: "gpt-5.6-sol", api: "openai-responses", provider: "openai", contextWindow: 1050000 }),
			// The Codex registry actively reports 272K for this alias, so the
			// luna/sol/terra correction must not overwrite it.
			createSpec({
				id: "gpt-daybreak-blue-latest",
				api: "openai-codex-responses",
				provider: "openai-codex",
				contextWindow: 272000,
			}),
		];

		applyGeneratedModelPolicies(models);

		expect(models[0]?.contextWindow).toBe(1_000_000);
		expect(models[1]?.contextWindow).toBe(1_000_000);
		expect(models[2]?.contextWindow).toBe(1_000_000);
		expect(models[3]?.contextWindow).toBe(1050000);
		expect(models[4]?.contextWindow).toBe(272000);
	});

	it("applies GPT-5.6 long-context pricing to Codex-transport SKUs (openai/codex#32486)", () => {
		const models: ModelSpec<Api>[] = [
			createSpec({ id: "gpt-5.6-sol", api: "openai-codex-responses", provider: "openai-codex" }),
			createSpec({ id: "gpt-5.6-luna", api: "openai-codex-responses", provider: "openai-codex" }),
			// Third-party carriers of the same id must not inherit the tier.
			createSpec({ id: "gpt-5.6-sol", api: "openai-completions", provider: "openrouter" }),
		];

		applyGeneratedModelPolicies(models);

		expect(models[0]?.cost.longContext).toMatchObject({ inputThreshold: 272_000, input: 10, output: 45 });
		expect(models[1]?.cost.longContext).toMatchObject({ inputThreshold: 272_000, input: 0.4, output: 1.8 });
		expect(models[2]?.cost.longContext).toBeUndefined();
	});

	it("pins Claude Mythos 5 first-party Anthropic catalog metadata", () => {
		const models: ModelSpec<Api>[] = [
			createSpec({
				id: "claude-mythos-5",
				api: "anthropic-messages",
				provider: "anthropic",
			}),
		];

		applyGeneratedModelPolicies(models);

		expect(models[0]?.contextWindow).toBe(1_000_000);
		expect(models[0]?.maxTokens).toBe(128_000);
		expect(models[0]?.cost).toEqual({ input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 });
		expect(models[0]?.thinking).toEqual({
			mode: "anthropic-adaptive",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			supportsDisplay: true,
		});
	});

	it("preserves QwenCloud's provider-authored qwen3.8 effort ladders", () => {
		const models: ModelSpec<Api>[] = [
			createSpec({
				id: "qwen3.8-max-preview",
				api: "openai-completions",
				provider: "alibaba-token-plan",
				thinking: {
					mode: "effort",
					efforts: [Effort.Low, Effort.High, Effort.XHigh],
					requiresEffort: true,
				},
			}),
			createSpec({
				id: "qwen3.8-max",
				api: "openai-completions",
				provider: "alibaba-token-plan",
				thinking: {
					mode: "effort",
					efforts: [Effort.Low, Effort.Medium, Effort.XHigh],
					defaultLevel: Effort.XHigh,
				},
			}),
		];

		applyGeneratedModelPolicies(models);

		expect(models.map(model => model.thinking)).toEqual([
			{
				mode: "effort",
				efforts: [Effort.Low, Effort.High, Effort.XHigh],
				requiresEffort: true,
			},
			{
				mode: "effort",
				efforts: [Effort.Low, Effort.Medium, Effort.XHigh],
				defaultLevel: Effort.XHigh,
			},
		]);
	});

	it("pins zai glm-5.2 base id to 1M context", () => {
		const models = [
			createSpec({
				id: "glm-5.2",
				api: "anthropic-messages",
				provider: "zai",
				contextWindow: 200_000,
				maxTokens: 8192,
			}),
		];

		applyGeneratedModelPolicies(models);

		expect(models[0]?.contextWindow).toBe(1_000_000);
		expect(models[0]?.maxTokens).toBe(131_072);
	});

	it("pins zai glm-5.3 to 1M context and derives uniform low/high/max thinking with mandatory reasoning", () => {
		const models = [
			createSpec({
				id: "glm-5.3",
				api: "anthropic-messages",
				provider: "zai",
				contextWindow: 200_000,
				maxTokens: 8192,
			}),
			createSpec({
				id: "glm-5.3",
				api: "openai-completions",
				provider: "zhipu-coding-plan",
				contextWindow: 200_000,
				maxTokens: 8192,
			}),
		];

		applyGeneratedModelPolicies(models);

		// Context pinning — same 1M tier as glm-5.2 on both GLM coding-plan hosts.
		for (const model of models) {
			expect(model.contextWindow).toBe(1_000_000);
			expect(model.maxTokens).toBe(131_072);
			// Uniform wire-exact low/high/max ladder (NOT the host-specific
			// high/max scale GLM-5.2 uses on zai/zhipu).
			expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
			// Thinking can no longer be disabled.
			expect(model.thinking?.requiresEffort).toBe(true);
			// Default effort is `max` per the GLM-5.3 API spec.
			expect(model.thinking?.defaultLevel).toBe(Effort.Max);
		}
	});

	it("pins zai glm-5.3-flash to the 1M tier and restores its native image input", () => {
		const models = [
			createSpec({
				id: "glm-5.3-flash",
				api: "anthropic-messages",
				provider: "zai",
				contextWindow: 200_000,
				maxTokens: 8192,
			}),
			createSpec({
				id: "glm-5.3-flash",
				api: "openai-completions",
				provider: "zhipu-coding-plan",
				contextWindow: 200_000,
				maxTokens: 8192,
			}),
		];

		applyGeneratedModelPolicies(models);

		for (const model of models) {
			expect(model.contextWindow).toBe(1_000_000);
			expect(model.maxTokens).toBe(131_072);
			// Natively multimodal despite the missing `v` marker; upstream
			// metadata reports the flash SKU as text-only.
			expect(model.input).toEqual(["text", "image"]);
			// Same mandatory low/high/max ladder as the GLM-5.3 base line.
			expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
			expect(model.thinking?.requiresEffort).toBe(true);
			expect(model.thinking?.defaultLevel).toBe(Effort.Max);
		}
	});

	it("bakes verified Cursor image families into the offline catalog", () => {
		const verifiedIds = [
			"kimi-k3-high",
			"kimi-k3-low",
			"kimi-k3-max",
			"cursor-grok-4.5",
			"cursor-grok-4.5-fast",
			"cursor-grok-4.6",
			"cursor-grok-4.6-fast",
			"composer-2.5",
			"composer-2.5-fast",
		];
		const unverifiedIds = ["cursor-grok-5", "composer-2.50", "k3-256k"];
		const models = [...verifiedIds, ...unverifiedIds].map(id =>
			createSpec({ id, api: "cursor-agent", provider: "cursor" }),
		);

		applyGeneratedModelPolicies(models);

		for (const model of models.slice(0, verifiedIds.length)) {
			expect(model.input).toEqual(["text", "image"]);
		}
		for (const model of models.slice(verifiedIds.length)) {
			expect(model.input).toEqual(["text"]);
		}
	});

	it("pins MiniMax-M3 long-context providers to 1M context", () => {
		const models = [
			createSpec({
				id: "MiniMax-M3",
				api: "anthropic-messages",
				provider: "minimax",
				contextWindow: 512_000,
				maxTokens: 128_000,
			}),
			createSpec({
				id: "MiniMax-M3",
				api: "anthropic-messages",
				provider: "minimax-cn",
				contextWindow: 512_000,
				maxTokens: 128_000,
			}),
			createSpec({
				id: "MiniMax-M3",
				api: "openai-completions",
				provider: "minimax-code",
				contextWindow: 512_000,
				maxTokens: 128_000,
			}),
			createSpec({
				id: "MiniMax-M3",
				api: "openai-completions",
				provider: "minimax-code-cn",
				contextWindow: 512_000,
				maxTokens: 128_000,
			}),
		];

		applyGeneratedModelPolicies(models);

		expect(models[0]?.contextWindow).toBe(1_000_000);
		expect(models[0]?.maxTokens).toBe(128_000);
		expect(models[1]?.contextWindow).toBe(1_000_000);
		expect(models[1]?.maxTokens).toBe(128_000);
		expect(models[2]?.contextWindow).toBe(1_000_000);
		expect(models[2]?.maxTokens).toBe(128_000);
		expect(models[3]?.contextWindow).toBe(1_000_000);
		expect(models[3]?.maxTokens).toBe(128_000);
	});

	it("normalizes Copilot generated fallback limits", () => {
		const models: ModelSpec<Api>[] = [
			createSpec({
				id: "claude-opus-4.6",
				api: "anthropic-messages",
				provider: "github-copilot",
				contextWindow: 144000,
				maxTokens: 64000,
			}),
			createSpec({
				id: "gpt-5.4-mini",
				api: "openai-responses",
				provider: "github-copilot",
				contextWindow: 400000,
				maxTokens: 128000,
			}),
			createSpec({
				id: "grok-code-fast-1",
				api: "openai-completions",
				provider: "github-copilot",
				contextWindow: 128000,
				maxTokens: 64000,
			}),
		];

		applyGeneratedModelPolicies(models);

		expect(models[0]?.contextWindow).toBe(168000);
		expect(models[0]?.maxTokens).toBe(32000);
		expect(models[1]?.contextWindow).toBe(272000);
		expect(models[1]?.maxTokens).toBe(128000);
		expect(models[2]?.contextWindow).toBe(192000);
		expect(models[2]?.maxTokens).toBe(64000);
	});

	it("marks Ollama Cloud generated rows to omit max output tokens", () => {
		const models: ModelSpec<Api>[] = [
			createSpec({
				id: "deepseek-v4-flash",
				api: "ollama-chat",
				provider: "ollama-cloud",
				contextWindow: 1048576,
				maxTokens: 1048576,
			}),
			createSpec({
				id: "deepseek-v4-flash",
				api: "ollama-chat",
				provider: "ollama",
				contextWindow: 1048576,
				maxTokens: 1048576,
			}),
		];

		applyGeneratedModelPolicies(models);

		expect(models[0]?.omitMaxOutputTokens).toBe(true);
		expect(models[1]?.omitMaxOutputTokens).toBeUndefined();
	});

	it("marks OpenCode Go MiMo models as not supporting tool_choice", () => {
		const models: ModelSpec<"openai-completions">[] = [
			createSpec({
				id: "mimo-v2.5-pro",
				api: "openai-completions",
				provider: "opencode-go",
			}),
		];

		applyGeneratedModelPolicies(models);

		expect(models[0]?.compat?.supportsToolChoice).toBe(false);
	});

	it("sets OpenCode Go DeepSeek V4 tool-call request compat for both OpenAI APIs", () => {
		const models: ModelSpec<Api>[] = [
			createSpec({
				id: "deepseek-v4-flash",
				api: "openai-responses",
				provider: "opencode-go",
			}),
			createSpec({
				id: "deepseek-v4-pro",
				api: "openai-completions",
				provider: "opencode-go",
			}),
		];

		applyGeneratedModelPolicies(models);

		for (const model of models) {
			expect(model.compat).toMatchObject({
				supportsToolChoice: false,
				maxTokensField: "max_tokens",
				reasoningContentField: "reasoning_content",
				requiresReasoningContentForToolCalls: true,
			});
		}
	});

	it("marks OpenCode Go Kimi K2.7 Code as not supporting forced tool_choice", () => {
		const models: ModelSpec<"openai-completions">[] = [
			createSpec({
				id: "kimi-k2.7-code",
				api: "openai-completions",
				provider: "opencode-go",
			}),
		];

		applyGeneratedModelPolicies(models);

		expect(models[0]?.compat?.supportsForcedToolChoice).toBe(false);
	});

	it("links spark variants and gpt-5.5 to their context promotion targets", () => {
		const models = [
			createSpec({ id: "gpt-5.3-codex-spark", api: "openai-codex-responses", provider: "openai-codex" }),
			createSpec({ id: "gpt-5.5", api: "openai-codex-responses", provider: "openai-codex" }),
			createSpec({ id: "gpt-5.4", api: "openai-codex-responses", provider: "openai-codex" }),
		];

		linkOpenAIPromotionTargets(models);

		expect(models[0]?.contextPromotionTarget).toBe("openai-codex/gpt-5.5");
		expect(models[1]?.contextPromotionTarget).toBe("openai-codex/gpt-5.4");
	});

	it("links every gpt-5.5 flavor to its gpt-5.4 sibling across namespaced and dated provider ids", () => {
		const models = [
			// Namespaced provider ids (id carries an `openai/` prefix).
			createSpec({ id: "openai/gpt-5.5", api: "openai-responses", provider: "openrouter" }),
			createSpec({ id: "openai/gpt-5.5-pro", api: "openai-responses", provider: "openrouter" }),
			createSpec({ id: "openai/gpt-5.4", api: "openai-responses", provider: "openrouter" }),
			createSpec({ id: "openai/gpt-5.4-pro", api: "openai-responses", provider: "openrouter" }),
			createSpec({ id: "openai/gpt-5.4-mini", api: "openai-responses", provider: "openrouter" }),
			// Dated snapshot ids on a provider with no plain `gpt-5.4`.
			createSpec({ id: "gpt-5.5-2026-04-23", api: "openai-responses", provider: "aimlapi" }),
			createSpec({ id: "gpt-5.4-2026-03-05", api: "openai-responses", provider: "aimlapi" }),
			// Dotted namespace (amazon-bedrock `openai.gpt-5.x`).
			createSpec({ id: "openai.gpt-5.5", api: "openai-responses", provider: "amazon-bedrock" }),
			createSpec({ id: "openai.gpt-5.4", api: "openai-responses", provider: "amazon-bedrock" }),
		];

		linkOpenAIPromotionTargets(models);

		// Base and pro both promote to the plainest same-provider gpt-5.4 (base wins
		// over `-pro`/`-mini`), and the namespaced target round-trips through
		// parseModelString (first-slash split → provider `openrouter`, id `openai/gpt-5.4`).
		expect(models[0]?.contextPromotionTarget).toBe("openrouter/openai/gpt-5.4");
		expect(models[1]?.contextPromotionTarget).toBe("openrouter/openai/gpt-5.4");
		// A gpt-5.4 model itself is never given a promotion target.
		expect(models[2]?.contextPromotionTarget).toBeUndefined();
		expect(models[3]?.contextPromotionTarget).toBeUndefined();
		expect(models[4]?.contextPromotionTarget).toBeUndefined();
		// Dated and dotted siblings resolve by parsed version, not literal id.
		expect(models[5]?.contextPromotionTarget).toBe("aimlapi/gpt-5.4-2026-03-05");
		expect(models[7]?.contextPromotionTarget).toBe("amazon-bedrock/openai.gpt-5.4");
	});

	it("sets freeform apply_patch metadata for first-party GPT-5 Responses models", () => {
		const models: ModelSpec<Api>[] = [
			createSpec({ id: "gpt-5.4", api: "openai-responses", provider: "openai" }),
			createSpec({ id: "gpt-5.3-codex-spark", api: "openai-codex-responses", provider: "openai-codex" }),
			createSpec({
				id: "gpt-5.3-codex-spark",
				api: "openai-responses",
				provider: "opencode",
				applyPatchToolType: "freeform",
			}),
			createSpec({
				id: "gpt-5.4",
				api: "openai-completions",
				provider: "litellm",
				applyPatchToolType: "freeform",
			}),
		];

		applyGeneratedModelPolicies(models);

		expect(models[0]?.applyPatchToolType).toBe("freeform");
		expect(models[1]?.applyPatchToolType).toBe("freeform");
		expect(models[2]?.applyPatchToolType).toBeUndefined();
		expect(models[3]?.applyPatchToolType).toBeUndefined();
	});

	it("strips paid xAI Responses effort dials for off-allowlist reasoners", () => {
		const models: ModelSpec<"openai-responses">[] = [
			createSpec({
				id: "grok-code-fast-1",
				api: "openai-responses",
				provider: "xai",
				thinking: { mode: "effort", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
			}),
			createSpec({
				id: "grok-4.5",
				api: "openai-responses",
				provider: "xai",
				thinking: { mode: "effort", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
			}),
			createSpec({
				id: "grok-code-fast-1",
				api: "openai-responses",
				provider: "openrouter",
				thinking: { mode: "effort", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
			}),
		];

		applyGeneratedModelPolicies(models);

		expect(models[0]?.thinking).toBeUndefined();
		expect(models[0]?.compat).toMatchObject({
			supportsReasoningEffort: false,
			omitReasoningEffort: true,
		});
		expect(models[0]?.compat).not.toHaveProperty("reasoningEffortMap");
		expect(models[1]?.thinking?.efforts).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High]);
		expect(models[1]?.compat?.supportsReasoningEffort).toBe(true);
		// Non-xAI hosts are outside this policy — no baked no-dial compat.
		expect(models[2]?.thinking).toBeDefined();
		expect(models[2]?.compat?.supportsReasoningEffort).toBeUndefined();
	});
});

describe("applyOllamaCloudOutputCap", () => {
	it("pins DeepSeek V4 Pro/Flash (and their tag variants) to the enforced ceiling (#7266)", () => {
		const models: ModelSpec<Api>[] = [
			createSpec({
				id: "deepseek-v4-flash",
				api: "ollama-chat",
				provider: "ollama-cloud",
				contextWindow: 1048576,
				maxTokens: 1048576,
			}),
			createSpec({
				id: "deepseek-v4-flash:0731",
				api: "ollama-chat",
				provider: "ollama-cloud",
				contextWindow: 1048576,
				maxTokens: 8192,
			}),
			createSpec({
				id: "deepseek-v4-pro",
				api: "ollama-chat",
				provider: "ollama-cloud",
				contextWindow: 1048576,
				maxTokens: 1048576,
			}),
		];

		applyOllamaCloudOutputCap(models);

		expect(models[0]?.maxTokens).toBe(65536);
		expect(models[1]?.maxTokens).toBe(65536);
		expect(models[2]?.maxTokens).toBe(65536);
	});

	it("leaves other Ollama Cloud models' discovered limits untouched", () => {
		const models: ModelSpec<Api>[] = [
			createSpec({
				id: "kimi-k2.5",
				api: "ollama-chat",
				provider: "ollama-cloud",
				contextWindow: 262144,
				maxTokens: 262144,
			}),
			createSpec({
				id: "deepseek-v3.1:671b",
				api: "ollama-chat",
				provider: "ollama-cloud",
				contextWindow: 163840,
				maxTokens: 163840,
			}),
		];

		applyOllamaCloudOutputCap(models);

		expect(models[0]?.maxTokens).toBe(262144);
		expect(models[1]?.maxTokens).toBe(163840);
	});

	it("caps by the context window when a capped model's window is below the ceiling", () => {
		const models: ModelSpec<Api>[] = [
			createSpec({
				id: "deepseek-v4-flash",
				api: "ollama-chat",
				provider: "ollama-cloud",
				contextWindow: 32768,
				maxTokens: 32768,
			}),
		];

		applyOllamaCloudOutputCap(models);

		expect(models[0]?.maxTokens).toBe(32768);
	});

	it("does not touch other providers", () => {
		const models: ModelSpec<Api>[] = [
			createSpec({
				id: "deepseek-v4-flash",
				api: "openai-completions",
				provider: "deepseek",
				contextWindow: 1048576,
				maxTokens: 1048576,
			}),
		];

		applyOllamaCloudOutputCap(models);

		expect(models[0]?.maxTokens).toBe(1048576);
	});
});

describe("applyAntigravityPricingFallback", () => {
	it("prices Gemini ids at Google API peers and Claude ids at Vertex, falling back to Anthropic", () => {
		const googleCost = { input: 1.5, output: 9, cacheRead: 0.15, cacheWrite: 0 };
		const previewCost = { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 0 };
		const vertexCost = { input: 6, output: 30, cacheRead: 0.6, cacheWrite: 7.5 };
		const anthropicCost = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
		const models: ModelSpec<Api>[] = [
			createSpec({ id: "gemini-3.5-flash", api: "google-generative-ai", provider: "google", cost: googleCost }),
			createSpec({
				id: "gemini-3.1-pro-preview",
				api: "google-generative-ai",
				provider: "google",
				cost: previewCost,
			}),
			createSpec({
				id: "claude-opus-4-6@default",
				api: "anthropic-messages",
				provider: "google-vertex",
				cost: vertexCost,
			}),
			createSpec({ id: "claude-opus-4-6", api: "anthropic-messages", provider: "anthropic", cost: anthropicCost }),
			createSpec({ id: "claude-sonnet-4-6", api: "anthropic-messages", provider: "anthropic", cost: anthropicCost }),
			createSpec({ id: "gemini-3.5-flash", api: "google-gemini-cli", provider: "google-antigravity" }),
			createSpec({ id: "gemini-3.1-pro", api: "google-gemini-cli", provider: "google-antigravity" }),
			createSpec({ id: "claude-opus-4-6", api: "google-gemini-cli", provider: "google-antigravity" }),
			createSpec({ id: "claude-sonnet-4-6", api: "google-gemini-cli", provider: "google-antigravity" }),
		];

		const result = applyAntigravityPricingFallback(models);

		expect(result[5]?.cost).toEqual(googleCost);
		expect(result[6]?.cost).toEqual(previewCost);
		// Vertex list price wins over Anthropic for aliased Claude ids.
		expect(result[7]?.cost).toEqual(vertexCost);
		// Dangling Vertex alias (no google-vertex row) falls back to Anthropic.
		expect(result[8]?.cost).toEqual(anthropicCost);
	});

	it("keeps zero cost for ids without a priced peer and never overwrites billable antigravity cost", () => {
		const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		const pricedCost = { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0 };
		const models: ModelSpec<Api>[] = [
			createSpec({ id: "gemini-3-flash-preview", api: "google-generative-ai", provider: "google", cost: zeroCost }),
			createSpec({ id: "tab_flash_lite_preview", api: "google-gemini-cli", provider: "google-antigravity" }),
			createSpec({ id: "gemini-3-flash", api: "google-gemini-cli", provider: "google-antigravity" }),
			createSpec({
				id: "gemini-3.6-flash",
				api: "google-gemini-cli",
				provider: "google-antigravity",
				cost: pricedCost,
			}),
			createSpec({
				id: "gemini-3.6-flash",
				api: "google-generative-ai",
				provider: "google",
				cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 },
			}),
		];

		const result = applyAntigravityPricingFallback(models);

		// No billable google peer (zero-cost peer is not a pricing source).
		expect(result[1]?.cost).toEqual(zeroCost);
		expect(result[2]?.cost).toEqual(zeroCost);
		// Already-billable antigravity rows keep their own pricing.
		expect(result[3]?.cost).toEqual(pricedCost);
	});
});
