import { describe, expect, it } from "bun:test";
import { truncateToVisualLines } from "@oh-my-pi/pi-coding-agent/modes/components/visual-truncate";

describe("truncateToVisualLines", () => {
	it("returns empty output for empty text", () => {
		const result = truncateToVisualLines("", 3, 10);

		expect(result.visualLines).toEqual([]);
		expect(result.skippedCount).toBe(0);
	});

	it("truncates to the last visual lines after wrapping", () => {
		const text = "one two three four";
		const result = truncateToVisualLines(text, 1, 10, 0);

		expect(result.visualLines).toEqual(["three four"]);
		expect(result.skippedCount).toBe(1);
	});

	it("applies horizontal padding to rendered lines", () => {
		const text = "one";
		const result = truncateToVisualLines(text, 1, 5, 1);

		expect(result.visualLines).toEqual([" one "]);
		expect(result.skippedCount).toBe(0);
	});
});
