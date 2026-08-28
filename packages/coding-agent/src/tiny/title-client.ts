import { $env, logger } from "@oh-my-pi/pi-utils";
import { settings } from "../config/settings";
import {
	createUnavailableWorker,
	createWorkerHandle,
	createWorkerSubprocess,
	inferenceWorkerEnv,
	logWorkerMessage,
	type RefCountedWorkerHandle,
	resolveWorkerSpawnCmd,
	SMOKE_TEST_TIMEOUT_MS,
	type SpawnedSubprocess,
	smokeTestWorker,
	spawnWorkerOrUnavailable,
} from "../subprocess/worker-client";
import { safeSend } from "../utils/ipc";
import { tinyModelDeviceSettingToEnv } from "./device";
import { tinyModelDtypeSettingToEnv } from "./dtype";
import {
	isTinyLocalModelKey,
	isTinyMemoryLocalModelKey,
	isTinyTitleLocalModelKey,
	type TinyLocalModelKey,
	type TinyMemoryLocalModelKey,
	type TinyTitleLocalModelKey,
} from "./models";
import type { TinyTitleProgressEvent, TinyTitleWorkerInbound, TinyTitleWorkerOutbound } from "./title-protocol";

type PendingRequest =
	| { kind: "generate"; modelKey: TinyTitleLocalModelKey; resolve: (title: string | null) => void }
	| { kind: "complete"; modelKey: TinyMemoryLocalModelKey; resolve: (text: string | null) => void }
	| { kind: "download"; modelKey: TinyLocalModelKey; resolve: (result: TinyTitleDownloadResult) => void };

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

export interface TinyModelCompletionOptions {
	maxTokens?: number;
	signal?: AbortSignal;
	systemPrompt?: string;
}

function normalizeTinyTitleGenerateOptions(
	options: AbortSignal | TinyTitleGenerateOptions | undefined,
): TinyTitleGenerateOptions {
	if (!options) return {};
	if ("aborted" in options && "addEventListener" in options) return { signal: options };
	return options;
}

/**
 * Hidden subcommand on the main CLI that boots the tiny-model worker in the
 * spawned subprocess. Kept in sync with the dispatch in `cli.ts`.
 */
export const TINY_WORKER_ARG = "__omp_worker_tiny_inference";

function readTinyModelSetting(path: "providers.tinyModelDevice" | "providers.tinyModelDtype"): string | undefined {
	try {
		const value = settings.get(path);
		return typeof value === "string" ? value : undefined;
	} catch {
		// Settings may be uninitialized (e.g. `omp --smoke-test`); fall back to env/default.
		return undefined;
	}
}

/**
 * Decide which `PI_TINY_DEVICE` / `PI_TINY_DTYPE` vars to overlay onto the worker
 * env. A present env var wins (left untouched); otherwise the mapped persisted
 * setting is used. Returns only the keys to add — never the default sentinel.
 * Pure for testability; see {@link tinyWorkerEnv} for the spawn-time glue.
 * @internal
 */
export function tinyWorkerEnvOverlay(
	env: Record<string, string | undefined>,
	deviceSetting: string | undefined,
	dtypeSetting: string | undefined,
): Record<string, string> {
	const overlay: Record<string, string> = {};
	if (!env.PI_TINY_DEVICE) {
		const device = tinyModelDeviceSettingToEnv(deviceSetting);
		if (device) overlay.PI_TINY_DEVICE = device;
	}
	if (!env.PI_TINY_DTYPE) {
		const dtype = tinyModelDtypeSettingToEnv(dtypeSetting);
		if (dtype) overlay.PI_TINY_DTYPE = dtype;
	}
	return overlay;
}

/**
 * Env handed to the tiny-model subprocess — and reused verbatim by the STT and
 * TTS workers, which share the same device/dtype resolution. The
 * `PI_TINY_DEVICE` / `PI_TINY_DTYPE` env vars win; otherwise the persisted
 * `providers.tinyModelDevice` / `providers.tinyModelDtype` settings are mapped
 * onto those vars so the subprocess's env-based resolution picks them up.
 * Resolved once at spawn (pipelines are cached for the lifetime of the
 * subprocess).
 */
