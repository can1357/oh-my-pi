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
}

/**
 * A local (on-device, ONNX) text-to-speech model the worker can load. `repo` is
 * the Hugging Face model id loaded through `kokoro-js`
 * (`KokoroTTS.from_pretrained`), which runs on the same `@huggingface/transformers`
 * + `onnxruntime` runtime as the rest of the tiny-model stack and bundles the
 * misaki/espeak phonemizer Kokoro needs. `dtype` is the default ONNX precision
 * (overridable via `providers.tinyModelDtype`/`PI_TINY_DTYPE`).
 */
export interface TtsLocalModelSpec {
	key: string;
	repo: string;
	dtype: TinyModelDtype;
	/** PCM sample rate the model emits; fallback only — the worker uses the value RawAudio reports. */
	sampleRate: number;
	label: string;
	description: string;
	/** First entry is the model's default voice. */
	voices: readonly TtsLocalVoiceSpec[];
}

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

/** Default voice within the default model — Kokoro's flagship grade-A voice. */
export const DEFAULT_TTS_VOICE = "af_heart";

/** Default local TTS model used when `tts.localModel` is unset. */
export const DEFAULT_TTS_LOCAL_MODEL_KEY = "kokoro";

/**
 * Local TTS model registry. Kokoro-82M is the on-device SoTA tiny TTS (tops the
 * TTS Arena leaderboard); the `onnx-community` ONNX export runs through
 * `kokoro-js` on the shared transformers.js/onnxruntime worker. q8 keeps the
 * weights ~100 MB and CPU inference fast while preserving quality. One model
 * spans every voice/accent — language selection is a voice choice, not a
 * separate download.
 */
export const TTS_LOCAL_MODELS = [
	{
		key: "kokoro",
		repo: "onnx-community/Kokoro-82M-v1.0-ONNX",
		dtype: "q8",
		sampleRate: 24_000,
		label: "Kokoro-82M",
		description: "Kokoro-82M neural TTS — SoTA on-device quality, multi-voice, fully local",
		voices: KOKORO_VOICES,
	},
] as const satisfies readonly TtsLocalModelSpec[];

export type TtsLocalModelKey = (typeof TTS_LOCAL_MODELS)[number]["key"];

export const TTS_LOCAL_MODEL_VALUES = ["kokoro"] as const;

type MissingTtsModelValue = Exclude<TtsLocalModelKey, (typeof TTS_LOCAL_MODEL_VALUES)[number]>;
type ExtraTtsModelValue = Exclude<(typeof TTS_LOCAL_MODEL_VALUES)[number], TtsLocalModelKey>;
const TTS_LOCAL_MODEL_VALUES_MATCH_REGISTRY: MissingTtsModelValue extends never
	? ExtraTtsModelValue extends never
		? true
		: never
	: never = true;
void TTS_LOCAL_MODEL_VALUES_MATCH_REGISTRY;

export const TTS_LOCAL_MODEL_OPTIONS = [
	{
		value: "kokoro",
		label: "Kokoro-82M",
		description: "Kokoro-82M neural TTS — SoTA on-device quality, multi-voice, fully local",
	},
] as const satisfies ReadonlyArray<{ value: TtsLocalModelKey; label: string; description: string }>;

/** Voice options for the `tts.localVoice` setting picker (default model's catalog). */
export const TTS_LOCAL_VOICE_OPTIONS = KOKORO_VOICES.map(voice => ({
	value: voice.id,
	label: voice.label,
})) as ReadonlyArray<{ value: string; label: string }>;

/** Accepted `tts.localVoice` values (default model's catalog) for schema validation. */
export const TTS_LOCAL_VOICE_VALUES = KOKORO_VOICES.map(voice => voice.id) as readonly string[];

export function getTtsLocalModelSpec(key: string): TtsLocalModelSpec | undefined {
	return TTS_LOCAL_MODELS.find(model => model.key === key);
}

export function isTtsLocalModelKey(value: string): value is TtsLocalModelKey {
	return getTtsLocalModelSpec(value) !== undefined;
}

/** Resolve a model key (or the default) to its Hugging Face repo id. */
export function resolveTtsRepo(modelKey: string | undefined): string {
	const spec = (modelKey && getTtsLocalModelSpec(modelKey)) || getTtsLocalModelSpec(DEFAULT_TTS_LOCAL_MODEL_KEY);
	if (!spec) throw new Error(`No local TTS model registered for key: ${modelKey ?? DEFAULT_TTS_LOCAL_MODEL_KEY}`);
	return spec.repo;
}

/**
 * Resolve a requested voice id to a concrete voice the model supports, falling
 * back to the model's default voice (first entry) when the id is unknown or the
 * legacy `"default"` sentinel. The returned id is always a valid Kokoro voice.
 */
export function resolveTtsVoice(modelKey: string | undefined, voice: string | undefined): string {
	const spec = (modelKey && getTtsLocalModelSpec(modelKey)) || getTtsLocalModelSpec(DEFAULT_TTS_LOCAL_MODEL_KEY);
	const fallback = spec?.voices[0]?.id ?? DEFAULT_TTS_VOICE;
	if (!spec || !voice) return fallback;
	const match = spec.voices.find(v => v.id === voice);
	return match ? match.id : fallback;
}
