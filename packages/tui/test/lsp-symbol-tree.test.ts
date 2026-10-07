import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, setThemeInstance, type Theme } from "../src/theme";
import { lspToolRenderer } from "../src/tools/lsp";

let theme: Theme;

beforeAll(async () => {
	theme = (await getThemeByName("dark"))!;
	setThemeInstance(theme);
});

describe("LSP symbols expanded tree", () => {
	it("draws branches and rails for nested siblings, including a sibling after a deeper child", () => {
		const text = [
			"Symbols in src/a.ts:",
			"class Alpha @ line 1",
			"  method one @ line 2",
			"    var inner @ line 3",
			"  method two @ line 5",
			"class Beta @ line 10",
			"  method three @ line 11",
			"function gamma @ line 20",
		].join("\n");
		const rows = lspToolRenderer
			.renderResult({ content: [{ type: "text", text }] }, { expanded: true, isPartial: false }, theme)
			.render(80)
			.map(row => Bun.stripANSI(row).replace(/^│/, "").replace(/\s*│$/, ""));
		const start = rows.findIndex(row => row.includes("in src/a.ts"));
		expect(rows.slice(start + 1, start + 15)).toEqual([
			"  ├─ class Alpha",
			"  │  line 1",
			"  │  ├─ method one",
			"  │  │  line 2",
			"  │  │  └─ var inner",
			"  │  │     line 3",
			"  │  └─ method two",
			"  │     line 5",
			"  ├─ class Beta",
			"  │  line 10",
			"  │  └─ method three",
			"  │     line 11",
			"  └─ function gamma",
			"     line 20",
		]);
	});
});
