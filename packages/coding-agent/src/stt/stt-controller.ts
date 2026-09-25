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

import { cfgSttLanguage, cfgSttSubmitTrigger } from "./settings";

export type SttState = "idle" | "recording" | "transcribing";

/** How a capture reports progress and state to its host. */
export interface SttCallbacks {
	showWarning(msg: string): void;
	showStatus(msg: string): void;
	onStateChange(state: SttState): void;
}

/** The slice of a text input the controller dictates into. */
export interface SttTarget {
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

	// Live streaming capture.
	#stream: SttStreamHandle | null = null;
	#streamRecorder: CaptureHandle | null = null;
	#streamEditor: SttTarget | null = null;
	/** Callbacks of the running capture, from the {@link start} that began it. */
	#streamCallbacks: SttCallbacks | null = null;
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

	#setState(state: SttState, options: SttCallbacks): void {
		this.#state = state;
		options.onStateChange(state);
	}

	/** Start dictating into `editor`, reporting to `options` until the capture ends. A no-op while a
	 *  capture is starting, recording, or transcribing. */
	async start(editor: SttTarget, options: SttCallbacks): Promise<void> {
		if (this.#state === "transcribing") options.showStatus("Transcription in progress...");
		if (this.#toggling || this.#state !== "idle") return;
		await this.#transition(options, () => this.#start(editor, options));
	}

	/** Stop the running capture and transcribe it. A capture still starting stops as soon as it is
	 *  up; otherwise a no-op unless recording. */
	async stop(): Promise<void> {
		if (this.#toggling) {
			if (this.#state === "idle" || this.#state === "recording") this.#stopAfterStart = true;
			return;
		}
		const callbacks = this.#streamCallbacks;
		if (this.#state === "recording" && callbacks) await this.#transition(callbacks, () => this.#stop(callbacks));
	}

	/** Stop a capture that is starting or recording; otherwise start one into `editor`. */
	async toggle(editor: SttTarget, options: SttCallbacks): Promise<void> {
		if (this.#state === "recording" || (this.#toggling && this.#state === "idle")) await this.stop();
		else await this.start(editor, options);
	}

	/** Run one start/stop step, then honor a stop requested while it was in flight. */
	async #transition(options: SttCallbacks, step: () => Promise<void>): Promise<void> {
		this.#toggling = true;
		try {
			await step();
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

	async #ensureDeps(options: SttCallbacks, modelKey = this.#resolveModelKey()): Promise<SttModelKey | null> {
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

	async #start(editor: SttTarget, options: SttCallbacks): Promise<void> {
		let model = this.#resolveModel();
		if (model?.api === "openai-transcriptions") {
			this.#startBuffered(editor, options, model);
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
			this.#startBuffered(editor, options, model);
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
		await this.#startStreaming(editor, options, modelKey);
	}

	async #stop(options: SttCallbacks): Promise<void> {
		if (this.#cloudModel) await this.#stopBuffered(options);
		else await this.#stopStreaming(options);
	}

	// ── Buffered cloud transcription ────────────────────────────────

	#startBuffered(editor: SttTarget, options: SttCallbacks, model: Model<Api>): void {
		this.#streamEditor = editor;
		this.#streamCallbacks = options;
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

	async #stopBuffered(options: SttCallbacks): Promise<void> {
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
			const language = cfgSttLanguage.get(this.#settings);
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
		this.#streamCallbacks = null;
		this.#streamCommitted = false;
		this.#streamAbort = null;
		this.#streamUtterance = "";
	}

	// ── Live streaming ──────────────────────────────────────────────

	/** Segment text gets a leading space once a prior segment is committed, so
	 *  phrases join naturally; the first phrase is inserted at the cursor as-is. */
	#prefixed(text: string): string {
		const normalized = text.replace(/\s+/g, " ").trim();
		if (!normalized) return "";
		return this.#streamCommitted ? ` ${normalized}` : normalized;
	}

	async #startStreaming(editor: SttTarget, options: SttCallbacks, modelKey: SttModelKey): Promise<void> {
		const language = cfgSttLanguage.get(this.#settings);
		this.#streamEditor = editor;
		this.#streamCallbacks = options;
		this.#streamCommitted = false;
		this.#streamUtterance = "";
		this.#streamAbort = new AbortController();
		const stream = sttClient.startStream(modelKey, {
			language: language || undefined,
			signal: this.#streamAbort.signal,
			onPartial: text => {
				if (this.#disposed || this.#state !== "recording") return;
				this.#streamEditor?.setVolatileText(this.#prefixed(text));
			},
			onSegment: text => {
				if (this.#disposed) return;
				const prefixed = this.#prefixed(text);
				if (prefixed) {
					this.#streamEditor?.commitVolatileText(prefixed);
					this.#streamCommitted = true;
					this.#streamUtterance += prefixed;
				} else {
					this.#streamEditor?.clearVolatileText();
				}
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

	async #stopStreaming(options: SttCallbacks): Promise<void> {
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
		this.#streamCallbacks = null;
		this.#streamCommitted = false;
		this.#streamAbort = null;
		this.#streamUtterance = "";
	}

	#finishTranscript(finalText: string, failed: boolean, options: SttCallbacks): void {
		if (!this.#streamCommitted && finalText) {
			const prefixed = this.#prefixed(finalText);
			this.#streamEditor?.commitVolatileText(prefixed);
			this.#streamCommitted = true;
			this.#streamUtterance = prefixed;
		} else {
			this.#streamEditor?.clearVolatileText();
		}
		if (!failed) options.showStatus(this.#streamCommitted ? "" : "No speech detected.");

		if (this.#streamCommitted && !failed && this.#streamEditor) {
			const trigger = cfgSttSubmitTrigger.get(this.#settings);
			const { submit, trimTrailing } = evaluateSubmitTrigger(this.#streamUtterance, trigger);
			if (trimTrailing > 0) {
				this.#streamEditor.deleteBeforeCursor(trimTrailing);
			}
			if (submit) {
				this.#streamEditor.submit();
			}
		}
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
