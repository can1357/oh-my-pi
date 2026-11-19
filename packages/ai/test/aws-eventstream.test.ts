import { describe, expect, test } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import {
	crc32,
	decodeEventStream,
	decodeMessage,
	MAX_HEADERS_LEN,
	MAX_MESSAGE_LEN,
} from "@oh-my-pi/pi-ai/providers/aws-eventstream";

// ---- Frame builder (mirrors @smithy/eventstream-codec but in-process so the
// test owns the bytes). The decoder is the production code; we encode here for
// fixture generation only.

function encodeStringHeader(name: string, value: string): Uint8Array {
	const nameBytes = new TextEncoder().encode(name);
	const valueBytes = new TextEncoder().encode(value);
	if (nameBytes.length > 255) throw new Error("name too long");
	const buf = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
	const view = new DataView(buf.buffer);
	let p = 0;
	view.setUint8(p, nameBytes.length);
	p += 1;
	buf.set(nameBytes, p);
	p += nameBytes.length;
	view.setUint8(p, 7); // string type
	p += 1;
	view.setUint16(p, valueBytes.length, false);
	p += 2;
	buf.set(valueBytes, p);
	return buf;
}

function encodeFrame(headers: Record<string, string>, payload: Uint8Array): Uint8Array {
	const headerChunks: Uint8Array[] = [];
	for (const name in headers) headerChunks.push(encodeStringHeader(name, headers[name]));
	const headerLen = headerChunks.reduce((s, c) => s + c.length, 0);
	const headerBytes = new Uint8Array(headerLen);
	let off = 0;
	for (const c of headerChunks) {
		headerBytes.set(c, off);
		off += c.length;
	}
	const total = 4 + 4 + 4 + headerLen + payload.length + 4;
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	view.setUint32(0, total, false);
	view.setUint32(4, headerLen, false);
	const preludeCrc = crc32(out.subarray(0, 8));
	view.setUint32(8, preludeCrc, false);
	out.set(headerBytes, 12);
	out.set(payload, 12 + headerLen);
	const msgCrc = crc32(out.subarray(0, total - 4));
	view.setUint32(total - 4, msgCrc, false);
	return out;
}

function streamFrom(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	let i = 0;
	return new ReadableStream({
		pull(controller) {
			if (i < chunks.length) controller.enqueue(chunks[i++]);
			else controller.close();
		},
	});
}

async function collect(
	stream: ReadableStream<Uint8Array>,
): Promise<Array<{ headers: Record<string, string>; text: string }>> {
	const out: Array<{ headers: Record<string, string>; text: string }> = [];
	for await (const msg of decodeEventStream(stream)) {
		out.push({ headers: msg.headers, text: new TextDecoder().decode(msg.payload) });
	}
	return out;
}

