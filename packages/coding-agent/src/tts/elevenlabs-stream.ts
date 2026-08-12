/**
 * ElevenLabs live streaming synthesis, implementing the same
 * {@link TtsStreamHandle} contract as the local Kokoro worker
 * ({@link ttsClient.synthesizeStream}) so {@link Vocalizer} can use either
 * backend interchangeably.
 *
 * Text is split into sentences client-side as it is pushed; each complete
 * sentence fires its own ElevenLabs `/text-to-speech/{voice}/stream` request
 * immediately (requests run concurrently, not queued one-after-another), and
 * results are reordered back into arrival-index order before being handed to
 * the player — so a slow sentence never blocks a faster later one from being
 * *fetched*, but playback still hears them in the right order.
 *
 * Each request currently reads its full response body before converting to
 * PCM and emitting one chunk per sentence (not sub-sentence byte streaming).
 * That still gives most of the latency win over "wait for the whole
 * utterance" — later work could stream partial PCM within a single sentence
 * for the remainder.
 *
 * Requires `output_format=pcm_24000`, which needs a paid ElevenLabs plan; a
 * 4xx here surfaces as a normal synthesis failure (caller/Vocalizer already
 * swallow-and-log those, matching the local backend's failure contract).
 */
import {
	DEFAULT_ELEVENLABS_MODEL_ID,
	DEFAULT_ELEVENLABS_VOICE_ID,
	ELEVENLABS_PCM_SAMPLE_RATE,
	ohMyPkElevenLabsUserAgent,
	resolveElevenLabsBaseUrl,
} from "../lib/elevenlabs-http";
import type { TtsAudioChunk, TtsStreamHandle } from "./tts-client";

export interface OpenElevenLabsStreamOptions {
	apiKey: string;
	voiceId?: string;
	modelId?: string;
	baseUrl?: string;
	signal?: AbortSignal;
}

/** Grabs a full sentence (including its terminator) or a forced line break. */
const SENTENCE_BOUNDARY = /[^.!?\n]*[.!?\n]+/g;
/** Caps a single synthesis request so one runaway unterminated sentence can't stall the pipeline. */
const MAX_SENTENCE_CHARS = 2_000;

/**
 * Single-producer/single-consumer async queue, mirroring the contract of the
 * (unexported) worker-backed channel in `tts-client.ts`: chunks pushed while
 * no consumer is awaiting are buffered in order; `close` ends the iterator
 * cleanly; `fail` ends it by throwing from the in-flight or next `next()`.
 */
