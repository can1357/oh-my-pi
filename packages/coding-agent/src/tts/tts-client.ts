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
import { isTtsLocalModelKey, type TtsLocalModelKey } from "./models";
import type { TtsProgressEvent, TtsWorkerInbound, TtsWorkerOutbound } from "./tts-protocol";

/** Decoded PCM returned by a local synthesis request. */
export interface TtsAudio {
	pcm: Float32Array;
	sampleRate: number;
}

type PendingRequest =
	| { kind: "synthesize"; modelKey: TtsLocalModelKey; resolve: (audio: TtsAudio | null) => void }
	| { kind: "download"; modelKey: TtsLocalModelKey; resolve: (ok: boolean) => void }
	| { kind: "stream"; modelKey: TtsLocalModelKey; channel: AudioChunkChannel };

export interface TtsSynthesizeOptions {
	voice?: string;
	signal?: AbortSignal;
}

export interface TtsDownloadOptions {
	signal?: AbortSignal;
	onProgress?: (event: TtsProgressEvent) => void;
}

export interface TtsStreamOptions {
	voice?: string;
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
 * Single-producer/single-consumer async queue bridging the worker's IPC
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
 * Hidden subcommand on the main CLI that boots the TTS worker in the spawned
 * subprocess. Kept in sync with the dispatch in `cli.ts` (Main-owned).
 */
export const TTS_WORKER_ARG = "__omp_worker_tts";

/**
 * Spawn the TTS worker as a subprocess. Exported for tests and the smoke probe;
 * production callers go through {@link spawnTtsWorker}.
 */
export function createTtsSubprocess(): SpawnedSubprocess<TtsWorkerOutbound> {
	return createWorkerSubprocess<TtsWorkerOutbound>({
		spawnCommand: resolveWorkerSpawnCmd(TTS_WORKER_ARG),
		env: tinyWorkerEnv(),
		exitLabel: "tts subprocess",
	});
}

function wrapSubprocess(
	spawned: SpawnedSubprocess<TtsWorkerOutbound>,
): RefCountedWorkerHandle<TtsWorkerInbound, TtsWorkerOutbound> {
	const { proc } = spawned;
	return {
		...createWorkerHandle<TtsWorkerInbound, TtsWorkerOutbound>(spawned, message => safeSend(proc, message, "tts")),
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

function spawnInlineUnavailableWorker(error: unknown): RefCountedWorkerHandle<TtsWorkerInbound, TtsWorkerOutbound> {
	return {
		...createUnavailableWorker<TtsWorkerInbound, TtsWorkerOutbound>(error),
		ref() {},
		unref() {},
	};
}

function spawnTtsWorker(): RefCountedWorkerHandle<TtsWorkerInbound, TtsWorkerOutbound> {
	return spawnWorkerOrUnavailable(
		() => wrapSubprocess(createTtsSubprocess()),
		spawnInlineUnavailableWorker,
		"TTS worker spawn failed; local TTS disabled",
	);
}

export class TtsClient {
	#worker: RefCountedWorkerHandle<TtsWorkerInbound, TtsWorkerOutbound> | null = null;
	#unsubscribeMessage: (() => void) | null = null;
	#unsubscribeError: (() => void) | null = null;
	#pending = new Map<string, PendingRequest>();
	#progressListeners = new Set<(event: TtsProgressEvent) => void>();
	#nextRequestId = 0;
	#refed = false;
	#spawnWorker: () => RefCountedWorkerHandle<TtsWorkerInbound, TtsWorkerOutbound>;

	constructor(spawnWorker: () => RefCountedWorkerHandle<TtsWorkerInbound, TtsWorkerOutbound> = spawnTtsWorker) {
		this.#spawnWorker = spawnWorker;
	}

	onProgress(listener: (event: TtsProgressEvent) => void): () => void {
		this.#progressListeners.add(listener);
		return () => this.#progressListeners.delete(listener);
	}

	async synthesize(modelKey: string, text: string, options: TtsSynthesizeOptions = {}): Promise<TtsAudio | null> {
		if (!isTtsLocalModelKey(modelKey)) return null;
		if (options.signal?.aborted) return null;

		try {
			const worker = this.#ensureWorker();
			const id = String(++this.#nextRequestId);
			const { promise, resolve } = Promise.withResolvers<TtsAudio | null>();
			this.#addPending(id, { kind: "synthesize", modelKey, resolve });
			const abort = (): void => {
				const pending = this.#pending.get(id);
				if (pending?.kind !== "synthesize") return;
				this.#deletePending(id);
				pending.resolve(null);
			};
			options.signal?.addEventListener("abort", abort, { once: true });
			try {
				const request: TtsWorkerInbound = options.voice
					? { type: "synthesize", id, modelKey, text, voice: options.voice }
					: { type: "synthesize", id, modelKey, text };
				worker.send(request);
				return await promise;
			} finally {
				options.signal?.removeEventListener("abort", abort);
				this.#deletePending(id);
			}
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
	 * cannot spawn.
	 */
	synthesizeStream(modelKey: string, options: TtsStreamOptions = {}): TtsStreamHandle {
		if (!isTtsLocalModelKey(modelKey) || options.signal?.aborted) {
			const channel = new AudioChunkChannel();
			channel.close();
			return { push: () => {}, end: () => {}, chunks: channel.iterator() };
		}

		let worker: RefCountedWorkerHandle<TtsWorkerInbound, TtsWorkerOutbound>;
		try {
			worker = this.#ensureWorker();
		} catch (error) {
			logger.debug("tts: stream synthesis failed to start", {
				modelKey,
				error: error instanceof Error ? error.message : String(error),
			});
			const channel = new AudioChunkChannel();
			channel.fail(error instanceof Error ? error : new Error(String(error)));
			return { push: () => {}, end: () => {}, chunks: channel.iterator() };
		}

		const id = String(++this.#nextRequestId);
		const signal = options.signal;
		let closed = false;
		let ended = false;
		const abort = (): void => {
			if (closed) return;
			closed = true;
			ended = true;
			if (!this.#pending.has(id)) return;
			this.#deletePending(id);
			worker.send({ type: "stream-cancel", id });
			channel.close();
		};
		const channel = new AudioChunkChannel(() => signal?.removeEventListener("abort", abort));
		this.#addPending(id, { kind: "stream", modelKey, channel });
		signal?.addEventListener("abort", abort, { once: true });

		const start: TtsWorkerInbound = options.voice
			? { type: "stream-start", id, modelKey, voice: options.voice }
			: { type: "stream-start", id, modelKey };
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
		if (options.signal?.aborted) return false;

		const unsubscribe = options.onProgress ? this.onProgress(options.onProgress) : undefined;
		try {
			const worker = this.#ensureWorker();
			const id = String(++this.#nextRequestId);
			const { promise, resolve } = Promise.withResolvers<boolean>();
			this.#addPending(id, { kind: "download", modelKey, resolve });
			const abort = (): void => {
				const pending = this.#pending.get(id);
				if (pending?.kind !== "download") return;
				this.#deletePending(id);
				pending.resolve(false);
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
			logger.debug("tts: local model download failed", {
				modelKey,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
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
			if (pending.kind === "synthesize") pending.resolve(null);
			else if (pending.kind === "download") pending.resolve(false);
			else pending.channel.close();
		}
		this.#pending.clear();
		this.#refed = false;
		try {
			await worker?.terminate();
		} catch {
			// Already gone.
		}
	}

	#ensureWorker(): RefCountedWorkerHandle<TtsWorkerInbound, TtsWorkerOutbound> {
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
	 * The TTS subprocess is spawned `unref`'d so an idle worker never blocks
	 * process exit. A short-lived CLI command (`omp say`) awaiting a request would
	 * otherwise let the event loop drain and exit before the audio arrives, so we
	 * `ref` the worker exactly while at least one request is pending.
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

	#handleMessage(message: TtsWorkerOutbound): void {
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

		this.#deletePending(message.id);
		if (message.type === "stream-done") {
			if (pending.kind === "stream") pending.channel.close();
			return;
		}
		if (message.type === "audio") {
			if (pending.kind === "synthesize") pending.resolve({ pcm: message.pcm, sampleRate: message.sampleRate });
			return;
		}
		if (message.type === "downloaded") {
			if (pending.kind === "download") pending.resolve(true);
			return;
		}
		logger.debug("tts: worker returned error", { error: message.error });
		this.#emitProgress({ modelKey: pending.modelKey, status: "error" });
		if (pending.kind === "synthesize") pending.resolve(null);
		else if (pending.kind === "download") pending.resolve(false);
		else pending.channel.fail(new Error(message.error));
		void this.terminate();
	}

	#emitProgress(event: TtsProgressEvent): void {
		for (const listener of this.#progressListeners) listener(event);
	}

	#handleWorkerError(error: Error): void {
		logger.warn("tts: worker error", { error: error.message });
		for (const pending of this.#pending.values()) {
			this.#emitProgress({ modelKey: pending.modelKey, status: "error" });
			if (pending.kind === "synthesize") pending.resolve(null);
			else if (pending.kind === "download") pending.resolve(false);
			else pending.channel.fail(error);
		}
		this.#pending.clear();
		void this.terminate();
	}
}

export const ttsClient = new TtsClient();

export async function shutdownTtsClient(): Promise<void> {
	await ttsClient.terminate();
}

export async function smokeTestTtsWorker({
	timeoutMs = SMOKE_TEST_TIMEOUT_MS,
}: {
	timeoutMs?: number;
} = {}): Promise<void> {
	await smokeTestWorker(wrapSubprocess(createTtsSubprocess()), "tts worker", timeoutMs);
}
