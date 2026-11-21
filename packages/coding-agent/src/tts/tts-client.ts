import { logger, toError } from "@oh-my-pi/pi-utils";
import { type ModelWorkerMessage, type ModelWorkerSender, ModelWorkerHost } from "../subprocess/model-worker-host";
import { SMOKE_TEST_TIMEOUT_MS } from "../subprocess/worker-client";
import { getTtsLocalModelSpec, isTtsLocalModelKey, type TtsLocalModelKey } from "./models";
import type { TtsProgressEvent, TtsWorkerInbound, TtsWorkerOutbound } from "./tts-protocol";

/** Decoded PCM returned by a local synthesis request. */
export interface TtsAudio {
	pcm: Float32Array;
	sampleRate: number;
}

type TtsRequest =
	| { kind: "synthesize"; modelKey: TtsLocalModelKey; resolve: (audio: TtsAudio | null) => void }
	| { kind: "stream"; modelKey: TtsLocalModelKey; channel: AudioChunkChannel };

export interface TtsSynthesizeOptions {
	voice?: string;
	/** Speaking rate (1 = normal); clamped by the worker. Omitted means normal speed. */
	speed?: number;
	signal?: AbortSignal;
}

export interface TtsDownloadOptions {
	signal?: AbortSignal;
	onProgress?: (event: TtsProgressEvent) => void;
}

export interface TtsStreamOptions {
	voice?: string;
	/** Speaking rate (1 = normal); clamped by the worker. Omitted means normal speed. */
	speed?: number;
	signal?: AbortSignal;
}

/** One synthesized segment of a streaming session, in emission order. */
export interface TtsAudioChunk {
	index: number;
	text: string;
	pcm: Float32Array;
	sampleRate: number;
}

/**
 * A live streaming-synthesis session. Feed complete speakable segments with
 * {@link push} (the worker synthesizes each push as-is) and close the input
 * with {@link end}; `chunks` yields each segment's audio as soon as it is
 * ready, then completes once the worker finishes draining the closed input.
 */
export interface TtsStreamHandle {
	push(text: string): void;
	end(): void;
	chunks: AsyncIterableIterator<TtsAudioChunk>;
}

/**
 * Single-producer/single-consumer async queue bridging the worker's tunnelled
 * `audio-chunk` messages to an async iterator. Chunks pushed while no consumer
 * is awaiting are buffered in order; {@link close} ends the iterator and
 * {@link fail} surfaces an error to the awaiting (or next) consumer.
 */
