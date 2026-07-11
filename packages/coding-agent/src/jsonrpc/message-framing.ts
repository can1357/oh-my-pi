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

/**
 * Locate the `\r\n\r\n` header terminator across the pending chunk list.
 * Returns the absolute byte index of the first `\r`, or -1 when not present.
 * Equivalent to scanning the contiguous concatenation of the chunks.
 */
function findHeaderEndInChunks(chunks: Buffer[]): number {
	let global = 0;
	let b0 = -1;
	let b1 = -1;
	let b2 = -1;
	for (const chunk of chunks) {
		for (let i = 0; i < chunk.length; i++) {
			const b3 = chunk[i];
			if (b0 === 13 && b1 === 10 && b2 === 13 && b3 === 10) {
				return global - 3;
			}
			b0 = b1;
			b1 = b2;
			b2 = b3;
			global++;
		}
	}
	return -1;
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

/** Drop the first `count` bytes from the pending chunk list in place. */
function dropChunkFront(chunks: Buffer[], count: number): void {
	let removed = 0;
	while (chunks.length > 0) {
		const head = chunks[0];
		if (removed + head.length <= count) {
			removed += head.length;
			chunks.shift();
		} else {
			chunks[0] = head.subarray(count - removed);
			break;
		}
	}
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

	/** Seed the buffer with any unparsed remainder left by a previous reader. */
	constructor(seed: Buffer) {
		if (seed.length > 0) {
			this.#pendingChunks.push(seed);
			this.#pendingLen = seed.length;
		}
	}

	/** Append a freshly read chunk to the pending buffer. */
	push(chunk: Buffer): void {
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
		while (true) {
			const headerEnd = findHeaderEndInChunks(this.#pendingChunks);
			if (headerEnd === -1) break;

			const headerText = MESSAGE_DECODER.decode(copyChunkRange(this.#pendingChunks, 0, headerEnd));
			const contentLengthMatch = headerText.match(/Content-Length: (\d+)/i);
			if (!contentLengthMatch) {
				onResync(headerText);
				dropChunkFront(this.#pendingChunks, headerEnd + 4);
				this.#pendingLen -= headerEnd + 4;
				continue;
			}

			const contentLength = Number.parseInt(contentLengthMatch[1], 10);
			const messageStart = headerEnd + 4; // Skip \r\n\r\n
			const messageEnd = messageStart + contentLength;
			if (this.#pendingLen < messageEnd) break;

			const messageText = MESSAGE_DECODER.decode(copyChunkRange(this.#pendingChunks, messageStart, messageEnd));
			dropChunkFront(this.#pendingChunks, messageEnd);
			this.#pendingLen -= messageEnd;
			yield messageText;
		}
	}

	/** The unparsed remainder, to persist when the reader stops. */
	remainder(): Buffer {
		return this.#pendingChunks.length === 0
			? Buffer.alloc(0)
			: this.#pendingChunks.length === 1
				? this.#pendingChunks[0]
				: Buffer.concat(this.#pendingChunks, this.#pendingLen);
	}
}
