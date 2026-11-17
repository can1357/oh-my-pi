/**
 * Local (on-device) text-to-speech model registry: the Phonon checkpoint the
 * TTS worker runs through the native `PhononTts` binding, the files it needs,
 * its curated voices, and the speaking-rate calibration.
 */
import type { PinnedHubFile } from "../downloads/pinned-hub-files";

/** A selectable voice: a stable id (the `tts.localVoice` value) plus a display label. */
export interface TtsLocalVoiceSpec {
	id: string;
	label: string;
}

/**
 * A local TTS model the worker can load. `files` is everything
 * `PhononTts.load` reads from the model directory; a `voices/<id>.safetensors`
 * target registers voice `<id>`.
 */
export interface TtsLocalModelSpec {
	key: string;
	label: string;
	description: string;
	files: readonly PinnedHubFile[];
	/** First entry is the model's default voice. */
	voices: readonly TtsLocalVoiceSpec[];
	/**
	 * Speaking rate → `duration_delta` conditioner, ascending by rate and
	 * interpolated linearly between points; the endpoints bound the rate.
	 */
	speedCurve: readonly (readonly [speed: number, durationDelta: number])[];
}

const PHONON_REPO = "gradium/phonon-31m-en";
const PHONON_REVISION = "92741c5b07d085ff840e26fea8ce43110b87852f";
const PHONON_VOICE_REPO = "gradium/phonon-voices";
const PHONON_VOICE_REVISION = "0ee17205f254b5abc43b266c8a0f215565c352f7";
/** Every catalog voice is one speaker-latent tensor of the same shape. */
const PHONON_VOICE_FILE_SIZE = 256_136;

/**
 * Curated English voices from the Phonon catalog (`voices.jsonl`): American and
 * British, female and male. `catalogId` names the embedding file upstream.
 */
const PHONON_VOICES = [
	{
		id: "harper",
		label: "Harper (American female)",
		catalogId: "4SZHfMpw-p46Ywgs",
		sha256: "6b3da6e2d796a20c51af892c482bd6509fb88267a221aff83c870843dee2a123",
	},
	{
		id: "hadley",
		label: "Hadley (American female)",
		catalogId: "bXwrkHhURL1VFJdG",
		sha256: "a879938aa9a2df0a8220bdadef88137929f71e887bd91e7db205bd5fa11661d2",
	},
	{
		id: "delia",
		label: "Delia (American female)",
		catalogId: "nGzMHMPAWGaJFHOo",
		sha256: "a0c3dcb91b2247eca56536be9ae8e8becc1c807b1136c5fe101552d6a155b24a",
	},
	{
		id: "everly",
		label: "Everly (American female)",
		catalogId: "vjFyp2BcCyTlUmYb",
		sha256: "958ea94da14f46dd48c7f64adac11ed2ad2aa45f7ccd165dfebab5272664402e",
	},
	{
		id: "easton",
		label: "Easton (American male)",
		catalogId: "LMDIYE0Oa377Qh6Z",
		sha256: "45c582673cb20edb04ddcca2b5a8865ddfb0a82599efadb269021e87d20fbdd4",
	},
	{
		id: "preston",
		label: "Preston (American male)",
		catalogId: "qIxlZ7Ei8KvWlyQH",
		sha256: "6e04b84d3ae8751b22bca0a4f63936f9cb648f4f2182b2d0788071ea1c0b68a1",
	},
	{
		id: "miles",
		label: "Miles (American male)",
		catalogId: "d9XCyhjo4JhkHF1d",
		sha256: "eab20e4f159b48cfbc01b1885804e24f681f80e7a64f909182763a4e3361bee8",
	},
	{
		id: "trevor",
		label: "Trevor (American male)",
		catalogId: "0zLApsZfVLLNaEGl",
		sha256: "dc1341c8937af5534e6bbcc5c0fc5e7c10312229b59061228074f93683fe2261",
	},
	{
		id: "maeve",
		label: "Maeve (British female)",
		catalogId: "6PWnV0Nq4wu7RVBT",
		sha256: "56494ee67d533ad227ff0dfd0b1c13ff5aa91f1ad6e596e66c2986ba3005e844",
	},
	{
		id: "bryony",
		label: "Bryony (British female)",
		catalogId: "gfP44RlHwr2kEwk7",
		sha256: "bcc207a73b7885e45b49ab633d3377a10158292e3a7cef9cd6764ad107f1cb9b",
	},
	{
		id: "edwin",
		label: "Edwin (British male)",
		catalogId: "zUCxzrOrugTSis03",
		sha256: "ff1d0735b8b45710462b1d1f846da040f970c6eb62c7c2f36dbfb8e5bde74f1e",
	},
	{
		id: "hugh",
		label: "Hugh (British male)",
		catalogId: "YyKcxPG7iIgS3jsK",
		sha256: "3169d74b47a54d1eb15e4c243f56393abe9fe90c7e1c308ecf96ee67618b152a",
	},
] as const;

