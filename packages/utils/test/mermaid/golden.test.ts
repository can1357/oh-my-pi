/**
 * Golden-file tests for the ASCII/Unicode renderer.
 *
 * Ported from AlexanderGrooff/mermaid-ascii cmd/graph_test.go.
 * Each .txt file contains mermaid input above a `---` separator
 * and the expected ASCII/Unicode output below it.
 *
 * Test data: 44 ASCII files + 22 Unicode files = 66 total.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderMermaidAscii } from "../../src/vendor/mermaid-ascii/ascii/index";
import { DIAGONAL_CHARS, hasDiagonalLines } from "../../src/vendor/mermaid-ascii/ascii/validate";

// ============================================================================
// Test case parser — matches Go's testutil.ReadTestCase format
// ============================================================================

interface TestCase {
	mermaid: string;
	expected: string;
	paddingX: number;
	paddingY: number;
}

/**
 * Parse a golden test file into its components.
 * Format:
 *   [paddingX=N]     (optional)
 *   [paddingY=N]     (optional)
 *   <mermaid code>
 *   ---
 *   <expected output>
 */
function parseTestCase(content: string): TestCase {
	const tc: TestCase = { mermaid: "", expected: "", paddingX: 5, paddingY: 5 };
	const lines = content.split("\n");
	const paddingRegex = /^(?:padding([xy]))\s*=\s*(\d+)\s*$/i;

	let inMermaid = true;
	let mermaidStarted = false;
	const mermaidLines: string[] = [];
	const expectedLines: string[] = [];

	for (const line of lines) {
		if (line === "---") {
			inMermaid = false;
			continue;
		}

		if (inMermaid) {
			const trimmed = line.trim();

			// Before mermaid code starts, parse padding directives and skip blanks
			if (!mermaidStarted) {
				if (trimmed === "") continue;
				const match = trimmed.match(paddingRegex);
				if (match) {
					const value = parseInt(match[2]!, 10);
					if (match[1]!.toLowerCase() === "x") {
						tc.paddingX = value;
					} else {
						tc.paddingY = value;
					}
					continue;
				}
			}

			mermaidStarted = true;
			mermaidLines.push(line);
		} else {
			expectedLines.push(line);
		}
	}

	tc.mermaid = `${mermaidLines.join("\n")}\n`;

	// Strip final trailing newline (matches Go's strings.TrimSuffix(expected, "\n"))
	let expected = expectedLines.join("\n");
	if (expected.endsWith("\n")) {
		expected = expected.slice(0, -1);
	}
	tc.expected = expected;

	return tc;
}

// ============================================================================
// Whitespace normalization — matches Go's testutil.NormalizeWhitespace
// ============================================================================

/**
 * Normalize whitespace for comparison:
 * - Trim trailing spaces from each line
 * - Remove leading/trailing blank lines
 */
function normalizeWhitespace(s: string): string {
	const lines = s.split("\n");
	const normalized = lines.map(l => l.trimEnd());

	// Remove leading blank lines
	while (normalized.length > 0 && normalized[0] === "") {
		normalized.shift();
	}
	// Remove trailing blank lines
	while (normalized.length > 0 && normalized[normalized.length - 1] === "") {
		normalized.pop();
	}

	return normalized.join("\n");
}

/** Replace spaces with middle dots for clearer diff output. */
function visualizeWhitespace(s: string): string {
	return s.replaceAll(" ", "·");
}

// ============================================================================
// Test runner — dynamically loads all golden files from testdata directories
// ============================================================================

function runGoldenTests(dir: string, useAscii: boolean): void {
	const files = readdirSync(dir)
		.filter(f => f.endsWith(".txt"))
		.sort();

	for (const file of files) {
		const testName = file.replace(".txt", "");

		it(testName, () => {
			const content = readFileSync(join(dir, file), "utf-8");
			const tc = parseTestCase(content);

			const actual = renderMermaidAscii(tc.mermaid, {
				useAscii,
				paddingX: tc.paddingX,
				paddingY: tc.paddingY,
				colorMode: "none",
			});

			const normalizedExpected = normalizeWhitespace(tc.expected);
			const normalizedActual = normalizeWhitespace(actual);

			if (normalizedExpected !== normalizedActual) {
				const expectedVis = visualizeWhitespace(normalizedExpected);
				const actualVis = visualizeWhitespace(normalizedActual);
				expect(actualVis).toBe(expectedVis);
			}
		});
	}
}

