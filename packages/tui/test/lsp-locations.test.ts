import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, setThemeInstance, type Theme } from "../src/theme";
import { lspToolRenderer } from "../src/tools/lsp";

let theme: Theme;

beforeAll(async () => {
	theme = (await getThemeByName("dark"))!;
	setThemeInstance(theme);
});

const DEFINITIONS = [
	"Found 3 definition(s):",
	"  src/a.ts:42:17",
	"    41: ",
	"    42: export function validate(token: string) {",
	"    43:   return token;",
	"  src/b.ts:7:3",
	"    6: // overload",
	"    7: function validate(): void;",
	"  src/c.d.ts:1:1",
	"    1: declare function validate(): void;",
].join("\n");

function renderRows(text: string, expanded: boolean, width = 100): string[] {
	return lspToolRenderer
		.renderResult({ content: [{ type: "text", text }] }, { expanded, isPartial: false }, theme, {
			action: "definition",
		})
		.render(width)
		.map(row => Bun.stripANSI(row));
}

describe("LSP definition locations", () => {
	it("counts the definitions and shows each location over its source, its own line marked", () => {
		const rows = renderRows(DEFINITIONS, false).join("\n");
		expect(rows).toContain("3 definitions");
		expect(rows).not.toContain("Found 3 definition(s)");
		expect(rows).toContain("src/a.ts:42:17");
		expect(rows).toMatch(/ {2}\*42│export function validate\(token: string\) \{/);
		expect(rows).toMatch(/ {3}43│ {2}return token;/);
		expect(rows).toMatch(/ {2}\*7│function validate\(\): void;/);
		// Collapsed, the third location sits behind the marker.
		expect(rows).not.toContain("src/c.d.ts");
		expect(rows).toContain("… 1 more definition");
	});

	it("shows every location when expanded", () => {
		const rows = renderRows(DEFINITIONS, true).join("\n");
		expect(rows).toContain("src/c.d.ts:1:1");
		expect(rows).toMatch(/\*1│declare function validate\(\): void;/);
		expect(rows).not.toContain("more definition");
	});

	it("keeps each collapsed source line on one row, cut at the card's edge", () => {
		const long = `export const banner = "${"x".repeat(200)}";`;
		const text = ["Found 1 definition(s):", "  src/a.ts:2:14", "    1: {", `    2: ${long}`, "    3: }"].join("\n");
		const rows = renderRows(text, false, 60);
		const marked = rows.findIndex(row => row.includes("*2│export const banner"));
		expect(rows[marked + 1]).toContain(" 3│}");
	});
});
