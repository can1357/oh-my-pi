const trailingEvents = new WeakSet<ServerSentEvent>();

import { abortableSource } from "./abortable";
import { parseStreamingJson } from "./json-parse";

const LF = 0x0a;
type JsonlChunkResult = {
	values: unknown[];
	error: unknown;
	read: number;
	done: boolean;
};

function parseJsonlChunkCompat(input: Uint8Array, beg?: number, end?: number): JsonlChunkResult;
function parseJsonlChunkCompat(input: string): JsonlChunkResult;
function parseJsonlChunkCompat(input: Uint8Array | string, beg?: number, end?: number): JsonlChunkResult {
	if (typeof input === "string") {
		const { values, error, read, done } = Bun.JSONL.parseChunk(input);
		return { values, error, read, done };
	}
	const start = beg ?? 0;
	const stop = end ?? input.length;
	const { values, error, read, done } = Bun.JSONL.parseChunk(input, start, stop);
	return { values, error, read, done };
}

export async function* readLines(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
	const buffer = new ConcatSink();
	const source = abortableSource(stream, signal);
	try {
		for await (const chunk of source) {
			for (const line of buffer.appendAndFlushLines(chunk)) {
				yield line;
			}
		}
		if (!buffer.isEmpty) {
			const tail = buffer.flush();
			if (tail) {
				buffer.clear();
				yield tail;
			}
		}
	} catch (err) {
		// Abort errors are expected — just stop the generator.
		if (signal?.aborted) return;
		throw err;
	}
}

