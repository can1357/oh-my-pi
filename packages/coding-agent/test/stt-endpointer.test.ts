import { describe, expect, it } from "bun:test";
import { StreamEndpointer } from "../src/stt/endpointer";

describe("StreamEndpointer pre-roll", () => {
	it("preserves the latest pre-onset samples in order across ring wraps and irregular chunks", () => {
		// 100 ms pre-roll = 1600 samples, deliberately not a multiple of the 480-sample frame,
		// so the ring wraps mid-frame several times before onset.
		const endpointer = new StreamEndpointer({ preRollMs: 100 });
		const frame = 480;
		const silenceSamples = frame * 17; // 8160 samples, > 5 ring capacities
		const speechSamples = frame * 20; // 600 ms of speech
		const input = new Float32Array(silenceSamples + speechSamples);
		// Unique, sub-threshold ramp so any reorder/drop in the pre-roll is detectable.
		for (let i = 0; i < silenceSamples; i += 1) input[i] = (i + 1) * 1e-7;
		for (let i = silenceSamples; i < input.length; i += 1) input[i] = i % 2 === 0 ? 0.5 : -0.5;

		const chunkSizes = [137, 911, 53, 480, 1203, 7];
		const events = [];
		for (let offset = 0, k = 0; offset < input.length; k += 1) {
			const end = Math.min(input.length, offset + chunkSizes[k % chunkSizes.length]!);
			events.push(...endpointer.push(input.subarray(offset, end)));
			offset = end;
		}
		events.push(...endpointer.flush());

		const segments = events.filter(event => event.kind === "segment");
		expect(segments).toHaveLength(1);
		const audio = segments[0]!.audio;
		// The segment is the 1600 samples before the onset frame, then the onset frame and the rest
		// of the input, each sample exactly once.
		const preRoll = 1600;
		const segmentStart = silenceSamples - preRoll;
		expect(Array.from(audio)).toEqual(Array.from(input.subarray(segmentStart, segmentStart + audio.length)));
		expect(audio.length).toBe(input.length - segmentStart);
	});
});

const FRAME = 480; // 30 ms at 16 kHz

/** Frames of a square wave whose RMS equals each given level. */
function framesAt(levels: number[]): Float32Array {
	const out = new Float32Array(levels.length * FRAME);
	levels.forEach((level, f) => {
		for (let i = 0; i < FRAME; i += 1) out[f * FRAME + i] = i % 2 === 0 ? level : -level;
	});
	return out;
}

function concat(...parts: Float32Array[]): Float32Array {
	const out = new Float32Array(parts.reduce((n, part) => n + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

function segmentsOf(input: Float32Array): Float32Array[] {
	const endpointer = new StreamEndpointer();
	return [...endpointer.push(input), ...endpointer.flush()]
		.filter(event => event.kind === "segment")
		.map(event => event.audio);
}

const roomNoise = (frames: number) => framesAt(Array(frames).fill(0.002));

describe("StreamEndpointer segmentation", () => {
	it("keeps a softer phrase that follows louder speech in the same segment", () => {
		// Loud syllables with quiet in-between frames (above the room noise), then a 900 ms softer
		// phrase, then loud speech again: no real pause anywhere.
		const loud = Array.from({ length: 100 }, (_, f) => (f % 4 === 0 ? 0.1 : 0.009));
		const speech = framesAt([...loud, ...Array(30).fill(0.02), ...loud]);
		const segments = segmentsOf(concat(roomNoise(20), speech, roomNoise(30)));

		expect(segments).toHaveLength(1);
		expect(segments[0]!.length).toBeGreaterThanOrEqual(speech.length);
	});

	it("ignores an isolated click after a pause, without a preview", () => {
		// A key click is one loud frame; the pre-roll before it is not speech. A preview of it would
		// be decoded (often as "Yeah.") and stay on screen, since no segment ever replaces it.
		const endpointer = new StreamEndpointer();
		const events = [...endpointer.push(concat(roomNoise(40), framesAt([0.3]), roomNoise(30))), ...endpointer.flush()];
		expect(events).toHaveLength(0);
	});

	it("discards a click that is still open when the stream ends", () => {
		// Push-to-talk release: the click lands ~250 ms before recording stops.
		const segments = segmentsOf(concat(roomNoise(40), framesAt([0.3]), roomNoise(8)));
		expect(segments).toHaveLength(0);
	});

	it("commits a short spoken word", () => {
		const segments = segmentsOf(concat(roomNoise(40), framesAt(Array(8).fill(0.05)), roomNoise(30)));
		expect(segments).toHaveLength(1);
	});
});

describe("StreamEndpointer previews", () => {
	/** Feeds continuous speech in 100 ms recorder chunks, "decoding" each preview in `decodeMs(audioMs)`; returns each preview's length in ms. */
	function previewLengths(seconds: number, decodeMs: (audioMs: number) => number): number[] {
		const endpointer = new StreamEndpointer();
		const speech = framesAt(Array(Math.round((seconds * 1000) / 30)).fill(0.1));
		const lengths: number[] = [];
		for (let offset = 0; offset < speech.length; offset += 1600) {
			for (const event of endpointer.push(speech.subarray(offset, offset + 1600))) {
				if (event.kind !== "partial") continue;
				const audioMs = event.audio.length / 16;
				lengths.push(audioMs);
				endpointer.notePartialDecode(decodeMs(audioMs), audioMs);
			}
		}
		return lengths;
	}

	it("keeps previewing a long segment whose decode cost grows with its length", () => {
		// Parakeet on a busy CPU: ~100 ms per second of audio, so an 11 s preview takes ~1.1 s.
		const lengths = previewLengths(11, audioMs => audioMs * 0.1);
		expect(lengths.at(-1)!).toBeGreaterThan(10_000);
	});

	it("stops previews when every decode takes seconds", () => {
		// Whisper on CPU decodes a fixed 30 s window, ~3 s whatever the audio length.
		expect(previewLengths(11, () => 3000)).toHaveLength(2);
	});
});
