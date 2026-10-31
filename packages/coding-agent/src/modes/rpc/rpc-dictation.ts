import type { AgentSession } from "../../session/agent-session";
import { STTController, type SttCallbacks, type SttTarget } from "../../stt";
import type { RpcDictationFrame } from "./rpc-types";

/** The controller surface used by RPC; tests can substitute the microphone boundary. */
export type RpcDictationController = Pick<STTController, "state" | "start" | "stop" | "dispose">;
export type RpcDictationControllerFactory = (session: AgentSession) => RpcDictationController;

interface Capture {
	id: string;
	controller: RpcDictationController;
	committed: string;
	volatile: string;
	lastPreview: string;
	error?: string;
	stopping: boolean;
	ended: boolean;
	startDone: Promise<void>;
	stopPromise?: Promise<{ text: string }>;
}

/** Owns one draft-only native microphone capture for an RPC session. */
export class RpcDictationBridge {
	readonly #session: AgentSession;
	readonly #output: (frame: RpcDictationFrame) => void;
	readonly #createController: RpcDictationControllerFactory;
	#capture: Capture | undefined;
	#disposed = false;

	constructor(
		session: AgentSession,
		output: (frame: RpcDictationFrame) => void,
		createController: RpcDictationControllerFactory = current =>
			new STTController({
				settings: current.settings,
				registry: current.modelRegistry,
				getSessionId: () => current.sessionId,
			}),
	) {
		this.#session = session;
		this.#output = output;
		this.#createController = createController;
	}

	get active(): boolean {
		return this.#capture !== undefined;
	}

	/** Resolves only when the microphone is recording; stopping a pending start cancels it. */
	async start(id: string): Promise<void> {
		if (typeof id !== "string" || id.length > 128 || !id.trim()) {
			throw new Error("captureId must be a non-blank string of at most 128 characters");
		}
		if (this.#disposed) throw new Error("Dictation is unavailable");
		if (this.#capture) throw new Error("A dictation capture is already active");
		const { promise: startDone, resolve: resolveStart } = Promise.withResolvers<void>();
		const capture: Capture = {
			id,
			controller: this.#createController(this.#session),
			committed: "",
			volatile: "",
			lastPreview: "",
			stopping: false,
			ended: false,
			startDone,
		};
		this.#capture = capture;
		const preview = () => {
			if (capture.ended) return;
			const text = capture.committed + capture.volatile;
			if (text === capture.lastPreview) return;
			capture.lastPreview = text;
			this.#output({ type: "dictation_transcript", captureId: id, text });
		};
		const target: SttTarget = {
			setVolatileText: text => {
				if (capture.ended) return;
				capture.volatile = text;
				preview();
			},
			clearVolatileText: () => {
				if (capture.ended) return;
				capture.volatile = "";
				preview();
			},
			commitVolatileText: text => {
				if (capture.ended) return;
				capture.committed += text;
				capture.volatile = "";
				preview();
			},
			submit: () => {
				throw new Error("Dictation cannot submit a prompt");
			},
			deleteBeforeCursor: () => {
				throw new Error("Dictation cannot edit a prompt");
			},
		};
		const callbacks: SttCallbacks = {
			manualSubmit: true,
			showStatus: () => {},
			showWarning: message => {
				if (!capture.ended) capture.error = message;
			},
			onStateChange: state => {
				if (capture.ended) return;
				if (state === "idle") {
					// Capture errors report idle immediately before their warning. Let both
					// callbacks complete before publishing the single terminal frame.
					queueMicrotask(() => {
						if (!capture.stopping && !capture.ended) this.#finish(capture);
					});
				} else {
					this.#output({ type: "dictation_state", captureId: id, state });
				}
			},
		};
		this.#output({ type: "dictation_state", captureId: id, state: "starting" });
		try {
			if (!capture.stopping && !capture.ended) await capture.controller.start(target, callbacks);
			if (capture.stopping || this.#disposed) throw new Error("Dictation start cancelled");
			if (capture.ended || capture.controller.state !== "recording") {
				throw new Error(capture.error || "Failed to start dictation");
			}
		} catch (cause) {
			const error = cause instanceof Error ? cause : new Error(String(cause));
			if (!capture.stopping && !capture.ended) {
				capture.error ??= error.message;
				this.#finish(capture);
			}
			throw error;
		} finally {
			resolveStart();
		}
	}

	/** Stops the mic and flushes transcription, or returns empty text with no capture. */
	stop(): Promise<{ text: string }> {
		const capture = this.#capture;
		if (!capture) return Promise.resolve({ text: "" });
		if (capture.stopPromise) return capture.stopPromise;
		capture.stopping = true;
		capture.stopPromise = (async () => {
			try {
				// STTController.stop() cancels a pending preflight but returns before
				// start settles; wait for its transition (including any flush) too.
				await capture.controller.stop();
				await capture.startDone;
				if (!capture.ended && capture.controller.state === "recording") await capture.controller.stop();
			} catch (cause) {
				capture.error ??= cause instanceof Error ? cause.message : String(cause);
			}
			const text = capture.committed + capture.volatile;
			this.#finish(capture);
			if (capture.error) throw new Error(capture.error);
			return { text };
		})();
		return capture.stopPromise;
	}

	/** Cancel pending work and close the microphone immediately when the RPC process is going away. */
	dispose(): void {
		this.#disposed = true;
		const capture = this.#capture;
		if (!capture) return;
		capture.stopping = true;
		this.#finish(capture);
	}

	#finish(capture: Capture): void {
		if (capture.ended) return;
		capture.ended = true;
		capture.controller.dispose();
		if (this.#capture === capture) this.#capture = undefined;
		const frame: RpcDictationFrame = {
			type: "dictation_end",
			captureId: capture.id,
			text: capture.committed + capture.volatile,
			...(capture.error ? { error: capture.error } : {}),
		};
		this.#output(frame);
	}
}
