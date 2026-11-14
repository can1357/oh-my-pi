/**
 * Client for the per-model tiny-model workers.
 *
 * Each local model is served by one worker process on the machine — the ONNX
 * worker (`worker.ts`) or, with `PI_TINY_DEVICE=mlx`, the MLX worker
 * (`mlx-server.py`) — that owns a socket named after the model. This client
 * connects to it, spawning it detached when it is not running, and lets it
 * die on its own once idle. Prompt construction and title extraction live
 * here so both workers only ever see message-level `chat` requests.
 */
import { $env, getTinyWorkerRuntimeDir, logger, prompt } from "@oh-my-pi/pi-utils";
import packageJson from "../../package.json" with { type: "json" };
import type { Setting } from "../config/registry";
import { isSettingsInitialized, settings } from "../config/settings";

import { stageRunnerScript } from "../eval/runner-cache";
import { ModelDownloadActivity } from "../downloads/model-downloads";
import titleSystemPrompt from "../prompts/system/title-system.md" with { type: "text" };
import {
	connectSharedWorker,
	LazyWorkerHandle,
	type SharedWorkerLaunch,
	smokeTestSharedWorker,
	spawnDetached,
	WORKER_CONNECTION_CLOSED,
} from "../subprocess/shared-worker";
import {
	inferenceWorkerEnv,
	type RefCountedWorkerHandle,
	resolveWorkerSpawnCmd,
	SMOKE_TEST_TIMEOUT_MS,
} from "../subprocess/worker-client";
import { MLX_DEVICE, resolveTinyModelDevicePreference, tinyMlxSupported, tinyModelDeviceSettingToEnv } from "./device";
import { tinyModelDtypeSettingToEnv } from "./dtype";
import { formatTitleUserMessage } from "./message-preproc";
import { ensureTinyMlxRuntime, getTinyMlxModelDir, MLX_LM_VERSION } from "./mlx-runtime";
import MLX_SERVER_SCRIPT from "./mlx-server.py" with { type: "text" };
import { getTinyLocalModelSpec, isTinyLocalModelKey, type TinyLocalModelKey } from "./models";
import { normalizeGeneratedTitle } from "./text";
import {
	TINY_WORKER_ARG,
	TINY_WORKER_IDLE_MS_ENV,
	TINY_WORKER_MODEL_ENV,
	TINY_WORKER_SOCKET_ENV,
	TINY_WORKER_TAG_ENV,
	type TinyChatMessage,
	type TinyTitleProgressEvent,
	type TinyWorkerBackend,
	type TinyWorkerRequest,
	type TinyWorkerResponse,
	tinyWorkerName,
} from "./title-protocol";
import { cfgProvidersTinyModelDevice, cfgProvidersTinyModelDtype } from "../session/settings";

const TITLE_PREFILL = "<title>";
const TITLE_CLOSE = "</title>";
const TITLE_MAX_NEW_TOKENS = 20;
const COMPLETION_DEFAULT_MAX_NEW_TOKENS = 256;
const COMPLETION_MAX_NEW_TOKENS = 1024;
const TINY_TITLE_SYSTEM_PROMPT = prompt.render(titleSystemPrompt);
const MLX_IDLE_SECONDS = 15 * 60;

type WorkerHandle = RefCountedWorkerHandle<TinyWorkerRequest, TinyWorkerResponse>;

type PendingRequest =
	| { kind: "title"; modelKey: TinyLocalModelKey; source: string; resolve: (title: string | null) => void }
	| { kind: "chat"; modelKey: TinyLocalModelKey; resolve: (text: string | null) => void }
	| { kind: "load"; modelKey: TinyLocalModelKey; resolve: (result: TinyTitleDownloadResult) => void };

export interface TinyTitleDownloadResult {
	ok: boolean;
	error?: string;
}

export interface TinyTitleDownloadOptions {
	signal?: AbortSignal;
	onProgress?: (event: TinyTitleProgressEvent) => void;
}

/**
 * Per-request controls for {@link TinyTitleClient.generate}.
 *
 * Carries the optional abort signal and title-system-prompt override used by
 * callers that customize automatic session-title generation.
 */
export interface TinyTitleGenerateOptions {
	signal?: AbortSignal;
	systemPrompt?: string;
}

export interface TinyModelChatOptions {
	maxTokens?: number;
	signal?: AbortSignal;
}

