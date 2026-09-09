import type { TinyModelDtype } from "../tiny/dtype";

/**
 * On-device speech-to-text model registry. Each tier maps a stable settings key
 * onto a locally-runnable ASR model and the engine that loads it:
 *
 * - `transformers` — a transformers.js / ONNX Whisper repo, loaded by the
 *   `@huggingface/transformers` `automatic-speech-recognition` pipeline.
 * - `sherpa` — a sherpa-onnx (Next-gen Kaldi) offline model, loaded by the
 *   native `sherpa-onnx-node` addon. Used for NVIDIA Parakeet, the Open ASR
 *   Leaderboard accuracy/speed leader.
 *
 * The worker resolves the spec by key and loads the model lazily (kept warm
 * afterwards). Both engines run inside the hard-killed subprocess worker.
 */

/** ASR runtime that loads a given tier's model. */
export type SttEngine = "transformers" | "sherpa";

interface SttModelBase {
	/** Stable key persisted in `stt.modelName` and sent over the worker protocol. */
	key: string;
	engine: SttEngine;
	/** Hugging Face repo id (transformers.js ONNX repo, or sherpa-onnx model repo). */
	repo: string;
	/** English-only checkpoint: rejects a configured source `language`. */
	englishOnly: boolean;
	label: string;
	description: string;
	/** Approximate on-disk download size for the shipped weights (UI hint). */
	sizeHint: string;
}

/** A Whisper-family tier loaded via the transformers.js ASR pipeline. */
export interface TransformersSttModelSpec extends SttModelBase {
	engine: "transformers";
	/** ONNX precision used unless overridden by `PI_TINY_DTYPE` / `providers.tinyModelDtype`. */
	dtype: TinyModelDtype;
}

/** A sherpa-onnx offline tier (e.g. NeMo Parakeet transducer) loaded natively. */
export interface SherpaSttModelSpec extends SttModelBase {
	engine: "sherpa";
	/** sherpa-onnx offline model family (e.g. `nemo_transducer`). */
	modelType: string;
	/** Model files (relative to the repo root) fetched into the local cache. */
	files: { encoder: string; decoder: string; joiner: string; tokens: string };
}

export type SttModelSpec = TransformersSttModelSpec | SherpaSttModelSpec;

/**
 * Speech model tiers, ordered light → SoTA. Defaults to {@link DEFAULT_STT_MODEL_KEY}.
 * `fast`/`balanced`/`turbo` are multilingual Whisper checkpoints on transformers.js;
 * `parakeet` is NVIDIA Parakeet TDT 0.6B v3 on sherpa-onnx — the Open ASR
 * Leaderboard leader (lower WER and far higher throughput than Whisper).
 */
export const STT_MODELS = [
	{
		key: "fast",
		engine: "transformers",
		repo: "onnx-community/whisper-base",
		dtype: "q8",
		englishOnly: false,
		label: "Fast (Whisper base)",
		description: "Whisper base, multilingual. Smallest + fastest; lowest accuracy. Best for low-resource machines.",
		sizeHint: "~60 MB",
	},
	{
		key: "balanced",
		engine: "transformers",
		repo: "onnx-community/whisper-small",
		dtype: "q8",
		englishOnly: false,
		label: "Balanced (Whisper small)",
		description: "Whisper small, multilingual. More accurate than Fast, still light on CPU/RAM.",
		sizeHint: "~190 MB",
	},
	{
		key: "turbo",
		engine: "transformers",
		repo: "onnx-community/whisper-large-v3-turbo",
		dtype: "q4",
		englishOnly: false,
		label: "Turbo (Whisper large-v3)",
		description: "Whisper large-v3-turbo, 99 languages. Widest language coverage; large download, slower.",
		sizeHint: "~600 MB",
	},
	{
		key: "parakeet",
		engine: "sherpa",
		repo: "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
		modelType: "nemo_transducer",
		files: {
			encoder: "encoder.int8.onnx",
			decoder: "decoder.int8.onnx",
			joiner: "joiner.int8.onnx",
			tokens: "tokens.txt",
		},
		englishOnly: false,
		label: "Parakeet TDT v3 (SoTA)",
		description:
			"NVIDIA Parakeet TDT 0.6B v3, 25 languages. Open ASR Leaderboard leader — best accuracy and far fastest decoding. Default.",
		sizeHint: "~680 MB",
	},
] as const satisfies readonly SttModelSpec[];

/**
 * SoTA default — NVIDIA Parakeet TDT 0.6B v3 (sherpa-onnx). Tops the Open ASR
 * Leaderboard on accuracy while decoding ~20× faster than Whisper large-v3.
 */
export const DEFAULT_STT_MODEL_KEY = "parakeet";

export type SttModelKey = (typeof STT_MODELS)[number]["key"];

/** A concrete entry from {@link STT_MODELS}; `key` is the literal tier union. */
export type SttModel = (typeof STT_MODELS)[number];

export const STT_MODEL_VALUES = ["fast", "balanced", "turbo", "parakeet"] as const satisfies readonly SttModelKey[];

type MissingSttModelValue = Exclude<SttModelKey, (typeof STT_MODEL_VALUES)[number]>;
type ExtraSttModelValue = Exclude<(typeof STT_MODEL_VALUES)[number], SttModelKey>;
const STT_MODEL_VALUES_MATCH_REGISTRY: MissingSttModelValue extends never
	? ExtraSttModelValue extends never
		? true
		: never
	: never = true;
void STT_MODEL_VALUES_MATCH_REGISTRY;

export const STT_MODEL_OPTIONS = STT_MODELS.map(({ key, label, description }) => ({
	value: key,
	label,
	description,
})) satisfies ReadonlyArray<{ value: SttModelKey; label: string; description: string }>;

export function isSttModelKey(value: string): value is SttModelKey {
	return STT_MODELS.some(model => model.key === value);
}

export function getSttModelSpec(key: string): SttModel | undefined {
	return STT_MODELS.find(model => model.key === key);
}

/**
 * Resolve a (possibly stale or legacy) `stt.modelName` value onto a concrete
 * spec, falling back to the SoTA default when the key is unknown.
 */
export function resolveSttModelSpec(key: string | undefined): SttModel {
	return (key !== undefined ? getSttModelSpec(key) : undefined) ?? getSttModelSpec(DEFAULT_STT_MODEL_KEY)!;
}
