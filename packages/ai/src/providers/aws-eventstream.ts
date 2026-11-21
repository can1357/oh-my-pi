/**
 * `application/vnd.amazon.eventstream` decoder.
 *
 * Wire format (all integers big-endian):
 *
 *   [total length     u32]
 *   [headers length   u32]
 *   [prelude CRC32    u32]   <- CRC over the first 8 bytes
 *   [headers          headers_length]
 *   [payload          total_length - headers_length - 16]
 *   [message CRC32    u32]   <- CRC over the entire message minus the trailing 4 bytes
 *
 * Headers: a sequence of `[name_len u8][name utf8][value_type u8][value …]`.
 * We only need the typed values Bedrock emits (boolean true/false, byte, short,
 * integer, long, byte-array, string, timestamp, uuid). All are surfaced as
 * strings for ease of consumption — Bedrock only sets string-valued headers in
 * practice (`:event-type`, `:message-type`, `:content-type`, `:exception-type`).
 */

import * as AIError from "../error";

const PRELUDE_LEN = 8;
const PRELUDE_CRC_LEN = 4;
const MESSAGE_CRC_LEN = 4;
const HEADER_BLOCK_OFFSET = PRELUDE_LEN + PRELUDE_CRC_LEN;
const MIN_MESSAGE_LEN = HEADER_BLOCK_OFFSET + MESSAGE_CRC_LEN;
/**
 * Largest message we accept. aws-c-event-stream caps whole messages at 24 MiB
 * (smithy caps the payload alone at 16 MiB); taking the larger bound never
 * rejects a frame a conforming service may send, while still bounding what a
 * corrupt or hostile length prefix can make us allocate.
 */
export const MAX_MESSAGE_LEN = 24 * 1024 * 1024;
/** Encoded header-block limit from the Amazon Event Stream specification. */
export const MAX_HEADERS_LEN = 128 * 1024;
/** Shared across messages: every header decode is a complete, non-streaming call. */
const HEADER_DECODER = new TextDecoder();

export interface EventStreamMessage {
	/** Lower-cased copy is *not* applied — Bedrock uses casing like `:event-type` verbatim. */
	headers: Record<string, string>;
	payload: Uint8Array;
}

/** CRC32 (IEEE / zlib polynomial 0xEDB88320), matches `@aws-crypto/crc32`. */
export function crc32(bytes: Uint8Array): number {
	return Bun.hash.crc32(bytes) >>> 0;
}

/**
 * Validate a 12-byte prelude (prelude CRC first, then lengths) and return the
 * declared total message length. Runs before any further message bytes are
 * buffered, so a corrupt length can never drive an allocation.
 */
function declaredMessageLength(prelude: Uint8Array): number {
	const view = new DataView(prelude.buffer, prelude.byteOffset, HEADER_BLOCK_OFFSET);
	if (crc32(prelude.subarray(0, PRELUDE_LEN)) !== view.getUint32(PRELUDE_LEN, false))
		throw new AIError.EventStreamFrameError("prelude CRC mismatch");
	const total = view.getUint32(0, false);
	if (total < MIN_MESSAGE_LEN) throw new AIError.EventStreamFrameError(`total length ${total} below minimum`);
	if (total > MAX_MESSAGE_LEN)
		throw new AIError.EventStreamFrameError(`total length ${total} exceeds maximum ${MAX_MESSAGE_LEN}`);
	const headersLen = view.getUint32(4, false);
	if (headersLen > MAX_HEADERS_LEN)
		throw new AIError.EventStreamFrameError(`headers length ${headersLen} exceeds maximum ${MAX_HEADERS_LEN}`);
	if (headersLen > total - MIN_MESSAGE_LEN)
		throw new AIError.EventStreamFrameError(`headers length ${headersLen} exceeds message length ${total}`);
	return total;
}

/**
 * Decode a single, fully buffered eventstream message. Throws if the framing is
 * malformed or either CRC mismatches. Used by both `decodeEventStream` (the
 * streaming entry point) and the unit tests, which exercise it with hand-built
 * frames.
 */
