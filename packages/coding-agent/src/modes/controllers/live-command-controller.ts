import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { batch } from "@oh-my-pi/pi-tui";
import { logger, toError } from "@oh-my-pi/pi-utils";
import { LiveSessionController, type LiveSessionControllerOptions, type LiveTranscript } from "../../live/controller";
import { LIVE_MODEL } from "../../live/protocol";
import { vocalizer } from "../../tts/vocalizer";
import type { AssistantView, InteractiveModeContext } from "../types";
import type { OverlayHandle } from "../../ui/shell";
import { createLiveCallModel, type LiveCallModel, LiveVisualizer } from "../../ui/apps/live-visualizer";
import { canonicalKeyId } from "../../config/keybindings/key-id";
import type { ExtensionLiveSession, ExtensionLiveStartOptions } from "../../extensibility/extensions/types";
import { resolveLiveVoice } from "../../live/settings";

const ANIMATION_INTERVAL_MS = 80;
type LiveSessionFactory = (options: LiveSessionControllerOptions) => LiveSessionController;
/** A started session, or the connect failure `#finish` has already shown and cleaned up. */
type LiveStartOutcome = { session: LiveSessionController } | { error: Error };

const LIVE_MESSAGE_USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Runs an extension's live observer; its failures are logged, never turned into a session failure. */
function notifyRemote(callback: () => void): void {
	try {
		callback();
	} catch (cause) {
		logger.warn("Live session observer threw", { error: toError(cause).message });
	}
}

/** Owns the composer-replacing visualizer and realtime session lifecycle for `/live`. */
export class LiveCommandController {
	readonly #ctx: InteractiveModeContext;
	readonly #createSession: LiveSessionFactory | undefined;

	#session: LiveSessionController | undefined;
	#settling: Promise<void> | undefined;
	#visualizer: LiveCallModel | undefined;
	/** The visualizer in the composer's place; closing it brings the composer back. */
	#visualizerHandle: OverlayHandle | undefined;
	#animationInterval: NodeJS.Timeout | undefined;
	#resumeVocalizer: (() => void) | undefined;
	#assistantTranscript: AssistantView | undefined;
	#assistantTranscriptTurn = 0;
	#assistantTranscriptStartedAt = 0;

	constructor(ctx: InteractiveModeContext, createSession?: LiveSessionFactory) {
		this.#ctx = ctx;
		this.#createSession = createSession;
	}

	/** Whether a live session is connected, connecting, or closing. */
	get active(): boolean {
		return this.#session !== undefined || this.#settling !== undefined;
	}

