import { describe, expect, test } from "bun:test";
import { type Api, Effort, type Model, type ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { DEFAULT_MODEL_PER_PROVIDER } from "@oh-my-pi/pi-catalog/provider-models";
import {
	expandRoleAlias,
	extractExplicitThinkingSelector,
	filterAvailableModelsByEnabledPatterns,
	parseModelPattern,
	parseModelString,
	pickDefaultAvailableModel,
	resolveAgentAdvisorSelection,
	resolveAgentModelPatterns,
	resolveAgentModelSelection,
	resolveAgentPrewalkPattern,
	resolveAllowedModels,
	resolveCliModel,
	resolveExplicitModelRole,
	resolveModelFromString,
	resolveModelOverride,
	resolveModelRoleValue,
	resolveModelScope,
	resolveProviderModelReference,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { DEFAULT_MODEL_ROLE_ALIAS, LEGACY_MODEL_ROLE_ALIAS_PREFIX } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

// Mock models for testing
const mockModels: Model<"anthropic-messages">[] = [
	buildModel({
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet 4.5",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		thinking: {
			mode: "budget",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		},
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200000,
		maxTokens: 8192,
	}),
	buildModel({
		id: "gpt-4o",
		name: "GPT-4o",
		api: "anthropic-messages", // Using same type for simplicity
		provider: "openai",
		baseUrl: "https://api.openai.com",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
		contextWindow: 128000,
		maxTokens: 4096,
	}),
];

// Mock OpenRouter models with colons in IDs
const mockOpenRouterModels: Model<Api>[] = [
	buildModel({
		id: "qwen/qwen3-coder:exacto",
		name: "Qwen3 Coder Exacto",
		api: "anthropic-messages",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		thinking: {
			mode: "budget",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		},
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
		contextWindow: 128000,
		maxTokens: 8192,
	}),
	buildModel({
		id: "openai/gpt-4o:extended",
		name: "GPT-4o Extended",
		api: "anthropic-messages",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
		contextWindow: 128000,
		maxTokens: 4096,
	}),
	buildModel({
		id: "z-ai/glm-4.7",
		name: "GLM 4.7",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		thinking: {
			mode: "budget",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		},
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
		contextWindow: 128000,
		maxTokens: 8192,
	}),
	buildModel({
		id: "deepseek/deepseek-v4-pro",
		name: "DeepSeek V4 Pro",
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
		contextWindow: 128000,
		maxTokens: 8192,
	}),
];

const mockMaxSuffixModels: Model<Api>[] = [
	buildModel({
		id: "coding-router",
		name: "NanoGPT Coding Router",
		api: "openai-completions",
		provider: "nanogpt",
		baseUrl: "https://nano-gpt.com/api/v1",
		reasoning: true,
		thinking: {
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		},
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	}),
	buildModel({
		id: "coding-router:max",
		name: "NanoGPT Coding Router Max",
		api: "openai-completions",
		provider: "nanogpt",
		baseUrl: "https://nano-gpt.com/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	}),
	buildModel({
		id: "coding-router:low",
		name: "NanoGPT Coding Router Low",
		api: "openai-completions",
		provider: "nanogpt",
		baseUrl: "https://nano-gpt.com/api/v1",
		reasoning: true,
		thinking: {
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		},
		input: ["text"],
		cost: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	}),
];

// Sibling models where one id is a prefix of the other AND the longer id embeds
// a thinking-tier token (`-highspeed` contains `high`). Regression fixture for
// the fuzzy match swallowing a `:high` thinking suffix into the longer id.
const mockThinkingSuffixSiblingModels: Model<"openai-completions">[] = [
	buildModel({
		id: "kimi-for-coding",
		name: "K2.7 Code",
		api: "openai-completions",
		provider: "kimi-code",
		baseUrl: "https://api.kimi.com/coding/v1",
		reasoning: true,
		thinking: { mode: "effort", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 32000,
	}),
	buildModel({
		id: "kimi-for-coding-highspeed",
		name: "K2.7 Code Highspeed",
		api: "openai-completions",
		provider: "kimi-code",
		baseUrl: "https://api.kimi.com/coding/v1",
		reasoning: true,
		thinking: { mode: "effort", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 32000,
	}),
];

const mockAutoSuffixModels: Model<Api>[] = [
	buildModel({
		id: "runtime:auto",
		name: "Runtime Auto",
		api: "openai-completions",
		provider: "example",
		baseUrl: "https://example.com/api",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	}),
];

const mockProviderOverlapModels: Model<"anthropic-messages">[] = [
	buildModel({
		id: "kimi-k2.5",
		name: "Kimi K2.5",
		api: "anthropic-messages",
		provider: "kimi-code",
		baseUrl: "https://api.kimi.ai",
		reasoning: false,
		input: ["text"],
		cost: { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 2 },
		contextWindow: 128000,
		maxTokens: 8192,
	}),
	buildModel({
		id: "moonshotai/kimi-k2.5",
		name: "Kimi K2.5 (OpenRouter)",
		api: "anthropic-messages",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 2.2, output: 6.2, cacheRead: 0.22, cacheWrite: 2.2 },
		contextWindow: 128000,
		maxTokens: 8192,
	}),
];

const mockCodexOverlapModels: Model<"anthropic-messages">[] = [
	buildModel({
		id: "gpt-5.3-codex",
		name: "GPT-5.3 Codex",
		api: "anthropic-messages",
		provider: "openai-codex",
		baseUrl: "https://api.openai.com",
		reasoning: true,
		thinking: {
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		},
		input: ["text"],
		cost: { input: 1.5, output: 6, cacheRead: 0.15, cacheWrite: 1.5 },
		contextWindow: 200000,
		maxTokens: 8192,
	}),
	buildModel({
		id: "gpt-5.3-codex-spark",
		name: "GPT-5.3 Codex Spark",
		api: "anthropic-messages",
		provider: "openai-codex",
		baseUrl: "https://api.openai.com",
		reasoning: true,
		thinking: {
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		},
		input: ["text"],
		cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 },
		contextWindow: 200000,
		maxTokens: 8192,
	}),
];

const mockMaxCapableModels: Model<"anthropic-messages">[] = [
	buildModel({
		id: "claude-opus-4-7",
		name: "Claude Opus 4.7",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		thinking: {
			mode: "anthropic-adaptive",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
		},
		input: ["text", "image"],
		cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
		contextWindow: 200000,
		maxTokens: 32000,
	}),
];

const openaiGpt55Models: Model<Api>[] = [
	buildModel({
		id: "gpt-5.5",
		name: "GPT-5.5",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://api.openai.com",
		reasoning: true,
		thinking: {
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		},
		input: ["text"],
		cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 },
		contextWindow: 400000,
		maxTokens: 128000,
	}),
	buildModel({
		id: "gpt-5.5",
		name: "GPT-5.5 Codex",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api/codex/responses",
		reasoning: true,
		thinking: {
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		},
		input: ["text"],
		cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 },
		contextWindow: 400000,
		maxTokens: 128000,
	}),
];

function createBedrockDefaultModel(
	overrides?: Partial<ModelSpec<"bedrock-converse-stream">>,
): Model<"bedrock-converse-stream"> {
	return buildModel({
		id: "us.anthropic.claude-opus-4-8",
		name: "Claude Opus 4.8 (US)",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1000000,
		maxTokens: 128000,
		...overrides,
	});
}

function createOpusModel(provider: string, id: string, name: string): Model<"anthropic-messages"> {
	return buildModel({
		id,
		name,
		api: "anthropic-messages",
		provider,
		baseUrl: provider === "anthropic" ? "https://api.anthropic.com" : "https://api.githubcopilot.com",
		reasoning: true,
		thinking: {
			mode: "budget",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		},
		input: ["text", "image"],
		cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
		contextWindow: 200000,
		maxTokens: 32000,
	});
}

const allModels = [...mockModels, ...mockOpenRouterModels, ...mockProviderOverlapModels, ...mockCodexOverlapModels];

describe("pickDefaultAvailableModel", () => {
	test("prefers Codex OAuth over plain OpenAI for the shared GPT default", () => {
		const result = pickDefaultAvailableModel(openaiGpt55Models);

		expect(result?.provider).toBe("openai-codex");
		expect(result?.id).toBe("gpt-5.5");
	});

	test("keeps earlier unrelated provider defaults ahead of shared Codex defaults", () => {
		const anthropicDefault = buildModel({
			id: DEFAULT_MODEL_PER_PROVIDER.anthropic,
			name: "Anthropic Default",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			thinking: {
				mode: "budget",
				efforts: [Effort.Low, Effort.Medium, Effort.High],
			},
			input: ["text"],
			cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 200000,
			maxTokens: 8192,
		});

		const result = pickDefaultAvailableModel([anthropicDefault, ...openaiGpt55Models]);

		expect(result?.provider).toBe("anthropic");
		expect(result?.id).toBe(DEFAULT_MODEL_PER_PROVIDER.anthropic);
	});

	test("uses the Zhipu Coding Plan login-validated model before newer z.ai defaults", () => {
		const zhipuGlm51 = buildModel({
			id: "glm-5.1",
			name: "GLM-5.1",
			api: "openai-completions",
			provider: "zhipu-coding-plan",
			baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 131072,
		});
		const zhipuGlm52 = buildModel({
			id: "glm-5.2",
			name: "GLM-5.2",
			api: "openai-completions",
			provider: "zhipu-coding-plan",
			baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 131072,
		});
		const zaiGlm52 = buildModel({
			id: "glm-5.2",
			name: "GLM-5.2",
			api: "anthropic-messages",
			provider: "zai",
			baseUrl: "https://api.z.ai/api/anthropic",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000000,
			maxTokens: 131072,
		});

		const result = pickDefaultAvailableModel([zhipuGlm51, zhipuGlm52, zaiGlm52]);

		expect(result?.provider).toBe("zhipu-coding-plan");
		expect(result?.id).toBe("glm-5.1");
	});

	test("prefers SuperGrok over paid xAI when both defaults are present", () => {
		const paid = getBundledModel("xai", DEFAULT_MODEL_PER_PROVIDER.xai);
		const oauth = getBundledModel("xai-oauth", DEFAULT_MODEL_PER_PROVIDER["xai-oauth"]);
		if (!paid || !oauth) {
			throw new Error("Expected bundled xAI provider defaults");
		}

		expect(pickDefaultAvailableModel([paid, oauth])?.provider).toBe("xai-oauth");
		expect(pickDefaultAvailableModel([paid])?.provider).toBe("xai");
	});

	test("prefers a concretely-authed provider over a sentinel-only ambient provider (issue #9967)", () => {
		const bedrockDefault = createBedrockDefaultModel();
		const anthropicDefault = createOpusModel("anthropic", DEFAULT_MODEL_PER_PROVIDER.anthropic, "Claude Opus");
		// amazon-bedrock leads in catalog/availability order, exactly as
		// `getAvailable()` returns it when a stray ~/.aws profile makes Bedrock
		// ambiently "available" alongside a real Anthropic OAuth login.
		const models = [bedrockDefault, anthropicDefault];

		// Without the credential hint the ambient provider still wins by order —
		// this is the reported bug (403 on the first turn).
		expect(pickDefaultAvailableModel(models)?.provider).toBe("amazon-bedrock");

		// With the hint, the provider the user actually signed into wins.
		const picked = pickDefaultAvailableModel(models, provider => provider === "anthropic");
		expect(picked?.provider).toBe("anthropic");
		expect(picked?.id).toBe(DEFAULT_MODEL_PER_PROVIDER.anthropic);
	});

	test("keeps a sentinel-only provider when it is the only credentialed option", () => {
		const bedrockDefault = createBedrockDefaultModel();
		const picked = pickDefaultAvailableModel([bedrockDefault], () => false);
		expect(picked?.provider).toBe("amazon-bedrock");
		expect(picked?.id).toBe(DEFAULT_MODEL_PER_PROVIDER["amazon-bedrock"]);
	});

	test("checks concrete auth once per provider", () => {
		const bedrockDefault = createBedrockDefaultModel();
		const secondBedrockModel = createBedrockDefaultModel({ id: "us.anthropic.claude-sonnet-4-6" });
		const anthropicDefault = createOpusModel("anthropic", DEFAULT_MODEL_PER_PROVIDER.anthropic, "Claude Opus");
		const checkedProviders: string[] = [];

		const picked = pickDefaultAvailableModel([bedrockDefault, secondBedrockModel, anthropicDefault], provider => {
			checkedProviders.push(provider);
			return provider === "anthropic";
		});

		expect(picked?.provider).toBe("anthropic");
		expect(checkedProviders).toEqual(["amazon-bedrock", "anthropic"]);
	});
});

describe("parseModelPattern", () => {
	describe("simple patterns without colons", () => {
		test("exact match returns model with undefined thinking level", () => {
			const result = parseModelPattern("claude-sonnet-4-5", allModels);
			expect(result.model?.id).toBe("claude-sonnet-4-5");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.explicitThinkingLevel).toBe(false);
			expect(result.warning).toBeUndefined();
		});

		test("partial match returns best model with undefined thinking level", () => {
			const result = parseModelPattern("sonnet", allModels);
			expect(result.model?.id).toBe("claude-sonnet-4-5");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.explicitThinkingLevel).toBe(false);
			expect(result.warning).toBeUndefined();
		});

		test("no match returns undefined model and thinking level", () => {
			const result = parseModelPattern("nonexistent", allModels);
			expect(result.model).toBeUndefined();
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.explicitThinkingLevel).toBe(false);
			expect(result.warning).toBeUndefined();
		});
	});

	describe("patterns with valid thinking levels", () => {
		test("sonnet:high returns sonnet with high thinking level", () => {
			const result = parseModelPattern("sonnet:high", allModels);
			expect(result.model?.id).toBe("claude-sonnet-4-5");
			expect(result.thinkingLevel).toBe(Effort.High);
			expect(result.warning).toBeUndefined();
		});

		test("gpt-4o:medium returns gpt-4o with medium thinking level", () => {
			const result = parseModelPattern("gpt-4o:medium", allModels);
			expect(result.model?.id).toBe("gpt-4o");
			expect(result.thinkingLevel).toBe(Effort.Medium);
			expect(result.warning).toBeUndefined();
		});

		test("all valid thinking levels work", () => {
			const levels = [
				"off",
				Effort.Minimal,
				Effort.Low,
				Effort.Medium,
				Effort.High,
				Effort.XHigh,
				Effort.Max,
			] as const;
			for (const level of levels) {
				const result = parseModelPattern(`sonnet:${level}`, allModels);
				expect(result.model?.id).toBe("claude-sonnet-4-5");
				expect(result.thinkingLevel).toBe(level);
				expect(result.warning).toBeUndefined();
			}
		});
		test("max parses as a real thinking level after the literal pattern misses", () => {
			const result = parseModelPattern("gpt-5.3-codex:max", allModels);
			expect(result.model?.id).toBe("gpt-5.3-codex");
			expect(result.thinkingLevel).toBe(Effort.Max);
			expect(result.explicitThinkingLevel).toBe(true);
			expect(result.warning).toBeUndefined();
		});

		test("literal model ids ending in max win over the thinking suffix", () => {
			const result = parseModelPattern("nanogpt/coding-router:max", mockMaxSuffixModels);
			expect(result.model?.id).toBe("coding-router:max");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.explicitThinkingLevel).toBe(false);
			expect(result.warning).toBeUndefined();
		});

		test("fuzzy selectors preserve literal models ending in a thinking-level suffix", () => {
			const result = parseModelPattern("router:low", mockMaxSuffixModels);
			expect(result.model?.id).toBe("coding-router:low");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.explicitThinkingLevel).toBe(false);
		});

		test("literal model ids ending in auto win over the auto sentinel alias", () => {
			const result = parseModelPattern("example/runtime:auto", mockAutoSuffixModels);
			expect(result.model?.id).toBe("runtime:auto");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.explicitThinkingLevel).toBe(false);
			expect(result.warning).toBeUndefined();
		});

		test("thinking suffix is stripped before fuzzy match, never absorbed into a longer sibling id", () => {
			// `kimi-for-coding:high` must resolve to the standard model at high effort,
			// not fuzzy-match `kimi-for-coding-highspeed` (issue #5151).
			const result = parseModelPattern("kimi-code/kimi-for-coding:high", mockThinkingSuffixSiblingModels);
			expect(result.model?.id).toBe("kimi-for-coding");
			expect(result.thinkingLevel).toBe(Effort.High);
			expect(result.explicitThinkingLevel).toBe(true);
			expect(result.warning).toBeUndefined();
		});

		test("bare id thinking suffix is stripped before fuzzy match against a longer sibling", () => {
			const result = parseModelPattern("kimi-for-coding:high", mockThinkingSuffixSiblingModels);
			expect(result.model?.id).toBe("kimi-for-coding");
			expect(result.thinkingLevel).toBe(Effort.High);
			expect(result.explicitThinkingLevel).toBe(true);
		});

		test("the longer sibling still resolves exactly with its own thinking suffix", () => {
			const result = parseModelPattern("kimi-code/kimi-for-coding-highspeed:high", mockThinkingSuffixSiblingModels);
			expect(result.model?.id).toBe("kimi-for-coding-highspeed");
			expect(result.thinkingLevel).toBe(Effort.High);
			expect(result.explicitThinkingLevel).toBe(true);
		});
	});

	describe("patterns with invalid thinking levels", () => {
		test("sonnet:random returns sonnet with undefined thinking level and warning", () => {
			const result = parseModelPattern("sonnet:random", allModels);
			expect(result.model?.id).toBe("claude-sonnet-4-5");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.explicitThinkingLevel).toBe(false);
			expect(result.warning).toContain("Invalid thinking level");
			expect(result.warning).toContain("random");
		});

		test("gpt-4o:invalid returns gpt-4o with undefined thinking level and warning", () => {
			const result = parseModelPattern("gpt-4o:invalid", allModels);
			expect(result.model?.id).toBe("gpt-4o");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.explicitThinkingLevel).toBe(false);
			expect(result.warning).toContain("Invalid thinking level");
		});
	});

	describe("OpenRouter models with colons in IDs", () => {
		test("qwen3-coder:exacto matches the model with undefined thinking level", () => {
			const result = parseModelPattern("qwen/qwen3-coder:exacto", allModels);
			expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.explicitThinkingLevel).toBe(false);
			expect(result.warning).toBeUndefined();
		});

		test("openrouter/qwen/qwen3-coder:exacto matches with provider prefix", () => {
			const result = parseModelPattern("openrouter/qwen/qwen3-coder:exacto", allModels);
			expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
			expect(result.model?.provider).toBe("openrouter");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.explicitThinkingLevel).toBe(false);
			expect(result.warning).toBeUndefined();
		});

		test("qwen3-coder:exacto:high matches model with high thinking level", () => {
			const result = parseModelPattern("qwen/qwen3-coder:exacto:high", allModels);
			expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
			expect(result.thinkingLevel).toBe(Effort.High);
			expect(result.explicitThinkingLevel).toBe(true);
			expect(result.warning).toBeUndefined();
		});

		test("openrouter/qwen/qwen3-coder:exacto:high matches with provider and thinking level", () => {
			const result = parseModelPattern("openrouter/qwen/qwen3-coder:exacto:high", allModels);
			expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
			expect(result.model?.provider).toBe("openrouter");
			expect(result.thinkingLevel).toBe(Effort.High);
			expect(result.explicitThinkingLevel).toBe(true);
			expect(result.warning).toBeUndefined();
		});

		test("gpt-4o:extended matches the extended model with undefined thinking level", () => {
			const result = parseModelPattern("openai/gpt-4o:extended", allModels);
			expect(result.model?.id).toBe("openai/gpt-4o:extended");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.explicitThinkingLevel).toBe(false);
			expect(result.warning).toBeUndefined();
		});

		test("supports OpenRouter route suffixes that are not present in the catalog", () => {
			const result = parseModelPattern("openrouter/z-ai/glm-4.7-20251222:nitro", allModels);
			expect(result.model?.provider).toBe("openrouter");
			expect(result.model?.id).toBe("z-ai/glm-4.7-20251222:nitro");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.explicitThinkingLevel).toBe(false);
			expect(result.warning).toBeUndefined();
		});

		test("supports OpenRouter route suffixes with an appended thinking level", () => {
			const result = parseModelPattern("openrouter/z-ai/glm-4.7-20251222:nitro:high", allModels);
			expect(result.model?.provider).toBe("openrouter");
			expect(result.model?.id).toBe("z-ai/glm-4.7-20251222:nitro");
			expect(result.thinkingLevel).toBe(Effort.High);
			expect(result.explicitThinkingLevel).toBe(true);
			expect(result.warning).toBeUndefined();
		});

		test("openrouter/<id>:max applies max through the exact-selector path, not an OpenRouter route", () => {
			// `max` is a thinking-level suffix, never an OpenRouter route suffix: the request
			// must resolve the base model and carry max, not clone a literal `z-ai/glm-4.7:max`.
			const result = parseModelPattern("openrouter/z-ai/glm-4.7:max", allModels);
			expect(result.model?.provider).toBe("openrouter");
			expect(result.model?.id).toBe("z-ai/glm-4.7");
			expect(result.thinkingLevel).toBe(Effort.Max);
			expect(result.explicitThinkingLevel).toBe(true);
		});
	});

	describe("invalid thinking levels with OpenRouter models", () => {
		test("qwen3-coder:exacto:random returns model with undefined thinking level and warning", () => {
			const result = parseModelPattern("qwen/qwen3-coder:exacto:random", allModels);
			expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.explicitThinkingLevel).toBe(false);
			expect(result.warning).toContain("Invalid thinking level");
			expect(result.warning).toContain("random");
		});

		test("qwen3-coder:exacto:high:random returns model with undefined thinking level and warning", () => {
			const result = parseModelPattern("qwen/qwen3-coder:exacto:high:random", allModels);
			expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.explicitThinkingLevel).toBe(false);
			expect(result.warning).toContain("Invalid thinking level");
			expect(result.warning).toContain("random");
		});
	});

	describe("provider-qualified selectors vs aggregator raw-id shadowing", () => {
		const anthropicOpus5 = createOpusModel("anthropic", "claude-opus-5", "Claude Opus 5");
		const openRouterOpus5 = buildModel({
			id: "anthropic/claude-opus-5",
			name: "Claude Opus 5 (OpenRouter)",
			api: "anthropic-messages",
			provider: "openrouter",
			baseUrl: "https://openrouter.ai/api/v1",
			reasoning: true,
			thinking: {
				mode: "budget",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			},
			input: ["text", "image"],
			cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
			contextWindow: 200000,
			maxTokens: 32000,
		});

		test("anthropic/claude-opus-5 does not shadow onto the OpenRouter flat id when anthropic is unavailable", () => {
			// Anthropic carries claude-opus-5 in the bundled catalog but is absent from
			// the candidate set (disabled provider, missing creds at boot): the selector
			// is provider-qualified and must fail rather than re-bind to OpenRouter.
			const result = parseModelPattern("anthropic/claude-opus-5", [openRouterOpus5]);
			expect(result.model).toBeUndefined();
		});

		test("the provider lock is case-insensitive (Anthropic/Claude-Opus-5 still fails closed)", () => {
			// The matcher compares ids case-insensitively, so the lock must too —
			// otherwise case variance silently re-enables the aggregator shadow.
			const result = parseModelPattern("Anthropic/Claude-Opus-5", [openRouterOpus5]);
			expect(result.model).toBeUndefined();
		});

		test("anthropic/claude-opus-5 resolves to the anthropic provider when it is available", () => {
			const result = parseModelPattern("anthropic/claude-opus-5", [anthropicOpus5, openRouterOpus5]);
			expect(result.model?.provider).toBe("anthropic");
			expect(result.model?.id).toBe("claude-opus-5");
		});

		test("explicit openrouter/anthropic/claude-opus-5 still selects the OpenRouter model", () => {
			const result = parseModelPattern("openrouter/anthropic/claude-opus-5", [openRouterOpus5]);
			expect(result.model?.provider).toBe("openrouter");
			expect(result.model?.id).toBe("anthropic/claude-opus-5");
		});

		test("resolveModelFromString keeps the provider lock when anthropic is absent", () => {
			const result = resolveModelFromString("anthropic/claude-opus-5", [openRouterOpus5]);
			expect(result).toBeUndefined();
		});

		test("resolveCliModel keeps the provider lock when anthropic is absent", () => {
			const result = resolveCliModel({
				cliModel: "anthropic/claude-opus-5",
				modelRegistry: {
					getAll: () => [openRouterOpus5],
					getAvailable: () => [],
				},
			});
			expect(result.model).toBeUndefined();
			expect(result.error).toBeTruthy();
		});

		test("openai/gpt-4o:extended still resolves to the OpenRouter raw id (openai carries no such id)", () => {
			const result = parseModelPattern("openai/gpt-4o:extended", allModels);
			expect(result.model?.provider).toBe("openrouter");
			expect(result.model?.id).toBe("openai/gpt-4o:extended");
		});
	});

	describe("edge cases", () => {
		test("empty pattern matches via partial matching", () => {
			// Empty string is included in all model IDs, so partial matching finds a match
			const result = parseModelPattern("", allModels);
			expect(result.model).not.toBeNull();
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.explicitThinkingLevel).toBe(false);
		});

		test("pattern ending with colon treats empty suffix as invalid", () => {
			const result = parseModelPattern("sonnet:", allModels);
			// Empty string after colon is not a valid thinking level
			// So it tries to match "sonnet:" which won't match, then tries "sonnet"
			expect(result.model?.id).toBe("claude-sonnet-4-5");
			expect(result.warning).toContain("Invalid thinking level");
		});
	});

	describe("preference logic", () => {
		test("prefers most recently used model when multiple providers match", () => {
			const result = parseModelPattern("k2.5", allModels, {
				usageOrder: ["kimi-code/kimi-k2.5"],
			});
			expect(result.model?.provider).toBe("kimi-code");
		});

		test("prefers first-party providers over OpenRouter when no usage data exists", () => {
			const result = parseModelPattern("k2.5", allModels, { usageOrder: [] });
			expect(result.model?.provider).toBe("kimi-code");
		});

		test("respects most recently used provider even if openrouter", () => {
			const result = parseModelPattern("k2.5", allModels, {
				usageOrder: ["openrouter/moonshotai/kimi-k2.5"],
			});
			expect(result.model?.provider).toBe("openrouter");
			expect(result.model?.id).toBe("moonshotai/kimi-k2.5");
		});
	});
});

