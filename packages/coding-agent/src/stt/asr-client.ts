import { type ModelWorkerMessage, ModelWorkerHost } from "../subprocess/model-worker-host";
import { SMOKE_TEST_TIMEOUT_MS } from "../subprocess/worker-client";
import type { SttProgressEvent, SttWorkerInbound, SttWorkerOutbound } from "./asr-protocol";
import { getSttModelSpec, type SttModelKey } from "./models";

type TranscribeRequest = {
	kind: "transcribe";
	modelKey: SttModelKey;
	resolve: (text: string) => void;
	reject: (error: Error) => void;
};

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
	/** The accelerated device failed to load the model; the worker runs on `fallbackDevice` instead. */
	onDeviceFallback?: (fallback: SttDeviceFallback) => void;
}

export interface SttDeviceFallback {
	device: string;
	fallbackDevice: string;
	error: string;
}

interface StreamState {
	modelKey: SttModelKey;
	onPartial: ((text: string) => void) | undefined;
	onSegment: ((text: string, index: number) => void) | undefined;
	onDeviceFallback: ((fallback: SttDeviceFallback) => void) | undefined;
	resolve: (text: string) => void;
	reject: (error: Error) => void;
	/** Run `apply` (resolve/reject) once, then unregister the stream. */
	finish: (apply: () => void) => void;
}

/**
 * Hidden subcommand on the main CLI that boots the speech-recognition worker
 * (spawned by the daemon `speech` module). Kept in sync with the dispatch in `cli.ts`.
 */
export const STT_WORKER_ARG = "__omp_worker_stt";

export class SttClient {
	#streams = new Map<string, StreamState>();
	#host: ModelWorkerHost<SttModelKey, SttWorkerInbound, SttWorkerOutbound, TranscribeRequest, SttProgressEvent>;

	/** `smoke`: a private unit the daemon stops once {@link terminate} releases it. */
	constructor(options: { smoke?: boolean } = {}) {
		this.#host = new ModelWorkerHost({
			name: "stt",
			smoke: options.smoke,
			workerArg: STT_WORKER_ARG,
			modelLabel: modelKey => getSttModelSpec(modelKey)?.label ?? modelKey,
			handleMessage: message => this.#handleMessage(message),
			failRequest: (request, error) => request.reject(error),
			hasStreams: () => this.#streams.size > 0,
			failStreams: error => this.#failStreams(error),
		});
	}

	onProgress(listener: (event: SttProgressEvent) => void): () => void {
		return this.#host.onProgress(listener);
	}

	/**
	 * Transcribe 16 kHz mono audio on the shared warm worker in the omp daemon.
	 * Rejects with the worker error on failure and with an `AbortError` when the
	 * signal fires (the warm worker keeps the model loaded across calls).
	 */
	async transcribe(modelKey: SttModelKey, audio: Float32Array, options: SttTranscribeOptions = {}): Promise<string> {
		options.signal?.throwIfAborted();
		return this.#host.request<string>(
			options.signal,
			id => ({ type: "transcribe", id, modelKey, audio, language: options.language }),
			(resolve, reject) => ({ kind: "transcribe", modelKey, resolve, reject }),
			(_resolve, reject) => reject(new DOMException("The operation was aborted.", "AbortError")),
		);
	}

	/**
	 * Open a live streaming session on the warm worker. Audio fed through the
	 * returned handle is segmented by the worker's endpointer: `onSegment` fires
	 * once per committed segment and `onPartial` for the volatile in-progress
	 * preview. `stop()` resolves with the full joined transcript; `cancel()` (or
	 * an aborted signal) tears the session down and resolves `stop()` with "".
	 */
	startStream(modelKey: SttModelKey, options: SttStreamOptions = {}): SttStreamHandle {
		const worker = this.#host.ensureWorker();
		const id = this.#host.nextId();
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
			apply();
		};
		this.#streams.set(id, {
			modelKey,
			onPartial: options.onPartial,
			onSegment: options.onSegment,
			onDeviceFallback: options.onDeviceFallback,
			resolve,
			reject,
			finish,
		});
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

	downloadModel(modelKey: SttModelKey, options: SttDownloadOptions = {}): Promise<SttDownloadResult> {
		return this.#host.downloadModel(modelKey, options);
	}

	/** Round-trip a `ping` to the worker. */
	ping(timeoutMs: number): Promise<void> {
		return this.#host.ping(timeoutMs);
	}

	terminate(): Promise<void> {
		return this.#host.terminate();
	}

	#handleMessage(message: ModelWorkerMessage<SttWorkerOutbound>): void {
		if (message.type === "device_fallback") {
			const { device, fallbackDevice, error } = message;
			this.#streams.get(message.id)?.onDeviceFallback?.({ device, fallbackDevice, error });
			return;
		}
		if (message.type === "partial" || message.type === "segment" || message.type === "stream_done") {
			const stream = this.#streams.get(message.id);
			if (!stream) return;
			if (message.type === "partial") stream.onPartial?.(message.text);
			else if (message.type === "segment") stream.onSegment?.(message.text, message.index);
			else stream.finish(() => stream.resolve(message.text));
			return;
		}

		const pending = this.#host.pending.get(message.id);
		if (!pending) {
			if (message.type === "error") {
				const stream = this.#streams.get(message.id);
				if (stream) {
					this.#host.emitProgress({ modelKey: stream.modelKey, status: "error" }, message.error);
					stream.finish(() => stream.reject(new Error(message.error)));
				}
			}
			return;
		}
		this.#host.deletePending(message.id);
		if (message.type === "transcription") {
			if (pending.kind === "transcribe") pending.resolve(message.text);
			return;
		}
		// message.type === "error"
		if (pending.kind === "ping") {
			pending.reject(new Error(message.error));
			return;
		}
		this.#host.emitProgress({ modelKey: pending.modelKey, status: "error" }, message.error);
		if (pending.kind === "transcribe") pending.reject(new Error(message.error));
		else pending.resolve({ ok: false, error: message.error });
	}

	#failStreams(error: Error): void {
		for (const stream of Array.from(this.#streams.values())) {
			this.#host.emitProgress({ modelKey: stream.modelKey, status: "error" }, error.message);
			stream.finish(() => stream.reject(error));
		}
	}
}

export const sttClient = new SttClient();

export async function shutdownSttClient(): Promise<void> {
	await sttClient.terminate();
}

/** `omp --smoke-test` probe: start the STT worker under the daemon, ping it, and let the daemon stop it. */
export async function smokeTestSttWorker({
	timeoutMs = SMOKE_TEST_TIMEOUT_MS,
}: {
	timeoutMs?: number;
} = {}): Promise<void> {
	const client = new SttClient({ smoke: true });
	try {
		await client.ping(timeoutMs);
	} finally {
		await client.terminate();
	}
}
