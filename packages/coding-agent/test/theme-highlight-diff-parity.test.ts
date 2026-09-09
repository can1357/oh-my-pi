import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, highlightCode, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

const unifiedDiffChunks = [
	[
		"diff --git a/src/example.ts b/src/example.ts",
		"index 1234567..89abcde 100644",
		"--- a/src/example.ts",
		"+++ b/src/example.ts",
		"@@ -1,4 +1,5 @@",
		' import { run } from "./run";',
		"-const enabled = false;",
		"+const enabled = true;",
		"+run(enabled);",
	],
	[
		"@@ -8,4 +9,4 @@ export function start() {",
		" context();",
		'-return "old";',
		'+return "new";',
		"\\ No newline at end of file",
	],
].map(lines => lines.join("\n"));

const unifiedDiff = unifiedDiffChunks.join("\n");
const diffLanguages: Array<"diff" | "patch"> = ["diff", "patch"];

beforeAll(async () => {
	const darkTheme = await getThemeByName("dark");
	if (!darkTheme) throw new Error("Expected dark theme to exist");
	setThemeInstance(darkTheme);
});

describe("diff highlighter chunk parity", () => {
	for (const lang of diffLanguages) {
		it(`highlights newline-complete ${lang} chunks with whole-block visual styles`, () => {
			const completeDiff = `${unifiedDiff}\n`;
			const wholeBlock = highlightCode(completeDiff, lang);
			const chunkedLines = unifiedDiffChunks.flatMap(chunk => {
				const highlighted = highlightCode(`${chunk}\n`, lang);
				return highlighted.slice(0, -1);
			});
			chunkedLines.push("");

			expect(Bun.stripANSI(wholeBlock.join("\n"))).toBe(completeDiff);
			expect(wholeBlock.join("\n")).not.toBe(completeDiff);
			expect(chunkedLines.map(line => line.replace(/^\x1b\[39m/u, ""))).toEqual(
				wholeBlock.map(line => line.replace(/^\x1b\[39m/u, "")),
			);
		});
	}
});
