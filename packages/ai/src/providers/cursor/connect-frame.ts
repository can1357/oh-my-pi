import { gunzipSync } from "node:zlib";
import * as AIError from "../../error";
import { formatConnectEndStreamError } from "../connect-error-detail";

/**
 * Connect v1 streaming envelope framing, per
 * <https://connectrpc.com/docs/protocol/>: `[1 byte flags][4 byte uint32
 * big-endian length][payload]`. This module is the single owner of that
 * grammar so the HTTP/2 path (cursor.ts today, the pooled transport later)
 * and the HTTP/1.1 poll bridge share one codec.
 *
 * Envelope flags: bit 0 (`0x01`) marks a gzip-compressed payload, bit 1
 * (`0x02`) marks the end-of-stream envelope; bits 2-7 are reserved and any
 * receiver MUST reject an unknown flag as a protocol error. Compression is
 * per-envelope and stateless across frames, so each envelope is compressed
 * and decompressed independently.
 */

export const CONNECT_FLAG_COMPRESSED = 0b00000001;
export const CONNECT_FLAG_END_STREAM = 0b00000010;
export const CONNECT_FLAG_RESERVED_MASK = 0b11111100;

/**
 * Hard upper bound on a single Connect frame payload. The 4-byte length prefix
 * is otherwise attacker-controlled (up to `2**32 - 1`), so a malicious or buggy
 * peer could force a reader to buffer gigabytes via `Buffer.concat` before an
 * idle-timeout wrapper aborts. Well above any legitimate response but tight
 * enough that a corrupt length prefix fails fast instead of consuming memory
 * (same convention as devin.ts:77). Also bounds the decompressed output of a
 * compressed envelope, so a tiny gzip payload cannot expand unboundedly.
 */
export const MAX_CONNECT_FRAME_PAYLOAD = 16 * 1024 * 1024;

/** A protocol-level violation of the Connect envelope grammar. */
export class ConnectProtocolError extends AIError.ProviderResponseError {}

/**
 * Connect end-stream JSON error. `message` is the classification prefix
 * (`Connect error ${code}: ${message}`); `diagnosticMessage` carries details
 * the recovery classifier must not see.
 */
export class ConnectEndStreamError extends ConnectProtocolError {
	readonly diagnosticMessage: string;

	constructor(classificationMessage: string, diagnosticMessage: string) {
		super(classificationMessage, { kind: "envelope" });
		this.diagnosticMessage = diagnosticMessage;
	}
}

export interface ConnectDataFrame {
	kind: "data";
	payload: Uint8Array;
}
export interface ConnectEndFrame {
	kind: "end";
	error: Error | null;
}
export type ConnectFrame = ConnectDataFrame | ConnectEndFrame;

/**
 * gRPC carries trailer messages percent-encoded; mirror that decode so the
 * surfaced error reads the server's real text. A malformed escape (e.g. a bare
 * `%` not forming a valid triple) falls back to the raw string rather than
 * letting a `URIError` escape out of the parser.
 */
function decodePercentEncoded(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/**
 * Parses an end-of-stream envelope payload. Returns `null` on a clean end, or
 * a `ConnectProtocolError` naming the carried error. May throw
 * `ConnectProtocolError` on malformed JSON, a non-object payload, or a
 * non-object error entry; it never throws a raw error out of the parser.
 */
function parseEndStreamFrame(payload: Uint8Array): Error | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(payload));
	} catch {
		throw new ConnectProtocolError("Connect end stream carried malformed JSON", {
			kind: "envelope",
		});
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new ConnectProtocolError("Connect end stream payload was not an object", {
			kind: "envelope",
		});
	}
	const error = "error" in parsed ? parsed.error : undefined;
	if (error === undefined || error === null) return null;
	if (typeof error !== "object" || Array.isArray(error)) {
		throw new ConnectProtocolError("Connect end stream error entry was not an object", {
			kind: "envelope",
		});
	}
	const code = "code" in error && typeof error.code === "string" && error.code ? error.code : "unknown";
	const message =
		"message" in error && typeof error.message === "string" && error.message
			? decodePercentEncoded(error.message)
			: "Unknown error";
	const classificationMessage = `Connect error ${code}: ${message}`;
	return new ConnectEndStreamError(classificationMessage, formatConnectEndStreamError(error));
}

