import { bareModelId, parseAnthropicModel, parseGlmModel, semverGte } from "./identity/classify";
import type { ModelTokenizer } from "./types";

const DEEPSEEK_V3_ALIASES: Record<string, true> = {
	"deepseek-chat": true,
	"deepseek-reasoner": true,
};
const KIMI_K2_ALIASES: Record<string, true> = {
	"kimi-for-coding": true,
	"kimi-for-coding-highspeed": true,
};

// Resolution is pure and catalog ids recur across providers and aliases.
const MAX_TOKENIZER_CACHE_ENTRIES = 2_048;
const modelTokenizerCache = new Map<string, ModelTokenizer | null>();

function claudeTokenizer(modelId: string): ModelTokenizer | undefined {
	const parsed = parseAnthropicModel(modelId);
	if (parsed) {
		if (parsed.kind === "opus") {
			if (semverGte(parsed.version, "5")) return "claude-v5";
			if (semverGte(parsed.version, "4.7")) return "claude-v47";
			return "claude-v3";
		}
		return semverGte(parsed.version, "5") ? "claude-v5-sonnet" : "claude-v3";
	}
	return /(^|[-/.:])claude([-.:]|$)/i.test(modelId) ? "claude-v3" : undefined;
}

function qwenTokenizer(modelId: string): ModelTokenizer | undefined {
	const version = /qwen[-_ ]?(\d+)\.(\d+)(?![\dbB])/i.exec(modelId);
	if (!version) return undefined;
	const major = Number.parseInt(version[1], 10);
	const minor = Number.parseInt(version[2], 10);
	return major > 3 || (major === 3 && minor >= 5) ? "qwen3" : undefined;
}

function deepSeekTokenizer(modelId: string): ModelTokenizer | undefined {
	const lower = modelId.toLowerCase();
	if (lower.includes("distill")) return undefined;
	if (DEEPSEEK_V3_ALIASES[lower]) return "deepseek-v3";
	return /(?:^|[-_.:])(?:v?[34]|r1)(?:[-_.:]|$)/.test(lower) && lower.includes("deepseek") ? "deepseek-v3" : undefined;
}

function kimiTokenizer(modelId: string): ModelTokenizer | undefined {
	const lower = modelId.toLowerCase();
	if (KIMI_K2_ALIASES[lower]) return "kimi-k2";
	return /(?:^|[-_.:])kimi[-_.:]?k?[23](?:[-_.:]|$)/.test(lower) ? "kimi-k2" : undefined;
}

function glmTokenizer(modelId: string): ModelTokenizer | undefined {
	const glm = parseGlmModel(modelId);
	return glm && semverGte(glm.version, "5") ? "glm5" : undefined;
}

/**
 * Resolve the exact locally embedded tokenizer for a canonical model id.
 *
 * This is catalog policy, not a runtime caller heuristic: [`buildModel`](./build.ts)
 * materializes the result as `Model.tokenizer`; consumers read that property.
 */
export function resolveModelTokenizer(modelId: string): ModelTokenizer | undefined {
	const cached = modelTokenizerCache.get(modelId);
	if (cached !== undefined) return cached ?? undefined;
	const bare = bareModelId(modelId);
	const tokenizer =
		claudeTokenizer(bare) ??
		qwenTokenizer(bare) ??
		deepSeekTokenizer(bare) ??
		kimiTokenizer(bare) ??
		glmTokenizer(bare);
	if (modelTokenizerCache.size === MAX_TOKENIZER_CACHE_ENTRIES) modelTokenizerCache.clear();
	modelTokenizerCache.set(modelId, tokenizer ?? null);
	return tokenizer;
}
