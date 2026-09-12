import { type ApiKeyResolver, type OAuthAccessSource, seedApiKeyResolver } from "@oh-my-pi/pi-ai";
import { AudioCapture } from "@oh-my-pi/pi-natives";
import { logger, sanitizeText } from "@oh-my-pi/pi-utils";
import { kNoAuth } from "../config/model-provider-discovery";
import { settings } from "../config/settings";
import { type SttStreamHandle, sttClient } from "./asr-client";
import {
	DEFAULT_CLOUD_STT_MODEL,
	DEFAULT_STT_BACKEND,
	DEFAULT_STT_CLOUD_CREDENTIAL,
	isCloudSttModel,
	isSttBackend,
	isSttCloudCredentialRoute,
	type SttBackend,
	type SttCloudCredentialRoute,
} from "./cloud-models";
import {
	AUDIO_LIMIT_MESSAGE,
	type CloudSttCredential,
	type CloudSttStreamOptions,
	MAX_AUDIO_SAMPLES,
	startCloudSttStream,
} from "./cloud-transcribe-client";
import { downloadSttModel, isSttModelCached } from "./downloader";
import { resolveSttModelSpec } from "./models";
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

/** Minimal registry surface for cloud credential and route resolution. */
export interface SttCredentialRegistry {
	/**
	 * OAuth source for the ChatGPT-subscription route. Typed as the full
	 * {@link OAuthAccessSource} because the resolved credential hands it to
	 * `withOAuthAccess`, which force-refreshes and rotates on rejection.
	 */
	authStorage?: OAuthAccessSource;
	getApiKeyForProvider(
		provider: string,
		sessionId?: string,
		options?: { signal?: AbortSignal },
	): Promise<string | undefined>;
	/**
	 * Central a/b/c key resolver. The API-key route carries it (seeded with the
	 * preflight key) so a server-rejected command-backed or broker-refreshed
	 * credential is refreshed/rotated instead of retried identically.
	 */
	resolver?(provider: string, options?: { sessionId?: string }): ApiKeyResolver;
	getProviderBaseUrl?(provider: string): string | undefined;
	getProviderHeaders?(provider: string): Record<string, string> | undefined;
}

/**
 * Resolve cloud STT credentials without erasing their provenance. ChatGPT
 * OAuth is routed through the Codex transport; OpenAI API keys retain custom
 * provider endpoints and headers. `route` restricts which source is consulted:
 * `auto` tries the subscription first, so a connected ChatGPT login shadows a
 * configured API key unless the user selects `api-key` explicitly.
 */
export async function resolveSttCloudCredential(
	registry: SttCredentialRegistry,
	sessionId?: string,
	signal?: AbortSignal,
	route: SttCloudCredentialRoute = DEFAULT_STT_CLOUD_CREDENTIAL,
): Promise<CloudSttCredential | undefined> {
	const authStorage = registry.authStorage;
	if (authStorage && route !== "api-key") {
		try {
			const access = await authStorage.getOAuthAccess("openai-codex", sessionId, { signal });
			if (access?.accessToken) return { kind: "codex", access, source: authStorage, sessionId };
		} catch {
			signal?.throwIfAborted();
		}
	}
	if (route === "subscription") return undefined;
	try {
		const apiKey = await registry.getApiKeyForProvider("openai", sessionId, { signal });
		if (!apiKey) return undefined;
		const baseUrl = registry.getProviderBaseUrl?.("openai");
		const headers = registry.getProviderHeaders?.("openai");
		if (apiKey === kNoAuth) return { kind: "openai", keyless: true, baseUrl, headers };
		const resolver = registry.resolver?.("openai", { sessionId });
		return {
			kind: "openai",
			// Seeded so the first attempt reuses the key this preflight resolved;
			// later attempts re-enter the registry for refresh/rotation.
			apiKey: resolver ? seedApiKeyResolver(apiKey, resolver) : apiKey,
			baseUrl,
			headers,
		};
	} catch {
		signal?.throwIfAborted();
		return undefined;
	}
}

/** Resolves the credential for one recording; `route` is the `stt.cloudCredential` setting. */
export type CloudCredentialResolver = (
	signal: AbortSignal,
	route: SttCloudCredentialRoute,
) => Promise<CloudSttCredential | undefined>;

