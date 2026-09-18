import type { TinyModelDtype } from "../tiny/dtype";

/**
 * On-device speech-to-text registry. Each stable settings key selects either a
 * bundled worker runtime or Apple's system speech service:
 *
 * - `transformers` — a transformers.js / ONNX Whisper repo, loaded by the
 *   `@huggingface/transformers` `automatic-speech-recognition` pipeline.
 * - `sherpa` — a sherpa-onnx (Next-gen Kaldi) offline model, loaded by the
 *   native `sherpa-onnx-node` addon. Used for NVIDIA Parakeet, the Open ASR
 *   Leaderboard accuracy/speed leader.
 * - `speech-analyzer` — macOS 26 SpeechAnalyzer + SpeechTranscriber, with
 *   locale assets installed and managed by the operating system.
 *
 * Worker models load lazily in the hard-killed STT subprocess. SpeechAnalyzer
 * runs in its own native sidecar and must never be sent to that worker.
 */

/** Runtime that transcribes a selected speech tier. */
export type SttEngine = "transformers" | "sherpa" | "speech-analyzer";

interface SttModelBase {
	/** Stable key persisted in `stt.modelName`. */
	key: string;
	engine: SttEngine;
	label: string;
	description: string;
	/** Approximate storage requirement shown by setup UI. */
	sizeHint: string;
}

interface WorkerSttModelBase extends SttModelBase {
	engine: "transformers" | "sherpa";
	/** Hugging Face repo id (transformers.js ONNX repo, or sherpa-onnx model repo). */
	repo: string;
	/** English-only checkpoint: rejects a configured source `language`. */
	englishOnly: boolean;
}

/** A Whisper-family tier loaded via the transformers.js ASR pipeline. */
export interface TransformersSttModelSpec extends WorkerSttModelBase {
	engine: "transformers";
	/** ONNX precision used unless overridden by `PI_TINY_DTYPE` / `providers.tinyModelDtype`. */
	dtype: TinyModelDtype;
}

/** A sherpa-onnx offline tier (e.g. NeMo Parakeet transducer) loaded natively. */
export interface SherpaSttModelSpec extends WorkerSttModelBase {
	engine: "sherpa";
	/** sherpa-onnx offline model family (e.g. `nemo_transducer`). */
	modelType: string;
	/** Model files (relative to the repo root) fetched into the local cache. */
	files: { encoder: string; decoder: string; joiner: string; tokens: string };
}

/** Apple's system-managed on-device transcriber on macOS 26 and later. */
export interface SpeechAnalyzerSttModelSpec extends SttModelBase {
	engine: "speech-analyzer";
}

export type SttModelSpec = TransformersSttModelSpec | SherpaSttModelSpec | SpeechAnalyzerSttModelSpec;

/**
 * Speech engines exposed by settings. Parakeet remains the cross-platform
 * default; `macos` is an opt-in system engine with no application-managed
 * model download.
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
	{
		key: "macos",
		engine: "speech-analyzer",
		label: "Apple SpeechAnalyzer (macOS 26+)",
		description:
			"Apple on-device SpeechTranscriber with live partials and system-managed locale assets. Requires macOS 26 or later.",
		sizeHint: "System-managed",
	},
] as const satisfies readonly SttModelSpec[];

/**
 * SoTA default — NVIDIA Parakeet TDT 0.6B v3 (sherpa-onnx). Tops the Open ASR
 * Leaderboard on accuracy while decoding ~20× faster than Whisper large-v3.
 */
export const DEFAULT_STT_MODEL_KEY = "parakeet";

/** Literal key union persisted in `stt.modelName`. */
export type ConfiguredSttModelKey = (typeof STT_MODELS)[number]["key"];

/** A concrete entry from {@link STT_MODELS}. */
export type SttModel = (typeof STT_MODELS)[number];
export type WorkerSttModel = Exclude<SttModel, { readonly engine: "speech-analyzer" }>;
/** Model key accepted by the ONNX/sherpa worker protocol. */
export type SttModelKey = WorkerSttModel["key"];
export type WorkerSttModelKey = SttModelKey;

export const STT_MODEL_VALUES = [
	"fast",
	"balanced",
	"turbo",
	"parakeet",
	"macos",
] as const satisfies readonly ConfiguredSttModelKey[];

type MissingSttModelValue = Exclude<ConfiguredSttModelKey, (typeof STT_MODEL_VALUES)[number]>;
type ExtraSttModelValue = Exclude<(typeof STT_MODEL_VALUES)[number], ConfiguredSttModelKey>;
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
})) satisfies ReadonlyArray<{ value: ConfiguredSttModelKey; label: string; description: string }>;

export function isSttModelKey(value: string): value is ConfiguredSttModelKey {
	return STT_MODELS.some(model => model.key === value);
}

export function getSttModelSpec(key: string): SttModel | undefined {
	return STT_MODELS.find(model => model.key === key);
}

/** Return only models accepted by the ONNX/sherpa worker protocol. */
export function getWorkerSttModelSpec(key: string): WorkerSttModel | undefined {
	const spec = getSttModelSpec(key);
	return spec?.engine === "speech-analyzer" ? undefined : spec;
}

/**
 * Resolve a (possibly stale or legacy) `stt.modelName` value onto a concrete
 * spec, falling back to the SoTA default when the key is unknown.
 */
export function resolveSttModelSpec(key: string | undefined): SttModel {
	return (key !== undefined ? getSttModelSpec(key) : undefined) ?? getSttModelSpec(DEFAULT_STT_MODEL_KEY)!;
}

/** Resolve a worker model while refusing the native SpeechAnalyzer engine. */
export function resolveWorkerSttModelSpec(key: string | undefined): WorkerSttModel {
	const spec = resolveSttModelSpec(key);
	if (spec.engine === "speech-analyzer") {
		throw new Error("Apple SpeechAnalyzer is a native STT engine, not a worker model.");
	}
	return spec;
}
