import { homedir } from "node:os";
import { join } from "node:path";
import {
	type Env,
	envBool,
	envDisabled,
	envFloat,
	envInt,
	envOneOf,
	envOptionalString,
	envString,
	envTruthy,
} from "./util/env";

export type { Env };
export { envBool, envDisabled, envFloat, envInt, envOneOf, envOptionalString, envString, envTruthy };

export const DEFAULT_DATA_DIR = join(homedir(), ".hermes", "mnemopi", "data");
export const DEFAULT_DB_FILENAME = "mnemopi.db";

export const DEFAULT_EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5";
export const DEFAULT_EMBEDDING_API_URL = "https://openrouter.ai/api/v1";

export type VecType = "float32" | "int8" | "bit";

export const EMBEDDING_DIMS: Readonly<Record<string, number>> = {
	"BAAI/bge-small-en-v1.5": 384,
	"BAAI/bge-base-en-v1.5": 768,
	"BAAI/bge-large-en-v1.5": 1024,
	"BAAI/bge-small-zh-v1.5": 512,
	"BAAI/bge-base-zh-v1.5": 768,
	"BAAI/bge-large-zh-v1.5": 1024,
	"intfloat/multilingual-e5-small": 384,
	"intfloat/multilingual-e5-base": 768,
	"intfloat/multilingual-e5-large": 1024,
	"BAAI/bge-m3": 1024,
	"BAAI/bge-multilingual-gemma2": 3584,
	"openai/text-embedding-3-small": 1536,
	"openai/text-embedding-3-large": 3072,
	"text-embedding-3-small": 1536,
	"text-embedding-3-large": 3072,
	"jina-embeddings-v5-omni-nano": 768,
	"jina-embeddings-v5-omni-small": 1024,
};

export const VERACITY_WEIGHT_DEFAULTS = {
	stated: 1.0,
	inferred: 0.7,
	tool: 0.5,
	imported: 0.6,
	unknown: 0.8,
} as const;

export function dataDir(env: Env = process.env): string {
	return envOptionalString("MNEMOPI_DATA_DIR", env) ?? DEFAULT_DATA_DIR;
}

export function dbPath(env: Env = process.env): string {
	return join(dataDir(env), DEFAULT_DB_FILENAME);
}

export function embeddingModel(env: Env = process.env): string {
	return envString("MNEMOPI_EMBEDDING_MODEL", DEFAULT_EMBEDDING_MODEL, env);
}

export function embeddingDim(env: Env = process.env): number {
	const explicit = envInt("MNEMOPI_EMBEDDING_DIM", NaN, env);
	if (Number.isFinite(explicit)) return explicit;
	return EMBEDDING_DIMS[embeddingModel(env)] ?? 384;
}

export function embeddingApiKey(env: Env = process.env): string {
	return envString(
		"MNEMOPI_EMBEDDING_API_KEY",
		envString("OPENROUTER_API_KEY", envString("OPENAI_API_KEY", "", env), env),
		env,
	);
}

export function embeddingApiUrl(env: Env = process.env): string {
	return envString("MNEMOPI_EMBEDDING_API_URL", envString("OPENROUTER_BASE_URL", DEFAULT_EMBEDDING_API_URL, env), env);
}

export function embeddingsDisabled(env: Env = process.env): boolean {
	return envString("MNEMOPI_NO_EMBEDDINGS", "", env) !== "";
}

/**
 * Per-input character cap applied inside `embed()` before any provider sees the text.
 *
 * Long retention transcripts (full multi-turn session windows) routinely outgrow
 * embedding model context windows: BGE/E5 defaults are 512 tokens, bge-m3 is
 * 8192, and OpenAI's text-embedding-3-* is 8192. llama.cpp's `/embeddings`
 * server rejects oversized requests with `request (N tokens) exceeds the
 * available context size`; OpenAI silently right-truncates. Capping at the
 * source gives both backends deterministic behavior and prevents the silent
 * recall degradation we saw in issue #3126.
 *
 * Default `8192` chars is intentionally conservative for 8192-token embedding
 * contexts (bge-m3, OpenAI text-embedding-3) and CJK-heavy transcripts. Raise
 * it for larger local contexts (for example Qwen3-Embedding with 32k ctx).
 * `0` disables the cap.
 */
export function embeddingMaxInputChars(env: Env = process.env): number {
	return Math.max(0, envInt("MNEMOPI_EMBEDDING_MAX_INPUT_CHARS", 8192, env));
}

export function workingMemoryTtlHours(env: Env = process.env): number {
	return envInt("MNEMOPI_WM_TTL_HOURS", 24, env);
}

export function maxEpisodeChars(env: Env = process.env): number {
	return Math.max(1, envInt("MNEMOPI_MAX_EPISODE_CHARS", 100000, env));
}

export function recencyHalflifeHours(env: Env = process.env): number {
	return envFloat("MNEMOPI_RECENCY_HALFLIFE", 168, env);
}

/** Recall-time score multiplier for an episodic row still at degradation tier 1. */
export function tier1Weight(env: Env = process.env): number {
	return envFloat("MNEMOPI_TIER1_WEIGHT", 1.0, env);
}

/** Recall-time score multiplier for an episodic row degraded to tier 2. */
export function tier2Weight(env: Env = process.env): number {
	return envFloat("MNEMOPI_TIER2_WEIGHT", 0.85, env);
}

/** Recall-time score multiplier for an episodic row degraded to tier 3 or beyond. */
export function tier3Weight(env: Env = process.env): number {
	return envFloat("MNEMOPI_TIER3_WEIGHT", 0.7, env);
}

