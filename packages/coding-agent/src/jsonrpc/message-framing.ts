/**
 * Shared Content-Length message framing for the JSON byte streams spoken by the
 * LSP and DAP stdio clients. Both protocols use the same base-protocol framing:
 * each message is a `Content-Length: <n>\r\n\r\n` header block followed by `<n>`
 * bytes of UTF-8 JSON. This module owns both directions so the LSP, DAP, and
 * LSP-mux transports don't each reimplement header encoding, chunk accumulation,
 * header scanning, and the mid-message remainder handoff.
 */

// Reused for all full (non-streaming) decodes; each decode() resets state, so a
// single instance is safe and avoids per-message TextDecoder allocation.
const MESSAGE_DECODER = new TextDecoder("utf-8");
const HEADER_TERMINATOR = [13, 10, 13, 10];

// Headers carry a length and optional content type; bodies can contain entire
// source files, workspace diagnostics, or base64 debugger memory responses.
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_CONTENT_BYTES = 256 * 1024 * 1024;

export class MessageFramingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MessageFramingError";
	}
}

/**
 * Encode one JSON-RPC message as a complete Content-Length frame.
 *
 * The body is UTF-8 encoded exactly once, straight into the frame buffer, so a
 * whole-document `didOpen`/`didChange` is not re-encoded or concatenated by the
 * sink. The returned buffer is never mutated afterwards; it is safe to write the
 * same frame to several sockets.
 */
export function encodeMessageFrame(message: unknown): Buffer {
	const json = JSON.stringify(message);
	const bodyLength = Buffer.byteLength(json, "utf8");
	const header = `Content-Length: ${bodyLength}\r\n\r\n`;
	const frame = Buffer.allocUnsafe(header.length + bodyLength);
	frame.write(header, 0, "latin1");
	frame.write(json, header.length, "utf8");
	return frame;
}

/**
 * Bytes [from, to) of the pending chunk list. A range inside the first chunk is
 * returned as a zero-copy view; only a range spanning chunks is copied out.
 */
function chunkRange(chunks: Buffer[], from: number, to: number): Buffer {
	const first = chunks[0];
	if (to <= first.length) return first.subarray(from, to);
	const out = Buffer.allocUnsafe(to - from);
	let global = 0;
	let written = 0;
	for (const chunk of chunks) {
		const chunkEnd = global + chunk.length;
		if (chunkEnd > from && global < to) {
			const start = Math.max(from, global) - global;
			const end = Math.min(to, chunkEnd) - global;
			chunk.copy(out, written, start, end);
			written += end - start;
		}
		global = chunkEnd;
		if (global >= to) break;
	}
	return out;
}

/**
 * Incremental Content-Length frame decoder for a JSON message byte stream.
 *
 * Incoming bytes are buffered as a list of chunks and only joined when a full
 * message spans several of them — concatenating the accumulator on every read
 * is O(n^2) for messages that span many reads (e.g. a large initial diagnostics
 * burst). Feed raw chunks with {@link push} and pull every complete message with
 * {@link drain}; {@link remainder} hands unconsumed bytes to another reader.
 */
export class MessageFramer {
	readonly #pendingChunks: Buffer[] = [];
	#pendingLen = 0;
	#scanChunk = 0;
	#scanOffset = 0;
	#scanned = 0;
	#matched = 0;
	#messageStart = 0;
	#contentLength: number | undefined;
	#failure: MessageFramingError | undefined;

	/** Seed the buffer with bytes already read from the stream (e.g. a handshake leftover). */
	constructor(seed: Uint8Array) {
		this.push(seed);
	}

