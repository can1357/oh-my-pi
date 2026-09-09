import { describe, expect, it } from "bun:test";
import { parseFindingDetails } from "@oh-my-pi/pi-coding-agent/tools/review";

describe("parseFindingDetails", () => {
	it("returns undefined for malformed finding details", () => {
		expect(parseFindingDetails({})).toBeUndefined();
		expect(
			parseFindingDetails({
				title: "[P1] Missing file path",
				body: "Body",
				priority: "P1",
				confidence: 0.8,
				line_start: 12,
				line_end: 12,
			}),
		).toBeUndefined();
	});

	it("parses a complete finding, coercing numeric priority", () => {
		expect(
			parseFindingDetails({
				title: "[P1] Example finding",
				body: "Body",
				priority: 1,
				confidence: 0.9,
				file_path: "/tmp/example.ts",
				line_start: 10,
				line_end: 12,
			}),
		).toEqual({
			title: "[P1] Example finding",
			body: "Body",
			priority: "P1",
			confidence: 0.9,
			file_path: "/tmp/example.ts",
			line_start: 10,
			line_end: 12,
		});
	});
});