/** Test seam for cloud backend dependencies. */
export interface SttControllerDeps {
	resolveCloudCredential?: CloudCredentialResolver;
	createCloudFetch?: CloudSttStreamOptions["fetchImpl"];
}

const defaultCloudCredentialResolver: CloudCredentialResolver = async (signal, route) => {
	signal.throwIfAborted();
	if (route === "subscription") return undefined;
	const env = (typeof Bun !== "undefined" ? Bun.env : process.env) as Record<string, string | undefined>;
	const apiKey = env["OPENAI_API_KEY"] ?? process.env["OPENAI_API_KEY"];
	return apiKey ? { kind: "openai", apiKey } : undefined;
};

/**
 * Accept microphone frames immediately while an asynchronous backend preflight
 * resolves. Frames are replayed in order once the real stream is ready. The
 * held audio is bounded by the cloud upload limit: a stalled credential lookup
 * or model download must not grow this buffer without limit.
 */
function bufferUntilStreamReady(targetPromise: Promise<SttStreamHandle>, abortSetup: () => void): SttStreamHandle {
	const pending: Float32Array[] = [];
	let pendingSamples = 0;
	const { promise: stopPromise, resolve: resolveStop, reject: rejectStop } = Promise.withResolvers<string>();
	void stopPromise.catch(() => {});
	let target: SttStreamHandle | null = null;
	let cancelled = false;
	let stopRequested = false;
	let stopSettled = false;
	// Set once frames can no longer reach a stream (cancelled, setup failed, or
	// bound exceeded): later frames are dropped instead of copied.
	let closed = false;
	const settleStop = (apply: () => void): void => {
		if (stopSettled) return;
		stopSettled = true;
		apply();
	};
	const close = (): void => {
		closed = true;
		pending.length = 0;
		pendingSamples = 0;
	};
	const stopTarget = (stream: SttStreamHandle): void => {
		void stream.stop().then(
			text => settleStop(() => resolveStop(text)),
			error => settleStop(() => rejectStop(error)),
		);
	};
	void targetPromise.then(
		stream => {
			target = stream;
			if (closed) {
				stream.cancel();
			} else {
				for (const audio of pending) stream.pushAudio(audio);
				if (stopRequested) stopTarget(stream);
			}
			pending.length = 0;
			pendingSamples = 0;
		},
		error => {
			close();
			settleStop(() => rejectStop(error));
		},
	);
	return {
		pushAudio(audio): void {
			if (closed || stopRequested || audio.length === 0) return;
			if (target) {
				target.pushAudio(audio);
				return;
			}
			if (pendingSamples + audio.length > MAX_AUDIO_SAMPLES) {
				close();
				abortSetup();
				settleStop(() => rejectStop(new Error(AUDIO_LIMIT_MESSAGE)));
				return;
			}
			pending.push(audio.slice());
			pendingSamples += audio.length;
		},
		stop(): Promise<string> {
			if (!stopRequested) {
				stopRequested = true;
				if (target && !closed) stopTarget(target);
			}
			return stopPromise;
		},
		cancel(): void {
			if (cancelled) return;
			cancelled = true;
			close();
			target?.cancel();
			settleStop(() => resolveStop(""));
		},
	};
}

/** Coordinates microphone capture with local or cloud streaming transcription. */
export class STTController {
	#state: SttState = "idle";
	#resolvedModelKey: string | null = null;
	#toggling = false;
	#stopAfterStart = false;
	#disposed = false;
	readonly #createCapture: CaptureFactory;
	readonly #resolveCloudCredential: CloudCredentialResolver;
	readonly #createCloudFetch: CloudSttStreamOptions["fetchImpl"];
	#didWarnMissingCloudCredential = false;
	#didWarnIgnoredCloudOptions = false;
	// Live streaming capture.
	#stream: SttStreamHandle | null = null;
	#streamRecorder: CaptureHandle | null = null;
	#streamEditor: Editor | null = null;
	#streamCommitted = false;
	#streamAbort: AbortController | null = null;
	#streamUtterance = "";

	/** Creates a controller; tests may replace the hardware capture boundary. */
	constructor(
		createCapture: CaptureFactory = onAudio => new AudioCapture(16_000, onAudio),
		deps: SttControllerDeps = {},
	) {
		this.#createCapture = createCapture;
		this.#resolveCloudCredential = deps.resolveCloudCredential ?? defaultCloudCredentialResolver;
		this.#createCloudFetch = deps.createCloudFetch;
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

	#backend(): SttBackend {
		const raw = settings.get("stt.backend") as string | undefined;
		return raw !== undefined && isSttBackend(raw) ? raw : DEFAULT_STT_BACKEND;
	}

