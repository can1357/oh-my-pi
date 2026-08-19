import { describe, expect, it } from "bun:test";
import { Effort } from "@pk-nerdsaver-ai/pi-catalog/effort";
import type { Api, ModelSpec, Provider } from "@pk-nerdsaver-ai/pi-catalog/types";
import { applyGeneratedModelPolicies, linkOpenAIPromotionTargets } from "../scripts/generated-policies";

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
	thinking?: ModelSpec<TApi>["thinking"];
}): ModelSpec<TApi> {
	return {
		id: overrides.id,
		name: overrides.id,
		api: overrides.api,
		provider: overrides.provider,
		baseUrl: "https://example.com",
		reasoning: overrides.reasoning ?? true,
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
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			effortMap: { minimal: "low", xhigh: "max" },
		});
		expect(models[1]?.cost.cacheRead).toBe(0.5);
		expect(models[1]?.cost.cacheWrite).toBe(6.25);
		expect(models[1]?.contextWindow).toBe(1000000);
		expect(models[2]?.contextWindow).toBe(272000);
		expect(models[3]?.contextWindow).toBe(272000);
		expect(models[3]?.priority).toBe(1);
	});

	it("pins Codex GPT-5.6 Sol to its Max-plan 1M context window", () => {
		const models: ModelSpec<Api>[] = [
			createSpec({
				id: "gpt-5.6-sol",
				api: "openai-codex-responses",
				provider: "openai-codex",
				contextWindow: 272_000,
				maxTokens: 32_000,
			}),
			createSpec({
				id: "gpt-5.6-terra",
				api: "openai-codex-responses",
				provider: "openai-codex",
				contextWindow: 272_000,
			}),
			createSpec({
				id: "gpt-5.6-sol",
				api: "openai-responses",
				provider: "openai",
				contextWindow: 272_000,
			}),
		];

		applyGeneratedModelPolicies(models);

		expect(models[0]?.contextWindow).toBe(1_050_000);
		expect(models[0]?.maxTokens).toBe(128_000);
		expect(models[1]?.contextWindow).toBe(272_000);
		expect(models[2]?.contextWindow).toBe(272_000);
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
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			effortMap: { minimal: "low", low: "medium", medium: "high", high: "xhigh", xhigh: "max" },
			supportsDisplay: true,
		});
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
});