/**
 * Encodes `payload` into a Connect envelope. When `compress` is set the body is
 * `gzip`-compressed and the envelope's bit-0 flag is set; the frame is always
 * `[flags][uint32BE length][payload]`.
 */
export function encodeConnectFrame(payload: Uint8Array, compress: boolean): Buffer {
	const body = compress ? Bun.gzipSync(payload as Uint8Array<ArrayBuffer>) : payload;
	let flags = 0;
	if (compress) flags |= CONNECT_FLAG_COMPRESSED;
	const frame = Buffer.alloc(5 + body.length);
	frame[0] = flags;
	frame.writeUInt32BE(body.length, 1);
	frame.set(body, 5);
	return frame;
}

/**
 * Stateful per-stream Connect decoder. Appends raw bytes and emits every frame
 * that completes, enforcing the terminal grammar: reserved flags and unknown
 * compression are rejected, at most one end-of-stream envelope may arrive, and
 * `finish()` requires that the end-of-stream envelope was seen with no trailing
 * bytes surviving in the buffer.
 *
 * Buffering is amortized O(1) per push: bytes accumulate in a geometrically
 * growing backing buffer and the consumed head is reclaimed only when a new
 * chunk would not fit in the remaining tail, so a large frame delivered in many
 * small chunks no longer copies the whole pending buffer on every push.
 */
export class ConnectFrameDecoder {
	readonly #acceptCompressed: boolean;
	// Backing buffer; valid unconsumed bytes are `#buf.subarray(#start, #end)`.
	#buf: Buffer = Buffer.alloc(0);
	#start = 0;
	#end = 0;
	#sawEndStream = false;

	constructor(options: { acceptCompressed: boolean }) {
		this.#acceptCompressed = options.acceptCompressed;
	}

	get sawEndStream(): boolean {
		return this.#sawEndStream;
	}

