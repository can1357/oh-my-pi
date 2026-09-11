/**
 * Dependency-free leaf: the speech-to-text backend and cloud transcription
 * model rosters plus their selection helpers.
 *
 * Kept free of imports on purpose. `config/settings-schema` needs these values
 * to declare `stt.backend` / `stt.modelName`, and it is imported before
 * `config/settings` by tests and public consumers; pulling them from the
 * runtime transcription client instead would close the cycle
 * `settings-schema → cloud-transcribe-client → tools/render-utils → settings →
 * settings-schema` and make `settings.ts` read `SETTINGS_SCHEMA` before it is
 * initialized.
 */

/**
 * Cloud STT model: file transcription. The Realtime transcription sessions
 * from the docs (`transcription_sessions`, `transcription_session.update`)
 * are not served on production (REST 404s, GA realtime rejects the events),
 * so the cloud backend records mic audio and transcribes the buffer on
 * release. No live partials — text lands when recording stops.
 */
export const DEFAULT_CLOUD_STT_MODEL = "gpt-4o-transcribe";

/** Transcription models selectable via `stt.modelName` when `stt.backend` is `cloud`. */
export const CLOUD_STT_MODEL_VALUES = [
	"gpt-4o-transcribe",
	"gpt-4o-mini-transcribe",
	"gpt-transcribe",
	"whisper-1",
] as const;
export type CloudSttModel = (typeof CLOUD_STT_MODEL_VALUES)[number];

export const CLOUD_STT_MODEL_OPTIONS = [
	{ value: "gpt-4o-transcribe", label: "GPT-4o Transcribe", description: "Best accuracy file transcription." },
	{
		value: "gpt-4o-mini-transcribe",
		label: "GPT-4o Mini Transcribe",
		description: "Cheaper and faster, slightly lower accuracy.",
	},
	{
		value: "gpt-transcribe",
		label: "GPT Transcribe",
		description: "Newest transcription model; reports detected languages.",
	},
	{ value: "whisper-1", label: "Whisper v1", description: "Legacy general-purpose transcription." },
] as const satisfies ReadonlyArray<{ value: CloudSttModel; label: string; description: string }>;

export function isCloudSttModel(value: string): value is CloudSttModel {
	return (CLOUD_STT_MODEL_VALUES as readonly string[]).includes(value);
}

/**
 * Resolve `stt.modelName` onto a cloud model. Local tier keys are not
 * transcription ids, so they fall back to the default rather than 400ing.
 */
export function resolveCloudSttModel(name: string | undefined): CloudSttModel {
	return name !== undefined && isCloudSttModel(name) ? name : DEFAULT_CLOUD_STT_MODEL;
}

export const STT_BACKEND_VALUES = ["local", "cloud"] as const;
export type SttBackend = (typeof STT_BACKEND_VALUES)[number];
export const DEFAULT_STT_BACKEND: SttBackend = "local";

export function isSttBackend(value: string): value is SttBackend {
	return (STT_BACKEND_VALUES as readonly string[]).includes(value);
}

export const STT_BACKEND_OPTIONS = [
	{ value: "local", label: "Local", description: "On-device Whisper/Parakeet. Private, no network." },
	{
		value: "cloud",
		label: "Cloud",
		description: "OpenAI transcription on release. Subscription first, else API key.",
	},
] as const satisfies ReadonlyArray<{ value: SttBackend; label: string; description: string }>;
