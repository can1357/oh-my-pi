import { logger } from "@oh-my-pi/pi-utils";
import { ModelDownloadActivity, type ModelLoadProgressEvent } from "../downloads/model-downloads";
import { tinyModelEnvKey } from "../tiny/title-client";
import { safeSend } from "../utils/ipc";
import {
	createUnavailableWorker,
	createWorkerHandle,
	logWorkerMessage,
	type RefCountedWorkerHandle,
	type SpawnedSubprocess,
	spawnWorkerOrUnavailable,
	type WorkerLogMessage,
} from "./worker-client";

/**
 * Shared parent-side plumbing for the warm, ref-counted model workers (speech-
 * to-text and text-to-speech): subprocess wrapping, lazy (re)spawn keyed on the
 * tiny-model env, pending-request bookkeeping that keeps the worker referenced
 * only while work is in flight, progress fan-out, model downloads, and teardown.
 * Each client keeps its own request kinds, streaming, and message semantics.
 */

/** Outcome of a {@link ModelWorkerHost.downloadModel} request. */
export interface ModelDownloadResult {
	ok: boolean;
	error?: string;
}

export interface ModelDownloadOptions<Progress> {
	signal?: AbortSignal;
	onProgress?: (event: Progress) => void;
}

/** Pending model download, owned and settled by the host. */
export interface ModelDownloadRequest<Key extends string> {
	kind: "download";
	modelKey: Key;
	resolve: (result: ModelDownloadResult) => void;
}

/** Worker messages left for the client once the host consumed log/progress/pong/downloaded. */
export type ModelWorkerMessage<Outbound> = Exclude<Outbound, { type: "log" | "progress" | "pong" | "downloaded" }>;

export interface ModelWorkerHostOptions<Inbound, Outbound, Request> {
	/** Log/error prefix, e.g. `"stt"`. */
	name: string;
	spawnWorker: () => RefCountedWorkerHandle<Inbound, Outbound>;
	/** Display label for a model key in the download registry. */
	modelLabel: (modelKey: string) => string;
	handleMessage: (message: ModelWorkerMessage<Outbound>) => void;
	/** Settle a client request when the worker is torn down (`terminated`) or faults. */
	failRequest: (request: Request, error: Error, terminated: boolean) => void;
	/** Whether work tracked outside the pending map (live streams) is active. */
	hasStreams?: () => boolean;
	/** Fail work tracked outside the pending map when the worker goes away. */
	failStreams?: (error: Error) => void;
}

