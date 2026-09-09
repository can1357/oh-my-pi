import { describe, expect, it } from "bun:test";
import {
	CompressionStats,
	DetectedPattern,
	MemoryCompressor,
	PatternDetector,
} from "@oh-my-pi/pi-mnemopi/core/patterns";

describe("memory compression", () => {
	it("reports savings and zero-size stats", () => {
		expect(
			new CompressionStats({ originalSize: 100, compressedSize: 70, ratio: 0.7, method: "dict" }).savingsPercent,
		).toBeCloseTo(30);
		expect(
			new CompressionStats({ originalSize: 0, compressedSize: 0, ratio: 1, method: "none" }).savingsPercent,
		).toBe(0);
	});

	it("round-trips dictionary and RLE compression", () => {
		const compressor = new MemoryCompressor();
		const dictText = "api key secret";
		const [dictCompressed, dictStats] = compressor.compress(dictText, "dict");
		expect(dictStats.method).toBe("dict");
		expect(dictCompressed.length).toBeLessThan(dictText.length);
		expect(compressor.decompress(dictCompressed, "dict")).toBe(dictText);

		const rleText = "aaaaabbbbbccccc";
		const [rleCompressed, rleStats] = compressor.compress(rleText, "rle");
		expect(rleStats.method).toBe("rle");
		expect(compressor.decompress(rleCompressed, "rle")).toBe(rleText);
	});

	it("uses deterministic semantic truncation and batch metadata", () => {
		const compressor = new MemoryCompressor();
		const [longCompressed, stats] = compressor.compress("x".repeat(600), "semantic");
		expect(stats.method).toBe("semantic");
		expect(longCompressed.length).toBeLessThan(600);
		expect(compressor.compress("Short text", "semantic")[0]).toBe("Short text");

		const [batch, batchStats] = compressor.compressBatch(
			[
				{ content: "remember that the user said hello" },
				{ content: "the user asked about mnemopi" },
				{ content: "conversation about memory systems" },
			],
			"dict",
		);
		expect(batch).toHaveLength(3);
		expect(batchStats.memoriesCompressed).toBe(3);
		expect(batch.every(memory => memory._compressed === true)).toBe(true);
	});
});

describe("pattern detection", () => {
	it("detects temporal hour and weekday patterns", () => {
		const detector = new PatternDetector(0.3);
		const memories = [
			{ content: "Morning meeting", timestamp: "2026-01-01T09:00:00" },
			{ content: "Code review", timestamp: "2026-01-01T10:00:00" },
			{ content: "Standup", timestamp: "2026-01-02T09:00:00" },
			{ content: "Planning", timestamp: "2026-01-03T09:00:00" },
		];
		const patterns = detector.detectTemporal(memories);
		expect(patterns.some(pattern => pattern.patternType === "temporal")).toBe(true);
		expect(patterns.some(pattern => pattern.description.includes("09:00"))).toBe(true);
		expect(detector.detectTemporal([{ content: "Only one", timestamp: "2026-01-01T09:00:00" }])).toEqual([]);
	});

	it("detects frequent keywords and co-occurrence", () => {
		const detector = new PatternDetector(0.1);
		const patterns = detector.detectContent([
			{ content: "The user likes Python programming and Rust language" },
			{ content: "Python programming and Rust language are both great" },
			{ content: "Comparing Python programming with Rust language" },
			{ content: "Something unrelated" },
		]);
		expect(patterns.some(pattern => pattern.description.toLowerCase().includes("python"))).toBe(true);
		expect(patterns.some(pattern => pattern.description.toLowerCase().includes("co-occurring"))).toBe(true);
	});

	it("detects source sequences and sorts combined output by confidence", () => {
		const detector = new PatternDetector(0.1);
		const memories = [
			{ content: "User asks question", source: "user", timestamp: "2026-01-01T09:00:00" },
			{ content: "Agent responds", source: "agent", timestamp: "2026-01-01T09:01:00" },
			{ content: "User asks again", source: "user", timestamp: "2026-01-01T09:05:00" },
			{ content: "Agent responds again", source: "agent", timestamp: "2026-01-01T09:06:00" },
		];
		const sequence = detector.detectSequence(memories);
		expect(sequence.some(pattern => pattern.description.includes("'user' often followed by 'agent'"))).toBe(true);
		const all = detector.detectAll(memories);
		for (let i = 1; i < all.length; i++) {
			const previous = all[i - 1];
			const current = all[i];
			if (previous === undefined || current === undefined) {
				throw new Error("Pattern sort check encountered a missing element");
			}
			expect(previous.confidence).toBeGreaterThanOrEqual(current.confidence);
		}
	});

	it("summarizes and serializes detected patterns", () => {
		const detector = new PatternDetector(0.1);
		const summary = detector.summarizePatterns([
			{ content: "Python is great", source: "user", timestamp: "2026-01-01T09:00:00" },
			{ content: "Agent agrees", source: "agent", timestamp: "2026-01-01T09:01:00" },
		]);
		expect(summary.total_memories).toBe(2);
		expect(summary.patterns_found).toBeDefined();

		const pattern = new DetectedPattern({
			pattern_type: "content",
			description: "Test pattern",
			confidence: 0.85,
			samples: ["sample1", "sample2"],
			metadata: { key: "value" },
		});
		expect(pattern.toDict()).toEqual({
			pattern_type: "content",
			description: "Test pattern",
			confidence: 0.85,
			samples: ["sample1", "sample2"],
			metadata: { key: "value" },
		});
	});
});