export interface TinyModelCompletionOptions extends TinyModelChatOptions {
	systemPrompt?: string;
}

function normalizeTinyTitleGenerateOptions(
	options: AbortSignal | TinyTitleGenerateOptions | undefined,
): TinyTitleGenerateOptions {
	if (!options) return {};
	if ("aborted" in options && "addEventListener" in options) return { signal: options };
	return options;
}

// ── Device / dtype resolution ────────────────────────────────────────

/** Setting value (its env var included); only the env var when settings are uninitialized (e.g. `omp --smoke-test`). */
function readTinyModelSetting(setting: Setting<string>): string | undefined {
	return isSettingsInitialized() ? setting.get(settings) : setting.envValue();
}

/**
 * Map the resolved `providers.tinyModelDevice` / `providers.tinyModelDtype`
 * values onto the `PI_TINY_DEVICE` / `PI_TINY_DTYPE` vars a worker should run
 * with. Only resolved keys are returned — never the default sentinel — so the
 * worker's built-in defaults apply for anything absent. Pure for testability;
 * see {@link tinyModelEnv} for the settings glue.
 * @internal
 */
export function tinyWorkerEnvOverlay(
	deviceSetting: string | undefined,
	dtypeSetting: string | undefined,
): Record<string, string> {
	const overlay: Record<string, string> = {};
	const device = tinyModelDeviceSettingToEnv(deviceSetting);
	if (device) overlay.PI_TINY_DEVICE = device;
	const dtype = tinyModelDtypeSettingToEnv(dtypeSetting);
	if (dtype) overlay.PI_TINY_DTYPE = dtype;
	return overlay;
}

/** Resolved device/dtype vars for this process. */
function tinyModelEnv(): Record<string, string> {
	return tinyWorkerEnvOverlay(
		readTinyModelSetting(cfgProvidersTinyModelDevice),
		readTinyModelSetting(cfgProvidersTinyModelDtype),
	);
}

/** Identity of the resolved device/dtype; a worker started under a different key is stale. */
export function tinyModelEnvKey(): string {
	const env = tinyModelEnv();
	return `${env.PI_TINY_DEVICE ?? ""}|${env.PI_TINY_DTYPE ?? ""}`;
}

/**
 * Env for an ONNX inference subprocess with the resolved device/dtype —
 * used for the tiny worker and reused verbatim by the STT and TTS workers,
 * which share the same device/dtype resolution.
 */
export function tinyWorkerEnv(): Record<string, string> {
	return inferenceWorkerEnv(tinyModelEnv());
}

/** Set once the mlx-lm bootstrap fails in this process; later workers fall back to ONNX. */
let mlxUnavailable = false;

/** Whether a worker started now would run the MLX backend (device resolves to `mlx` on Apple silicon). */
export function tinyWorkerUsesMlx(): boolean {
	return (
		!mlxUnavailable &&
		tinyMlxSupported() &&
		resolveTinyModelDevicePreference(tinyModelEnv().PI_TINY_DEVICE).device === MLX_DEVICE
	);
}

// ── Worker launch ────────────────────────────────────────────────────

/** How to start one tiny worker: a shared-worker launch plus the backend that names its endpoint. */
export interface TinyWorkerLaunch extends SharedWorkerLaunch {
	backend: TinyWorkerBackend;
}

/** How to start the ONNX worker for `modelKey` with the resolved device/dtype env. @internal */
export function onnxLaunch(modelKey: TinyLocalModelKey, modelEnv: Record<string, string>): TinyWorkerLaunch {
	const tag = `${packageJson.version}|onnx|${modelEnv.PI_TINY_DEVICE ?? ""}|${modelEnv.PI_TINY_DTYPE ?? ""}`;
	return {
		label: `tiny onnx worker for ${modelKey}`,
		backend: "onnx",
		tag,
		spawn(endpoint, logPath) {
			const command = resolveWorkerSpawnCmd(TINY_WORKER_ARG);
			const env = inferenceWorkerEnv({
				...modelEnv,
				[TINY_WORKER_SOCKET_ENV]: endpoint,
				[TINY_WORKER_MODEL_ENV]: modelKey,
				[TINY_WORKER_TAG_ENV]: tag,
			});
			return Promise.resolve(spawnDetached(command.cmd, command.cwd, env, logPath));
		},
	};
}

