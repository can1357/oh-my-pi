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
	it("lists grouped diagnostics under their file's path", () => {
		const rows = render(
			[
				"1 error(s), 1 warning(s):",
				"# src/",
				"## a.ts",
				"  3:5 [error] [ts] Cannot find name 'x'. (2304)",
				"  9:1 [warning] [ts] Unused 'y'. (6133)",
			].join("\n"),
		);
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
});