class AudioChunkChannel {
	#queue: TtsAudioChunk[] = [];
	#waiters: Array<{
		resolve: (result: IteratorResult<TtsAudioChunk>) => void;
		reject: (error: Error) => void;
	}> = [];
	#error: Error | null = null;
	#settled = false;
	#onSettle: (() => void) | undefined;

	constructor(onSettle?: () => void) {
		this.#onSettle = onSettle;
	}

	push(chunk: TtsAudioChunk): void {
		if (this.#settled) return;
		const waiter = this.#waiters.shift();
		if (waiter) waiter.resolve({ value: chunk, done: false });
		else this.#queue.push(chunk);
	}

	close(): void {
		this.#settle(null);
	}

	fail(error: Error): void {
		this.#settle(error);
	}

	#settle(error: Error | null): void {
		if (this.#settled) return;
		this.#settled = true;
		this.#error = error;
		for (const waiter of this.#waiters) {
			if (error) waiter.reject(error);
			else waiter.resolve({ value: undefined, done: true });
		}
		this.#waiters = [];
		this.#onSettle?.();
	}

	async *iterator(): AsyncIterableIterator<TtsAudioChunk> {
		while (true) {
			const buffered = this.#queue.shift();
			if (buffered) {
				yield buffered;
				continue;
			}
			if (this.#error) throw this.#error;
			if (this.#settled) return;
			const { promise, resolve, reject } = Promise.withResolvers<IteratorResult<TtsAudioChunk>>();
			this.#waiters.push({ resolve, reject });
			const result = await promise;
			if (result.done) return;
			yield result.value;
		}
	}
}

/**
 * Hidden subcommand on the main CLI that boots the TTS worker (spawned by the
 * daemon `speech` module). Kept in sync with the dispatch in `cli.ts`.
 */
export const TTS_WORKER_ARG = "__omp_worker_tts";

export class TtsClient {
	#host: ModelWorkerHost<TtsLocalModelKey, TtsWorkerInbound, TtsWorkerOutbound, TtsRequest, TtsProgressEvent>;

	/** `smoke`: a private unit the daemon stops once {@link terminate} releases it. */
	constructor(options: { smoke?: boolean } = {}) {
		this.#host = new ModelWorkerHost({
			name: "tts",
			smoke: options.smoke,
			workerArg: TTS_WORKER_ARG,
			modelLabel: modelKey => getTtsLocalModelSpec(modelKey)?.label ?? modelKey,
			handleMessage: message => this.#handleMessage(message),
			failRequest: (request, error, terminated) => {
				if (request.kind === "synthesize") request.resolve(null);
				else if (terminated) request.channel.close();
				else request.channel.fail(error);
			},
		});
	}

	onProgress(listener: (event: TtsProgressEvent) => void): () => void {
		return this.#host.onProgress(listener);
	}

	async synthesize(modelKey: string, text: string, options: TtsSynthesizeOptions = {}): Promise<TtsAudio | null> {
		if (!isTtsLocalModelKey(modelKey)) return null;
		if (options.signal?.aborted) return null;

		try {
			return await this.#host.request<TtsAudio | null>(
				options.signal,
				(id): TtsWorkerInbound => ({
					type: "synthesize",
					id,
					modelKey,
					text,
					...(options.voice ? { voice: options.voice } : {}),
					...(options.speed !== undefined ? { speed: options.speed } : {}),
				}),
				resolve => ({ kind: "synthesize", modelKey, resolve }),
				resolve => resolve(null),
			);
		} catch (error) {
			logger.debug("tts: local synthesis failed", {
				modelKey,
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	/**
	 * Open a streaming-synthesis session. Complete speakable segments are fed
	 * through the returned handle's `push`/`end`; audio is emitted one segment
	 * at a time via `chunks`, so playback can begin before the full text is
	 * known. Returns an inert handle (immediately-ended `chunks`) for unknown
	 * models or an already-aborted signal, and fails the iterator if the worker
	 * cannot start.
	 */
	synthesizeStream(modelKey: string, options: TtsStreamOptions = {}): TtsStreamHandle {
		if (!isTtsLocalModelKey(modelKey) || options.signal?.aborted) {
			const channel = new AudioChunkChannel();
			channel.close();
			return { push: () => {}, end: () => {}, chunks: channel.iterator() };
		}

		let worker: ModelWorkerSender<TtsWorkerInbound>;
		try {
			worker = this.#host.ensureWorker();
		} catch (error) {
			logger.debug("tts: stream synthesis failed to start", {
				modelKey,
				error: error instanceof Error ? error.message : String(error),
			});
			const channel = new AudioChunkChannel();
			channel.fail(toError(error));
			return { push: () => {}, end: () => {}, chunks: channel.iterator() };
		}

		const id = this.#host.nextId();
		const signal = options.signal;
		let closed = false;
		let ended = false;
		const abort = (): void => {
			if (closed) return;
			closed = true;
			ended = true;
			if (!this.#host.pending.has(id)) return;
			this.#host.deletePending(id);
			worker.send({ type: "stream-cancel", id });
			channel.close();
		};
		const channel = new AudioChunkChannel(() => signal?.removeEventListener("abort", abort));
		this.#host.addPending(id, { kind: "stream", modelKey, channel });
		signal?.addEventListener("abort", abort, { once: true });

		const start: TtsWorkerInbound = {
			type: "stream-start",
			id,
			modelKey,
			...(options.voice ? { voice: options.voice } : {}),
			...(options.speed !== undefined ? { speed: options.speed } : {}),
		};
		worker.send(start);

		return {
			push: (text: string) => {
				if (!closed && !ended) worker.send({ type: "stream-push", id, text });
			},
			end: () => {
				if (closed || ended) return;
				ended = true;
				worker.send({ type: "stream-end", id });
			},
			chunks: channel.iterator(),
		};
	}

	async downloadModel(modelKey: string, options: TtsDownloadOptions = {}): Promise<boolean> {
		if (!isTtsLocalModelKey(modelKey)) return false;
		return (await this.#host.downloadModel(modelKey, options)).ok;
	}

	/** Round-trip a `ping` to the worker. */
	ping(timeoutMs: number): Promise<void> {
		return this.#host.ping(timeoutMs);
	}

	terminate(): Promise<void> {
		return this.#host.terminate();
	}

	#handleMessage(message: ModelWorkerMessage<TtsWorkerOutbound>): void {
		const pending = this.#host.pending.get(message.id);
		if (!pending) return;

		// Streaming chunks are non-terminal: keep the session registered until
		// `stream-done` (or an error) so later chunks still route to its channel.
		if (message.type === "audio-chunk") {
			if (pending.kind === "stream") {
				pending.channel.push({
					index: message.index,
					text: message.text,
					pcm: message.pcm,
					sampleRate: message.sampleRate,
				});
			}
			return;
		}

		this.#host.deletePending(message.id);
		if (message.type === "stream-done") {
			if (pending.kind === "stream") pending.channel.close();
			return;
		}
		if (message.type === "audio") {
			if (pending.kind === "synthesize") pending.resolve({ pcm: message.pcm, sampleRate: message.sampleRate });
			return;
		}
		logger.debug("tts: worker returned error", { error: message.error });
		if (pending.kind === "ping") {
			pending.reject(new Error(message.error));
			return;
		}
		this.#host.emitProgress({ modelKey: pending.modelKey, status: "error" }, message.error);
		if (pending.kind === "synthesize") pending.resolve(null);
		else if (pending.kind === "download") pending.resolve({ ok: false, error: message.error });
		else pending.channel.fail(new Error(message.error));
	}
}

export const ttsClient = new TtsClient();

export async function shutdownTtsClient(): Promise<void> {
	await ttsClient.terminate();
}

/** `omp --smoke-test` probe: start the TTS worker under the daemon, ping it, and let the daemon stop it. */
export async function smokeTestTtsWorker({
	timeoutMs = SMOKE_TEST_TIMEOUT_MS,
}: {
	timeoutMs?: number;
} = {}): Promise<void> {
	const client = new TtsClient({ smoke: true });
	try {
		await client.ping(timeoutMs);
	} finally {
		await client.terminate();
	}
}
