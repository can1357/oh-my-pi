import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import { isOfficialAnthropicApiUrl } from "@pk-nerdsaver-ai/pi-catalog/compat/anthropic";
import { buildOpenAICompat, buildOpenAIResponsesCompat } from "@pk-nerdsaver-ai/pi-catalog/compat/openai";
import { writeModelCache } from "@pk-nerdsaver-ai/pi-catalog/model-cache";
import { resolveProviderModels } from "@pk-nerdsaver-ai/pi-catalog/model-manager";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { openrouterModelManagerOptions } from "@pk-nerdsaver-ai/pi-catalog/provider-models/openai-compat";
import type { ModelSpec } from "@pk-nerdsaver-ai/pi-catalog/types";

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
});

describe("xAI-OAuth Responses reasoning-effort suppression", () => {
	const grokResponsesSpec = (id: string): ModelSpec<"openai-responses"> => ({
		id,
		name: id,
		api: "openai-responses",
		provider: "xai-oauth",
		baseUrl: "https://api.x.ai/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 512_000,
		maxTokens: 512_000,
	});

	it("omits the effort dial for a custom grok-build spec (off the allowlist)", () => {
		const compat = buildOpenAIResponsesCompat(grokResponsesSpec("grok-build"));
		expect(compat.supportsReasoningEffort).toBe(false);
		expect(compat.omitReasoningEffort).toBe(true);
		expect(buildModel(grokResponsesSpec("grok-build")).thinking).toBeUndefined();
	});

	it("keeps the effort dial for a custom grok-4.3 spec (on the allowlist)", () => {
		expect(buildOpenAIResponsesCompat(grokResponsesSpec("grok-4.3")).supportsReasoningEffort).toBe(true);
	});

	it("lets an explicit compat.supportsReasoningEffort override the allowlist default", () => {
		const compat = buildOpenAIResponsesCompat({
			...grokResponsesSpec("grok-build"),
			compat: { supportsReasoningEffort: true },
		});
		expect(compat.supportsReasoningEffort).toBe(true);
	});

	it("does not suppress effort for a non-xai-oauth provider with a grok-like id", () => {
		const compat = buildOpenAIResponsesCompat({
			...grokResponsesSpec("grok-build"),
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
		});
		expect(compat.supportsReasoningEffort).toBe(true);
	});
});

