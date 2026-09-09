import { describe, expect, it } from "bun:test";
import { CATEGORY_MAP, encode, PHRASE_MAP, STRUCTURAL_REPLACEMENTS } from "@oh-my-pi/pi-mnemopi/core/aaak";
import {
	classifyBatch,
	classifyMemory,
	getDecayRate,
	getTypePriority,
	MemoryType,
	shouldConsolidate,
} from "@oh-my-pi/pi-mnemopi/core/typed-memory";

describe("typed memory classification", () => {
	it("classifies the Python integration test cases", () => {
		const fact = classifyMemory("The API is at https://example.com");
		expect(fact.memory_type).toBe(MemoryType.FACT);
		expect(fact.memoryType).toBe(MemoryType.FACT);
		expect(fact.confidence).toBeGreaterThan(0.5);

		expect(classifyMemory("I prefer dark mode").memory_type).toBe(MemoryType.PREFERENCE);
		expect(classifyMemory("I will deliver by Friday").memory_type).toBe(MemoryType.COMMITMENT);
		expect(classifyMemory("Alice decided to use PostgreSQL for the new project.").memory_type).toBe(
			MemoryType.DECISION,
		);
	});

	it("applies Python fallback classification for empty, short, and long unmatched text", () => {
		expect(classifyMemory("   ")).toEqual({
			memory_type: MemoryType.UNKNOWN,
			memoryType: MemoryType.UNKNOWN,
			confidence: 0,
			matched_pattern: "",
			matchedPattern: "",
			priority: "stable",
		});

		const short = classifyMemory("blue kettle");
		expect(short.memory_type).toBe(MemoryType.FACT);
		expect(short.confidence).toBe(0.3);
		expect(short.matched_pattern).toBe("default_short");

		const long = classifyMemory("blue kettle beside quiet window without known trigger words");
		expect(long.memory_type).toBe(MemoryType.CONTEXT);
		expect(long.confidence).toBe(0.3);
		expect(long.matched_pattern).toBe("default_long");
	});

	it("keeps priority, consolidation, decay, and batch helpers aligned with Python", () => {
		expect(getTypePriority(MemoryType.INSTRUCTION)).toBeGreaterThan(getTypePriority(MemoryType.EVENT));
		expect(getTypePriority(MemoryType.COMMITMENT)).toBe(9);
		expect(getTypePriority(MemoryType.ARTIFACT)).toBe(1);
		expect(getDecayRate(MemoryType.CONTEXT)).toBeGreaterThan(getDecayRate(MemoryType.FACT));
		expect(getDecayRate(MemoryType.ERROR)).toBe(0.05);
		expect(shouldConsolidate(MemoryType.DECISION)).toBe(true);
		expect(shouldConsolidate(MemoryType.EVENT)).toBe(false);
		expect(shouldConsolidate(MemoryType.ERROR)).toBe(false);
		expect(
			classifyBatch(["I prefer dark mode", "Meeting with Alice yesterday"]).map(match => match.memory_type),
		).toEqual([MemoryType.PREFERENCE, MemoryType.EVENT]);
	});

	it("uses Python confidence boosts and type-order tie breaking", () => {
		const boosted = classifyMemory("The official API is at https://example.com and documented");
		expect(boosted.memory_type).toBe(MemoryType.FACT);
		expect(boosted.confidence).toBeCloseTo(0.9);

		const tieBroken = classifyMemory("This is a type of persistent error");
		expect(tieBroken.memory_type).toBe(MemoryType.ERROR);
		expect(tieBroken.priority).toBe("persistent");
	});
});

describe("AAAK encoding", () => {
	it("exports the Python public maps", () => {
		expect(CATEGORY_MAP.PREFERENCE).toBe("PREF");
		expect(PHRASE_MAP["User requested "]).toBe("REQ ");
		expect(STRUCTURAL_REPLACEMENTS).toContainEqual([" and ", "+"]);
	});

	it("compresses category prefixes, phrases, structure, and parentheses like Python", () => {
		expect(encode("PREFERENCE: Imperial units for GPS, 12-hour time format ( 5:30 PM )")).toBe(
			"PREF|Imperial units→GPS | 12-hour time format (5:30 PM)",
		);
		expect(encode("User asked for real-time transcription and translation using self-hosted automation")).toBe(
			"ASK RT transc+transl→selfhost auto",
		);
		expect(encode("User email is alice@example.com, GitHub: alice")).toBe("@alice@example.com | GH:alice");
	});

	it("leaves compact AAAK text unchanged and uses Python completion compaction order", () => {
		expect(encode("PREF|dark-mode")).toBe("PREF|dark-mode");
		expect(encode("TASK: backup working correctly, migration completed")).toBe("TASK: backup OK | migration DONEd");
	});
});
