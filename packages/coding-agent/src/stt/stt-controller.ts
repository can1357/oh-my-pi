import { AudioCapture } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { settings } from "../config/settings";
import type { SttTranscriber, SttTranscriptionSession } from "./contracts";
import { evaluateSubmitTrigger } from "./submit-trigger";
import { createSttTranscriber } from "./transcriber-registry";

export type SttState = "idle" | "recording" | "transcribing";

interface ToggleOptions {
	showWarning(message: string): void;
	showStatus(message: string): void;
	onStateChange(state: SttState): void;
	/** Force a redraw after async edits to the composer (live segment/preview inserts). */
	requestRender?(): void;
}

/** The slice of the composer editor the controller drives. */
interface Editor {
	insertText(text: string): void;
	setVolatileText(text: string): void;
	clearVolatileText(): void;
	commitVolatileText(text: string): void;
	submit(): void;
	deleteBeforeCursor(count: number): void;
}

interface CaptureHandle {
	stop(): void;
}

type CaptureFactory = (onAudio: (error: Error | null, samples: Float32Array) => void) => CaptureHandle;

interface STTControllerOptions {
	createCapture?: CaptureFactory;
	modelRegistry?: ModelRegistry;
	getSessionId?: () => string | undefined;
	createTranscriber?: (id: string) => SttTranscriber;
}

/** Coordinates microphone capture, the selected transcriber, and editor updates. */
export class STTController {
	#state: SttState = "idle";
	#toggling = false;
	#stopAfterStart = false;
	#disposed = false;
	readonly #createCapture: CaptureFactory;
	readonly #modelRegistry: ModelRegistry | undefined;
	readonly #getSessionId: () => string | undefined;
	readonly #createTranscriber: (id: string) => SttTranscriber;
	#transcriberId: string | null = null;
	#transcriber: SttTranscriber | null = null;
	#session: SttTranscriptionSession | null = null;
	#recorder: CaptureHandle | null = null;
	#editor: Editor | null = null;
	#abort: AbortController | null = null;
	#committed = false;
	#utterance = "";

	constructor(optionsOrCreateCapture: STTControllerOptions | CaptureFactory = {}) {
		const options =
			typeof optionsOrCreateCapture === "function"
				? { createCapture: optionsOrCreateCapture }
				: optionsOrCreateCapture;
		this.#createCapture = options.createCapture ?? (onAudio => new AudioCapture(16_000, onAudio));
		this.#modelRegistry = options.modelRegistry;
		this.#getSessionId = options.getSessionId ?? (() => undefined);
		this.#createTranscriber = options.createTranscriber ?? createSttTranscriber;
	}

	get state(): SttState {
		return this.#state;
	}

