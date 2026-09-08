/**
 * Shared Content-Length message framing for the JSON byte streams spoken by the
 * LSP and DAP stdio clients. Both protocols use the same base-protocol framing:
 * each message is a `Content-Length: <n>\r\n\r\n` header block followed by `<n>`
 * bytes of UTF-8 JSON. This module owns the incremental decode so the two
 * clients don't each reimplement chunk accumulation, header scanning, and the
 * mid-message remainder handoff.
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

/** Copy the byte range [from, to) out of the pending chunk list into one Buffer. */
function copyChunkRange(chunks: Buffer[], from: number, to: number): Buffer {
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
 * message is framed — concatenating the accumulator on every read is O(n^2) for
 * messages that span many reads (e.g. a large initial diagnostics burst). Feed
 * raw chunks with {@link push}, pull every complete message with {@link drain},
 * and persist {@link remainder} when the reader stops so a restarted reader
 * resumes mid-message.
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

	/** Seed the buffer with any unparsed remainder left by a previous reader. */
	constructor(seed: Buffer) {
		this.push(seed);
	}

	/** Append a freshly read chunk to the pending buffer. */
	push(chunk: Buffer): void {
		if (this.#failure) throw this.#failure;
		if (chunk.length === 0) return;
		this.#pendingChunks.push(chunk);
		this.#pendingLen += chunk.length;
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
				const headerText = MESSAGE_DECODER.decode(copyChunkRange(this.#pendingChunks, 0, headerEnd));
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
			const text = MESSAGE_DECODER.decode(copyChunkRange(this.#pendingChunks, this.#messageStart, messageEnd));
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
