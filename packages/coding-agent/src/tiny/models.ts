/** Default session-title model: the online @smol path (no local download / on-device inference). */
export const ONLINE_TINY_TITLE_MODEL_KEY = "online";
/** Local model the `tiny-models` CLI downloads when none is named. Not the session-title default — that is {@link ONLINE_TINY_TITLE_MODEL_KEY}. */
export const DEFAULT_TINY_TITLE_LOCAL_MODEL_KEY = "lfm2.5-230m";

export interface TinyTitleLocalModelSpec {
	key: string;
	repo: string;
	dtype: "q4";
	label: string;
	description: string;
	contextNote: string;
	/** Model family emits hidden reasoning unless the chat template disables it. */
	reasoning?: boolean;
	/** Reason this model is blocked before loading the ONNX runtime. */
	unsupportedReason?: string;
}

export const TINY_TITLE_LOCAL_MODELS = [
	{
		key: "lfm2.5-230m",
		repo: "LiquidAI/LFM2.5-230M-ONNX",
		dtype: "q4",
		label: "LFM2.5 230M",
		description: "Recommended local model; fastest LFM2.5 option, about 214 MB cached.",
		contextNote: "Best balance among the current compact title models.",
	},
	{
		key: "lfm2.5-350m",
		repo: "onnx-community/LFM2.5-350M-ONNX",
		dtype: "q4",
		label: "LFM2.5 350M",
		description: "Larger LFM2.5 option, about 292 MB cached; tends toward terse titles.",
		contextNote: "Use when compact labels are preferred over descriptive titles.",
	},
	{
		key: "falcon-h1-90m",
		repo: "onnx-community/Falcon-H1-Tiny-90M-Instruct-ONNX",
		dtype: "q4",
		label: "Falcon H1 Tiny 90M",
		description: "Smallest option, about 147 MB cached; lower fidelity on complex prompts.",
		contextNote: "Use on constrained machines where download size matters most.",
	},
] as const satisfies readonly TinyTitleLocalModelSpec[];

export const TINY_TITLE_MODEL_VALUES = [
	ONLINE_TINY_TITLE_MODEL_KEY,
	"lfm2.5-230m",
	"lfm2.5-350m",
	"falcon-h1-90m",
] as const;

export type TinyTitleModelKey = (typeof TINY_TITLE_MODEL_VALUES)[number];
export type TinyTitleLocalModelKey = (typeof TINY_TITLE_LOCAL_MODELS)[number]["key"];

type MissingTinyTitleModelValue = Exclude<
	typeof ONLINE_TINY_TITLE_MODEL_KEY | TinyTitleLocalModelKey,
	TinyTitleModelKey
>;
type ExtraTinyTitleModelValue = Exclude<TinyTitleModelKey, typeof ONLINE_TINY_TITLE_MODEL_KEY | TinyTitleLocalModelKey>;
const TINY_TITLE_MODEL_VALUES_MATCH_REGISTRY: MissingTinyTitleModelValue extends never
	? ExtraTinyTitleModelValue extends never
		? true
		: never
	: never = true;
void TINY_TITLE_MODEL_VALUES_MATCH_REGISTRY;

export const TINY_TITLE_MODEL_OPTIONS = [
	{
		value: ONLINE_TINY_TITLE_MODEL_KEY,
		label: "Online (TINY role, else @smol)",
		description:
			"Online title generation: the TINY model role (set one in /models) when assigned, otherwise the online fallback (commit role, then @smol). No local download or on-device inference.",
	},
	...TINY_TITLE_LOCAL_MODELS.map(model => ({
		value: model.key,
		label: model.label,
		description: model.description,
	})),
] satisfies ReadonlyArray<{ value: TinyTitleModelKey; label: string; description: string }>;

export function isTinyTitleLocalModelKey(value: string): value is TinyTitleLocalModelKey {
	return TINY_TITLE_LOCAL_MODELS.some(model => model.key === value);
}

