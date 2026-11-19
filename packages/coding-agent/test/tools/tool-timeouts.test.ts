import { describe, expect, it } from "bun:test";
import { deferredDiagnosticsWaitMs } from "@oh-my-pi/pi-coding-agent/lsp/diagnostics";
import { clampTimeout, resolveLspTimeouts, TOOL_TIMEOUTS } from "@oh-my-pi/pi-coding-agent/tools/tool-timeouts";

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

describe("resolveLspTimeouts", () => {
	it("keeps the 20s call deadline and 10s server wait at the default setting", () => {
		expect(resolveLspTimeouts(undefined, 10)).toEqual({ call: 20, wait: 10 });
	});

	it("lets a raised lsp.requestTimeout extend both the server wait and the call deadline", () => {
		// F-13: a cold tsgo needs ~16-18s for its first diagnostic; the wait was hard-capped at 10s.
		expect(resolveLspTimeouts(undefined, 60)).toEqual({ call: 60, wait: 60 });
	});

	it("lets an explicit timeout raise the server wait past the setting", () => {
		// F-13: `timeout` used to only lower the 10s diagnostics wait.
		expect(resolveLspTimeouts(30, 10)).toEqual({ call: 30, wait: 30 });
	});

	it("lets an explicit timeout lower the setting", () => {
		expect(resolveLspTimeouts(5, 60)).toEqual({ call: 5, wait: 5 });
	});

	it("caps the setting and the argument by tools.maxTimeout and the tool range", () => {
		expect(resolveLspTimeouts(120, 10, 30)).toEqual({ call: 30, wait: 30 });
		expect(resolveLspTimeouts(undefined, 60, 30)).toEqual({ call: 30, wait: 30 });
		expect(resolveLspTimeouts(undefined, 1000)).toEqual({
			call: TOOL_TIMEOUTS.lsp.max,
			wait: TOOL_TIMEOUTS.lsp.max,
		});
	});
});

describe("deferredDiagnosticsWaitMs", () => {
	it("waits at least 12s for late post-edit diagnostics and longer when lsp.requestTimeout is raised", () => {
		expect(deferredDiagnosticsWaitMs(10)).toBe(12_000);
		expect(deferredDiagnosticsWaitMs(60)).toBe(60_000);
	});
});
