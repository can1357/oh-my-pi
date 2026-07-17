/**
 * Streaming assistant speech-vocalization.
 *
 * The vocalizer turns the assistant's STREAMING output into spoken audio as a
 * side effect of the normal turn. Text deltas are streamed *straight into the
 * TTS engine* ({@link Vocalizer.pushDelta} → the worker's incremental text
 * input): the engine splits the running text at sentence boundaries and emits
 * one audio chunk per sentence, which a single {@link StreamingAudioPlayer}
 * plays back gaplessly. So the assistant starts speaking sentence 1 while later
 * sentences are still being generated — low latency, never overlapping.
 *
 * Overspeech control:
 * - {@link clear} stops playback instantly (kills the player) and aborts
 *   in-flight synthesis — wired to a new turn, an Esc/Ctrl+C interrupt, and a
 *   sent message.
 * - {@link duck}/{@link unduck} lower/restore the volume while the user is
 *   speaking (push-to-talk), so the assistant doesn't talk over them.
 * - Sessions are chained, so sequential utterances queue and drain in order
 *   rather than overlapping.
 *
 * Errors are swallowed (debug-logged) so a synthesis or playback failure never
 * throws into the turn. A process-level singleton ({@link vocalizer}) is shared
 * by the event controller (streaming deltas) and the ask tool (spoken questions).
 */
import { logger } from "@pk-nerdsaver-ai/pi-utils";
import { settings } from "../config/settings";
import { DEFAULT_TTS_VOICE } from "./models";
import { isSpeechHardStopped } from "./speech-hard-stop";
import { createStreamingPlayer, DUCK_GAIN } from "./streaming-player";
import { type TtsStreamHandle, ttsClient } from "./tts-client";

export interface VocalizerPlayer {
	start(sampleRate: number): void;
	write(pcm: Float32Array): void;
	setGain(gain: number): void;
	end(): Promise<void>;
	stop(): void;
}

export class Vocalizer {
	/** Open stream session for the current utterance; null when none is active. */
	#handle: TtsStreamHandle | null = null;
	/** Aborts the in-flight session on {@link clear}; replaced per session. */
	#abort: AbortController | null = null;
	/** The current session's player; stopped on {@link clear}, gain-tracked for ducking. */
	#player: VocalizerPlayer | null = null;
	/** Serialized playback chain across sessions; awaited by {@link idle}. */
	#chain: Promise<void> = Promise.resolve();
	/** Whether the user is currently speaking; new sessions open ducked. */
	#ducked = false;
	#createPlayer: () => VocalizerPlayer;

	constructor(createPlayer: () => VocalizerPlayer = createStreamingPlayer) {
		this.#createPlayer = createPlayer;
	}

	/**
	 * Stream a delta of assistant text into the engine. No-op when vocalization
	 * is disabled. The engine buffers the running text and emits audio for each
	 * complete sentence; the trailing partial is flushed by {@link flush}.
	 */
	pushDelta(text: string): void {
		if (!settings.get("speech.enabled") || isSpeechHardStopped()) return;
		if (!text) return;
		this.#ensureSession().push(text);
	}

	/**
	 * Close the current input stream (call at message/turn end). The engine
	 * flushes its trailing partial as a final chunk; the player keeps draining
	 * queued audio until it completes.
	 */
	flush(): void {
		this.#handle?.end();
		this.#handle = null;
	}

	/**
	 * Speak a complete piece of text in one shot (ask questions, yield-mode final
	 * message): stream it in and immediately close the input. No-op when disabled.
	 */
	speak(text: string): void {
		if (!settings.get("speech.enabled") || isSpeechHardStopped()) return;
		if (!text) return;
		this.#ensureSession().push(text);
		this.flush();
	}

	/**
	 * Interrupt and drop the current session, killing in-flight playback and
	 * synthesis (new turn / user message / Esc interrupt). Audio stops at once.
	 */
	clear(): void {
		this.#handle = null;
		this.#abort?.abort();
		this.#abort = null;
		this.#player?.stop();
		this.#player = null;
	}

	/** Lower the volume while the user is speaking (push-to-talk), so speech doesn't drown them out. */
	duck(): void {
		this.#ducked = true;
		this.#player?.setGain(DUCK_GAIN);
	}

	/** Restore full volume once the user stops speaking. */
	unduck(): void {
		this.#ducked = false;
		this.#player?.setGain(1);
	}

	/** Resolve once the playback chain has drained (tests / shutdown). */
	idle(): Promise<void> {
		return this.#chain;
	}

	/**
	 * Open a streaming-synthesis session lazily on the first delta and chain its
	 * playback after any prior session's, so sequential utterances never overlap.
	 */
	#ensureSession(): TtsStreamHandle {
		if (this.#handle) return this.#handle;
		const modelKey = settings.get("tts.localModel");
		const voice = settings.get("speech.voice") || DEFAULT_TTS_VOICE;
		const abort = new AbortController();
		this.#abort = abort;
		const handle = ttsClient.synthesizeStream(modelKey, { voice, signal: abort.signal });
		this.#handle = handle;
		const player = this.#createPlayer();
		player.setGain(this.#ducked ? DUCK_GAIN : 1);
		this.#player = player;
		this.#chain = this.#chain.then(() => this.#play(handle, player, abort.signal));
		return handle;
	}

	/** Feed each synthesized sentence into the player in arrival order; abort stops it. */
	async #play(handle: TtsStreamHandle, player: VocalizerPlayer, signal: AbortSignal): Promise<void> {
		let started = false;
		try {
			for await (const chunk of handle.chunks) {
				if (signal.aborted || isSpeechHardStopped()) break;
				if (!started) {
					player.start(chunk.sampleRate);
					started = true;
				}
				player.write(chunk.pcm);
			}
			if (started && !signal.aborted) {
				await player.end();
				return;
			}
		} catch (error) {
			logger.debug("vocalizer: stream failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
		player.stop();
	}
}

/** Process-level vocalizer shared by the event controller and the ask tool. */
export const vocalizer = new Vocalizer();
