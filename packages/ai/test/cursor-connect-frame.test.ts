import { describe, expect, test } from "bun:test";
import {
	CONNECT_FLAG_COMPRESSED,
	CONNECT_FLAG_END_STREAM,
	CONNECT_FLAG_RESERVED_MASK,
	type ConnectFrame,
	ConnectFrameDecoder,
	ConnectProtocolError,
	encodeConnectFrame,
	MAX_CONNECT_FRAME_PAYLOAD,
} from "../src/providers/cursor/connect-frame";

/**
 * Builds a raw envelope with the given flags and payload, bypassing the codec,
 * so grammar violations can be exercised directly.
 */
function rawFrame(flags: number, body: Uint8Array | string): Buffer {
	const payload = typeof body === "string" ? Buffer.from(body) : Buffer.from(body);
	const frame = Buffer.alloc(5 + payload.length);
	frame[0] = flags;
	frame.writeUInt32BE(payload.length, 1);
	frame.set(payload, 5);
	return frame;
}

/** Asserts `fn` throws a `ConnectProtocolError`, optionally pinning message and kind. */
function expectProtocolError(
	fn: () => void,
	messagePart?: string,
	kind?: "envelope" | "incomplete-stream",
): ConnectProtocolError {
	let err: unknown;
	try {
		fn();
	} catch (e) {
		err = e;
	}
	expect(err).toBeInstanceOf(ConnectProtocolError);
	if (messagePart !== undefined) {
		expect((err as Error).message).toContain(messagePart);
	}
	if (kind !== undefined) {
		expect((err as ConnectProtocolError).kind).toBe(kind);
	}
	return err as ConnectProtocolError;
}

/** Asserts an error carried inside an end frame is a `ConnectProtocolError` with the given kind. */
function expectEndErrorKind(decoder: ConnectFrameDecoder, payload: Uint8Array | string, kind: "envelope") {
	const frames = decoder.push(rawFrame(CONNECT_FLAG_END_STREAM, payload));
	expect(frames).toHaveLength(1);
	expect(frames[0].kind).toBe("end");
	const err = (frames[0] as { error: Error | null }).error;
	expect(err).toBeInstanceOf(ConnectProtocolError);
	expect((err as ConnectProtocolError).kind).toBe(kind);
	return err as ConnectProtocolError;
}

describe("encodeConnectFrame", () => {
	test("uncompressed frame is flags, length, payload", () => {
		const payload = new TextEncoder().encode("hello");
		const frame = encodeConnectFrame(payload, false);
		expect(frame.length).toBe(5 + 5);
		expect(frame[0]).toBe(0);
		expect(frame.readUInt32BE(1)).toBe(5);
		expect(frame.subarray(5).toString()).toBe("hello");
	});

	test("compressed frame sets bit 0 and gzips the body", () => {
		const payload = new TextEncoder().encode("a".repeat(1024));
		const frame = encodeConnectFrame(payload, true);
		expect(frame[0]).toBe(CONNECT_FLAG_COMPRESSED);
		// Body is gzip, so the length differs from the raw payload and decompresses back.
		expect(frame.readUInt32BE(1)).not.toBe(payload.length);
		expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(frame.subarray(5))))).toBe("a".repeat(1024));
	});
});

