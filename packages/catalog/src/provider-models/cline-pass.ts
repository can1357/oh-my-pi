import { Effort } from "../effort";
import type { ModelSpec, ThinkingConfig } from "../types";

type ClinePassCost = ModelSpec<"openai-completions">["cost"];
type ClinePassInput = ModelSpec<"openai-completions">["input"];

export interface ClinePassModelMetadata {
	name: string;
	contextWindow: number;
	maxTokens: number;
	input: ClinePassInput;
	cost: ClinePassCost;
	reasoning: boolean;
	thinking?: ThinkingConfig;
	tier: "subscription" | "free";
}

const LOW_HIGH_MAX: ThinkingConfig = {
	mode: "effort",
	efforts: [Effort.Low, Effort.High, Effort.Max],
	defaultLevel: Effort.High,
	requiresEffort: false,
};

const HIGH_XHIGH: ThinkingConfig = {
	mode: "effort",
	efforts: [Effort.High, Effort.XHigh],
	requiresEffort: false,
};

const LOW_TO_MAX: ThinkingConfig = {
	mode: "effort",
	efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
	requiresEffort: false,
};

const QWEN_38_EFFORTS: ThinkingConfig = {
	mode: "effort",
	efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
	requiresEffort: true,
};

const QWEN_37_BUDGETS: ThinkingConfig = {
	mode: "budget",
	efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
	defaultLevel: Effort.High,
	requiresEffort: false,
	// Cline derives these from its 10/20/50/80/95/100% effort ratios and
	// the model's 131,072-token output ceiling, capped by the advertised
	// 262,144-token reasoning maximum.
	effortBudgets: {
		[Effort.Minimal]: 13_107,
		[Effort.Low]: 26_214,
		[Effort.Medium]: 65_536,
		[Effort.High]: 104_857,
		[Effort.XHigh]: 124_518,
		[Effort.Max]: 131_072,
	},
};

/**
 * ClinePass metadata published by Cline CLI 3.0.58 / @cline/llms 0.0.79.
 * The public recommended-models endpoint remains authoritative for membership;
 * this snapshot supplies the exact limits, plan pricing, and reasoning controls
 * that endpoint omits, including a deterministic offline catalog floor.
 */
export const CLINE_PASS_MODEL_METADATA: Readonly<Record<string, ClinePassModelMetadata>> = {
	"kimi-k3": {
		name: "Kimi K3",
		contextWindow: 1_048_576,
		maxTokens: 1_048_576,
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
		reasoning: true,
		thinking: LOW_HIGH_MAX,
		tier: "subscription",
	},
	"qwen3.8-max": {
		name: "Qwen3.8 Max",
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		input: ["text", "image"],
		cost: { input: 2, output: 6, cacheRead: 0.25, cacheWrite: 2.5 },
		reasoning: true,
		thinking: QWEN_38_EFFORTS,
		tier: "subscription",
	},
	"deepseek-v4-flash": {
		name: "DeepSeek V4 Flash",
		contextWindow: 1_048_576,
		maxTokens: 384_000,
		input: ["text"],
		cost: { input: 0.056, output: 0.112, cacheRead: 0.0112, cacheWrite: 0 },
		reasoning: true,
		thinking: HIGH_XHIGH,
		tier: "subscription",
	},
	"glm-5.2": {
		name: "GLM-5.2",
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		input: ["text"],
		cost: { input: 0.966, output: 3.036, cacheRead: 0.1932, cacheWrite: 0 },
		reasoning: true,
		thinking: LOW_HIGH_MAX,
		tier: "subscription",
	},
	"deepseek-v4-pro": {
		name: "DeepSeek V4 Pro",
		contextWindow: 1_048_576,
		maxTokens: 384_000,
		input: ["text"],
		cost: { input: 0.522, output: 1.044, cacheRead: 0.0435, cacheWrite: 0 },
		reasoning: true,
		thinking: HIGH_XHIGH,
		tier: "subscription",
	},
	"qwen3.7-max": {
		name: "Qwen3.7 Max",
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		input: ["text"],
		cost: { input: 1.475, output: 4.425, cacheRead: 0.295, cacheWrite: 1.84375 },
		reasoning: true,
		thinking: HIGH_XHIGH,
		tier: "subscription",
	},
	"qwen3.7-plus": {
		name: "Qwen3.7 Plus",
		contextWindow: 1_000_000,
		maxTokens: 131_072,
		input: ["text", "image"],
		cost: { input: 0.32, output: 1.28, cacheRead: 0.064, cacheWrite: 0.4 },
		reasoning: true,
		thinking: QWEN_37_BUDGETS,
		tier: "subscription",
	},
	"minimax-m3": {
		name: "MiniMax-M3",
		contextWindow: 1_048_576,
		maxTokens: 512_000,
		input: ["text", "image"],
		cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
		reasoning: true,
		tier: "subscription",
	},
	"kimi-k2.7-code": {
		name: "Kimi K2.7 Code",
		contextWindow: 262_144,
		maxTokens: 262_144,
		input: ["text", "image"],
		cost: { input: 0.67, output: 3.4, cacheRead: 0.19, cacheWrite: 0 },
		reasoning: true,
		tier: "subscription",
	},
	"kimi-k2.6": {
		name: "Kimi K2.6",
		contextWindow: 262_144,
		maxTokens: 262_144,
		input: ["text", "image"],
		cost: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
		reasoning: true,
		tier: "subscription",
	},
	"glm-5.3": {
		name: "GLM-5.3",
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		input: ["text"],
		cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
		reasoning: true,
		thinking: LOW_HIGH_MAX,
		tier: "subscription",
	},
	"mimo-v2.5-pro": {
		name: "MiMo-V2.5-Pro",
		contextWindow: 1_050_000,
		maxTokens: 131_072,
		input: ["text"],
		cost: { input: 0.435, output: 0.87, cacheRead: 0.0036, cacheWrite: 0 },
		reasoning: true,
		tier: "subscription",
	},
	"mimo-v2.5": {
		name: "MiMo-V2.5",
		contextWindow: 1_050_000,
		maxTokens: 131_072,
		input: ["text", "image"],
		cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
		reasoning: true,
		tier: "subscription",
	},
	"stealth/ox-alpha": {
		name: "Ox Alpha (free)",
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: true,
		thinking: LOW_TO_MAX,
		tier: "free",
	},
	"deepseek/deepseek-v4-flash": {
		name: "DeepSeek V4 Flash (free)",
		contextWindow: 1_048_576,
		maxTokens: 384_000,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: true,
		thinking: HIGH_XHIGH,
		tier: "free",
	},
	"poolside/laguna-s-2.1:free": {
		name: "Laguna S 2.1 (free)",
		contextWindow: 262_144,
		maxTokens: 32_768,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: true,
		tier: "free",
	},
};

export function getClinePassModelMetadata(id: string): ClinePassModelMetadata | undefined {
	return CLINE_PASS_MODEL_METADATA[id];
}
