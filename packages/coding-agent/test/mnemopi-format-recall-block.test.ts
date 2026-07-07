import { describe, expect, it } from "bun:test";
import { formatRecallBlock } from "@pk-nerdsaver-ai/pi-coding-agent/mnemopi/state";
import type { RecallResult } from "@pk-nerdsaver-ai/pi-mnemopi";

function makeResult(content: string, overrides: Partial<RecallResult> = {}): RecallResult {
	return { content, ...overrides } as RecallResult;
}

function renderedLines(block: string): string[] {
	const bodyStart = block.indexOf("\n\n") + 2;
	const body = block.slice(bodyStart, block.lastIndexOf("\n</memories>"));
	return body.split("\n\n");
}

describe("formatRecallBlock per-item cap", () => {
	it("passes short content through untouched", () => {
		const block = formatRecallBlock([makeResult("user prefers tabs over spaces")]);
		const line = renderedLines(block)[0];
		expect(line).toBe("- user prefers tabs over spaces");
	});

	it("truncates content longer than 600 chars and appends an ellipsis", () => {
		const fat = "x".repeat(2_500);
		const block = formatRecallBlock([makeResult(fat)]);
		const line = renderedLines(block)[0];
		// "- " prefix (2) + 600 chars + ellipsis (1) = 603.
		expect(line).toBe(`- ${"x".repeat(600)}…`);
		expect(line.length).toBe(603);
	});

	it("does not truncate content exactly at the boundary (600 chars stays as-is)", () => {
		const exact = "y".repeat(600);
		const block = formatRecallBlock([makeResult(exact)]);
		const line = renderedLines(block)[0];
		expect(line).toBe(`- ${exact}`);
		expect(line.endsWith("…")).toBe(false);
	});

	it("caps every line so no rendered memory line exceeds ~610 chars of content", () => {
		const results = [
			makeResult("a".repeat(5_000)),
			makeResult("short note"),
			makeResult("z".repeat(1_500), { source: "session-42", timestamp: "2024-08-01T12:34:56.000Z" }),
		];
		const block = formatRecallBlock(results);
		for (const line of renderedLines(block)) {
			// "- " (2) + content (<= 601 with ellipsis) + source "[…]" + " (YYYY-MM-DD)".
			expect(line.length).toBeLessThanOrEqual(2 + 601 + 32);
			expect(line.length).toBeGreaterThan(2);
		}
		// Spot-check: the fat transcript line keeps the source/date suffix and ends with "…".
		const fatLine = renderedLines(block)[0];
		expect(fatLine.endsWith("…")).toBe(true);
		// The medium line is truncated and still carries its suffix.
		const mediumLine = renderedLines(block)[2];
		expect(mediumLine).toContain("z".repeat(100));
		expect(mediumLine).toContain(" [session-42] (2024-08-01)");
	});

	it("leaves short items inside a mixed batch untrimmed", () => {
		const block = formatRecallBlock([makeResult("tiny"), makeResult("m".repeat(900)), makeResult("still tiny")]);
		const lines = renderedLines(block);
		expect(lines[0]).toBe("- tiny");
		expect(lines[1].endsWith("…")).toBe(true);
		expect(lines[1].length).toBeLessThanOrEqual(2 + 600 + 1);
		expect(lines[2]).toBe("- still tiny");
	});
});