	#cloudCredentialRoute(): SttCloudCredentialRoute {
		const raw = settings.get("stt.cloudCredential") as string | undefined;
		return raw !== undefined && isSttCloudCredentialRoute(raw) ? raw : DEFAULT_STT_CLOUD_CREDENTIAL;
	}

	async #ensureCloudCredential(options: ToggleOptions, signal: AbortSignal): Promise<CloudSttCredential | null> {
		const route = this.#cloudCredentialRoute();
		try {
			const credential = await this.#resolveCloudCredential(signal, route);
			signal.throwIfAborted();
			if (credential) {
				this.#warnIgnoredCloudOptions(credential, options);
				return credential;
			}
		} catch (err) {
			signal.throwIfAborted();
			logger.error("STT cloud credential resolution failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		}
		if (!this.#didWarnMissingCloudCredential) {
			this.#didWarnMissingCloudCredential = true;
			const missing =
				route === "api-key"
					? "No OpenAI API key for cloud speech-to-text (stt.cloudCredential is api-key)"
					: route === "subscription"
						? "No ChatGPT subscription for cloud speech-to-text (stt.cloudCredential is subscription)"
						: "No OpenAI credentials for cloud speech-to-text (API key or ChatGPT subscription)";
			options.showWarning(`${missing} — falling back to the local model.`);
		}
		return null;
	}

	/**
	 * The ChatGPT-subscription route posts only the audio file: the Codex
	 * transcribe endpoint has no `model`/`language`/`prompt` fields, and an
	 * `openai-codex` bearer cannot be sent to the platform API that does. Say so
	 * once per session rather than letting a configured transcription model,
	 * language, or keyword list appear to apply when it does not. The advice
	 * names `stt.cloudCredential` because a connected subscription shadows a
	 * configured API key under the default `auto` route.
	 */
	#warnIgnoredCloudOptions(credential: CloudSttCredential, options: ToggleOptions): void {
		if (credential.kind !== "codex" || this.#didWarnIgnoredCloudOptions) return;
		const ignored: string[] = [];
		const model = settings.get("stt.modelName") as string | undefined;
		if (model !== undefined && isCloudSttModel(model) && model !== DEFAULT_CLOUD_STT_MODEL) ignored.push("model");
		if (settings.get("stt.language")) ignored.push("language");
		if (String(settings.get("stt.keywords") ?? "").trim()) ignored.push("keywords");
		if (ignored.length === 0) return;
		this.#didWarnIgnoredCloudOptions = true;
		options.showWarning(
			`Cloud dictation is using your ChatGPT subscription, whose transcription endpoint ignores ${ignored.join(", ")}. To use ${ignored.length > 1 ? "them" : "it"}, configure an OpenAI API key and set stt.cloudCredential to api-key.`,
		);
	}

	/**
	 * Local-backend preflight: reports a dependency failure here, since no
	 * stream exists yet to carry it.
	 */
	async #ensureLocalDeps(options: ToggleOptions): Promise<boolean> {
		try {
			await this.#prepareLocalModel(options);
			return true;
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Failed to setup STT dependencies";
			options.showWarning(msg);
			logger.error("STT dependency setup failed", { error: msg });
			return false;
		}
	}

	/**
	 * Make the local model available, downloading with progress on first use.
	 * Throws the concrete failure (or the abort reason) so each caller reports
	 * it exactly once: the local backend in {@link #ensureLocalDeps}, the cloud
	 * fallback through the stream's `stop()` rejection.
	 */
	async #prepareLocalModel(options: ToggleOptions, signal?: AbortSignal): Promise<void> {
		const modelKey = resolveSttModelSpec(settings.get("stt.modelName") as string | undefined).key;
		// Keyed on the model rather than a one-shot flag: switching stt.modelName
		// mid-session must re-run preflight so an uncached new tier downloads here
		// (with progress) instead of blocking silently at stop.
		if (this.#resolvedModelKey === modelKey) return;
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
			this.#warmModel(modelKey, signal);
		} else {
			await downloadSttModel(modelKey, p => status(`Downloading speech model ${p.label} (${p.percent}%)`), {
				signal,
			});
		}
		if (wroteStatus) options.showStatus("");
		this.#resolvedModelKey = modelKey;
	}

	/** Warm the speech model in the worker without blocking recording. The worker
	 *  memoizes the load, so the stream/transcribe path reuses it and the model is
	 *  hot by the time recording stops. Only called when the weights are already
	 *  cached, so no network fetch happens. `signal` is the recording's abort:
	 *  when the recording is cancelled the warmup must not keep the worker
	 *  referenced (and process exit delayed) for a load nothing will consume. On
	 *  load failure (corrupt cache, OOM, runtime install) or abort, invalidate the
	 *  resolved key so the next toggle re-runs preflight and retries instead of
	 *  skipping it forever. */
	#warmModel(modelKey: string, signal?: AbortSignal): void {
		void downloadSttModel(modelKey, undefined, { signal }).catch(err => {
			// Guard against a concurrent model switch clobbering a newer resolution.
			if (!this.#disposed && this.#resolvedModelKey === modelKey) this.#resolvedModelKey = null;
			logger.debug("stt: background model warmup failed", {
				error: err instanceof Error ? err.message : String(err),
			});
		});
	}

	async #start(editor: Editor, options: ToggleOptions): Promise<void> {
		if (this.#backend() === "cloud") {
			await this.#startStreaming(editor, options, true);
			return;
		}
		if (!(await this.#ensureLocalDeps(options))) return;
		await this.#startStreaming(editor, options);
	}

	async #stop(options: ToggleOptions): Promise<void> {
		await this.#stopStreaming(options);
	}

	// ── Live streaming ──────────────────────────────────────────────

	/** Segment text gets a leading space once a prior segment is committed, so
	 *  phrases join naturally; the first phrase is inserted at the cursor as-is. */
	#prefixed(text: string): string {
		// Strip ANSI and control bytes before anything else: a compat endpoint or
		// proxy can return them inside transcript text, and every string that
		// reaches the composer and the TUI renderer passes through here —
		// partials, committed segments, and the final cloud transcript.
		const normalized = sanitizeText(text).replace(/\s+/g, " ").trim();
		if (!normalized) return "";
		return this.#streamCommitted ? ` ${normalized}` : normalized;
	}

	async #startStreaming(editor: Editor, options: ToggleOptions, cloud = false): Promise<void> {
		const modelKey = resolveSttModelSpec(settings.get("stt.modelName") as string | undefined).key;
		const language = settings.get("stt.language") as string | undefined;
		const keywords = String(settings.get("stt.keywords") ?? "")
			.split(",")
			.map(s => s.trim())
			.filter(Boolean);
		this.#streamEditor = editor;
		this.#streamCommitted = false;
		this.#streamUtterance = "";
		const streamAbort = new AbortController();
		this.#streamAbort = streamAbort;
		const onPartial = (text: string): void => {
			if (this.#disposed || this.#state !== "recording") return;
			this.#streamEditor?.setVolatileText(this.#prefixed(text));
			options.requestRender?.();
		};
		const onSegment = (text: string): void => {
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
		};
		const stream = cloud
			? bufferUntilStreamReady(
					this.#ensureCloudCredential(options, streamAbort.signal).then(async credential => {
						if (credential) {
							return startCloudSttStream({
								credential,
								model: settings.get("stt.modelName") as string | undefined,
								language: language || undefined,
								keywords: keywords.length ? keywords : undefined,
								signal: streamAbort.signal,
								fetchImpl: this.#createCloudFetch,
								onPartial,
								onSegment,
							});
						}
						// A failure here rejects the buffered stream's stop(), which
						// #stopStreaming reports once with the concrete message.
						await this.#prepareLocalModel(options, streamAbort.signal);
						return sttClient.startStream(modelKey, {
							language: language || undefined,
							signal: streamAbort.signal,
							onPartial,
							onSegment,
						});
					}),
					() => streamAbort.abort(new Error(AUDIO_LIMIT_MESSAGE)),
				)
			: sttClient.startStream(modelKey, {
					language: language || undefined,
					signal: streamAbort.signal,
					onPartial,
					onSegment,
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
					options.requestRender?.();
					this.#cleanupStream();
					this.#setState("idle", options);
					options.showWarning(error.message);
					return;
				}
				stream.pushAudio(samples);
			});
		} catch (err) {
			streamAbort.abort(err);
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
		this.#resolvedModelKey = null;
	}
}
