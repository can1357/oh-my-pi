/**
 * Cloud speech session for the vocalizer: the same {@link TtsStreamHandle}
 * contract as the local worker stream, backed by the speech role chain.
 *
 * Each pushed segment is synthesized as WAV through the active candidate and
 * decoded to PCM, strictly in push order. A failing candidate is dropped for
 * the rest of the utterance and the segment retries on the next one; a
 * `local-inference` candidate later in the chain synthesizes on-device. A
 * permanent failure (missing key, 4xx other than 408/429, audio that is not
 * WAV) is also recorded in the caller's `excluded` set, so later utterances
 * skip that model instead of paying its latency again; transient failures
 * (network, 5xx, 408, 429) are retried on the next utterance. When every
 * candidate has failed the stream closes, so playback ends instead of stalling.
 *
 * The player runs at one rate per utterance, so every chunk is resampled to
 * the rate of the utterance's first chunk when fail-over lands on a model
 * that returns another rate.
 */
import type { Api, ApiKeyResolver, Model } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { synthesizeSpeech } from "@oh-my-pi/pi-ai/speech";
import { logger } from "@oh-my-pi/pi-utils";
import { AudioChunkChannel, type TtsAudio, type TtsStreamHandle, ttsClient } from "./tts-client";
import { decodeWav, resamplePcm } from "./wav";

export interface CloudSpeechStreamOptions {
	/** Vocalizer chain in attempt order: cloud speech models, optionally followed by local ones. */
	chain: readonly Model<Api>[];
	resolveApiKey(model: Model<Api>): ApiKeyResolver;
	/** Kokoro voice/speed for a local candidate reached by fail-over. */
	localVoice: string;
	localSpeed: number;
	/** `provider/id` of models that failed permanently earlier in the session; this stream adds to it. */
	excluded: Set<string>;
	signal: AbortSignal;
}

/** Thrown when a candidate answered with audio the vocalizer cannot decode. */
class UndecodableSpeechError extends Error {
	override readonly name = "UndecodableSpeechError";
}

/** HTTP statuses that may succeed when the same request is sent again. */
const TRANSIENT_CLIENT_STATUSES = new Set([408, 425, 429]);

/** Whether retrying `error` on a later utterance cannot succeed without a configuration change. */
function isPermanentSpeechFailure(error: unknown): boolean {
	if (
		error instanceof AIError.MissingApiKeyError ||
		error instanceof AIError.ValidationError ||
		error instanceof UndecodableSpeechError
	) {
		return true;
	}
	const status = error instanceof AIError.ProviderHttpError ? error.status : undefined;
	return status !== undefined && status >= 400 && status < 500 && !TRANSIENT_CLIENT_STATUSES.has(status);
}

export function createCloudSpeechStream(options: CloudSpeechStreamOptions): TtsStreamHandle {
	const { chain, excluded, signal } = options;
	let active = 0;
	let index = 0;
	let closed = false;
	let sampleRate: number | undefined;
	let tail = Promise.resolve();
	const close = (): void => {
		closed = true;
		channel.close();
	};
	const channel = new AudioChunkChannel(() => signal.removeEventListener("abort", close));
	if (signal.aborted) close();
	else signal.addEventListener("abort", close, { once: true });

	const synthesizeSegment = async (text: string): Promise<TtsAudio | null> => {
		let attempted = false;
		for (; active < chain.length; active += 1) {
			const model = chain[active]!;
			const label = `${model.provider}/${model.id}`;
			if (excluded.has(label)) continue;
			attempted = true;
			try {
				if (model.api === "local-inference") {
					const audio = await ttsClient.synthesize(model.id, text, {
						voice: options.localVoice,
						speed: options.localSpeed,
						signal,
					});
					if (audio) return audio;
					throw new Error("local synthesis returned no audio");
				}
				const result = await synthesizeSpeech(
					model,
					{ text, format: "wav" },
					{ apiKey: options.resolveApiKey(model), signal },
				);
				try {
					return decodeWav(result.audio);
				} catch (error) {
					throw new UndecodableSpeechError(error instanceof Error ? error.message : String(error));
				}
			} catch (error) {
				if (signal.aborted) return null;
				const message = error instanceof Error ? error.message : String(error);
				if (model.api !== "local-inference" && isPermanentSpeechFailure(error)) {
					excluded.add(label);
					logger.warn("vocalizer: speech model failed permanently; skipping it for this session", {
						model: label,
						error: message,
					});
				} else {
					logger.debug("vocalizer: speech candidate failed", { model: label, error: message });
				}
			}
		}
		// Exhaustion caused only by models already excluded this session was reported when they failed.
		if (attempted) {
			logger.warn("vocalizer: every speech model failed; the rest of the utterance is silent", {
				chain: chain.map(model => `${model.provider}/${model.id}`),
			});
		}
		return null;
	};

	return {
		push(text: string): void {
			if (closed) return;
			const segmentIndex = index++;
			tail = tail.then(async () => {
				if (closed) return;
				const audio = await synthesizeSegment(text);
				if (closed) return;
				if (!audio) {
					close();
					return;
				}
				sampleRate ??= audio.sampleRate;
				const pcm = resamplePcm(audio.pcm, audio.sampleRate, sampleRate);
				channel.push({ index: segmentIndex, text, pcm, sampleRate });
			});
		},
		end(): void {
			tail = tail.then(() => channel.close());
		},
		chunks: channel.iterator(),
	};
}