	/**
	 * Append a freshly read chunk to the pending buffer. The bytes are retained
	 * as a zero-copy view until consumed, so callers must not reuse or mutate
	 * the chunk after pushing it.
	 */
	push(chunk: Uint8Array): void {
		if (this.#failure) throw this.#failure;
		if (chunk.byteLength === 0) return;
		this.#pendingChunks.push(
			Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength),
		);
		this.#pendingLen += chunk.byteLength;
	}

	/**
	 * Yield the JSON text of every complete message currently buffered. A header
	 * block without a `Content-Length` is non-protocol noise (e.g. a server
	 * printing to stdout); `onResync` is invoked with the offending header text
	 * and the framer drops past the bogus terminator to recover instead of
	 * stalling on the same junk header forever.
	 */
	*drain(onResync: (headerText: string) => void): Generator<string> {
		if (this.#failure) throw this.#failure;
		while (true) {
			if (this.#contentLength === undefined) {
				const headerEnd = this.#findHeaderEnd();
				if (headerEnd === -1) break;
				const headerText = MESSAGE_DECODER.decode(chunkRange(this.#pendingChunks, 0, headerEnd));
				const lengths = [...headerText.matchAll(/^Content-Length:[ \t]*([^\r\n]*)$/gim)];
				if (lengths.length === 0) {
					this.#dropFront(headerEnd + 4);
					onResync(headerText);
					continue;
				}
				const rawLength = lengths[0][1].trim();
				if (lengths.length !== 1 || !/^\d+$/.test(rawLength)) {
					this.#fail("Invalid or duplicate JSON-RPC Content-Length");
				}
				const contentLength = Number(rawLength);
				if (!Number.isSafeInteger(contentLength) || contentLength > MAX_CONTENT_BYTES) {
					this.#fail(`JSON-RPC Content-Length exceeds ${MAX_CONTENT_BYTES}-byte limit`);
				}
				this.#contentLength = contentLength;
				this.#messageStart = headerEnd + 4;
			}

			const messageEnd = this.#messageStart + this.#contentLength;
			if (this.#pendingLen < messageEnd) break;
			const text = MESSAGE_DECODER.decode(chunkRange(this.#pendingChunks, this.#messageStart, messageEnd));
			this.#dropFront(messageEnd);
			yield text;
		}
	}

	#findHeaderEnd(): number {
		while (this.#scanChunk < this.#pendingChunks.length) {
			const chunk = this.#pendingChunks[this.#scanChunk];
			while (this.#scanOffset < chunk.length) {
				const byte = chunk[this.#scanOffset++];
				this.#scanned++;
				this.#matched = byte === HEADER_TERMINATOR[this.#matched] ? this.#matched + 1 : byte === 13 ? 1 : 0;
				if (this.#matched === 4) return this.#scanned - 4;
				if (this.#scanned >= MAX_HEADER_BYTES) {
					this.#fail(`JSON-RPC header exceeds ${MAX_HEADER_BYTES}-byte limit`);
				}
			}
			this.#scanChunk++;
			this.#scanOffset = 0;
		}
		return -1;
	}

	#dropFront(count: number): void {
		let consumed = 0;
		let remaining = count;
		while (consumed < this.#pendingChunks.length && this.#pendingChunks[consumed].length <= remaining) {
			remaining -= this.#pendingChunks[consumed++].length;
		}
		this.#pendingChunks.splice(0, consumed);
		if (remaining > 0) this.#pendingChunks[0] = this.#pendingChunks[0].subarray(remaining);
		this.#pendingLen -= count;
		this.#scanChunk = 0;
		this.#scanOffset = 0;
		this.#scanned = 0;
		this.#matched = 0;
		this.#messageStart = 0;
		this.#contentLength = undefined;
	}

	#fail(message: string): never {
		this.#pendingChunks.length = 0;
		this.#pendingLen = 0;
		this.#failure = new MessageFramingError(message);
		throw this.#failure;
	}

	/** Includes the current header so another reader can resume mid-body. */
	remainder(): Buffer {
		return this.#pendingChunks.length === 0
			? Buffer.alloc(0)
			: this.#pendingChunks.length === 1
				? this.#pendingChunks[0]
				: Buffer.concat(this.#pendingChunks, this.#pendingLen);
	}
}
