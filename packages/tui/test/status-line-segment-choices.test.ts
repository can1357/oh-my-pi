import { describe, expect, test } from "bun:test";
import { STATUS_LINE_SEGMENT_CHOICES, STATUS_LINE_SEGMENT_IDS } from "../src/status-line/schema";

describe("status line segment choices", () => {
	test("covers every segment id the schema accepts", () => {
		// A missing entry would leave the segment unreachable from the settings editor,
		// even though config.yml still accepts it.
		expect(STATUS_LINE_SEGMENT_CHOICES.map(choice => choice.value).sort()).toEqual(
			[...STATUS_LINE_SEGMENT_IDS].sort(),
		);
	});

	test("lists each segment once, with a label and a description", () => {
		expect(new Set(STATUS_LINE_SEGMENT_CHOICES.map(choice => choice.value)).size).toBe(
			STATUS_LINE_SEGMENT_CHOICES.length,
		);
		for (const choice of STATUS_LINE_SEGMENT_CHOICES) {
			expect(choice.label.length).toBeGreaterThan(0);
			expect(choice.description.length).toBeGreaterThan(0);
		}
	});
});