export function getTinyTitleModelSpec(key: TinyTitleLocalModelKey): (typeof TINY_TITLE_LOCAL_MODELS)[number] {
	const spec = TINY_TITLE_LOCAL_MODELS.find(model => model.key === key);
	if (!spec) throw new Error(`Unknown tiny title model: ${key}`);
	return spec;
}

/** Default memory model: the online path (the configured smol / remote LLM; no local download). */
export const ONLINE_MEMORY_MODEL_KEY = "online";
/** Recommended local model for memory tasks when none is named. */
export const DEFAULT_MEMORY_LOCAL_MODEL_KEY = "lfm2-1.2b";

/**
 * Local models for Mnemopi memory tasks (fact extraction + consolidation).
 * These are larger (1B-1.7B) than the title models: structured extraction and
 * faithful summarization need more capacity than 3-6 word titles. All q4.
 * Ranking/recipe rationale lives in docs/local-models.md.
 */
export const TINY_MEMORY_LOCAL_MODELS = [
	{
		key: "qwen3-1.7b",
		repo: "onnx-community/Qwen3-1.7B-ONNX",
		dtype: "q4",
		label: "Qwen3 1.7B",
		description:
			"Disabled for local inference: onnxruntime-node cannot run this ONNX export's RotaryEmbedding cache updates.",
		contextNote: "Blocked before load to avoid the unsupported RotaryEmbedding runtime path.",
		reasoning: true,
		unsupportedReason:
			"onnxruntime-node does not support Qwen3 RotaryEmbedding cache updates in onnx-community/Qwen3-1.7B-ONNX",
	},
	{
		key: "llama3.2:3b",
		repo: "onnx-community/Llama-3.2-3B-Instruct-ONNX",
		dtype: "q4",
		label: "Llama 3.2 3B",
		description:
			"Larger Llama 3.2 option for local memory/classifier tasks; higher quality potential at higher disk/RAM/latency cost.",
		contextNote: "Use when larger model capacity is preferred over faster load times.",
	},
	{
		key: "gemma-3-1b",
		repo: "onnx-community/gemma-3-1b-it-ONNX",
		dtype: "q4",
		label: "Gemma 3 1B",
		description: "Best consolidation/dedup; lighter footprint, but leaks small talk during extraction.",
		contextNote: "Use when consolidation quality and size matter most.",
	},
	{
		key: "qwen2.5-1.5b",
		repo: "onnx-community/Qwen2.5-1.5B-Instruct",
		dtype: "q4",
		label: "Qwen2.5 1.5B",
		description: "Best extraction granularity (atomic facts); weaker consolidation.",
		contextNote: "Use when fine-grained, deduplicatable facts matter more than summaries.",
	},
	{
		key: "lfm2-1.2b",
		repo: "onnx-community/LFM2-1.2B-ONNX",
		dtype: "q4",
		label: "LFM2 1.2B",
		description: "Fastest load; solid all-rounder, slightly noisier extraction labels.",
		contextNote: "Use when local startup cost is the priority.",
	},
] as const satisfies readonly TinyTitleLocalModelSpec[];

export const TINY_MEMORY_MODEL_VALUES = [
	ONLINE_MEMORY_MODEL_KEY,
	"qwen3-1.7b",
	"llama3.2:3b",
	"gemma-3-1b",
	"qwen2.5-1.5b",
	"lfm2-1.2b",
] as const;

export type TinyMemoryModelKey = (typeof TINY_MEMORY_MODEL_VALUES)[number];
export type TinyMemoryLocalModelKey = (typeof TINY_MEMORY_LOCAL_MODELS)[number]["key"];

type MissingTinyMemoryModelValue = Exclude<
	typeof ONLINE_MEMORY_MODEL_KEY | TinyMemoryLocalModelKey,
	TinyMemoryModelKey
