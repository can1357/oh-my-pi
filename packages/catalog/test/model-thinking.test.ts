import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import {
	clampThinkingLevelForModel,
	defaultSupportedEffort,
	getSupportedEfforts,
	mapEffortToAnthropicAdaptiveEffort,
	mapEffortToGoogleThinkingLevel,
	minimumSupportedEffort,
	requireSupportedEffort,
} from "@oh-my-pi/pi-catalog/model-thinking";
import type { Api, Model, ModelSpec, Provider } from "@oh-my-pi/pi-catalog/types";

function createModel<TApi extends Api>(overrides: {
	id: string;
	api: TApi;
	provider: Provider;
	name?: string;
	reasoning?: boolean;
	baseUrl?: string;
	compat?: ModelSpec<TApi>["compat"];
	thinking?: ModelSpec<TApi>["thinking"];
}): Model<TApi> {
	return buildModel({
		id: overrides.id,
		name: overrides.name ?? overrides.id,
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
			compat: { reasoningEffortMap: { max: "max-plus" } },
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
		// Explicit compat overrides still win over identity-derived wire values.
		expect(deepseek.thinking?.effortMap).toEqual({ max: "max-plus" });
		// OpenRouter-hosted Anthropic adaptive models carry the wire-exact
		// five-tier ladder with no remapping.
		expect(getSupportedEfforts(openRouterAnthropic)).toEqual([
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.XHigh,
			Effort.Max,
		]);
		expect(openRouterAnthropic.thinking?.effortMap).toBeUndefined();
	});

	it("derives Anthropic adaptive thinking for SAP hai-proxy version-first Claude ids", () => {
		const opus48 = createModel({
			id: "anthropic--claude-4.8-opus",
			api: "anthropic-messages",
			provider: "custom",
		});
		const opus46 = createModel({
			id: "anthropic--claude-4.6-opus",
			api: "anthropic-messages",
			provider: "custom",
		});

		expect(opus48.thinking).toEqual({
			mode: "anthropic-adaptive",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			supportsDisplay: true,
		});
		expect(getSupportedEfforts(opus48)).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max]);
		expect(opus46.thinking).toEqual({
			mode: "anthropic-adaptive",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.Max],
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

		// Z.ai dialect: the model only does none/high/max on the wire, so the
		// ladder is the honest high/max pair (none = thinking off).
		expect(getSupportedEfforts(zai)).toEqual([Effort.High, Effort.Max]);
		expect(zai.thinking?.effortMap).toBeUndefined();
		// Fireworks keeps its distinct lower tiers and the `minimal -> none`
		// quirk; the genuine `max` tier sits above `high`.
		expect(getSupportedEfforts(fireworks)).toEqual([
			Effort.Minimal,
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.Max,
		]);
		expect(fireworks.thinking?.effortMap).toEqual({ minimal: "none" });
		// OpenRouter rejects `max` and treats `xhigh` as its max tier: expose the
		// `xhigh` tier and pass it through unmapped.
		expect(getSupportedEfforts(openRouter)).toContain(Effort.XHigh);
		expect(openRouter.thinking?.effortMap).toBeUndefined();
	});

	it("applies the DeepSeek effort contract to Ollama Cloud ollama-chat models (issue #8334)", () => {
		const flash = createModel({
			id: "deepseek-v4-flash",
			api: "ollama-chat",
			provider: "ollama-cloud",
			baseUrl: "https://ollama.com",
		});
		const flashDated = createModel({
			id: "deepseek-v4-flash:0731",
			api: "ollama-chat",
			provider: "ollama-cloud",
			baseUrl: "https://ollama.com",
		});
		const pro = createModel({
			id: "deepseek-v4-pro",
			api: "ollama-chat",
			provider: "ollama-cloud",
			baseUrl: "https://ollama.com",
		});
		const v32 = createModel({
			id: "deepseek-v3.2",
			api: "ollama-chat",
			provider: "ollama-cloud",
			baseUrl: "https://ollama.com",
		});

		// V4 Flash keeps its low/high/max ladder over the ollama-chat transport
		// instead of Ollama's generic minimal..xhigh scale (medium/xhigh fold
		// into high, max is a real wire tier).
		expect(getSupportedEfforts(flash)).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect(getSupportedEfforts(flashDated)).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect(flash.thinking?.effortMap).toBeUndefined();
		// V4 Pro shares Flash's low/high/max ladder on the direct API and every
		// aggregator route (DeepSeek's docs advertise `low` for both V4 SKUs);
		// the older V3.x reasoners still top out at high/max.
		expect(getSupportedEfforts(pro)).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect(getSupportedEfforts(v32)).toEqual([Effort.High, Effort.Max]);
	});

	it("applies the DeepSeek effort contract to opencode-go openai-responses flash (issue #9134)", () => {
		// opencode-go/deepseek-v4-flash is pinned to the Responses transport
		// (the Go gateway serves it only at /responses), but the effort ladder
		// is a model property: it must expose low/high/max like the pro sibling
		// on chat completions, not the generic minimal..xhigh fallback.
		const flash = createModel({
			id: "deepseek-v4-flash",
			api: "openai-responses",
			provider: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
		});
		const pro = createModel({
			id: "deepseek-v4-pro",
			api: "openai-completions",
			provider: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
		});

		expect(getSupportedEfforts(flash)).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect(flash.thinking?.effortMap).toBeUndefined();
		expect(() => requireSupportedEffort(flash, Effort.Medium)).toThrow(/Supported efforts: low, high, max/);
		expect(getSupportedEfforts(pro)).toEqual([Effort.Low, Effort.High, Effort.Max]);
	});

	it("grants the low/high/max ladder to OpenRouter deepseek-v4-pro-0813 but not the undated route (issue #8517)", () => {
		// OpenRouter's /models advertises reasoning.supported_efforts
		// [low, high, max] for the dated SKU; the discovered ladder is baked
		// into thinking.efforts.
		const discovered = { mode: "effort" as const, efforts: [Effort.Low, Effort.High, Effort.Max] };
		const dated = createModel({
			id: "deepseek/deepseek-v4-pro-0813",
			api: "openrouter",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			thinking: discovered,
		});
		const bare = createModel({
			id: "deepseek/deepseek-v4-pro",
			api: "openrouter",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			thinking: discovered,
		});

		// The dated SKU keeps its advertised ladder; :max no longer clamps.
		expect(getSupportedEfforts(dated)).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect(clampThinkingLevelForModel(dated, Effort.Max)).toBe(Effort.Max);
		// The undated OpenRouter route stays high-only.
		expect(getSupportedEfforts(bare)).toEqual([Effort.High]);
		expect(clampThinkingLevelForModel(bare, Effort.Max)).toBe(Effort.High);
	});

	it("normalizes OpenCode gateway ox-alpha onto the low/high/max ladder with mandatory thinking (issue #9349)", () => {
		// The OpenCode Go gateway rejects minimal/medium/xhigh for ox-alpha
		// (`[1210] ... please use low, high, or max`), so the stale
		// minimal..xhigh surface the catalog shipped made the top tier
		// unreachable: `max` clamped to `xhigh` and 400'd upstream.
		const staleThinking = {
			mode: "effort" as const,
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		};
		const oxAlpha = createModel({
			id: "ox-alpha-free",
			api: "openai-completions",
			provider: "opencode-go",
			baseUrl: "https://opencode.ai/zen/go/v1",
			thinking: staleThinking,
		});

		expect(oxAlpha.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.High, Effort.Max],
			requiresEffort: true,
		});
		// The top tier now reaches the gateway's real `max` wire value instead
		// of the rejected `xhigh`, and no selection can produce a rejected tier.
		expect(oxAlpha.thinking?.effortMap).toBeUndefined();
		expect(requireSupportedEffort(oxAlpha, Effort.Max)).toBe(Effort.Max);
		expect(clampThinkingLevelForModel(oxAlpha, Effort.XHigh)).toBe(Effort.High);
		expect(clampThinkingLevelForModel(oxAlpha, Effort.Medium)).toBe(Effort.Low);

		// Zen serves the same SKU under an unrelated aliased id; the stencil
		// display name carries the signal and must normalize identically so
		// `max` is reachable instead of clamping to rejected `xhigh`.
		const zenAlias = createModel({
			id: "x-preview-f-free",
			name: "Ox Alpha Free (Unlimited)",
			api: "openai-completions",
			provider: "opencode-zen",
			baseUrl: "https://opencode.ai/zen/v1",
			thinking: staleThinking,
		});
		expect(zenAlias.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.High, Effort.Max],
			requiresEffort: true,
		});
		expect(requireSupportedEffort(zenAlias, Effort.Max)).toBe(Effort.Max);
		expect(clampThinkingLevelForModel(zenAlias, Effort.XHigh)).toBe(Effort.High);

		// A zen id with no ox-alpha signal keeps its shipped ladder untouched.
		const zenOther = createModel({
			id: "hy3-preview-free",
			api: "openai-completions",
			provider: "opencode-zen",
			baseUrl: "https://opencode.ai/zen/v1",
			thinking: staleThinking,
		});
		expect(getSupportedEfforts(zenOther)).toEqual([
			Effort.Minimal,
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.XHigh,
		]);
		expect(zenOther.thinking?.requiresEffort).toBeUndefined();

		// Other hosts proxying an ox-alpha SKU expose their own vocabularies and
		// must not inherit the gateway ladder.
		const kiloOxAlpha = createModel({
			id: "stealth/ox-alpha",
			api: "openai-completions",
			provider: "kilo",
			baseUrl: "https://api.kilo.ai/api/gateway",
			thinking: staleThinking,
		});
		expect(getSupportedEfforts(kiloOxAlpha)).toEqual([
			Effort.Minimal,
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.XHigh,
		]);
		expect(kiloOxAlpha.thinking?.requiresEffort).toBeUndefined();

		// The name match needs a trailing boundary too: "Ox Alphabet" merely
		// shares the prefix and must keep its shipped ladder.
		const oxAlphabet = createModel({
			id: "hy3-preview-free",
			name: "Ox Alphabet",
			api: "openai-completions",
			provider: "opencode-zen",
			baseUrl: "https://opencode.ai/zen/v1",
			thinking: staleThinking,
		});
		expect(getSupportedEfforts(oxAlphabet)).toEqual([
			Effort.Minimal,
			Effort.Low,
			Effort.Medium,
			Effort.High,
			Effort.XHigh,
		]);
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

	it("maps minimal to LOW when a collapsed family aliases it onto the low wire id", () => {
		const model = createModel({
			id: "gemini-3.7-flash",
			api: "google-gemini-cli",
			provider: "google-antigravity",
			thinking: {
				mode: "google-level",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
				requiresEffort: true,
				effortRouting: {
					[Effort.Minimal]: "gemini-3.7-flash-low",
					[Effort.Low]: "gemini-3.7-flash-low",
					[Effort.Medium]: "gemini-3.7-flash-medium",
					[Effort.High]: "gemini-3.7-flash-high",
				},
			},
		});
		expect(mapEffortToGoogleThinkingLevel(Effort.Minimal, model)).toBe("LOW");
		expect(mapEffortToGoogleThinkingLevel(Effort.Low, model)).toBe("LOW");
		expect(mapEffortToGoogleThinkingLevel(Effort.Minimal)).toBe("MINIMAL");
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
		const sonnet5 = createModel({ id: "claude-sonnet-5", api: "anthropic-messages", provider: "anthropic" });
		const sonnet5Bedrock = createModel({
			id: "global.anthropic.claude-sonnet-5",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
		});
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
		expect(sonnet5.thinking?.mode).toBe("anthropic-adaptive");
		expect(sonnet5Bedrock.thinking?.mode).toBe("anthropic-adaptive");
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
		// Opus 4.6 has no real xhigh tier — the honest ladder is the four-tier
		// low/medium/high/max wire scale, mapped 1:1.
		expect(getSupportedEfforts(opus46)).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.Max]);
		expect(opus46.thinking?.effortMap).toBeUndefined();
		expect(() => mapEffortToAnthropicAdaptiveEffort(opus46, Effort.XHigh)).toThrow(/not supported/);
		// Opus 4.7+ on the Messages API exposes the full five-tier wire scale
		// low..max with no remapping.
		expect(getSupportedEfforts(opus47)).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max]);
		expect(opus47.thinking?.effortMap).toBeUndefined();
		expect(() => mapEffortToAnthropicAdaptiveEffort(opus47, Effort.Minimal)).toThrow(/not supported/);
		expect(mapEffortToAnthropicAdaptiveEffort(mythos, Effort.XHigh)).toBe("xhigh");
		// Bedrock Converse stays on the four-tier scale regardless of version.
		expect(getSupportedEfforts(opus47Bedrock)).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.Max]);
		expect(opus47Bedrock.thinking?.effortMap).toBeUndefined();
		expect(() => mapEffortToAnthropicAdaptiveEffort(sonnet5Bedrock, Effort.XHigh)).toThrow(/not supported/);
		// Sonnet 4.6 runs adaptive mode on the three-tier low/medium/high scale.
		expect(getSupportedEfforts(sonnet46)).toEqual([Effort.Low, Effort.Medium, Effort.High]);
		expect(() => mapEffortToAnthropicAdaptiveEffort(sonnet46, Effort.XHigh)).toThrow(/not supported/);
		expect(() => mapEffortToAnthropicAdaptiveEffort(sonnet46, Effort.Max)).toThrow(/not supported/);
	});

	it("bakes adaptive display support for Opus 4.7+, Sonnet 5+, and Fable/Mythos 5", () => {
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
		const sonnet5 = createModel({ id: "claude-sonnet-5", api: "anthropic-messages", provider: "anthropic" });
		const sonnet5Bedrock = createModel({
			id: "global.anthropic.claude-sonnet-5",
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
		});

		expect(opus46.thinking?.supportsDisplay).toBeUndefined();
		expect(opus47.thinking?.supportsDisplay).toBe(true);
		expect(opus47Dotted.thinking?.supportsDisplay).toBe(true);
		expect(opus4Dated.thinking?.supportsDisplay).toBeUndefined();
		expect(fable.thinking?.supportsDisplay).toBe(true);
		expect(fableBedrock.thinking?.supportsDisplay).toBe(true);
		expect(sonnet5.thinking?.supportsDisplay).toBe(true);
		expect(sonnet5Bedrock.thinking?.supportsDisplay).toBe(true);
	});

	it("classifies OpenAI-schema Bedrock models as effort, leaving gpt-oss on budget", () => {
		// Bedrock serves the GPT-5.x SKUs through OpenAI's own request schema,
		// which rejects Anthropic's budget block: `unknown_parameter: 'thinking'`.
		for (const id of ["global.openai.gpt-5.6-luna", "global.openai.gpt-5.6-sol", "global.openai.gpt-5.6-terra"]) {
			expect(createModel({ id, api: "bedrock-converse-stream", provider: "amazon-bedrock" }).thinking?.mode).toBe(
				"effort",
			);
		}

		// gpt-oss is not a `gpt-<digits>` id, so it stays unclassified and keeps
		// the budget path it ships with today.
		expect(
			createModel({ id: "openai.gpt-oss-120b", api: "bedrock-converse-stream", provider: "amazon-bedrock" }).thinking
				?.mode,
		).toBe("budget");
	});

	it("backfills wire facts onto explicit thinking, explicit values winning", () => {
		// Authored partial ladders on wire-exact models normalize to the
		// model-defined ladder, and the wire map is re-derived alongside:
		// stale cached surfaces cannot pin retired wire facts.
		const filled = createModel({
			id: "claude-opus-4-8",
			api: "anthropic-messages",
			provider: "anthropic",
			thinking: { mode: "anthropic-adaptive", efforts: [Effort.Low, Effort.High] },
		});
		expect(filled.thinking).toEqual({
			mode: "anthropic-adaptive",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			supportsDisplay: true,
		});

		// Explicit wire facts are authoritative — including `false` — when the
		// authored ladder matches the wire truth.
		const pinned = createModel({
			id: "claude-opus-4-8",
			api: "anthropic-messages",
			provider: "anthropic",
			thinking: {
				mode: "anthropic-adaptive",
				efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
				effortMap: { max: "ultra" },
				supportsDisplay: false,
			},
		});
		expect(pinned.thinking?.effortMap).toEqual({ max: "ultra" });
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
		const sonnet5 = createModel({ id: "claude-sonnet-5", api: "anthropic-messages", provider: "anthropic" });
		const fable = createModel({ id: "claude-fable-5", api: "anthropic-messages", provider: "anthropic" });

		expect(sonnet45.compat.supportsSamplingParams).toBe(true);
		expect(opus47.compat.supportsSamplingParams).toBe(false);
		expect(sonnet5.compat.supportsSamplingParams).toBe(false);
		expect(fable.compat.supportsSamplingParams).toBe(false);
	});

	it("bakes sampling-param rejection into OpenAI reasoning compat (#5606)", () => {
		// GitHub Copilot Responses gpt-5.6 — the reported failing model.
		const luna = createModel({
			id: "gpt-5.6-luna",
			api: "openai-responses",
			provider: "github-copilot",
			baseUrl: "https://api.githubcopilot.com",
		});
		const gpt5 = createModel({ id: "gpt-5", api: "openai-responses", provider: "openai" });
		const gpt5Mini = createModel({ id: "gpt-5-mini", api: "openai-completions", provider: "openai" });
		const gpt5Chat = createModel({ id: "gpt-5-chat-latest", api: "openai-responses", provider: "openai" });
		const oThree = createModel({ id: "o3-mini", api: "openai-responses", provider: "openai" });
		// Non-restricted OpenAI + non-OpenAI models keep sampling support.
		const gpt4o = createModel({ id: "gpt-4o", api: "openai-responses", provider: "openai", reasoning: false });
		const kimi = createModel({ id: "kimi-k2.6", api: "openai-completions", provider: "moonshot" });

		expect(luna.compat.supportsSamplingParams).toBe(false);
		expect(gpt5.compat.supportsSamplingParams).toBe(false);
		expect(gpt5Mini.compat.supportsSamplingParams).toBe(false);
		expect(gpt5Chat.compat.supportsSamplingParams).toBe(false);
		expect(oThree.compat.supportsSamplingParams).toBe(false);
		expect(gpt4o.compat.supportsSamplingParams).toBe(true);
		expect(kimi.compat.supportsSamplingParams).toBe(true);
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

	it("bakes the wire-exact five-tier low..max ladder on GPT-5.6 wire-effort APIs", () => {
		const codex = createModel({
			id: "gpt-5.6-sol",
			api: "openai-codex-responses",
			provider: "openai-codex",
		});

		expect(codex.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
		});

		// Stale baked metadata (caches/discovery) — including shifted-era maps —
		// normalizes to the wire-exact ladder with the map re-derived away, and
		// namespaced OpenRouter ids parse.
		const staleOpenRouter = createModel({
			id: "openai/gpt-5.6-terra",
			api: "openrouter",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			thinking: {
				mode: "effort",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
				effortMap: {
					minimal: "low",
					low: "medium",
					medium: "high",
					high: "xhigh",
					xhigh: "max",
				},
			},
		});

		expect(staleOpenRouter.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
		});
	});

	it("keeps pre-5.6 and Devin-routed GPT models on their own effort surfaces", () => {
		const gpt55 = createModel({
			id: "gpt-5.5",
			api: "openai-responses",
			provider: "openai",
		});

		expect(gpt55.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		});
		expect(gpt55.thinking?.effortMap).toBeUndefined();

		// Devin selects effort by routing to per-tier sibling model ids, never
		// via a wire reasoning.effort field — no effort map may attach.
		const devin = createModel({
			id: "gpt-5-6-sol",
			api: "devin-agent",
			provider: "devin",
			baseUrl: "https://server.codeium.com",
			thinking: {
				mode: "effort",
				efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
				effortRouting: {
					off: "gpt-5-6-sol-none",
					low: "gpt-5-6-sol-low",
					medium: "gpt-5-6-sol-medium",
					high: "gpt-5-6-sol-high",
					xhigh: "gpt-5-6-sol-xhigh",
					max: "gpt-5-6-sol-max",
				},
			},
		});

		expect(devin.thinking?.effortMap).toBeUndefined();
		expect(devin.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max]);
	});
	it("classifies Z.ai GLM-5.2 on the anthropic-messages coding endpoint as budget-effort with high/max", () => {
		// Z.ai's anthropic-messages proxy (api.z.ai/api/anthropic) serves
		// GLM-5.2 with the same two-tier high/max reasoning scale as Umans.
		// The catalog must derive mode:"anthropic-budget-effort" (not plain
		// "budget" with five synthetic tiers) so the wire encoder emits
		// output_config.effort instead of only thinking.budget_tokens.
		const model = createModel({
			id: "glm-5.2",
			api: "anthropic-messages",
			provider: "zai",
			baseUrl: "https://api.z.ai/api/anthropic",
		});

		expect(model.thinking?.mode).toBe("anthropic-budget-effort");
		expect(getSupportedEfforts(model)).toEqual([Effort.High, Effort.Max]);
		expect(model.thinking?.effortMap).toBeUndefined();
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
		expect(() => requireSupportedEffort(model, Effort.XHigh)).toThrow(
			/Supported efforts: minimal, low, medium, high/,
		);
	});

	it("exposes the Z.AI GLM-5.2 high/max wire pair directly", () => {
		const model = createModel({
			id: "glm-5.2",
			api: "openai-completions",
			provider: "zhipu-coding-plan",
			baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
			compat: { thinkingFormat: "zai" },
		});

		expect(model.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.High, Effort.Max],
		});
		expect(() => requireSupportedEffort(model, Effort.XHigh)).toThrow(/Supported efforts: high, max/);
		// Selecting a retired tier clamps down instead of erroring in UI flows.
		expect(clampThinkingLevelForModel(model, Effort.XHigh)).toBe(Effort.High);
	});

	it("exposes Ollama Cloud GLM-5.2 high/max and hides unsupported lower efforts", () => {
		const model = createModel({
			id: "glm-5.2",
			api: "ollama-chat",
			provider: "ollama-cloud",
			baseUrl: "https://ollama.com",
		});

		expect(model.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.High, Effort.Max],
		});
		expect(() => requireSupportedEffort(model, Effort.Medium)).toThrow(/Supported efforts: high, max/);
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
		expect(() => requireSupportedEffort(model, Effort.XHigh)).toThrow(
			/Supported efforts: minimal, low, medium, high/,
		);
	});

	it("exposes wire-exact adaptive ladders for OpenRouter-hosted Anthropic models", () => {
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
		const sonnet5 = createModel({
			id: "anthropic/claude-sonnet-5",
			api: "openai-completions",
			provider: "openrouter",
		});
		expect(fable.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max]);
		expect(opus46.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.Max]);
		expect(sonnet46.thinking?.efforts.at(-1)).toBe(Effort.High);
		expect(sonnet5.thinking?.efforts.at(-1)).toBe(Effort.Max);
		expect(() => requireSupportedEffort(opus46, Effort.XHigh)).toThrow(/not supported/);
	});

	it("does not expose xhigh on first-party Grok 4.5 Responses models", () => {
		const paid = createModel({
			id: "grok-4.5",
			api: "openai-responses",
			provider: "xai",
			baseUrl: "https://api.x.ai/v1",
		});
		const oauth = createModel({
			id: "grok-4.5",
			api: "openai-responses",
			provider: "xai-oauth",
			baseUrl: "https://api.x.ai/v1",
		});

		expect(paid.thinking?.efforts).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High]);
		expect(oauth.thinking?.efforts).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High]);
		expect(() => requireSupportedEffort(paid, Effort.XHigh)).toThrow(/not supported/);
	});

	it("exposes xhigh on first-party Grok 4.6 Responses models", () => {
		const paid = createModel({
			id: "grok-4.6",
			api: "openai-responses",
			provider: "xai",
			baseUrl: "https://api.x.ai/v1",
		});
		const oauth = createModel({
			id: "grok-4.6",
			api: "openai-responses",
			provider: "xai-oauth",
			baseUrl: "https://api.x.ai/v1",
		});

		expect(paid.thinking?.efforts).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]);
		expect(oauth.thinking?.efforts).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]);
		expect(requireSupportedEffort(paid, Effort.XHigh)).toBe(Effort.XHigh);
		expect(paid.compat.reasoningEffortMap?.xhigh).toBeUndefined();
	});

	it("exposes xhigh on first-party Grok multi-agent Responses models", () => {
		const paid = createModel({
			id: "grok-4.20-multi-agent-beta-latest",
			api: "openai-responses",
			provider: "xai",
			baseUrl: "https://api.x.ai/v1",
		});
		const oauth = createModel({
			id: "grok-4.20-multi-agent-0309",
			api: "openai-responses",
			provider: "xai-oauth",
			baseUrl: "https://api.x.ai/v1",
		});

		expect(paid.thinking?.efforts).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]);
		expect(oauth.thinking?.efforts).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]);
		expect(requireSupportedEffort(paid, Effort.XHigh)).toBe(Effort.XHigh);
		expect(paid.compat.reasoningEffortMap?.xhigh).toBeUndefined();
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

