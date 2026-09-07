import { logger } from "@oh-my-pi/pi-utils";
import type { SttStreamHandle, SttStreamOptions } from "./asr-client";

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

const CLOUD_STT_URL = "https://api.openai.com/v1/audio/transcriptions";
const CLOUD_STT_TIMEOUT_MS = 60_000;

/** omp records at 16 kHz mono; the endpoint accepts 16-bit PCM WAV as-is. */
const MIC_SAMPLE_RATE = 16_000;

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

export interface CloudSttStreamOptions extends SttStreamOptions {
	apiKey: string;
	/** Transcription model id; resolved with {@link resolveCloudSttModel}. */
	model?: string;
	/** Domain hints; forwarded as the endpoint `prompt` when set. */
	keywords?: string[];
	/** Fetch implementation; defaults to global fetch. Tests inject a stub. */
	fetchImpl?: typeof fetch;
}

/**
 * Buffering cloud stream. Same {@link SttStreamHandle} shape as the local
 * worker client so `STTController` drives both backends through one path:
 * `pushAudio` accumulates, `stop()` transcribes the buffer and resolves with
 * the text (empty when silent), `cancel()` resolves "" without a request.
 */
export function startCloudSttStream(options: CloudSttStreamOptions): SttStreamHandle {
	const fetchImpl = options.fetchImpl ?? fetch;
	const chunks: Float32Array[] = [];
	let queuedBytes = 0;
	let settled = false;
	let stopped = false;
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	void promise.catch(() => {});

	const finish = (apply: () => void): void => {
		if (settled) return;
		settled = true;
		apply();
	};

	const abort = (): void => finish(() => resolve(""));
	if (options.signal?.aborted) abort();
	else options.signal?.addEventListener("abort", abort, { once: true });

	return {
		pushAudio(audio: Float32Array): void {
			if (settled || stopped) return;
			chunks.push(audio.slice());
			queuedBytes += audio.length;
		},
		stop: () => {
			if (!settled && !stopped) {
				stopped = true;
				if (queuedBytes === 0) {
					finish(() => resolve(""));
				} else {
					void transcribeBuffer(fetchImpl, options, concat(chunks, queuedBytes)).then(
						text => finish(() => resolve(text)),
						err => {
							const msg = err instanceof Error ? err.message : String(err);
							logger.error("STT cloud transcription failed", { error: msg });
							finish(() => reject(err instanceof Error ? err : new Error(msg)));
						},
					);
				}
			}
			return promise;
		},
		cancel: () => finish(() => resolve("")),
	};
}

function concat(chunks: Float32Array[], total: number): Float32Array {
	const out = new Float32Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

async function transcribeBuffer(
	fetchImpl: typeof fetch,
	options: CloudSttStreamOptions,
	audio: Float32Array,
): Promise<string> {
	const form = new FormData();
	form.append("model", resolveCloudSttModel(options.model));
	if (options.language) form.append("language", options.language);
	if (options.keywords?.length) form.append("prompt", options.keywords.join(", "));
	form.append("response_format", "json");
	form.append("file", new Blob([encodeWav16k(audio)], { type: "audio/wav" }), "dictation.wav");
	const timeout = AbortSignal.timeout(CLOUD_STT_TIMEOUT_MS);
	const response = await fetchImpl(CLOUD_STT_URL, {
		method: "POST",
		headers: { Authorization: `Bearer ${options.apiKey}` },
		body: form,
		signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
	});
	if (!response.ok) {
		const detail = (await response.text().catch(() => "")).slice(0, 300);
		throw new Error(`Cloud transcription failed (${response.status}): ${detail}`);
	}
	const body = (await response.json()) as { text?: string };
	return (body.text ?? "").trim();
}

/** Encode 16 kHz mono float samples as a PCM16 WAV file. */
export function encodeWav16k(audio: Float32Array): ArrayBuffer {
	const buffer = new ArrayBuffer(44 + audio.length * 2);
	const view = new DataView(buffer);
	writeWavHeader(view, audio.length);
	const pcm = new Int16Array(buffer, 44);
	for (let i = 0; i < audio.length; i++) {
		pcm[i] = Math.max(-32768, Math.min(32767, Math.round(audio[i]! * 32767)));
	}
	return buffer;
}

function writeWavHeader(view: DataView, samples: number): void {
	const writeAscii = (offset: number, text: string): void => {
		for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
	};
	writeAscii(0, "RIFF");
	view.setUint32(4, 36 + samples * 2, true);
	writeAscii(8, "WAVE");
	writeAscii(12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, MIC_SAMPLE_RATE, true);
	view.setUint32(28, MIC_SAMPLE_RATE * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	writeAscii(36, "data");
	view.setUint32(40, samples * 2, true);
}
