import * as os from "node:os";
import { logger } from "@oh-my-pi/pi-utils";
import { daemonClient } from "../daemon/client";
import {
	decodeMessage,
	encodeMessage,
	FrameDecoder,
	FrameWriter,
	SPEECH_MODULE_KIND,
	type SpeechFlavor,
	speechUnitKey,
	speechUnitParams,
} from "../daemon/modules/speech-frames";
import { type DaemonClient, type DaemonTunnel, GLOBAL_SCOPE } from "../daemon/protocol";
import { ModelDownloadActivity, type ModelLoadProgressEvent } from "../downloads/model-downloads";
import { tinyWorkerEnv } from "../tiny/title-client";
import { resolveWorkerSpawnCmd } from "./worker-client";

/**
 * Client-side plumbing for the warm model workers (speech-to-text and
 * text-to-speech). The worker process lives in the omp daemon's `speech`
 * module, keyed on the tiny-model device/dtype env and shared by every
 * session; this host opens (find-or-start) that unit, attaches a tunnel, and
 * speaks the binary frame protocol over it. It owns pending-request
 * bookkeeping, progress fan-out, model downloads, and teardown; each client
 * keeps its own request kinds, streaming, and message semantics.
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

/** Pending readiness probe, owned and settled by the host. */
export interface PingRequest {
	kind: "ping";
	resolve: () => void;
	reject: (error: Error) => void;
}

/** Worker messages left for the client once the host consumed progress/pong/downloaded. */
export type ModelWorkerMessage<Outbound> = Exclude<Outbound, { type: "log" | "progress" | "pong" | "downloaded" }>;

/** Ordered sender bound to one tunnel; messages sent before it connects are delivered once it does. */
export interface ModelWorkerSender<Inbound> {
	send(message: Inbound): void;
}

export interface ModelWorkerHostOptions<Outbound, Request> {
	/** Log/error prefix and unit flavor. */
	name: SpeechFlavor;
	/** Hidden CLI selector that boots the worker (`STT_WORKER_ARG` / `TTS_WORKER_ARG`). */
	workerArg: string;
	/** Display label for a model key in the download registry. */
	modelLabel: (modelKey: string) => string;
	handleMessage: (message: ModelWorkerMessage<Outbound>) => void;
	/** Settle a client request when the host is torn down (`terminated`) or the worker connection fails. */
	failRequest: (request: Request, error: Error, terminated: boolean) => void;
	/** Whether work tracked outside the pending map (live streams) is active. */
	hasStreams?: () => boolean;
	/** Fail work tracked outside the pending map when the worker connection goes away. */
	failStreams?: (error: Error) => void;
	/** Smoke test: a unit of its own (`:smoke` key) that the daemon stops as soon as the lease is released. */
	smoke?: boolean;
}

interface Connection {
	daemon: DaemonClient;
	tunnel: DaemonTunnel;
	lease: string | undefined;
	writer: FrameWriter;
	offReconnect: () => void;
}

/** How often a host holding the process alive rechecks whether any work is still in flight. */
const KEEP_ALIVE_CHECK_MS = 250;

/** Any request tracked in {@link ModelWorkerHost.pending}: the client's own kinds plus host-owned ones. */
export type HostRequest<Key extends string, Request> = Request | ModelDownloadRequest<Key> | PingRequest;

export class ModelWorkerHost<
	Key extends string,
	Inbound extends { type: string; id: string },
	Outbound extends { type: string; id?: string; event?: Progress },
	Request extends { kind: string; modelKey: Key },
	Progress extends ModelLoadProgressEvent & { modelKey: Key },
