/**
 * Connect-protocol streaming envelope shared by the Cursor and Devin
 * transports: 1 flag byte + 4-byte big-endian payload length + payload.
 */

/** Flag bit: payload is compressed with the negotiated encoding (gzip). */
export const CONNECT_COMPRESSED_FLAG = 0x01;
/** Flag bit: payload is the end-of-stream JSON trailer. */
export const CONNECT_END_STREAM_FLAG = 0x02;

const CONNECT_HEADER_BYTES = 5;

/** Wrap one Connect-protocol message: 1 flag byte + 4-byte big-endian length + payload. */
export function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(CONNECT_HEADER_BYTES + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, CONNECT_HEADER_BYTES);
	return frame;
}

/** One decoded Connect envelope. */
export interface ConnectFrame {
	flags: number;
	payload: Buffer;
}

/** Options for {@link ConnectFrameDecoder}. */
export interface ConnectFrameDecoderOptions {
	/**
	 * Payload cap: a length prefix above `maxPayloadBytes` throws `error(length)`
	 * before any of that payload is buffered. Uncapped when omitted.
	 */
	limit?: { maxPayloadBytes: number; error: (length: number) => Error };
}

/**
 * Incremental Connect frame decoder. Incoming chunks are kept as-is and a frame
 * spanning several chunks is joined once, when the length the header announced
 * has fully arrived — re-concatenating the pending bytes on every chunk made a
 * multi-MB frame cost O(size × chunks).
 *
 * Payloads alias the chunk they came from whenever a frame fits in one chunk,
 * so callers must not reuse chunk buffers they hand in.
 */
export class ConnectFrameDecoder {
	#chunks: Buffer[] = [];
	#buffered = 0;
	readonly #limit: ConnectFrameDecoderOptions["limit"];

	constructor(options: ConnectFrameDecoderOptions = {}) {
		this.#limit = options.limit;
	}

	/** Remaining bytes at EOF expose truncated headers and payloads to the transport. */
	get bufferedBytes(): number {
		return this.#buffered;
	}

	/**
	 * Buffer `chunk` (if any) and yield every frame now complete, in wire order.
	 * An oversize length prefix throws after the frames that precede it.
	 */
	*decode(chunk?: Uint8Array): Generator<ConnectFrame, void, undefined> {
		if (chunk && chunk.length > 0) {
			this.#chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.length));
			this.#buffered += chunk.length;
		}
		while (this.#buffered >= CONNECT_HEADER_BYTES) {
			// A header split across chunks is joined (5 bytes plus one chunk) so it
			// can be read in place.
			while (this.#chunks[0].length < CONNECT_HEADER_BYTES) {
				this.#chunks.splice(0, 2, Buffer.concat([this.#chunks[0], this.#chunks[1]]));
			}
			const length = this.#chunks[0].readUInt32BE(1);
			if (this.#limit && length > this.#limit.maxPayloadBytes) throw this.#limit.error(length);
			const frameBytes = CONNECT_HEADER_BYTES + length;
			if (this.#buffered < frameBytes) return;
			const frame = this.#take(frameBytes);
			yield { flags: frame[0], payload: frame.subarray(CONNECT_HEADER_BYTES) };
		}
	}

	/** Remove and return the next `size` buffered bytes; copies only when they span chunks. */
	#take(size: number): Buffer {
		this.#buffered -= size;
		const first = this.#chunks[0];
		if (first.length >= size) {
			if (first.length === size) this.#chunks.shift();
			else this.#chunks[0] = first.subarray(size);
			return first.subarray(0, size);
		}
		const out = Buffer.allocUnsafe(size);
		let offset = 0;
		let consumed = 0;
		while (offset < size) {
			const chunk = this.#chunks[consumed];
			const needed = size - offset;
			if (chunk.length <= needed) {
				out.set(chunk, offset);
				offset += chunk.length;
				consumed++;
			} else {
				out.set(chunk.subarray(0, needed), offset);
				this.#chunks[consumed] = chunk.subarray(needed);
				offset = size;
			}
		}
		this.#chunks.splice(0, consumed);
		return out;
	}
}

/** Compatibility name for Connect envelopes carrying either JSON or protobuf. */
export const frameConnectPayload = frameConnectMessage;

/** Yield complete envelopes immediately, reject partial EOF, and cancel on early exit. */
export async function* readConnectFrames(
	body: ReadableStream<Uint8Array>,
	maxFrameBytes = 16 * 1024 * 1024,
): AsyncGenerator<ConnectFrame> {
	const reader = body.getReader();
	const decoder = new ConnectFrameDecoder({
		limit: {
			maxPayloadBytes: maxFrameBytes,
			error: () => new Error("Connect envelope exceeds the configured size limit"),
		},
	});
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				if (decoder.bufferedBytes) throw new Error("Connect stream ended with a truncated envelope");
				return;
			}
			yield* decoder.decode(value);
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