/** The voice catalog surfaced by settings, the `tts` tool, and ACP. */
export const TTS_LOCAL_VOICES: readonly TtsLocalVoiceSpec[] = PHONON_VOICES.map(({ id, label }) => ({ id, label }));

/** Default voice within the default model. */
export const DEFAULT_TTS_VOICE = "harper";

/**
 * Phonon's speaking-rate calibration: mean audio-length ratio against
 * `duration_delta` 0, over four voices × three texts. The conditioner
 * saturates past ±0.5 (and degrades beyond -0.7), which bounds the rate.
 */
const PHONON_SPEED_CURVE = [
	[0.8, 0.5],
	[0.85, 0.3],
	[0.88, 0.2],
	[0.94, 0.1],
	[1, 0],
	[1.08, -0.1],
	[1.14, -0.2],
	[1.2, -0.3],
	[1.27, -0.4],
	[1.3, -0.5],
] as const;

/**
 * Local TTS model registry. Phonon 31M (Gradium, Apache-2.0, built on Kyutai's
 * Pocket TTS) streams 24 kHz speech from 80 ms latent frames; the q8 GGUF keeps
 * the weights at 64.5 MB and runs many times real time on a CPU core.
 */
export const TTS_LOCAL_MODELS = [
	{
		key: "phonon-31m",
		label: "Phonon 31M",
		description: "Phonon 31M neural TTS — fast on-device English speech, multi-voice, fully local",
		files: [
			{
				repo: PHONON_REPO,
				revision: PHONON_REVISION,
				source: "config.json",
				target: "config.json",
				size: 4634,
				sha256: "b5d0f88353638370d94035b7d73d7d6577c0554d78f8d7ecfd40490aae39ae85",
			},
			{
				repo: PHONON_REPO,
				revision: PHONON_REVISION,
				source: "tokenizer.json",
				target: "tokenizer.json",
				size: 277_967,
				sha256: "691a00068fa7b989f2f3e5ae5daa2d1a5bb319f2d5360deafcfb19a8bb6e7936",
			},
			{
				repo: PHONON_REPO,
				revision: PHONON_REVISION,
				source: "model.q8.gguf",
				target: "model.q8.gguf",
				size: 64_512_352,
				sha256: "a7d9aad2cd6dc66473f24a08bc6d2939030ef4d751ef82349361fbef3272dbae",
			},
			...PHONON_VOICES.map(voice => ({
				repo: PHONON_VOICE_REPO,
				revision: PHONON_VOICE_REVISION,
				source: `voices/${voice.catalogId}.safetensors`,
				target: `voices/${voice.id}.safetensors`,
				size: PHONON_VOICE_FILE_SIZE,
				sha256: voice.sha256,
			})),
		],
		voices: TTS_LOCAL_VOICES,
		speedCurve: PHONON_SPEED_CURVE,
	},
] as const satisfies readonly TtsLocalModelSpec[];

