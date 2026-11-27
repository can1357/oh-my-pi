/**
 * Cloud speech session for the vocalizer: the {@link TtsStreamHandle} contract
 * of the local worker stream, backed by the vocalizer's speech chain.
 *
 * Segments are synthesized as WAV through the active candidate in push order;
 * synthesis of the next segment overlaps playback of the current one. A failing
 * candidate is dropped for the rest of the utterance and the segment moves on to
 * the next one; a `local-inference` candidate synthesizes on-device. When every
 * candidate has failed the stream closes, so playback ends instead of stalling.
 *
 * The player runs at one rate per utterance, so every chunk is resampled to the
 * rate of the utterance's first chunk.
 */
import type { Api, ApiKeyResolver, Model } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { synthesizeSpeech } from "@oh-my-pi/pi-ai/speech";
import { logger } from "@oh-my-pi/pi-utils";
import { AudioChunkChannel, type TtsAudio, type TtsStreamHandle, ttsClient } from "./tts-client";
import { decodeWav, resamplePcm } from "./wav";

export interface CloudSpeechStreamOptions {
	/** Candidates in attempt order: cloud speech models, optionally followed by local ones. */
	chain: readonly Model<Api>[];
	resolveApiKey(model: Model<Api>): ApiKeyResolver;
	/** Voice and speed for a local candidate. */
	localVoice: string;
	localSpeed: number;
	/** A cloud model failed in a way that retrying cannot fix without a configuration change. */
	onPermanentFailure(model: Model<Api>): void;
	signal: AbortSignal;
}

/** Thrown when a candidate answered with audio the vocalizer cannot decode. */
class UndecodableSpeechError extends Error {
	override readonly name = "UndecodableSpeechError";
}

/** Client statuses that may succeed when the same request is sent again. */
const TRANSIENT_CLIENT_STATUSES = new Set([408, 425, 429]);

/**
 * Missing key, undecodable audio, or a non-transient 4xx. A `ValidationError`
 * is not permanent: it can come from one segment (a length limit), not the model.
 */
function isPermanentSpeechFailure(error: unknown): boolean {
	if (error instanceof AIError.MissingApiKeyError || error instanceof UndecodableSpeechError) return true;
	if (!(error instanceof AIError.ProviderHttpError)) return false;
	return error.status >= 400 && error.status < 500 && !TRANSIENT_CLIENT_STATUSES.has(error.status);
}

const modelLabel = (model: Model<Api>): string => `${model.provider}/${model.id}`;

export function createCloudSpeechStream(options: CloudSpeechStreamOptions): TtsStreamHandle {
	const { chain, signal } = options;
	const channel = new AudioChunkChannel(() => signal.removeEventListener("abort", close));
	let active = 0;
	let index = 0;
	let sampleRate: number | undefined;
	let tail = Promise.resolve();
	function close(): void {
		channel.close();
	}
	if (signal.aborted) close();
	else signal.addEventListener("abort", close, { once: true });

	const synthesizeWith = async (model: Model<Api>, text: string): Promise<TtsAudio> => {
		if (model.api === "local-inference") {
			const audio = await ttsClient.synthesize(model.id, text, {
				voice: options.localVoice,
				speed: options.localSpeed,
				signal,
			});
			if (!audio) throw new Error("local synthesis returned no audio");
			return audio;
		}
		const { audio } = await synthesizeSpeech(
			model,
			{ text, format: "wav" },
			{ apiKey: options.resolveApiKey(model), signal },
		);
		try {
			return decodeWav(audio);
		} catch (error) {
			throw new UndecodableSpeechError(error instanceof Error ? error.message : String(error));
		}
	};

	const synthesizeSegment = async (text: string): Promise<TtsAudio | null> => {
		for (; active < chain.length; active += 1) {
			const model = chain[active]!;
			try {
				return await synthesizeWith(model, text);
			} catch (error) {
				if (signal.aborted) return null;
				const message = error instanceof Error ? error.message : String(error);
				if (model.api !== "local-inference" && isPermanentSpeechFailure(error)) {
					options.onPermanentFailure(model);
					logger.warn("vocalizer: speech model failed permanently", { model: modelLabel(model), error: message });
				} else {
					logger.debug("vocalizer: speech candidate failed", { model: modelLabel(model), error: message });
				}
			}
		}
		logger.warn("vocalizer: every speech model failed; the rest of the utterance is silent", {
			chain: chain.map(modelLabel),
		});
		return null;
	};

	return {
		push(text: string): void {
			if (signal.aborted || active >= chain.length) return;
			const segmentIndex = index++;
			tail = tail.then(async () => {
				if (signal.aborted || active >= chain.length) return;
				const audio = await synthesizeSegment(text);
				if (!audio) {
					close();
					return;
				}
				sampleRate ??= audio.sampleRate;
				channel.push({
					index: segmentIndex,
					text,
					pcm: resamplePcm(audio.pcm, audio.sampleRate, sampleRate),
					sampleRate,
				});
			});
		},
		end(): void {
			tail = tail.then(close);
		},
		chunks: channel.iterator(),
	};
}