export function decodeMessage(frame: Uint8Array): EventStreamMessage {
	if (frame.length < MIN_MESSAGE_LEN) throw new AIError.EventStreamFrameError("frame too short");
	const total = declaredMessageLength(frame);
	if (total !== frame.length)
		throw new AIError.EventStreamFrameError(`framed length ${total} != buffer ${frame.length}`);
	return decodeValidatedFrame(frame);
}

/** Decode a frame whose prelude was validated and whose length equals its declared total. */
function decodeValidatedFrame(frame: Uint8Array): EventStreamMessage {
	const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
	const total = frame.length;
	const headersLen = view.getUint32(4, false);
	const msgCrc = view.getUint32(total - MESSAGE_CRC_LEN, false);
	const computedMsgCrc = crc32(frame.subarray(0, total - MESSAGE_CRC_LEN));
	if (computedMsgCrc !== msgCrc) throw new AIError.EventStreamFrameError("message CRC mismatch");

	const headersBytes = frame.subarray(HEADER_BLOCK_OFFSET, HEADER_BLOCK_OFFSET + headersLen);
	const payload = frame.subarray(HEADER_BLOCK_OFFSET + headersLen, total - MESSAGE_CRC_LEN);
	return { headers: parseHeaders(headersBytes), payload };
}

/** Throw unless `length` bytes starting at `offset` lie inside the header block. */
function requireHeaderBytes(buf: Uint8Array, offset: number, length: number, field: string): void {
	if (offset + length > buf.length)
		throw new AIError.EventStreamFrameError(`header ${field} overruns header block at offset ${offset}`);
}