export async function* readJsonl<T>(stream: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<T> {
	const buffer = new ConcatSink();
	const source = abortableSource(stream, signal);
	try {
		for await (const chunk of source) {
			yield* buffer.pullJSONL<T>(chunk, 0, chunk.length);
		}
		if (!buffer.isEmpty) {
			const tail = buffer.flush();
			if (tail) {
				buffer.clear();
				const { values, error, done } = parseJsonlChunkCompat(tail, 0, tail.length);
				if (values.length > 0) {
					yield* values as T[];
				}
				if (error) throw error;
				if (!done) {
					throw new Error("JSONL stream ended unexpectedly");
				}
			}
		}
	} catch (err) {
		// Abort errors are expected — just stop the generator.
		if (signal?.aborted) return;
		throw err;
	}
}

// =============================================================================
// SSE (Server-Sent Events)
// =============================================================================

class ConcatSink {
	#space?: Buffer;
	#length = 0;

	#ensureCapacity(size: number): Buffer {
		const space = this.#space;
		if (space && space.length >= size) return space;
		const nextSize = space ? Math.max(size, space.length * 2) : size;
		const next = Buffer.allocUnsafe(nextSize);
		if (space && this.#length > 0) {
			space.copy(next, 0, 0, this.#length);
		}
		this.#space = next;
		return next;
	}

	append(chunk: Uint8Array) {
		const n = chunk.length;
		if (!n) return;
		const offset = this.#length;
		const space = this.#ensureCapacity(offset + n);
		space.set(chunk, offset);
		this.#length += n;
	}

	reset(chunk: Uint8Array) {
		const n = chunk.length;
		if (!n) {
			this.#length = 0;
			return;
		}
		const space = this.#ensureCapacity(n);
		space.set(chunk, 0);
		this.#length = n;
	}

	get isEmpty(): boolean {
		return this.#length === 0;
	}

	flush(): Uint8Array | undefined {
		if (!this.#length) return undefined;
		return this.#space!.subarray(0, this.#length);
	}

	clear() {
		this.#length = 0;
	}

	*appendAndFlushLines(chunk: Uint8Array) {
		let pos = 0;
		while (pos < chunk.length) {
			const nl = chunk.indexOf(LF, pos);
			if (nl === -1) {
				this.append(chunk.subarray(pos));
				return;
			}
			const suffix = chunk.subarray(pos, nl);
			pos = nl + 1;
			if (this.isEmpty) {
				yield suffix;
			} else {
				this.append(suffix);
				const payload = this.flush();
				if (payload) {
					yield payload;
					this.clear();
				}
			}
		}
	}
	*pullJSONL<T>(chunk: Uint8Array, beg: number, end: number) {
		if (this.isEmpty) {
			const { values, error, read, done } = parseJsonlChunkCompat(chunk, beg, end);
			if (values.length > 0) {
				yield* values as T[];
			}
			if (error) throw error;
			if (done) return;
			this.reset(chunk.subarray(read, end));
			return;
		}

		const offset = this.#length;
		const n = end - beg;
		const total = offset + n;
		const space = this.#ensureCapacity(total);
		space.set(chunk.subarray(beg, end), offset);
		this.#length = total;

		const { values, error, read, done } = parseJsonlChunkCompat(space.subarray(0, total), 0, total);
		if (values.length > 0) {
			yield* values as T[];
		}
		if (error) throw error;
		if (done) {
			this.#length = 0;
			return;
		}
		const rem = total - read;
		if (rem < total) {
			space.copyWithin(0, read, total);
		}
		this.#length = rem;
	}
}

/**
 * Stream parsed JSON objects from SSE `data:` lines.
 *
 * Thin wrapper over {@link readSseEvents}: yields one parsed JSON value per
 * dispatched SSE event, skipping events with empty `data` and stopping at the
 * OpenAI-style `[DONE]` sentinel. If your consumer doesn't care about `event:`
 * names or doesn't need a custom parse step, use this; otherwise call
 * `readSseEvents` directly.
 *
 * @example
 * ```ts
 * for await (const obj of readSseJson(response.body!)) {
 *   console.log(obj);
 * }
 * ```
 */
export type SseEventObserver = (event: ServerSentEvent) => void;

function notifySseEventObserver(observer: SseEventObserver | undefined, event: ServerSentEvent): void {
	if (!observer) return;
	try {
		observer(event);
	} catch {
		// Diagnostic observers must never perturb provider stream consumption.
	}
}

function isRecoverableTrailingJson(data: string): boolean {
	const first = data.trimStart()[0];
	if (first !== "{" && first !== "[") return false;
	// Best-effort relaxed recovery via the shared streaming JSON parser: a
	// container-shaped final event that fails strict `JSON.parse` is treated as a
	// cut-off (or lightly malformed) stream tail and ends iteration cleanly instead
	// of throwing. Non-container final events (plain-text errors, bare scalars) are
	// not recoverable and still surface as a SyntaxError.
	const recovered = parseStreamingJson<unknown>(data);
	return typeof recovered === "object" && recovered !== null;
}

export async function* readSseJson<T>(
	stream: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
	onEvent?: SseEventObserver,
): AsyncGenerator<T> {
	for await (const sse of readSseEvents(stream, signal)) {
		const isTrailing = trailingEvents.has(sse);
		notifySseEventObserver(onEvent, sse);
		const data = sse.data;
		if (data === "" || data === "[DONE]") {
			if (data === "[DONE]") return;
			continue;
		}
		try {
			yield JSON.parse(data) as T;
		} catch (err) {
			if (err instanceof SyntaxError && isTrailing && isRecoverableTrailingJson(data)) {
				return;
			}
			throw err;
		}
	}
}

/**
 * A single Server-Sent Event dispatched on a blank-line boundary.
 *
 * - `event` is the value of the most recent `event:` field, or `null` if none.
 * - `data` is the concatenation (joined by `\n`) of every `data:` field in the
 *   event, exactly as required by the SSE spec.
 * - `raw` is the list of decoded non-empty lines that made up the event,
 *   preserved for diagnostic context (error reporting, debugging). The
 *   dispatching blank line is not included.
 */
export interface ServerSentEvent {
	event: string | null;
	data: string;
	raw: string[];
}

interface SseEventState {
	event: string | null;
	// `data` accumulates across multiple `data:` lines per the SSE spec, joined
	// by `\n`. We keep the running string here and append as lines arrive instead
	// of buffering an array and joining at flush. `null` means "no data: field
	// seen yet" (distinct from a `data:` field with an empty value).
	data: string | null;
	raw: string[];
}

// Single decoder reused for all line decodes. Safe because lines are split on
// LF (0x0a) which is always a single-byte ASCII char in UTF-8 and never appears
// inside a multi-byte sequence — so each line is itself a complete UTF-8 run.
const SSE_LINE_DECODER = new TextDecoder("utf-8");

function decodeSseLineBytes(line: Uint8Array, end: number): string {
	return end === line.length ? SSE_LINE_DECODER.decode(line) : SSE_LINE_DECODER.decode(line.subarray(0, end));
}

function flushSseEvent(state: SseEventState): ServerSentEvent | null {
	if (state.event === null && state.data === null) {
		state.raw = [];
		return null;
	}
	const event: ServerSentEvent = {
		event: state.event,
		data: state.data ?? "",
		raw: state.raw,
	};
	state.event = null;
	state.data = null;
	state.raw = [];
	return event;
}

function pushSseLine(line: Uint8Array, state: SseEventState): ServerSentEvent | null {
	// `appendAndFlushLines` splits on LF only; strip a trailing CR so CRLF sources
	// don't leak `\r` into field values.
	let end = line.length;
	if (end > 0 && line[end - 1] === 0x0d /* '\r' */) end--;
	if (end === 0) return flushSseEvent(state);

	// Comment line: keep in `raw` for diagnostic context, skip parsing.
	if (line[0] === 0x3a /* ':' */) {
		state.raw.push(decodeSseLineBytes(line, end));
		return null;
	}

	const text = decodeSseLineBytes(line, end);
	state.raw.push(text);

	const colon = text.indexOf(":");
	const fieldName = colon === -1 ? text : text.slice(0, colon);
	let value = colon === -1 ? "" : text.slice(colon + 1);
	if (value.charCodeAt(0) === 0x20 /* ' ' */) value = value.slice(1);

	if (fieldName === "event") {
		state.event = value;
	} else if (fieldName === "data") {
		if (state.data === null) {
			state.data = value;
		} else {
			state.data += "\n";
			state.data += value;
		}
	}
	// `id` and `retry` are intentionally ignored — the providers we consume
	// don't use them, and the underlying transport handles reconnects itself.
	return null;
}

/**
 * Stream raw Server-Sent Events from an HTTP response body.
 *
 * Yields one `ServerSentEvent` per blank-line dispatch. The consumer is
 * responsible for parsing `data` (e.g. JSON, plain text, error envelope).
 * Use `readSseJson` instead when every event is a single `data:` JSON object
 * and you don't need access to the `event:` field.
 *
 * Internally backed by a Buffer-based line reader (`ConcatSink`) so chunk
 * concatenation is O(n) and never triggers per-line string slicing of the
 * accumulated buffer.
 *
 * @example
 * ```ts
 * for await (const sse of readSseEvents(response.body!)) {
 *   if (sse.event === "ping") continue;
 *   const obj = JSON.parse(sse.data);
 * }
 * ```
 */
export async function* readSseEvents(
	stream: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<ServerSentEvent> {
	const lineBuffer = new ConcatSink();
	const state: SseEventState = { event: null, data: null, raw: [] };
	const source = abortableSource(stream, signal);
	try {
		for await (const chunk of source) {
			for (const line of lineBuffer.appendAndFlushLines(chunk)) {
				const event = pushSseLine(line, state);
				if (event) yield event;
			}
		}
		// Treat any trailing partial line (no terminating LF) as a complete line.
		if (!lineBuffer.isEmpty) {
			const tail = lineBuffer.flush();
			if (tail) {
				lineBuffer.clear();
				const event = pushSseLine(tail, state);
				if (event) {
					trailingEvents.add(event);
					yield event;
				}
			}
		}
		// Real services don't always close on a blank line — flush any pending event.
		const trailing = flushSseEvent(state);
		if (trailing) {
			trailingEvents.add(trailing);
			yield trailing;
		}
	} catch (err) {
		if (signal?.aborted) return;
		throw err;
	}
}

/**
 * Parse a complete JSONL string, skipping malformed lines instead of throwing.
 *
 * Uses `Bun.JSONL.parseChunk` internally. On parse errors, the malformed
 * region is skipped up to the next newline and parsing continues.
 *
 * @example
 * ```ts
 * const entries = parseJsonlLenient<MyType>(fileContents);
 * ```
 */
export function parseJsonlLenient<T>(buffer: string): T[] {
	let entries: T[] | undefined;

	while (buffer.length > 0) {
		const { values, error, read, done } = parseJsonlChunkCompat(buffer);
		if (values.length > 0) {
			const ext = values as T[];
			if (!entries) {
				entries = ext;
			} else {
				entries.push(...ext);
			}
		}
		if (error) {
			const nextNewline = buffer.indexOf("\n", read);
			if (nextNewline === -1) break;
			buffer = buffer.substring(nextNewline + 1);
			continue;
		}
		if (read === 0) break;
		buffer = buffer.substring(read);
		if (done) break;
	}
	return entries ?? [];
}