describe("resolveModelRoleValue", () => {
	test("resolves @role:<thinking> by expanding role alias before parsing thinking", () => {
		const settings = {
			getModelRole: (role: string) => (role === "smol" ? "openrouter/qwen/qwen3-coder:exacto" : undefined),
		} as NonNullable<Parameters<typeof resolveModelRoleValue>[2]>["settings"];

		const result = resolveModelRoleValue("@smol:high", allModels, { settings });

		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
		expect(result.thinkingLevel).toBe(Effort.High);
		expect(result.explicitThinkingLevel).toBe(true);
	});

	test("resolves @role:max by expanding role alias before parsing thinking", () => {
		const settings = {
			getModelRole: (role: string) => (role === "smol" ? "openai-codex/gpt-5.3-codex" : undefined),
		} as NonNullable<Parameters<typeof resolveModelRoleValue>[2]>["settings"];

		const result = resolveModelRoleValue("@smol:max", allModels, { settings });

		expect(result.model?.provider).toBe("openai-codex");
		expect(result.model?.id).toBe("gpt-5.3-codex");
		// Role-value resolution clamps: gpt-5.3-codex's ladder tops out at xhigh.
		expect(result.thinkingLevel).toBe(Effort.XHigh);
		expect(result.explicitThinkingLevel).toBe(true);
	});

	test("resolves @default through configured default role alias", () => {
		const settings = {
			getModelRole: (role: string) => (role === "default" ? "openrouter/qwen/qwen3-coder:exacto" : undefined),
		} as NonNullable<Parameters<typeof resolveModelRoleValue>[2]>["settings"];

		const result = resolveModelRoleValue("@default", allModels, { settings });

		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
		expect(result.thinkingLevel).toBeUndefined();
		expect(result.explicitThinkingLevel).toBe(false);
		expect(result.warning).toBeUndefined();
	});

	test("splits direct comma fallback chains before parsing thinking selectors", () => {
		const result = resolveModelRoleValue("anthropic/claude-sonnet-4-5:off,openai/gpt-4o:off", allModels);

		expect(result.model?.provider).toBe("anthropic");
		expect(result.model?.id).toBe("claude-sonnet-4-5");
		expect(result.thinkingLevel).toBe("off");
		expect(result.explicitThinkingLevel).toBe(true);
		expect(result.warning).toBeUndefined();
	});

	test("tries later direct comma fallback entries when earlier entries miss", () => {
		const result = resolveModelRoleValue("anthropic/missing:off,openai/gpt-4o:off", allModels);

		expect(result.model?.provider).toBe("openai");
		expect(result.model?.id).toBe("gpt-4o");
		expect(result.thinkingLevel).toBe("off");
		expect(result.explicitThinkingLevel).toBe(true);
		expect(result.warning).toBeUndefined();
	});

	test("does not resolve exact codex role values to codex-spark via substring matching", () => {
		const providerQualified = resolveModelRoleValue("openai-codex/gpt-5.3-codex:xhigh", allModels);
		expect(providerQualified.model?.provider).toBe("openai-codex");
		expect(providerQualified.model?.id).toBe("gpt-5.3-codex");
		expect(providerQualified.thinkingLevel).toBe(Effort.XHigh);
		expect(providerQualified.explicitThinkingLevel).toBe(true);

		const idOnly = resolveModelRoleValue("gpt-5.3-codex:xhigh", allModels);
		expect(idOnly.model?.provider).toBe("openai-codex");
		expect(idOnly.model?.id).toBe("gpt-5.3-codex");
		expect(idOnly.thinkingLevel).toBe(Effort.XHigh);
		expect(idOnly.explicitThinkingLevel).toBe(true);
	});

	test("clamps explicit thinking selectors from model metadata", () => {
		const result = resolveModelRoleValue("anthropic/claude-sonnet-4-5:xhigh", allModels);

		expect(result.model?.provider).toBe("anthropic");
		expect(result.model?.id).toBe("claude-sonnet-4-5");
		expect(result.thinkingLevel).toBe(Effort.High);
		expect(result.explicitThinkingLevel).toBe(true);
	});

	test("passes max through unclamped when the model ladder includes it", () => {
		const result = resolveModelRoleValue("anthropic/claude-opus-4-7:max", mockMaxCapableModels);

		expect(result.model?.provider).toBe("anthropic");
		expect(result.model?.id).toBe("claude-opus-4-7");
		expect(result.thinkingLevel).toBe(Effort.Max);
		expect(result.explicitThinkingLevel).toBe(true);
	});

	test("preserves an explicit :auto suffix as an explicit thinking selector", () => {
		const result = resolveModelRoleValue("anthropic/claude-sonnet-4-5:auto", allModels);

		expect(result.model?.provider).toBe("anthropic");
		expect(result.model?.id).toBe("claude-sonnet-4-5");
		expect(result.thinkingLevel).toBe("auto");
		expect(result.explicitThinkingLevel).toBe(true);
		expect(result.warning).toBeUndefined();
	});

	test("does not clamp :auto against the model's supported efforts", () => {
		// claude-sonnet-4-5 caps at "high"; ensure auto isn't collapsed onto it
		// by resolveThinkingLevelForModel.
		const result = resolveModelRoleValue("anthropic/claude-sonnet-4-5:auto", allModels);

		expect(result.thinkingLevel).toBe("auto");
		expect(result.explicitThinkingLevel).toBe(true);
	});
});
describe("resolveAgentPrewalkPattern", () => {
	test("agent definition alone decides: true → default target, pattern → custom, false/absent → off", () => {
		expect(resolveAgentPrewalkPattern({ agentPrewalk: true })).toBe("@smol");
		expect(resolveAgentPrewalkPattern({ agentPrewalk: "@very-smol" })).toBe("@very-smol");
		expect(resolveAgentPrewalkPattern({ agentPrewalk: false })).toBeUndefined();
		expect(resolveAgentPrewalkPattern({})).toBeUndefined();
	});

	test("settings override wins over the agent definition", () => {
		expect(resolveAgentPrewalkPattern({ settingsOverride: "off", agentPrewalk: true })).toBeUndefined();
		expect(resolveAgentPrewalkPattern({ settingsOverride: "off", agentPrewalk: "@very-smol" })).toBeUndefined();
		expect(resolveAgentPrewalkPattern({ settingsOverride: "on", agentPrewalk: false })).toBe("@smol");
		expect(resolveAgentPrewalkPattern({ settingsOverride: "openai/gpt-4o", agentPrewalk: false })).toBe(
			"openai/gpt-4o",
		);
	});

	test("override 'on' keeps the agent's custom target when one is defined", () => {
		expect(resolveAgentPrewalkPattern({ settingsOverride: "on", agentPrewalk: "@very-smol" })).toBe("@very-smol");
		expect(resolveAgentPrewalkPattern({ settingsOverride: "on" })).toBe("@smol");
	});

	test("blank override falls through to the agent definition", () => {
		expect(resolveAgentPrewalkPattern({ settingsOverride: "  ", agentPrewalk: true })).toBe("@smol");
		expect(resolveAgentPrewalkPattern({ settingsOverride: "", agentPrewalk: false })).toBeUndefined();
	});
});
describe("resolveAgentAdvisorSelection", () => {
	test("agent definition alone decides: true → advisor role, pattern → custom model, false/absent → off", () => {
		expect(resolveAgentAdvisorSelection({ agentAdvisor: true })).toEqual({});
		expect(resolveAgentAdvisorSelection({ agentAdvisor: "moonshot/k3" })).toEqual({ model: "moonshot/k3" });
		expect(resolveAgentAdvisorSelection({ agentAdvisor: false })).toBeUndefined();
		expect(resolveAgentAdvisorSelection({})).toBeUndefined();
	});

	test("settings override wins over the agent definition", () => {
		expect(resolveAgentAdvisorSelection({ settingsOverride: "off", agentAdvisor: true })).toBeUndefined();
		expect(resolveAgentAdvisorSelection({ settingsOverride: "off", agentAdvisor: "moonshot/k3" })).toBeUndefined();
		expect(resolveAgentAdvisorSelection({ settingsOverride: "on", agentAdvisor: false })).toEqual({});
		expect(resolveAgentAdvisorSelection({ settingsOverride: "openai/gpt-4o", agentAdvisor: false })).toEqual({
			model: "openai/gpt-4o",
		});
	});

	test("override 'on' keeps the agent's custom advisor model when one is defined", () => {
		expect(resolveAgentAdvisorSelection({ settingsOverride: "on", agentAdvisor: "moonshot/k3" })).toEqual({
			model: "moonshot/k3",
		});
		expect(resolveAgentAdvisorSelection({ settingsOverride: "on" })).toEqual({});
	});

	test("blank override falls through to the agent definition", () => {
		expect(resolveAgentAdvisorSelection({ settingsOverride: "  ", agentAdvisor: true })).toEqual({});
		expect(resolveAgentAdvisorSelection({ settingsOverride: "", agentAdvisor: false })).toBeUndefined();
	});
});
describe("resolveAgentModelPatterns", () => {
	test("pairs the first non-empty source's role with its patterns, skipping aliases with no patterns", () => {
		const settings = Settings.isolated({
			modelRoles: {
				empty: "",
				override: "openai/gpt-4o",
				definition: "anthropic/claude-sonnet-4-5",
			},
		});

		expect(
			resolveAgentModelSelection({
				requestModel: "",
				settingsOverride: "@override",
				agentModel: ["@definition"],
				settings,
			}),
		).toEqual({ patterns: ["openai/gpt-4o"], role: "override" });

		expect(
			resolveAgentModelSelection({
				requestModel: "@empty",
				settingsOverride: ",,",
				agentModel: ["@definition"],
				settings,
			}),
		).toEqual({ patterns: ["anthropic/claude-sonnet-4-5"], role: "definition" });

		// An explicit selector carries no role identity, so the child must not
		// capture the routing of a role that happens to name the same model.
		expect(
			resolveAgentModelSelection({
				requestModel: "openai/gpt-4o",
				settingsOverride: "@override",
				agentModel: ["@definition"],
				settings,
			}),
		).toEqual({ patterns: ["openai/gpt-4o"], role: undefined });
	});

	test("falls back to the active session model when @task is unset", () => {
		const settings = Settings.isolated({
			modelRoles: { default: "anthropic/claude-sonnet-4-5" },
		});

		const result = resolveAgentModelPatterns({
			agentModel: "@task",
			settings,
			activeModelPattern: "openai/gpt-4o",
		});

		expect(result).toEqual(["openai/gpt-4o"]);
	});

	test("uses the configured task role before falling back to the session model", () => {
		const settings = Settings.isolated({
			modelRoles: {
				default: "openai/gpt-4o",
				task: "anthropic/claude-sonnet-4-5:high",
			},
		});

		const result = resolveAgentModelPatterns({
			agentModel: "@task",
			settings,
			activeModelPattern: "openai/gpt-4o",
		});

		expect(result).toEqual(["anthropic/claude-sonnet-4-5:high"]);
	});

	test("accepts YAML list values for configured task role patterns", () => {
		const settings = Settings.isolated({
			modelRoles: {
				task: ["anthropic/claude-sonnet-4-6", "zai/glm-5.2:high"],
			},
		});

		const result = resolveAgentModelPatterns({
			agentModel: "@task",
			settings,
		});

		expect(result).toEqual(["anthropic/claude-sonnet-4-6", "zai/glm-5.2:high"]);
	});

	test("uses default for unconfigured smol and slow agent roles before priority defaults", () => {
		const settings = Settings.isolated({
			modelRoles: { default: "local/llama" },
		});

		expect(resolveAgentModelPatterns({ agentModel: "@smol", settings })).toEqual(["local/llama"]);
		expect(resolveAgentModelPatterns({ agentModel: "@slow", settings })).toEqual(["local/llama"]);
	});

	test("expands cross-role default aliases when inheriting for an unset role", () => {
		const settings = Settings.isolated({
			modelRoles: { default: "@slow", slow: "anthropic/claude-sonnet-4-5" },
		});

		expect(resolveAgentModelPatterns({ agentModel: "@smol", settings })).toEqual(["anthropic/claude-sonnet-4-5"]);
	});

	test("slow priority falls forward to Opus 4.8 before older Opus aliases", () => {
		const settings = Settings.isolated();
		const patterns = resolveAgentModelPatterns({ agentModel: "@slow", settings });

		const dottedRegistry = {
			getAvailable: () => [
				createOpusModel("github-copilot", "claude-opus-4.7", "Claude Opus 4.7"),
				createOpusModel("github-copilot", "claude-opus-4.8", "Claude Opus 4.8"),
			],
		} as Parameters<typeof resolveModelOverride>[1];
		const dotted = resolveModelOverride(patterns, dottedRegistry, settings);
		expect(dotted.model?.provider).toBe("github-copilot");
		expect(dotted.model?.id).toBe("claude-opus-4.8");

		const dashedRegistry = {
			getAvailable: () => [
				createOpusModel("anthropic", "claude-opus-4-7", "Claude Opus 4.7"),
				createOpusModel("anthropic", "claude-opus-4-8", "Claude Opus 4.8"),
			],
		} as Parameters<typeof resolveModelOverride>[1];
		const dashed = resolveModelOverride(patterns, dashedRegistry, settings);
		expect(dashed.model?.provider).toBe("anthropic");
		expect(dashed.model?.id).toBe("claude-opus-4-8");
	});
});

