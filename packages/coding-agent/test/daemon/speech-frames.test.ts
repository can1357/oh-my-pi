import { describe, expect, it } from "bun:test";
import {
	decodeMessage,
	encodeFrame,
	encodeMessage,
	FRAME_PCM,
	FrameDecoder,
	type SpeechFrame,
} from "../../src/daemon/modules/speech-frames";

function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

function decodeAll(chunks: Uint8Array[]): SpeechFrame[] {
	const decoder = new FrameDecoder();
	const frames: SpeechFrame[] = [];
	for (const chunk of chunks) decoder.push(chunk, frame => frames.push(frame));
	return frames;
}

const transcriptRequest = { type: "transcribe", id: "req-1", language: "fr", text: "héllo wörld ✓" };
const audioMessage = {
	type: "audio",
	id: "tts-7",
	sampleRate: 24_000,
	samples: new Float32Array([0, 1, -1, 0.5, -0.25, 3.4028234663852886e38, 1e-40]),
};

describe("speech frame codec", () => {
	it("round-trips a JSON message unchanged (worker would otherwise see a different request)", () => {
		const [frame] = decodeAll([encodeMessage(transcriptRequest)]);
		expect(frame!.payload).toBeUndefined();
		expect(decodeMessage<typeof transcriptRequest>(frame!)).toEqual(transcriptRequest);
	});

	it("round-trips a PCM message: samples come back as the same Float32Array field and no `$pcm` leaks", () => {
		const [frame] = decodeAll([encodeMessage(audioMessage)]);
		const decoded = decodeMessage<typeof audioMessage & Record<string, unknown>>(frame!);
		expect(decoded.samples).toBeInstanceOf(Float32Array);
		expect(Array.from(decoded.samples)).toEqual(Array.from(audioMessage.samples));
		expect({ ...decoded, samples: undefined }).toEqual({ ...audioMessage, samples: undefined });
		expect("$pcm" in decoded).toBe(false);
	});

	it("decodes a frame split at every byte boundary (tunnels deliver arbitrary chunking)", () => {
		const stream = concat([
			encodeMessage(transcriptRequest),
			encodeMessage(audioMessage),
			encodeMessage({ type: "pong", id: "p" }),
		]);
		const expected = decodeAll([stream]).map(frame => decodeMessage(frame));
		expect(expected).toHaveLength(3);
		for (let split = 0; split <= stream.length; split++) {
			const frames = decodeAll([stream.subarray(0, split), stream.subarray(split)]);
			expect(frames.map(frame => decodeMessage(frame))).toEqual(expected);
		}
		const byteByByte = decodeAll(Array.from(stream, (_, at) => stream.subarray(at, at + 1)));
		expect(byteByByte.map(frame => decodeMessage(frame))).toEqual(expected);
	});

	it("emits every frame of a chunk holding several, in order (no frame dropped or merged)", () => {
		const ids = ["a", "b", "c", "d"];
		const frames = decodeAll([concat(ids.map(id => encodeFrame({ type: "ping", id })))]);
		expect(frames.map(frame => frame.header.id)).toEqual(ids);
	});

	it("keeps a decoded payload intact after later frames reuse the decoder buffer", () => {
		const first = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
		const decoder = new FrameDecoder();
		const frames: SpeechFrame[] = [];
		decoder.push(encodeFrame({ type: "a", id: "1" }, first), frame => frames.push(frame));
		decoder.push(encodeFrame({ type: "b", id: "2" }, new Uint8Array(8).fill(0xee)), frame => frames.push(frame));
		expect(Array.from(frames[0]!.payload!)).toEqual(Array.from(first));
	});

	it("writes the length prefix and PCM samples little-endian (workers on any host read the same bytes)", () => {
		const frame = encodeMessage({ type: "audio", id: "x", samples: new Float32Array([1, -2]) });
		const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
		expect(view.getUint32(0, true)).toBe(frame.length - 4);
		expect(frame[4]).toBe(FRAME_PCM);
		const headerLength = view.getUint32(5, true);
		const samples = Array.from(frame.subarray(9 + headerLength));
		// 1.0f = 0x3f800000, -2.0f = 0xc0000000, least significant byte first.
		expect(samples).toEqual([0x00, 0x00, 0x80, 0x3f, 0x00, 0x00, 0x00, 0xc0]);
	});

	it("throws on an oversized length prefix instead of buffering a desynchronized stream", () => {
		const corrupt = new Uint8Array([0xff, 0xff, 0xff, 0x7f, 0x00]);
		expect(() => new FrameDecoder().push(corrupt, () => {})).toThrow(/exceeds the frame limit/);
	});
});
