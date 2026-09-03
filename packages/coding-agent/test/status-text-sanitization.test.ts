import { describe, expect, it } from "bun:test";
import { sanitizeStatusText, sanitizeStyledStatusText } from "@oh-my-pi/pi-coding-agent/modes/shared";

describe("sanitizeStatusText", () => {
	it("strips OSC, DCS, PM, APC, and 8-bit CSI escape sequences", () => {
		const input =
			"prefix " +
			"\x1b]8;;https://example.com\x07link\x1b]8;;\x07" +
			" " +
			"\x1bPhidden-dcs\x1b\\" +
			"\x1b^hidden-pm\x1b\\" +
			"\x1b_hidden-apc\x1b\\" +
			"\x9b31mred\x9b0m" +
			" suffix";

		expect(sanitizeStatusText(input)).toBe("prefix link red suffix");
	});
});

describe("sanitizeStyledStatusText", () => {
	it("preserves complete SGR color/style sequences verbatim", () => {
		expect(sanitizeStyledStatusText("\x1b[1;32mgreen\x1b[0m")).toBe("\x1b[1;32mgreen\x1b[0m");
	});

	it("strips non-SGR escape sequences (cursor moves, screen clears, OSC hyperlinks)", () => {
		expect(sanitizeStyledStatusText("a\x1b[2Jb")).toBe("ab");
		expect(sanitizeStyledStatusText("a\x1b[10;5Hb")).toBe("ab");
		expect(sanitizeStyledStatusText("\x1b]8;;https://example.com\x07link\x1b]8;;\x07")).toBe("link");
	});

	it("maps row-breaking controls (tab, newline, carriage return, lone ESC) to spaces and collapses runs", () => {
		expect(sanitizeStyledStatusText("a\tb\nc\rd")).toBe("a b c d");
		expect(sanitizeStyledStatusText("keep\x1b[1m   \x1b[0m color")).toBe("keep\x1b[1m \x1b[0m color");
		expect(sanitizeStyledStatusText("\x1b[31m\x1b[2Jred\x1b[0m\nend")).toBe("\x1b[31mred\x1b[0m end");
	});
});