	/** Number of unconsumed bytes currently buffered. */
	get #pending(): number {
		return this.#end - this.#start;
	}

	/** Ensures `chunk` can be appended without overflowing the backing buffer. */
	#append(chunk: Buffer): void {
		const needed = this.#pending + chunk.length;
		if (needed > this.#buf.length) {
			// Grow geometrically and copy only the live bytes to the front,
			// reclaiming any consumed head. Each byte is copied O(1) amortized.
			const cap = Math.max(needed, this.#buf.length * 2, 64);
			const next = Buffer.alloc(cap);
			next.set(this.#buf.subarray(this.#start, this.#end), 0);
			this.#buf = next;
			this.#end = this.#pending;
			this.#start = 0;
		} else if (this.#end + chunk.length > this.#buf.length) {
			// Enough total capacity, but the tail is too short: compact in place.
			// Safe because no outstanding view into `#buf` escapes this decoder —
			// frame payloads are copied out or decompressed into fresh buffers.
			this.#buf.copyWithin(0, this.#start, this.#end);
			this.#end = this.#pending;
			this.#start = 0;
		}
		this.#buf.set(chunk, this.#end);
		this.#end += chunk.length;
	}

	/** Appends bytes and returns every frame that completed. Throws `ConnectProtocolError`. */
	push(chunk: Buffer): ConnectFrame[] {
		// Once the terminal envelope has been consumed, no further bytes are
		// valid — a terminal envelope is exactly one header + payload, nothing
		// more. Reject any non-empty trailing chunk from push() itself.
		if (this.#sawEndStream && chunk.length > 0) {
			throw new ConnectProtocolError("Cursor Connect received bytes after end-of-stream envelope", {
				kind: "envelope",
			});
		}
		if (chunk.length === 0) return [];
		this.#append(chunk);

		const frames: ConnectFrame[] = [];
		while (this.#pending >= 5) {
			const flags = this.#buf[this.#start];
			const msgLen = this.#buf.readUInt32BE(this.#start + 1);
			// Reject a declared length above the cap before treating the frame as
			// present — the 4-byte prefix is otherwise attacker-controlled.
			if (msgLen > MAX_CONNECT_FRAME_PAYLOAD) {
				throw new ConnectProtocolError(
					`Cursor Connect frame length ${msgLen} exceeds ${MAX_CONNECT_FRAME_PAYLOAD}-byte cap`,
					{ kind: "envelope" },
				);
			}
			if (this.#pending < 5 + msgLen) break;

			const payloadStart = this.#start + 5;
			const payloadEnd = payloadStart + msgLen;
			const payload = this.#buf.subarray(payloadStart, payloadEnd);
			// Consume the envelope before processing it; a processing throw is a
			// terminal protocol error that aborts the stream regardless.
			this.#start = payloadEnd;

			// No frame may follow the end-of-stream envelope.
			if (this.#sawEndStream) {
				throw new ConnectProtocolError("Cursor Connect received a frame after end-of-stream", {
					kind: "envelope",
				});
			}

			if ((flags & CONNECT_FLAG_RESERVED_MASK) !== 0) {
				throw new ConnectProtocolError(`Cursor Connect protocol error: invalid envelope flags ${flags}`, {
					kind: "envelope",
				});
			}

			let body: Uint8Array = payload;
			if ((flags & CONNECT_FLAG_COMPRESSED) !== 0) {
				if (!this.#acceptCompressed) {
					throw new ConnectProtocolError(
						"Cursor Connect received a compressed envelope but compression was not negotiated",
						{ kind: "envelope" },
					);
				}
				// node:zlib gunzipSync is used instead of Bun.gunzipSync because
				// only node:zlib exposes `maxOutputLength`, which bounds the
				// decompressed size and stops a tiny gzip payload from expanding
				// unboundedly. This is the documented exception to AGENTS.md's
				// Bun-over-Node rule (Bun has no output-bound decompressor).
				try {
					body = gunzipSync(payload as Uint8Array<ArrayBuffer>, {
						maxOutputLength: MAX_CONNECT_FRAME_PAYLOAD,
					});
				} catch (e) {
					const code = typeof e === "object" && e !== null && "code" in e ? e.code : undefined;
					if (code === "ERR_BUFFER_TOO_LARGE") {
						throw new ConnectProtocolError(
							`Cursor Connect decompressed envelope exceeds ${MAX_CONNECT_FRAME_PAYLOAD}-byte cap`,
							{ kind: "envelope", cause: e },
						);
					}
					throw new ConnectProtocolError("Cursor Connect envelope declared gzip but could not be decompressed", {
						kind: "envelope",
						cause: e,
					});
				}
				// Defensive: maxOutputLength already enforces this, but keep an
				// explicit post-check so the bound holds even if the option's
				// semantics ever change.
				if (body.length > MAX_CONNECT_FRAME_PAYLOAD) {
					throw new ConnectProtocolError(
						`Cursor Connect decompressed envelope exceeds ${MAX_CONNECT_FRAME_PAYLOAD}-byte cap`,
						{ kind: "envelope" },
					);
				}
			} else {
				// Copy the payload out so later compaction of `#buf` cannot mutate
				// a view the caller still holds.
				body = Buffer.from(payload);
			}

			if ((flags & CONNECT_FLAG_END_STREAM) !== 0) {
				this.#sawEndStream = true;
				frames.push({ kind: "end", error: parseEndStreamFrame(body) });
			} else {
				frames.push({ kind: "data", payload: body });
			}
		}
		return frames;
	}

	/**
	 * Call on stream EOF. Throws `ConnectProtocolError` when no end-of-stream
	 * was seen, or when trailing bytes survive the final frame. A stream that
	 * ends exactly on a frame boundary without a terminal envelope is still an
	 * incomplete stream, which the Cursor consumer tolerates once it has seen
	 * `turnEnded`; any dangling partial frame or stray bytes after that boundary
	 * is a protocol/envelope error instead.
	 */
	finish(): void {
		if (this.#pending > 0) {
			throw new ConnectProtocolError(
				this.#sawEndStream
					? "Cursor Connect received bytes after end-of-stream envelope"
					: "Cursor Connect received trailing bytes after final frame",
				{ kind: "envelope" },
			);
		}
		if (!this.#sawEndStream) {
			throw new ConnectProtocolError("Cursor stream ended before end-of-stream frame", {
				kind: "incomplete-stream",
			});
		}
	}
}