describe("generic chat-template thinking dialect", () => {
	it("preserves an explicit model effort ladder and derives the thinking-off wire mode", () => {
		const model = createModel({
			id: "deepseek-flash-v4",
			name: "DeepSeek Flash V4",
			api: "openai-completions",
			provider: "yolo-auto",
			baseUrl: "https://yolo-auto.com/v1",
			compat: {
				supportsReasoningEffort: true,
				thinkingFormat: "chat-template",
			},
			thinking: {
				mode: "effort",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
				effortMap: {
					[Effort.Minimal]: "low",
					[Effort.Low]: "low",
					[Effort.Medium]: "high",
					[Effort.High]: "high",
					[Effort.XHigh]: "max",
					[Effort.Max]: "max",
				},
			},
		});

		expect(model.compat.thinkingFormat).toBe("chat-template");
		expect(model.compat.reasoningDisableMode).toBe("chat-template-thinking-false");
		expect(model.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			effortMap: {
				[Effort.Minimal]: "low",
				[Effort.Low]: "low",
				[Effort.Medium]: "high",
				[Effort.High]: "high",
				[Effort.XHigh]: "max",
				[Effort.Max]: "max",
			},
		});
	});
});

describe("Qwen 3.8 local template effort ladder", () => {
	it("derives the low/medium/xhigh ladder with mandatory effort on local llama.cpp-style backends", () => {
		const llamaCpp = createModel({
			id: "qwen3.8-27b",
			api: "openai-completions",
			provider: "llama.cpp",
			baseUrl: "http://127.0.0.1:8080/v1",
		});
		// Official 3.8 template: reasoning_effort accepts exactly low/medium/xhigh
		// and raises on `enable_thinking: false` — off must clamp, never disable.
		expect(llamaCpp.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.XHigh],
			requiresEffort: true,
		});
		expect(llamaCpp.compat.qwenTemplateReasoningEffort).toBe(true);
		// Unsupported tiers clamp onto real wire tiers: high floors to medium
		// (xhigh is a deliberate opt-in), minimal floors to low.
		expect(clampThinkingLevelForModel(llamaCpp, Effort.High)).toBe(Effort.Medium);
		expect(clampThinkingLevelForModel(llamaCpp, Effort.Minimal)).toBe(Effort.Low);
		expect(minimumSupportedEffort(llamaCpp)).toBe(Effort.Low);
	});

	it("defaults an effort-less clamp to the tier routing to requestModelId, else the floor (issue #9478)", () => {
		// A collapsed row whose default wire id is a non-floor tier clamps to the
		// effort that routes there, not the numeric minimum.
		const grok = buildModel({
			id: "cursor-grok-4.6",
			name: "Grok 4.6",
			api: "cursor-agent",
			provider: "cursor",
			baseUrl: "https://api2.cursor.sh",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 64_000,
			requestModelId: "cursor-grok-4.6-medium",
			thinking: {
				mode: "effort",
				efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
				requiresEffort: true,
				effortRouting: {
					[Effort.Low]: "cursor-grok-4.6-low",
					[Effort.Medium]: "cursor-grok-4.6-medium",
					[Effort.High]: "cursor-grok-4.6-high",
					[Effort.XHigh]: "cursor-grok-4.6-xhigh",
				},
			},
		});
		expect(defaultSupportedEffort(grok)).toBe(Effort.Medium);
		expect(minimumSupportedEffort(grok)).toBe(Effort.Low);

		// Families whose default already is the floor are unchanged.
		const floorDefault = createModel({
			id: "custom-reasoner",
			api: "openai-codex-responses",
			provider: "custom",
			baseUrl: "https://example.com",
			thinking: { mode: "effort", efforts: [Effort.Medium, Effort.High] },
		});
		expect(defaultSupportedEffort(floorDefault)).toBe(minimumSupportedEffort(floorDefault));
	});

	it("normalizes a stale cached generic ladder to the template ladder", () => {
		const cached = createModel({
			id: "qwen3.8-27b",
			api: "openai-completions",
			provider: "vllm",
			baseUrl: "http://127.0.0.1:8000/v1",
			thinking: { mode: "effort", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
		});
		expect(cached.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.XHigh],
			requiresEffort: true,
		});
	});

	it("routes vLLM Qwen through the chat_template_kwargs dialect", () => {
		// vLLM ignores top-level `enable_thinking`; only chat_template_kwargs
		// reach the template renderer.
		const vllm = createModel({
			id: "qwen3.8-27b",
			api: "openai-completions",
			provider: "vllm",
			baseUrl: "http://127.0.0.1:8000/v1",
		});
		expect(vllm.compat.thinkingFormat).toBe("qwen-chat-template");
		expect(vllm.compat.reasoningDisableMode).toBe("qwen-template-false");
		expect(vllm.compat.qwenTemplateReasoningEffort).toBe(true);
	});

	it("keeps hosted, pre-3.8, and local-Ollama Qwen off the template ladder", () => {
		const hosted = createModel({
			id: "qwen3.8-27b",
			api: "openai-completions",
			provider: "nanogpt",
			baseUrl: "https://nano-gpt.com/api/v1",
		});
		expect(hosted.compat.qwenTemplateReasoningEffort).toBe(false);
		expect(hosted.thinking?.efforts).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High]);

		const qwen36 = createModel({
			id: "qwen-3.6-27b",
			api: "openai-completions",
			provider: "llama.cpp",
			baseUrl: "http://localhost:8080/v1",
		});
		expect(qwen36.compat.qwenTemplateReasoningEffort).toBe(false);
		expect(qwen36.thinking?.requiresEffort).toBeUndefined();

		// Local Ollama renders its own (Go) templates and keeps the native
		// low/medium/high/max effort vocabulary.
		const ollama = createModel({
			id: "qwen3.8-27b",
			api: "openai-completions",
			provider: "ollama",
			baseUrl: "http://127.0.0.1:11434/v1",
		});
		expect(ollama.compat.qwenTemplateReasoningEffort).toBe(false);
		expect(ollama.thinking?.efforts).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.Max]);
	});
});
