import type { SherpaArchiveSpec } from "../speech/sherpa-model-files";
import type { TinyModelDtype } from "../tiny/dtype";

/**
 * Voice exposed by a local TTS model. Kokoro ships a fixed catalog of named
 * voices; a voice is just a stable id (e.g. `af_heart`) plus a display label.
 * Selection is purely on-device — generating with a different voice needs no
 * extra network fetch once the model weights are cached.
 */
export interface TtsLocalVoiceSpec {
	id: string;
	label: string;
	/** sherpa-onnx speaker id; absent for the kokoro-js runtime, which takes the id directly. */
	sid?: number;
}

interface TtsLocalModelBase {
	key: string;
	/** Hugging Face repo id or archive cache key. */
	repo: string;
	/** PCM sample rate the model emits; fallback only — the worker uses the value the runtime reports. */
	sampleRate: number;
	label: string;
	description: string;
	/** Approximate on-disk download size for the shipped weights (UI hint). */
	sizeHint: string;
	/** First entry is the model's default voice. */
	voices: readonly TtsLocalVoiceSpec[];
}

/** A Kokoro-82M ONNX export loaded through `kokoro-js`. */
export interface KokoroJsTtsLocalModelSpec extends TtsLocalModelBase {
	engine: "kokoro-js";
	/** Default ONNX precision (overridable via `providers.tinyModelDtype`/`PI_TINY_DTYPE`). */
	dtype: TinyModelDtype;
}

/** A sherpa-onnx Kokoro export loaded through the native `OfflineTts` API. */
export interface SherpaTtsLocalModelSpec extends TtsLocalModelBase {
	engine: "sherpa";
	/** Release archive downloaded into the shared tiny-model cache. */
	archive: SherpaArchiveSpec;
	/** Required files relative to the extracted model root. */
	files: Record<string, string>;
	/** Required directories relative to the extracted model root. */
	directories?: readonly string[];
}

export type TtsLocalModelSpec = KokoroJsTtsLocalModelSpec | SherpaTtsLocalModelSpec;

/**
 * Curated Kokoro-82M voice catalog. Kokoro ships ~28 voices; we surface the
 * higher-graded ones across American/British × female/male so the picker stays
 * useful without listing every D/F-grade sample. `af_heart` (grade A) leads and
 * is the default voice. Grades are Kokoro's own `overallGrade` ratings.
 */
export const KOKORO_VOICES: readonly TtsLocalVoiceSpec[] = [
	{ id: "af_heart", label: "Heart (American female)" },
	{ id: "af_bella", label: "Bella (American female)" },
	{ id: "af_nicole", label: "Nicole (American female)" },
	{ id: "af_aoede", label: "Aoede (American female)" },
	{ id: "af_kore", label: "Kore (American female)" },
	{ id: "af_sarah", label: "Sarah (American female)" },
	{ id: "am_michael", label: "Michael (American male)" },
	{ id: "am_fenrir", label: "Fenrir (American male)" },
	{ id: "am_puck", label: "Puck (American male)" },
	{ id: "bf_emma", label: "Emma (British female)" },
	{ id: "bm_george", label: "George (British male)" },
	{ id: "bm_fable", label: "Fable (British male)" },
] as const;

/**
 * Curated Chinese voices from Kokoro-82M v1.1-zh. The full sherpa export has 100
 * Chinese speakers; this list covers common female and male voices while keeping
 * the settings picker navigable. `sid` values come from the model's speaker
 * table and are stable for the v1.1-zh export.
 */
export const KOKORO_ZH_VOICES: readonly TtsLocalVoiceSpec[] = [
	{ id: "zf_001", label: "Chinese female (zf_001)", sid: 3 },
	{ id: "zf_002", label: "Chinese female (zf_002)", sid: 4 },
	{ id: "zf_003", label: "Chinese female (zf_003)", sid: 5 },
	{ id: "zf_004", label: "Chinese female (zf_004)", sid: 6 },
	{ id: "zf_005", label: "Chinese female (zf_005)", sid: 7 },
	{ id: "zf_017", label: "Chinese female (zf_017)", sid: 11 },
	{ id: "zm_010", label: "Chinese male (zm_010)", sid: 59 },
	{ id: "zm_011", label: "Chinese male (zm_011)", sid: 60 },
	{ id: "zm_012", label: "Chinese male (zm_012)", sid: 61 },
	{ id: "zm_013", label: "Chinese male (zm_013)", sid: 62 },
	{ id: "zm_014", label: "Chinese male (zm_014)", sid: 63 },
	{ id: "zm_015", label: "Chinese male (zm_015)", sid: 64 },
] as const;

/** Default voice within the default model — Kokoro's flagship grade-A voice. */
export const DEFAULT_TTS_VOICE = "af_heart";

/**
 * Local TTS model registry. `kokoro` is the original English-only Kokoro-82M
 * runtime; `kokoro-zh` is the official sherpa-onnx Kokoro-82M v1.1-zh export,
 * which handles Chinese and English inside the native sherpa runtime.
 */
