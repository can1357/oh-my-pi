import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, highlightCode, type Theme } from "../src/theme/theme";
import { classifyGroupedLines, createCodeFrameStyler } from "../src/tools/grouped-file-output";

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
});
