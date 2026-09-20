import { logger } from "@oh-my-pi/pi-utils";
import {
	createUnavailableWorker,
	createWorkerHandle,
	createWorkerSubprocess,
	logWorkerMessage,
	type RefCountedWorkerHandle,
	resolveWorkerSpawnCmd,
	SMOKE_TEST_TIMEOUT_MS,
	type SpawnedSubprocess,
	smokeTestWorker,
	spawnWorkerOrUnavailable,
} from "../subprocess/worker-client";
import { tinyWorkerEnv } from "../tiny/title-client";
import { safeSend } from "../utils/ipc";
import type { SttProgressEvent, SttWorkerInbound, SttWorkerOutbound } from "./asr-protocol";
import type { SttModelKey } from "./models";

type PendingRequest =
	| { kind: "transcribe"; modelKey: SttModelKey; resolve: (text: string) => void; reject: (error: Error) => void }
	| { kind: "download"; modelKey: SttModelKey; resolve: (result: SttDownloadResult) => void };

export interface SttTranscribeOptions {
	language?: string;
	signal?: AbortSignal;
}

export interface SttDownloadOptions {
	signal?: AbortSignal;
	onProgress?: (event: SttProgressEvent) => void;
}

export interface SttDownloadResult {
	ok: boolean;
	error?: string;
}

/** Live streaming session handle returned by {@link SttClient.startStream}. */
export interface SttStreamHandle {
	/** Feed 16 kHz mono float samples as the recorder produces them. */
	pushAudio(audio: Float32Array): void;
	/** Flush the trailing segment and resolve with the full joined transcript. */
	stop(): Promise<string>;
	/** Tear the session down without a final flush (resolves `stop()` with ""). */
	cancel(): void;
}

export interface SttStreamOptions {
	language?: string;
	signal?: AbortSignal;
	/** Volatile transcript of the in-progress segment, refreshed as audio arrives. */
	onPartial?: (text: string) => void;
	/** A finalized segment, emitted once when the endpointer commits it. */
	onSegment?: (text: string, index: number) => void;
}

interface StreamState {
	modelKey: SttModelKey;
	onPartial: ((text: string) => void) | undefined;
	onSegment: ((text: string, index: number) => void) | undefined;
	resolve: (text: string) => void;
	reject: (error: Error) => void;
	/** Run `apply` (resolve/reject) once, then unregister the stream. */
	finish: (apply: () => void) => void;
}

/**
 * Hidden subcommand on the main CLI that boots the speech-recognition worker in
 * the spawned subprocess. Kept in sync with the dispatch in `cli.ts`.
 */
export const STT_WORKER_ARG = "__omp_worker_stt";

/**
 * Spawn the speech worker as a subprocess. Exported for tests and the smoke
 * probe; production callers go through {@link spawnSttWorker}.
 */
export function createSttSubprocess(): SpawnedSubprocess<SttWorkerOutbound> {
	return createWorkerSubprocess<SttWorkerOutbound>({
		spawnCommand: resolveWorkerSpawnCmd(STT_WORKER_ARG),
		env: tinyWorkerEnv(),
		exitLabel: "stt subprocess",
	});
}

