import { describe, expect, it } from "bun:test";
import { clampTimeout, TOOL_TIMEOUTS } from "@oh-my-pi/pi-coding-agent/tools/tool-timeouts";

describe("clampTimeout", () => {
	it("returns the per-tool default when no raw timeout is given", () => {
		expect(clampTimeout("bash")).toBe(TOOL_TIMEOUTS.bash.default);
		expect(clampTimeout("eval")).toBe(TOOL_TIMEOUTS.eval.default);
	});

	it("clamps explicit values to the per-tool min/max", () => {
		expect(clampTimeout("bash", 0.1)).toBe(TOOL_TIMEOUTS.bash.min);
		expect(clampTimeout("bash", 999_999)).toBe(TOOL_TIMEOUTS.bash.max);
		expect(clampTimeout("lsp", 1)).toBe(TOOL_TIMEOUTS.lsp.min);
	});

	it("caps the default-fallback path with a positive maxTimeout", () => {
		// Regression for #6294: omitting the raw timeout used the 300s bash
		// default and bypassed tools.maxTimeout entirely.
		expect(clampTimeout("bash", undefined, 30)).toBe(30);
	});

	it("caps an explicit value above maxTimeout", () => {
		expect(clampTimeout("bash", 600, 30)).toBe(30);
	});

	it("lets an explicit value below maxTimeout win", () => {
		expect(clampTimeout("bash", 10, 30)).toBe(10);
	});

	it("treats maxTimeout <= 0 as no global cap", () => {
		expect(clampTimeout("bash", undefined, 0)).toBe(TOOL_TIMEOUTS.bash.default);
		expect(clampTimeout("bash", undefined, -1)).toBe(TOOL_TIMEOUTS.bash.default);
	});

	it("still enforces the per-tool min when maxTimeout is below it", () => {
		// maxTimeout under the floor cannot drive the effective timeout below
		// the tool's own minimum (bash min = 1s).
		expect(clampTimeout("bash", undefined, 0.1)).toBe(TOOL_TIMEOUTS.bash.min);
	});
});