/** Wrap a spawned subprocess as a ref-counted handle sending over `safeSend`. */
export function wrapRefCountedSubprocess<Inbound, Outbound>(
	spawned: SpawnedSubprocess<Outbound>,
	label: string,
): RefCountedWorkerHandle<Inbound, Outbound> {
	const { proc } = spawned;
	return {
		...createWorkerHandle<Inbound, Outbound>(spawned, message => safeSend(proc, message, label)),
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

/** Spawn a ref-counted worker, degrading to an inline unavailable stub when the subprocess cannot start. */
export function spawnRefCountedWorker<Inbound extends { type: string; id: string }, Outbound extends { type: string }>(
	createSubprocess: () => SpawnedSubprocess<Outbound>,
	label: string,
	warnMessage: string,
): RefCountedWorkerHandle<Inbound, Outbound> {
	return spawnWorkerOrUnavailable(
		() => wrapRefCountedSubprocess<Inbound, Outbound>(createSubprocess(), label),
		error => ({ ...createUnavailableWorker<Inbound, Outbound>(error), ref() {}, unref() {} }),
		warnMessage,
	);
}

function isDownloadRequest<Key extends string, Request extends { kind: string }>(
	request: Request | ModelDownloadRequest<Key>,
): request is ModelDownloadRequest<Key> {
	return request.kind === "download";
}

export class ModelWorkerHost<
	Key extends string,
	Inbound extends { type: string; id: string },
	Outbound extends { type: string; id?: string; event?: Progress },
	Request extends { kind: string; modelKey: Key },
	Progress extends ModelLoadProgressEvent & { modelKey: Key },
> {
	/** In-flight correlated requests by id; any entry keeps the worker referenced. */
	readonly pending = new Map<string, Request | ModelDownloadRequest<Key>>();
	#worker: RefCountedWorkerHandle<Inbound, Outbound> | null = null;
	#unsubscribe: Array<() => void> = [];
	#progressListeners = new Set<(event: Progress) => void>();
	#downloads: ModelDownloadActivity;
	#nextRequestId = 0;
	#refed = false;
	/** {@link tinyModelEnvKey} the current worker was spawned under. */
	#workerEnvKey: string | undefined;
	#options: ModelWorkerHostOptions<Inbound, Outbound, Request>;

	constructor(options: ModelWorkerHostOptions<Inbound, Outbound, Request>) {
		this.#options = options;
		this.#downloads = new ModelDownloadActivity(options.modelLabel);
	}

	nextId(): string {
		return String(++this.#nextRequestId);
	}

	onProgress(listener: (event: Progress) => void): () => void {
		this.#progressListeners.add(listener);
		return () => this.#progressListeners.delete(listener);
	}

	emitProgress(event: Progress, error?: string): void {
		this.#downloads.observe(event, error);
		for (const listener of this.#progressListeners) listener(event);
	}

	ensureWorker(): RefCountedWorkerHandle<Inbound, Outbound> {
		const envKey = tinyModelEnvKey();
		if (this.#worker) {
			if (this.#workerEnvKey === envKey || this.pending.size > 0 || this.#options.hasStreams?.())
				return this.#worker;
			// Device/dtype changed while idle: retire the worker so the respawn uses the new env.
			void this.terminate();
		}
		const worker = this.#options.spawnWorker();
		this.#worker = worker;
		this.#workerEnvKey = envKey;
		this.#unsubscribe = [
			worker.onMessage(message => this.#handleMessage(message)),
			worker.onError(error => this.#handleWorkerError(error)),
		];
		return worker;
	}

	/** Register a pending request and keep the worker referenced while work is in flight. */
	addPending(id: string, request: Request | ModelDownloadRequest<Key>): void {
		this.pending.set(id, request);
		this.syncWorkerRef();
	}

	/** Drop a pending request and unref the worker once nothing is in flight. */
	deletePending(id: string): void {
		if (this.pending.delete(id)) this.syncWorkerRef();
	}

	/**
	 * Workers start unreferenced so an idle warm model never blocks exit. A
	 * short-lived command (`omp say`, STT setup/download) awaiting IPC would
	 * otherwise let Bun drain the event loop and exit before the reply arrives,
	 * so the worker is `ref`'d exactly while a request or stream is active.
	 */
	syncWorkerRef(): void {
		const worker = this.#worker;
		if (!worker) return;
		const shouldRef = this.pending.size > 0 || (this.#options.hasStreams?.() ?? false);
		if (shouldRef === this.#refed) return;
		this.#refed = shouldRef;
		if (shouldRef) worker.ref();
		else worker.unref();
	}

	/**
	 * Send one correlated request and await its settlement. The request stays
	 * registered (keeping the worker referenced) until it settles; an abort
	 * unregisters it and settles it through `onAbort`.
	 */
	async request<T>(
		signal: AbortSignal | undefined,
		message: (id: string) => Inbound,
		pending: (resolve: (value: T) => void, reject: (error: Error) => void) => Request | ModelDownloadRequest<Key>,
		onAbort: (resolve: (value: T) => void, reject: (error: Error) => void) => void,
	): Promise<T> {
		const worker = this.ensureWorker();
		const id = this.nextId();
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		this.addPending(id, pending(resolve, reject));
		const abort = (): void => {
			if (!this.pending.has(id)) return;
			this.deletePending(id);
			onAbort(resolve, reject);
		};
		signal?.addEventListener("abort", abort, { once: true });
		try {
			worker.send(message(id));
			return await promise;
		} finally {
			signal?.removeEventListener("abort", abort);
			this.deletePending(id);
		}
	}

	async downloadModel(modelKey: Key, options: ModelDownloadOptions<Progress> = {}): Promise<ModelDownloadResult> {
		if (options.signal?.aborted) return { ok: false };
		const unsubscribe = options.onProgress ? this.onProgress(options.onProgress) : undefined;
		try {
			return await this.request<ModelDownloadResult>(
				options.signal,
				// Every model worker's Inbound union carries this `download` request; the generic cannot prove it.
				id => ({ type: "download", id, modelKey }) as unknown as Inbound,
				resolve => ({ kind: "download", modelKey, resolve }),
				resolve => resolve({ ok: false }),
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.debug(`${this.#options.name}: local model download failed`, { modelKey, error: message });
			return { ok: false, error: message };
		} finally {
			unsubscribe?.();
		}
	}

	async terminate(): Promise<void> {
		const worker = this.#worker;
		this.#worker = null;
		for (const unsubscribe of this.#unsubscribe) unsubscribe();
		this.#unsubscribe = [];
		this.#failAll(new Error(`${this.#options.name} worker terminated`), true);
		this.#refed = false;
		try {
			await worker?.terminate();
		} catch {
			// Already gone.
		}
	}

	#handleMessage(message: Outbound): void {
		if (message.type === "log") {
			// `log` is the only Outbound member with this discriminant; the generic cannot prove it.
			const log = message as unknown as WorkerLogMessage;
			logWorkerMessage(log);
			return;
		}
		if (message.type === "progress") {
			if (message.event) this.emitProgress(message.event);
			return;
		}
		if (message.type === "pong") return;
		if (message.type === "downloaded" && message.id !== undefined) {
			const request = this.pending.get(message.id);
			if (!request) return;
			this.deletePending(message.id);
			if (isDownloadRequest(request)) request.resolve({ ok: true });
			return;
		}
		this.#options.handleMessage(message as ModelWorkerMessage<Outbound>);
	}

	/** Emit an error progress event for and settle every pending request, then fail streams. */
	#failAll(error: Error, terminated: boolean): void {
		for (const request of this.pending.values()) {
			this.emitProgress({ modelKey: request.modelKey, status: "error" } as Progress, error.message);
			if (isDownloadRequest(request)) {
				request.resolve(terminated ? { ok: false } : { ok: false, error: error.message });
			} else {
				this.#options.failRequest(request, error, terminated);
			}
		}
		this.pending.clear();
		this.#options.failStreams?.(error);
	}

	#handleWorkerError(error: Error): void {
		logger.warn(`${this.#options.name}: worker error`, { error: error.message });
		this.#failAll(error, false);
		void this.terminate();
	}
}