function mlxLaunch(
	modelKey: TinyLocalModelKey,
	emitProgress: (event: TinyTitleProgressEvent) => void,
): TinyWorkerLaunch {
	const spec = getTinyLocalModelSpec(modelKey);
	if (!spec) throw new Error(`Unknown tiny local model: ${modelKey}`);
	const tag = `mlx|${MLX_LM_VERSION}|${Bun.hash.crc32(MLX_SERVER_SCRIPT).toString(16)}`;
	return {
		label: `tiny mlx worker for ${modelKey}`,
		backend: "mlx",
		tag,
		async spawn(endpoint, logPath) {
			const python = await ensureTinyMlxRuntime(phase =>
				emitProgress({ modelKey, status: phase, name: `mlx-lm@${MLX_LM_VERSION}` }),
			);
			const script = await stageRunnerScript("omp-tiny-mlx", "py", MLX_SERVER_SCRIPT);
			const env = inferenceWorkerEnv({
				PYTHONUNBUFFERED: "1",
				PYTHONIOENCODING: "utf-8",
				TRANSFORMERS_VERBOSITY: "error",
				HF_HUB_DISABLE_PROGRESS_BARS: "1",
				TOKENIZERS_PARALLELISM: "false",
			});
			const idleSeconds = Number($env[TINY_WORKER_IDLE_MS_ENV]) / 1000 || MLX_IDLE_SECONDS;
			const cmd = [
				python,
				"-u",
				script,
				"--socket",
				endpoint,
				"--tag",
				tag,
				"--model-key",
				modelKey,
				"--repo",
				spec.mlxRepo,
				"--dir",
				getTinyMlxModelDir(spec.mlxRepo),
				"--idle-seconds",
				String(idleSeconds),
			];
			return spawnDetached(cmd, undefined, env, logPath);
		},
	};
}

/** Connect to the machine-shared worker serving `modelKey` on `launch.backend`, spawning or replacing it as needed. */
export function connectTinyWorker(
	launch: TinyWorkerLaunch,
	modelKey: TinyLocalModelKey,
	runtimeDir = getTinyWorkerRuntimeDir(),
): Promise<WorkerHandle> {
	return connectSharedWorker(launch, runtimeDir, tinyWorkerName(modelKey, launch.backend));
}

// ── Prompt construction / output parsing ─────────────────────────────

function buildTitleMessages(message: string, systemPrompt?: string): TinyChatMessage[] {
	return [
		{ role: "system", content: systemPrompt?.trim() || TINY_TITLE_SYSTEM_PROMPT },
		{ role: "user", content: formatTitleUserMessage(message) },
	];
}

function buildCompletionMessages(promptText: string, systemPrompt?: string): TinyChatMessage[] {
	const userMessage: TinyChatMessage = { role: "user", content: promptText };
	const system = systemPrompt?.trim();
	return system ? [{ role: "system", content: system }, userMessage] : [userMessage];
}

function extractTinyTitle(text: string, sourceText: string): string | null {
	const titleStart = text.lastIndexOf(TITLE_PREFILL);
	const withoutPrefix = titleStart >= 0 ? text.slice(titleStart + TITLE_PREFILL.length) : text;
	// Self-closing tag: <title/> or <title /> (only when the prefill is present).
	if (titleStart >= 0 && /^\s*\/>/.test(withoutPrefix)) return null;
	const closeIndex = withoutPrefix.indexOf(TITLE_CLOSE);
	const withoutClose = closeIndex >= 0 ? withoutPrefix.slice(0, closeIndex) : withoutPrefix;
	const tagIndex = withoutClose.indexOf("<");
	const withoutTag = tagIndex >= 0 ? withoutClose.slice(0, tagIndex) : withoutClose;
	return normalizeGeneratedTitle(withoutTag, sourceText);
}

// ── Client ───────────────────────────────────────────────────────────

/** One connection per model this process has used; the worker behind it is shared machine-wide. */
interface ModelWorker {
	handle: WorkerHandle;
	unsubscribe: () => void;
	refed: boolean;
	/** {@link tinyModelEnvKey} when the connection was made. */
	envKey: string;
}

/**
 * Per-model worker connections. Device/dtype settings are read at use time: a
 * connection made under a different device/dtype is replaced on its next idle
 * use, and the launch-tag probe then swaps the machine-wide worker.
 */
