import type { ApiKeyResolver } from "@oh-my-pi/pi-ai";
import { transcribeAudio } from "@oh-my-pi/pi-ai/transcription";
import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import { AudioCapture } from "@oh-my-pi/pi-natives";
import type { ModelBrowserRegistry } from "@oh-my-pi/pi-tui/overlays/model-browser";
import { logger } from "@oh-my-pi/pi-utils";
import { resolveRoleChain } from "../config/model-resolver";
import { roleCandidatePool } from "../config/model-roles";
import { type Settings, settings } from "../config/settings";
import { type SttStreamHandle, sttClient } from "./asr-client";
import { downloadSttModel, isSttModelCached } from "./downloader";
import { resolveSttModelSpec, type SttModelKey } from "./models";
import { evaluateSubmitTrigger } from "./submit-trigger";
import { encodePcm16Wav } from "./wav";

export type SttState = "idle" | "recording" | "transcribing";

export interface ToggleOptions {
	showWarning(msg: string): void;
	showStatus(msg: string): void;
	onStateChange(state: SttState): void;
	submitEditor?(editor: Editor): void;
	subscribeFocus?(listener: () => void): () => void;
}

/** The slice of a text editor the controller drives. */
export interface Editor {
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

interface SttRegistry extends ModelBrowserRegistry {
	resolver(model: Model<Api>, sessionId?: string): ApiKeyResolver;
}

export interface STTControllerDependencies {
	settings: Settings;
	registry: SttRegistry;
	getSessionId?: () => string;
}

/** Coordinates native microphone capture with streaming local or buffered cloud transcription. */
export class STTController {
	#state: SttState = "idle";
	#resolvedModelKey: SttModelKey | null = null;
	#toggling = false;
	#stopAfterStart = false;
	#disposed = false;
	readonly #createCapture: CaptureFactory;
	readonly #settings: Settings;
	readonly #registry: SttRegistry | undefined;
	readonly #getSessionId: (() => string) | undefined;
	#resolveEditor: (() => Editor | null) | null = null;
	#fallbackEditor: Editor | null = null;
	#unsubscribeFocus: (() => void) | null = null;
	#lastPartial = "";

	// Live streaming capture.
	#stream: SttStreamHandle | null = null;
	#streamRecorder: CaptureHandle | null = null;
	#streamEditor: Editor | null = null;
	#streamCommitted = false;
	#streamAbort: AbortController | null = null;
	#streamUtterance = "";

	// Buffered cloud capture.
	#cloudModel: Model<Api> | null = null;
	#cloudAudio: Float32Array[] = [];

	/** Creates a controller; tests may replace the hardware capture boundary. */
	constructor();
	constructor(createCapture: CaptureFactory);
	constructor(dependencies: STTControllerDependencies);
	constructor(createCapture: CaptureFactory, dependencies: STTControllerDependencies);
	constructor(
		createCaptureOrDependencies?: CaptureFactory | STTControllerDependencies,
		dependencies?: STTControllerDependencies,
	) {
		if (typeof createCaptureOrDependencies === "function") {
			this.#createCapture = createCaptureOrDependencies;
			this.#settings = dependencies?.settings ?? settings;
			this.#registry = dependencies?.registry;
			this.#getSessionId = dependencies?.getSessionId;
		} else {
			this.#createCapture = onAudio => new AudioCapture(16_000, onAudio);
			this.#settings = createCaptureOrDependencies?.settings ?? settings;
			this.#registry = createCaptureOrDependencies?.registry;
			this.#getSessionId = createCaptureOrDependencies?.getSessionId;
		}
	}

	get state(): SttState {
		return this.#state;
	}

	#setState(state: SttState, options: ToggleOptions): void {
		this.#state = state;
		options.onStateChange(state);
	}

