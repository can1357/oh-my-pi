import { describe, expect, it } from "bun:test";
import { ConnectFrameDecoder, frameConnectMessage } from "../src/providers/connect-frame";

const bytes = (text: string) => new TextEncoder().encode(text);

function decodeAll(decoder: ConnectFrameDecoder, chunks: Uint8Array[]): Array<{ flags: number; text: string }> {
	const frames: Array<{ flags: number; text: string }> = [];
	for (const chunk of chunks) {
		for (const frame of decoder.decode(chunk)) frames.push({ flags: frame.flags, text: frame.payload.toString() });
	}
	return frames;
}

describe("ConnectFrameDecoder", () => {
	it("decodes a frame whose 5-byte header is split across chunks", () => {
		const frame = frameConnectMessage(bytes("hello"), 0x02);
		const chunks = [frame.subarray(0, 1), frame.subarray(1, 3), frame.subarray(3, 4), frame.subarray(4)];
		expect(decodeAll(new ConnectFrameDecoder(), chunks)).toEqual([{ flags: 0x02, text: "hello" }]);
	});

	it("joins a payload spanning three or more chunks", () => {
		const payload = "abcdefghijklmnopqrstuvwxyz";
		const frame = frameConnectMessage(bytes(payload));
		const chunks = [frame.subarray(0, 7), frame.subarray(7, 15), frame.subarray(15, 22), frame.subarray(22)];
		expect(decodeAll(new ConnectFrameDecoder(), chunks)).toEqual([{ flags: 0, text: payload }]);
	});

	it("yields every frame packed into one chunk, keeping a trailing partial frame for later", () => {
		const third = frameConnectMessage(bytes("three"));
		const chunk = Buffer.concat([
			frameConnectMessage(bytes("one")),
			frameConnectMessage(bytes("two"), 0x01),
			third.subarray(0, 6),
		]);
		const decoder = new ConnectFrameDecoder();
		expect(decodeAll(decoder, [chunk])).toEqual([
			{ flags: 0, text: "one" },
			{ flags: 0x01, text: "two" },
		]);
		expect(decodeAll(decoder, [third.subarray(6)])).toEqual([{ flags: 0, text: "three" }]);
	});

	it("throws the configured error for an oversize length only after yielding the frames before it", () => {
		const oversize = Buffer.alloc(5);
		oversize.writeUInt32BE(1024, 1);
		const decoder = new ConnectFrameDecoder({
			limit: { maxPayloadBytes: 16, error: length => new RangeError(`too big: ${length}`) },
		});
		const yielded: string[] = [];
		expect(() => {
			for (const frame of decoder.decode(Buffer.concat([frameConnectMessage(bytes("ok")), oversize]))) {
				yielded.push(frame.payload.toString());
			}
		}).toThrow(new RangeError("too big: 1024"));
		expect(yielded).toEqual(["ok"]);
	});

	it("yields nothing when decode is called without a chunk and nothing is buffered", () => {
		expect([...new ConnectFrameDecoder().decode()]).toEqual([]);
	});
});