export const TTS_LOCAL_MODELS = [
	{
		key: "kokoro",
		engine: "kokoro-js",
		repo: "onnx-community/Kokoro-82M-v1.0-ONNX",
		dtype: "q8",
		sampleRate: 24_000,
		label: "Kokoro-82M",
		description: "Kokoro-82M neural TTS — SoTA on-device quality, multi-voice, fully local",
		sizeHint: "~100 MB",
		voices: KOKORO_VOICES,
	},
	{
		key: "kokoro-zh",
		engine: "sherpa",
		repo: "kokoro-int8-multi-lang-v1_1",
		archive: {
			url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_1.tar.bz2",
		},
		files: {
			model: "model.int8.onnx",
			voices: "voices.bin",
			tokens: "tokens.txt",
			usLexicon: "lexicon-us-en.txt",
			zhLexicon: "lexicon-zh.txt",
		},
		directories: ["espeak-ng-data"],
		sampleRate: 24_000,
		label: "Kokoro-82M v1.1 (Chinese/English)",
		description:
			"Kokoro-82M v1.1-zh, 103 voices, Chinese and English with punctuation, int8 sherpa-onnx. Fully local.",
		sizeHint: "~200 MB",
		voices: KOKORO_ZH_VOICES,
	},
] as const satisfies readonly TtsLocalModelSpec[];

export type TtsLocalModelKey = (typeof TTS_LOCAL_MODELS)[number]["key"];

const seenVoiceIds: Record<string, true> = {};
/** Voice options for the `tts.localVoice` picker across every local model. */
export const TTS_LOCAL_VOICE_OPTIONS = TTS_LOCAL_MODELS.flatMap(model =>
	model.voices.flatMap(voice => {
		if (seenVoiceIds[voice.id]) return [];
		seenVoiceIds[voice.id] = true;
		return [{ value: voice.id, label: voice.label }];
	}),
) as ReadonlyArray<{ value: string; label: string }>;

/** Accepted `tts.localVoice` values across every local model for schema validation. */
export const TTS_LOCAL_VOICE_VALUES = TTS_LOCAL_VOICE_OPTIONS.map(voice => voice.value) as readonly string[];

export function getTtsLocalModelSpec(key: string): TtsLocalModelSpec | undefined {
	return TTS_LOCAL_MODELS.find(model => model.key === key);
}

export function isTtsLocalModelKey(value: string): value is TtsLocalModelKey {
	return getTtsLocalModelSpec(value) !== undefined;
}

/** Resolve a model key (or the default) to its Hugging Face repo id or archive cache key. */
export function resolveTtsRepo(modelKey: string | undefined): string {
	const fallbackKey = TTS_LOCAL_MODELS[0].key;
	const spec = (modelKey && getTtsLocalModelSpec(modelKey)) || getTtsLocalModelSpec(fallbackKey);
	if (!spec) throw new Error(`No local TTS model registered for key: ${modelKey ?? fallbackKey}`);
	return spec.repo;
}

/**
 * Resolve a requested voice id to a concrete voice the model supports, falling
 * back to the model's default voice (first entry) when the id is unknown or the
 * legacy `"default"` sentinel.
 */
export function resolveTtsVoice(modelKey: string | undefined, voice: string | undefined): string {
	const spec = (modelKey && getTtsLocalModelSpec(modelKey)) || getTtsLocalModelSpec(TTS_LOCAL_MODELS[0].key);
	const fallback = spec?.voices[0]?.id ?? DEFAULT_TTS_VOICE;
	if (!spec || !voice) return fallback;
	const match = spec.voices.find(v => v.id === voice);
	return match ? match.id : fallback;
}

/** Resolve a sherpa voice id to its speaker id. */
export function resolveTtsSpeakerId(modelKey: string | undefined, voice: string | undefined): number {
	const spec = (modelKey && getTtsLocalModelSpec(modelKey)) || getTtsLocalModelSpec(TTS_LOCAL_MODELS[0].key);
	const resolved = resolveTtsVoice(modelKey, voice);
	const match = spec?.voices.find(v => v.id === resolved);
	if (match?.sid === undefined) {
		throw new Error(`Voice ${resolved} has no sherpa speaker id for model ${spec?.key ?? modelKey}`);
	}
	return match.sid;
}

/** Kokoro's native speaking rate; also the value used when no speed is configured. */
export const DEFAULT_TTS_SPEED = 1;

/**
 * Accepted speaking-rate band. Kokoro takes any positive float, but intelligibility
 * collapses well outside this range.
 */
export const TTS_SPEED_MIN = 0.5;
export const TTS_SPEED_MAX = 2.5;

/** Speed presets for the `tts.localSpeed` / `speech.speed` setting pickers. */
export const TTS_SPEED_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
	{ value: "0.5", label: "0.5×" },
	{ value: "0.75", label: "0.75×" },
	{ value: "1", label: "1× (normal)" },
	{ value: "1.25", label: "1.25×" },
	{ value: "1.5", label: "1.5×" },
	{ value: "1.75", label: "1.75×" },
	{ value: "2", label: "2×" },
	{ value: "2.5", label: "2.5×" },
];

/**
 * Resolve a requested speaking rate to one Kokoro is given: clamped into
 * [{@link TTS_SPEED_MIN}, {@link TTS_SPEED_MAX}], or {@link DEFAULT_TTS_SPEED}
 * when missing or not a finite number.
 */
export function resolveTtsSpeed(speed: number | undefined): number {
	if (speed === undefined || !Number.isFinite(speed)) return DEFAULT_TTS_SPEED;
	return Math.min(TTS_SPEED_MAX, Math.max(TTS_SPEED_MIN, speed));
}
