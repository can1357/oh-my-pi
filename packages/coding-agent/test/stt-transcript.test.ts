import { describe, expect, it } from "bun:test";
import { DEFAULT_ENDPOINTER_CONFIG } from "@oh-my-pi/pi-coding-agent/stt/endpointer";
import {
	AudioChunker,
	formatTranscriptTime,
	type SttSegment,
	segmentTimedTokens,
	segmentWhisperChunks,
	trimSegmentsToSpeech,
} from "@oh-my-pi/pi-coding-agent/stt/transcript";
import { parseVideoTimestamp } from "@oh-my-pi/pi-coding-agent/utils/video";

const rounded = (segments: SttSegment[]) =>
	segments.map(segment => ({
		start: Math.round(segment.start * 100) / 100,
		end: Math.round(segment.end * 100) / 100,
		text: segment.text,
	}));

// Parakeet TDT tokens for synthesized speech: speech ends at 3.52 s, a 2.2 s
// pause follows, and the model emits the first sentence's period at 5.04 s.
const PARAKEET_TOKENS = {
	tokens: [
		" H",
		"ello",
		" and",
		" wel",
		"c",
		"ome",
		",",
		" this",
		" is",
		" a",
		" test",
		" of",
		" the",
		" trans",
		"cri",
		"p",
		"tion",
		" fe",
		"at",
		"ure",
		".",
		" A",
		"fter",
		" two",
		" sec",
		"ond",
		"s",
		" of",
		" sil",
		"ence",
		",",
		" the",
		" spe",
		"ak",
		"er",
		" continu",
		"es",
		" with",
		" the",
		" sec",
		"ond",
		" sent",
		"ence",
		".",
		" Fin",
		"ally",
		",",
		" the",
		" num",
		"ber",
		" ",
		"4",
		"2",
		" app",
		"e",
		"ars",
		" at",
		" the",
		" end",
		".",
	],
	timestamps: [
		0, 0.16, 0.4, 0.56, 0.72, 0.88, 0.96, 1.12, 1.36, 1.52, 1.6, 1.92, 2.08, 2.24, 2.56, 2.72, 2.96, 3.2, 3.44, 3.76,
		5.04, 5.44, 5.76, 6, 6.32, 6.48, 6.64, 6.8, 6.96, 7.28, 7.52, 7.68, 7.84, 8.08, 8.24, 8.4, 8.72, 8.88, 9.04, 9.2,
		9.44, 9.6, 9.92, 10.16, 10.4, 10.72, 10.96, 11.12, 11.28, 11.52, 11.68, 11.84, 12.08, 12.32, 12.4, 12.56, 12.72,
		12.8, 12.96, 13.2,
	],
	durations: [
		0.16, 0.24, 0.16, 0.16, 0.16, 0.08, 0.16, 0.24, 0.16, 0.08, 0.32, 0.16, 0.16, 0.32, 0.16, 0.24, 0.24, 0.24, 0.32,
		0.32, 0.08, 0.32, 0.24, 0.16, 0.16, 0.16, 0.16, 0.16, 0.32, 0.24, 0.16, 0.16, 0.24, 0.16, 0.16, 0.32, 0.16, 0.16,
		0.16, 0.24, 0.16, 0.32, 0.24, 0.24, 0.32, 0.24, 0.16, 0.16, 0.24, 0.16, 0.16, 0.24, 0.24, 0.08, 0.16, 0.16, 0.08,
		0.16, 0.24, 0.08,
	],
};

describe("segmentTimedTokens", () => {
	it("splits Parakeet tokens into sentences that end with their last word, not a late period", () => {
		expect(rounded(segmentTimedTokens(PARAKEET_TOKENS, 13.34))).toEqual([
			{ start: 0, end: 4.08, text: "Hello and welcome, this is a test of the transcription feature." },
			{
				start: 5.44,
				end: 10.16,
				text: "After two seconds of silence, the speaker continues with the second sentence.",
			},
			{ start: 10.4, end: 13.2, text: "Finally, the number 42 appears at the end." },
		]);
	});

	it("keeps a decimal point inside its sentence", () => {
		const segments = segmentTimedTokens(
			{
				tokens: [" Version", " ", "3", ".", "5", " ships", " today", "."],
				timestamps: [0, 2.5, 2.6, 2.7, 2.8, 3, 3.4, 3.8],
				durations: [2.4, 0.1, 0.1, 0.1, 0.1, 0.3, 0.3, 0.1],
			},
			4,
		);
		expect(segments.map(segment => segment.text)).toEqual(["Version 3.5 ships today."]);
	});

	it("keeps a short abbreviation with the words after it", () => {
		const segments = segmentTimedTokens(
			{
				tokens: [" Mr", ".", " Webb", " arrived", " late", "."],
				timestamps: [0, 0.3, 0.5, 0.9, 1.4, 1.9],
				durations: [0.3, 0.1, 0.4, 0.5, 0.4, 0.1],
			},
			2,
		);
		expect(segments.map(segment => segment.text)).toEqual(["Mr. Webb arrived late."]);
	});

	it("starts a new segment after a one-second pause even without punctuation", () => {
		const segments = segmentTimedTokens(
			{
				tokens: [" so", " we", " wait", " and", " then", " go"],
				timestamps: [0, 0.3, 0.6, 2.0, 2.3, 2.6],
				durations: [0.2, 0.2, 0.2, 0.2, 0.2, 0.2],
			},
			3,
		);
		expect(rounded(segments)).toEqual([
			{ start: 0, end: 0.8, text: "so we wait" },
			{ start: 2, end: 2.8, text: "and then go" },
		]);
	});

	it("breaks run-on speech at the first word boundary past twelve seconds", () => {
		const tokens: string[] = [];
		const timestamps: number[] = [];
		const durations: number[] = [];
		for (let second = 0; second < 20; second++) {
			tokens.push(" wor", "d");
			timestamps.push(second, second + 0.5);
			durations.push(0.4, 0.4);
		}
		const segments = segmentTimedTokens({ tokens, timestamps, durations }, 20);
		expect(rounded(segments).map(({ start, end }) => [start, end])).toEqual([
			[0, 11.9],
			[12, 19.9],
		]);
		expect(segments.every(segment => segment.text.split(" ").every(word => word === "word"))).toBe(true);
	});
});