export class TinyTitleClient {
	#workers = new Map<TinyLocalModelKey, ModelWorker>();
	#pending = new Map<string, PendingRequest>();
	/** Models whose load/generation failed, keyed to the device/dtype they failed under. */
	#failedModels = new Map<TinyLocalModelKey, string>();
	#progressListeners = new Set<(event: TinyTitleProgressEvent) => void>();
	#downloads = new ModelDownloadActivity(modelKey => getTinyLocalModelSpec(modelKey)?.label ?? modelKey);
	#nextRequestId = 0;
	#connect: (modelKey: TinyLocalModelKey) => Promise<WorkerHandle>;

	constructor(connect?: (modelKey: TinyLocalModelKey) => Promise<WorkerHandle>) {
		this.#connect = connect ?? (modelKey => this.#connectDefault(modelKey));
	}

	async #connectDefault(modelKey: TinyLocalModelKey): Promise<WorkerHandle> {
		if (tinyWorkerUsesMlx()) {
			try {
				return await connectTinyWorker(
					mlxLaunch(modelKey, event => this.#emitProgress(event)),
					modelKey,
				);
			} catch (error) {
				mlxUnavailable = true;
				const message = error instanceof Error ? error.message : String(error);
				logger.warn("tiny-title: MLX worker unavailable; falling back to ONNX CPU", { modelKey, error: message });
				// Ends a visible `mlx-lm` install row; the ONNX fallback tracks its own load.
				this.#downloads.observe({ modelKey, status: "error" }, `MLX unavailable: ${message}`);
			}
		}
		return connectTinyWorker(onnxLaunch(modelKey, tinyModelEnv()), modelKey);
	}

	onProgress(listener: (event: TinyTitleProgressEvent) => void): () => void {
		this.#progressListeners.add(listener);
		return () => this.#progressListeners.delete(listener);
	}

