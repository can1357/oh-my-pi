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

	it("cuts collapsed source lines at the card's edge and offers expansion for the clipped text", () => {
		const long = `export const banner = "${"x".repeat(200)}";`;
		const text = ["Found 1 definition(s):", "  src/a.ts:2:14", "    1: {", `    2: ${long}`, "    3: }"].join("\n");
		const rows = renderRows(text, false, 60);
		const marked = rows.findIndex(row => row.includes("*2│export const banner"));
		expect(rows[marked + 1]).toContain(" 3│}");
		expect(rows.join("\n")).toContain("Expand");
		expect(renderRows(text, false, 400).join("\n")).not.toContain("Expand");
	});

	it("keeps a location whose path starts with whitespace instead of folding its source into the previous one", () => {
		const text = [
			"Found 2 definition(s):",
			"  src/a.ts:1:1",
			"    1: export const a = 1;",
			"   spaced.ts:3:5",
			"    3: export const spaced = 2;",
		].join("\n");
		const rows = renderRows(text, true).join("\n");
		expect(rows).toMatch(/─ {2}spaced\.ts:3:5/);
		expect(rows).toMatch(/\*3│export const spaced = 2;/);
	});
});
