/**
 * Cloud speech session for the vocalizer: the same {@link TtsStreamHandle}
 * contract as the local worker stream, backed by the speech role chain.
 *
 * Each pushed segment is synthesized as WAV through the active candidate and
 * decoded to PCM, strictly in push order. A failing candidate (HTTP error,
 * missing key, undecodable audio) is dropped for the rest of the session and
 * the segment retries on the next one; a `local-inference` candidate later in
 * the chain synthesizes on-device. When every candidate has failed the stream
 * closes, so playback ends instead of stalling.
 */
import type { Api, ApiKeyResolver, Model } from "@oh-my-pi/pi-ai";
import { synthesizeSpeech } from "@oh-my-pi/pi-ai/speech";
import { logger } from "@oh-my-pi/pi-utils";
import { AudioChunkChannel, type TtsAudio, type TtsStreamHandle, ttsClient } from "./tts-client";
import { decodeWav } from "./wav";

export interface CloudSpeechStreamOptions {
	/** Vocalizer chain in attempt order: cloud speech models, optionally followed by local ones. */
	chain: readonly Model<Api>[];
	resolveApiKey(model: Model<Api>): ApiKeyResolver;
	/** Kokoro voice/speed for a local candidate reached by fail-over. */
	localVoice: string;
	localSpeed: number;
	signal: AbortSignal;
}

export function createCloudSpeechStream(options: CloudSpeechStreamOptions): TtsStreamHandle {
	const { chain, signal } = options;
	let active = 0;
	let index = 0;
	let closed = false;
	let tail = Promise.resolve();
	const close = (): void => {
		closed = true;
		channel.close();
	};
	const channel = new AudioChunkChannel(() => signal.removeEventListener("abort", close));
	if (signal.aborted) close();
	else signal.addEventListener("abort", close, { once: true });

	const synthesizeSegment = async (text: string): Promise<TtsAudio | null> => {
		while (active < chain.length) {
			const model = chain[active]!;
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
				return decodeWav(result.audio);
			} catch (error) {
				if (signal.aborted) return null;
				logger.debug("vocalizer: speech candidate failed", {
					model: `${model.provider}/${model.id}`,
					error: error instanceof Error ? error.message : String(error),
				});
				active += 1;
			}
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
				channel.push({ index: segmentIndex, text, pcm: audio.pcm, sampleRate: audio.sampleRate });
			});
		},
		end(): void {
			tail = tail.then(() => channel.close());
		},
		chunks: channel.iterator(),
	};
}