function parseHeaders(buf: Uint8Array): Record<string, string> {
	const out: Record<string, string> = {};
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	let p = 0;
	while (p < buf.length) {
		const nameLen = view.getUint8(p);
		p += 1;
		requireHeaderBytes(buf, p, nameLen + 1, "name");
		const name = HEADER_DECODER.decode(buf.subarray(p, p + nameLen));
		p += nameLen;
		const type = view.getUint8(p);
		p += 1;
		switch (type) {
			case 0: // bool true
				out[name] = "true";
				break;
			case 1: // bool false
				out[name] = "false";
				break;
			case 2: // byte
				requireHeaderBytes(buf, p, 1, "byte value");
				out[name] = String(view.getInt8(p));
				p += 1;
				break;
			case 3: // short
				requireHeaderBytes(buf, p, 2, "short value");
				out[name] = String(view.getInt16(p, false));
				p += 2;
				break;
			case 4: // integer
				requireHeaderBytes(buf, p, 4, "integer value");
				out[name] = String(view.getInt32(p, false));
				p += 4;
				break;
			case 5: // long — surface as decimal string to avoid precision loss
				requireHeaderBytes(buf, p, 8, "long value");
				out[name] = bigIntFromBytes(buf.subarray(p, p + 8)).toString();
				p += 8;
				break;
			case 6: {
				// byte array — base64 for safe transport
				requireHeaderBytes(buf, p, 2, "byte-array length");
				const len = view.getUint16(p, false);
				p += 2;
				requireHeaderBytes(buf, p, len, "byte-array value");
				out[name] = Buffer.from(buf.buffer, buf.byteOffset + p, len).toString("base64");
				p += len;
				break;
			}
			case 7: {
				// string
				requireHeaderBytes(buf, p, 2, "string length");
				const len = view.getUint16(p, false);
				p += 2;
				requireHeaderBytes(buf, p, len, "string value");
				out[name] = HEADER_DECODER.decode(buf.subarray(p, p + len));
				p += len;
				break;
			}
			case 8: {
				// timestamp (ms since epoch as i64)
				requireHeaderBytes(buf, p, 8, "timestamp value");
				const date = new Date(Number(bigIntFromBytes(buf.subarray(p, p + 8))));
				if (Number.isNaN(date.getTime()))
					throw new AIError.EventStreamFrameError(`header ${name} timestamp out of range`);
				out[name] = date.toISOString();
				p += 8;
				break;
			}
			case 9: {
				// uuid
				requireHeaderBytes(buf, p, 16, "uuid value");
				const u = buf.subarray(p, p + 16);
				const hex: string[] = [];
				for (let i = 0; i < 16; i++) hex.push(u[i].toString(16).padStart(2, "0"));
				out[name] =
					`${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
				p += 16;
				break;
			}
			default:
				throw new AIError.EventStreamFrameError(`unknown header value type ${type}`);
		}
	}
	return out;
}

function bigIntFromBytes(b: Uint8Array): bigint {
	let v = 0n;
	for (let i = 0; i < b.length; i++) v = (v << 8n) | BigInt(b[i]);
	// sign-extend (two's complement)
	if (b.length === 8 && b[0] & 0x80) v -= 1n << 64n;
	return v;
}

/**
 * Async generator that consumes a `ReadableStream<Uint8Array>` (e.g. a fetch
 * response body) and yields fully-framed messages. Handles arbitrary chunk
 * boundaries: messages may span multiple chunks, and a single chunk may carry
 * many messages.
 *
 * A message wholly inside one chunk is decoded in place (zero-copy). A message
 * spanning chunks is copied once into a buffer sized from its validated
 * prelude, so buffered memory never exceeds one bounded message and every byte
 * is copied at most once. Yielded payloads are never overwritten afterwards.
 * A body that ends inside a frame raises `EventStreamFrameError` with
 * `kind: "truncated"`.
 */
export async function* decodeEventStream(source: ReadableStream<Uint8Array>): AsyncGenerator<EventStreamMessage> {
	const reader = source.getReader();
	// The 12-byte prelude of a message whose prelude spans chunks.
	const prelude = new Uint8Array(HEADER_BLOCK_OFFSET);
	let preludeFilled = 0;
	// A message spanning chunks, allocated at its validated declared length.
	let pending: Uint8Array | undefined;
	let pendingFilled = 0;
	let completed = false;
	try {
		while (true) {
			const { value: chunk, done } = await reader.read();
			if (done) break;
			let offset = 0;
			while (offset < chunk.length) {
				if (pending) {
					const count = Math.min(pending.length - pendingFilled, chunk.length - offset);
					pending.set(chunk.subarray(offset, offset + count), pendingFilled);
					pendingFilled += count;
					offset += count;
					if (pendingFilled < pending.length) break;
					const frame = pending;
					pending = undefined;
					yield decodeValidatedFrame(frame);
					continue;
				}
				const available = chunk.length - offset;
				if (preludeFilled > 0 || available < HEADER_BLOCK_OFFSET) {
					const count = Math.min(HEADER_BLOCK_OFFSET - preludeFilled, available);
					prelude.set(chunk.subarray(offset, offset + count), preludeFilled);
					preludeFilled += count;
					offset += count;
					if (preludeFilled < HEADER_BLOCK_OFFSET) break;
					preludeFilled = 0;
					// total >= MIN_MESSAGE_LEN > prelude, so the frame always needs more bytes.
					pending = new Uint8Array(declaredMessageLength(prelude));
					pending.set(prelude);
					pendingFilled = HEADER_BLOCK_OFFSET;
					continue;
				}
				const total = declaredMessageLength(chunk.subarray(offset, offset + HEADER_BLOCK_OFFSET));
				if (available >= total) {
					yield decodeValidatedFrame(chunk.subarray(offset, offset + total));
					offset += total;
					continue;
				}
				pending = new Uint8Array(total);
				pendingFilled = 0;
			}
		}
		if (pending || preludeFilled > 0)
			throw new AIError.EventStreamFrameError("truncated message at end of stream", "truncated");
		completed = true;
	} finally {
		// On abnormal exit (consumer threw/broke, decode error) cancel the body so the
		// HTTP connection is released instead of draining until GC.
		if (!completed) await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