describe("resolveModelFromString", () => {
	test("falls back to pattern parsing for provider/model:thinking when strict provider+id miss", () => {
		const resolved = resolveModelFromString("openrouter/qwen/qwen3-coder:exacto:high", allModels);
		expect(resolved?.provider).toBe("openrouter");
		expect(resolved?.id).toBe("qwen/qwen3-coder:exacto");
	});

	test("treats colon-containing model IDs without thinking suffix as exact IDs", () => {
		const resolved = resolveModelFromString("openrouter/qwen/qwen3-coder:exacto", allModels);
		expect(resolved?.provider).toBe("openrouter");
		expect(resolved?.id).toBe("qwen/qwen3-coder:exacto");
	});
});

describe("resolveModelOverride", () => {
	test("preserves explicit off and explicit-thinking metadata", () => {
		const registry = {
			getAvailable: () => allModels,
		} as Parameters<typeof resolveModelOverride>[1];

		const result = resolveModelOverride(["sonnet:off"], registry);

		expect(result.model?.id).toBe("claude-sonnet-4-5");
		expect(result.thinkingLevel).toBe("off");
		expect(result.explicitThinkingLevel).toBe(true);
	});

	test("resolves colon-containing model IDs with appended thinking suffix", () => {
		const registry = {
			getAvailable: () => allModels,
		} as Parameters<typeof resolveModelOverride>[1];

		const result = resolveModelOverride(["openrouter/qwen/qwen3-coder:exacto:high"], registry);

		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
		expect(result.thinkingLevel).toBe(Effort.High);
		expect(result.explicitThinkingLevel).toBe(true);
	});
});
describe("resolveCliModel", () => {
	test("resolves --model provider/id without --provider", () => {
		const registry = { getAll: () => allModels, getAvailable: () => allModels } as unknown as Parameters<
			typeof resolveCliModel
		>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliModel: "openai/gpt-4o",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openai");
		expect(result.model?.id).toBe("gpt-4o");
	});

	test("prefers an authenticated provider for an unqualified exact model id", () => {
		const availableModels = openaiGpt55Models.filter(model => model.provider === "openai-codex");
		const registry = { getAll: () => openaiGpt55Models, getAvailable: () => openaiGpt55Models };

		const result = resolveCliModel({
			cliModel: "gpt-5.5",
			modelRegistry: registry,
			availableModels,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openai-codex");
		expect(result.model?.id).toBe("gpt-5.5");
	});

	test("prefers an authenticated provider for flat slashful ids whose prefix is a provider slug", () => {
		const mirror = (provider: string, baseUrl: string): Model<"anthropic-messages"> =>
			buildModel({
				id: "openai/gpt-oss-120b",
				name: "GPT-OSS 120B",
				api: "anthropic-messages",
				provider,
				baseUrl,
				reasoning: false,
				input: ["text"],
				cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
				contextWindow: 128000,
				maxTokens: 4096,
			});
		const catalogFirst = mirror("fireworks", "https://api.fireworks.ai");
		const authenticated = mirror("openrouter", "https://openrouter.ai");
		// "openai" is a real provider slug in the catalog, but it does not carry
		// this model — the selector is a flat aggregator id, not provider/id.
		const catalog = [...allModels, catalogFirst, authenticated];

		const result = resolveCliModel({
			cliModel: "openai/gpt-oss-120b",
			modelRegistry: { getAll: () => catalog, getAvailable: () => [authenticated] },
			availableModels: [authenticated],
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("openai/gpt-oss-120b");
	});

	test("resolves bare configured role names from --model", () => {
		const registry = { getAll: () => allModels, getAvailable: () => allModels };
		const settings = Settings.isolated({
			modelRoles: { task: "openai/gpt-4o" },
		});

		const result = resolveCliModel({
			cliModel: "task",
			modelRegistry: registry,
			settings,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openai");
		expect(result.model?.id).toBe("gpt-4o");
	});

	test("resolves bare configured role names with thinking suffixes", () => {
		const registry = { getAll: () => allModels, getAvailable: () => allModels };
		const settings = Settings.isolated({
			modelRoles: { task: "anthropic/claude-sonnet-4-5" },
		});

		const result = resolveCliModel({
			cliModel: "task:high",
			modelRegistry: registry,
			settings,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.id).toBe("claude-sonnet-4-5");
		expect(result.thinkingLevel).toBe(Effort.High);
		expect(result.configuredPatterns).toEqual(["anthropic/claude-sonnet-4-5:high"]);
	});

	test("preserves configured role fallback selectors for deferred resolution", () => {
		const registry = { getAll: () => allModels, getAvailable: () => allModels };
		const settings = Settings.isolated({
			modelRoles: {
				task: "openrouter/z-ai/glm-4.7@cerebras,anthropic/claude-sonnet-4-5",
			},
		});

		const result = resolveCliModel({
			cliModel: "task",
			modelRegistry: registry,
			settings,
		});

		expect(result.configuredPatterns).toEqual(["openrouter/z-ai/glm-4.7@cerebras", "anthropic/claude-sonnet-4-5"]);
	});

	test("reports when a configured role matches after unresolved candidates", () => {
		const registry = { getAll: () => allModels, getAvailable: () => allModels };
		const settings = Settings.isolated({
			modelRoles: {
				task: "runtime-provider/runtime-model,anthropic/claude-sonnet-4-5",
			},
		});

		const result = resolveCliModel({
			cliModel: "task",
			modelRegistry: registry,
			settings,
		});

		expect(result.model?.provider).toBe("anthropic");
		expect(result.configuredPatternIndex).toBe(1);
		expect(result.configuredPatterns).toEqual(["runtime-provider/runtime-model", "anthropic/claude-sonnet-4-5"]);
	});

	test("does not fuzzy-match unresolved configured roles", () => {
		const registry = { getAll: () => allModels, getAvailable: () => allModels };
		const settings = Settings.isolated({
			modelRoles: { sonnet: "runtime-provider/runtime-model" },
		});

		const result = resolveCliModel({
			cliModel: "sonnet",
			modelRegistry: registry,
			settings,
		});

		expect(result.model).toBeUndefined();
		expect(result.configuredPatterns).toEqual(["runtime-provider/runtime-model"]);
		expect(result.error).toContain('Model "sonnet" not found');
	});

	test("keeps unknown --model names on the not-found path", () => {
		const registry = { getAll: () => allModels, getAvailable: () => allModels };

		const result = resolveCliModel({
			cliModel: "not-a-model",
			modelRegistry: registry,
		});

		expect(result.model).toBeUndefined();
		expect(result.error).toContain('Model "not-a-model" not found');
	});

	test("prefers an exact model name over a same-named configured role", () => {
		const exactModel = buildModel({
			id: "task",
			name: "Task",
			api: "anthropic-messages",
			provider: "openai",
			baseUrl: "https://api.openai.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
			contextWindow: 128000,
			maxTokens: 4096,
		});
		const registry = { getAll: () => [...allModels, exactModel], getAvailable: () => [...allModels, exactModel] };
		const settings = Settings.isolated({
			modelRoles: { task: "anthropic/claude-sonnet-4-5" },
		});

		const result = resolveCliModel({
			cliModel: "task",
			modelRegistry: registry,
			settings,
		});

		expect(result.error).toBeUndefined();
		expect(result.model).toBe(exactModel);
		const suffixed = resolveCliModel({
			cliModel: "task:high",
			modelRegistry: registry,
			settings,
		});

		expect(suffixed.error).toBeUndefined();
		expect(suffixed.model).toBe(exactModel);
		expect(suffixed.thinkingLevel).toBe(Effort.High);
	});

	test("configured role beats an unauthenticated catalog id collision (#6508)", () => {
		// A bundled `cursor/default` model has the bare id `default`, which collides
		// with the reserved `default` role selector. When the user has no Cursor
		// credentials the catalog entry is not authenticated, so it must not shadow
		// a configured, runnable `modelRoles.default`.
		const cursorDefault = buildModel({
			id: "default",
			name: "Cursor Default",
			api: "anthropic-messages",
			provider: "cursor",
			baseUrl: "https://cursor.sh",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 4096,
		});
		const registry = { getAll: () => [...allModels, cursorDefault], getAvailable: () => allModels };
		const settings = Settings.isolated({
			modelRoles: { default: "openai/gpt-4o" },
		});

		const result = resolveCliModel({
			cliModel: "default",
			modelRegistry: registry,
			settings,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openai");
		expect(result.model?.id).toBe("gpt-4o");
	});

	test("unauthenticated catalog id still resolves when no role matches", () => {
		// Without a configured role the same bare id must still reach the catalog
		// model (so `--model default` surfaces the usual "no API key" error rather
		// than a spurious not-found), confirming the fallback is only deferred.
		const cursorDefault = buildModel({
			id: "default",
			name: "Cursor Default",
			api: "anthropic-messages",
			provider: "cursor",
			baseUrl: "https://cursor.sh",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 4096,
		});
		const registry = { getAll: () => [...allModels, cursorDefault], getAvailable: () => allModels };
		const settings = Settings.isolated({ modelRoles: {} });

		const result = resolveCliModel({
			cliModel: "default",
			modelRegistry: registry,
			settings,
		});

		expect(result.model?.provider).toBe("cursor");
		expect(result.model?.id).toBe("default");
	});

	test("resolves configured custom, legacy, and default role aliases from --model", () => {
		const registry = { getAll: () => allModels, getAvailable: () => allModels };
		const settings = Settings.isolated({
			modelRoles: {
				default: "openai/gpt-4o",
				fable: "anthropic/claude-sonnet-4-5:high",
			},
		});

		const canonical = resolveCliModel({
			cliModel: "@fable",
			modelRegistry: registry,
			settings,
		});
		const legacy = resolveCliModel({
			cliModel: `${LEGACY_MODEL_ROLE_ALIAS_PREFIX}fable`,
			modelRegistry: registry,
			settings,
		});
		const defaultRole = resolveCliModel({
			cliModel: DEFAULT_MODEL_ROLE_ALIAS,
			modelRegistry: registry,
			settings,
		});

		expect(canonical.error).toBeUndefined();
		expect(canonical.model?.provider).toBe("anthropic");
		expect(canonical.model?.id).toBe("claude-sonnet-4-5");
		expect(canonical.thinkingLevel).toBe(Effort.High);
		expect(legacy).toEqual(canonical);
		expect(defaultRole.model?.provider).toBe("openai");
		expect(defaultRole.model?.id).toBe("gpt-4o");
	});

	test("splits thinking suffixes and abbreviations off the * default alias", () => {
		const registry = { getAll: () => allModels, getAvailable: () => allModels };
		const settings = Settings.isolated({
			modelRoles: { default: "anthropic/claude-sonnet-4-5" },
		});

		const explicit = resolveCliModel({
			cliModel: `${DEFAULT_MODEL_ROLE_ALIAS}:high`,
			modelRegistry: registry,
			settings,
		});
		const abbreviated = resolveCliModel({
			cliModel: `${DEFAULT_MODEL_ROLE_ALIAS}:xhi`,
			modelRegistry: registry,
			settings,
		});

		expect(explicit.error).toBeUndefined();
		expect(explicit.model?.id).toBe("claude-sonnet-4-5");
		expect(explicit.thinkingLevel).toBe(Effort.High);
		// `xhi` → xhigh via unique-prefix parsing, then clamped to the model ladder.
		expect(abbreviated.error).toBeUndefined();
		expect(abbreviated.model?.id).toBe("claude-sonnet-4-5");
		expect(abbreviated.thinkingLevel).toBe(Effort.High);
	});

	test("resolves fuzzy patterns within an explicit provider", () => {
		const registry = { getAll: () => allModels, getAvailable: () => allModels } as unknown as Parameters<
			typeof resolveCliModel
		>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliProvider: "openai",
			cliModel: "4o",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openai");
		expect(result.model?.id).toBe("gpt-4o");
	});

	test("supports --model <pattern>:<thinking> (without explicit --thinking)", () => {
		const registry = { getAll: () => allModels, getAvailable: () => allModels } as unknown as Parameters<
			typeof resolveCliModel
		>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliModel: "sonnet:high",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.id).toBe("claude-sonnet-4-5");
		expect(result.thinkingLevel).toBe(Effort.High);
	});

	test("prefers exact model id match over provider inference (OpenRouter-style ids)", () => {
		const registry = { getAll: () => allModels, getAvailable: () => allModels } as unknown as Parameters<
			typeof resolveCliModel
		>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliModel: "openai/gpt-4o:extended",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("openai/gpt-4o:extended");
	});

	test("does not strip invalid :suffix as thinking level in --model (fail fast)", () => {
		const registry = { getAll: () => allModels, getAvailable: () => allModels } as unknown as Parameters<
			typeof resolveCliModel
		>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliProvider: "openai",
			cliModel: "gpt-4o:extended",
			modelRegistry: registry,
		});

		expect(result.model).toBeUndefined();
		expect(result.error).toContain("not found");
	});

	test("supports provider-prefixed OpenRouter route suffixes even when the base model is cataloged without them", () => {
		const registry = { getAll: () => allModels, getAvailable: () => allModels } as unknown as Parameters<
			typeof resolveCliModel
		>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliModel: "openrouter/z-ai/glm-4.7-20251222:nitro",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("z-ai/glm-4.7-20251222:nitro");
	});

	test("supports explicit OpenRouter provider with route suffixes that are not in the catalog", () => {
		const registry = { getAll: () => allModels, getAvailable: () => allModels } as unknown as Parameters<
			typeof resolveCliModel
		>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliProvider: "openrouter",
			cliModel: "z-ai/glm-4.7-20251222:nitro",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("z-ai/glm-4.7-20251222:nitro");
	});

	test("accepts Bedrock inference profile ARNs and preserves thinking suffixes", () => {
		const defaultBedrockModel = createBedrockDefaultModel();
		const profileArn = "arn:aws:bedrock:us-east-2:1234567890:application-inference-profile/company-opus-48";

		const baseResult = resolveCliModel({
			cliProvider: "amazon-bedrock",
			cliModel: profileArn,
			modelRegistry: { getAll: () => [defaultBedrockModel], getAvailable: () => [defaultBedrockModel] },
		});
		const offResult = resolveCliModel({
			cliProvider: "amazon-bedrock",
			cliModel: `${profileArn}:off`,
			modelRegistry: { getAll: () => [defaultBedrockModel], getAvailable: () => [defaultBedrockModel] },
		});

		expect(baseResult.error).toBeUndefined();
		expect(baseResult.model?.provider).toBe("amazon-bedrock");
		expect(baseResult.model?.api).toBe("bedrock-converse-stream");
		expect(baseResult.model?.id).toBe(profileArn);
		expect(baseResult.model?.name).toBe("Bedrock inference profile");
		expect(baseResult.model?.reasoning).toBe(false);
		expect(baseResult.model?.thinking).toBeUndefined();
		expect(baseResult.model?.contextWindow).toBeNull();
		expect(baseResult.model?.maxTokens).toBeNull();
		expect(baseResult.thinkingLevel).toBeUndefined();
		expect(offResult.error).toBeUndefined();
		expect(offResult.model?.id).toBe(profileArn);
		expect(offResult.thinkingLevel).toBe("off");
	});

	test("inherits provider-scoped guardrail, transport, and header overrides onto an ARN model, but not the template's prompt-cache checkpoints", () => {
		const templateModel = createBedrockDefaultModel({
			transport: "pi-native",
			headers: { "X-Custom-Header": "custom-value" },
			guardrailIdentifier: "arn:aws:bedrock:eu-west-2:123456789012:guardrail/abcd1234",
			guardrailVersion: "1",
			guardrailTrace: "enabled",
		});
		const profileArn = "arn:aws:bedrock:us-east-2:1234567890:application-inference-profile/company-opus-48";

		const result = resolveCliModel({
			cliProvider: "amazon-bedrock",
			cliModel: profileArn,
			modelRegistry: { getAll: () => [templateModel], getAvailable: () => [templateModel] },
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.id).toBe(profileArn);
		expect(result.model?.transport).toBe("pi-native");
		expect(result.model?.headers).toEqual({ "X-Custom-Header": "custom-value" });
		expect(result.model?.guardrailIdentifier).toBe("arn:aws:bedrock:eu-west-2:123456789012:guardrail/abcd1234");
		expect(result.model?.guardrailVersion).toBe("1");
		expect(result.model?.guardrailTrace).toBe("enabled");

		// The template's Opus-4.8 id derives explicit prompt-cache checkpoints;
		// the synthesized ARN model must not borrow that checkpoint policy.
		expect((templateModel.compat as { promptCacheMode?: string }).promptCacheMode).toBe("explicit");
		expect((result.model?.compat as { promptCacheMode?: string } | undefined)?.promptCacheMode).toBe("none");
	});

	test("returns a clear error when there are no models", () => {
		const registry = { getAll: () => [], getAvailable: () => [] } as unknown as Parameters<
			typeof resolveCliModel
		>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliProvider: "openai",
			cliModel: "gpt-4o",
			modelRegistry: registry,
		});

		expect(result.model).toBeUndefined();
		expect(result.error).toContain("No models available");
	});

	test("resolves provider-prefixed fuzzy patterns (openrouter/qwen -> openrouter model)", () => {
		const registry = { getAll: () => allModels, getAvailable: () => allModels } as unknown as Parameters<
			typeof resolveCliModel
		>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliModel: "openrouter/qwen",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
	});

	test("prefers decomposed provider+id over flat id match when ambiguous", () => {
		// Simulates the zai/glm-5 bug: vercel-ai-gateway has id="zai/glm-5",
		// zai has id="glm-5". Input "zai/glm-5" should resolve to provider=zai.
		const ambiguousModels: Model<"anthropic-messages">[] = [
			buildModel({
				id: "zai/glm-5",
				name: "GLM-5 (Vercel)",
				api: "anthropic-messages",
				provider: "vercel-ai-gateway",
				baseUrl: "https://vercel.ai",
				reasoning: false,
				input: ["text"],
				cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
				contextWindow: 128000,
				maxTokens: 4096,
			}),
			buildModel({
				id: "glm-5",
				name: "GLM-5",
				api: "anthropic-messages",
				provider: "zai",
				baseUrl: "https://api.z.ai",
				reasoning: false,
				input: ["text"],
				cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
				contextWindow: 128000,
				maxTokens: 4096,
			}),
		];
		const registry = { getAll: () => ambiguousModels, getAvailable: () => ambiguousModels } as unknown as Parameters<
			typeof resolveCliModel
		>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliModel: "zai/glm-5",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("zai");
		expect(result.model?.id).toBe("glm-5");
	});
});

describe("resolveModelScope", () => {
	test("does not coalesce explicit provider/id patterns to Codex (regression for enabledModels)", async () => {
		const scoped = await resolveModelScope(["openai/gpt-5.5"], {
			getAvailable: () => openaiGpt55Models,
		});
		expect(scoped).toHaveLength(1);
		expect(scoped[0].model.provider).toBe("openai");
		expect(scoped[0].model.id).toBe("gpt-5.5");
	});

	test("resolves role aliases in --models scope to the role's model with its thinking level", async () => {
		const settings = Settings.isolated({
			modelRoles: { fable: "anthropic/claude-sonnet-4-5:high" },
		});

		const scoped = await resolveModelScope(
			["@fable", "openai/gpt-4o"],
			{ getAvailable: () => allModels },
			undefined,
			settings,
		);

		expect(scoped).toHaveLength(2);
		expect(scoped[0].model.id).toBe("claude-sonnet-4-5");
		expect(scoped[0].thinkingLevel).toBe(Effort.High);
		expect(scoped[0].explicitThinkingLevel).toBe(true);
		expect(scoped[1].model.id).toBe("gpt-4o");
	});

	test("applies max thinking selectors to glob scopes when no literal max ids match", async () => {
		const registry = {
			getAvailable: () => mockCodexOverlapModels,
		};

		const scoped = await resolveModelScope(["openai-codex/*:max"], registry);

		expect(scoped).toHaveLength(2);
		// Scoped levels clamp per model: max on an xhigh-ceiling ladder resolves to xhigh.
		expect(scoped.map(entry => entry.thinkingLevel)).toEqual([Effort.XHigh, Effort.XHigh]);
		expect(scoped.every(entry => entry.explicitThinkingLevel)).toBe(true);
	});

	test("keeps max on glob scopes when the model ladder includes it", async () => {
		const registry = {
			getAvailable: () => mockMaxCapableModels,
		};

		const scoped = await resolveModelScope(["anthropic/*:max"], registry);

		expect(scoped).toHaveLength(1);
		expect(scoped[0].thinkingLevel).toBe(Effort.Max);
		expect(scoped[0].explicitThinkingLevel).toBe(true);
	});

	test("preserves literal :max in scoped-model globs", async () => {
		const registry = {
			getAvailable: () => mockMaxSuffixModels,
		};

		const scoped = await resolveModelScope(["nanogpt/*:max"], registry);

		expect(scoped).toHaveLength(1);
		expect(scoped[0].model.id).toBe("coding-router:max");
		expect(scoped[0].thinkingLevel).toBeUndefined();
		expect(scoped[0].explicitThinkingLevel).toBe(false);
	});
});

describe("parseModelString", () => {
	test("parses standard provider/id format", () => {
		const result = parseModelString("anthropic/claude-sonnet-4-5");
		expect(result).toEqual({ provider: "anthropic", id: "claude-sonnet-4-5" });
	});

	test("returns undefined for strings without a slash", () => {
		expect(parseModelString("claude-sonnet-4-5")).toBeUndefined();
		expect(parseModelString("")).toBeUndefined();
		expect(parseModelString("sonnet:high")).toBeUndefined();
	});

	test("returns undefined for strings starting with slash", () => {
		expect(parseModelString("/claude-sonnet-4-5")).toBeUndefined();
	});

	describe("thinking level suffix extraction", () => {
		test("extracts valid thinking level from provider/id:level", () => {
			const result = parseModelString("anthropic/claude-sonnet-4-5:high");
			expect(result).toEqual({ provider: "anthropic", id: "claude-sonnet-4-5", thinkingLevel: Effort.High });
		});

		test("extracts all valid thinking levels", () => {
			const levels = ["off", Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] as const;
			for (const level of levels) {
				const result = parseModelString(`anthropic/claude-sonnet-4-5:${level}`);
				expect(result?.id).toBe("claude-sonnet-4-5");
				expect(result?.thinkingLevel).toBe(level);
			}
		});

		test("does NOT strip invalid suffix — treats it as part of model ID", () => {
			const result = parseModelString("openrouter/qwen/qwen3-coder:exacto");
			expect(result).toEqual({ provider: "openrouter", id: "qwen/qwen3-coder:exacto" });
		});

		test("handles model ID with colon followed by valid thinking level", () => {
			// e.g. "openrouter/qwen/qwen3-coder:exacto:high" — last colon is thinking level
			const result = parseModelString("openrouter/qwen/qwen3-coder:exacto:high");
			expect(result).toEqual({
				provider: "openrouter",
				id: "qwen/qwen3-coder:exacto",
				thinkingLevel: Effort.High,
			});
		});

		test("extracts max when explicitly enabled for provider id selectors", () => {
			const result = parseModelString("deepseek/deepseek-v4-pro:max", { allowMaxSuffix: true });
			expect(result).toEqual({ provider: "deepseek", id: "deepseek-v4-pro", thinkingLevel: Effort.Max });
		});

		test("preserves literal max model ids when the caller can prove they exist", () => {
			const result = parseModelString("nanogpt/coding-router:max", {
				allowMaxSuffix: true,
				isLiteralModelId: (provider, id) => provider === "nanogpt" && id === "coding-router:max",
			});
			expect(result).toEqual({ provider: "nanogpt", id: "coding-router:max" });
		});

		test("leaves :max attached to the model id unless the caller opts in via allowMaxSuffix", () => {
			// Without allowMaxSuffix, the strict suffix parser must not silently
			// reinterpret a literal `:max` id as a thinking suffix.
			const result = parseModelString("anthropic/claude-sonnet-4-5:max");
			expect(result).toEqual({ provider: "anthropic", id: "claude-sonnet-4-5:max" });
		});

		test("leaves :auto attached to the model id unless the caller opts in via allowAutoAlias", () => {
			// Without allowAutoAlias, the strict suffix parser must not silently
			// reinterpret a literal `:auto` id as an auto-thinking selector.
			const result = parseModelString("example/runtime:auto");
			expect(result).toEqual({ provider: "example", id: "runtime:auto" });
		});

		test("extracts auto sentinel when explicitly enabled for provider id selectors", () => {
			const result = parseModelString("openai/gpt-5:auto", { allowAutoAlias: true });
			expect(result).toEqual({ provider: "openai", id: "gpt-5", thinkingLevel: "auto" });
		});

		test("preserves literal :auto model ids when the caller can prove they exist", () => {
			const result = parseModelString("example/runtime:auto", {
				allowAutoAlias: true,
				isLiteralModelId: (provider, id) => provider === "example" && id === "runtime:auto",
			});
			expect(result).toEqual({ provider: "example", id: "runtime:auto" });
		});

		test("does not strip inherited object keys as thinking suffixes", () => {
			const result = parseModelString("anthropic/claude-sonnet-4-5:constructor");
			expect(result).toEqual({ provider: "anthropic", id: "claude-sonnet-4-5:constructor" });
		});
		test("does not extract thinking level from model ID with invalid suffix", () => {
			const result = parseModelString("openrouter/openai/gpt-4o:extended");
			// :extended is not a valid thinking level, so it stays as part of the ID
			expect(result).toEqual({ provider: "openrouter", id: "openai/gpt-4o:extended" });
		});

		test("handles empty suffix after colon", () => {
			const result = parseModelString("anthropic/claude-sonnet-4-5:");
			// Empty string is not a valid thinking level, so colon stays as part of ID
			expect(result).toEqual({ provider: "anthropic", id: "claude-sonnet-4-5:" });
		});
	});
});

describe("resolveModelFromString", () => {
	test("applies max as a provider model selector alias after literal lookup misses", () => {
		const result = resolveModelFromString("nanogpt/coding-router:max", [mockMaxSuffixModels[0]]);
		expect(result?.provider).toBe("nanogpt");
		expect(result?.id).toBe("coding-router");
	});

	test("preserves literal max provider model ids before alias parsing", () => {
		const result = resolveModelFromString("nanogpt/coding-router:max", mockMaxSuffixModels);
		expect(result?.provider).toBe("nanogpt");
		expect(result?.id).toBe("coding-router:max");
	});

	test("preserves literal :auto provider model ids before alias parsing", () => {
		const result = resolveModelFromString("example/runtime:auto", mockAutoSuffixModels);
		expect(result?.provider).toBe("example");
		expect(result?.id).toBe("runtime:auto");
	});
});

describe("resolveExplicitModelRole", () => {
	test("extracts built-in, custom, legacy, default, and thinking-suffixed aliases before expansion", () => {
		const settings = Settings.isolated({
			modelRoles: {
				reviewer: "openai/gpt-4o",
			},
		});

		expect(resolveExplicitModelRole("@task", settings)).toBe("task");
		expect(resolveExplicitModelRole("pi/reviewer:high", settings)).toBe("reviewer");
		expect(resolveExplicitModelRole("@reviewer:xhigh", settings)).toBe("reviewer");
		expect(resolveExplicitModelRole("*:low", settings)).toBe("default");
	});

	test("does not infer a role from an explicit model selector", () => {
		const settings = Settings.isolated({ modelRoles: { reviewer: "openai/gpt-4o" } });
		expect(resolveExplicitModelRole("openai/gpt-4o", settings)).toBeUndefined();
		expect(resolveExplicitModelRole("openai/gpt-4o:high", settings)).toBeUndefined();
		expect(resolveExplicitModelRole("openai/gpt-4o:max", settings)).toBeUndefined();
		expect(resolveExplicitModelRole(["openai/gpt-4o", "@reviewer:high"], settings)).toBe("reviewer");
	});
});

describe("expandRoleAlias", () => {
	test("expands @vision to configured vision role", () => {
		const settings = Settings.isolated();
		settings.setModelRole("vision", "openai/gpt-4o");

		expect(expandRoleAlias("@vision", settings)).toBe("openai/gpt-4o");
	});

	test("keeps @vision alias when vision role is unset", () => {
		const settings = Settings.isolated();
		settings.setModelRole("default", "anthropic/claude-sonnet-4-5");

		expect(expandRoleAlias("@vision", settings)).toBe("@vision");
	});
});

describe("extractExplicitThinkingSelector", () => {
	test("does not carry max from literal role model ids", () => {
		const result = extractExplicitThinkingSelector("nanogpt/coding-router:max", undefined, {
			isLiteralModelId: (provider, id) => provider === "nanogpt" && id === "coding-router:max",
		});
		expect(result).toBeUndefined();
	});

	test("treats max as an explicit selector when the model id is not literal", () => {
		const result = extractExplicitThinkingSelector("nanogpt/coding-router:max", undefined, {
			isLiteralModelId: () => false,
		});
		expect(result).toBe(Effort.Max);
	});

	test("treats max on pi role aliases as an explicit selector before expansion", () => {
		const settings = Settings.isolated();
		settings.setModelRole("smol", "nanogpt/coding-router:max");
		const result = extractExplicitThinkingSelector("@smol:max", settings, {
			isLiteralModelId: (provider, id) => provider === "nanogpt" && id === "coding-router:max",
		});
		expect(result).toBe(Effort.Max);
	});

	test("does not carry auto from literal role model ids", () => {
		const result = extractExplicitThinkingSelector("nanogpt/coding-router:auto", undefined, {
			isLiteralModelId: (provider, id) => provider === "nanogpt" && id === "coding-router:auto",
		});
		expect(result).toBeUndefined();
	});

	test("treats auto as an explicit selector when the model id is not literal", () => {
		const result = extractExplicitThinkingSelector("openai/gpt-5:auto", undefined, {
			isLiteralModelId: () => false,
		});
		expect(result).toBe("auto");
	});
});

describe("provider routing selector (@upstream)", () => {
	const openRouterOnly = (model: Model<Api> | undefined): string[] | undefined =>
		(model?.compat as { openRouterRouting?: { only?: string[] } } | undefined)?.openRouterRouting?.only;

	test("pins an OpenRouter model to one upstream via @slug", () => {
		const result = parseModelPattern("openrouter/z-ai/glm-4.7@cerebras", allModels);
		expect(result.model?.id).toBe("z-ai/glm-4.7");
		expect(result.model?.provider).toBe("openrouter");
		expect(result.upstream).toBe("cerebras");
		expect(openRouterOnly(result.model)).toEqual(["cerebras"]);
	});

	test("resolves @slug without an explicit provider prefix", () => {
		const result = parseModelPattern("z-ai/glm-4.7@cerebras", allModels);
		expect(result.model?.id).toBe("z-ai/glm-4.7");
		expect(openRouterOnly(result.model)).toEqual(["cerebras"]);
	});

	test("combines @slug with a trailing thinking level", () => {
		const result = parseModelPattern("openrouter/z-ai/glm-4.7@cerebras:high", allModels);
		expect(result.model?.id).toBe("z-ai/glm-4.7");
		expect(result.thinkingLevel).toBe(Effort.High);
		expect(openRouterOnly(result.model)).toEqual(["cerebras"]);
	});

	test("preserves @upstream when the slug also matches model tokens", () => {
		const result = parseModelPattern("openrouter/deepseek/deepseek-v4-pro@deepseek:high", allModels);
		expect(result.model?.id).toBe("deepseek/deepseek-v4-pro");
		expect(result.thinkingLevel).toBe(Effort.High);
		expect(result.upstream).toBe("deepseek");
		expect(openRouterOnly(result.model)).toEqual(["deepseek"]);
	});

	test("routes Vercel AI Gateway models via vercelGatewayRouting", () => {
		const gatewayModel: Model<"openai-completions"> = buildModel({
			id: "zai/glm-4.7",
			name: "GLM 4.7 (Gateway)",
			api: "openai-completions",
			provider: "vercel-ai-gateway",
			baseUrl: "https://ai-gateway.vercel.sh/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
			contextWindow: 128000,
			maxTokens: 8192,
		});
		const result = parseModelPattern("vercel-ai-gateway/zai/glm-4.7@cerebras", [gatewayModel]);
		expect(result.model?.id).toBe("zai/glm-4.7");
		expect(
			(result.model?.compat as { vercelGatewayRouting?: { only?: string[] } } | undefined)?.vercelGatewayRouting
				?.only,
		).toEqual(["cerebras"]);
		expect(openRouterOnly(result.model)).toBeUndefined();
	});

	test("does not split a model id that legitimately ends in @ (Vertex)", () => {
		const vertexModel: Model<"anthropic-messages"> = buildModel({
			id: "claude-opus-4-8@default",
			name: "Claude Opus 4.8",
			api: "anthropic-messages",
			provider: "google-vertex",
			baseUrl: "https://us-aiplatform.googleapis.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
			contextWindow: 200000,
			maxTokens: 32000,
		});
		const result = parseModelPattern("claude-opus-4-8@default", [vertexModel]);
		expect(result.model?.id).toBe("claude-opus-4-8@default");
		expect(result.upstream).toBeUndefined();
		expect(openRouterOnly(result.model)).toBeUndefined();
	});

	test("keeps fuzzy matching a non-aggregator provider id that ends in @ (Vertex)", () => {
		const vertexModel: Model<"anthropic-messages"> = buildModel({
			id: "claude-opus-4-8@default",
			name: "Claude Opus 4.8",
			api: "anthropic-messages",
			provider: "google-vertex",
			baseUrl: "https://us-aiplatform.googleapis.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
			contextWindow: 200000,
			maxTokens: 32000,
		});
		// `opus@default` is a fuzzy provider-qualified pattern: the `@upstream` bypass must not
		// swallow it, because google-vertex is not an aggregator and the routing fallback would
		// never resolve it, leaving the selector unmatched.
		const result = parseModelPattern("google-vertex/opus@default", [vertexModel]);
		expect(result.model?.id).toBe("claude-opus-4-8@default");
		expect(result.upstream).toBeUndefined();
		expect(openRouterOnly(result.model)).toBeUndefined();
	});

	test("ignores @slug on a non-aggregator model (no silent routing)", () => {
		const result = parseModelPattern("gpt-4o@cerebras", allModels);
		expect(result.model).toBeUndefined();
	});

	test("resolveCliModel round-trips @upstream in the selector and carries compat", () => {
		const registry = { getAll: () => allModels, getAvailable: () => allModels } as unknown as Parameters<
			typeof resolveCliModel
		>[0]["modelRegistry"];
		const result = resolveCliModel({ cliModel: "openrouter/z-ai/glm-4.7@cerebras", modelRegistry: registry });
		expect(result.model?.id).toBe("z-ai/glm-4.7");
		expect(result.selector).toBe("openrouter/z-ai/glm-4.7@cerebras");
		expect(openRouterOnly(result.model)).toEqual(["cerebras"]);
	});
});

describe("filterAvailableModelsByEnabledPatterns", () => {
	const models = mockModels as Model[];
	test("returns all models when patterns is empty", () => {
		expect(filterAvailableModelsByEnabledPatterns(models, [])).toEqual(models);
	});

	test("resolves role aliases to the role's model when settings are provided", () => {
		const settings = Settings.isolated({
			modelRoles: { fable: "anthropic/claude-sonnet-4-5:high" },
		});
		const result = filterAvailableModelsByEnabledPatterns(models, ["@fable"], settings);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("claude-sonnet-4-5");
	});

	test("filters by exact provider/modelId", () => {
		const result = filterAvailableModelsByEnabledPatterns(models, ["anthropic/claude-sonnet-4-5"]);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("claude-sonnet-4-5");
	});

	test("filters by bare model id matching across providers", () => {
		const result = filterAvailableModelsByEnabledPatterns(models, ["claude-sonnet-4-5"]);
		expect(result).toHaveLength(1);
		expect(result[0].provider).toBe("anthropic");
	});

	test("strips :thinkingLevel suffix before matching", () => {
		const result = filterAvailableModelsByEnabledPatterns(models, ["anthropic/claude-sonnet-4-5:high"]);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("claude-sonnet-4-5");
	});

	test("preserves colon-bearing OpenRouter ids (suffix is not a thinking level)", () => {
		const openRouterModels = mockOpenRouterModels as Model[];
		const result = filterAvailableModelsByEnabledPatterns(openRouterModels, ["openrouter/qwen/qwen3-coder:exacto"]);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("qwen/qwen3-coder:exacto");
	});

	test("matches bare OpenRouter-style model id with slash but no provider prefix", () => {
		const openRouterModels = mockOpenRouterModels as Model[];
		const result = filterAvailableModelsByEnabledPatterns(openRouterModels, ["qwen/qwen3-coder:exacto"]);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("qwen/qwen3-coder:exacto");
		expect(result[0].provider).toBe("openrouter");
	});

	test("evaluates glob patterns against provider/modelId", () => {
		const result = filterAvailableModelsByEnabledPatterns(models, ["anthropic/*"]);
		expect(result).toHaveLength(1);
		expect(result[0].provider).toBe("anthropic");
	});
	test("preserves literal :max in enabledModels globs", () => {
		const result = filterAvailableModelsByEnabledPatterns(mockMaxSuffixModels, ["nanogpt/*:max"]);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("coding-router:max");
	});

	test("evaluates glob patterns against bare model id", () => {
		const result = filterAvailableModelsByEnabledPatterns(models, ["claude-*"]);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("claude-sonnet-4-5");
	});

	test("applies glob and exact patterns together", () => {
		const result = filterAvailableModelsByEnabledPatterns(models, ["anthropic/*", "openai/gpt-4o"]);
		expect(result).toHaveLength(2);
	});

	test("returns empty list when no pattern matches (misconfiguration)", () => {
		const result = filterAvailableModelsByEnabledPatterns(models, ["nonexistent-model"]);
		expect(result).toHaveLength(0);
	});

	test("includes multiple patterns from different providers", () => {
		const result = filterAvailableModelsByEnabledPatterns(models, ["anthropic/claude-sonnet-4-5", "openai/gpt-4o"]);
		expect(result).toHaveLength(2);
	});

	test("keeps synthetic Bedrock inference profile matches", () => {
		const bedrockModels = [createBedrockDefaultModel()];
		const profileArn = "arn:aws:bedrock:us-east-2:1234567890:application-inference-profile/company-opus-48";

		const result = filterAvailableModelsByEnabledPatterns(bedrockModels, [`amazon-bedrock/${profileArn}`]);

		expect(result).toHaveLength(1);
		expect(result[0].provider).toBe("amazon-bedrock");
		expect(result[0].id).toBe(profileArn);
		expect(result[0].reasoning).toBe(false);
	});

	test("resolveAllowedModels keeps synthetic Bedrock inference profile matches", async () => {
		const bedrockModels = [createBedrockDefaultModel()];
		const profileArn = "arn:aws:bedrock:us-east-2:1234567890:application-inference-profile/company-opus-48";
		const settings = Settings.isolated({ enabledModels: [profileArn] });

		const result = await resolveAllowedModels(
			{
				getAvailable: () => bedrockModels,
			},
			settings,
		);

		expect(result).toHaveLength(1);
		expect(result[0].provider).toBe("amazon-bedrock");
		expect(result[0].id).toBe(profileArn);
		expect(result[0].reasoning).toBe(false);
	});
	test("does not coalesce explicit provider/id patterns to Codex (regression for enabledModels)", () => {
		const result = filterAvailableModelsByEnabledPatterns(openaiGpt55Models, ["openai/gpt-5.5"]);
		expect(result).toHaveLength(1);
		expect(result[0].provider).toBe("openai");
		expect(result[0].id).toBe("gpt-5.5");
	});
});

describe("effort-tier variant aliases", () => {
	const variantModels: Model<Api>[] = [
		buildModel({
			id: "gemini-3.5-flash",
			requestModelId: "gemini-3.5-flash-extra-low",
			name: "Gemini 3.5 Flash",
			api: "google-gemini-cli",
			provider: "google-antigravity",
			baseUrl: "https://daily-cloudcode-pa.googleapis.com",
			reasoning: true,
			thinking: {
				mode: "google-level",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
				effortRouting: {
					off: "gemini-3.5-flash-extra-low",
					[Effort.Minimal]: "gemini-3-flash-agent",
					[Effort.Low]: "gemini-3.5-flash-extra-low",
					[Effort.Medium]: "gemini-3.5-flash-extra-low",
					[Effort.High]: "gemini-3.5-flash-low",
				},
				suppressWhenOff: true,
			},
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 65_535,
		}),
		// Live legacy model whose id is also a recycled alias of the family —
		// exact matches must keep winning while it exists.
		buildModel({
			id: "gemini-3-flash",
			name: "Gemini 3 Flash",
			api: "google-gemini-cli",
			provider: "google-antigravity",
			baseUrl: "https://daily-cloudcode-pa.googleapis.com",
			reasoning: true,
			thinking: { mode: "google-level", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 65_535,
		}),
		// Auto-derived pair target on a provider without a hand table.
		buildModel({
			id: "kimi-k2",
			name: "Kimi K2",
			api: "openai-completions",
			provider: "venice",
			baseUrl: "https://api.venice.ai/api/v1",
			reasoning: true,
			thinking: { mode: "budget", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 8_192,
		}),
	];

	test("provider-qualified retired tier ids resolve to the collapsed model", () => {
		const result = parseModelPattern("google-antigravity/gemini-3.5-flash-low", variantModels);
		expect(result.model?.id).toBe("gemini-3.5-flash");
		expect(result.thinkingLevel).toBeUndefined();
	});

	test("retired tier ids keep explicit :level suffixes", () => {
		const result = parseModelPattern("google-antigravity/gemini-3.5-flash-low:high", variantModels);
		expect(result.model?.id).toBe("gemini-3.5-flash");
		expect(result.thinkingLevel).toBe(Effort.High);
	});

	test("bare retired tier ids resolve through the alias table", () => {
		const result = parseModelPattern("gemini-3.5-flash-extra-low", variantModels);
		expect(result.model?.id).toBe("gemini-3.5-flash");
		expect(result.model?.provider).toBe("google-antigravity");
	});

	test("live models always beat recycled aliases", () => {
		const result = parseModelPattern("google-antigravity/gemini-3-flash", variantModels);
		expect(result.model?.id).toBe("gemini-3-flash");
	});

	test("consumed X-thinking twins resolve via the grammar fallback", () => {
		expect(parseModelPattern("venice/kimi-k2-thinking", variantModels).model?.id).toBe("kimi-k2");
		expect(parseModelPattern("kimi-k2-thinking", variantModels).model?.id).toBe("kimi-k2");
	});
});

describe("Devin selector parity", () => {
	const devinModel = (id: string, overrides: Partial<Model<"devin-agent">> = {}): Model<Api> =>
		buildModel({
			id,
			name: id,
			api: "devin-agent",
			provider: "devin",
			baseUrl: "https://server.codeium.com",
			reasoning: true,
			input: ["text", "image"],
			supportsTools: true,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 64_000,
			...overrides,
		});

	const devinModels: Model<Api>[] = [
		devinModel("claude-opus-5", {
			requestModelId: "claude-opus-5-low",
			thinking: {
				mode: "effort",
				efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
				effortRouting: {
					[Effort.Low]: "claude-opus-5-low",
					[Effort.XHigh]: "claude-opus-5-xhigh",
				},
				requiresEffort: true,
			},
		}),
		// Fuzzy-match decoy: `opus` must not land here.
		devinModel("claude-opus-4-6"),
		devinModel("swe-1-7-lightning", {
			requestModelId: "swe-1-7-lightning-medium",
			thinking: {
				mode: "effort",
				efforts: [Effort.Medium, Effort.Max],
				effortRouting: {
					[Effort.Medium]: "swe-1-7-lightning-medium",
					[Effort.Max]: "swe-1-7-lightning",
				},
				defaultLevel: Effort.Medium,
				requiresEffort: true,
			},
		}),
		devinModel("gemini-3-7-flash", {
			requestModelId: "gemini-3-7-flash-medium",
			thinking: {
				mode: "effort",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
				effortRouting: {
					[Effort.Medium]: "gemini-3-7-flash-medium",
					[Effort.High]: "gemini-3-7-flash-high",
				},
				defaultLevel: Effort.Medium,
				requiresEffort: true,
			},
		}),
		// A family that only exists in the live catalog: collapsed at discovery
		// time, so no hand-table alias covers its wire ids.
		devinModel("claude-mythos-9", {
			requestModelId: "claude-mythos-9-medium",
			thinking: {
				mode: "effort",
				efforts: [Effort.Medium, Effort.High],
				effortRouting: {
					[Effort.Medium]: "claude-mythos-9-medium",
					[Effort.High]: "claude-mythos-9-high",
				},
				requiresEffort: true,
			},
		}),
	];

	test("provider-scoped native aliases beat fuzzy id matches", () => {
		expect(parseModelPattern("devin/opus", devinModels).model?.id).toBe("claude-opus-5");
		expect(parseModelPattern("devin/swe", devinModels).model?.id).toBe("swe-1-7-lightning");
		expect(parseModelPattern("devin/gemini", devinModels).model?.id).toBe("gemini-3-7-flash");
		const withLevel = parseModelPattern("devin/opus:high", devinModels);
		expect(withLevel.model?.id).toBe("claude-opus-5");
		expect(withLevel.thinkingLevel).toBe(Effort.High);
	});

	test("dotted native spellings resolve to the hyphenated logical id", () => {
		expect(parseModelPattern("devin/gemini-3.7-flash", devinModels).model?.id).toBe("gemini-3-7-flash");
		expect(parseModelPattern("devin/swe-1.7-lightning", devinModels).model?.id).toBe("swe-1-7-lightning");
	});

	test("raw effort-route wire ids resolve to their collapsed model, provider-scoped", () => {
		expect(resolveProviderModelReference("devin", "claude-mythos-9-high", devinModels)?.id).toBe("claude-mythos-9");
		expect(resolveProviderModelReference("devin", "gemini-3-7-flash-high", devinModels)?.id).toBe("gemini-3-7-flash");
		expect(resolveProviderModelReference("openai", "claude-mythos-9-high", devinModels)).toBeUndefined();
	});

	test("a live raw model still wins over the collapsed carrier routing to it", () => {
		const withRaw = [...devinModels, devinModel("claude-mythos-9-high")];
		expect(resolveProviderModelReference("devin", "claude-mythos-9-high", withRaw)?.id).toBe("claude-mythos-9-high");
	});
});