export function statedWeight(env: Env = process.env): number {
	return envFloat("MNEMOPI_STATED_WEIGHT", VERACITY_WEIGHT_DEFAULTS.stated, env);
}

export function inferredWeight(env: Env = process.env): number {
	return envFloat("MNEMOPI_INFERRED_WEIGHT", VERACITY_WEIGHT_DEFAULTS.inferred, env);
}

export function toolWeight(env: Env = process.env): number {
	return envFloat("MNEMOPI_TOOL_WEIGHT", VERACITY_WEIGHT_DEFAULTS.tool, env);
}

export function importedWeight(env: Env = process.env): number {
	return envFloat("MNEMOPI_IMPORTED_WEIGHT", VERACITY_WEIGHT_DEFAULTS.imported, env);
}

export function unknownWeight(env: Env = process.env): number {
	return envFloat("MNEMOPI_UNKNOWN_WEIGHT", VERACITY_WEIGHT_DEFAULTS.unknown, env);
}

export function vecType(env: Env = process.env): VecType {
	return envOneOf("MNEMOPI_VEC_TYPE", ["float32", "int8", "bit"] as const, "int8", env);
}

export function vectorWeight(env: Env = process.env): number {
	return envFloat("MNEMOPI_VEC_WEIGHT", 0.5, env);
}

export function ftsWeight(env: Env = process.env): number {
	return envFloat("MNEMOPI_FTS_WEIGHT", 0.3, env);
}

export function importanceWeight(env: Env = process.env): number {
	return envFloat("MNEMOPI_IMPORTANCE_WEIGHT", 0.2, env);
}

export function normalizedRecallWeights(
	vec = vectorWeight(),
	fts = ftsWeight(),
	importance = importanceWeight(),
): readonly [number, number, number] {
	const vw = Math.max(0, vec);
	const fw = Math.max(0, fts);
	const iw = Math.max(0, importance);
	const total = vw + fw + iw;
	if (total === 0) {
		return [0.5, 0.3, 0.2];
	}
	const epsilon = 1e-10;
	if (Math.abs(total - 1) < epsilon) {
		return [vw, fw, iw];
	}
	return [vw / total, fw / total, iw / total];
}

export interface RecallFeatureFlags {
	polyphonicRecall?: boolean;
	enhancedRecall?: boolean;
	proactiveLinking?: boolean;
}

let polyphonicRecallDefault = false;
let enhancedRecallDefault = false;
let proactiveLinkingDefault = false;

/**
 * Sets process-wide defaults for the env-gated recall features. Hosts that open
 * several memories with different policies should pass the per-instance
 * `polyphonicRecall` / `enhancedRecall` / `proactiveLinking` options instead
 * (`Mnemopi` / `BeamMemory` constructors), which take precedence over these
 * defaults. The `MNEMOPI_POLYPHONIC_RECALL` / `MNEMOPI_ENHANCED_RECALL` /
 * `MNEMOPI_PROACTIVE_LINKING` environment variables still win whenever they are set.
 */
export function configureRecallFeatures(flags: RecallFeatureFlags): void {
	if (flags.polyphonicRecall !== undefined) polyphonicRecallDefault = flags.polyphonicRecall;
	if (flags.enhancedRecall !== undefined) enhancedRecallDefault = flags.enhancedRecall;
	if (flags.proactiveLinking !== undefined) proactiveLinkingDefault = flags.proactiveLinking;
}

/**
 * Resolves the polyphonic recall gate: the env var wins when set, then the
 * per-instance `configured` value, then the process-wide default.
 */
export function polyphonicRecallEnabled(env: Env = process.env, configured?: boolean): boolean {
	const value = envOptionalString("MNEMOPI_POLYPHONIC_RECALL", env);
	return value === undefined ? (configured ?? polyphonicRecallDefault) : value === "1";
}

export function temporalHalflifeHours(env: Env = process.env): number {
	return envFloat("MNEMOPI_TEMPORAL_HALFLIFE_HOURS", 24, env);
}

/**
 * Resolves the enhanced recall (query result cache) gate: the env var wins when
 * set, then the per-instance `configured` value, then the process-wide default.
 */
export function enhancedRecallEnabled(env: Env = process.env, configured?: boolean): boolean {
	const value = envOptionalString("MNEMOPI_ENHANCED_RECALL", env);
	return value === undefined ? (configured ?? enhancedRecallDefault) : value === "1";
}

export function proactiveLinkingEnabled(env: Env = process.env): boolean {
	const value = envOptionalString("MNEMOPI_PROACTIVE_LINKING", env);
	return value === undefined ? proactiveLinkingDefault : value === "1";
}

export function llmEnabled(env: Env = process.env): boolean {
	return envBool("MNEMOPI_LLM_ENABLED", true, env);
}

export function llmMaxTokens(env: Env = process.env): number {
	return envInt("MNEMOPI_LLM_MAX_TOKENS", 2048, env);
}

export function llmContext(env: Env = process.env): number {
	return envInt("MNEMOPI_LLM_N_CTX", 2048, env);
}

export function llmBaseUrl(env: Env = process.env): string {
	return envString("MNEMOPI_LLM_BASE_URL", "", env).replace(/\/+$/, "");
}

export function llmApiKey(env: Env = process.env): string {
	return envString("MNEMOPI_LLM_API_KEY", "", env);
}

export function llmModel(env: Env = process.env): string {
	return envString("MNEMOPI_LLM_MODEL", "", env);
}

export function hostLlmEnabled(env: Env = process.env): boolean {
	return envBool("MNEMOPI_HOST_LLM_ENABLED", false, env);
}

export function sleepPrompt(env: Env = process.env): string {
	return envString("MNEMOPI_SLEEP_PROMPT", "", env).trim();
}
