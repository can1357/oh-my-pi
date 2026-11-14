import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, setThemeInstance, type Theme } from "../src/theme";
import { lspToolRenderer } from "../src/tools/lsp";

let theme: Theme;

beforeAll(async () => {
	theme = (await getThemeByName("dark"))!;
	setThemeInstance(theme);
});

function renderRequestResult(text: string): string {
	return lspToolRenderer
		.renderResult({ content: [{ type: "text", text }] }, { expanded: false, isPartial: false }, theme, {
			action: "request",
		})
		.render(100)
		.map(row => Bun.stripANSI(row))
		.join("\n");
}

describe("LSP status rows", () => {
	// A status glyph can be plain text (ASCII `[-]`), and a `request` response is the server's text
	// verbatim, so only the diagnostics action's rows that start with a glyph are status rows.
	it("keeps a response that mentions the error glyph mid-line as a response, not diagnostics", () => {
		const text = renderRequestResult(`{"items": ["a ${theme.status.error} b"]}\nsecond line`);

		expect(text).not.toContain("No issues");
		expect(text).toContain(`{"items": ["a ${theme.status.error} b"]}`);
		expect(text).toContain("second line");
	});

	it("keeps a request response whose line starts with the error glyph as a response", () => {
		const text = renderRequestResult(`server ← custom/method:\n${theme.status.error} literal\nkeep-me`);

		expect(text).not.toContain("No issues");
		expect(text).toContain(`${theme.status.error} literal`);
		expect(text).toContain("keep-me");
	});
});

describe("LSP diagnostics", () => {
	const render = (text: string) =>
		lspToolRenderer
			.renderResult({ content: [{ type: "text", text }] }, { expanded: false, isPartial: false }, theme, {
				action: "diagnostics",
				file: "src/a.ts",
			})
			.render(100)
			.map(row => Bun.stripANSI(row).trimEnd());

	// The tool groups diagnostics under `# dir/` and `## file` headers, rows carrying only `line:col`.
	it("lists grouped diagnostics under their file's path, in an error state", () => {
		const rows = render(
			[
				"1 error(s), 1 warning(s):",
				"# src/",
				"## a.ts",
				"  3:5 [error] [ts] Cannot find name 'x'. (2304)",
				"  9:1 [warning] [ts] Unused 'y'. (6133)",
			].join("\n"),
		);
		expect(rows[0]).toStartWith(`${theme.status.error} LSP:`);
		expect(rows[0]).toEndWith("1 error · 1 warning");
		expect(rows.some(row => row.includes("src/a.ts:3:5 [error] [ts] Cannot find name 'x'. (2304)"))).toBe(true);
		expect(rows.some(row => row.includes("src/a.ts:9:1 [warning] [ts] Unused 'y'. (6133)"))).toBe(true);
	});

	it("counts a failed server instead of reporting no issues", () => {
		const rows = render(`${theme.status.error} src/a.ts: all language servers failed (tsserver)`);
		expect(rows[0]).toEndWith("1 server failure");
		expect(rows[0]).not.toContain("No issues");
		expect(rows.join("\n")).toContain("src/a.ts: all language servers failed (tsserver)");
	});

	it("shows a partial server failure as a warning instead of a clean result", () => {
		const partial = render(`OK\n${theme.status.warning} src/a.ts: some servers failed (tsserver)`);
		expect(partial[0]).toStartWith(`${theme.status.warning} LSP:`);
		expect(partial[0]).not.toContain("No issues");
		expect(partial.join("\n")).toContain("src/a.ts: some servers failed (tsserver)");

		const clean = render("OK");
		expect(clean).toEqual([`${theme.symbol("tool.lsp")} LSP: diagnostics src/a.ts No issues`]);
	});

	// A multi-file response carries one summary line per file; the header counts every row.
	it("counts every file's diagnostics, info included", () => {
		const rows = render(
			[
				`${theme.status.error} src/a.ts: 2 error(s)`,
				"# src/",
				"## a.ts",
				"  1:1 [error] one",
				"  2:1 [error] two",
				`${theme.status.error} src/b.ts: 1 error(s), 1 warning(s), 1 info(s)`,
				"# src/",
				"## b.ts",
				"  1:1 [error] three",
				"  2:1 [warning] four",
				"  3:1 [info] five",
			].join("\n"),
		);
		expect(rows[0]).toContain("src/a.ts 3 errors · 1 warning · 1 info");

		const infoOnly = render(["1 info(s):", "# src/", "## a.ts", "  3:5 [info] Prefer const"].join("\n"));
		expect(infoOnly[0]).toEndWith("src/a.ts 1 info");
	});
});