> {
	/** In-flight correlated requests by id. */
	readonly pending = new Map<string, HostRequest<Key, Request>>();
	#connection: Promise<Connection> | null = null;
	/** Unit key the current connection was opened under. */
	#connectionKey: string | undefined;
	/** Bumped on every connect/teardown; stale tunnel callbacks compare against it. */
	#generation = 0;
	#progressListeners = new Set<(event: Progress) => void>();
	#downloads: ModelDownloadActivity;
	#nextRequestId = 0;
	#options: ModelWorkerHostOptions<Outbound, Request>;
	/** Ref'd while requests or streams are in flight; the tunnel itself never holds the process. */
	#keepAlive: NodeJS.Timeout | undefined;

	constructor(options: ModelWorkerHostOptions<Outbound, Request>) {
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

	/**
	 * Sender over the shared worker for the current device/dtype. Reuses the open
	 * tunnel unless the env changed while idle, in which case the old lease is
	 * dropped and the matching unit is opened.
	 */
	ensureWorker(): ModelWorkerSender<Inbound> {
		const connection = this.#connect();
		return {
			send: message => {
				this.#holdWhileBusy();
				void connection.then(
					open => open.writer.write(encodeMessage(message)),
					() => {
						// Connection failure already settled every request.
					},
				);
			},
		};
	}

	/** Register a pending request. */
	addPending(id: string, request: HostRequest<Key, Request>): void {
		this.pending.set(id, request);
	}

	deletePending(id: string): void {
		this.pending.delete(id);
	}

	/**
	 * Send one correlated request and await its settlement. An abort
	 * unregisters it and settles it through `onAbort`.
	 */
	async request<T>(
		signal: AbortSignal | undefined,
		message: (id: string) => Inbound,
		pending: (resolve: (value: T) => void, reject: (error: Error) => void) => HostRequest<Key, Request>,
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

	/** Round-trip a `ping` through the daemon to the worker; rejects after `timeoutMs`. */
	async ping(timeoutMs: number): Promise<void> {
		const timeout = AbortSignal.timeout(timeoutMs);
		await this.request<void>(
			timeout,
			// Every model worker's Inbound union carries `ping`; the generic cannot prove it.
			id => ({ type: "ping", id }) as unknown as Inbound,
			(resolve, reject) => ({ kind: "ping", resolve: () => resolve(), reject }),
			(_resolve, reject) => reject(new Error(`${this.#options.name} worker did not pong within ${timeoutMs}ms`)),
		);
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

	/** Close the tunnel and drop the lease; the shared worker stays warm for its idle window. */
	async terminate(): Promise<void> {
		const connection = this.#connection;
		this.#connection = null;
		this.#connectionKey = undefined;
		this.#generation++;
		this.#failAll(new Error(`${this.#options.name} worker terminated`), true);
		if (!connection) return;
		try {
			await this.#dispose(await connection);
		} catch {
			// Never connected, or the daemon is already gone.
		}
	}

	/** Keep the process alive until every request and stream in flight settled. */
	#holdWhileBusy(): void {
		if (this.#keepAlive) return;
		this.#keepAlive = setInterval(() => {
			if (this.pending.size > 0 || this.#options.hasStreams?.()) return;
			clearInterval(this.#keepAlive);
			this.#keepAlive = undefined;
		}, KEEP_ALIVE_CHECK_MS);
	}

	async #dispose(open: Connection): Promise<void> {
		open.offReconnect();
		open.writer.close();
		open.tunnel.close();
		if (open.lease) await open.daemon.release(open.lease);
	}

	#connect(): Promise<Connection> {
		const env = tinyWorkerEnv();
		const baseKey = speechUnitKey(this.#options.name, env);
		const key = this.#options.smoke ? `${baseKey}:smoke` : baseKey;
		if (this.#connection) {
			if (this.#connectionKey === key || this.pending.size > 0 || this.#options.hasStreams?.()) {
				return this.#connection;
			}
			// Device/dtype changed while idle: release the old unit and open the matching one.
			void this.terminate();
		}
		const generation = ++this.#generation;
		const connection = this.#open(key, env, generation);
		this.#connection = connection;
		this.#connectionKey = key;
		connection.catch(error => {
			if (generation !== this.#generation) return;
			const failure = error instanceof Error ? error : new Error(String(error));
			logger.warn(`${this.#options.name}: worker unavailable`, { error: failure.message });
			this.#lost(failure);
		});
		return connection;
	}

	async #open(key: string, env: Record<string, string>, generation: number): Promise<Connection> {
		const daemon = await daemonClient();
		const { unit, lease } = await daemon.open({
			kind: SPEECH_MODULE_KIND,
			scope: GLOBAL_SCOPE,
			key,
			label: `${this.#options.name} worker`,
			params: speechUnitParams(resolveWorkerSpawnCmd(this.#options.workerArg), env, os.homedir()),
			policy: this.#options.smoke ? { idleMs: 0 } : undefined,
		});
		let tunnel: DaemonTunnel;
		try {
			tunnel = await daemon.attach(unit.id);
		} catch (error) {
			if (lease) void daemon.release(lease).catch(() => {});
			throw error;
		}
		// Pending work holds the process through #keepAlive; an idle tunnel must not.
		tunnel.unref();
		// The lease died with the old daemon connection; the next use opens the unit again.
		const offReconnect = daemon.onReconnect(() => {
			if (generation !== this.#generation) return;
			this.#lost(new Error(`${this.#options.name} worker lost: daemon restarted`));
		});
		const decoder = new FrameDecoder();
		tunnel.start(
			chunk => {
				if (generation !== this.#generation) return;
				try {
					decoder.push(chunk, frame => this.#handleMessage(decodeMessage<Outbound>(frame)));
				} catch (error) {
					logger.warn(`${this.#options.name}: malformed worker frame`, {
						error: error instanceof Error ? error.message : String(error),
					});
					tunnel.close();
				}
			},
			reason => {
				if (generation !== this.#generation) return;
				this.#lost(new Error(`${this.#options.name} worker connection closed${reason ? `: ${reason}` : ""}`));
			},
		);
		return { daemon, tunnel, lease, writer: new FrameWriter(tunnel), offReconnect };
	}

	/** The tunnel failed or closed under live work: settle everything and reconnect on next use. */
	#lost(error: Error): void {
		const connection = this.#connection;
		this.#connection = null;
		this.#connectionKey = undefined;
		this.#generation++;
		this.#failAll(error, false);
		void connection?.then(open => this.#dispose(open)).catch(() => {});
	}

	#handleMessage(message: Outbound): void {
		if (message.type === "progress") {
			if (message.event) this.emitProgress(message.event);
			return;
		}
		if ((message.type === "downloaded" || message.type === "pong") && message.id !== undefined) {
			const request = this.pending.get(message.id);
			if (!request) return;
			this.deletePending(message.id);
			if (request.kind === "download") (request as ModelDownloadRequest<Key>).resolve({ ok: true });
			else if (request.kind === "ping") (request as PingRequest).resolve();
			return;
		}
		if (message.type === "log") return;
		this.#options.handleMessage(message as ModelWorkerMessage<Outbound>);
	}

	/** Emit an error progress event for and settle every pending request, then fail streams. */
	#failAll(error: Error, terminated: boolean): void {
		for (const request of this.pending.values()) {
			if (request.kind === "ping") {
				(request as PingRequest).reject(error);
				continue;
			}
			const modelRequest = request as Request | ModelDownloadRequest<Key>;
			this.emitProgress({ modelKey: modelRequest.modelKey, status: "error" } as Progress, error.message);
			if (modelRequest.kind === "download") {
				(modelRequest as ModelDownloadRequest<Key>).resolve(
					terminated ? { ok: false } : { ok: false, error: error.message },
				);
			} else {
				this.#options.failRequest(modelRequest as Request, error, terminated);
			}
		}
		this.pending.clear();
		this.#options.failStreams?.(error);
	}
}