export function tinyWorkerEnv(): Record<string, string> {
	return inferenceWorkerEnv(
		tinyWorkerEnvOverlay(
			$env,
			readTinyModelSetting("providers.tinyModelDevice"),
			readTinyModelSetting("providers.tinyModelDtype"),
		),
	);
}

/**
 * Spawn the tiny-model worker as a subprocess. Exported for tests and the
 * smoke probe; production callers go through {@link spawnTinyTitleWorker}.
 */
export function createTinyTitleSubprocess(): SpawnedSubprocess<TinyTitleWorkerOutbound> {
	return createWorkerSubprocess<TinyTitleWorkerOutbound>({
		spawnCommand: resolveWorkerSpawnCmd(TINY_WORKER_ARG),
		env: tinyWorkerEnv(),
		exitLabel: "tiny model subprocess",
	});
}

function wrapSubprocess(
	spawned: SpawnedSubprocess<TinyTitleWorkerOutbound>,
): RefCountedWorkerHandle<TinyTitleWorkerInbound, TinyTitleWorkerOutbound> {
	const { proc } = spawned;
	return {
		...createWorkerHandle<TinyTitleWorkerInbound, TinyTitleWorkerOutbound>(spawned, message =>
			safeSend(proc, message, "tiny-title"),
		),
		ref() {
			try {
				proc.ref();
			} catch {
				// Already gone.
			}
		},
		unref() {
			try {
				proc.unref();
			} catch {
				// Already gone.
			}
		},
	};
}

function spawnInlineUnavailableWorker(
	error: unknown,
): RefCountedWorkerHandle<TinyTitleWorkerInbound, TinyTitleWorkerOutbound> {
	return {
		...createUnavailableWorker<TinyTitleWorkerInbound, TinyTitleWorkerOutbound>(error),
		ref() {},
		unref() {},
	};
}

function spawnTinyTitleWorker(): RefCountedWorkerHandle<TinyTitleWorkerInbound, TinyTitleWorkerOutbound> {
	return spawnWorkerOrUnavailable(
		() => wrapSubprocess(createTinyTitleSubprocess()),
		spawnInlineUnavailableWorker,
		"Tiny title worker spawn failed; local titles disabled",
	);
}

export class TinyTitleClient {
	#worker: RefCountedWorkerHandle<TinyTitleWorkerInbound, TinyTitleWorkerOutbound> | null = null;
	#unsubscribeMessage: (() => void) | null = null;
	#unsubscribeError: (() => void) | null = null;
	#pending = new Map<string, PendingRequest>();
	#failedModels = new Set<TinyLocalModelKey>();
	#progressListeners = new Set<(event: TinyTitleProgressEvent) => void>();
	#nextRequestId = 0;
	#refed = false;
	#spawnWorker: () => RefCountedWorkerHandle<TinyTitleWorkerInbound, TinyTitleWorkerOutbound>;

	constructor(
		spawnWorker: () => RefCountedWorkerHandle<TinyTitleWorkerInbound, TinyTitleWorkerOutbound> = spawnTinyTitleWorker,
	) {
		this.#spawnWorker = spawnWorker;
	}

	onProgress(listener: (event: TinyTitleProgressEvent) => void): () => void {
		this.#progressListeners.add(listener);
		return () => this.#progressListeners.delete(listener);
	}

