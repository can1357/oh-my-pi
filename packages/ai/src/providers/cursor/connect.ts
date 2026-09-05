import { gunzipSync } from "node:zlib";

export const CONNECT_FLAG_COMPRESSED = 0b0000_0001;
export const CONNECT_FLAG_END_STREAM = 0b0000_0010;
export const CONNECT_MAX_FRAME_BYTES = 16 * 1024 * 1024;
const CONNECT_PREFIX_BYTES = 5;

export interface ConnectFrame {
	/** Payload after gzip decompression. */
	readonly body: Uint8Array;
	readonly compressed: boolean;
	readonly endOfStream: boolean;
}

export function encodeConnectFrame(body: Uint8Array, flags = 0): Uint8Array {
	const frame = new Uint8Array(CONNECT_PREFIX_BYTES + body.length);
	const view = new DataView(frame.buffer);
	view.setUint8(0, flags);
	view.setUint32(1, body.length, false);
	frame.set(body, CONNECT_PREFIX_BYTES);
	return frame;
}

/** Incremental decoder shared by the live transport and protocol fixtures. */
export class ConnectFrameDecoder {
	#buffer = new Uint8Array(0);
	#read = 0;
	#write = 0;

	get #available(): number {
		return this.#write - this.#read;
	}

	#reserve(extra: number): void {
		if (this.#write + extra <= this.#buffer.length) return;
		const needed = this.#available + extra;
		if (needed <= this.#buffer.length) {
			this.#buffer.copyWithin(0, this.#read, this.#write);
		} else {
			let capacity = Math.max(this.#buffer.length * 2, 64 * 1024);
			while (capacity < needed) capacity *= 2;
			const grown = new Uint8Array(capacity);
			grown.set(this.#buffer.subarray(this.#read, this.#write));
			this.#buffer = grown;
		}
		this.#write = this.#available;
		this.#read = 0;
	}

	push(chunk: Uint8Array): ConnectFrame[] {
		if (chunk.length > 0) {
			this.#reserve(chunk.length);
			this.#buffer.set(chunk, this.#write);
			this.#write += chunk.length;
		}

		const frames: ConnectFrame[] = [];
		for (;;) {
			if (this.#available < CONNECT_PREFIX_BYTES) break;
			const view = new DataView(this.#buffer.buffer, this.#buffer.byteOffset + this.#read, CONNECT_PREFIX_BYTES);
			const flags = view.getUint8(0);
			const length = view.getUint32(1, false);
			if (length > CONNECT_MAX_FRAME_BYTES) {
				throw new Error(`Connect frame length ${length} exceeds the ${CONNECT_MAX_FRAME_BYTES} byte cap`);
			}
			if (this.#available < CONNECT_PREFIX_BYTES + length) break;
			const start = this.#read + CONNECT_PREFIX_BYTES;
			const raw = this.#buffer.slice(start, start + length);
			this.#read = start + length;
			const compressed = (flags & CONNECT_FLAG_COMPRESSED) !== 0;
			frames.push({
				body: compressed ? gunzipSync(raw, { maxOutputLength: CONNECT_MAX_FRAME_BYTES }) : raw,
				compressed,
				endOfStream: (flags & CONNECT_FLAG_END_STREAM) !== 0,
			});
		}
		if (this.#read === this.#write) {
			this.#read = 0;
			this.#write = 0;
		}
		return frames;
	}

	end(): void {
		if (this.#available > 0) {
			throw new Error(`Connect stream ended mid-frame with ${this.#available} trailing bytes`);
		}
	}
}
