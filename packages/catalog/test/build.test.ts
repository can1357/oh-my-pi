import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { isOfficialAnthropicApiUrl } from "@oh-my-pi/pi-catalog/compat/anthropic";
import { resolveModelPolicy } from "@oh-my-pi/pi-catalog/compat/resolve";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { readModelCache, writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { openrouterModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-catalog/types";

function completionsSpec(overrides: Partial<ModelSpec<"openai-completions">> = {}): ModelSpec<"openai-completions"> {
	return {
		id: "some-model",
		name: "Some Model",
		api: "openai-completions",
		provider: "custom",
		baseUrl: "https://api.example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
		...overrides,
	};
}

function responsesSpec(overrides: Partial<ModelSpec<"openai-responses">> = {}): ModelSpec<"openai-responses"> {
	return {
		id: "some-model",
		name: "Some Model",
		api: "openai-responses",
		provider: "custom",
		baseUrl: "https://api.example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: null,
		maxTokens: null,
		...overrides,
	};
}

function openrouterSpec(overrides: Partial<ModelSpec<"openrouter">> = {}): ModelSpec<"openrouter"> {
	return {
		id: "anthropic/claude-sonnet-4",
		name: "Claude Sonnet 4",
		api: "openrouter",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
		...overrides,
	};
}

describe("buildModel", () => {
	it("resolves a complete compat record for an openai-completions spec with no compat", () => {
		const model = buildModel(completionsSpec());

		expect(model.compat).toBeDefined();
		expect(typeof model.compat.supportsStore).toBe("boolean");
		expect(model.compat.maxTokensField).toBe("max_completion_tokens");
		expect(model.compat.thinkingFormat).toBe("openai");
		expect(typeof model.compat.isOpenRouterHost).toBe("boolean");
		expect(model.compat.isOpenRouterHost).toBe(false);
		expect(model.compatConfig).toBeUndefined();
	});

	it("built models survive a JSON roundtrip, so generator-materialized rows need no rebuild", () => {
		// models.ts consumes models.json rows verbatim as complete Models; this
		// holds only if buildModel output is pure JSON (no functions, no
		// undefined-valued fields that JSON would drop).
		const generated = [buildModel(completionsSpec({ reasoning: true })), buildModel(openrouterSpec())];
		for (const model of generated) {
			expect(JSON.parse(JSON.stringify(model)) as Model<Api>).toEqual(model);
		}
	});

	it("lets sparse overrides win over detection and keeps the verbatim config", () => {
		const sparse = { supportsDeveloperRole: true } as const;
		const model = buildModel(
			completionsSpec({
				provider: "groq",
				baseUrl: "https://api.groq.com/openai/v1",
				compat: sparse,
			}),
		);

		// Detection would say false for a non-OpenAI host; the override wins.
		expect(model.compat.supportsDeveloperRole).toBe(true);
		// The verbatim sparse object is preserved by reference.
		expect(model.compatConfig).toBe(sparse);
	});

	it("materializes the opencode whenThinking variant without mutating the base view", () => {
		const model = buildModel(
			completionsSpec({
				provider: "opencode-zen",
				baseUrl: "https://opencode.ai/zen/v1",
				reasoning: true,
			}),
		);

		expect(model.compat.whenThinking).toBeDefined();
		expect(model.compat.whenThinking?.requiresReasoningContentForToolCalls).toBe(true);
		expect(model.compat.whenThinking?.allowsSyntheticReasoningContentForToolCalls).toBe(false);
		// Base compat stays on the thinking-off defaults.
		expect(model.compat.requiresReasoningContentForToolCalls).toBe(false);
		expect(model.compat.allowsSyntheticReasoningContentForToolCalls).toBe(true);
	});

	it("leaves whenThinking undefined for non-opencode reasoning specs", () => {
		const model = buildModel(completionsSpec({ reasoning: true }));
		expect(model.compat.whenThinking).toBeUndefined();
	});

	it("builds OpenRouter pseudo-API models with shared chat and Responses compat", () => {
		const model = buildModel(
			openrouterSpec({
				compat: { openRouterRouting: { only: ["anthropic"], order: ["anthropic"] } },
			}),
		);

		expect(model.compat).toBeDefined();
		expect(model.compat.isOpenRouterHost).toBe(true);
		expect(model.compat.thinkingFormat).toBe("openrouter");
		expect(model.compat.supportsStrictMode).toBe(true);
		expect(model.compat.strictResponsesPairing).toBe(false);
		expect(model.compat.openRouterRouting).toEqual({ only: ["anthropic"], order: ["anthropic"] });
	});
	it("materializes glyph-tokenization eligibility for Anthropic-compatible wire models", () => {
		const anthropic = buildModel({
			id: "claude-opus-4-8",
			name: "Some Model",
			api: "anthropic-messages",
			provider: "anthropic-compatible",
			baseUrl: "https://api.example.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
		});

		expect(anthropic.requiresGlyphTokenization).toBe(true);
		expect(buildModel(completionsSpec()).requiresGlyphTokenization).toBe(false);
		expect(buildModel({ ...completionsSpec(), id: "claude-opus-4-8" }).requiresGlyphTokenization).toBe(true);
		expect(
			buildModel({
				id: "other-model",
				name: "Other Model",
				api: "anthropic-messages",
				provider: "anthropic-compatible",
				baseUrl: "https://api.example.com/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 8_192,
			}).requiresGlyphTokenization,
		).toBe(false);
		expect(getBundledModel("anthropic", "claude-opus-4-8").requiresGlyphTokenization).toBe(true);
	});

	it("loads bundled OpenRouter models with resolved compat", () => {
		const model = getBundledModel<"openrouter">("openrouter", "anthropic/claude-sonnet-4");

		expect(model.compat).toBeDefined();
		expect(model.compat?.isOpenRouterHost).toBe(true);
		expect(model.compat?.supportsStrictMode).toBe(true);
	});

	it("strips gateway author prefixes and extrinsic tags from display names", () => {
		const cases: [string, string][] = [
			["Anthropic: Claude Opus 4.6 (Fast) ($$$$)", "Claude Opus 4.6 (Fast)"],
			["Claude Opus 4.5 (latest)", "Claude Opus 4.5"],
			["Gemini 2.5 Flash (Thinking) (Antigravity)", "Gemini 2.5 Flash (Thinking)"],
			["Stealth: Claude Opus 4.6 (20% off)", "Claude Opus 4.6"],
			["NousResearch: Hermes 2 Pro (retires Jun 5)", "Hermes 2 Pro"],
			["Z.ai: GLM 5", "GLM 5"],
		];
		for (const [raw, cleaned] of cases) {
			expect(buildModel(completionsSpec({ name: raw })).name).toBe(cleaned);
		}
	});

	it("keeps variant tags that map to distinct wire ids", () => {
		const keep = [
			"Trinity Large Preview (free)",
			"Grok 4.1 Fast (Non-Reasoning)",
			"GPT-4o (2024-08-06)",
			"Claude Haiku 3.5 (EU)",
			"Llama-3.3+(3.1v3.3)-70B-Hanami-x1",
		];
		for (const name of keep) {
			expect(buildModel(completionsSpec({ name })).name).toBe(name);
		}
	});
	it("limits inferred GA computer capability to first-party Responses transports", () => {
		const common = {
			id: "gpt-5.6-terra",
			name: "GPT-5.6 Terra",
			reasoning: true,
			input: ["text", "image"] as Array<"text" | "image">,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400_000,
			maxTokens: 128_000,
		};
		const direct = {
			...common,
			api: "openai-responses" as const,
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
		} satisfies ModelSpec<"openai-responses">;

		expect(buildModel(direct).supportsComputerUse).toBe(true);
		expect(buildModel({ ...direct, baseUrl: "https://gateway.example/v1" }).supportsComputerUse).toBe(false);
		expect(buildModel({ ...direct, provider: "gpt-proxy" }).supportsComputerUse).toBe(false);

		const subscription = {
			...common,
			api: "openai-codex-responses" as const,
			provider: "openai-codex",
			baseUrl: "https://chatgpt.com/backend-api",
		} satisfies ModelSpec<"openai-codex-responses">;
		for (const id of ["gpt-5.3-codex-spark", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"]) {
			expect(buildModel({ ...subscription, id, name: id }).supportsComputerUse).toBe(false);
		}
		expect(buildModel({ ...subscription, supportsComputerUse: true }).supportsComputerUse).toBe(true);

		const azure = {
			...common,
			api: "azure-openai-responses" as const,
			provider: "azure",
			baseUrl: "",
		} satisfies ModelSpec<"azure-openai-responses">;
		expect(buildModel(azure).supportsComputerUse).toBe(true);
		expect(buildModel({ ...azure, provider: "azure-openai" }).supportsComputerUse).toBe(true);
		expect(buildModel({ ...azure, provider: "custom-azure-proxy" }).supportsComputerUse).toBe(false);
		expect(buildModel({ ...azure, baseUrl: "https://gateway.example/openai/v1" }).supportsComputerUse).toBe(false);
	});
	it("recomputes inferred computer capability when a built model is rerouted while preserving explicit metadata", () => {
		const direct = {
			id: "gpt-5.4",
			name: "GPT-5.4",
			api: "openai-responses" as const,
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text", "image"] as Array<"text" | "image">,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400_000,
			maxTokens: 128_000,
		} satisfies ModelSpec<"openai-responses">;
		const reroute = (model: Model<"openai-responses">, baseUrl: string) =>
			buildModel({ ...model, baseUrl, compat: model.compatConfig } as ModelSpec<"openai-responses">);

		expect(reroute(buildModel(direct), "https://gateway.example/v1").supportsComputerUse).toBe(false);
		const inferred = buildModel(direct);
		expect(
			buildModel({
				...inferred,
				provider: "gpt-proxy",
				compat: inferred.compatConfig,
			} as ModelSpec<"openai-responses">).supportsComputerUse,
		).toBe(false);
		expect(
			reroute(buildModel({ ...direct, supportsComputerUse: true }), "https://gateway.example/v1")
				.supportsComputerUse,
		).toBe(true);
		expect(reroute(buildModel({ ...direct, supportsComputerUse: false }), direct.baseUrl).supportsComputerUse).toBe(
			false,
		);
	});
});

describe("xAI Responses reasoning-effort suppression", () => {
	const grokResponsesSpec = (
		id: string,
		provider: "xai" | "xai-oauth" = "xai-oauth",
	): ModelSpec<"openai-responses"> => ({
		id,
		name: id,
		api: "openai-responses",
		provider,
		baseUrl: "https://api.x.ai/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 512_000,
		maxTokens: 512_000,
	});

	it("omits the effort dial for a custom grok-build spec (off the allowlist)", () => {
		const compat = resolveModelPolicy(grokResponsesSpec("grok-build")).compat;
		expect(compat.supportsReasoningEffort).toBe(false);
		expect(compat.omitReasoningEffort).toBe(true);
		expect(buildModel(grokResponsesSpec("grok-build")).thinking).toBeUndefined();
	});

	it("keeps the effort dial for a custom grok-4.3 spec (on the allowlist)", () => {
		expect(resolveModelPolicy(grokResponsesSpec("grok-4.3")).compat.supportsReasoningEffort).toBe(true);
	});

	it("applies the same Responses dialect to paid xai and xai-oauth", () => {
		const paid = resolveModelPolicy(grokResponsesSpec("grok-4.3", "xai")).compat;
		const oauth = resolveModelPolicy(grokResponsesSpec("grok-4.3", "xai-oauth")).compat;
		expect(paid.promptCacheSessionHeader).toBe("x-grok-conv-id");
		expect(oauth.promptCacheSessionHeader).toBe("x-grok-conv-id");
		expect(paid.includeEncryptedReasoning).toBe(true);
		expect(oauth.includeEncryptedReasoning).toBe(true);
		expect(paid.filterReasoningHistory).toBe(false);
		expect(oauth.filterReasoningHistory).toBe(false);
		expect(paid.supportsImageDetailOriginal).toBe(false);
		expect(oauth.supportsImageDetailOriginal).toBe(false);
		expect(paid.supportsReasoningEffort).toBe(true);
		expect(oauth.supportsReasoningEffort).toBe(true);
		expect(paid.reasoningEffortMap).toEqual({ minimal: "low", xhigh: "high", max: "high" });
		expect(oauth.reasoningEffortMap).toEqual({ minimal: "low", xhigh: "high", max: "high" });
		expect(
			resolveModelPolicy(grokResponsesSpec("grok-4.20-multi-agent-0309", "xai")).compat.reasoningEffortMap,
		).toEqual({ minimal: "low" });
		expect(paid.supportsPenaltyAndStopParams).toBe(false);
		expect(oauth.supportsPenaltyAndStopParams).toBe(false);
		expect(paid.supportsReasoningSummary).toBe(false);
		expect(oauth.supportsReasoningSummary).toBe(false);
	});

	it("suppresses penalty params on every first-party xAI Responses model", () => {
		const reasoning = resolveModelPolicy(grokResponsesSpec("grok-4.5", "xai")).compat;
		const nonReasoning = resolveModelPolicy({
			...grokResponsesSpec("grok-2", "xai"),
			reasoning: false,
		}).compat;
		expect(reasoning.supportsPenaltyAndStopParams).toBe(false);
		expect(nonReasoning.supportsPenaltyAndStopParams).toBe(false);
	});

	it("omits effort for paid xai models off the Grok allowlist", () => {
		const compat = resolveModelPolicy(grokResponsesSpec("grok-code-fast-1", "xai")).compat;
		expect(compat.supportsReasoningEffort).toBe(false);
		expect(compat.omitReasoningEffort).toBe(true);
		expect(buildModel(grokResponsesSpec("grok-code-fast-1", "xai")).thinking).toBeUndefined();
	});

	it("exposes the grok-4.6 low..xhigh ladder and rejects max", () => {
		const model = buildModel(grokResponsesSpec("grok-4.6"));
		expect(model.compat.supportsReasoningEffort).toBe(true);
		expect(model.compat.omitReasoningEffort).toBe(false);
		expect(model.thinking?.efforts).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]);
		expect(model.thinking?.efforts).not.toContain(Effort.Max);
	});

	it("lets the grok-4.6 allowlist beat a stale cached omitReasoningEffort flag", () => {
		const model = buildModel({
			...grokResponsesSpec("grok-4.6"),
			compat: { omitReasoningEffort: true },
		});
		expect(model.compat.supportsReasoningEffort).toBe(true);
		expect(model.compat.omitReasoningEffort).toBe(false);
		expect(model.thinking?.efforts).toContain(Effort.XHigh);
		expect(model.thinking?.efforts).not.toContain(Effort.Max);
	});

	it("lets an explicit compat.supportsReasoningEffort override the allowlist default", () => {
		const compat = resolveModelPolicy({
			...grokResponsesSpec("grok-build"),
			compat: { supportsReasoningEffort: true },
		}).compat;
		expect(compat.supportsReasoningEffort).toBe(true);
	});

	it("does not suppress effort for a non-xAI provider with a grok-like id", () => {
		const compat = resolveModelPolicy({
			...grokResponsesSpec("grok-build"),
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
		}).compat;
		expect(compat.supportsReasoningEffort).toBe(true);
	});
});

describe("openai-completions wire-quirk compat detection", () => {
	it("derives wireModelIdMode from provider/host", () => {
		expect(resolveModelPolicy(completionsSpec({ provider: "firepass" })).compat.wireModelIdMode).toBe("firepass");
		expect(
			resolveModelPolicy(
				completionsSpec({ provider: "fireworks", baseUrl: "https://api.fireworks.ai/inference/v1" }),
			).compat.wireModelIdMode,
		).toBe("fireworks");
		// Fireworks "Fast" variants route through the router namespace (like Fire Pass).
		expect(
			resolveModelPolicy(
				completionsSpec({
					provider: "fireworks",
					id: "kimi-k2.6-fast",
					baseUrl: "https://api.fireworks.ai/inference/v1",
				}),
			).compat.wireModelIdMode,
		).toBe("firepass");
		expect(
			resolveModelPolicy(completionsSpec({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" })).compat
				.wireModelIdMode,
		).toBe("openrouter");
		expect(resolveModelPolicy(completionsSpec()).compat.wireModelIdMode).toBe("raw");
	});

	it("strips DeepSeek special tokens only for deepseek ids on nvidia/deepseek providers", () => {
		expect(
			resolveModelPolicy(
				completionsSpec({
					provider: "nvidia",
					id: "deepseek-ai/deepseek-v3.1",
					baseUrl: "https://integrate.api.nvidia.com/v1",
				}),
			).compat.stripDeepseekSpecialTokens,
		).toBe(true);
		expect(
			resolveModelPolicy(
				completionsSpec({ provider: "deepseek", id: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1" }),
			).compat.stripDeepseekSpecialTokens,
		).toBe(true);
		// DeepSeek id behind another host must NOT strip (only nvidia/deepseek hosts emit the raw tokens).
		expect(
			resolveModelPolicy(
				completionsSpec({
					provider: "openrouter",
					id: "deepseek/deepseek-v3.1",
					baseUrl: "https://openrouter.ai/api/v1",
				}),
			).compat.stripDeepseekSpecialTokens,
		).toBe(false);
		// Non-deepseek id on nvidia must NOT strip.
		expect(
			resolveModelPolicy(
				completionsSpec({
					provider: "nvidia",
					id: "meta/llama-3.1",
					baseUrl: "https://integrate.api.nvidia.com/v1",
				}),
			).compat.stripDeepseekSpecialTokens,
		).toBe(false);
	});

	it("downgrades forced tool choice only for DeepSeek reasoning models on OpenCode gateways", () => {
		const deepseekReasoning = {
			id: "deepseek-v4-flash",
			name: "DeepSeek V4 Flash",
			reasoning: true,
		} as const;

		expect(
			resolveModelPolicy(
				completionsSpec({
					...deepseekReasoning,
					provider: "opencode-zen",
					baseUrl: "https://opencode.ai/zen/v1",
				}),
			).compat.supportsForcedToolChoice,
		).toBe(false);
		expect(
			resolveModelPolicy(
				completionsSpec({
					...deepseekReasoning,
					provider: "custom",
					baseUrl: "https://opencode.ai/zen/go/v1",
				}),
			).compat.supportsForcedToolChoice,
		).toBe(false);
		expect(
			resolveModelPolicy(
				completionsSpec({
					...deepseekReasoning,
					provider: "nvidia",
					baseUrl: "https://integrate.api.nvidia.com/v1",
				}),
			).compat.supportsForcedToolChoice,
		).toBe(true);
		expect(
			resolveModelPolicy(
				completionsSpec({
					...deepseekReasoning,
					provider: "opencode-zen",
					baseUrl: "https://opencode.ai/zen/v1",
					reasoning: false,
				}),
			).compat.supportsForcedToolChoice,
		).toBe(true);
	});
	it("downgrades forced tool choice for OpenCode gateways on Responses API", () => {
		expect(
			resolveModelPolicy(
				responsesSpec({
					id: "muse-spark-1.2-contributor",
					provider: "opencode-go",
					name: "Muse Spark",
					baseUrl: "https://opencode.ai/zen/go/v1",
				}),
			).compat.supportsForcedToolChoice,
		).toBe(false);
		expect(
			resolveModelPolicy(
				responsesSpec({
					id: "muse-spark-1.2",
					provider: "opencode-zen",
					name: "Muse Spark",
					baseUrl: "https://opencode.ai/zen/v1",
				}),
			).compat.supportsForcedToolChoice,
		).toBe(false);
		expect(
			resolveModelPolicy(
				responsesSpec({ id: "gpt-5", provider: "openai", name: "GPT-5", baseUrl: "https://api.openai.com/v1" }),
			).compat.supportsForcedToolChoice,
		).toBe(true);
	});

	it("requires a synthetic assistant bridge after tool results only for Mistral hosts", () => {
		// Mistral/Devstral reject a user message directly after a tool result; the chat
		// builder bridges it with a synthetic assistant turn, keyed on the Mistral host.
		expect(
			resolveModelPolicy(
				completionsSpec({ provider: "mistral", id: "devstral-latest", baseUrl: "https://api.mistral.ai/v1" }),
			).compat.requiresAssistantAfterToolResult,
		).toBe(true);
		// URL-only match (custom provider fronting Mistral).
		expect(
			resolveModelPolicy(
				completionsSpec({
					provider: "custom",
					id: "mistral-large",
					baseUrl: "https://proxy.example/mistral.ai/v1",
				}),
			).compat.requiresAssistantAfterToolResult,
		).toBe(true);
		// Non-Mistral hosts must not insert the bridge.
		expect(resolveModelPolicy(completionsSpec()).compat.requiresAssistantAfterToolResult).toBe(false);
		expect(
			resolveModelPolicy(completionsSpec({ provider: "openai", id: "gpt-5", baseUrl: "https://api.openai.com/v1" }))
				.compat.requiresAssistantAfterToolResult,
		).toBe(false);
	});

	it("flags cumulative reasoning deltas for MiniMax provider or id", () => {
		expect(resolveModelPolicy(completionsSpec({ provider: "minimax" })).compat.reasoningDeltasMayBeCumulative).toBe(
			true,
		);
		expect(resolveModelPolicy(completionsSpec({ id: "MiniMax-M2" })).compat.reasoningDeltasMayBeCumulative).toBe(
			true,
		);
		expect(resolveModelPolicy(completionsSpec()).compat.reasoningDeltasMayBeCumulative).toBe(false);
	});

	it("extends the reasoning stream idle floor to Kimi K2.6 and K2.7 Code, not other reasoning models", () => {
		const kimiOverrides = {
			provider: "moonshot",
			baseUrl: "https://api.moonshot.ai/v1",
			reasoning: true,
		} as const;
		expect(
			resolveModelPolicy(completionsSpec({ ...kimiOverrides, id: "kimi-k2.6" })).compat.streamIdleTimeoutMs,
		).toBe(300_000);
		expect(
			resolveModelPolicy(completionsSpec({ ...kimiOverrides, id: "kimi-k2.7-code" })).compat.streamIdleTimeoutMs,
		).toBe(300_000);
		expect(
			resolveModelPolicy(completionsSpec({ ...kimiOverrides, id: "kimi-k2.7-code-highspeed" })).compat
				.streamIdleTimeoutMs,
		).toBe(300_000);
		// K2.7 Code on non-native OpenAI-compatible hosts keeps their default.
		expect(
			resolveModelPolicy(completionsSpec({ id: "kimi-k2.7-code", reasoning: true })).compat.streamIdleTimeoutMs,
		).toBeUndefined();
		// A non-Kimi reasoning model on a generic host keeps the runtime default.
		expect(
			resolveModelPolicy(completionsSpec({ id: "some-reasoner", reasoning: true })).compat.streamIdleTimeoutMs,
		).toBeUndefined();
	});

	it("maps the remaining provider-keyed wire quirks", () => {
		expect(resolveModelPolicy(completionsSpec({ provider: "ollama" })).compat.emptyLengthFinishIsContextError).toBe(
			true,
		);
		expect(resolveModelPolicy(completionsSpec()).compat.emptyLengthFinishIsContextError).toBe(false);
		expect(
			resolveModelPolicy(completionsSpec({ provider: "openai", baseUrl: "https://api.openai.com/v1" })).compat
				.usesOpenAIToolCallIdLimit,
		).toBe(true);
		expect(resolveModelPolicy(completionsSpec()).compat.usesOpenAIToolCallIdLimit).toBe(false);
		expect(
			resolveModelPolicy(
				completionsSpec({ provider: "fireworks", baseUrl: "https://api.fireworks.ai/inference/v1" }),
			).compat.dropThinkingWhenReasoningEffort,
		).toBe(true);
		expect(resolveModelPolicy(completionsSpec()).compat.dropThinkingWhenReasoningEffort).toBe(false);
	});

	it("floors the stream timeout for a loopback litellm proxy without enabling reasoning replay (#4786)", () => {
		// A litellm proxy on a loopback baseUrl fronts a local llama-server whose
		// prefill can exceed the 100s default first-event budget on large prompts.
		// The proxy carve-out (which keeps `replayReasoningContent` off so the
		// field is never forwarded to an unrelated cloud upstream) must NOT also
		// strip the widened stream-timeout floor, or the turn aborts and
		// retry-loops during a slow reprocess.
		const loopback = resolveModelPolicy(
			completionsSpec({ provider: "litellm", id: "qwen3", baseUrl: "http://127.0.0.1:4000/v1" }),
		).compat;
		expect(loopback.streamIdleTimeoutMs).toBe(300_000);
		expect(loopback.replayReasoningContent).toBe(false);

		// A litellm proxy on a remote baseUrl gets neither: no local upstream to
		// wait on, and replay would risk a 400 on the cloud upstream.
		const remote = resolveModelPolicy(
			completionsSpec({ provider: "litellm", id: "qwen3", baseUrl: "https://litellm.example.com/v1" }),
		).compat;
		expect(remote.streamIdleTimeoutMs).toBeUndefined();
		expect(remote.replayReasoningContent).toBe(false);

		// A first-party local backend (llama.cpp) still gets both the floor and
		// the reasoning replay it needs for KV-cache reuse.
		const native = resolveModelPolicy(
			completionsSpec({ provider: "llama.cpp", id: "qwen3", baseUrl: "http://127.0.0.1:8080/v1" }),
		).compat;
		expect(native.streamIdleTimeoutMs).toBe(300_000);
		expect(native.replayReasoningContent).toBe(true);
	});

	it("disables the leaked-markup healer for the official OpenAI endpoint only", () => {
		// Official OpenAI returns structured reasoning and never leaks fences, so
		// the provider-local healer stays off; every other OpenAI-compatible host
		// keeps the default "thinking" healer, and Kimi/DSML keep their grammars.
		expect(
			resolveModelPolicy(completionsSpec({ provider: "openai", baseUrl: "https://api.openai.com/v1" })).compat
				.streamMarkupHealingPattern,
		).toBeUndefined();
		expect(
			resolveModelPolicy(completionsSpec({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" })).compat
				.streamMarkupHealingPattern,
		).toBe("thinking");
		// A lookalike host under the openai provider id is NOT the official endpoint.
		expect(
			resolveModelPolicy(completionsSpec({ provider: "openai", baseUrl: "https://api.openai.com.evil/v1" })).compat
				.streamMarkupHealingPattern,
		).toBe("thinking");
		expect(
			resolveModelPolicy(
				completionsSpec({ provider: "moonshot", id: "kimi-k2", baseUrl: "https://api.moonshot.ai/v1" }),
			).compat.streamMarkupHealingPattern,
		).toBe("kimi");
	});

	it("derives Responses obfuscation opt-out and wire mode per surface", () => {
		expect(
			resolveModelPolicy(
				responsesSpec({ id: "gpt-5", provider: "openai", name: "GPT 5", baseUrl: "https://api.openai.com/v1" }),
			).compat.supportsObfuscationOptOut,
		).toBe(true);
		// Azure mirrors the schema but is NOT the OpenAI host: no obfuscation opt-out.
		expect(
			resolveModelPolicy({
				id: "gpt-5",
				name: "gpt-5",
				api: "azure-openai-responses",
				provider: "azure",
				baseUrl: "",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: null,
				maxTokens: null,
			}).compat.supportsObfuscationOptOut,
		).toBe(false);
		const openrouterResponses = resolveModelPolicy(
			responsesSpec({
				id: "anthropic/claude-sonnet-4",
				provider: "openrouter",
				name: "Claude Sonnet 4",
				baseUrl: "https://openrouter.ai/api/v1",
			}),
		).compat;
		expect(openrouterResponses.supportsObfuscationOptOut).toBe(false);
		expect(openrouterResponses.wireModelIdMode).toBe("openrouter");
	});
});

describe("OpenAI explicit prompt-cache breakpoint compat", () => {
	it("enables the 30-minute breakpoint contract for GPT-5.6+ on the official API", () => {
		const completions = resolveModelPolicy(
			completionsSpec({ id: "gpt-5.6", provider: "openai", baseUrl: "https://api.openai.com/v1" }),
		).compat;
		const responses = resolveModelPolicy(
			responsesSpec({
				id: "gpt-5.6-mini",
				provider: "openai",
				name: "GPT 5.6 Mini",
				baseUrl: "https://api.openai.com/v1",
			}),
		).compat;

		expect(completions.supportsPromptCacheBreakpoints).toBe(true);
		expect(completions.promptCacheBreakpointTtl).toBe("30m");
		expect(responses.supportsPromptCacheBreakpoints).toBe(true);
		expect(responses.promptCacheBreakpointTtl).toBe("30m");

		expect(
			resolveModelPolicy(
				completionsSpec({ id: "gpt-5.6-preview", provider: "openai", baseUrl: "https://api.openai.com/v1" }),
			).compat.supportsPromptCacheBreakpoints,
		).toBe(true);
		expect(
			resolveModelPolicy(
				completionsSpec({ id: "gpt-5.7", provider: "openai", baseUrl: "https://api.openai.com/v1" }),
			).compat.supportsPromptCacheBreakpoints,
		).toBe(true);
		expect(
			resolveModelPolicy(
				responsesSpec({
					id: "gpt-6.1-mini",
					provider: "openai",
					name: "GPT 6.1 Mini",
					baseUrl: "https://api.openai.com/v1",
				}),
			).compat.supportsPromptCacheBreakpoints,
		).toBe(true);

		expect(
			resolveModelPolicy(
				completionsSpec({ id: "gpt-5.5", provider: "openai", baseUrl: "https://api.openai.com/v1" }),
			).compat.supportsPromptCacheBreakpoints,
		).toBe(false);
		expect(
			resolveModelPolicy(
				responsesSpec({
					id: "gpt-5.6",
					provider: "openrouter",
					name: "GPT 5.6 through OpenRouter",
					baseUrl: "https://openrouter.ai/api/v1",
				}),
			).compat.supportsPromptCacheBreakpoints,
		).toBe(false);
		expect(
			resolveModelPolicy(
				responsesSpec({ id: "gpt-4.1", provider: "openai", name: "GPT 4.1", baseUrl: "https://api.openai.com/v1" }),
			).compat.supportsPromptCacheBreakpoints,
		).toBe(false);
		expect(
			resolveModelPolicy(
				responsesSpec({
					id: "gpt-5.6",
					provider: "openai",
					name: "GPT 5.6",
					baseUrl: "https://api.openai.com.evil/v1",
				}),
			).compat.supportsPromptCacheBreakpoints,
		).toBe(false);
	});

	it("keeps custom endpoint support opt-in", () => {
		const compat = resolveModelPolicy(
			completionsSpec({
				id: "gpt-5.6",
				compat: { supportsPromptCacheBreakpoints: true, promptCacheBreakpointTtl: "30m" },
			}),
		).compat;

		expect(compat.supportsPromptCacheBreakpoints).toBe(true);
		expect(compat.promptCacheBreakpointTtl).toBe("30m");
	});
});

describe("OpenRouter model discovery", () => {
	it("keeps refreshed OpenRouter models on the OpenRouter pseudo API", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-openrouter-refresh-"));
		const dbPath = path.join(tempDir, "models.db");
		const routing = { only: ["anthropic"], order: ["anthropic"] };
		const staticModel = openrouterSpec({ compat: { openRouterRouting: routing } });
		const options = openrouterModelManagerOptions({
			fetch: async () =>
				new Response(
					JSON.stringify({
						data: [
							{
								id: staticModel.id,
								name: "Anthropic: Claude Sonnet 4",
								supported_parameters: ["tools", "tool_choice", "reasoning"],
								architecture: { modality: "text+image" },
								pricing: {
									prompt: "0.000003",
									completion: "0.000015",
									input_cache_read: "0.0000003",
									input_cache_write: "0.00000375",
								},
								top_provider: { max_completion_tokens: 32_000 },
								context_length: 180_000,
							},
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		});

		try {
			const dynamicModels = await options.fetchDynamicModels?.();
			expect(dynamicModels?.[0]?.api).toBe("openrouter");

			const online = await resolveProviderModels<"openrouter">(
				{
					...options,
					staticModels: [staticModel],
					cacheDbPath: dbPath,
				},
				"online",
			);

			const model = online.models.find(candidate => candidate.id === staticModel.id);
			expect(model?.api).toBe("openrouter");
			expect(model?.provider).toBe("openrouter");
			expect(model?.compat.isOpenRouterHost).toBe(true);
			expect(model?.compat.openRouterRouting).toEqual(routing);
			expect(model?.input).toEqual(["text", "image"]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("maps OpenRouter's advertised reasoning effort ladder, default, and mandatory state", async () => {
		const options = openrouterModelManagerOptions({
			fetch: async () =>
				Response.json({
					data: [
						{
							id: "deepseek/deepseek-v4-flash-0731",
							name: "DeepSeek V4 Flash 0731",
							supported_parameters: ["tools", "reasoning", "reasoning_effort"],
							reasoning: {
								supported_efforts: ["max", "high", "low"],
								default_effort: "high",
								mandatory: true,
							},
						},
					],
				}),
		});
		const specs = await options.fetchDynamicModels?.();
		const spec = specs?.find(model => model.id === "deepseek/deepseek-v4-flash-0731");
		if (!spec) throw new Error("Expected discovered DeepSeek V4 Flash 0731 model");

		expect(buildModel(spec).thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Low, Effort.High, Effort.Max],
			defaultLevel: Effort.High,
			requiresEffort: true,
		});
	});

	it("ignores legacy OpenRouter chat-completions cache rows", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-openrouter-legacy-cache-"));
		const dbPath = path.join(tempDir, "models.db");
		const legacyModel = buildModel(
			completionsSpec({
				id: "anthropic/claude-sonnet-4",
				provider: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
				reasoning: true,
			}),
		);
		try {
			writeModelCache("openrouter", Date.now(), [legacyModel], true, "", dbPath);

			const offline = await resolveProviderModels<"openrouter">(
				{
					...openrouterModelManagerOptions(),
					staticModels: [],
					cacheDbPath: dbPath,
				},
				"offline",
			);

			expect(offline.models).toEqual([]);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});

describe("model cache spec round trip", () => {
	it("persists sparse specs and rebuilds resolved models on cache reads", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-model-cache-"));
		const dbPath = path.join(tempDir, "models.db");
		const sparse = { supportsDeveloperRole: true } as const;
		const spec = completionsSpec({ provider: "spec-cache-test", compat: sparse });
		try {
			const online = await resolveProviderModels<"openai-completions">(
				{
					providerId: "spec-cache-test",
					staticModels: [],
					cacheDbPath: dbPath,
					fetchDynamicModels: async () => [spec],
				},
				"online",
			);
			expect(online.models[0]?.compat.supportsDeveloperRole).toBe(true);

			// The persisted row carries the sparse spec, never the resolved record.
			const db = new Database(dbPath, { readonly: true });
			const row = db
				.query<{ models: string }, [string]>("SELECT models FROM model_cache WHERE provider_id = ?")
				.get("spec-cache-test");
			db.close();
			expect(row).toBeDefined();
			const persisted = JSON.parse(row?.models ?? "[]") as ModelSpec<"openai-completions">[];
			expect(persisted[0]?.compat).toEqual(sparse);
			expect(persisted[0]).not.toHaveProperty("compatConfig");
			expect(persisted[0]?.compat).not.toHaveProperty("isOpenRouterHost");

			// Offline reads rebuild the row into a fully-resolved model.
			const offline = await resolveProviderModels<"openai-completions">(
				{
					providerId: "spec-cache-test",
					staticModels: [],
					cacheDbPath: dbPath,
				},
				"offline",
			);
			const model = offline.models.find(candidate => candidate.id === spec.id);
			expect(model?.compat.supportsDeveloperRole).toBe(true);
			expect(model?.compat.isOpenRouterHost).toBe(false);
			expect(model?.compatConfig).toEqual(sparse);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("preserves static long-context pricing through dynamic refresh and cache restore", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-tiered-cost-"));
		const dbPath = path.join(tempDir, "models.db");
		const staticModel = completionsSpec({
			id: "tiered-model",
			provider: "tiered-cost-test",
			cost: {
				input: 1,
				output: 2,
				cacheRead: 0.1,
				cacheWrite: 1.25,
				longContext: {
					inputThreshold: 272_000,
					input: 2,
					output: 3,
					cacheRead: 0.2,
					cacheWrite: 2.5,
				},
			},
		});
		const dynamicModel = completionsSpec({
			...staticModel,
			cost: { input: 3, output: 4, cacheRead: 0.3, cacheWrite: 3.75 },
		});
		const options = {
			providerId: "tiered-cost-test",
			staticModels: [staticModel],
			cacheDbPath: dbPath,
		};
		try {
			const online = await resolveProviderModels<"openai-completions">(
				{ ...options, fetchDynamicModels: async () => [dynamicModel] },
				"online",
			);
			expect(online.models[0]?.cost).toEqual({
				...dynamicModel.cost,
				longContext: staticModel.cost.longContext,
			});

			const offline = await resolveProviderModels<"openai-completions">(options, "offline");
			expect(offline.models[0]?.cost.longContext).toEqual(staticModel.cost.longContext);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("invalidates schema-v10 rows that predate computer-use capability provenance", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-legacy-computer-cache-"));
		const dbPath = path.join(tempDir, "models.db");
		const model = buildModel({
			id: "legacy-inferred-computer",
			name: "Legacy inferred computer",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400_000,
			maxTokens: 128_000,
		} satisfies ModelSpec<"openai-responses">);
		try {
			writeModelCache("legacy-computer-cache-test", Date.now(), [model], true, "", dbPath);
			const db = new Database(dbPath);
			db.run("UPDATE model_cache SET version = 10 WHERE provider_id = ?", ["legacy-computer-cache-test"]);
			db.close();

			expect(readModelCache("legacy-computer-cache-test", Infinity, Date.now, dbPath)).toBeNull();
			const verified = new Database(dbPath, { readonly: true });
			const row = verified.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM model_cache").get();
			verified.close();
			expect(row?.count).toBe(0);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("preserves computer-use provenance across cache restarts and endpoint reroutes", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-computer-use-cache-"));
		const dbPath = path.join(tempDir, "models.db");
		const common = {
			name: "GPT-5.4",
			requestModelId: "gpt-5.4",
			api: "openai-responses" as const,
			reasoning: true,
			input: ["text", "image"] as Array<"text" | "image">,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 400_000,
			maxTokens: 128_000,
		};
		const direct = {
			...common,
			id: "inferred-direct",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
		} satisfies ModelSpec<"openai-responses">;
		const proxy = {
			...common,
			id: "inferred-proxy",
			provider: "gpt-proxy",
			baseUrl: "https://gateway.example/v1",
		} satisfies ModelSpec<"openai-responses">;
		const explicitTrue = { ...direct, id: "explicit-true", supportsComputerUse: true };
		const explicitFalse = { ...proxy, id: "explicit-false", supportsComputerUse: false };
		const reroute = (model: Model<"openai-responses">, provider: string, baseUrl: string) =>
			buildModel({ ...model, provider, baseUrl, compat: model.compatConfig } as ModelSpec<"openai-responses">);

		try {
			await resolveProviderModels<"openai-responses">(
				{
					providerId: "computer-use-cache-test",
					staticModels: [],
					cacheDbPath: dbPath,
					fetchDynamicModels: async () => [direct, proxy, explicitTrue, explicitFalse],
				},
				"online",
			);

			const db = new Database(dbPath, { readonly: true });
			const row = db
				.query<{ models: string }, [string]>("SELECT models FROM model_cache WHERE provider_id = ?")
				.get("computer-use-cache-test");
			db.close();
			const persisted = JSON.parse(row?.models ?? "[]") as Array<Record<string, unknown>>;
			expect(persisted.find(model => model.id === direct.id)).not.toHaveProperty("supportsComputerUse");
			expect(persisted.find(model => model.id === proxy.id)).not.toHaveProperty("supportsComputerUse");
			expect(persisted.find(model => model.id === explicitTrue.id)?.supportsComputerUse).toBe(true);
			expect(persisted.find(model => model.id === explicitFalse.id)?.supportsComputerUse).toBe(false);

			const offline = await resolveProviderModels<"openai-responses">(
				{ providerId: "computer-use-cache-test", staticModels: [], cacheDbPath: dbPath },
				"offline",
			);
			const byId = new Map(offline.models.map(model => [model.id, model]));
			const cachedDirect = byId.get(direct.id);
			const cachedProxy = byId.get(proxy.id);
			const cachedExplicitTrue = byId.get(explicitTrue.id);
			const cachedExplicitFalse = byId.get(explicitFalse.id);
			expect(cachedDirect?.supportsComputerUseConfig).toBeUndefined();
			expect(cachedProxy?.supportsComputerUseConfig).toBeUndefined();
			expect(reroute(cachedDirect!, "gpt-proxy", proxy.baseUrl).supportsComputerUse).toBe(false);
			expect(reroute(cachedProxy!, "openai", direct.baseUrl).supportsComputerUse).toBe(true);
			expect(cachedExplicitTrue?.supportsComputerUseConfig).toBe(true);
			expect(cachedExplicitFalse?.supportsComputerUseConfig).toBe(false);
			expect(reroute(cachedExplicitTrue!, "gpt-proxy", proxy.baseUrl).supportsComputerUse).toBe(true);
			expect(reroute(cachedExplicitFalse!, "openai", direct.baseUrl).supportsComputerUse).toBe(false);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("uses current static limits for same-id cache rows when the static fingerprint changed", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-static-fingerprint-"));
		const dbPath = path.join(tempDir, "models.db");
		const staleSameId = buildModel(
			completionsSpec({
				id: "catalog-updated-model",
				name: "Catalog Updated Model (cached)",
				provider: "spec-cache-test",
				contextWindow: 64_000,
				maxTokens: 4_000,
			}),
		);
		const cachedOnly = buildModel(
			completionsSpec({
				id: "cache-only-model",
				name: "Cache Only Model",
				provider: "spec-cache-test",
				contextWindow: 96_000,
				maxTokens: 6_000,
			}),
		);
		const updatedStatic = completionsSpec({
			id: staleSameId.id,
			name: "Catalog Updated Model",
			provider: "spec-cache-test",
			contextWindow: 256_000,
			maxTokens: 32_000,
		});

		try {
			writeModelCache(
				"spec-cache-test",
				Date.now(),
				[staleSameId, cachedOnly],
				true,
				"merge-v3:stale-static-catalog",
				dbPath,
			);

			const offline = await resolveProviderModels<"openai-completions">(
				{
					providerId: "spec-cache-test",
					staticModels: [updatedStatic],
					cacheDbPath: dbPath,
				},
				"offline",
			);

			const sameId = offline.models.find(candidate => candidate.id === updatedStatic.id);
			expect(sameId?.contextWindow).toBe(256_000);
			expect(sameId?.maxTokens).toBe(32_000);

			const cacheOnly = offline.models.find(candidate => candidate.id === cachedOnly.id);
			expect(cacheOnly?.contextWindow).toBe(96_000);
			expect(cacheOnly?.maxTokens).toBe(6_000);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
	it("retries an empty discovery result after the short interval and caches recovery", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-empty-discovery-"));
		const dbPath = path.join(tempDir, "models.db");
		const recoveredModel = completionsSpec({ id: "recovered-model", provider: "empty-discovery-test" });
		let discoveredModels: readonly ModelSpec<"openai-completions">[] = [];
		let fetches = 0;
		let currentTime = 1_000_000;
		const options = {
			providerId: "empty-discovery-test",
			staticModels: [],
			dynamicModelsAuthoritative: true,
			cacheDbPath: dbPath,
			now: () => currentTime,
			fetchDynamicModels: async () => {
				fetches++;
				return discoveredModels;
			},
		};
		try {
			const empty = await resolveProviderModels(options, "online");
			expect(empty.models).toEqual([]);
			// Authoritative for the cycle (drives downstream pruning) yet not pinned
			// into the cache as authoritative (keeps the short retry interval).
			expect(empty.stale).toBe(false);
			expect(fetches).toBe(1);

			const db = new Database(dbPath, { readonly: true });
			const row = db
				.query<{ authoritative: number }, [string]>("SELECT authoritative FROM model_cache WHERE provider_id = ?")
				.get(options.providerId);
			db.close();
			expect(row?.authoritative).toBe(0);

			discoveredModels = [recoveredModel];
			currentTime += 5 * 60 * 1_000 - 1;
			const beforeRetry = await resolveProviderModels(options, "online-if-uncached");
			expect(beforeRetry.models).toEqual([]);
			expect(fetches).toBe(1);

			currentTime++;
			const recovered = await resolveProviderModels(options, "online-if-uncached");
			expect(recovered.models.map(model => model.id)).toEqual([recoveredModel.id]);
			expect(recovered.stale).toBe(false);
			expect(fetches).toBe(2);

			currentTime++;
			const cached = await resolveProviderModels(options, "online-if-uncached");
			expect(cached.models.map(model => model.id)).toEqual([recoveredModel.id]);
			expect(cached.stale).toBe(false);
			expect(fetches).toBe(2);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
	it("reports an authoritative catalog emptying as non-stale so removed models prune", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-empty-transition-"));
		const dbPath = path.join(tempDir, "models.db");
		const model = completionsSpec({ id: "going-away", provider: "empty-transition-test" });
		let discoveredModels: readonly ModelSpec<"openai-completions">[] = [model];
		const options = {
			providerId: "empty-transition-test",
			staticModels: [],
			dynamicModelsAuthoritative: true,
			cacheDbPath: dbPath,
			fetchDynamicModels: async () => discoveredModels,
		};
		try {
			const populated = await resolveProviderModels(options, "online");
			expect(populated.models.map(candidate => candidate.id)).toEqual([model.id]);
			expect(populated.stale).toBe(false);

			discoveredModels = [];
			const emptied = await resolveProviderModels(options, "online");
			expect(emptied.models).toEqual([]);
			// The successful empty fetch must stay authoritative so ModelRegistry
			// prunes the removed model instead of leaving it selectable forever.
			expect(emptied.stale).toBe(false);

			const db = new Database(dbPath, { readonly: true });
			const row = db
				.query<{ authoritative: number }, [string]>("SELECT authoritative FROM model_cache WHERE provider_id = ?")
				.get(options.providerId);
			db.close();
			expect(row?.authoritative).toBe(0);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
	it("restores static model headers on fresh cache reads", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-static-headers-"));
		const dbPath = path.join(tempDir, "models.db");
		const staticModel = completionsSpec({
			id: "header-static-model",
			provider: "header-cache-test",
			headers: { "X-Project-Id": "project-42" },
		});
		let fetches = 0;
		const options = {
			providerId: "header-cache-test",
			staticModels: [staticModel],
			cacheDbPath: dbPath,
			fetchDynamicModels: async () => {
				fetches++;
				return [];
			},
		};
		try {
			const online = await resolveProviderModels(options, "online");
			expect(online.models[0]?.headers).toEqual({ "X-Project-Id": "project-42" });
			expect(fetches).toBe(1);

			const offline = await resolveProviderModels(options, "offline");
			expect(offline.models[0]?.headers).toEqual({ "X-Project-Id": "project-42" });
			expect(fetches).toBe(1);

			const fresh = await resolveProviderModels(options, "online-if-uncached");
			expect(fresh.models[0]?.headers).toEqual({ "X-Project-Id": "project-42" });
			expect(fetches).toBe(1);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("refetches dynamic-only models whose headers cannot be restored", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-dynamic-headers-"));
		const dbPath = path.join(tempDir, "models.db");
		const dynamicModel = completionsSpec({
			id: "header-dynamic-model",
			provider: "header-cache-test",
			headers: { "X-Required-Route": "route-42" },
		});
		let fetches = 0;
		const options = {
			providerId: "header-cache-test",
			staticModels: [],
			dynamicModelsAuthoritative: true,
			cacheDbPath: dbPath,
			fetchDynamicModels: async () => {
				fetches++;
				return [dynamicModel];
			},
		};
		try {
			const online = await resolveProviderModels(options, "online");
			expect(online.models[0]?.headers).toEqual({ "X-Required-Route": "route-42" });
			expect(fetches).toBe(1);

			const fresh = await resolveProviderModels(options, "online-if-uncached");
			expect(fresh.models[0]?.headers).toEqual({ "X-Required-Route": "route-42" });
			expect(fetches).toBe(2);

			const offline = await resolveProviderModels(options, "offline");
			expect(offline.models).toEqual([]);
			expect(offline.stale).toBe(true);
			expect(fetches).toBe(2);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps a synthesized request-model variant across an offline restart", async () => {
		// Regression for #6037/#6284: Copilot `-1m` long-context variants are
		// synthesized dynamically with transport headers and a `requestModelId`
		// pointing at a same-provider base. Their headers are omitted from the
		// cache but recoverable from the base's static headers, so they must NOT
		// be flagged unrestorable and dropped on the next offline read.
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-request-model-variant-"));
		const dbPath = path.join(tempDir, "models.db");
		const headers = { "X-GitHub-Api-Version": "2026-06-01" };
		const base = completionsSpec({ id: "sol", provider: "variant-cache-test", headers });
		const variant = completionsSpec({
			id: "sol-1m",
			provider: "variant-cache-test",
			requestModelId: "sol",
			headers,
			contextWindow: 1_000_000,
		});
		const options = {
			providerId: "variant-cache-test",
			staticModels: [base],
			cacheDbPath: dbPath,
		};
		try {
			const online = await resolveProviderModels<"openai-completions">(
				{ ...options, fetchDynamicModels: async () => [base, variant] },
				"online",
			);
			expect(online.models.find(candidate => candidate.id === "sol-1m")).toBeDefined();

			const offline = await resolveProviderModels<"openai-completions">(
				{ ...options, fetchDynamicModels: async () => null },
				"offline",
			);
			const restored = offline.models.find(candidate => candidate.id === "sol-1m");
			expect(restored).toBeDefined();
			expect(restored?.headers).toEqual(headers);
			expect(offline.models.find(candidate => candidate.id === "sol")?.headers).toEqual(headers);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("refetches a current request-model alias whose headers differ from its static base", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-custom-alias-"));
		const dbPath = path.join(tempDir, "models.db");
		const baseHeaders = { "X-Route": "static" };
		const customHeaders = { "X-Route": "tenant-specific" };
		const base = completionsSpec({ id: "base", provider: "alias-cache-test", headers: baseHeaders });
		const aliasSpec = completionsSpec({
			id: "custom-alias",
			provider: "alias-cache-test",
			requestModelId: "base",
			headers: customHeaders,
		});
		const alias = buildModel(aliasSpec);
		let fetches = 0;
		const options = {
			providerId: "alias-cache-test",
			staticModels: [base],
			cacheDbPath: dbPath,
			fetchDynamicModels: async () => {
				fetches++;
				return [aliasSpec];
			},
		};
		try {
			writeModelCache("alias-cache-test", Date.now(), [alias], true, "", dbPath, [buildModel(base)]);

			const refreshed = await resolveProviderModels<"openai-completions">(options, "online-if-uncached");
			expect(fetches).toBe(1);
			expect(refreshed.models.find(candidate => candidate.id === alias.id)?.headers).toEqual(customHeaders);

			const offline = await resolveProviderModels<"openai-completions">(options, "offline");
			expect(offline.models.find(candidate => candidate.id === alias.id)).toBeUndefined();
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});

	it("recovers a legacy stale-marked request-model variant via requestModelId", async () => {
		// Legacy cache rows (written by the old id-only writer) flag `-1m`
		// variants unrestorable because it never matched their base's headers.
		// The restore path must still recover them through `requestModelId`.
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-catalog-legacy-variant-"));
		const dbPath = path.join(tempDir, "models.db");
		const headers = { "X-GitHub-Api-Version": "2026-06-01" };
		const base = completionsSpec({ id: "sol", provider: "variant-cache-test", headers });
		const variant = buildModel(
			completionsSpec({
				id: "sol-1m",
				provider: "variant-cache-test",
				requestModelId: "sol",
				headers,
				contextWindow: 1_000_000,
			}),
		);
		try {
			// Emulate a legacy write: no static header source, so the variant is
			// flagged unrestorable even though its base carries the headers.
			writeModelCache("variant-cache-test", Date.now(), [variant], true, "", dbPath);
			const db = new Database(dbPath);
			db.run("UPDATE model_cache SET header_restore_version = 0 WHERE provider_id = ?", ["variant-cache-test"]);
			db.close();

			const offline = await resolveProviderModels<"openai-completions">(
				{ providerId: "variant-cache-test", staticModels: [base], cacheDbPath: dbPath },
				"offline",
			);
			const restored = offline.models.find(candidate => candidate.id === "sol-1m");
			expect(restored).toBeDefined();
			expect(restored?.headers).toEqual(headers);
		} finally {
			await fs.rm(tempDir, { recursive: true, force: true });
		}
	});
});

describe("isOfficialAnthropicApiUrl", () => {
	it("treats a missing baseUrl as official", () => {
		expect(isOfficialAnthropicApiUrl(undefined)).toBe(true);
	});

	it("accepts the https first-party host", () => {
		expect(isOfficialAnthropicApiUrl("https://api.anthropic.com/v1")).toBe(true);
	});

	it("rejects non-https schemes", () => {
		expect(isOfficialAnthropicApiUrl("http://api.anthropic.com")).toBe(false);
	});

	it("rejects lookalike hostnames", () => {
		expect(isOfficialAnthropicApiUrl("https://api.anthropic.com.evil.com")).toBe(false);
	});
});
