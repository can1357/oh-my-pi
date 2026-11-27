import { describe, expect, it } from "bun:test";
import { RESERVED_ROW } from "@oh-my-pi/pi-tui/driver/images/anchor";
import { drawRow, normalizeRow, stripTrailingBlankSpaces } from "@oh-my-pi/pi-tui/driver/output/ansi";
import { renderMarkdown } from "../../src/text/markdown";
import { loadThemeSync } from "../../src/theme";
import { Vt } from "./vt";

const theme = loadThemeSync("dark");

describe("stripTrailingBlankSpaces", () => {
	it("strips trailing spaces on plain and foreground-styled default-background rows", () => {
		expect(stripTrailingBlankSpaces("hello     ")).toBe("hello");
		expect(stripTrailingBlankSpaces("     ")).toBe("");
		expect(stripTrailingBlankSpaces("\x1b[32mhello\x1b[0m     ")).toBe("\x1b[32mhello\x1b[0m");
		expect(stripTrailingBlankSpaces("\x1b[32mhello   \x1b[0m")).toBe("\x1b[32mhello");
		expect(stripTrailingBlankSpaces("\x1b[32m   \x1b[0m")).toBe("");
		// Truecolor foreground RGB components (40, 7, 4) must not be misread as bg/inverse/underline.
		expect(stripTrailingBlankSpaces("\x1b[38;2;40;7;4mhello   \x1b[39m")).toBe("\x1b[38;2;40;7;4mhello");
	});

	it("preserves trailing spaces that carry visible cell styling", () => {
		expect(stripTrailingBlankSpaces("\x1b[48;2;30;30;30mhello   \x1b[49m")).toBe(
			"\x1b[48;2;30;30;30mhello   \x1b[49m",
		);
		expect(stripTrailingBlankSpaces("\x1b[41m   \x1b[0m")).toBe("\x1b[41m   \x1b[0m");
		expect(stripTrailingBlankSpaces("\x1b[7mhello   \x1b[27m")).toBe("\x1b[7mhello   \x1b[27m");
		expect(stripTrailingBlankSpaces("\x1b[4mhello   \x1b[24m")).toBe("\x1b[4mhello   \x1b[24m");
		expect(stripTrailingBlankSpaces("\x1b[4:3mhello   \x1b[4:0m")).toBe("\x1b[4:3mhello   \x1b[4:0m");
		expect(stripTrailingBlankSpaces("\x1b[9mhello   \x1b[29m")).toBe("\x1b[9mhello   \x1b[29m");
		expect(stripTrailingBlankSpaces("\x1b[53mhello   \x1b[55m")).toBe("\x1b[53mhello   \x1b[55m");
		expect(stripTrailingBlankSpaces("\x1b]8;;https://example.com\x1b\\link \x1b]8;;\x1b\\")).toBe(
			"\x1b]8;;https://example.com\x1b\\link \x1b]8;;\x1b\\",
		);
	});

	it("strips default-background spaces after a background, underline, or hyperlink closes", () => {
		expect(stripTrailingBlankSpaces("\x1b[48;2;30;30;30mhello\x1b[49m   ")).toBe("\x1b[48;2;30;30;30mhello\x1b[49m");
		expect(stripTrailingBlankSpaces("\x1b[4:3mhello\x1b[4:0m   ")).toBe("\x1b[4:3mhello\x1b[4:0m");
		// SGR 21 matches SgrState.apply (underline off).
		expect(stripTrailingBlankSpaces("\x1b[4mhello\x1b[21m   ")).toBe("\x1b[4mhello\x1b[21m");
		expect(stripTrailingBlankSpaces("\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\   ")).toBe(
			"\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\",
		);
	});

	it("handles 3-byte escapes, SOS/PM control strings, tmux DCS, and escape-only RESERVED_ROW", () => {
		// 3-byte G0 charset designation (e.g. `tput sgr0` emits ESC ( B ESC [ m).
		expect(stripTrailingBlankSpaces("\x1b[32mfoo   \x1b(B\x1b[m")).toBe("\x1b[32mfoo");
		// SOS and PM payloads are control strings, not visible text.
		expect(stripTrailingBlankSpaces("foo   \x1bXignored\x1b\\")).toBe("foo");
		expect(stripTrailingBlankSpaces("foo   \x1b^ignored\x1b\\")).toBe("foo");
		// Tmux passthrough DCS (doubled ESC inside payload) stays intact as graphics.
		const tmux = "\x1bPtmux;\x1b\x1bPqdata\x1b\x1b\\\x1b\\";
		expect(stripTrailingBlankSpaces(tmux)).toBe(tmux);
		// Escape-only RESERVED_ROW (\x1b[0m) must remain distinct from "" so FrameWriter erases replaced image bands.
		expect(stripTrailingBlankSpaces(RESERVED_ROW)).toBe(RESERVED_ROW);
		expect(normalizeRow(RESERVED_ROW, 40)).toBe(RESERVED_ROW);
	});
});

describe("terminal output trailing spaces", () => {
	it("normalizes padded default-background rows so drawRow emits EL0 instead of trailing spaces", () => {
		const normalized = normalizeRow("const x = 1;        ", 20);
		expect(normalized).toBe("const x = 1;");
		expect(drawRow(normalized, 20)).toBe("\rconst x = 1;\x1b[K");

		const blank = normalizeRow("                    ", 20);
		expect(blank).toBe("");
		expect(drawRow(blank, 20)).toBe("\r\x1b[2K");
	});

	it("omits trailing spaces on default-background markdown prose and code blocks and uses EL0 on shorter updates", () => {
		const vt = new Vt({ columns: 40, rows: 10 });
		const rows = renderMarkdown("Hello world\n\n```ts\nconst answer = 42;\n```", 40, {
			theme,
			paddingX: 1,
			codeIndent: 0,
		});
		const mark = vt.writes.length;
		vt.present({ viewport: rows, cursor: null });
		const bytes = vt.since(mark);
		// Every non-empty default-background row uses EL0 (\x1b[K) rather than padding to 40 columns.
		expect(bytes).toContain("\x1b[K");
		expect(bytes).not.toContain("Hello world          ");
		expect(bytes).not.toContain("const answer = 42;          ");
		expect(vt.screen().slice(0, 5)).toEqual([" Hello world", "", "```ts", "const answer = 42;", "```"]);

		// Updating a longer row to a shorter row emits EL0 (\x1b[K) and clears the remainder cleanly.
		const updateMark = vt.writes.length;
		vt.present({ viewport: [" Hi", "", "```ts", "const x = 1;", "```"], cursor: null });
		const updateBytes = vt.since(updateMark);
		expect(updateBytes).toContain("\r Hi\x1b[K");
		expect(updateBytes).toContain("\rconst x = 1;\x1b[K");
		expect(vt.screen().slice(0, 5)).toEqual([" Hi", "", "```ts", "const x = 1;", "```"]);
	});

	it("preserves full-width background fills, box borders, and right-aligned text", () => {
		const vt = new Vt({ columns: 20, rows: 4 });
		const bgRow = `\x1b[48;2;40;40;40m${"hello".padEnd(20)}\x1b[49m`;
		const boxRow = `│ ${"item".padEnd(16)} │`;
		const rightAligned = `${"left"}${" ".repeat(11)}right`;
		vt.present({ viewport: [bgRow, boxRow, rightAligned], cursor: null });
		expect(vt.screen().slice(0, 3)).toEqual(["hello", "│ item             │", "left           right"]);
		// Background fill extends all the way to the last column (col 19).
		expect(vt.term.cell(19, 0)?.bg).toEqual(vt.term.cell(0, 0)?.bg);
	});
});