describe("aws-eventstream", () => {
	test("CRC32 matches known vectors", () => {
		// Standard CRC32 of "123456789" = 0xCBF43926 (zlib/IEEE).
		const bytes = new TextEncoder().encode("123456789");
		expect(crc32(bytes)).toBe(0xcbf43926);
		expect(crc32(new Uint8Array(0))).toBe(0);
	});

	test("decodes a single full-message frame", async () => {
		const payload = new TextEncoder().encode('{"messageStart":{"role":"assistant"}}');
		const frame = encodeFrame(
			{ ":message-type": "event", ":event-type": "messageStart", ":content-type": "application/json" },
			payload,
		);
		const decoded = decodeMessage(frame);
		expect(decoded.headers[":event-type"]).toBe("messageStart");
		expect(new TextDecoder().decode(decoded.payload)).toBe('{"messageStart":{"role":"assistant"}}');

		const collected = await collect(streamFrom([frame]));
		expect(collected).toHaveLength(1);
		expect(collected[0].headers[":message-type"]).toBe("event");
	});

	test("stitches a frame split across two chunks", async () => {
		const payload = new TextEncoder().encode('{"contentBlockDelta":{"delta":{"text":"hi"}}}');
		const frame = encodeFrame({ ":message-type": "event", ":event-type": "contentBlockDelta" }, payload);
		const mid = Math.floor(frame.length / 2);
		const chunks = [frame.subarray(0, mid), frame.subarray(mid)];
		const collected = await collect(streamFrom(chunks.map(c => new Uint8Array(c))));
		expect(collected).toHaveLength(1);
		expect(collected[0].headers[":event-type"]).toBe("contentBlockDelta");
		expect(collected[0].text).toContain('"hi"');
	});

	test("decodes multiple messages packed into one chunk", async () => {
		const a = encodeFrame(
			{ ":message-type": "event", ":event-type": "messageStart" },
			new TextEncoder().encode('{"role":"assistant"}'),
		);
		const b = encodeFrame(
			{ ":message-type": "event", ":event-type": "contentBlockDelta" },
			new TextEncoder().encode('{"x":1}'),
		);
		const c = encodeFrame(
			{ ":message-type": "event", ":event-type": "messageStop" },
			new TextEncoder().encode('{"stopReason":"end_turn"}'),
		);
		const merged = new Uint8Array(a.length + b.length + c.length);
		merged.set(a, 0);
		merged.set(b, a.length);
		merged.set(c, a.length + b.length);

		const collected = await collect(streamFrom([merged]));
		expect(collected.map(x => x.headers[":event-type"])).toEqual([
			"messageStart",
			"contentBlockDelta",
			"messageStop",
		]);
	});

	test("surfaces exception event headers and payload", async () => {
		const payload = new TextEncoder().encode('{"message":"input too long"}');
		const frame = encodeFrame(
			{
				":message-type": "exception",
				":exception-type": "validationException",
				":content-type": "application/json",
			},
			payload,
		);
		const collected = await collect(streamFrom([frame]));
		expect(collected).toHaveLength(1);
		expect(collected[0].headers[":message-type"]).toBe("exception");
		expect(collected[0].headers[":exception-type"]).toBe("validationException");
		expect(collected[0].text).toContain("input too long");
	});

	test("throws on prelude CRC mismatch", () => {
		const frame = encodeFrame({ ":event-type": "x" }, new Uint8Array(0));
		frame[8] ^= 0xff; // flip a byte in the prelude CRC
		expect(() => decodeMessage(frame)).toThrow(/prelude CRC/);
	});

	test("throws on message CRC mismatch", () => {
		const frame = encodeFrame({ ":event-type": "x" }, new TextEncoder().encode("{}"));
		frame[frame.length - 1] ^= 0xff;
		expect(() => decodeMessage(frame)).toThrow(/message CRC/);
	});

	/** A 12-byte prelude declaring `total` and `headersLen`, with a valid prelude CRC. */
	function prelude(total: number, headersLen: number): Uint8Array {
		const out = new Uint8Array(12);
		const view = new DataView(out.buffer);
		view.setUint32(0, total, false);
		view.setUint32(4, headersLen, false);
		view.setUint32(8, crc32(out.subarray(0, 8)), false);
		return out;
	}

	/** A frame with caller-supplied raw header-block bytes and valid CRCs. */
	function rawFrame(headers: Uint8Array, payload: Uint8Array): Uint8Array {
		const total = 16 + headers.length + payload.length;
		const out = new Uint8Array(total);
		out.set(prelude(total, headers.length));
		out.set(headers, 12);
		out.set(payload, 12 + headers.length);
		new DataView(out.buffer).setUint32(total - 4, crc32(out.subarray(0, total - 4)), false);
		return out;
	}

	async function frameError(promise: Promise<unknown>): Promise<AIError.EventStreamFrameError> {
		const error = await promise.then(
			() => undefined,
			(err: unknown) => err,
		);
		if (!(error instanceof AIError.EventStreamFrameError)) throw new Error(`expected frame error, got ${error}`);
		return error;
	}

	const oversized = prelude(MAX_MESSAGE_LEN + 1, 0);
	const badCrc = prelude(MAX_MESSAGE_LEN, 0);
	badCrc[11] ^= 0xff;
	test.each([
		["an oversized total length", [oversized], "exceeds maximum"],
		["an oversized total split mid-prelude", [oversized.subarray(0, 5), oversized.subarray(5)], "exceeds maximum"],
		["a corrupt prelude CRC", [badCrc], "prelude CRC"],
		["headers longer than the message", [prelude(64, 64)], "exceeds message length"],
		["headers over the cap", [prelude(16 + MAX_HEADERS_LEN + 1, MAX_HEADERS_LEN + 1)], "exceeds maximum"],
	])("rejects %s before buffering the body", async (_, head, message) => {
		let pulls = 0;
		// Up to 8 MiB of filler follows the prelude; a bounded decoder never pulls it.
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (pulls < head.length) controller.enqueue(head[pulls]);
				else if (pulls < head.length + 128) controller.enqueue(new Uint8Array(64 * 1024));
				else controller.close();
				pulls += 1;
			},
		});
		const error = await frameError(collect(stream));
		expect(error.kind).toBe("malformed");
		expect(error.message).toContain(message);
		expect(pulls).toBe(head.length);
	});

	test.each([
		["name", new Uint8Array([3, 0x61]), new Uint8Array(0)],
		// The payload after a short header block must not be read as header bytes.
		["string value", new Uint8Array([1, 0x78, 7, 0, 4, 0x61]), new TextEncoder().encode("bcd")],
	])("a header %s read past the header block raises a frame error", (field, headers, payload) => {
		expect(() => decodeMessage(rawFrame(headers, payload))).toThrow(`header ${field} overruns`);
	});

	test("decodes a header-only frame with an empty payload split across chunks", async () => {
		const headers = { ":message-type": "error", ":error-code": "InternalFailure" };
		const frame = encodeFrame(headers, new Uint8Array(0));
		expect(await collect(streamFrom([frame.subarray(0, 20), frame.subarray(20)]))).toEqual([{ headers, text: "" }]);
	});

	test("reassembles frames fed one byte at a time without clobbering yielded payloads", async () => {
		const a = encodeFrame({ ":event-type": "a" }, new TextEncoder().encode("first"));
		const b = encodeFrame({ ":event-type": "b" }, new TextEncoder().encode("second"));
		const bytes = [...a, ...b].map(byte => new Uint8Array([byte]));
		const payloads: Uint8Array[] = [];
		for await (const msg of decodeEventStream(streamFrom(bytes))) payloads.push(msg.payload);
		expect(payloads.map(p => new TextDecoder().decode(p))).toEqual(["first", "second"]);
	});

	test.each([6, 12, 20])("a body cut at byte %d raises a truncated frame error", async cut => {
		const frame = encodeFrame({ ":event-type": "x" }, new TextEncoder().encode("{}"));
		expect((await frameError(collect(streamFrom([frame.subarray(0, cut)])))).kind).toBe("truncated");
	});
});