	/** Start live mode, or stop the currently active session. */
	async handleCommand(): Promise<void> {
		if (this.#session) {
			await this.stop();
			return;
		}
		while (this.#settling) await this.#settling;
		// Another start may have claimed the slot while the previous session finished closing.
		if (this.#session) return;
		// A connect failure was already shown; anything else (factory, mounting) propagates.
		await this.#start(resolveLiveVoice(this.#ctx.settings));
	}

	/**
	 * Start a live session whose audio runs on a caller-owned WebRTC peer. The visualizer shows
	 * it as it shows `/live`, and `/live` or the stop key ends it.
	 */
	async startRemote(options: ExtensionLiveStartOptions): Promise<ExtensionLiveSession> {
		// Untyped callers: without an offer the controller would open the host microphone instead.
		if (typeof options.sdpOffer !== "string" || !options.sdpOffer.trim()) {
			throw new Error("startLive requires a non-empty sdpOffer");
		}
		while (this.#settling) await this.#settling;
		const voice = resolveLiveVoice(this.#ctx.settings, options.voice);
		const outcome = await this.#start(voice, options);
		if ("error" in outcome) throw outcome.error;
		const { session } = outcome;
		const stop = async (): Promise<void> => {
			if (this.#session === session) await this.stop();
			else await session.stop();
		};
		const sdpAnswer = session.sdpAnswer;
		if (sdpAnswer === undefined) {
			await stop();
			throw new Error("The live session stopped before its SDP answer was available");
		}
		return { sdpAnswer, voice, stop };
	}

	/** Stop the active live session and restore the editor. */
	async stop(): Promise<void> {
		const session = this.#session;
		if (!session) {
			if (this.#settling) await this.#settling;
			return;
		}
		try {
			await session.stop();
		} catch (cause) {
			this.#finish(session, toError(cause));
		} finally {
			this.#finish(session);
		}
	}

	/** Release UI resources during synchronous InteractiveMode teardown. */
	dispose(): void {
		const session = this.#session;
		if (session) {
			this.#finish(session);
			void session.stop().catch(cause => {
				logger.debug("Live session teardown failed", { error: toError(cause).message });
			});
		} else {
			this.#restoreEditor();
		}
	}

	/**
	 * Starts a session. A connect failure is shown, cleaned up and returned; the slot check and
	 * claim (`#session = session`) run synchronously, so concurrent starts cannot both win.
	 */
	async #start(voice: string, remote?: ExtensionLiveStartOptions): Promise<LiveStartOutcome> {
		if (this.#session) throw new Error("A live session is already active");
		this.#assistantTranscriptTurn = 0;
		this.#assistantTranscriptStartedAt = 0;
		const visualizer = createLiveCallModel();
		this.#mountVisualizer(visualizer);

		const options: LiveSessionControllerOptions = {
			session: this.#ctx.session,
			extractAssistantText: message => this.#ctx.extractAssistantText(message),
			voice,
			instructions: remote?.instructions,
			sdpOffer: remote?.sdpOffer,
			callbacks: {
				onPhase: phase => {
					notifyRemote(() => remote?.onPhase?.(phase));
					if (this.#visualizer !== visualizer) return;
					visualizer.setPhase(phase);
				},
				onLevels: input => {
					if (this.#visualizer !== visualizer) return;
					visualizer.setInputLevel(input);
				},
				onTranscript: transcript => {
					if (transcript) notifyRemote(() => remote?.onTranscript?.(transcript));
					if (this.#visualizer !== visualizer) return;
					if (!transcript) {
						visualizer.clearTranscript();
					} else if (transcript.role === "user") {
						visualizer.setTranscript(transcript.text);
					} else {
						this.#presentAssistantTranscript(transcript);
					}
				},
				onTerminal: error => {
					this.#finish(session, error);
					notifyRemote(() => remote?.onEnd?.(error));
				},
			},
		};
		let session: LiveSessionController;
		try {
			session = this.#createSession ? this.#createSession(options) : new LiveSessionController(options);
		} catch (cause) {
			// No session to finish: put the editor back before the failure propagates.
			this.#restoreEditor();
			throw cause;
		}
		this.#session = session;

		try {
			await session.start();
		} catch (cause) {
			const error = toError(cause);
			if (this.#session === session) {
				await session.stop();
				this.#finish(session, error);
			}
			return { error };
		}
		return { session };
	}

	#presentAssistantTranscript(transcript: LiveTranscript): void {
		if (
			transcript.turn < this.#assistantTranscriptTurn ||
			(transcript.turn === this.#assistantTranscriptTurn && !this.#assistantTranscript)
		) {
			return;
		}
		if (transcript.turn > this.#assistantTranscriptTurn) {
			this.#finalizeAssistantTranscript();
			this.#assistantTranscriptTurn = transcript.turn;
		}

		if (!this.#assistantTranscript) this.#assistantTranscriptStartedAt = Date.now();
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: transcript.text }],
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: LIVE_MODEL,
			usage: { ...LIVE_MESSAGE_USAGE },
			stopReason: "stop",
			timestamp: this.#assistantTranscriptStartedAt,
		};
		// The spoken reply reads in the accent, apart from typed turns.
		const view = this.#assistantTranscript ?? this.#ctx.presentAssistant(message, { tone: "accent" });
		this.#assistantTranscript = view;
		batch(() => {
			view.message.set(message);
			view.transient.set(!transcript.final);
		});
		if (transcript.final) {
			view.finalized.set(true);
			this.#assistantTranscript = undefined;
			this.#assistantTranscriptStartedAt = 0;
		}
	}

	#finalizeAssistantTranscript(): void {
		const view = this.#assistantTranscript;
		if (!view) return;
		view.finalized.set(true);
		this.#assistantTranscript = undefined;
		this.#assistantTranscriptStartedAt = 0;
	}

	#mountVisualizer(visualizer: LiveCallModel): void {
		this.#visualizer = visualizer;
		const stopKeys = this.#ctx.keybindings.keysFor("app.live.toggle").map(canonicalKeyId);
		this.#visualizerHandle = this.#ctx.showEditorAreaDialog(() =>
			LiveVisualizer({
				model: visualizer,
				onStop: () => {
					void this.stop().catch(cause => this.#ctx.showError(toError(cause).message));
				},
				onToggleMute: () => this.#session?.toggleMute(),
				stopKeys,
			}),
		);
		this.#resumeVocalizer = vocalizer.suspend();
		let frame = 0;
		this.#animationInterval = setInterval(() => {
			if (this.#visualizer !== visualizer) return;
			frame += 1;
			visualizer.setFrame(frame);
		}, ANIMATION_INTERVAL_MS);
	}
	#finish(session: LiveSessionController, error?: Error): void {
		if (this.#session !== session) return;
		this.#session = undefined;
		this.#restoreEditor();
		if (error) this.#ctx.showError(error.message);
		const settling = session.stop().catch(cause => {
			logger.debug("Live session cleanup failed", { error: toError(cause).message });
		});
		this.#settling = settling;
		void settling.finally(() => {
			if (this.#settling === settling) this.#settling = undefined;
		});
	}

	#restoreEditor(): void {
		this.#finalizeAssistantTranscript();
		if (this.#animationInterval) {
			clearInterval(this.#animationInterval);
			this.#animationInterval = undefined;
		}
		this.#resumeVocalizer?.();
		this.#resumeVocalizer = undefined;
		this.#visualizer = undefined;
		const handle = this.#visualizerHandle;
		this.#visualizerHandle = undefined;
		handle?.close();
	}
}
