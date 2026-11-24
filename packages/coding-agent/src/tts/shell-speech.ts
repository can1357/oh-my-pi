/**
 * Speech for the embedded shell's `say` builtin.
 *
 * `say` asks the host first: when the session has speech set up — vocalization
 * on, an explicit `speech` role, or the local model already installed — the
 * text is synthesized by the same speech-role chain the `tts` tool uses and
 * played through the streaming player (or returned as PCM for `say -o`).
 * Otherwise the answer is `configured: false` and `say` uses the system
 * synthesizer; it asks again with `required` when the system has none.
 *
 * `say -v` picks one of the model's voices by name and `say -r` (words per
 * minute) scales the speaking rate; a voice the model does not have and the
 * options with no equivalent are ignored.
 */
import type { FetchImpl, Model } from "@oh-my-pi/pi-ai";
import { MissingApiKeyError, ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { isSpeechApi, synthesizeSpeech } from "@oh-my-pi/pi-ai/speech";
import {
	type ShellSpeech,
	ShellSpeechOp,
	type ShellSpeechRequest,
	type ShellSpeechResponse,
	type ShellSpeechVoice,
} from "@oh-my-pi/pi-natives";
import { toError } from "@oh-my-pi/pi-utils";
import { cfgOffline } from "../config/auxiliary-model-policy";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import type { ToolSession } from "../tools";
import { resolveSpeechCandidates, XAI_BUILTIN_VOICES } from "../tools/tts";
import { isTtsModelCached } from "./downloader";
import {
	DEFAULT_TTS_VOICE,
	getTtsLocalModelSpec,
	isTtsLocalModelKey,
	resolveTtsSpeed,
	TTS_LOCAL_MODELS,
} from "./models";
import { SpeakableStream } from "./speakable";
import { createStreamingPlayer } from "./streaming-player";
import { type TtsStreamHandle, type TtsStreamOptions, ttsClient } from "./tts-client";
import { type VocalizerPlayer, vocalizer } from "./vocalizer";
import { decodeWav } from "./wav";

import { cfgSpeechEnabled, cfgTtsLocalSpeed, cfgTtsLocalVoice } from "./settings";

/** Words per minute `say` speaks at when given no `-r`; a rate scales against it. */
const SAY_DEFAULT_RATE = 175;
/** Speed range the OpenAI-compatible speech endpoint accepts. */
const CLOUD_SPEED_MIN = 0.25;
const CLOUD_SPEED_MAX = 4;
/** Sample rate reported for a capture that synthesized nothing. */
const SILENT_SAMPLE_RATE = 24_000;

/** The session facts speech is resolved from. */
export interface ShellSpeechSession {
	settings: Settings;
	/** Resolves the speech role; without one only the bundled local model speaks. */
	modelRegistry?: ModelRegistry;
	/** Provider of the session's active model, for the offline policy. */
	getSessionProvider?: () => string | undefined;
	/** Session whose credential affinity cloud synthesis uses. */
	getSessionId?: () => string | undefined;
	fetch?: FetchImpl;
}

/** The synthesis and playback services behind {@link ShellSpeechHost}. */
export interface ShellSpeechServices {
	synthesizeStream(modelKey: string, options: TtsStreamOptions): TtsStreamHandle;
	synthesizeCloud: typeof synthesizeSpeech;
	createPlayer(): VocalizerPlayer;
	isModelCached(modelKey: string): Promise<boolean>;
	/** Resolves once assistant speech already queued has finished playing. */
	speechIdle(): Promise<void>;
}

const DEFAULT_SERVICES: ShellSpeechServices = {
	synthesizeStream: (modelKey, options) => ttsClient.synthesizeStream(modelKey, options),
	synthesizeCloud: synthesizeSpeech,
	createPlayer: createStreamingPlayer,
	isModelCached: isTtsModelCached,
	speechIdle: () => vocalizer.idle(),
};

type SpeechBackend = { kind: "local"; modelKey: string } | { kind: "cloud"; model: Model; registry: ModelRegistry };

interface PcmChunk {
	pcm: Float32Array;
	sampleRate: number;
}

function backendVoices(backend: SpeechBackend): ShellSpeechVoice[] {
	if (backend.kind === "local") {
		// The local model's voices are American or British English.
		return (getTtsLocalModelSpec(backend.modelKey)?.voices ?? []).map(voice => ({
			name: voice.id,
			locale: voice.label.includes("British") ? "en_GB" : "en_US",
			sample: voice.label,
		}));
	}
	if (backend.model.api !== "xai-tts") return [];
	return XAI_BUILTIN_VOICES.map(name => ({ name, locale: "en_US", sample: backend.model.name }));
}

/** Serves the `say` builtin of one shell run from the session's speech setup. */
export class ShellSpeechHost {
	readonly #session: ShellSpeechSession;
	readonly #services: ShellSpeechServices;
	/** `speak` requests in flight, by request id; aborted by `cancel`. */
	readonly #speaking = new Map<number, AbortController>();

	constructor(session: ShellSpeechSession, services: ShellSpeechServices = DEFAULT_SERVICES) {
		this.#session = session;
		this.#services = services;
	}

	/** Native shell binding: every `say` request reaches {@link handle}. */
	shellSpeech(): ShellSpeech {
		return {
			handler: (error, request) =>
				error ? Promise.resolve({ configured: true, error: error.message }) : this.handle(request),
		};
	}

	/** Serve one request; failures come back as `error` data. */
	async handle(request: ShellSpeechRequest): Promise<ShellSpeechResponse> {
		try {
			if (request.op === ShellSpeechOp.Cancel) {
				if (typeof request.id === "number") this.#speaking.get(request.id)?.abort();
				return { configured: true };
			}
			const backends = this.#backends();
			const usable = request.required === true ? backends.length > 0 : await this.#configured(backends);
			if (!usable) return { configured: false };
			if (request.op === ShellSpeechOp.Voices) return { configured: true, voices: backendVoices(backends[0]!) };
			return await this.#speak(backends, request);
		} catch (error) {
			return { configured: true, error: toError(error).message };
		}
	}

	/** The speech role's candidates this session may use, in attempt order. */
	#backends(): SpeechBackend[] {
		const { settings, modelRegistry } = this.#session;
		const offline = cfgOffline.get(settings);
		const sessionProvider = this.#session.getSessionProvider?.();
		const backends: SpeechBackend[] = [];
		if (modelRegistry) {
			for (const { model } of resolveSpeechCandidates(settings, modelRegistry, false)) {
				if (offline && model.provider !== sessionProvider) continue;
				if (model.api === "local-inference") {
					if (isTtsLocalModelKey(model.id)) backends.push({ kind: "local", modelKey: model.id });
				} else if (isSpeechApi(model.api)) {
					backends.push({ kind: "cloud", model, registry: modelRegistry });
				}
			}
		}
		// Like the vocalizer: the bundled local model when the role resolves nothing.
		if (backends.length === 0 && (!offline || sessionProvider === "local")) {
			backends.push({ kind: "local", modelKey: TTS_LOCAL_MODELS[0].key });
		}
		return backends;
	}

	/** Whether the user set speech up, so `say` should prefer it over the system synthesizer. */
	async #configured(backends: SpeechBackend[]): Promise<boolean> {
		const first = backends[0];
		if (!first) return false;
		const { settings } = this.#session;
		if (cfgSpeechEnabled.get(settings) || Object.hasOwn(settings.getModelRoles(), "speech")) return true;
		return first.kind === "local" && (await this.#services.isModelCached(first.modelKey));
	}

	async #speak(backends: SpeechBackend[], request: ShellSpeechRequest): Promise<ShellSpeechResponse> {
		const abort = new AbortController();
		const id = typeof request.id === "number" ? request.id : undefined;
		if (id !== undefined) this.#speaking.set(id, abort);
		try {
			const failures: string[] = [];
			for (const backend of backends) {
				let chunks: AsyncIterable<PcmChunk>;
				if (backend.kind === "local") {
					chunks = this.#synthesizeLocal(backend.modelKey, request, abort.signal);
				} else {
					try {
						chunks = await this.#synthesizeCloud(backend.model, backend.registry, request, abort.signal);
					} catch (error) {
						if (abort.signal.aborted) throw error;
						if (error instanceof MissingApiKeyError || error instanceof ProviderHttpError) {
							failures.push(`${backend.model.provider}/${backend.model.id}: ${error.message}`);
							continue;
						}
						throw error;
					}
				}
				if (request.capture === true) return await this.#capture(chunks);
				await this.#play(chunks, abort.signal);
				return { configured: true };
			}
			throw new Error(`Speech synthesis failed for every candidate: ${failures.join("; ")}`);
		} finally {
			if (id !== undefined) this.#speaking.delete(id);
		}
	}

	/** Stream `request.text` through the local model, one speakable segment per chunk. */
	async *#synthesizeLocal(
		modelKey: string,
		request: ShellSpeechRequest,
		signal: AbortSignal,
	): AsyncGenerator<PcmChunk> {
		const { settings } = this.#session;
		const splitter = new SpeakableStream();
		const segments = [...splitter.push(request.text ?? ""), ...splitter.flush()];
		if (segments.length === 0) return;
		const asked = request.voice?.trim().toLowerCase();
		const voice =
			getTtsLocalModelSpec(modelKey)?.voices.find(candidate => candidate.id === asked)?.id ??
			(cfgTtsLocalVoice.get(settings) || DEFAULT_TTS_VOICE);
		const speed =
			typeof request.rate === "number"
				? resolveTtsSpeed(request.rate / SAY_DEFAULT_RATE)
				: cfgTtsLocalSpeed.get(settings);
		const stream = this.#services.synthesizeStream(modelKey, { voice, speed, signal });
		for (const segment of segments) stream.push(segment);
		stream.end();
		let synthesized = false;
		for await (const chunk of stream.chunks) {
			synthesized = true;
			yield chunk;
		}
		if (!synthesized && !signal.aborted) {
			throw new Error(`Local TTS model "${modelKey}" produced no audio`);
		}
	}

	/** Synthesize `request.text` with a cloud speech model, as one chunk. */
	async #synthesizeCloud(
		model: Model,
		registry: ModelRegistry,
		request: ShellSpeechRequest,
		signal: AbortSignal,
	): Promise<AsyncIterable<PcmChunk>> {
		const asked = request.voice?.trim().toLowerCase();
		const voice = model.api === "xai-tts" ? XAI_BUILTIN_VOICES.find(candidate => candidate === asked) : undefined;
		const speed =
			model.api === "openai-speech" && typeof request.rate === "number"
				? Math.min(CLOUD_SPEED_MAX, Math.max(CLOUD_SPEED_MIN, request.rate / SAY_DEFAULT_RATE))
				: undefined;
		const result = await this.#services.synthesizeCloud(
			model,
			{
				text: request.text ?? "",
				format: "wav",
				...(voice !== undefined ? { voice } : {}),
				...(speed !== undefined ? { speed } : {}),
			},
			{
				apiKey: registry.resolver(model, this.#session.getSessionId?.()),
				fetch: this.#session.fetch,
				signal,
			},
		);
		const chunk = decodeWav(result.audio);
		return (async function* () {
			yield chunk;
		})();
	}

	async #capture(chunks: AsyncIterable<PcmChunk>): Promise<ShellSpeechResponse> {
		const parts: Float32Array[] = [];
		let total = 0;
		let sampleRate = SILENT_SAMPLE_RATE;
		for await (const chunk of chunks) {
			parts.push(chunk.pcm);
			total += chunk.pcm.length;
			sampleRate = chunk.sampleRate;
		}
		const samples = new Float32Array(total);
		let offset = 0;
		for (const part of parts) {
			samples.set(part, offset);
			offset += part.length;
		}
		return { configured: true, samples, sampleRate };
	}

	/** Play `chunks` gaplessly after any assistant speech; an abort stops the audio at once. */
	async #play(chunks: AsyncIterable<PcmChunk>, signal: AbortSignal): Promise<void> {
		await this.#services.speechIdle();
		const player = this.#services.createPlayer();
		const stop = (): void => player.stop();
		signal.addEventListener("abort", stop, { once: true });
		try {
			let started = false;
			for await (const chunk of chunks) {
				if (signal.aborted) return;
				if (!started) {
					player.start(chunk.sampleRate);
					started = true;
				}
				player.write(chunk.pcm);
			}
			if (started && !signal.aborted) await player.end();
		} catch (error) {
			player.stop();
			throw error;
		} finally {
			signal.removeEventListener("abort", stop);
		}
	}
}

/** The speech binding a shell run of `session` hands to its `say` builtin. */
export function sessionShellSpeech(session: ToolSession): ShellSpeech {
	return new ShellSpeechHost({
		settings: session.settings,
		modelRegistry: session.modelRegistry,
		getSessionProvider: () => session.getActiveModel?.()?.provider,
		getSessionId: () => session.getSessionId?.() ?? undefined,
		fetch: session.fetch,
	}).shellSpeech();
}