function wrapSubprocess(
	spawned: SpawnedSubprocess<SttWorkerOutbound>,
): RefCountedWorkerHandle<SttWorkerInbound, SttWorkerOutbound> {
	const { proc } = spawned;
	return {
		...createWorkerHandle<SttWorkerInbound, SttWorkerOutbound>(spawned, message => safeSend(proc, message, "stt")),
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

function spawnInlineUnavailableWorker(error: unknown): RefCountedWorkerHandle<SttWorkerInbound, SttWorkerOutbound> {
	return {
		...createUnavailableWorker<SttWorkerInbound, SttWorkerOutbound>(error),
		ref() {},
		unref() {},
	};
}

function spawnSttWorker(): RefCountedWorkerHandle<SttWorkerInbound, SttWorkerOutbound> {
	return spawnWorkerOrUnavailable(
		() => wrapSubprocess(createSttSubprocess()),
		spawnInlineUnavailableWorker,
		"stt worker spawn failed; speech-to-text disabled",
	);
}

export class SttClient {
	#worker: RefCountedWorkerHandle<SttWorkerInbound, SttWorkerOutbound> | null = null;
	#unsubscribeMessage: (() => void) | null = null;
	#unsubscribeError: (() => void) | null = null;
	#pending = new Map<string, PendingRequest>();
	#streams = new Map<string, StreamState>();
	#progressListeners = new Set<(event: SttProgressEvent) => void>();
	#nextRequestId = 0;
	#refed = false;
	#spawnWorker: () => RefCountedWorkerHandle<SttWorkerInbound, SttWorkerOutbound>;

	constructor(spawnWorker: () => RefCountedWorkerHandle<SttWorkerInbound, SttWorkerOutbound> = spawnSttWorker) {
		this.#spawnWorker = spawnWorker;
	}

	onProgress(listener: (event: SttProgressEvent) => void): () => void {
		this.#progressListeners.add(listener);
		return () => this.#progressListeners.delete(listener);
	}

	/**
	 * Transcribe 16 kHz mono audio on the warm worker. Rejects with the worker
	 * error on failure and with an `AbortError` when the signal fires (the warm
	 * worker keeps the model loaded across calls — the model is never reloaded).
	 */
	async transcribe(modelKey: SttModelKey, audio: Float32Array, options: SttTranscribeOptions = {}): Promise<string> {
		options.signal?.throwIfAborted();
		const worker = this.#ensureWorker();
		const id = String(++this.#nextRequestId);
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		this.#addPending(id, { kind: "transcribe", modelKey, resolve, reject });
		const abort = (): void => {
			const pending = this.#pending.get(id);
			if (pending?.kind !== "transcribe") return;
			this.#deletePending(id);
			pending.reject(new DOMException("The operation was aborted.", "AbortError"));
		};
		options.signal?.addEventListener("abort", abort, { once: true });
		try {
			worker.send({ type: "transcribe", id, modelKey, audio, language: options.language });
			return await promise;
		} finally {
			options.signal?.removeEventListener("abort", abort);
			this.#deletePending(id);
		}
	}

	/**
	 * Open a live streaming session on the warm worker. Audio fed through the
	 * returned handle is segmented by the worker's endpointer: `onSegment` fires
	 * once per committed segment and `onPartial` for the volatile in-progress
	 * preview. `stop()` resolves with the full joined transcript; `cancel()` (or
	 * an aborted signal) tears the session down and resolves `stop()` with "".
	 */
	startStream(modelKey: SttModelKey, options: SttStreamOptions = {}): SttStreamHandle {
		const worker = this.#ensureWorker();
		const id = String(++this.#nextRequestId);
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		// `stop()` is normally the only awaiter of `promise`, but with model loading
		// now deferred to the stream, a load failure (or early worker error) can
		// reject it before the caller stops — attach a benign handler so that never
		// surfaces as an unhandled rejection. stop()/await still observes the
		// rejection through the original promise.
		void promise.catch(() => {});
		const signal = options.signal;
		let settled = false;
		const onAbort = (): void => handle.cancel();
		const finish = (apply: () => void): void => {
			if (settled) return;
			settled = true;
			this.#streams.delete(id);
			signal?.removeEventListener("abort", onAbort);
			this.#syncWorkerRef();
			apply();
		};
		this.#streams.set(id, {
			modelKey,
			onPartial: options.onPartial,
			onSegment: options.onSegment,
			resolve,
			reject,
			finish,
		});
		this.#syncWorkerRef();
		worker.send({ type: "stream_start", id, modelKey, language: options.language });
		const handle: SttStreamHandle = {
			pushAudio: audio => {
				if (!settled) worker.send({ type: "stream_audio", id, audio });
			},
			stop: () => {
				if (!settled) worker.send({ type: "stream_stop", id });
				return promise;
			},
			cancel: () => {
				if (settled) return;
				worker.send({ type: "stream_cancel", id });
				finish(() => resolve(""));
			},
		};
		if (signal?.aborted) handle.cancel();
		else signal?.addEventListener("abort", onAbort, { once: true });
		return handle;
	}

	async downloadModel(modelKey: SttModelKey, options: SttDownloadOptions = {}): Promise<SttDownloadResult> {
		if (options.signal?.aborted) return { ok: false };
		const unsubscribe = options.onProgress ? this.onProgress(options.onProgress) : undefined;
		try {
			const worker = this.#ensureWorker();
			const id = String(++this.#nextRequestId);
			const { promise, resolve } = Promise.withResolvers<SttDownloadResult>();
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
			logger.debug("stt: local model download failed", {
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
			if (pending.kind === "transcribe") pending.reject(new Error("stt worker terminated"));
			else pending.resolve({ ok: false });
		}
		this.#pending.clear();
		this.#refed = false;
		this.#failStreams(new Error("stt worker terminated"));
		try {
			await worker?.terminate();
		} catch {
			// Already gone.
		}
	}

	#ensureWorker(): RefCountedWorkerHandle<SttWorkerInbound, SttWorkerOutbound> {
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

	/** Drop a pending request and unref the worker once no request or stream is active. */
	#deletePending(id: string): void {
		if (this.#pending.delete(id)) this.#syncWorkerRef();
	}

	/**
	 * STT workers start unreferenced so an idle warm model never blocks exit.
	 * Setup/download commands must keep the worker alive while awaiting IPC, or
	 * Bun can drain the event loop immediately after `Preparing Speech-to-Text`.
	 */
	#syncWorkerRef(): void {
		const worker = this.#worker;
		if (!worker) return;
		const shouldRef = this.#pending.size > 0 || this.#streams.size > 0;
		if (shouldRef === this.#refed) return;
		this.#refed = shouldRef;
		if (shouldRef) worker.ref();
		else worker.unref();
	}

	#handleMessage(message: SttWorkerOutbound): void {
		if (message.type === "log") {
			logWorkerMessage(message);
			return;
		}
		if (message.type === "progress") {
			this.#emitProgress(message.event);
			return;
		}
		if (message.type === "pong") return;

		if (message.type === "partial" || message.type === "segment" || message.type === "stream_done") {
			const stream = this.#streams.get(message.id);
			if (!stream) return;
			if (message.type === "partial") stream.onPartial?.(message.text);
			else if (message.type === "segment") stream.onSegment?.(message.text, message.index);
			else stream.finish(() => stream.resolve(message.text));
			return;
		}

		const pending = this.#pending.get(message.id);
		if (!pending) {
			if (message.type === "error") {
				const stream = this.#streams.get(message.id);
				if (stream) {
					this.#emitProgress({ modelKey: stream.modelKey, status: "error" });
					stream.finish(() => stream.reject(new Error(message.error)));
				}
			}
			return;
		}
		this.#deletePending(message.id);
		if (message.type === "transcription") {
			if (pending.kind === "transcribe") pending.resolve(message.text);
			return;
		}
		if (message.type === "downloaded") {
			if (pending.kind === "download") pending.resolve({ ok: true });
			return;
		}
		// message.type === "error"
		this.#emitProgress({ modelKey: pending.modelKey, status: "error" });
		if (pending.kind === "transcribe") pending.reject(new Error(message.error));
		else pending.resolve({ ok: false, error: message.error });
	}

	#emitProgress(event: SttProgressEvent): void {
		for (const listener of this.#progressListeners) listener(event);
	}

	#failStreams(error: Error): void {
		for (const stream of Array.from(this.#streams.values())) {
			this.#emitProgress({ modelKey: stream.modelKey, status: "error" });
			stream.finish(() => stream.reject(error));
		}
	}

	#handleWorkerError(error: Error): void {
		logger.warn("stt: worker error", { error: error.message });
		for (const pending of this.#pending.values()) {
			this.#emitProgress({ modelKey: pending.modelKey, status: "error" });
			if (pending.kind === "transcribe") pending.reject(error);
			else pending.resolve({ ok: false, error: error.message });
		}
		this.#pending.clear();
		this.#failStreams(error);
		void this.terminate();
	}
}

export const sttClient = new SttClient();

export async function shutdownSttClient(): Promise<void> {
	await sttClient.terminate();
}

export async function smokeTestSttWorker({
	timeoutMs = SMOKE_TEST_TIMEOUT_MS,
}: {
	timeoutMs?: number;
} = {}): Promise<void> {
	await smokeTestWorker(wrapSubprocess(createSttSubprocess()), "stt worker", timeoutMs);
}
