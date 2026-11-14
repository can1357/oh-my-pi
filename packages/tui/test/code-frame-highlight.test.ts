import { afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import * as themeModule from "../src/theme/theme";
import { getThemeByName, highlightCode, type Theme } from "../src/theme/theme";
import { classifyGroupedLines, createCodeFrameStyler } from "../src/tools/grouped-file-output";

afterEach(() => {
	vi.restoreAllMocks();
});

let theme: Theme;

beforeAll(async () => {
	theme = (await getThemeByName("dark"))!;
});

function styleSearchRows(lines: string[]): (string | undefined)[] {
	const style = createCodeFrameStyler(lines, classifyGroupedLines(lines, undefined), "toolOutput", theme);
	return lines.map((_, index) => style(index));
}

describe("search code frames", () => {
	it("highlights consecutive rows of one file as one text, so a comment carries across rows", () => {
		const rows = styleSearchRows([
			"## a.ts",
			" 1│/* start",
			"*2│   end */ const x = 1;",
			" 9│   end */ const y = 2;",
		]);
		expect(rows[0]).toBeUndefined();
		const joined = highlightCode("/* start\n   end */ const x = 1;", "typescript", theme);
		expect(rows[2]).toBe(`${theme.fg("toolOutput", "*2│")}${joined[1]}`);
		// Line 9 does not follow line 2: it starts its own run, outside the comment.
		const alone = highlightCode("   end */ const y = 2;", "typescript", theme);
		expect(rows[3]).toBe(`${theme.fg("toolOutput", " 9│")}${alone[0]}`);
	});

	it("keeps the flat tint for a file in a language the highlighter lacks", () => {
		const rows = styleSearchRows(["## notes.unknownext", "*3│plain text"]);
		expect(rows[1]).toBe(`${theme.fg("toolOutput", "*3│")}${theme.fg("toolOutput", "plain text")}`);
	});

	it("highlights only a bounded chunk of a huge match for the rows actually requested", () => {
		const lines = ["## big.ts", ...Array.from({ length: 2000 }, (_, i) => ` ${i + 1}│const v${i} = ${i};`)];
		const style = createCodeFrameStyler(lines, classifyGroupedLines(lines, undefined), "toolOutput", theme);
		const highlight = spyOn(themeModule, "highlightCode");
		style(1);
		style(2000);
		const highlightedRows = highlight.mock.calls.reduce((rows, [code]) => rows + code.split("\n").length, 0);
		expect(highlight).toHaveBeenCalledTimes(2);
		expect(highlightedRows).toBeLessThanOrEqual(128);
	});

	it("highlights in the searched language when ast_grep overrode the file's", () => {
		const lines = ["## a.h", "*1│class A {};"];
		const style = createCodeFrameStyler(lines, classifyGroupedLines(lines, undefined), "toolOutput", theme, "cpp");
		expect(style(1)).toBe(`${theme.fg("toolOutput", "*1│")}${highlightCode("class A {};", "cpp", theme)[0]}`);
	});
});
