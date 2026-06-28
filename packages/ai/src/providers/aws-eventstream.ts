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
 * Decode a single, fully buffered eventstream message. Throws if the framing is
 * malformed or either CRC mismatches. Used by both `decodeEventStream` (the
 * streaming entry point) and the unit tests, which exercise it with hand-built
 * frames.
 */
export function decodeMessage(frame: Uint8Array): EventStreamMessage {
	if (frame.length < MIN_MESSAGE_LEN) throw new AIError.EventStreamFrameError("frame too short");
	const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
	const total = view.getUint32(0, false);
	if (total !== frame.length)
		throw new AIError.EventStreamFrameError(`framed length ${total} != buffer ${frame.length}`);
	const headersLen = view.getUint32(4, false);
	const preludeCrc = view.getUint32(8, false);
	const computedPreludeCrc = crc32(frame.subarray(0, PRELUDE_LEN));
	if (computedPreludeCrc !== preludeCrc) throw new AIError.EventStreamFrameError("prelude CRC mismatch");
	const msgCrc = view.getUint32(total - MESSAGE_CRC_LEN, false);
	const computedMsgCrc = crc32(frame.subarray(0, total - MESSAGE_CRC_LEN));
	if (computedMsgCrc !== msgCrc) throw new AIError.EventStreamFrameError("message CRC mismatch");

	const headersBytes = frame.subarray(HEADER_BLOCK_OFFSET, HEADER_BLOCK_OFFSET + headersLen);
	const payload = frame.subarray(HEADER_BLOCK_OFFSET + headersLen, total - MESSAGE_CRC_LEN);
	return { headers: parseHeaders(headersBytes), payload };
}

function parseHeaders(buf: Uint8Array): Record<string, string> {
	const out: Record<string, string> = {};
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	const decoder = new TextDecoder();
	let p = 0;
	while (p < buf.length) {
		const nameLen = view.getUint8(p);
		p += 1;
		const name = decoder.decode(buf.subarray(p, p + nameLen));
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
				out[name] = String(view.getInt8(p));
				p += 1;
				break;
			case 3: // short
				out[name] = String(view.getInt16(p, false));
				p += 2;
				break;
			case 4: // integer
				out[name] = String(view.getInt32(p, false));
				p += 4;
				break;
			case 5: // long — surface as decimal string to avoid precision loss
				out[name] = bigIntFromBytes(buf.subarray(p, p + 8)).toString();
				p += 8;
				break;
			case 6: {
				// byte array — base64 for safe transport
				const len = view.getUint16(p, false);
				p += 2;
				out[name] = Buffer.from(buf.buffer, buf.byteOffset + p, len).toString("base64");
				p += len;
				break;
			}
			case 7: {
				// string
				const len = view.getUint16(p, false);
				p += 2;
				out[name] = decoder.decode(buf.subarray(p, p + len));
				p += len;
				break;
			}
			case 8: // timestamp (ms since epoch as i64)
				out[name] = new Date(Number(bigIntFromBytes(buf.subarray(p, p + 8)))).toISOString();
				p += 8;
				break;
			case 9: {
				// uuid
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
 */
export async function* decodeEventStream(source: ReadableStream<Uint8Array>): AsyncGenerator<EventStreamMessage> {
	const reader = source.getReader();
	// Single growable buffer; we slide a read cursor along it and compact when a
	// complete prefix has been consumed. Avoids per-message Uint8Array copies.
	let buf: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
	let completed = false;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (value && value.length > 0) buf = buf.length === 0 ? value : Buffer.concat([buf, value]);
			let offset = 0;
			while (buf.length - offset >= 4) {
				const dv = new DataView(buf.buffer, buf.byteOffset + offset, buf.length - offset);
				const total = dv.getUint32(0, false);
				if (total < MIN_MESSAGE_LEN) throw new AIError.EventStreamFrameError(`total length ${total} below minimum`);
				if (buf.length - offset < total) break;
				const frame = buf.subarray(offset, offset + total);
				yield decodeMessage(frame);
				offset += total;
			}
			if (offset > 0) buf = buf.slice(offset);
			if (done) break;
		}
		if (buf.length > 0) throw new AIError.EventStreamFrameError("truncated message at end of stream");
		completed = true;
	} finally {
		// On abnormal exit (consumer threw/broke, decode error) cancel the body so the
		// HTTP connection is released instead of draining until GC.
		if (!completed) await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