>;
type ExtraTinyMemoryModelValue = Exclude<TinyMemoryModelKey, typeof ONLINE_MEMORY_MODEL_KEY | TinyMemoryLocalModelKey>;
const TINY_MEMORY_MODEL_VALUES_MATCH_REGISTRY: MissingTinyMemoryModelValue extends never
	? ExtraTinyMemoryModelValue extends never
		? true
		: never
	: never = true;
void TINY_MEMORY_MODEL_VALUES_MATCH_REGISTRY;

export const TINY_MEMORY_MODEL_OPTIONS = [
	{
		value: ONLINE_MEMORY_MODEL_KEY,
		label: "Online (TINY role, else @smol)",
		description:
			"Use the online model: the TINY role from /models when set, otherwise @smol. No local model download or on-device inference.",
	},
	...TINY_MEMORY_LOCAL_MODELS.map(model => ({
		value: model.key,
		label: model.label,
		description: model.description,
	})),
] satisfies ReadonlyArray<{ value: TinyMemoryModelKey; label: string; description: string }>;

export function isTinyMemoryLocalModelKey(value: string): value is TinyMemoryLocalModelKey {
	return TINY_MEMORY_LOCAL_MODELS.some(model => model.key === value);
}

export function getTinyMemoryModelSpec(key: TinyMemoryLocalModelKey): (typeof TINY_MEMORY_LOCAL_MODELS)[number] {
	const spec = TINY_MEMORY_LOCAL_MODELS.find(model => model.key === key);
	if (!spec) throw new Error(`Unknown tiny memory model: ${key}`);
	return spec;
}

/** Return whether a memory local model may emit reasoning tokens before answers. */
export function isTinyMemoryReasoningModelKey(key: TinyMemoryLocalModelKey): boolean {
	const spec = getTinyMemoryModelSpec(key);
	return "reasoning" in spec && spec.reasoning === true;
}

/** Any local model key (title or memory), used by the shared inference worker. */
export type TinyLocalModelKey = TinyTitleLocalModelKey | TinyMemoryLocalModelKey;

/** Resolve a local model spec by key across both the title and memory registries. */
export function getTinyLocalModelSpec(key: string): TinyTitleLocalModelSpec | undefined {
	return (
		TINY_TITLE_LOCAL_MODELS.find(model => model.key === key) ??
		TINY_MEMORY_LOCAL_MODELS.find(model => model.key === key)
	);
}

export function isTinyLocalModelKey(value: string): value is TinyLocalModelKey {
	return getTinyLocalModelSpec(value) !== undefined;
}

/** Combined local model registry (title + memory) for the shared tiny-models CLI. */
export const TINY_LOCAL_MODELS = [
	...TINY_TITLE_LOCAL_MODELS,
	...TINY_MEMORY_LOCAL_MODELS,
] as const satisfies readonly TinyTitleLocalModelSpec[];

/**
 * Difficulty-classifier model for the `auto` thinking level. Defaults to the
 * online smol path; the local options reuse the memory-model registry because
 * the shared worker's `complete()` only accepts memory local keys, and the
 * 1B+ memory models classify coding difficulty far more reliably than the
 * sub-1B title models.
 */
export const ONLINE_AUTO_THINKING_MODEL_KEY = ONLINE_MEMORY_MODEL_KEY;
export const AUTO_THINKING_MODEL_VALUES = TINY_MEMORY_MODEL_VALUES;
export type AutoThinkingModelKey = TinyMemoryModelKey;

export const AUTO_THINKING_MODEL_OPTIONS = [
	{
		value: ONLINE_AUTO_THINKING_MODEL_KEY,
		label: "Online (TINY role, else @smol)",
		description:
			"Classify prompt difficulty online with the TINY role model (set one in /models) or @smol; no local download or on-device inference.",
	},
	...TINY_MEMORY_LOCAL_MODELS.map(model => ({
		value: model.key,
		label: model.label,
		description: model.description,
	})),
] satisfies ReadonlyArray<{ value: AutoThinkingModelKey; label: string; description: string }>;