	#setState(state: SttState, options: ToggleOptions): void {
		this.#state = state;
		options.onStateChange(state);
	}

	async toggle(editor: Editor, options: ToggleOptions): Promise<void> {
		if (this.#toggling) {
			if (this.#state === "idle" || this.#state === "recording") this.#stopAfterStart = true;
			return;
		}
		this.#toggling = true;
		try {
			switch (this.#state) {
				case "idle":
					await this.#start(editor, options);
					break;
				case "recording":
					await this.#stop(options);
					break;
				case "transcribing":
					options.showStatus("Transcription in progress...");
					break;
			}
			if (this.#stopAfterStart && this.#state === "recording") {
				this.#stopAfterStart = false;
				await this.#stop(options);
			}
			if (this.#state !== "recording") this.#stopAfterStart = false;
		} finally {
			this.#toggling = false;
		}
	}

	async #start(editor: Editor, options: ToggleOptions): Promise<void> {
		const modelRegistry = this.#modelRegistry;
		this.#editor = editor;
		this.#committed = false;
		this.#utterance = "";
		this.#abort = new AbortController();
		const transcriberId = settings.get("stt.transcriber");
		if (this.#transcriberId !== transcriberId || !this.#transcriber) {
			this.#transcriberId = transcriberId;
			this.#transcriber = this.#createTranscriber(transcriberId);
		}
		const transcriber = this.#transcriber;
		try {
			const session = await transcriber.createSession(
				{
					authStorage: modelRegistry?.authStorage,
					sessionId: this.#getSessionId(),
					language: settings.get("stt.language") || undefined,
					signal: this.#abort.signal,
				},
				{
					onPartial: text => {
						if (this.#disposed || this.#state !== "recording") return;
						this.#editor?.setVolatileText(this.#prefixed(text));
						options.requestRender?.();
					},
					onSegment: text => {
						if (this.#disposed) return;
						const prefixed = this.#prefixed(text);
						if (prefixed) {
							this.#editor?.commitVolatileText(prefixed);
							this.#committed = true;
							this.#utterance += prefixed;
						}
						if (!prefixed) this.#editor?.clearVolatileText();
						options.requestRender?.();
					},
					onDurationWarning: options.showWarning,
					onStatus: options.showStatus,
					onError: error => {
						void this.#failCapture(error, options);
					},
				},
			);
			this.#session = session;
			this.#recorder = this.#createCapture((error, samples) => {
				if (this.#disposed || this.#session !== session || this.#state !== "recording") return;
				if (error) {
					void this.#failCapture(error, options);
					return;
				}
				session.pushAudio(samples);
			});
		} catch (error) {
			await this.#cleanup();
			const message = error instanceof Error ? error.message : "Failed to start speech transcription";
			options.showWarning(message);
			logger.error("STT failed to start", { error: message, transcriber: transcriber.id });
			return;
		}
		this.#setState("recording", options);
		logger.debug("STT recording started", { transcriber: transcriber.id });
	}

	async #stop(options: ToggleOptions): Promise<void> {
		const session = this.#session;
		if (!session) {
			this.#setState("idle", options);
			return;
		}
		this.#setState("transcribing", options);
		this.#stopRecorder();
		let failed = false;
		let finalText = "";
		try {
			finalText = (await session.stop()).trim();
		} catch (error) {
			failed = true;
			if (!this.#disposed) {
				const message = error instanceof Error ? error.message : "Transcription failed";
				options.showWarning(message);
				logger.error("STT transcription failed", { error: message, transcriber: this.#transcriber?.id });
			}
		}
		if (this.#disposed) {
			await this.#cleanup();
			return;
		}
		if (!this.#committed && finalText) {
			const prefixed = this.#prefixed(finalText);
			this.#editor?.commitVolatileText(prefixed);
			this.#committed = true;
			this.#utterance = prefixed;
		}
		if (this.#committed || !finalText) this.#editor?.clearVolatileText();
		options.requestRender?.();
		if (!failed) options.showStatus(this.#committed ? "" : "No speech detected.");
		if (this.#committed && !failed && this.#editor) this.#applySubmitTrigger(this.#editor);
		await this.#cleanup();
		this.#setState("idle", options);
	}

	async #failCapture(error: Error, options: ToggleOptions): Promise<void> {
		this.#abort?.abort(error);
		this.#stopRecorder();
		this.#editor?.clearVolatileText();
		options.requestRender?.();
		this.#setState("idle", options);
		options.showWarning(error.message);
		logger.error("Speech capture failed", { error: error.message });
		await this.#cleanup();
	}

	#prefixed(text: string): string {
		const normalized = text.replace(/\s+/g, " ").trim();
		if (!normalized) return "";
		return this.#committed ? ` ${normalized}` : normalized;
	}

	#applySubmitTrigger(editor: Editor): void {
		const { submit, trimTrailing } = evaluateSubmitTrigger(this.#utterance, settings.get("stt.submitTrigger"));
		if (trimTrailing > 0) editor.deleteBeforeCursor(trimTrailing);
		if (submit) editor.submit();
	}

	#stopRecorder(): void {
		const recorder = this.#recorder;
		this.#recorder = null;
		try {
			recorder?.stop();
		} catch (error) {
			logger.debug("stt: microphone cleanup failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async #cleanup(): Promise<void> {
		const session = this.#session;
		this.#session = null;
		this.#recorder = null;
		this.#editor = null;
		this.#committed = false;
		this.#utterance = "";
		this.#abort = null;
		await session?.dispose().catch(error => {
			logger.debug("stt: session cleanup failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
	}

	dispose(): void {
		this.#disposed = true;
		this.#abort?.abort();
		this.#stopRecorder();
		void this.#cleanup();
		this.#transcriber = null;
		this.#transcriberId = null;
		this.#state = "idle";
	}
}
