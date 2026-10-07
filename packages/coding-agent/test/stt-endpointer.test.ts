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
		// The pre-roll window is the most recent 1600 samples up to and including the onset frame.
		const preRoll = 1600;
		const onsetEnd = silenceSamples + frame;
		expect(Array.from(audio.subarray(0, preRoll))).toEqual(Array.from(input.subarray(onsetEnd - preRoll, onsetEnd)));
	});
});
