import type { TinyModelDtype } from "../tiny/dtype";

/**
 * On-device speech-to-text model registry. Each tier maps a stable settings key
 * onto a locally-runnable ASR model and the engine that loads it:
 *
 * - `transformers` — a transformers.js / ONNX Whisper repo, loaded by the
 *   `@huggingface/transformers` `automatic-speech-recognition` pipeline.
 * - `sherpa` — a sherpa-onnx (Next-gen Kaldi) offline or native streaming model,
 *   loaded by the native `sherpa-onnx-node` addon. Used for the Parakeet-family
 *   transducers (Fluid Speech Pro, Parakeet) and Nemotron.
 *
 * The worker resolves the spec by key and loads the model lazily (kept warm
 * afterwards). Both engines run inside the hard-killed subprocess worker.
 */

/** ASR runtime that loads a given tier's model. */
export type SttEngine = "transformers" | "sherpa";

interface SttModelBase {
	/** Canonical catalog model id sent over the worker protocol. */
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

/** A sherpa-onnx tier loaded natively, with offline or online recognition. */
export interface SherpaSttModelSpec extends SttModelBase {
	engine: "sherpa";
	/** Recognizer API: offline utterance decoding or native online streaming. */
	mode: "offline" | "online";
	/** sherpa-onnx model family (e.g. `nemo_transducer`); empty for automatic detection. */
	modelType: string;
	/** Model files (relative to the repo root) fetched into the local cache. */
	files: { encoder: string; decoder: string; joiner: string; tokens: string };
	/** ONNX external-data weight files the graphs in `files` load by relative name; fetched alongside them. */
	externalData: readonly string[];
}

export type SttModelSpec = TransformersSttModelSpec | SherpaSttModelSpec;

/**
 * Speech models. Defaults to the multilingual {@link DEFAULT_STT_MODEL_KEY}.
 * Whisper uses transformers.js; the Parakeet-family transducers and native
 * streaming Nemotron use sherpa-onnx.
 */
export const STT_MODELS = [
	{
		key: "whisper-base",
		engine: "transformers",
		repo: "onnx-community/whisper-base",
		dtype: "q8",
		englishOnly: false,
		label: "Fast (Whisper base)",
		description: "Whisper base, multilingual. Smallest + fastest; lowest accuracy. Best for low-resource machines.",
		sizeHint: "~60 MB",
	},
	{
		key: "whisper-small",
		engine: "transformers",
		repo: "onnx-community/whisper-small",
		dtype: "q8",
		englishOnly: false,
		label: "Balanced (Whisper small)",
		description: "Whisper small, multilingual. More accurate than Fast, still light on CPU/RAM.",
		sizeHint: "~190 MB",
	},
	{
		key: "whisper-large-v3-turbo",
		engine: "transformers",
		repo: "onnx-community/whisper-large-v3-turbo",
		dtype: "q4",
		englishOnly: false,
		label: "Turbo (Whisper large-v3)",
		description: "Whisper large-v3-turbo, 99 languages. Widest language coverage; large download, slower.",
		sizeHint: "~600 MB",
	},
	{
		key: "fluid-speech-pro",
		engine: "sherpa",
		mode: "offline",
		repo: "FluidVoice-Labs/fluid-speech-pro-onnx",
		modelType: "nemo_transducer",
		files: {
			encoder: "encoder-model.int8.onnx",
			decoder: "decoder.int8.onnx",
			joiner: "joiner.int8.onnx",
			tokens: "vocab.txt",
		},
		externalData: ["encoder-model.int8.onnx.data", "decoder.int8.onnx.data", "joiner.int8.onnx.data"],
		englishOnly: false,
		label: "Fluid Speech Pro (SoTA)",
		description:
			"Fluid Speech Pro 0.63B, 25 European languages. Most accurate open model under 1B; holds up with noise and music in the room. Default.",
		sizeHint: "~800 MB",
	},
	{
		key: "parakeet-tdt-0.6b-v2",
		engine: "sherpa",
		mode: "offline",
		repo: "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
		modelType: "nemo_transducer",
		files: {
			encoder: "encoder.int8.onnx",
			decoder: "decoder.int8.onnx",
			joiner: "joiner.int8.onnx",
			tokens: "tokens.txt",
		},
		externalData: [],
		englishOnly: true,
		label: "Parakeet TDT v2 (English)",
		description: "NVIDIA Parakeet TDT 0.6B v2, English only. Most accurate English dictation at the same speed.",
		sizeHint: "~650 MB",
	},
	{
		key: "nemotron-streaming-en-0.6b",
		engine: "sherpa",
		mode: "online",
		repo: "csukuangfj2/sherpa-onnx-nemotron-speech-streaming-en-0.6b-160ms-int8-2026-04-25",
		modelType: "",
		files: {
			encoder: "encoder.int8.onnx",
			decoder: "decoder.int8.onnx",
			joiner: "joiner.int8.onnx",
			tokens: "tokens.txt",
		},
		externalData: [],
		englishOnly: true,
		label: "Nemotron 0.6B (live streaming, English)",
		description:
			"NVIDIA Nemotron Speech 0.6B, English only. Native streaming recognition with live words while you speak; 160 ms audio chunks.",
		sizeHint: "~630 MB",
	},
] as const satisfies readonly SttModelSpec[];

/**
 * SoTA default — Fluid Speech Pro (sherpa-onnx), a post-trained Parakeet TDT
 * 0.6B v3: #2 open model on the Open ASR Leaderboard and the best under 1B,
 * decoding dictation dozens of times faster than real time on a CPU.
 */
export const DEFAULT_STT_MODEL_KEY = "fluid-speech-pro";

export type SttModelKey = (typeof STT_MODELS)[number]["key"];

/** A concrete entry from {@link STT_MODELS}; `key` is the literal tier union. */
export type SttModel = (typeof STT_MODELS)[number];

export const STT_MODEL_VALUES = [
	"whisper-base",
	"whisper-small",
	"whisper-large-v3-turbo",
	"fluid-speech-pro",
	"parakeet-tdt-0.6b-v2",
	"nemotron-streaming-en-0.6b",
] as const satisfies readonly SttModelKey[];

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

/** Resolve a catalog model id, falling back to the SoTA default when unknown. */
export function resolveSttModelSpec(key: string | undefined): SttModel {
	return (key !== undefined ? getSttModelSpec(key) : undefined) ?? getSttModelSpec(DEFAULT_STT_MODEL_KEY)!;
}