	async toggle(resolveEditor: () => Editor | null, fallbackEditor: Editor, options: ToggleOptions): Promise<void> {
		if (this.#toggling) {
			if (this.#state === "idle" || this.#state === "recording") this.#stopAfterStart = true;
			return;
		}
		this.#toggling = true;
		try {
			switch (this.#state) {
				case "idle":
					await this.#start(resolveEditor, fallbackEditor, options);
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

	#resolveModel(): Model<Api> | undefined {
		if (!this.#registry) return undefined;
		const pool = roleCandidatePool("dictation", this.#settings, this.#registry);
		return resolveRoleChain("dictation", this.#settings, pool)[0]?.model;
	}

	#resolveModelKey(model = this.#resolveModel()): SttModelKey {
		return resolveSttModelSpec(model?.id).key;
	}

	async #ensureDeps(options: ToggleOptions, modelKey = this.#resolveModelKey()): Promise<SttModelKey | null> {
		// Keyed on the resolved role model rather than a one-shot flag: changing
		// modelRoles.dictation mid-session re-runs preflight for the new model.
		if (this.#resolvedModelKey === modelKey) return modelKey;
		try {
			// Only clear the status line when preflight emitted progress; the
			// cached-model fast path emits nothing.
			let wroteStatus = false;
			const status = (msg: string): void => {
				wroteStatus = true;
				options.showStatus(msg);
			};
			// Loading the multi-hundred-MB speech model into the worker is what made
			// the old "Checking STT dependencies…" step slow. Don't pay it before
			// recording: when the weights are already cached, start now and warm the
			// model in the background — the stream/transcribe paths load it on demand
			// (memoized in the worker) and it is hot by the time recording stops.
			// Only a genuine first-use download blocks, with explicit progress, so we
			// never record silently against missing weights.
			if (await isSttModelCached(modelKey)) {
				this.#warmModel(modelKey);
			} else {
				await downloadSttModel(modelKey, p => status(`Downloading speech model ${p.label} (${p.percent}%)`));
			}
			if (wroteStatus) options.showStatus("");
			this.#resolvedModelKey = modelKey;
			return modelKey;
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Failed to setup STT dependencies";
			options.showWarning(msg);
			logger.error("STT dependency setup failed", { error: msg });
			return null;
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
			if (!this.#disposed && this.#resolvedModelKey === modelKey) this.#resolvedModelKey = null;
			logger.debug("stt: background model warmup failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		});
	}

	async #start(resolveEditor: () => Editor | null, fallbackEditor: Editor, options: ToggleOptions): Promise<void> {
		let model = this.#resolveModel();
		if (model?.api === "openai-transcriptions") {
			this.#startBuffered(resolveEditor, fallbackEditor, options, model);
			return;
		}
		if (model && model.api !== "local-inference") {
			options.showWarning(`Unsupported speech-to-text API: ${model.api}`);
			return;
		}

		let modelKey = await this.#ensureDeps(options, this.#resolveModelKey(model));
		if (!modelKey) return;
		model = this.#resolveModel();
		if (model?.api === "openai-transcriptions") {
			this.#startBuffered(resolveEditor, fallbackEditor, options, model);
			return;
		}
		if (model && model.api !== "local-inference") {
			options.showWarning(`Unsupported speech-to-text API: ${model.api}`);
			return;
		}
		const startModelKey = this.#resolveModelKey(model);
		if (startModelKey !== modelKey) {
			modelKey = await this.#ensureDeps(options, startModelKey);
			if (!modelKey) return;
		}
		await this.#startStreaming(resolveEditor, fallbackEditor, options, modelKey);
	}

	async #stop(options: ToggleOptions): Promise<void> {
		if (this.#cloudModel) await this.#stopBuffered(options);
		else await this.#stopStreaming(options);
	}

	#attachFocus(resolveEditor: () => Editor | null, fallbackEditor: Editor, options: ToggleOptions): void {
		this.#resolveEditor = resolveEditor;
		this.#fallbackEditor = fallbackEditor;
		this.#streamEditor = resolveEditor();
		this.#lastPartial = "";
		this.#unsubscribeFocus = options.subscribeFocus?.(() => this.#handleFocusChange()) || null;
	}

	#releaseFocus(): void {
		this.#unsubscribeFocus?.();
		this.#unsubscribeFocus = null;
		this.#resolveEditor = null;
		this.#fallbackEditor = null;
		this.#lastPartial = "";
	}

	#handleFocusChange(): boolean {
		if (this.#disposed || this.#state !== "recording") return false;
		const nextEditor = this.#resolveEditor?.() || null;
		if (nextEditor === this.#streamEditor) return false;
		this.#streamEditor?.clearVolatileText();
		this.#streamEditor = nextEditor;
		const preview = this.#currentVolatilePreview();
		if (preview) nextEditor?.setVolatileText(preview);
		return true;
	}

	// ── Buffered cloud transcription ────────────────────────────────

	#startBuffered(
		resolveEditor: () => Editor | null,
		fallbackEditor: Editor,
		options: ToggleOptions,
		model: Model<Api>,
	): void {
		this.#attachFocus(resolveEditor, fallbackEditor, options);
		this.#streamCommitted = false;
		this.#streamUtterance = "";
		this.#streamAbort = new AbortController();
		this.#cloudModel = model;
		this.#cloudAudio = [];

		try {
			this.#streamRecorder = this.#createCapture((error, samples) => {
				if (this.#disposed || this.#cloudModel !== model || this.#state !== "recording") return;
				if (error) {
					logger.error("Native microphone capture failed", { error: error.message });
					const recorder = this.#streamRecorder;
					this.#streamRecorder = null;
					try {
						recorder?.stop();
					} catch (cause) {
						logger.debug("stt: microphone cleanup failed", {
							error: cause instanceof Error ? cause.message : String(cause),
						});
					}
					this.#streamAbort?.abort(error);
					this.#streamEditor?.clearVolatileText();
					this.#cleanupCloud();
					this.#setState("idle", options);
					options.showWarning(error.message);
					return;
				}
				if (samples.length > 0) this.#cloudAudio.push(samples.slice());
			});
		} catch (err) {
			this.#streamAbort?.abort();
			this.#cleanupCloud();
			const msg = err instanceof Error ? err.message : "Failed to start microphone capture";
			options.showWarning(msg);
			logger.error("STT recording failed to start", { error: msg });
			return;
		}

		this.#setState("recording", options);
		logger.debug("STT buffered recording started", { model: `${model.provider}/${model.id}` });
	}

	async #stopBuffered(options: ToggleOptions): Promise<void> {
		const model = this.#cloudModel;
		const recorder = this.#streamRecorder;
		const abort = this.#streamAbort;
		if (!model || !abort || !this.#registry) {
			this.#cleanupCloud();
			this.#setState("idle", options);
			return;
		}

		this.#setState("transcribing", options);
		options.showStatus("Transcribing...");
		try {
			recorder?.stop();
		} catch (err) {
			logger.debug("stt: buffered recorder stop failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
		this.#streamRecorder = null;

		let failed = false;
		let finalText = "";
		try {
			const language = this.#settings.get("stt.language");
			const result = await transcribeAudio(
				model,
				{
					audio: encodePcm16Wav(this.#cloudAudio),
					mimeType: "audio/wav",
					fileName: "dictation.wav",
					responseFormat: "json",
					...(language && { language }),
				},
				{
					apiKey: this.#registry.resolver(model, this.#getSessionId?.()),
					signal: abort.signal,
				},
			);
			finalText = result.text.trim();
		} catch (err) {
			failed = true;
			if (!this.#disposed) {
				const msg = err instanceof Error ? err.message : "Transcription failed";
				options.showWarning(msg);
				logger.error("STT cloud transcription failed", { error: msg });
			}
		}
		if (this.#disposed) {
			this.#cleanupCloud();
			return;
		}

		this.#finishTranscript(finalText, failed, options);
		this.#cleanupCloud();
		this.#setState("idle", options);
	}

	#cleanupCloud(): void {
		this.#cloudModel = null;
		this.#cloudAudio = [];
		this.#streamRecorder = null;
		this.#streamEditor = null;
		this.#streamCommitted = false;
		this.#streamAbort = null;
		this.#streamUtterance = "";
		this.#releaseFocus();
	}

	// ── Live streaming ──────────────────────────────────────────────
	#currentVolatilePreview(): string {
		const partial = this.#lastPartial.replace(/\s+/g, " ").trim();
		if (!this.#streamUtterance) return partial;
		if (!partial) return this.#streamUtterance;
		return `${this.#streamUtterance} ${partial}`;
	}

	/** Segments accumulate before final insertion; prefix each later segment with a space. */
	#prefixed(text: string): string {
		const normalized = text.replace(/\s+/g, " ").trim();
		if (!normalized) return "";
		return this.#streamCommitted ? ` ${normalized}` : normalized;
	}

	async #startStreaming(
		resolveEditor: () => Editor | null,
		fallbackEditor: Editor,
		options: ToggleOptions,
		modelKey: SttModelKey,
	): Promise<void> {
		const language = this.#settings.get("stt.language");
		this.#attachFocus(resolveEditor, fallbackEditor, options);
		this.#streamCommitted = false;
		this.#streamUtterance = "";
		this.#streamAbort = new AbortController();
		const stream = sttClient.startStream(modelKey, {
			language: language || undefined,
			signal: this.#streamAbort.signal,
			onPartial: text => {
				if (this.#disposed || this.#state !== "recording") return;
				this.#lastPartial = text;
				if (this.#handleFocusChange()) return;
				const preview = this.#currentVolatilePreview();
				if (preview) this.#streamEditor?.setVolatileText(preview);
				if (!preview) this.#streamEditor?.clearVolatileText();
			},
			onSegment: text => {
				if (this.#disposed) return;
				this.#lastPartial = "";
				const prefixed = this.#prefixed(text);
				if (prefixed) {
					this.#streamCommitted = true;
					this.#streamUtterance += prefixed;
				}
				if (this.#handleFocusChange()) return;
				if (this.#state !== "recording") return;
				if (this.#streamUtterance) this.#streamEditor?.setVolatileText(this.#streamUtterance);
				else this.#streamEditor?.clearVolatileText();
			},
		});
		this.#stream = stream;
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
		logger.debug("STT live recording started", { modelKey });
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
		this.#finishTranscript(finalText, failed, options);
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
		this.#releaseFocus();
	}

	#finishTranscript(finalText: string, failed: boolean, options: ToggleOptions): void {
		const focusedEditor = this.#resolveEditor?.() || null;
		const targetEditor = focusedEditor || this.#fallbackEditor;
		let transcript = this.#streamUtterance;
		if (finalText) transcript = finalText;
		transcript = transcript.trim();
		this.#streamEditor?.clearVolatileText();
		if (transcript) targetEditor?.commitVolatileText(transcript);

		if (!failed && !transcript) options.showStatus("No speech detected.");
		if (!failed && transcript && !focusedEditor) options.showStatus("Dictation inserted into composer draft.");
		if (!failed && transcript && focusedEditor) options.showStatus("");

		if (!transcript || failed || !targetEditor) return;
		const trigger = this.#settings.get("stt.submitTrigger");
		const { submit, trimTrailing } = evaluateSubmitTrigger(transcript, trigger);
		if (trimTrailing > 0) targetEditor.deleteBeforeCursor(trimTrailing);
		if (submit && options.submitEditor) options.submitEditor(targetEditor);
		if (submit && !options.submitEditor) targetEditor.submit();
	}

	dispose(): void {
		this.#disposed = true;
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
		this.#cloudModel = null;
		this.#cloudAudio = [];
		this.#state = "idle";
		this.#resolvedModelKey = null;
	}
}