	/**
	 * Spawn the tiny-model worker ahead of first use without loading any model.
	 * Called from idle TUI startup so the first {@link generate} reuses a live,
	 * unref'd subprocess instead of paying subprocess-spawn latency on the submit
	 * hot path (issue #6462). No-ops for online / non-local keys and for models
	 * already marked failed. A no-op `ping` round-trips the transport to fault in
	 * the worker's module graph; no pending request is registered, so
	 * {@link #syncWorkerRef} leaves the worker unref'd and idle sessions still exit.
	 */
	prewarm(modelKey: string): void {
		if (!isTinyTitleLocalModelKey(modelKey) || this.#failedModels.has(modelKey)) return;
		try {
			const worker = this.#ensureWorker();
			worker.send({ type: "ping", id: String(++this.#nextRequestId) });
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
		if (!isTinyTitleLocalModelKey(modelKey)) return null;
		if (options.signal?.aborted || this.#failedModels.has(modelKey)) return null;

		try {
			const worker = this.#ensureWorker();
			const id = String(++this.#nextRequestId);
			const { promise, resolve } = Promise.withResolvers<string | null>();
			this.#addPending(id, { kind: "generate", modelKey, resolve });
			const abort = (): void => {
				const pending = this.#pending.get(id);
				if (pending?.kind !== "generate") return;
				this.#deletePending(id);
				pending.resolve(null);
			};
			options.signal?.addEventListener("abort", abort, { once: true });
			try {
				const request: TinyTitleWorkerInbound = options.systemPrompt
					? { type: "generate", id, modelKey, message, systemPrompt: options.systemPrompt }
					: { type: "generate", id, modelKey, message };
				worker.send(request);
				return await promise;
			} finally {
				options.signal?.removeEventListener("abort", abort);
				this.#deletePending(id);
			}
		} catch (error) {
			logger.debug("tiny-title: local generation failed", {
				modelKey,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	async complete(modelKey: string, prompt: string, options: TinyModelCompletionOptions = {}): Promise<string | null> {
		if (!isTinyMemoryLocalModelKey(modelKey)) return null;
		if (options.signal?.aborted || this.#failedModels.has(modelKey)) return null;

		try {
			const worker = this.#ensureWorker();
			const id = String(++this.#nextRequestId);
			const { promise, resolve } = Promise.withResolvers<string | null>();
			this.#addPending(id, { kind: "complete", modelKey, resolve });
			const abort = (): void => {
				const pending = this.#pending.get(id);
				if (pending?.kind !== "complete") return;
				this.#deletePending(id);
				pending.resolve(null);
			};
			options.signal?.addEventListener("abort", abort, { once: true });
			try {
				worker.send({
					type: "complete",
					id,
					modelKey,
					prompt,
					maxTokens: options.maxTokens,
					systemPrompt: options.systemPrompt,
				});
				return await promise;
			} finally {
				options.signal?.removeEventListener("abort", abort);
				this.#deletePending(id);
			}
		} catch (error) {
			logger.debug("tiny-model: local completion failed", {
				modelKey,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	async downloadModel(modelKey: string, options: TinyTitleDownloadOptions = {}): Promise<TinyTitleDownloadResult> {
		if (!isTinyLocalModelKey(modelKey)) return { ok: false };
		if (options.signal?.aborted) return { ok: false };

		const unsubscribe = options.onProgress ? this.onProgress(options.onProgress) : undefined;
		try {
			const worker = this.#ensureWorker();
			const id = String(++this.#nextRequestId);
			const { promise, resolve } = Promise.withResolvers<TinyTitleDownloadResult>();
			this.#addPending(id, { kind: "download", modelKey, resolve });
			const abort = (): void => {
				const pending = this.#pending.get(id);
				if (pending?.kind !== "download") return;
				this.#deletePending(id);
				pending.resolve({ ok: false });
			};
			options.signal?.addEventListener("abort", abort, { once: true });
			try {
				worker.send({ type: "download", id, modelKey });
				return await promise;
			} finally {
				options.signal?.removeEventListener("abort", abort);
				this.#deletePending(id);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.debug("tiny-title: local model download failed", {
				modelKey,
				error: message,
			});
			return { ok: false, error: message };
		} finally {
			unsubscribe?.();
		}
	}

	async terminate(): Promise<void> {
		const worker = this.#worker;
		this.#worker = null;
		this.#unsubscribeMessage?.();
		this.#unsubscribeMessage = null;
		this.#unsubscribeError?.();
		this.#unsubscribeError = null;
		for (const pending of this.#pending.values()) {
			this.#emitProgress({ modelKey: pending.modelKey, status: "error" });
			if (pending.kind === "generate" || pending.kind === "complete") pending.resolve(null);
			else pending.resolve({ ok: false });
		}
		this.#pending.clear();
		this.#refed = false;
		try {
			await worker?.terminate();
		} catch {
			// Already gone.
		}
	}

	#ensureWorker(): RefCountedWorkerHandle<TinyTitleWorkerInbound, TinyTitleWorkerOutbound> {
		if (this.#worker) return this.#worker;
		const worker = this.#spawnWorker();
		this.#worker = worker;
		this.#unsubscribeMessage = worker.onMessage(message => this.#handleMessage(message));
		this.#unsubscribeError = worker.onError(error => this.#handleWorkerError(error));
		return worker;
	}

	/** Register a pending request and keep the worker referenced while work is in flight. */
	#addPending(id: string, request: PendingRequest): void {
		this.#pending.set(id, request);
		this.#syncWorkerRef();
	}

	/** Drop a pending request and unref the worker once nothing is in flight. */
	#deletePending(id: string): void {
		if (this.#pending.delete(id)) this.#syncWorkerRef();
	}

	/**
	 * Tiny-model workers are spawned `unref`'d so idle TUI sessions can exit.
	 * Short-lived CLI downloads need the opposite while awaiting worker IPC, or
	 * Bun can drain the event loop before the subprocess answers.
	 */
	#syncWorkerRef(): void {
		const worker = this.#worker;
		if (!worker) return;
		const shouldRef = this.#pending.size > 0;
		if (shouldRef === this.#refed) return;
		this.#refed = shouldRef;
		if (shouldRef) worker.ref();
		else worker.unref();
	}

	#handleMessage(message: TinyTitleWorkerOutbound): void {
		if (message.type === "log") {
			logWorkerMessage(message);
			return;
		}
		if (message.type === "progress") {
			this.#emitProgress(message.event);
			return;
		}
		if (message.type === "pong") return;

		const pending = this.#pending.get(message.id);
		if (!pending) return;
		this.#deletePending(message.id);
		if (message.type === "title") {
			if (pending.kind === "generate") pending.resolve(message.title);
			return;
		}
		if (message.type === "downloaded") {
			if (pending.kind === "download") pending.resolve({ ok: true });
			return;
		}
		if (message.type === "completion") {
			if (pending.kind === "complete") pending.resolve(message.text);
			return;
		}
		logger.debug("tiny-title: worker returned error", { error: message.error });
		this.#markFailedModel(pending);
		this.#emitProgress({ modelKey: pending.modelKey, status: "error" });
		if (pending.kind === "download") pending.resolve({ ok: false, error: message.error });
		else pending.resolve(null);
		void this.terminate();
	}

	#markFailedModel(pending: PendingRequest): void {
		if (pending.kind === "generate" || pending.kind === "complete") this.#failedModels.add(pending.modelKey);
	}

	#emitProgress(event: TinyTitleProgressEvent): void {
		for (const listener of this.#progressListeners) listener(event);
	}

	#handleWorkerError(error: Error): void {
		logger.warn("tiny-title: worker error", { error: error.message });
		for (const pending of this.#pending.values()) {
			this.#emitProgress({ modelKey: pending.modelKey, status: "error" });
			if (pending.kind === "generate" || pending.kind === "complete") pending.resolve(null);
			else pending.resolve({ ok: false, error: error.message });
		}
		this.#pending.clear();
		void this.terminate();
	}
}

export const tinyTitleClient = new TinyTitleClient();

/** Alias for the shared tiny-model worker client (titles + memory completions). */
export const tinyModelClient = tinyTitleClient;

export async function shutdownTinyTitleClient(): Promise<void> {
	await tinyTitleClient.terminate();
}

export async function smokeTestTinyTitleWorker({
	timeoutMs = SMOKE_TEST_TIMEOUT_MS,
}: {
	timeoutMs?: number;
} = {}): Promise<void> {
	await smokeTestWorker(wrapSubprocess(createTinyTitleSubprocess()), "tiny title worker", timeoutMs);
}
