/**
 * Connect-RPC envelope framing for Grok Bot streaming endpoints.
 *
 * Wire shape (unchanged across Connect protocol v1 unary+streaming):
 *   [flags: u8][length: u32 BE][payload bytes]
 * flags bit 0x02 marks the end-of-stream trailer; its payload is JSON:
 *   `{}` on success, `{"error": {code, message, details?}}` on failure.
 */

export const CONNECT_END_STREAM_FLAG = 0b00000010;

/** Guard against runaway frames; InferenceService responses stay far below this. */
export const MAX_CONNECT_FRAME_PAYLOAD = 16 * 1024 * 1024;

export function frameConnectProto(protoBytes: Buffer | Uint8Array, flags = 0): Buffer {
	const payload = Buffer.isBuffer(protoBytes) ? protoBytes : Buffer.from(protoBytes);
	const frame = Buffer.alloc(5 + payload.length);
	frame[0] = flags;
	frame.writeUInt32BE(payload.length, 1);
	payload.copy(frame, 5);
	return frame;
}

export interface ConnectFrame {
	flags: number;
	bytes: Buffer;
}

/**
 * Instance-specific Connect payload limit. OAuth verification uses a much
 * smaller cap than normal inference, before any payload buffer is allocated.
 */
export interface ConnectFrameReaderOptions {
	maxPayload?: number;
}

/**
 * Incremental frame splitter for a Connect byte stream. Feed chunks as they
 * arrive; complete frames come out in order. Throws when a declared payload
 * exceeds its instance cap — that is always a protocol violation, not a
 * slow-stream condition.
 */
export class ConnectFrameReader {
	#header = Buffer.allocUnsafe(5);
	#headerLength = 0;
	#payload: Buffer | undefined;
	#payloadLength = 0;
	#payloadOffset = 0;
	#flags = 0;
	#terminal = false;
	#maxPayload: number;

	constructor(options: ConnectFrameReaderOptions = {}) {
		const maxPayload = options.maxPayload ?? MAX_CONNECT_FRAME_PAYLOAD;
		if (!Number.isSafeInteger(maxPayload) || maxPayload < 0) {
			throw new Error(`Connect frame cap must be a non-negative safe integer, got ${maxPayload}`);
		}
		this.#maxPayload = maxPayload;
	}
	/**
	 * Feed one transport chunk and lazily yield fully assembled frames. The
	 * reader never retains the input chunk: it copies only the five-byte header
	 * until it can validate the declared length, then retains exactly one
	 * payload-sized buffer while that frame is incomplete.
	 */
	*push(chunk: Uint8Array): IterableIterator<ConnectFrame> {
		if (this.#terminal || chunk.byteLength === 0) return;

		let offset = 0;
		while (!this.#terminal) {
			if (this.#headerLength < this.#header.length) {
				const count = Math.min(this.#header.length - this.#headerLength, chunk.byteLength - offset);
				if (count === 0) return;
				this.#header.set(chunk.subarray(offset, offset + count), this.#headerLength);
				this.#headerLength += count;
				offset += count;
				if (this.#headerLength < this.#header.length) return;

				const length =
					((this.#header[1]! << 24) | (this.#header[2]! << 16) | (this.#header[3]! << 8) | this.#header[4]!) >>> 0;
				if (length > this.#maxPayload) {
					this.#resetFrame();
					this.#terminal = true;
					throw new Error(`Connect frame too large (${length} bytes; cap ${this.#maxPayload})`);
				}
				this.#flags = this.#header[0]!;
				this.#payloadLength = length;
				this.#payloadOffset = 0;
				this.#payload = Buffer.allocUnsafe(length);
			}

			const payload = this.#payload!;
			const remaining = this.#payloadLength - this.#payloadOffset;
			if (remaining > 0) {
				const count = Math.min(remaining, chunk.byteLength - offset);
				if (count === 0) return;
				payload.set(chunk.subarray(offset, offset + count), this.#payloadOffset);
				this.#payloadOffset += count;
				offset += count;
				if (this.#payloadOffset < this.#payloadLength) return;
			}

			const flags = this.#flags;
			this.#resetFrame();
			if (flags & CONNECT_END_STREAM_FLAG) this.#terminal = true;
			// Reset before yielding so later pushes cannot mutate this frame's
			// payload, even if a consumer pauses the iterator here.
			yield { flags, bytes: payload };
		}
	}

	#resetFrame(): void {
		this.#headerLength = 0;
		this.#payload = undefined;
		this.#payloadLength = 0;
		this.#payloadOffset = 0;
		this.#flags = 0;
	}

	/** Bytes buffered waiting for more input. Non-empty at EOF means truncation. */
	get buffered(): number {
		return this.#headerLength + this.#payloadOffset;
	}
}

export interface ConnectEndStream {
	error?: {
		code?: string;
		message?: string;
		details?: unknown[];
	};
	metadata?: Record<string, string[]>;
	raw: string;
}

/**
 * Parse an end-of-stream trailer. A trailer is always a JSON object; when it
 * contains `error`, that member must itself be a structurally valid error
 * object. Malformed trailers never impersonate a clean completion.
 */
export function parseEndStreamTrailer(bytes: Buffer): ConnectEndStream {
	const raw = Buffer.from(bytes).toString("utf8").trim();
	if (!raw) throw new Error("Connect end-stream trailer was not a JSON object");
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("Connect end-stream trailer is not valid JSON");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Connect end-stream trailer was not a JSON object");
	}
	const object = parsed as Record<string, unknown>;
	let metadata: Record<string, string[]> | undefined;
	if ("metadata" in object) {
		const candidate = object.metadata;
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
			throw new Error("Connect end-stream trailer metadata was not an object");
		}
		for (const value of Object.values(candidate)) {
			if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
				throw new Error("Connect end-stream trailer metadata was malformed");
			}
		}
		metadata = candidate as Record<string, string[]>;
	}
	const endStream = metadata ? { metadata, raw } : { raw };
	if (!("error" in object)) return endStream;
	const errObj = object.error;
	if (!errObj || typeof errObj !== "object" || Array.isArray(errObj)) {
		throw new Error("Connect end-stream trailer error was not an object");
	}
	const err = errObj as Record<string, unknown>;
	if (
		typeof err.code !== "string" ||
		err.code.length === 0 ||
		(err.message !== undefined && typeof err.message !== "string") ||
		(err.details !== undefined && !Array.isArray(err.details))
	) {
		throw new Error("Connect end-stream trailer error was malformed");
	}
	return {
		...endStream,
		error: {
			code: err.code,
			message: typeof err.message === "string" ? err.message : undefined,
			details: Array.isArray(err.details) ? err.details : undefined,
		},
	};
}
