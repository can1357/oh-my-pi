import { describe, expect, it } from "bun:test";
import {
	placementsFromDiff,
	type RenderedHunk,
	renderHunks,
	solveRenderedHunks,
} from "@oh-my-pi/typescript-edit-benchmark/hunks";

/** Round-trip an input/expected pair through the prompt machinery. */
function roundTrip(input: string, expected: string): { hunks: RenderedHunk[]; solved: string } {
	const inputLines = input.replace(/\n$/, "").split("\n");
	const placements = placementsFromDiff(input, expected);
	const hunks = renderHunks(inputLines, placements);
	if (!hunks) throw new Error("renderHunks returned null");
	const solved = solveRenderedHunks(inputLines, hunks);
	if (!solved) throw new Error("solveRenderedHunks returned null");
	return { hunks, solved: `${solved.join("\n")}\n` };
}

describe("hunk round-trip", () => {
	it("reproduces the expected file for a block replacement", () => {
		const input = "const a = 1;\nfunction f() {\n\treturn a;\n}\nexport { f };\n";
		const expected = "const a = 1;\nfunction f() {\n\treturn a + 1;\n}\nexport { f };\n";
		const { hunks, solved } = roundTrip(input, expected);
		expect(solved).toBe(expected);
		expect(hunks).toHaveLength(1);
		expect(hunks[0].unique).toBe(true);
	});

	it("reproduces the expected file for a pure insertion, anchored on a non-blank line", () => {
		const input = "function f() {\n\n\treturn 1;\n}\n";
		const expected = "function f() {\n\n\tconst x = 0;\n\treturn 1;\n}\n";
		const { hunks, solved } = roundTrip(input, expected);
		expect(solved).toBe(expected);
		// The line directly above the insertion is blank; the anchor must be visible.
		expect(hunks[0].oldBlock.some(line => line.trim().length > 0)).toBe(true);
	});

	it("reproduces the expected file for a pure deletion, anchored on context", () => {
		const input = "a();\nb();\nc();\n";
		const expected = "a();\nc();\n";
		const { hunks, solved } = roundTrip(input, expected);
		expect(solved).toBe(expected);
		// Deletions keep a context anchor so the replacement is never an empty fence.
		expect(hunks[0].newBlock.length).toBeGreaterThan(0);
		expect(hunks[0].oldBlock.length).toBeGreaterThan(hunks[0].newBlock.length);
	});
});

describe("uniqueness handling", () => {
	it("extends a repeated block with context until it is unique", () => {
		const input = "start();\nif (x) {\n\tstop();\n}\nif (y) {\n\tstop();\n}\n";
		const expected = "start();\nif (x) {\n\tstop();\n}\nif (y) {\n\thalt();\n}\n";
		const { hunks, solved } = roundTrip(input, expected);
		expect(solved).toBe(expected);
		expect(hunks[0].unique).toBe(true);
		// `\tstop();` alone is ambiguous; the block must carry the `if (y) {` context.
		expect(hunks[0].oldBlock.length).toBeGreaterThan(1);
	});

	it("marks a hunk non-unique with its start line when context cannot disambiguate", () => {
		const line = "value += 1;";
		const input = `${Array.from({ length: 4 }, () => line).join("\n")}\n`;
		const expected = `${[line, line, "value += 2;", line].join("\n")}\n`;
		const inputLines = input.replace(/\n$/, "").split("\n");
		const hunks = renderHunks(inputLines, placementsFromDiff(input, expected));
		if (!hunks) throw new Error("renderHunks returned null");
		expect(hunks[0].unique).toBe(false);
		// startLine must locate a real occurrence of the (extended) old block, so
		// a solver that trusts it lands on the right copy.
		expect(inputLines.slice(hunks[0].startLine - 1, hunks[0].startLine - 1 + hunks[0].oldBlock.length)).toEqual(
			hunks[0].oldBlock,
		);
		const solved = solveRenderedHunks(inputLines, hunks);
		expect(solved ? `${solved.join("\n")}\n` : null).toBe(expected);
	});
});

describe("placement merging", () => {
	it("renders two adjacent swapped statements as a single hunk", () => {
		const input = "setup();\nsecond();\nfirst();\nteardown();\n";
		const expected = "setup();\nfirst();\nsecond();\nteardown();\n";
		const { hunks, solved } = roundTrip(input, expected);
		expect(solved).toBe(expected);
		expect(hunks).toHaveLength(1);
	});

	it("keeps distant changes as separate hunks", () => {
		const filler = Array.from({ length: 10 }, (_, i) => `line${i}();`).join("\n");
		const input = `alpha();\n${filler}\nomega();\n`;
		const expected = `alpha2();\n${filler}\nomega2();\n`;
		const { hunks, solved } = roundTrip(input, expected);
		expect(solved).toBe(expected);
		expect(hunks).toHaveLength(2);
	});
});
