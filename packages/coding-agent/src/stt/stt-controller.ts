import { AudioCapture } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import { settings } from "../config/settings";
import { appleSpeechClient } from "./apple-speech-client";
import { type SttStreamHandle, sttClient } from "./asr-client";
import { downloadSttModel, isSttModelCached } from "./downloader";
import { resolveSttModelSpec, type SttModelKey } from "./models";
import { evaluateSubmitTrigger } from "./submit-trigger";

export type SttState = "idle" | "recording" | "transcribing";

interface ToggleOptions {
	showWarning(msg: string): void;
	showStatus(msg: string): void;
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

/** Coordinates native microphone capture with incremental local transcription. */
export class STTController {
	#state: SttState = "idle";
	#resolvedDependencyKey: string | null = null;
	#toggling = false;
	#stopAfterStart = false;
	#disposed = false;
	readonly #lifetimeAbort = new AbortController();
	readonly #createCapture: CaptureFactory;

	// Live streaming capture.
	#stream: SttStreamHandle | null = null;
	#streamRecorder: CaptureHandle | null = null;
	#streamEditor: Editor | null = null;
	#streamCommitted = false;
	#streamAbort: AbortController | null = null;
	#streamUtterance = "";

	/** Creates a controller; tests may replace the hardware capture boundary. */
	constructor(createCapture: CaptureFactory = onAudio => new AudioCapture(16_000, onAudio)) {
		this.#createCapture = createCapture;
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
			} else if (this.#state !== "recording") {
				this.#stopAfterStart = false;
			}
		} finally {
			this.#toggling = false;
		}
	}

	async #ensureDeps(options: ToggleOptions): Promise<boolean> {
		const spec = resolveSttModelSpec(settings.get("stt.modelName") as string | undefined);
		const language = settings.get("stt.language") as string | undefined;
		// Apple speech assets are locale-specific. A language change must repeat
		// the native status/prepare probe even when the engine itself is unchanged.
		const dependencyKey = spec.engine === "speech-analyzer" ? `${spec.key}\0${language?.trim() || "auto"}` : spec.key;
		if (this.#resolvedDependencyKey === dependencyKey) return true;
		try {
			// Only clear the status line when preflight emitted progress; cached
			// worker models and already-installed Apple locales emit nothing.
			let wroteStatus = false;
			const status = (msg: string): void => {
				wroteStatus = true;
				options.showStatus(msg);
			};
			if (spec.engine === "speech-analyzer") {
				const signal = this.#lifetimeAbort.signal;
				const availability = await appleSpeechClient.status(language, signal);
				if (!availability.success || !availability.available || !availability.supported) {
					throw new Error(availability.error ?? "Apple SpeechAnalyzer is unavailable for the selected locale.");
				}
				if (!availability.installed) {
					const locale = availability.locale ?? language?.trim() ?? "system locale";
					status(`Preparing system-managed Apple speech recognition (${locale})...`);
					await appleSpeechClient.prepare(language, signal);
				}
			} else if (await isSttModelCached(spec.key)) {
				// Loading the multi-hundred-MB worker model used to block before
				// recording. Cached models start now and warm in the background;
				// only a genuine first-use download blocks.
				this.#warmModel(spec.key);
			} else {
				await downloadSttModel(spec.key, progress =>
					status(`Downloading speech model ${progress.label} (${progress.percent}%)`),
				);
			}
			if (this.#disposed) return false;
			if (wroteStatus) options.showStatus("");
			this.#resolvedDependencyKey = dependencyKey;
			return true;
		} catch (err) {
			if (this.#disposed) return false;
			const msg = err instanceof Error ? err.message : "Failed to setup STT dependencies";
			options.showWarning(msg);
			logger.error("STT dependency setup failed", { error: msg });
			return false;
		}
	}

	/** Warm the speech model in the worker without blocking recording. The worker
	 *  memoizes the load, so the stream/transcribe path reuses it and the model is
	 *  hot by the time recording stops. Only called when the weights are already
	 *  cached, so no network fetch happens. On load failure (corrupt cache, OOM,
	 *  runtime install) invalidate the resolved key so the next toggle re-runs
	 *  preflight and retries instead of skipping it forever. */
	#warmModel(modelKey: SttModelKey): void {
		void downloadSttModel(modelKey).catch(err => {
			// Guard against a concurrent model switch clobbering a newer resolution.
			if (!this.#disposed && this.#resolvedDependencyKey === modelKey) this.#resolvedDependencyKey = null;
			logger.debug("stt: background model warmup failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		});
	}

	async #start(editor: Editor, options: ToggleOptions): Promise<void> {
		if (!(await this.#ensureDeps(options))) return;
		if (this.#disposed) return;
		await this.#startStreaming(editor, options);
	}

	async #stop(options: ToggleOptions): Promise<void> {
		await this.#stopStreaming(options);
	}

	// ── Live streaming ──────────────────────────────────────────────

	/** Segment text gets a leading space once a prior segment is committed, so
	 *  phrases join naturally; the first phrase is inserted at the cursor as-is. */
	#prefixed(text: string): string {
		const normalized = text.replace(/\s+/g, " ").trim();
		if (!normalized) return "";
		return this.#streamCommitted ? ` ${normalized}` : normalized;
	}

	async #startStreaming(editor: Editor, options: ToggleOptions): Promise<void> {
		if (this.#disposed) return;
		const spec = resolveSttModelSpec(settings.get("stt.modelName") as string | undefined);
		const language = settings.get("stt.language") as string | undefined;
		this.#streamEditor = editor;
		this.#streamCommitted = false;
		this.#streamUtterance = "";
		this.#streamAbort = new AbortController();
		const streamOptions = {
			language: language || undefined,
			signal: this.#streamAbort.signal,
			onPartial: (text: string) => {
				if (this.#disposed || this.#state !== "recording") return;
				this.#streamEditor?.setVolatileText(this.#prefixed(text));
				options.requestRender?.();
			},
			onSegment: (text: string) => {
				if (this.#disposed) return;
				const prefixed = this.#prefixed(text);
				if (prefixed) {
					this.#streamEditor?.commitVolatileText(prefixed);
					this.#streamCommitted = true;
					this.#streamUtterance += prefixed;
				} else {
					this.#streamEditor?.clearVolatileText();
				}
				options.requestRender?.();
			},
		};
		let stream: SttStreamHandle;
		try {
			// SpeechAnalyzer performs an async ready handshake before microphone
			// capture begins; worker streams are ready synchronously.
			stream =
				spec.engine === "speech-analyzer"
					? await appleSpeechClient.startStream(language, streamOptions)
					: sttClient.startStream(spec.key, streamOptions);
		} catch (err) {
			this.#cleanupStream();
			if (!this.#disposed) {
				const msg = err instanceof Error ? err.message : "Failed to start speech recognition";
				options.showWarning(msg);
				logger.error("STT stream failed to start", { error: msg });
			}
			return;
		}
		this.#stream = stream;
		if (this.#disposed) {
			stream.cancel();
			this.#cleanupStream();
			return;
		}
		let recorder: CaptureHandle;
		try {
			recorder = this.#createCapture((error, samples) => {
				if (this.#disposed || this.#stream !== stream || this.#state !== "recording") return;
				if (error) {
					logger.error("Native microphone capture failed", { error: error.message });
					const activeRecorder = this.#streamRecorder;
					this.#streamRecorder = null;
					try {
						activeRecorder?.stop();
					} catch (cause) {
						logger.debug("stt: microphone cleanup failed", {
							error: cause instanceof Error ? cause.message : String(cause),
						});
					}
					this.#streamAbort?.abort(error);
					stream.cancel();
					this.#streamEditor?.clearVolatileText();
					options.requestRender?.();
					this.#cleanupStream();
					this.#setState("idle", options);
					options.showWarning(error.message);
					return;
				}
				stream.pushAudio(samples);
			});
		} catch (err) {
			stream.cancel();
			this.#cleanupStream();
			const msg = err instanceof Error ? err.message : "Failed to start microphone capture";
			options.showWarning(msg);
			logger.error("STT recording failed to start", { error: msg });
			return;
		}
		this.#streamRecorder = recorder;
		this.#setState("recording", options);
		logger.debug("STT live recording started", { modelKey: spec.key });
	}

	async #stopStreaming(options: ToggleOptions): Promise<void> {
		const stream = this.#stream;
		const recorder = this.#streamRecorder;
		if (!stream) {
			this.#setState("idle", options);
			return;
		}
		this.#setState("transcribing", options);
		// Stop the mic first so no further audio is fed, then flush the worker.
		try {
			recorder?.stop();
		} catch (err) {
			logger.debug("stt: streaming recorder stop failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
		this.#streamRecorder = null;

		let failed = false;
		let finalText = "";
		try {
			finalText = (await stream.stop()).trim();
		} catch (err) {
			failed = true;
			if (!this.#disposed) {
				const msg = err instanceof Error ? err.message : "Transcription failed";
				options.showWarning(msg);
				logger.error("STT live transcription failed", { error: msg });
			}
		}
		if (this.#disposed) {
			this.#cleanupStream();
			return;
		}
		if (!this.#streamCommitted && finalText) {
			const prefixed = this.#prefixed(finalText);
			this.#streamEditor?.commitVolatileText(prefixed);
			this.#streamCommitted = true;
			this.#streamUtterance = prefixed;
		} else {
			this.#streamEditor?.clearVolatileText();
		}
		options.requestRender?.();
		if (!failed) options.showStatus(this.#streamCommitted ? "" : "No speech detected.");

		if (this.#streamCommitted && !failed && this.#streamEditor) {
			const trigger = settings.get("stt.submitTrigger");
			const { submit, trimTrailing } = evaluateSubmitTrigger(this.#streamUtterance, trigger);
			if (trimTrailing > 0) {
				this.#streamEditor.deleteBeforeCursor(trimTrailing);
			}
			if (submit) {
				this.#streamEditor.submit();
			}
		}

		this.#cleanupStream();
		this.#setState("idle", options);
	}

	#cleanupStream(): void {
		this.#stream = null;
		this.#streamRecorder = null;
		this.#streamEditor = null;
		this.#streamCommitted = false;
		this.#streamAbort = null;
		this.#streamUtterance = "";
	}

	dispose(): void {
		this.#disposed = true;
		this.#lifetimeAbort.abort();
		if (this.#streamAbort) {
			this.#streamAbort.abort();
			this.#streamAbort = null;
		}
		this.#stream?.cancel();
		try {
			this.#streamRecorder?.stop();
		} catch {
			// best effort cleanup
		}
		this.#cleanupStream();
		this.#state = "idle";
		this.#resolvedDependencyKey = null;
	}
}
