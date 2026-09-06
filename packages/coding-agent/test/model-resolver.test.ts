import { describe, expect, test } from "bun:test";
import { type Api, Effort, type Model } from "@pk-nerdsaver-ai/pi-ai";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import { DEFAULT_MODEL_PER_PROVIDER } from "@pk-nerdsaver-ai/pi-catalog/provider-models";
import type { CanonicalModelVariant } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import {
	type CanonicalModelRegistry,
	expandRoleAlias,
	extractExplicitThinkingSelector,
	filterAvailableModelsByEnabledPatterns,
	parseModelPattern,
	parseModelString,
	pickDefaultAvailableModel,
	resolveAgentModelPatterns,
	resolveAllowedModels,
	resolveCliModel,
	resolveModelFromString,
	resolveModelOverride,
	resolveModelRoleValue,
	resolveModelScope,
	resolveRoleSelection,
} from "@pk-nerdsaver-ai/pi-coding-agent/config/model-resolver";
import {
	hasExplicitRoleServiceTier,
	resolveRoleServiceTier,
} from "@pk-nerdsaver-ai/pi-coding-agent/config/service-tier";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";

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

const codexCanonicalRegistry: CanonicalModelRegistry = {
	resolveCanonicalModel: (canonicalId: string, options?: { candidates?: Model<Api>[] }) => {
		if (canonicalId !== "gpt-5.5") return undefined;
		return options?.candidates?.find(model => model.provider === "openai-codex" && model.id === canonicalId);
	},
	getCanonicalId: (model: Model<Api>) => (model.id === "gpt-5.5" ? "gpt-5.5" : undefined),
};

function createBedrockDefaultModel(): Model<"bedrock-converse-stream"> {
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

const canonicalVariantModels: Model<"anthropic-messages">[] = [
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
		id: "anthropic/claude-sonnet-4.5",
		name: "Claude Sonnet 4.5 (Copilot)",
		api: "anthropic-messages",
		provider: "github-copilot",
		baseUrl: "https://api.githubcopilot.com",
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
];

const canonicalRegistry = {
	resolveCanonicalModel: (canonicalId: string, options?: { candidates?: Model<"anthropic-messages">[] }) => {
		if (canonicalId !== "claude-sonnet-4-5") return undefined;
		const candidates = options?.candidates ?? canonicalVariantModels;
		return (
			candidates.find(model => model.provider === "github-copilot") ??
			candidates.find(model => model.provider === "anthropic")
		);
	},
	getCanonicalVariants: (canonicalId: string, options?: { candidates?: Model<"anthropic-messages">[] }) => {
		if (canonicalId !== "claude-sonnet-4-5") return [];
		const candidates = options?.candidates ?? canonicalVariantModels;
		return candidates.map(model => ({
			canonicalId,
			selector: `${model.provider}/${model.id}`,
			model,
			source: model.id === canonicalId ? "bundled" : "heuristic",
		}));
	},
	getCanonicalId: () => "claude-sonnet-4-5",
	getAvailable: () => canonicalVariantModels,
} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

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
});

