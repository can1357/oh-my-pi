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

	it("drops the per-match capture rows, keeping every row of each match", async () => {
		const body = await renderCollapsedBody(2, [
			"## a.ts",
			"*1│f(",
			" 2│  a)",
			"  meta: $A=a",
			"## b.ts",
			"*3│f(b)",
			"  meta: $A=b",
		]);
		expect(body.some(line => line.includes("meta:"))).toBe(false);
		// Only a match's first row carries the `*` mark; the rows after it are the rest of the match.
		expect(body.some(line => line.includes("2│  a)"))).toBe(true);
		expect(body.some(line => line.includes("│f(b)"))).toBe(true);
	});
});

describe("astGrepToolRenderer header", () => {
	it("names the scope right after the pattern, before the counts", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		const result = {
			content: [{ type: "text", text: "" }],
			details: {
				matchCount: 1,
				fileCount: 1,
				filesSearched: 4,
				limitReached: false,
				scopePath: "src",
				displayContent: "## src/a.ts\n*1│f(a)",
			},
		};
		const header = sanitizeText(
			astGrepToolRenderer
				.renderResult(result, { expanded: false, isPartial: false }, uiTheme, { pat: "f($A)" })
				.render(120)[0]!,
		);
		expect(header).toContain("AST Grep: f($A) in src 1 match · 1 file · searched 4");
		// The native head reads in the same order.
		const head = astGrepToolRenderer.describeResult(
			result,
			{ expanded: false, isPartial: false },
			{ pat: "f($A)" },
		).head;
		const headText = typeof head === "string" ? head : (head ?? []).map(part => part.t).join("");
		expect(headText).toBe("AST Grep f($A) in src 1 match 1 file searched 4");
	});

	it("shows the title and subject on an error, with the message on the next row", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		const result = { content: [{ type: "text", text: "Pattern parse error" }], isError: true };
		const lines = sanitizeText(
			astGrepToolRenderer
				.renderResult(result, { expanded: false, isPartial: false }, uiTheme, { pat: "f(", path: "src" })
				.render(120)
				.join("\n"),
		).split("\n");
		expect(lines[0]).toContain("AST Grep: f( in src");
		expect(lines[1]).toContain("Pattern parse error");
		const head = astGrepToolRenderer.describeResult(
			result,
			{ expanded: false, isPartial: false },
			{ pat: "f(", path: "src" },
		).head;
		const headText = typeof head === "string" ? head : (head ?? []).map(part => part.t).join("");
		expect(headText).toBe("AST Grep f( in src");
	});

	it("renders zero matches as a single header with a warning-colored count", async () => {
		const uiTheme = (await getThemeByName("dark"))!;
		const result = {
			content: [{ type: "text", text: "" }],
			details: { matchCount: 0, fileCount: 0, filesSearched: 4, limitReached: false, scopePath: "src" },
		};
		const lines = astGrepToolRenderer
			.renderResult(result, { expanded: false, isPartial: false }, uiTheme, { pat: "f($A)" })
			.render(120);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(uiTheme.fg("warning", "0 matches"));
		expect(sanitizeText(lines[0]!)).toContain("AST Grep: f($A) in src 0 matches · searched 4");
		const view = astGrepToolRenderer.describeResult(result, { expanded: false, isPartial: false }, { pat: "f($A)" });
		expect(view.body).toEqual([]);
	});
});