describe("ConnectFrameDecoder grammar", () => {
	test("data frame round-trips through encode then decode", () => {
		const payload = new TextEncoder().encode("streaming text");
		const frame = encodeConnectFrame(payload, false);
		const decoder = new ConnectFrameDecoder({ acceptCompressed: true });
		const frames = decoder.push(frame);
		expect(frames).toHaveLength(1);
		expect(frames[0]).toEqual({ kind: "data", payload });
		expect(decoder.sawEndStream).toBe(false);
	});

	test("gzip round-trip data frame (end-to-end encode -> decode)", () => {
		const payload = new TextEncoder().encode("gzipped payload");
		const frame = encodeConnectFrame(payload, true);
		const decoder = new ConnectFrameDecoder({ acceptCompressed: true });
		const frames = decoder.push(frame);
		expect(frames).toHaveLength(1);
		expect(frames[0].kind).toBe("data");
		expect((frames[0] as { payload: Uint8Array }).payload).toEqual(payload);
	});

	test("reserved flags are rejected as a protocol error", () => {
		const decoder = new ConnectFrameDecoder({ acceptCompressed: true });
		// flags = 0x04 clears a reserved bit.
		expectProtocolError(() => decoder.push(rawFrame(0x04, "payload")), "invalid envelope flags 4", "envelope");
	});

	test("all reserved bits are covered by the mask", () => {
		expect(CONNECT_FLAG_RESERVED_MASK).toBe(0b11111100);
		expect(CONNECT_FLAG_COMPRESSED & CONNECT_FLAG_RESERVED_MASK).toBe(0);
		expect(CONNECT_FLAG_END_STREAM & CONNECT_FLAG_RESERVED_MASK).toBe(0);
	});

	test("compressed envelope with acceptCompressed=false is rejected", () => {
		const decoder = new ConnectFrameDecoder({ acceptCompressed: false });
		expectProtocolError(() => decoder.push(rawFrame(0x01, "garbage")), "compression", "envelope");
	});

	test("a bad gzip body surfaces a protocol error, never a raw zlib error", () => {
		const decoder = new ConnectFrameDecoder({ acceptCompressed: true });
		expectProtocolError(() => decoder.push(rawFrame(0x01, "not gzip data")), "decompressed", "envelope");
	});

	test("compressed end-stream (flags 0x03) parses to a clean end", () => {
		const decoder = new ConnectFrameDecoder({ acceptCompressed: true });
		const endPayload = Bun.gzipSync(Buffer.from(JSON.stringify({ error: null })));
		const frames = decoder.push(rawFrame(CONNECT_FLAG_END_STREAM | CONNECT_FLAG_COMPRESSED, endPayload));
		expect(frames).toHaveLength(1);
		expect(frames[0]).toEqual({ kind: "end", error: null });
		expect(decoder.sawEndStream).toBe(true);
		// No frame (data or second end) may follow end-of-stream, but the decoder
		// buffers the trailing bytes and exposes the protocol error via poisonError
		// instead of throwing from push(), so the pump can emit prefix frames first.
		expect(decoder.push(rawFrame(0x00, "late"))).toEqual([]);
		expect(decoder.poisonError).toBeInstanceOf(ConnectProtocolError);
		expect(decoder.poisonError?.kind).toBe("envelope");
		expect(decoder.poisonError?.message).toContain("bytes after end-of-stream");
		const secondEnd = decoder.push(rawFrame(CONNECT_FLAG_END_STREAM, JSON.stringify({})));
		expect(secondEnd).toEqual([]);
		expect(decoder.poisonError?.kind).toBe("envelope");
	});

	test("clean end-of-stream frame yields a null error and marks the stream ended", () => {
		const decoder = new ConnectFrameDecoder({ acceptCompressed: true });
		const frames = decoder.push(rawFrame(CONNECT_FLAG_END_STREAM, JSON.stringify({ error: null })));
		expect(frames).toHaveLength(1);
		expect(frames[0]).toEqual({ kind: "end", error: null });
		expect(decoder.sawEndStream).toBe(true);
	});

	test("end-stream carrying an error code/message surfaces a protocol error", () => {
		const decoder = new ConnectFrameDecoder({ acceptCompressed: true });
		const endJson = JSON.stringify({ error: { code: "resource_exhausted", message: "quota%20hit" } });
		const frames = decoder.push(rawFrame(CONNECT_FLAG_END_STREAM, endJson));
		expect(frames).toHaveLength(1);
		expect(frames[0].kind).toBe("end");
		const err = (frames[0] as { error: Error | null }).error;
		expect(err).toBeInstanceOf(ConnectProtocolError);
		expect((err as ConnectProtocolError).kind).toBe("envelope");
		// The percent-encoded message is decoded.
		expect((err as Error).message).toContain("resource_exhausted");
		expect((err as Error).message).toContain("quota hit");
	});

	test("end-stream message with a malformed percent escape stays a protocol error, never a URIError", () => {
		const decoder = new ConnectFrameDecoder({ acceptCompressed: true });
		const endJson = JSON.stringify({ error: { code: "resource_exhausted", message: "bad%" } });
		const err = expectEndErrorKind(decoder, endJson, "envelope");
		// The malformed escape is surfaced raw (decodeURIComponent threw and was
		// swallowed) rather than leaking a URIError out of the parser.
		expect(err.message).toContain("bad%");
		expect(err).not.toBeInstanceOf(URIError);
	});

	test("malformed JSON end-stream produces a protocol error, never a raw throw", () => {
		const decoder = new ConnectFrameDecoder({ acceptCompressed: true });
		expectProtocolError(
			() => decoder.push(rawFrame(CONNECT_FLAG_END_STREAM, "{not json")),
			"malformed JSON",
			"envelope",
		);
	});

	test("non-object end-stream payload produces a protocol error", () => {
		const decoder = new ConnectFrameDecoder({ acceptCompressed: true });
		expectProtocolError(
			() => decoder.push(rawFrame(CONNECT_FLAG_END_STREAM, "[1,2,3]")),
			"not an object",
			"envelope",
		);
	});

	test("second end-stream frame after end-of-stream is buffered as poison", () => {
		const decoder = new ConnectFrameDecoder({ acceptCompressed: true });
		decoder.push(rawFrame(CONNECT_FLAG_END_STREAM, JSON.stringify({ error: null })));
		expect(decoder.push(rawFrame(CONNECT_FLAG_END_STREAM, JSON.stringify({ error: null })))).toEqual([]);
		expect(decoder.poisonError).toBeInstanceOf(ConnectProtocolError);
		expect(decoder.poisonError?.kind).toBe("envelope");
		expect(decoder.poisonError?.message).toContain("bytes after end-of-stream");
	});

	test("data frame after end-of-stream is buffered as poison", () => {
		const decoder = new ConnectFrameDecoder({ acceptCompressed: true });
		decoder.push(rawFrame(CONNECT_FLAG_END_STREAM, JSON.stringify({ error: null })));
		expect(decoder.push(rawFrame(0x00, "late data"))).toEqual([]);
		expect(decoder.poisonError).toBeInstanceOf(ConnectProtocolError);
		expect(decoder.poisonError?.kind).toBe("envelope");
		expect(decoder.poisonError?.message).toContain("bytes after end-of-stream");
	});

	test("terminal envelope plus an incomplete trailing envelope in one push withholds the end frame", () => {
		const decoder = new ConnectFrameDecoder({ acceptCompressed: true });
		// The trailing bytes form a complete header declaring more payload than
		// the chunk holds, so the decode loop exits on an incomplete frame.
		// push() must not return an end frame with bytes still pending; the
		// poisoned decoder reports the tail at finish().
		const chunk = Buffer.concat([
			rawFrame(CONNECT_FLAG_END_STREAM, JSON.stringify({ error: null })),
			Buffer.from([0x00, 0x00, 0x00, 0x00, 0x04]),
		]);
		expect(decoder.push(chunk)).toEqual([]);
		expect(decoder.sawEndStream).toBe(true);
		expectProtocolError(() => decoder.finish(), "bytes after end-of-stream", "envelope");
	});

	test("declared length above the cap is rejected before allocating", () => {
		const decoder = new ConnectFrameDecoder({ acceptCompressed: true });
		const oversized = Buffer.alloc(5);
		oversized[0] = 0;
		oversized.writeUInt32BE(MAX_CONNECT_FRAME_PAYLOAD + 1, 1);
		expectProtocolError(() => decoder.push(oversized), `exceeds ${MAX_CONNECT_FRAME_PAYLOAD}-byte cap`, "envelope");
	});

	test("finish() before end-of-stream throws and reports an incomplete stream", () => {
		const decoder = new ConnectFrameDecoder({ acceptCompressed: true });
		expectProtocolError(() => decoder.finish(), "stream ended before end-of-stream frame", "incomplete-stream");
	});

	test("finish() after end-of-stream leaves the decoder terminal", () => {
		const decoder = new ConnectFrameDecoder({ acceptCompressed: true });
		const frames = decoder.push(rawFrame(CONNECT_FLAG_END_STREAM, JSON.stringify({ error: null })));
		expect(frames).toEqual([{ kind: "end", error: null }]);
		expect(decoder.sawEndStream).toBe(true);
		// The no-op contract, made observable: finish() neither reopens the
		// stream nor consumes the terminal state, so a trailing byte is
		// still a protocol error after it ran. It is surfaced via poisonError,
		// not by throwing from push(), so prefix frames can still be emitted first.
		decoder.finish();
		expect(decoder.push(Buffer.from([0x00]))).toEqual([]);
		expect(decoder.poisonError).toBeInstanceOf(ConnectProtocolError);
		expect(decoder.poisonError?.kind).toBe("envelope");
		expect(decoder.poisonError?.message).toContain("bytes after end-of-stream");
	});

	test("fragmented byte-at-a-time delivery yields identical frames to one chunk", () => {
		const payloadA = new TextEncoder().encode("first message");
		const payloadB = new TextEncoder().encode("second message");
		const stream = Buffer.concat([
			encodeConnectFrame(payloadA, false),
			encodeConnectFrame(payloadB, false),
			rawFrame(CONNECT_FLAG_END_STREAM, JSON.stringify({ error: null })),
		]);

		const whole = new ConnectFrameDecoder({ acceptCompressed: true });
		const wholeFrames = whole.push(stream);

		const fragmented = new ConnectFrameDecoder({ acceptCompressed: true });
		const fragFrames: { kind: string; payload?: Uint8Array; error?: Error | null }[] = [];
		for (let i = 0; i < stream.length; i++) {
			fragFrames.push(...fragmented.push(stream.subarray(i, i + 1)));
		}

		expect(fragFrames.map(f => f.kind)).toEqual(wholeFrames.map(f => f.kind));
		expect(fragmented.sawEndStream).toBe(whole.sawEndStream);
		expect((fragFrames[0] as { payload: Uint8Array }).payload).toEqual(payloadA);
		expect((fragFrames[1] as { payload: Uint8Array }).payload).toEqual(payloadB);
		expect(fragFrames[2].error).toBeNull();
	});
});

