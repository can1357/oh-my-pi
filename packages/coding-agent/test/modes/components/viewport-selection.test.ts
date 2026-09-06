import { describe, expect, it } from "bun:test";
import {
	highlightViewportSelection,
	sliceViewportSelection,
} from "@oh-my-pi/pi-coding-agent/modes/components/viewport-selection";

describe("sliceViewportSelection", () => {
	it("strips ANSI while including both cell endpoints across rows", () => {
		expect(sliceViewportSelection(["alpha", "\x1b[31mbeta\x1b[0m"], 8, { row: 0, col: 2 }, { row: 1, col: 2 })).toBe(
			"pha\nbet",
		);
	});

	it("retains OSC 66 payloads in copied and highlighted text", () => {
		const osc66 = "\x1b]66;s=2;Hi\x1b\\";
		expect(sliceViewportSelection([osc66], 4, { row: 0, col: 0 }, { row: 0, col: 3 })).toBe("Hi");
		const [highlighted] = highlightViewportSelection([osc66], 4, { row: 0, col: 0 }, { row: 0, col: 3 });
		expect(highlighted).toContain("Hi");
	});

	it("expands endpoints that land inside wide graphemes", () => {
		expect(sliceViewportSelection(["a界b"], 4, { row: 0, col: 1 }, { row: 0, col: 1 })).toBe("界");
		expect(sliceViewportSelection(["a界b"], 4, { row: 0, col: 2 }, { row: 0, col: 2 })).toBe("界");
	});

	it("orders a reverse drag and keeps the selected line break", () => {
		expect(sliceViewportSelection(["first", "second", "third"], 8, { row: 2, col: 2 }, { row: 0, col: 1 })).toBe(
			"irst\nsecond\nthi",
		);
	});

	it("clamps selection columns to the viewport cell width", () => {
		expect(sliceViewportSelection(["short"], 5, { row: 0, col: 0 }, { row: 0, col: 40 })).toBe("short");
	});
});

describe("highlightViewportSelection", () => {
	it("marks the selected cells with reverse video", () => {
		const [line] = highlightViewportSelection(["alpha"], 8, { row: 0, col: 1 }, { row: 0, col: 3 });
		expect(Bun.stripANSI(line ?? "")).toBe("alpha");
		expect(line).toContain("\x1b[7m");
		expect(line).toContain("\x1b[27m");
	});
});