	/**
	 * Reach the model's worker ahead of first use without loading anything, so
	 * the first {@link generate} finds a live connection instead of paying the
	 * probe/spawn latency on the submit hot path (issue #6462). No-ops for
	 * online / non-local keys and for models already marked failed.
	 */
	prewarm(modelKey: string): void {
		if (!isTinyLocalModelKey(modelKey) || this.#hasFailed(modelKey)) return;
		try {
			this.#ensureWorker(modelKey).handle.send({ type: "ping", id: String(++this.#nextRequestId) });
		} catch (error) {
			logger.debug("tiny-title: prewarm failed", {
				modelKey,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async generate(modelKey: string, message: string, signal?: AbortSignal): Promise<string | null>;
	async generate(modelKey: string, message: string, options?: TinyTitleGenerateOptions): Promise<string | null>;
	async generate(
		modelKey: string,
		message: string,
		optionsOrSignal?: AbortSignal | TinyTitleGenerateOptions,
	): Promise<string | null> {
		const options = normalizeTinyTitleGenerateOptions(optionsOrSignal);
		if (!isTinyLocalModelKey(modelKey)) return null;
		if (options.signal?.aborted || this.#hasFailed(modelKey)) return null;
		const { promise, resolve } = Promise.withResolvers<string | null>();
		const request: TinyWorkerRequest = {
			type: "chat",
			id: String(++this.#nextRequestId),
			messages: buildTitleMessages(message, options.systemPrompt),
			prefill: TITLE_PREFILL,
			stop: TITLE_CLOSE,
			maxNewTokens: TITLE_MAX_NEW_TOKENS,
		};
		return this.#run(request, { kind: "title", modelKey, source: message, resolve }, promise, options.signal, () =>
			resolve(null),
		);
	}

	async chat(
		modelKey: string,
		messages: readonly TinyChatMessage[],
		options: TinyModelChatOptions = {},
	): Promise<string | null> {
		if (!isTinyLocalModelKey(modelKey)) return null;
		if (options.signal?.aborted || this.#hasFailed(modelKey)) return null;
		const requested = options.maxTokens ?? COMPLETION_DEFAULT_MAX_NEW_TOKENS;
		const { promise, resolve } = Promise.withResolvers<string | null>();
		const request: TinyWorkerRequest = {
			type: "chat",
			id: String(++this.#nextRequestId),
			messages,
			maxNewTokens: Math.min(Math.max(1, requested), COMPLETION_MAX_NEW_TOKENS),
		};
		return this.#run(request, { kind: "chat", modelKey, resolve }, promise, options.signal, () => resolve(null));
	}

	async complete(
		modelKey: string,
		promptText: string,
		options: TinyModelCompletionOptions = {},
	): Promise<string | null> {
		return this.chat(modelKey, buildCompletionMessages(promptText, options.systemPrompt), options);
	}

	async downloadModel(modelKey: string, options: TinyTitleDownloadOptions = {}): Promise<TinyTitleDownloadResult> {
		if (!isTinyLocalModelKey(modelKey)) return { ok: false };
		if (options.signal?.aborted) return { ok: false };
		const unsubscribe = options.onProgress ? this.onProgress(options.onProgress) : undefined;
		try {
			const { promise, resolve } = Promise.withResolvers<TinyTitleDownloadResult>();
			const request: TinyWorkerRequest = { type: "load", id: String(++this.#nextRequestId) };
			return await this.#run(request, { kind: "load", modelKey, resolve }, promise, options.signal, () =>
				resolve({ ok: false }),
			);
		} finally {
			unsubscribe?.();
		}
	}

	/**
	 * Register `pending`, send `request` to the model's worker, and hand back
	 * `promise` (settled by the correlated reply, a worker error, `onAbort`, or
	 * a send failure) with the bookkeeping detached once it settles.
	 */
	#run<T>(
		request: TinyWorkerRequest,
		pending: PendingRequest,
		promise: Promise<T>,
		signal: AbortSignal | undefined,
		onAbort: () => void,
	): Promise<T> {
		const abort = (): void => {
			if (!this.#pending.delete(request.id)) return;
			this.#syncWorkerRef(pending.modelKey);
			onAbort();
		};
		try {
			const worker = this.#ensureWorker(pending.modelKey);
			this.#pending.set(request.id, pending);
			this.#syncWorkerRef(pending.modelKey);
			signal?.addEventListener("abort", abort, { once: true });
			worker.handle.send(request);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.debug("tiny-title: local request failed", {
				modelKey: pending.modelKey,
				kind: pending.kind,
				error: message,
			});
			this.#pending.delete(request.id);
			this.#fail(pending, message);
		}
		return promise.finally(() => {
			signal?.removeEventListener("abort", abort);
			if (this.#pending.delete(request.id)) this.#syncWorkerRef(pending.modelKey);
		});
	}

	async terminate(): Promise<void> {
		const workers = [...this.#workers.values()];
		this.#workers.clear();
		for (const pending of this.#pending.values()) this.#fail(pending, undefined);
		this.#pending.clear();
		for (const worker of workers) {
			worker.unsubscribe();
			try {
				await worker.handle.terminate();
			} catch {
				// Already gone.
			}
		}
	}

	#ensureWorker(modelKey: TinyLocalModelKey): ModelWorker {
		const envKey = tinyModelEnvKey();
		const existing = this.#workers.get(modelKey);
		if (existing) {
			// Device/dtype changed since connecting: reconnect once idle so in-flight
			// requests finish on the old worker.
			if (existing.envKey === envKey || this.#hasPending(modelKey)) return existing;
			this.#workers.delete(modelKey);
			existing.unsubscribe();
			void existing.handle.terminate();
		}
		const handle = new LazyWorkerHandle<TinyWorkerRequest, TinyWorkerResponse>(() => this.#connect(modelKey));
		const unsubscribeMessage = handle.onMessage(message => this.#handleMessage(modelKey, message));
		const unsubscribeError = handle.onError(error => this.#handleWorkerError(modelKey, error));
		const worker: ModelWorker = {
			handle,
			refed: false,
			envKey,
			unsubscribe: () => {
				unsubscribeMessage();
				unsubscribeError();
			},
		};
		this.#workers.set(modelKey, worker);
		return worker;
	}

	/**
	 * Keep the socket referenced only while a request for that model is in
	 * flight, so idle TUI sessions can exit while short-lived CLI downloads
	 * are not starved by Bun draining the event loop first.
	 */
	#syncWorkerRef(modelKey: TinyLocalModelKey): void {
		const worker = this.#workers.get(modelKey);
		if (!worker) return;
		const inFlight = this.#hasPending(modelKey);
		if (inFlight === worker.refed) return;
		worker.refed = inFlight;
		if (inFlight) worker.handle.ref();
		else worker.handle.unref();
	}

	#handleMessage(modelKey: TinyLocalModelKey, message: TinyWorkerResponse): void {
		if (message.type === "pong") return;
		if (message.type === "progress") {
			this.#emitProgress(message.event);
			return;
		}
		// Any answer settles the model's load, even for an abandoned request;
		// MLX `chat` loads send no `ready` of their own.
		if (message.type === "error") this.#downloads.observe({ modelKey, status: "error" }, message.error);
		else this.#downloads.observe({ modelKey, status: "ready" });
		const pending = this.#pending.get(message.id);
		if (!pending) return;
		this.#pending.delete(message.id);
		this.#syncWorkerRef(modelKey);
		if (message.type === "error") {
			logger.debug("tiny-title: worker returned error", { modelKey, error: message.error });
			this.#markFailedModel(pending);
			this.#fail(pending, message.error);
			// One worker serves one model: a failed load/generation leaves nothing
			// worth staying connected to. Sibling requests for the model fault too.
			this.#dropWorker(modelKey, message.error);
			return;
		}
		if (message.type === "text") {
			if (pending.kind === "title") pending.resolve(extractTinyTitle(message.text, pending.source));
			else if (pending.kind === "chat") pending.resolve(message.text.trim() || null);
			return;
		}
		if (pending.kind === "load") pending.resolve({ ok: true });
	}

	#hasPending(modelKey: TinyLocalModelKey): boolean {
		for (const pending of this.#pending.values()) {
			if (pending.modelKey === modelKey) return true;
		}
		return false;
	}

	#hasFailed(modelKey: TinyLocalModelKey): boolean {
		return this.#failedModels.get(modelKey) === tinyModelEnvKey();
	}

	#fail(pending: PendingRequest, error: string | undefined): void {
		this.#emitProgress({ modelKey: pending.modelKey, status: "error" }, error);
		if (pending.kind === "load") pending.resolve(error === undefined ? { ok: false } : { ok: false, error });
		else pending.resolve(null);
	}

	#markFailedModel(pending: PendingRequest): void {
		if (pending.kind !== "load") this.#failedModels.set(pending.modelKey, tinyModelEnvKey());
	}

	#emitProgress(event: TinyTitleProgressEvent, error?: string): void {
		this.#downloads.observe(event, error);
		for (const listener of this.#progressListeners) listener(event);
	}

	/** Forget the model's connection and fail every request still in flight for it. Returns how many failed. */
	#dropWorker(modelKey: TinyLocalModelKey, error: string): number {
		const worker = this.#workers.get(modelKey);
		if (worker) {
			this.#workers.delete(modelKey);
			worker.unsubscribe();
			void worker.handle.terminate();
		}
		let failed = 0;
		for (const [id, pending] of this.#pending) {
			if (pending.modelKey !== modelKey) continue;
			this.#pending.delete(id);
			this.#fail(pending, error);
			failed += 1;
		}
		return failed;
	}

	/** The model's worker went away or could not be reached. */
	#handleWorkerError(modelKey: TinyLocalModelKey, error: Error): void {
		const failed = this.#dropWorker(modelKey, error.message);
		// A worker exiting on its own while idle is routine; losing requests is not. A load
		// abandoned by an aborted request is still on the HUD, so close that row only.
		if (failed === 0 && error.message.startsWith(WORKER_CONNECTION_CLOSED)) {
			this.#downloads.failOpen(modelKey, error.message);
			logger.debug("tiny-title: worker went away while idle", { modelKey });
			return;
		}
		// Failed requests already surfaced through `#fail`; this covers a connect failure with nothing in flight.
		if (failed === 0) this.#downloads.observe({ modelKey, status: "error" }, error.message);
		logger.warn("tiny-title: worker error", { modelKey, error: error.message, failedRequests: failed });
	}
}

export const tinyTitleClient = new TinyTitleClient();

/** Alias for the shared tiny-model worker client (titles + generic chat completions). */
export const tinyModelClient = tinyTitleClient;

/** Drop this process's worker connections; the workers themselves keep serving others until idle. */
export async function shutdownTinyTitleClient(): Promise<void> {
	await tinyTitleClient.terminate();
}

/** Exercise ONNX worker startup and the tagged ping handshake for distribution smoke tests. */
export async function smokeTestTinyTitleWorker({
	timeoutMs = SMOKE_TEST_TIMEOUT_MS,
}: {
	timeoutMs?: number;
} = {}): Promise<void> {
	const modelKey: TinyLocalModelKey = "lfm2.5-230m";
	await smokeTestSharedWorker(
		onnxLaunch(modelKey, {}),
		getTinyWorkerRuntimeDir(),
		tinyWorkerName(modelKey, "onnx"),
		timeoutMs,
	);
}
