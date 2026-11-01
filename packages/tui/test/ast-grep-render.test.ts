import { describe, expect, it } from "bun:test";
import { getThemeByName } from "@oh-my-pi/pi-tui/theme";
import { astGrepToolRenderer } from "@oh-my-pi/pi-tui/tools/ast-grep";
import { sanitizeText } from "@oh-my-pi/pi-utils";

async function renderCollapsedBody(matchCount: number, displayContent: string[]): Promise<string[]> {
	const uiTheme = (await getThemeByName("dark"))!;
	const result = {
		content: [{ type: "text", text: "" }],
		details: {
			matchCount,
			fileCount: 2,
			filesSearched: 2,
			limitReached: false,
			displayContent: displayContent.join("\n"),
		},
	};
	const lines = astGrepToolRenderer
		.renderResult(result, { expanded: false, isPartial: false }, uiTheme, { pat: "f($A)" })
		.render(120);
	return sanitizeText(lines.join("\n")).split("\n").slice(1);
}

describe("astGrepToolRenderer collapsed preview", () => {
	it("shows the head of a single file taller than the preview and counts the matches it hides", async () => {
		const body = await renderCollapsedBody(
			8,
			Array.from({ length: 8 }, (_, i) => `*${i + 1}│f(${i})`),
		);
		expect(body.filter(line => line.includes("│f("))).toHaveLength(5);
		expect(body.at(-1)).toContain("… 3 more matches");
	});

	it("cuts the next file short and counts the matches left out, not the files", async () => {
		const body = await renderCollapsedBody(7, [
			"# src/",
			"## a.ts",
			"*1│f(a)",
			"## b.ts",
			"*1│f(b)",
			"*2│f(c)",
			"*3│f(d)",
			"*4│f(e)",
			"## c.ts",
			"*1│f(f)",
			"*2│f(g)",
		]);
		expect(body.filter(line => line.includes("│f("))).toHaveLength(3);
		expect(body.some(line => line.includes("src/c.ts"))).toBe(false);
		expect(body.at(-1)).toContain("… 4 more matches");
	});
});
