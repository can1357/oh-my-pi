import { describe, expect, it } from "bun:test";
import { type DetectedSpeech, type SpeechDetector, StreamEndpointer } from "../src/stt/endpointer";

/** Reports scripted utterances `[start, end)` once `hangover` samples of silence follow them, like Silero's end-of-speech delay. */
class ScriptedDetector implements SpeechDetector {
	#position = 0;
	#ready: DetectedSpeech[] = [];

	constructor(
		readonly utterances: Array<[start: number, end: number]>,
		readonly hangover = 4000,
	) {}

	acceptWaveform(samples: Float32Array): void {
		this.#position += samples.length;
		this.#collect(false);
	}

	isEmpty(): boolean {
		return this.#ready.length === 0;
	}

	isDetected(): boolean {
		const next = this.utterances[0];
		return next !== undefined && this.#position >= next[0] && this.#position < next[1] + this.hangover;
	}

	front(): DetectedSpeech {
		return this.#ready[0]!;
	}

	pop(): void {
		this.#ready.shift();
	}

	flush(): void {
		this.#collect(true);
	}

	#collect(flush: boolean): void {
		for (let next = this.utterances[0]; next; next = this.utterances[0]) {
			const [start, end] = next;
			if (flush ? this.#position <= start : this.#position < end + this.hangover) return;
			this.utterances.shift();
			this.#ready.push({ start, samples: new Float32Array(Math.min(end, this.#position) - start) });
		}
	}
}

describe("StreamEndpointer", () => {
	it("pads each utterance from the raw stream and never decodes audio twice", () => {
		// 240 ms pre-roll = 3840 samples, 120 ms tail = 1920 samples. The last two
		// utterances are back to back, as when the detector force-splits long speech.
		const detector = new ScriptedDetector([
			[8000, 16000],
			[32000, 40000],
			[44000, 50000],
			[50000, 56000],
		]);
		const endpointer = new StreamEndpointer(detector, { preRollMs: 240, tailMs: 120 });
		// Unique ramp so any reorder, drop, or stale offset after released audio shows up.
		const input = Float32Array.from({ length: 58000 }, (_, i) => i + 1);
		const chunkSizes = [137, 911, 53, 1600, 2203, 7];
		const segments: Float32Array[] = [];
		for (let offset = 0, k = 0; offset < input.length; k += 1) {
			const end = Math.min(input.length, offset + chunkSizes[k % chunkSizes.length]!);
			for (const event of endpointer.push(input.subarray(offset, end))) {
				if (event.kind === "segment") segments.push(event.audio);
			}
			offset = end;
		}
		for (const event of endpointer.flush()) if (event.kind === "segment") segments.push(event.audio);

		const ranges = segments.map(audio => [audio[0]! - 1, audio[audio.length - 1]!] as const);
		expect(ranges).toEqual([
			[4160, 17920],
			[28160, 41920],
			[41920, 51920],
			[51920, 57920],
		]);
		for (const audio of segments) {
			expect(Array.from(audio)).toEqual(Array.from(input.subarray(audio[0]! - 1, audio[audio.length - 1]!)));
		}
	});

	it("commits a recording with no detected speech whole, in windows, without its silent ones", () => {
		const endpointer = new StreamEndpointer(new ScriptedDetector([]), { fallbackWindowMs: 1000 });
		// 30 000 samples of non-speech sound (singing, say), then 15 000 of silence.
		const input = Float32Array.from({ length: 45000 }, (_, i) => (i < 30000 ? 0.01 + i * 1e-6 : 0));
		for (let offset = 0; offset < input.length; offset += 320) {
			expect(endpointer.push(input.subarray(offset, offset + 320))).toEqual([]);
		}

		const segments = endpointer.flush().map(event => Array.from(event.audio));
		expect(segments).toEqual([Array.from(input.subarray(0, 16000)), Array.from(input.subarray(16000, 32000))]);
	});

	it("turns slow previews off within an utterance and back on for the next one", () => {
		const endpointer = new StreamEndpointer(new ScriptedDetector([[0, 16000]], 1600), { partialIntervalMs: 100 });
		const chunk = new Float32Array(1600);
		const partials = () => endpointer.push(chunk).filter(event => event.kind === "partial").length;

		expect(partials()).toBe(1);
		endpointer.notePartialDecode(500);
		endpointer.notePartialDecode(500);
		expect(partials()).toBe(0);
		// Keep feeding until the detector commits the utterance.
		for (let i = 0; i < 9; i++) endpointer.push(chunk);
		expect(endpointer.partialsEnabled).toBe(true);
	});
});