describe("openai-completions wire-quirk compat detection", () => {
	it("derives wireModelIdMode from provider/host", () => {
		expect(buildOpenAICompat(completionsSpec({ provider: "firepass" })).wireModelIdMode).toBe("firepass");
		expect(
			buildOpenAICompat(completionsSpec({ provider: "fireworks", baseUrl: "https://api.fireworks.ai/inference/v1" }))
				.wireModelIdMode,
		).toBe("fireworks");
		// Fireworks "Fast" variants route through the router namespace (like Fire Pass).
		expect(
			buildOpenAICompat(
				completionsSpec({
					provider: "fireworks",
					id: "kimi-k2.6-fast",
					baseUrl: "https://api.fireworks.ai/inference/v1",
				}),
			).wireModelIdMode,
		).toBe("firepass");
		expect(
			buildOpenAICompat(completionsSpec({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }))
				.wireModelIdMode,
		).toBe("openrouter");
		expect(buildOpenAICompat(completionsSpec()).wireModelIdMode).toBe("raw");
	});

	it("strips DeepSeek special tokens only for deepseek ids on nvidia/deepseek providers", () => {
		expect(
			buildOpenAICompat(
				completionsSpec({
					provider: "nvidia",
					id: "deepseek-ai/deepseek-v3.1",
					baseUrl: "https://integrate.api.nvidia.com/v1",
				}),
			).stripDeepseekSpecialTokens,
		).toBe(true);
		expect(
			buildOpenAICompat(
				completionsSpec({ provider: "deepseek", id: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1" }),
			).stripDeepseekSpecialTokens,
		).toBe(true);
		// DeepSeek id behind another host must NOT strip (only nvidia/deepseek hosts emit the raw tokens).
		expect(
			buildOpenAICompat(
				completionsSpec({
					provider: "openrouter",
					id: "deepseek/deepseek-v3.1",
					baseUrl: "https://openrouter.ai/api/v1",
				}),
			).stripDeepseekSpecialTokens,
		).toBe(false);
		// Non-deepseek id on nvidia must NOT strip.
		expect(
			buildOpenAICompat(
				completionsSpec({
					provider: "nvidia",
					id: "meta/llama-3.1",
					baseUrl: "https://integrate.api.nvidia.com/v1",
				}),
			).stripDeepseekSpecialTokens,
		).toBe(false);
	});

	it("requires a synthetic assistant bridge after tool results only for Mistral hosts", () => {
		// Mistral/Devstral reject a user message directly after a tool result; the chat
		// builder bridges it with a synthetic assistant turn, keyed on the Mistral host.
		expect(
			buildOpenAICompat(
				completionsSpec({ provider: "mistral", id: "devstral-latest", baseUrl: "https://api.mistral.ai/v1" }),
			).requiresAssistantAfterToolResult,
		).toBe(true);
		// URL-only match (custom provider fronting Mistral).
		expect(
			buildOpenAICompat(
				completionsSpec({
					provider: "custom",
					id: "mistral-large",
					baseUrl: "https://proxy.example/mistral.ai/v1",
				}),
			).requiresAssistantAfterToolResult,
		).toBe(true);
		// Non-Mistral hosts must not insert the bridge.
		expect(buildOpenAICompat(completionsSpec()).requiresAssistantAfterToolResult).toBe(false);
		expect(
			buildOpenAICompat(completionsSpec({ provider: "openai", id: "gpt-5", baseUrl: "https://api.openai.com/v1" }))
				.requiresAssistantAfterToolResult,
		).toBe(false);
	});

	it("flags cumulative reasoning deltas for MiniMax provider or id", () => {
		expect(buildOpenAICompat(completionsSpec({ provider: "minimax" })).reasoningDeltasMayBeCumulative).toBe(true);
		expect(buildOpenAICompat(completionsSpec({ id: "MiniMax-M2" })).reasoningDeltasMayBeCumulative).toBe(true);
		expect(buildOpenAICompat(completionsSpec()).reasoningDeltasMayBeCumulative).toBe(false);
	});

	it("maps the remaining provider-keyed wire quirks", () => {
		expect(buildOpenAICompat(completionsSpec({ provider: "ollama" })).emptyLengthFinishIsContextError).toBe(true);
		expect(buildOpenAICompat(completionsSpec()).emptyLengthFinishIsContextError).toBe(false);
		expect(
			buildOpenAICompat(completionsSpec({ provider: "openai", baseUrl: "https://api.openai.com/v1" }))
				.usesOpenAIToolCallIdLimit,
		).toBe(true);
		expect(buildOpenAICompat(completionsSpec()).usesOpenAIToolCallIdLimit).toBe(false);
		expect(
			buildOpenAICompat(completionsSpec({ provider: "fireworks", baseUrl: "https://api.fireworks.ai/inference/v1" }))
				.dropThinkingWhenReasoningEffort,
		).toBe(true);
		expect(buildOpenAICompat(completionsSpec()).dropThinkingWhenReasoningEffort).toBe(false);
	});

	it("derives Responses obfuscation opt-out and wire mode per surface", () => {
		expect(
			buildOpenAIResponsesCompat({
				id: "gpt-5",
				provider: "openai",
				name: "GPT 5",
				baseUrl: "https://api.openai.com/v1",
			}).supportsObfuscationOptOut,
		).toBe(true);
		// Azure mirrors the schema but is NOT the OpenAI host: no obfuscation opt-out.
		expect(
			buildOpenAIResponsesCompat({ id: "gpt-5", provider: "azure", name: "gpt-5", baseUrl: "" })
				.supportsObfuscationOptOut,
		).toBe(false);
		const openrouterResponses = buildOpenAIResponsesCompat({
			id: "anthropic/claude-sonnet-4",
			provider: "openrouter",
			name: "Claude Sonnet 4",
			baseUrl: "https://openrouter.ai/api/v1",
		});
		expect(openrouterResponses.supportsObfuscationOptOut).toBe(false);
		expect(openrouterResponses.wireModelIdMode).toBe("openrouter");
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