describe("segmentWhisperChunks", () => {
	it("ends an unclosed final chunk at the end of the audio and drops blank chunks", () => {
		expect(
			segmentWhisperChunks(
				[
					{ text: " Hello there.", timestamp: [0, 1.5] },
					{ text: "  ", timestamp: [1.5, 2] },
					{ text: " Still talking", timestamp: [2, null] },
				],
				7.25,
			),
		).toEqual([
			{ start: 0, end: 1.5, text: "Hello there." },
			{ start: 2, end: 7.25, text: "Still talking" },
		]);
	});
});

describe("trimSegmentsToSpeech", () => {
	const SAMPLE_RATE = 16_000;
	// 10 s of faint noise with speech-level tones at 2-4 s and 6-8 s.
	const audio = new Float32Array(10 * SAMPLE_RATE);
	for (let i = 0; i < audio.length; i++) {
		const t = i / SAMPLE_RATE;
		const voiced = (t >= 2 && t < 4) || (t >= 6 && t < 8);
		audio[i] = voiced ? 0.5 * Math.sin(2 * Math.PI * 220 * t) : 0.001 * Math.sin(2 * Math.PI * 1234.5 * t);
	}

	it("pulls segments that span silence in to their speech, stopping before the next segment", () => {
		// Whisper-shaped: the first segment runs from the window start past the next onset.
		const [first, second] = trimSegmentsToSpeech(
			[
				{ start: 0, end: 6.2, text: "first" },
				{ start: 6.05, end: 10, text: "second" },
			],
			audio,
			SAMPLE_RATE,
			DEFAULT_ENDPOINTER_CONFIG,
		);
		expect(first!.start).toBeGreaterThanOrEqual(1.85);
		expect(first!.start).toBeLessThan(2);
		expect(first!.end).toBeGreaterThan(4);
		expect(first!.end).toBeLessThanOrEqual(4.15);
		expect(second!.start).toBe(6.05);
		expect(second!.end).toBeGreaterThan(8);
		expect(second!.end).toBeLessThanOrEqual(8.15);
	});

	it("keeps a segment's times when nothing inside it is voiced", () => {
		const quiet = { start: 8.5, end: 9.5, text: "breath" };
		expect(trimSegmentsToSpeech([quiet], audio, SAMPLE_RATE, DEFAULT_ENDPOINTER_CONFIG)).toEqual([quiet]);
	});
});

describe("AudioChunker", () => {
	const SAMPLE_RATE = 16_000;
	const gaps: Array<[number, number]> = [
		[24, 24.6],
		[51, 51.6],
	];
	// 75 s of a 440 Hz tone with two short silent gaps where a cut belongs.
	const signal = new Float32Array(75 * SAMPLE_RATE);
	for (let i = 0; i < signal.length; i++) {
		const t = i / SAMPLE_RATE;
		const silent = gaps.some(([from, to]) => t >= from && t < to);
		signal[i] = silent ? 0 : 0.5 * Math.sin(2 * Math.PI * 440 * t);
	}

	it("cuts inside pauses and covers every sample exactly once at the right offset", () => {
		const chunker = new AudioChunker();
		const chunks = [];
		for (let start = 0; start < signal.length; start += 12_345) {
			chunks.push(...chunker.push(signal.subarray(start, Math.min(signal.length, start + 12_345))));
		}
		const tail = chunker.flush();
		if (tail) chunks.push(tail);

		expect(chunks).toHaveLength(3);
		let expectedOffset = 0;
		for (const chunk of chunks) {
			expect(chunk.offset).toBe(expectedOffset);
			expect(chunk.audio.length).toBeLessThanOrEqual(30 * SAMPLE_RATE);
			expect(chunk.audio).toEqual(signal.subarray(chunk.offset, chunk.offset + chunk.audio.length));
			expectedOffset += chunk.audio.length;
		}
		expect(expectedOffset).toBe(signal.length);
		const cuts = chunks.slice(1).map(chunk => chunk.offset / SAMPLE_RATE);
		cuts.forEach((cut, index) => {
			expect(cut).toBeGreaterThan(gaps[index]![0]);
			expect(cut).toBeLessThan(gaps[index]![1]);
		});
	});
});

describe("formatTranscriptTime", () => {
	it("carries rounding into the next minute and hour", () => {
		expect(formatTranscriptTime(5.04)).toBe("0:05.0");
		expect(formatTranscriptTime(59.96)).toBe("1:00.0");
		expect(formatTranscriptTime(3599.96)).toBe("1:00:00.0");
		expect(formatTranscriptTime(3725.34)).toBe("1:02:05.3");
	});

	it("produces times that read back as video timestamp selectors", () => {
		for (const seconds of [0, 3.5, 65.3, 599.9, 3725.3, 7322.1]) {
			expect(parseVideoTimestamp(formatTranscriptTime(seconds))).toBeCloseTo(seconds, 5);
		}
	});
});