describe("resolveModelRoleValue", () => {
	test("does not reroute explicit OpenAI GPT defaults through Codex canonical selection", () => {
		const result = resolveModelRoleValue("openai/gpt-5.5:xhigh", openaiGpt55Models, {
			modelRegistry: codexCanonicalRegistry,
		});

		expect(result.model?.provider).toBe("openai");
		expect(result.model?.id).toBe("gpt-5.5");
		expect(result.thinkingLevel).toBe(Effort.XHigh);
		expect(result.explicitThinkingLevel).toBe(true);
	});

	test("reroutes bare GPT default through Codex canonical selection", () => {
		const result = resolveModelRoleValue("gpt-5.5:xhigh", openaiGpt55Models, {
			modelRegistry: codexCanonicalRegistry,
		});

		expect(result.model?.provider).toBe("openai-codex");
		expect(result.model?.id).toBe("gpt-5.5");
		expect(result.thinkingLevel).toBe(Effort.XHigh);
		expect(result.explicitThinkingLevel).toBe(true);
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
			const levels = ["off", Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] as const;
			for (const level of levels) {
				const result = parseModelPattern(`sonnet:${level}`, allModels);
				expect(result.model?.id).toBe("claude-sonnet-4-5");
				expect(result.thinkingLevel).toBe(level);
				expect(result.warning).toBeUndefined();
			}
		});
		test("max selects a distinct thinking tier after the literal pattern misses", () => {
			const result = parseModelPattern("gpt-5.3-codex:max", allModels);
			expect(result.model?.id).toBe("gpt-5.3-codex");
			expect(result.thinkingLevel).toBe(Effort.Max);
			expect(result.explicitThinkingLevel).toBe(true);
			expect(result.warning).toBeUndefined();
		});

		test("literal model ids ending in max win over the thinking alias", () => {
			const result = parseModelPattern("nanogpt/coding-router:max", mockMaxSuffixModels);
			expect(result.model?.id).toBe("coding-router:max");
			expect(result.thinkingLevel).toBeUndefined();
			expect(result.explicitThinkingLevel).toBe(false);
			expect(result.warning).toBeUndefined();
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

		test("openrouter/<id>:max selects reasoning rather than an OpenRouter route", () => {
			// Preserve the requested max tier; session resolution clamps it to the
			// model's ceiling instead of cloning a literal `z-ai/glm-4.7:max` ID.
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

	describe("canonical ids", () => {
		test("resolves an exact canonical id through the registry before bare-id matching", () => {
			const result = parseModelPattern("claude-sonnet-4-5", canonicalVariantModels, undefined, {
				modelRegistry: canonicalRegistry,
			});
			expect(result.model?.provider).toBe("github-copilot");
			expect(result.model?.id).toBe("anthropic/claude-sonnet-4.5");
		});
	});
});

describe("resolveModelRoleValue", () => {
	test("resolves pi/<role>:<thinking> by expanding role alias before parsing thinking", () => {
		const settings = {
			getModelRole: (role: string) => (role === "smol" ? "openrouter/qwen/qwen3-coder:exacto" : undefined),
		} as NonNullable<Parameters<typeof resolveModelRoleValue>[2]>["settings"];

		const result = resolveModelRoleValue("pi/smol:high", allModels, { settings });

		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("qwen/qwen3-coder:exacto");
		expect(result.thinkingLevel).toBe(Effort.High);
		expect(result.explicitThinkingLevel).toBe(true);
	});

	test("resolves pi/<role>:max by expanding role alias before parsing thinking", () => {
		const settings = {
			getModelRole: (role: string) => (role === "smol" ? "openai-codex/gpt-5.3-codex" : undefined),
		} as NonNullable<Parameters<typeof resolveModelRoleValue>[2]>["settings"];

		const result = resolveModelRoleValue("pi/smol:max", allModels, { settings });

		expect(result.model?.provider).toBe("openai-codex");
		expect(result.model?.id).toBe("gpt-5.3-codex");
		expect(result.thinkingLevel).toBe(Effort.XHigh);
		expect(result.explicitThinkingLevel).toBe(true);
	});

	test("resolves pi/default through configured default role alias", () => {
		const settings = {
			getModelRole: (role: string) => (role === "default" ? "openrouter/qwen/qwen3-coder:exacto" : undefined),
		} as NonNullable<Parameters<typeof resolveModelRoleValue>[2]>["settings"];

		const result = resolveModelRoleValue("pi/default", allModels, { settings });

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
});
describe("resolveAgentModelPatterns", () => {
	test("falls back to the active session model when pi/task is unset", () => {
		const settings = Settings.isolated({
			modelRoles: { default: "anthropic/claude-sonnet-4-5" },
		});

		const result = resolveAgentModelPatterns({
			agentModel: "pi/task",
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
			agentModel: "pi/task",
			settings,
			activeModelPattern: "openai/gpt-4o",
		});

		expect(result).toEqual(["anthropic/claude-sonnet-4-5:high"]);
	});

	test("uses default for unconfigured smol, slow, and designer agent roles before priority defaults", () => {
		const settings = Settings.isolated({
			modelRoles: { default: "local/llama" },
		});

		expect(resolveAgentModelPatterns({ agentModel: "pi/smol", settings })).toEqual(["local/llama"]);
		expect(resolveAgentModelPatterns({ agentModel: "pi/slow", settings })).toEqual(["local/llama"]);
		expect(resolveAgentModelPatterns({ agentModel: "pi/designer", settings })).toEqual(["local/llama"]);
	});

	test("expands cross-role default aliases when inheriting for an unset role", () => {
		const settings = Settings.isolated({
			modelRoles: { default: "pi/slow", slow: "anthropic/claude-sonnet-4-5" },
		});

		expect(resolveAgentModelPatterns({ agentModel: "pi/smol", settings })).toEqual(["anthropic/claude-sonnet-4-5"]);
	});

	test("prefers configured designer role override over priority defaults", () => {
		const settings = Settings.isolated({
			modelRoles: {
				default: "anthropic/claude-sonnet-4-5",
				designer: "openai/gpt-4o",
			},
		});

		const result = resolveAgentModelPatterns({
			agentModel: "pi/designer",
			settings,
		});

		expect(result).toEqual(["openai/gpt-4o"]);
	});

	test("slow priority falls forward to Opus 4.8 before older Opus aliases", () => {
		const settings = Settings.isolated();
		const patterns = resolveAgentModelPatterns({ agentModel: "pi/slow", settings });

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
	test("resolves exact canonical ids to the preferred concrete provider", () => {
		const result = resolveCliModel({
			cliModel: "claude-sonnet-4-5",
			modelRegistry: {
				...canonicalRegistry,
				getAll: () => canonicalVariantModels,
			} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"],
		});

		expect(result.error).toBeUndefined();
		expect(result.selector).toBe("claude-sonnet-4-5");
		expect(result.model?.provider).toBe("github-copilot");
		expect(result.model?.id).toBe("anthropic/claude-sonnet-4.5");
	});

	test("resolves --model provider/id without --provider", () => {
		const registry = {
			getAll: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliModel: "openai/gpt-4o",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openai");
		expect(result.model?.id).toBe("gpt-4o");
	});

	test("resolves fuzzy patterns within an explicit provider", () => {
		const registry = {
			getAll: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

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
		const registry = {
			getAll: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliModel: "sonnet:high",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.id).toBe("claude-sonnet-4-5");
		expect(result.thinkingLevel).toBe(Effort.High);
	});

	test("prefers exact model id match over provider inference (OpenRouter-style ids)", () => {
		const registry = {
			getAll: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliModel: "openai/gpt-4o:extended",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("openai/gpt-4o:extended");
	});

	test("does not strip invalid :suffix as thinking level in --model (fail fast)", () => {
		const registry = {
			getAll: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliProvider: "openai",
			cliModel: "gpt-4o:extended",
			modelRegistry: registry,
		});

		expect(result.model).toBeUndefined();
		expect(result.error).toContain("not found");
	});

	test("supports provider-prefixed OpenRouter route suffixes even when the base model is cataloged without them", () => {
		const registry = {
			getAll: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliModel: "openrouter/z-ai/glm-4.7-20251222:nitro",
			modelRegistry: registry,
		});

		expect(result.error).toBeUndefined();
		expect(result.model?.provider).toBe("openrouter");
		expect(result.model?.id).toBe("z-ai/glm-4.7-20251222:nitro");
	});

	test("supports explicit OpenRouter provider with route suffixes that are not in the catalog", () => {
		const registry = {
			getAll: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

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
			modelRegistry: {
				getAll: () => [defaultBedrockModel],
			},
		});
		const offResult = resolveCliModel({
			cliProvider: "amazon-bedrock",
			cliModel: `${profileArn}:off`,
			modelRegistry: {
				getAll: () => [defaultBedrockModel],
			},
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

	test("returns a clear error when there are no models", () => {
		const registry = {
			getAll: () => [],
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

		const result = resolveCliModel({
			cliProvider: "openai",
			cliModel: "gpt-4o",
			modelRegistry: registry,
		});

		expect(result.model).toBeUndefined();
		expect(result.error).toContain("No models available");
	});

	test("resolves provider-prefixed fuzzy patterns (openrouter/qwen -> openrouter model)", () => {
		const registry = {
			getAll: () => allModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

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
		const registry = {
			getAll: () => ambiguousModels,
		} as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];

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
	test("expands exact canonical ids into all concrete variants", async () => {
		const scoped = await resolveModelScope(["claude-sonnet-4-5"], {
			getAvailable: () => canonicalVariantModels,
			getCanonicalVariants: (canonicalId: string, options?: { candidates?: Model<"anthropic-messages">[] }) =>
				canonicalRegistry.getCanonicalVariants!(canonicalId, options),
		} as unknown as Parameters<typeof resolveModelScope>[1]);

		expect(scoped).toHaveLength(2);
		expect(scoped.map(entry => `${entry.model.provider}/${entry.model.id}`).sort()).toEqual([
			"anthropic/claude-sonnet-4-5",
			"github-copilot/anthropic/claude-sonnet-4.5",
		]);
	});

	test("does not coalesce explicit provider/id patterns to Codex (regression for enabledModels)", async () => {
		const scoped = await resolveModelScope(["openai/gpt-5.5"], {
			getAvailable: () => openaiGpt55Models,
			getCanonicalVariants: () => [],
		});
		expect(scoped).toHaveLength(1);
		expect(scoped[0].model.provider).toBe("openai");
		expect(scoped[0].model.id).toBe("gpt-5.5");
	});

	test("expands exact canonical ids with max thinking aliases", async () => {
		const scoped = await resolveModelScope(["claude-sonnet-4-5:max"], {
			getAvailable: () => canonicalVariantModels,
			getCanonicalVariants: (canonicalId: string, options?: { candidates?: Model<"anthropic-messages">[] }) =>
				canonicalRegistry.getCanonicalVariants!(canonicalId, options),
		} as unknown as Parameters<typeof resolveModelScope>[1]);

		expect(scoped).toHaveLength(2);
		expect(scoped.map(entry => `${entry.model.provider}/${entry.model.id}`).sort()).toEqual([
			"anthropic/claude-sonnet-4-5",
			"github-copilot/anthropic/claude-sonnet-4.5",
		]);
		expect(scoped.map(entry => entry.thinkingLevel)).toEqual([Effort.High, Effort.High]);
		expect(scoped.every(entry => entry.explicitThinkingLevel)).toBe(true);
	});

	test("applies max thinking aliases to glob scopes when no literal max ids match", async () => {
		const registry = {
			getAvailable: () => mockCodexOverlapModels,
			getCanonicalVariants: (_id: string, _opts?: unknown): CanonicalModelVariant[] => [],
		};

		const scoped = await resolveModelScope(["openai-codex/*:max"], registry);

		expect(scoped).toHaveLength(2);
		expect(scoped.map(entry => entry.thinkingLevel)).toEqual([Effort.XHigh, Effort.XHigh]);
		expect(scoped.every(entry => entry.explicitThinkingLevel)).toBe(true);
	});

	test("preserves literal :max in scoped-model globs", async () => {
		const registry = {
			getAvailable: () => mockMaxSuffixModels,
			getCanonicalVariants: (_id: string, _opts?: unknown): CanonicalModelVariant[] => [],
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
			const result = parseModelString("deepseek/deepseek-v4-pro:max", { allowMaxAlias: true });
			expect(result).toEqual({ provider: "deepseek", id: "deepseek-v4-pro", thinkingLevel: Effort.Max });
		});

		test("preserves literal max model ids when the caller can prove they exist", () => {
			const result = parseModelString("nanogpt/coding-router:max", {
				allowMaxAlias: true,
				isLiteralModelId: (provider, id) => provider === "nanogpt" && id === "coding-router:max",
			});
			expect(result).toEqual({ provider: "nanogpt", id: "coding-router:max" });
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
});

describe("expandRoleAlias", () => {
	test("expands pi/vision to configured vision role", () => {
		const settings = Settings.isolated();
		settings.setModelRole("vision", "openai/gpt-4o");

		expect(expandRoleAlias("pi/vision", settings)).toBe("openai/gpt-4o");
	});

	test("keeps pi/vision alias when vision role is unset", () => {
		const settings = Settings.isolated();
		settings.setModelRole("default", "anthropic/claude-sonnet-4-5");

		expect(expandRoleAlias("pi/vision", settings)).toBe("pi/vision");
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
		const result = extractExplicitThinkingSelector("pi/smol:max", settings, {
			isLiteralModelId: (provider, id) => provider === "nanogpt" && id === "coding-router:max",
		});
		expect(result).toBe(Effort.Max);
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
		const registry = { getAll: () => allModels } as unknown as Parameters<typeof resolveCliModel>[0]["modelRegistry"];
		const result = resolveCliModel({ cliModel: "openrouter/z-ai/glm-4.7@cerebras", modelRegistry: registry });
		expect(result.model?.id).toBe("z-ai/glm-4.7");
		expect(result.selector).toBe("openrouter/z-ai/glm-4.7@cerebras");
		expect(openRouterOnly(result.model)).toEqual(["cerebras"]);
	});
});

describe("filterAvailableModelsByEnabledPatterns", () => {
	const models = mockModels as Model[];
	const registry = {
		getCanonicalVariants: (_id: string, _opts?: unknown): CanonicalModelVariant[] => [],
	};

	test("returns all models when patterns is empty", () => {
		expect(filterAvailableModelsByEnabledPatterns(models, [], registry)).toEqual(models);
	});

	test("filters by exact provider/modelId", () => {
		const result = filterAvailableModelsByEnabledPatterns(models, ["anthropic/claude-sonnet-4-5"], registry);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("claude-sonnet-4-5");
	});

	test("filters by bare model id matching across providers", () => {
		const result = filterAvailableModelsByEnabledPatterns(models, ["claude-sonnet-4-5"], registry);
		expect(result).toHaveLength(1);
		expect(result[0].provider).toBe("anthropic");
	});

	test("expands canonical id via registry", () => {
		const canonicalRegistry = {
			getCanonicalVariants: (id: string, _opts?: unknown): CanonicalModelVariant[] =>
				id === "claude-sonnet-4-5"
					? [
							{
								canonicalId: "claude-sonnet-4-5",
								selector: "anthropic/claude-sonnet-4-5",
								model: models[0],
								source: "bundled",
							},
						]
					: [],
		};
		const result = filterAvailableModelsByEnabledPatterns(models, ["claude-sonnet-4-5"], canonicalRegistry);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("claude-sonnet-4-5");
	});

	test("expands canonical enabledModels entries with max thinking aliases", () => {
		const registry = {
			getCanonicalVariants: (canonicalId: string, options?: { candidates?: Model<"anthropic-messages">[] }) =>
				canonicalRegistry.getCanonicalVariants!(canonicalId, options),
		};
		const result = filterAvailableModelsByEnabledPatterns(
			canonicalVariantModels,
			["claude-sonnet-4-5:max"],
			registry,
		);
		expect(result.map(model => `${model.provider}/${model.id}`).sort()).toEqual([
			"anthropic/claude-sonnet-4-5",
			"github-copilot/anthropic/claude-sonnet-4.5",
		]);
	});

	test("strips :thinkingLevel suffix before matching", () => {
		const result = filterAvailableModelsByEnabledPatterns(models, ["anthropic/claude-sonnet-4-5:high"], registry);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("claude-sonnet-4-5");
	});

	test("preserves colon-bearing OpenRouter ids (suffix is not a thinking level)", () => {
		const openRouterModels = mockOpenRouterModels as Model[];
		const result = filterAvailableModelsByEnabledPatterns(
			openRouterModels,
			["openrouter/qwen/qwen3-coder:exacto"],
			registry,
		);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("qwen/qwen3-coder:exacto");
	});

	test("matches bare OpenRouter-style model id with slash but no provider prefix", () => {
		const openRouterModels = mockOpenRouterModels as Model[];
		const result = filterAvailableModelsByEnabledPatterns(openRouterModels, ["qwen/qwen3-coder:exacto"], registry);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("qwen/qwen3-coder:exacto");
		expect(result[0].provider).toBe("openrouter");
	});

	test("evaluates glob patterns against provider/modelId", () => {
		const result = filterAvailableModelsByEnabledPatterns(models, ["anthropic/*"], registry);
		expect(result).toHaveLength(1);
		expect(result[0].provider).toBe("anthropic");
	});
	test("preserves literal :max in enabledModels globs", () => {
		const result = filterAvailableModelsByEnabledPatterns(mockMaxSuffixModels, ["nanogpt/*:max"], registry);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("coding-router:max");
	});

	test("evaluates glob patterns against bare model id", () => {
		const result = filterAvailableModelsByEnabledPatterns(models, ["claude-*"], registry);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("claude-sonnet-4-5");
	});

	test("applies glob and exact patterns together", () => {
		const result = filterAvailableModelsByEnabledPatterns(models, ["anthropic/*", "openai/gpt-4o"], registry);
		expect(result).toHaveLength(2);
	});

	test("returns empty list when no pattern matches (misconfiguration)", () => {
		const result = filterAvailableModelsByEnabledPatterns(models, ["nonexistent-model"], registry);
		expect(result).toHaveLength(0);
	});

	test("includes multiple patterns from different providers", () => {
		const result = filterAvailableModelsByEnabledPatterns(
			models,
			["anthropic/claude-sonnet-4-5", "openai/gpt-4o"],
			registry,
		);
		expect(result).toHaveLength(2);
	});

	test("keeps synthetic Bedrock inference profile matches", () => {
		const bedrockModels = [createBedrockDefaultModel()];
		const profileArn = "arn:aws:bedrock:us-east-2:1234567890:application-inference-profile/company-opus-48";

		const result = filterAvailableModelsByEnabledPatterns(bedrockModels, [`amazon-bedrock/${profileArn}`], registry);

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
				getCanonicalVariants: registry.getCanonicalVariants,
			},
			settings,
		);

		expect(result).toHaveLength(1);
		expect(result[0].provider).toBe("amazon-bedrock");
		expect(result[0].id).toBe(profileArn);
		expect(result[0].reasoning).toBe(false);
	});
	test("does not coalesce explicit provider/id patterns to Codex (regression for enabledModels)", () => {
		const result = filterAvailableModelsByEnabledPatterns(openaiGpt55Models, ["openai/gpt-5.5"], registry);
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

describe("resolveRoleSelection service tiers", () => {
	const makeSettings = (role: string, model: string, tiers: Record<string, string>) => {
		const settings = Settings.isolated({ modelRoleTiers: tiers });
		settings.setModelRole(role, model);
		return settings;
	};

	test("returns the matched role's configured tier", () => {
		const settings = makeSettings("smol", "anthropic/claude-sonnet-4-5", { smol: "priority" });
		const resolved = resolveRoleSelection(["tiny", "smol"], settings, mockModels);
		expect(resolved?.model.id).toBe("claude-sonnet-4-5");
		expect(resolved?.serviceTier).toBe("priority");
	});

	test("tier follows the role that actually matched in a fallback chain", () => {
		const settings = Settings.isolated({ modelRoleTiers: { tiny: "flex", smol: "priority" } });
		settings.setModelRole("tiny", "anthropic/claude-sonnet-4-5");
		settings.setModelRole("smol", "openai/gpt-4o");
		const resolved = resolveRoleSelection(["tiny", "smol"], settings, mockModels);
		expect(resolved?.model.id).toBe("claude-sonnet-4-5");
		expect(resolved?.serviceTier).toBe("flex");
	});

	test("falls through to the next role when the first has no model", () => {
		const settings = Settings.isolated({ modelRoleTiers: { tiny: "flex", smol: "priority" } });
		settings.setModelRole("smol", "openai/gpt-4o");
		const resolved = resolveRoleSelection(["tiny", "smol"], settings, mockModels);
		expect(resolved?.model.id).toBe("gpt-4o");
		expect(resolved?.serviceTier).toBe("priority");
	});

	test("roles without a tier entry resolve with an undefined tier", () => {
		const settings = makeSettings("smol", "anthropic/claude-sonnet-4-5", {});
		const resolved = resolveRoleSelection(["smol"], settings, mockModels);
		expect(resolved?.model.id).toBe("claude-sonnet-4-5");
		expect(resolved?.serviceTier).toBeUndefined();
	});

	test('"none" and unknown tier values omit the tier', () => {
		const settings = makeSettings("smol", "anthropic/claude-sonnet-4-5", { smol: "none", tiny: "turbo" });
		const resolved = resolveRoleSelection(["tiny", "smol"], settings, mockModels);
		expect(resolved?.serviceTier).toBeUndefined();
		const scoped = makeSettings("smol", "anthropic/claude-sonnet-4-5", { smol: "openai-only" });
		expect(resolveRoleSelection(["smol"], scoped, mockModels)?.serviceTier).toBe("openai-only");
	});
});

describe("resolveRoleServiceTier explicit entries", () => {
	test('"none" is explicit but carries no tier', () => {
		expect(hasExplicitRoleServiceTier({ smol: "none" }, "smol")).toBe(true);
		expect(resolveRoleServiceTier({ smol: "none" }, "smol")).toBeUndefined();
	});

	test("absent and unrecognized entries are not explicit", () => {
		expect(hasExplicitRoleServiceTier({}, "smol")).toBe(false);
		expect(hasExplicitRoleServiceTier(undefined, "smol")).toBe(false);
		expect(hasExplicitRoleServiceTier({ smol: "turbo" }, "smol")).toBe(false);
		expect(hasExplicitRoleServiceTier({ smol: "inherit" }, "smol")).toBe(false);
	});

	test("concrete tiers are explicit", () => {
		expect(hasExplicitRoleServiceTier({ smol: "priority" }, "smol")).toBe(true);
		expect(resolveRoleServiceTier({ smol: "priority" }, "smol")).toBe("priority");
		expect(hasExplicitRoleServiceTier({ smol: "flex" }, "smol")).toBe(true);
	});
});
