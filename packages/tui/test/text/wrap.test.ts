import { describe, expect, it } from "bun:test";
import { visibleWidth, wrap, wrapBeside, wrapChars, wrapHanging } from "@oh-my-pi/pi-tui/text/width";

const UNDERLINE_ON = "\x1b[4m";
const UNDERLINE_OFF = "\x1b[24m";

describe("wrap", () => {
	it("wraps by words within the width, one row per line break", () => {
		const rows = wrap("hello world this is a test", 10);
		expect(rows.length).toBeGreaterThan(1);
		for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(10);
		expect(wrap("a\n\nb", 10)).toEqual(["a", "", "b"]);
		expect(wrap("", 10)).toEqual([""]);
		expect(wrap("x", 0)).toEqual([]);
	});

	it("hard-breaks words longer than a row and breaks between CJK ideographs", () => {
		expect(wrap("aaaaaaaaaaaaaaaaaaaaa bb", 8)).toEqual(["aaaaaaaa", "aaaaaaaa", "aaaaa bb"]);
		expect(wrap("日本語のテキストです", 5)).toEqual(["日本", "語の", "テキ", "スト", "です"]);
	});

	it("never exceeds the width with trailing whitespace", () => {
		expect(visibleWidth(wrap("  ", 1)[0]!)).toBeLessThanOrEqual(1);
	});

	it("starts a style on the row its text lands on", () => {
		const url = "https://example.com/very/long/path/that/will/wrap";
		const rows = wrap(`read this thread ${UNDERLINE_ON}${url}${UNDERLINE_OFF}`, 40);
		expect(rows[0]).toBe("read this thread");
		expect(rows[1]!.startsWith(UNDERLINE_ON)).toBe(true);
	});

	it("closes underline (not everything) at row ends so it never bleeds into padding", () => {
		const url = "https://example.com/very/long/path/that/will/definitely/wrap";
		const rows = wrap(`prefix ${UNDERLINE_ON}${url}${UNDERLINE_OFF} suffix`, 30);
		for (let i = 1; i < rows.length - 1; i++) {
			if (!rows[i]!.includes(UNDERLINE_ON)) continue;
			expect(rows[i]!.endsWith(UNDERLINE_OFF)).toBe(true);
			expect(rows[i]!.endsWith("\x1b[0m")).toBe(false);
		}
		expect(wrap(`${UNDERLINE_ON}underlined text here ${UNDERLINE_OFF}more`, 18)[0]).not.toContain(
			` ${UNDERLINE_OFF}`,
		);
	});

	it("carries colors across rows without full resets", () => {
		const rows = wrap("\x1b[44mhello world this is blue background text\x1b[0m", 15);
		for (const row of rows) expect(row).toContain("\x1b[44m");
		for (const row of rows.slice(0, -1)) expect(row.endsWith("\x1b[0m")).toBe(false);
		const red = wrap("\x1b[31mhello world this is red\x1b[0m", 10);
		for (const row of red.slice(1)) expect(row.startsWith("\x1b[31m")).toBe(true);
	});

	it("closes strikethrough at row ends while colors carry on", () => {
		const text = "\x1b[38;5;196m\x1b[48;5;236m\x1b[9mstrikethrough content that wraps across lines\x1b[29m\x1b[0m";
		const rows = wrap(text, 16);
		expect(rows.length).toBeGreaterThan(1);
		for (const row of rows.slice(0, -1)) expect(row.endsWith("\x1b[29m")).toBe(true);
		for (const row of rows.slice(1)) {
			expect(row).toContain("38;5;196");
			expect(row).toContain("48;5;236");
		}
	});
});

describe("wrapChars", () => {
	it("hard-wraps at exact columns keeping every space", () => {
		expect(wrapChars("ab cd ef", 3)).toEqual(["ab ", "cd ", "ef"]);
		expect(wrapChars("a\n\nb", 4)).toEqual(["a", "", "b"]);
	});

	it("never splits a wide grapheme; one wider than the row gets its own row", () => {
		expect(wrapChars("a日本", 2)).toEqual(["a", "日", "本"]);
		expect(wrapChars("日x", 1)).toEqual(["日", "x"]);
	});

	it("keeps styles open across rows", () => {
		const rows = wrapChars("\x1b[31mabcdef", 3);
		expect(rows).toHaveLength(2);
		expect(rows[1]!.startsWith("\x1b[31m")).toBe(true);
	});
});

describe("hanging wraps", () => {
	it("indents continuation rows under the line's own leading whitespace", () => {
		expect(wrapHanging("    one two three four five six", 16)).toEqual([
			"    one two",
			"    three four",
			"    five six",
		]);
		expect(wrapHanging("\tone two three four", 12)).toEqual(["\tone two", "   three", "   four"]);
	});

	it("hangs after an explicit number of cells", () => {
		expect(wrapHanging("1. alpha beta gamma delta", 12, 3)).toEqual(["1. alpha", "   beta", "   gamma", "   delta"]);
	});

	it("falls back to a plain wrap when the hang would take over half the row", () => {
		expect(wrapHanging("          alpha beta", 12)).toEqual(wrap("          alpha beta", 12));
		expect(wrapHanging("  short", 20)).toEqual(["  short"]);
	});

	it("wraps content beside a prefix with a custom continuation", () => {
		expect(wrapBeside(" 12│", "alpha beta gamma", 10, "   │")).toEqual([" 12│alpha", "   │beta", "   │gamma"]);
		expect(wrapBeside("- ", "alpha beta", 7)).toEqual(["- alpha", "  beta"]);
	});
});