// ============================================================================
// Test suites
// ============================================================================

const testdataDir = join(import.meta.dir, "testdata");

describe("ASCII rendering", () => {
	runGoldenTests(join(testdataDir, "ascii"), true);
});

describe("Unicode rendering", () => {
	runGoldenTests(join(testdataDir, "unicode"), false);
});

// ============================================================================
// Config behavior tests — ported from Go's TestGraphUseAsciiConfig
// ============================================================================

describe("Config behavior", () => {
	const mermaidInput = "graph LR\nA --> B";

	it("ASCII and Unicode outputs should differ", () => {
		const asciiOutput = renderMermaidAscii(mermaidInput, { useAscii: true, colorMode: "none" });
		const unicodeOutput = renderMermaidAscii(mermaidInput, { useAscii: false, colorMode: "none" });
		expect(asciiOutput).not.toBe(unicodeOutput);
	});

	it("ASCII output should not contain Unicode box-drawing characters", () => {
		const output = renderMermaidAscii(mermaidInput, { useAscii: true, colorMode: "none" });
		expect(output).not.toContain("┌");
		expect(output).not.toContain("─");
		expect(output).not.toContain("│");
	});

	it("Unicode output should contain Unicode box-drawing characters", () => {
		const output = renderMermaidAscii(mermaidInput, { useAscii: false, colorMode: "none" });
		const hasUnicode = output.includes("┌") || output.includes("─") || output.includes("│");
		expect(hasUnicode).toBe(true);
	});
});

// ============================================================================
// Diagonal validation — ensures all edges use orthogonal Manhattan routing
// ============================================================================

describe("Diagonal validation", () => {
	const asciiDir = join(testdataDir, "ascii");
	const unicodeDir = join(testdataDir, "unicode");

	it("ASCII output should never contain diagonal characters", () => {
		// Test all ASCII golden files
		const files = readdirSync(asciiDir).filter(f => f.endsWith(".txt"));
		for (const file of files) {
			const content = readFileSync(join(asciiDir, file), "utf-8");
			const { mermaid, paddingX, paddingY } = parseTestCase(content);
			const output = renderMermaidAscii(mermaid, {
				useAscii: true,
				boxBorderPadding: paddingX,
				paddingY: paddingY,
				colorMode: "none",
			});

			// Check for diagonal characters
			for (const char of DIAGONAL_CHARS.ascii) {
				expect(output).not.toContain(char);
			}
		}
	});

	it("Unicode output should never contain diagonal characters", () => {
		// Test all Unicode golden files
		const files = readdirSync(unicodeDir).filter(f => f.endsWith(".txt"));
		for (const file of files) {
			const content = readFileSync(join(unicodeDir, file), "utf-8");
			const { mermaid, paddingX, paddingY } = parseTestCase(content);
			const output = renderMermaidAscii(mermaid, {
				useAscii: false,
				boxBorderPadding: paddingX,
				paddingY: paddingY,
				colorMode: "none",
			});

			// Check for diagonal characters
			for (const char of DIAGONAL_CHARS.unicode) {
				expect(output).not.toContain(char);
			}
		}
	});

	it("hasDiagonalLines utility correctly detects diagonal characters", () => {
		// Should detect ASCII diagonals
		expect(hasDiagonalLines("A / B")).toBe(true);
		expect(hasDiagonalLines("A \\ B")).toBe(true);

		// Should detect Unicode diagonals
		expect(hasDiagonalLines("A ╱ B")).toBe(true);
		expect(hasDiagonalLines("A ╲ B")).toBe(true);

		// Should not flag clean output
		expect(hasDiagonalLines("┌───┐\n│ A │\n└───┘")).toBe(false);
		expect(hasDiagonalLines("+---+\n| A |\n+---+")).toBe(false);
	});
});