class OrderedChunkQueue {
	#buffer: TtsAudioChunk[] = [];
	#waiting: Array<{
		resolve: (result: IteratorResult<TtsAudioChunk>) => void;
		reject: (error: Error) => void;
	}> = [];
	#closed = false;
	#error: Error | null = null;

	push(chunk: TtsAudioChunk): void {
		if (this.#closed) return;
		const waiter = this.#waiting.shift();
		if (waiter) {
			waiter.resolve({ value: chunk, done: false });
			return;
		}
		this.#buffer.push(chunk);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const waiter of this.#waiting.splice(0)) waiter.resolve({ value: undefined, done: true });
	}

	fail(error: Error): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#error = error;
		for (const waiter of this.#waiting.splice(0)) waiter.reject(error);
	}

	iterator(): AsyncIterableIterator<TtsAudioChunk> {
		const queue = this;
		return {
			[Symbol.asyncIterator]() {
				return this;
			},
			next(): Promise<IteratorResult<TtsAudioChunk>> {
				const buffered = queue.#buffer.shift();
				if (buffered) return Promise.resolve({ value: buffered, done: false });
				if (queue.#closed) {
					if (queue.#error) return Promise.reject(queue.#error);
					return Promise.resolve({ value: undefined, done: true });
				}
				const { promise, resolve, reject } = Promise.withResolvers<IteratorResult<TtsAudioChunk>>();
				queue.#waiting.push({ resolve, reject });
				return promise;
			},
		};
	}
}

/** Converts little-endian signed 16-bit PCM bytes (ElevenLabs' `pcm_24000` format) to mono Float32 in [-1, 1]. */
function pcm16BytesToFloat32(bytes: Uint8Array): Float32Array {
	const sampleCount = Math.floor(bytes.length / 2);
	const pcm = new Float32Array(sampleCount);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	for (let i = 0; i < sampleCount; i++) pcm[i] = view.getInt16(i * 2, true) / 32_768;
	return pcm;
}

class ElevenLabsStreamSession implements TtsStreamHandle {
	#queue = new OrderedChunkQueue();
	#buffer = "";
	#nextIndex = 0;
	#nextEmitIndex = 0;
	#pendingResults = new Map<number, TtsAudioChunk>();
	#inFlight = new Set<Promise<void>>();
	#ended = false;
	#apiKey: string;
	#baseUrl: string;
	#voiceId: string;
	#modelId: string;
	#signal: AbortSignal | undefined;

	constructor(options: OpenElevenLabsStreamOptions) {
		this.#apiKey = options.apiKey;
		this.#baseUrl = options.baseUrl || resolveElevenLabsBaseUrl();
		this.#voiceId = options.voiceId || DEFAULT_ELEVENLABS_VOICE_ID;
		this.#modelId = options.modelId || DEFAULT_ELEVENLABS_MODEL_ID;
		this.#signal = options.signal;
		this.#signal?.addEventListener("abort", () => this.#queue.close(), { once: true });
	}

	push(text: string): void {
		if (this.#ended || this.#signal?.aborted || !text) return;
		this.#buffer += text;
		this.#drainCompleteSentences();
	}

	end(): void {
		if (this.#ended) return;
		this.#ended = true;
		const trailing = this.#buffer.trim();
		this.#buffer = "";
		if (trailing) this.#enqueueSentence(trailing);
		void this.#awaitAllThenClose();
	}

	get chunks(): AsyncIterableIterator<TtsAudioChunk> {
		return this.#queue.iterator();
	}

	#drainCompleteSentences(): void {
		SENTENCE_BOUNDARY.lastIndex = 0;
		let consumed = 0;
		let match: RegExpExecArray | null = SENTENCE_BOUNDARY.exec(this.#buffer);
		while (match !== null) {
			if (match.index !== consumed) break; // defensive: boundary regex should never skip text
			const sentence = match[0];
			consumed += sentence.length;
			const trimmed = sentence.trim();
			if (trimmed) this.#enqueueSentence(trimmed);
			match = SENTENCE_BOUNDARY.exec(this.#buffer);
		}
		this.#buffer = this.#buffer.slice(consumed);
	}

	#enqueueSentence(text: string): void {
		const index = this.#nextIndex++;
		const bounded = text.length > MAX_SENTENCE_CHARS ? text.slice(0, MAX_SENTENCE_CHARS) : text;
		const task = this.#synthesizeSentence(index, bounded)
			.then(chunk => {
				this.#pendingResults.set(index, chunk);
				this.#drainOrderedResults();
			})
			.catch((error: unknown) => {
				this.#queue.fail(error instanceof Error ? error : new Error(String(error)));
			});
		this.#inFlight.add(task);
		void task.finally(() => this.#inFlight.delete(task));
	}

	async #synthesizeSentence(index: number, text: string): Promise<TtsAudioChunk> {
		const url = `${this.#baseUrl}/text-to-speech/${encodeURIComponent(this.#voiceId)}/stream?output_format=pcm_24000`;
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"xi-api-key": this.#apiKey,
				"Content-Type": "application/json",
				"User-Agent": ohMyPkElevenLabsUserAgent(),
			},
			body: JSON.stringify({ text, model_id: this.#modelId }),
			signal: this.#signal,
		});
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			throw new Error(`ElevenLabs TTS stream failed (${response.status}): ${detail.slice(0, 300)}`);
		}
		const bytes = new Uint8Array(await response.arrayBuffer());
		return { index, text, pcm: pcm16BytesToFloat32(bytes), sampleRate: ELEVENLABS_PCM_SAMPLE_RATE };
	}

	#drainOrderedResults(): void {
		let next = this.#pendingResults.get(this.#nextEmitIndex);
		while (next) {
			this.#pendingResults.delete(this.#nextEmitIndex);
			this.#queue.push(next);
			this.#nextEmitIndex++;
			next = this.#pendingResults.get(this.#nextEmitIndex);
		}
	}

	async #awaitAllThenClose(): Promise<void> {
		// Safe as a single snapshot: `#ended` blocks new sentences from being
		// enqueued after `end()`, so `#inFlight` only shrinks from here.
		await Promise.all(this.#inFlight);
		this.#drainOrderedResults();
		this.#queue.close();
	}
}

/**
 * Open a live ElevenLabs streaming-synthesis session. Mirrors
 * `ttsClient.synthesizeStream`'s contract exactly so {@link Vocalizer} can
 * swap backends without touching its playback loop. Returns an inert handle
 * (immediately-ended `chunks`) for an already-aborted signal.
 */
export function openElevenLabsStream(options: OpenElevenLabsStreamOptions): TtsStreamHandle {
	if (options.signal?.aborted) {
		const queue = new OrderedChunkQueue();
		queue.close();
		return { push: () => {}, end: () => {}, chunks: queue.iterator() };
	}
	const session = new ElevenLabsStreamSession(options);
	return { push: text => session.push(text), end: () => session.end(), chunks: session.chunks };
}