describe("ConnectFrameDecoder hardening (grill loop batch 1)", () => {
	test("bounded inflate: a compressed envelope expanding past the cap is rejected", () => {
		// 16 MiB + 1 of repeated bytes compresses to a few KB but would decompress
		// past MAX_CONNECT_FRAME_PAYLOAD. The decoder must reject it as a protocol
		// error, never allocate the full expansion.
		const oversized = new Uint8Array(MAX_CONNECT_FRAME_PAYLOAD + 1).fill(0x41);
		const gz = Bun.gzipSync(oversized as Uint8Array<ArrayBuffer>);
		expect(gz.length).toBeLessThan(MAX_CONNECT_FRAME_PAYLOAD);
		const decoder = new ConnectFrameDecoder({ acceptCompressed: true });
		expectProtocolError(() => decoder.push(rawFrame(CONNECT_FLAG_COMPRESSED, gz)), "exceeds", "envelope");
		expect(decoder.sawEndStream).toBe(false);
	});

	test("amortized buffering: a 256 KiB frame delivered in 4 KiB chunks decodes identically to one chunk", () => {
		const payload = new TextEncoder().encode("Z".repeat(256 * 1024));
		const frame = encodeConnectFrame(payload, false);
		const chunkSize = 4 * 1024;

		const whole = new ConnectFrameDecoder({ acceptCompressed: true });
		const wholeFrames = whole.push(frame);

		const fragmented = new ConnectFrameDecoder({ acceptCompressed: true });
		const fragFrames: ConnectFrame[] = [];
		for (let i = 0; i < frame.length; i += chunkSize) {
			fragFrames.push(...fragmented.push(frame.subarray(i, Math.min(i + chunkSize, frame.length))));
		}
		expect(fragFrames).toHaveLength(1);
		expect(fragFrames[0].kind).toBe("data");
		expect((fragFrames[0] as { payload: Uint8Array }).payload).toEqual(payload);
		expect(wholeFrames).toHaveLength(1);
		expect((wholeFrames[0] as { payload: Uint8Array }).payload).toEqual(
			(fragFrames[0] as { payload: Uint8Array }).payload,
		);
	});

	test("stray tail after end-stream in the same chunk withholds the end frame (1 byte)", () => {
		const decoder = new ConnectFrameDecoder({ acceptCompressed: true });
		const endFrame = rawFrame(CONNECT_FLAG_END_STREAM, JSON.stringify({ error: null }));
		// The end frame plus one stray byte in one chunk: the untrustworthy end
		// frame is withheld so no consumer can accept a malformed terminal state.
		expect(decoder.push(Buffer.concat([endFrame, Buffer.from([0x00])]))).toEqual([]);
		expect(decoder.sawEndStream).toBe(true);
		// The decoder stays poisoned: finish() reports the buffered tail.
		expectProtocolError(() => decoder.finish(), "bytes after end-of-stream", "envelope");
	});

	test("complete frame after end-stream does not discard preceding data", () => {
		const decoder = new ConnectFrameDecoder({ acceptCompressed: true });
		const chunk = Buffer.concat([
			rawFrame(0x00, "streamed tokens"),
			rawFrame(CONNECT_FLAG_END_STREAM, JSON.stringify({ error: null })),
			rawFrame(0x00, "forbidden trailing frame"),
		]);
		const frames = decoder.push(chunk);
		expect(frames).toHaveLength(1);
		expect(frames[0]).toEqual({ kind: "data", payload: Buffer.from("streamed tokens") });
		expect(decoder.sawEndStream).toBe(true);
		expectProtocolError(() => decoder.finish(), "bytes after end-of-stream", "envelope");
	});

	test("trailing bytes after end-stream: a chunk pushed after the terminal frame exposes poisonError", () => {
		const decoder = new ConnectFrameDecoder({ acceptCompressed: true });
		decoder.push(rawFrame(CONNECT_FLAG_END_STREAM, JSON.stringify({ error: null })));
		expect(decoder.sawEndStream).toBe(true);
		// Even a single byte pushed after the terminal envelope is a protocol error,
		// but push() does not throw: it buffers the tail and exposes the error via
		// the poison signal so the pump can emit already-decoded prefix frames first.
		expect(decoder.push(Buffer.from([0x00]))).toEqual([]);
		expect(decoder.poisonError).toBeInstanceOf(ConnectProtocolError);
		expect(decoder.poisonError?.kind).toBe("envelope");
		expect(decoder.poisonError?.message).toContain("bytes after end-of-stream");
		// finish() still reports the buffered tail as a protocol error.
		expectProtocolError(() => decoder.finish(), "bytes after end-of-stream", "envelope");
	});
});