export type TtsLocalModelKey = (typeof TTS_LOCAL_MODELS)[number]["key"];

/** Voice options for the `tts.localVoice` / `speech.voice` setting pickers. */
export const TTS_LOCAL_VOICE_OPTIONS = TTS_LOCAL_VOICES.map(voice => ({
	value: voice.id,
	label: voice.label,
})) as ReadonlyArray<{ value: string; label: string }>;

/** Accepted `tts.localVoice` / `speech.voice` values, for schema validation. */
export const TTS_LOCAL_VOICE_VALUES = TTS_LOCAL_VOICES.map(voice => voice.id) as readonly string[];

export function getTtsLocalModelSpec(key: string): TtsLocalModelSpec | undefined {
	return TTS_LOCAL_MODELS.find(model => model.key === key);
}

export function isTtsLocalModelKey(value: string): value is TtsLocalModelKey {
	return getTtsLocalModelSpec(value) !== undefined;
}

/**
 * Resolve a requested voice id to one the model ships, falling back to the
 * model's default voice (first entry) when the id is missing or unknown.
 */
export function resolveTtsVoice(modelKey: string | undefined, voice: string | undefined): string {
	const spec = (modelKey && getTtsLocalModelSpec(modelKey)) || getTtsLocalModelSpec(TTS_LOCAL_MODELS[0].key);
	const fallback = spec?.voices[0]?.id ?? DEFAULT_TTS_VOICE;
	if (!spec || !voice) return fallback;
	const match = spec.voices.find(v => v.id === voice);
	return match ? match.id : fallback;
}

/** The model's natural speaking rate; also the value used when no speed is configured. */
export const DEFAULT_TTS_SPEED = 1;

/** Accepted speaking-rate band: the calibrated range of {@link PHONON_SPEED_CURVE}. */
export const TTS_SPEED_MIN = PHONON_SPEED_CURVE[0][0];
export const TTS_SPEED_MAX = PHONON_SPEED_CURVE[PHONON_SPEED_CURVE.length - 1][0];

/** Speed presets for the `tts.localSpeed` / `speech.speed` setting pickers. */
export const TTS_SPEED_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
	{ value: "0.8", label: "0.8×" },
	{ value: "0.9", label: "0.9×" },
	{ value: "1", label: "1× (normal)" },
	{ value: "1.1", label: "1.1×" },
	{ value: "1.2", label: "1.2×" },
	{ value: "1.3", label: "1.3×" },
];

/**
 * Resolve a requested speaking rate to one the model is given: clamped into
 * [{@link TTS_SPEED_MIN}, {@link TTS_SPEED_MAX}], or {@link DEFAULT_TTS_SPEED}
 * when missing or not a finite number.
 */
export function resolveTtsSpeed(speed: number | undefined): number {
	if (speed === undefined || !Number.isFinite(speed)) return DEFAULT_TTS_SPEED;
	return Math.min(TTS_SPEED_MAX, Math.max(TTS_SPEED_MIN, speed));
}

/**
 * The `duration_delta` conditioner value that makes `spec` speak at `speed`
 * (already resolved by {@link resolveTtsSpeed}), interpolated along the
 * model's {@link TtsLocalModelSpec.speedCurve} and clamped to its endpoints.
 */
export function ttsDurationDelta(spec: TtsLocalModelSpec, speed: number): number {
	const curve = spec.speedCurve;
	const first = curve[0];
	const last = curve[curve.length - 1];
	if (!first || !last) return 0;
	if (speed <= first[0]) return first[1];
	if (speed >= last[0]) return last[1];
	for (let i = 1; i < curve.length; i++) {
		const [hiSpeed, hiDelta] = curve[i]!;
		if (speed > hiSpeed) continue;
		const [loSpeed, loDelta] = curve[i - 1]!;
		return loDelta + ((speed - loSpeed) / (hiSpeed - loSpeed)) * (hiDelta - loDelta);
	}
	return last[1];
}
