/**
 * The status line's `vim` segment (upstream packages/tui/test/status-line-vim.test.ts) and the dot
 * between extension statuses (status-line-status-segment.test.ts), as the native bar's spans.
 */
import { describe, expect, it } from "bun:test";
import type { StatusFacts } from "../../../src/ui/status/facts";
import { effectiveStatusSettings, segmentView } from "../../../src/ui/status/segments";
import { corpusStatusFacts } from "./fixture";

type VimStatus = NonNullable<StatusFacts["vim"]>;

const settings = effectiveStatusSettings({ preset: "custom", sessionAccent: false });

function vimView(vim: VimStatus | undefined) {
	return segmentView("vim", { ...corpusStatusFacts(), vim }, settings);
}

/** What the native bar reads: the spans' text joined. */
function text(vim: VimStatus | undefined): string | undefined {
	return vimView(vim)
		?.spans.map(part => part.t)
		.join("");
}

describe("status line vim segment", () => {
	it("stays hidden when vim mode is off", () => {
		expect(vimView(undefined)).toBeNull();
	});

	it("names the active mode, the half-typed command and a multi-line selection", () => {
		expect(text({ mode: "normal", pending: "", selectedLines: 0, display: "text" })).toBe("NORMAL");
		expect(text({ mode: "visual-line", pending: "", selectedLines: 1, display: "text" })).toBe("V-LINE");
		expect(text({ mode: "visual-line", pending: "", selectedLines: 4, display: "text" })).toBe("V-LINE 4L");
		expect(text({ mode: "normal", pending: "2d", selectedLines: 0, display: "text" })).toBe("NORMAL 2d");
	});

	it("with display none, hides the mode but still echoes a half-typed command", () => {
		const pending = vimView({ mode: "normal", pending: "15d", selectedLines: 4, display: "none" });
		expect(pending?.spans).toEqual([{ t: "15d", s: "muted" }]);
		expect(pending?.look.pieces).toEqual([{ t: "15d", s: "muted" }]);
		// Nothing pending: the whole segment stays hidden.
		expect(vimView({ mode: "normal", pending: "", selectedLines: 4, display: "none" })).toBeNull();
		expect(vimView({ mode: "normal", pending: '"a', selectedLines: 0, display: "none" })?.spans).toEqual([
			expect.objectContaining({ t: '"a' }),
		]);
	});
});

describe("status line status segment", () => {
	it("draws the dot between statuses dim in the native bar, apart from the accent statuses", () => {
		const view = segmentView("status", { ...corpusStatusFacts(), hooks: ["build ok", "2 tests"] }, settings);
		expect(view?.spans.map(part => [part.t, part.s])).toEqual([
			["build ok", "accent"],
			[" · ", "dim"],
			["2 tests", "accent"],
		]);
	});
});
