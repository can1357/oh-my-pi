import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, highlightCode, setThemeInstance, type Theme } from "../src/theme";
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

describe("LSP result header", () => {
	const request = { action: "references", file: "src/a.ts", line: 42, symbol: "validate" } as const;

	it("carries the request and the counts over references grouped per file, each previewing its source line", () => {
		const text = [
			"Found 3 reference(s):",
			"  src/a.ts:42:14",
			"    41: ",
			"    42: export function validate(token: string) {",
			"    43:   return token;",
			"  src/b.ts:7:1",
			"    7: validate(input);",
			"  ... 1 additional reference(s) shown without context",
			"  src/b.ts:120:3",
		].join("\n");
		const rows = lspToolRenderer
			.renderResult({ content: [{ type: "text", text }] }, { expanded: false, isPartial: false }, theme, request)
			.render(100)
			.map(row => Bun.stripANSI(row).trimEnd());
		// Positions right-align across files so the rules line up; one past the context limit has no source to show.
		expect(rows).toEqual([
			`${theme.symbol("tool.lsp")} LSP: references src/a.ts:42 (validate) 3 references · 2 files`,
			"├─ src/a.ts (1)",
			"│  └─ 42:14│ export function validate(token: string) {",
			"└─ src/b.ts (2)",
			"   ├─   7:1│ validate(input);",
			"   └─ 120:3",
		]);
	});

	// Source context that reads like a diagnostics summary or a hover code block stays a reference.
	const misleading: Array<[string, string[], string]> = [
		[
			"a diagnostics count",
			["  src/a.ts:3:7", '    3: const message = "1 error(s)";'],
			'3:7│ const message = "1 error(s)";',
		],
		["a code fence", ["  docs/a.md:3:1", "    2: ```ts", "    3: render(doc);", "    4: ```"], "3:1│ render(doc);"],
	];
	for (const [name, rows, preview] of misleading) {
		it(`keeps a reference whose source holds ${name} a reference`, () => {
			const result = { content: [{ type: "text", text: ["Found 1 reference(s):", ...rows].join("\n") }] };
			const rendered = lspToolRenderer
				.renderResult(result, { expanded: false, isPartial: false }, theme, request)
				.render(100)
				.map(row => Bun.stripANSI(row).trimEnd());
			expect(rendered[0]).toEndWith("1 reference · 1 file");
			expect(rendered.at(-1)).toEndWith(preview);

			const view = lspToolRenderer.describeResult(result, { expanded: false, isPartial: false }, request);
			expect(view?.tool?.meta).toContain("1 reference");
			expect(view?.tone).toBeUndefined();
		});
	}

	it("hangs a failure's message beneath the request and wraps it in full", () => {
		const render = (text: string, width: number) =>
			lspToolRenderer
				.renderResult(
					{ content: [{ type: "text", text }], isError: true },
					{ expanded: false, isPartial: false },
					theme,
					request,
				)
				.render(width)
				.map(row => Bun.stripANSI(row).trimEnd());
		expect(render("No language server found for this file", 100)).toEqual([
			`${theme.status.error} LSP: references src/a.ts:42 (validate)`,
			"  No language server found for this file",
		]);

		const long = render(`tsserver failed: ${"detail ".repeat(20)}END`, 60);
		expect(long.slice(1).every(row => row.startsWith("  "))).toBe(true);
		expect(long.join(" ")).toContain("detail END");
	});
});

describe("LSP source highlighting", () => {
	const render = (text: string, action: "definition" | "references") =>
		lspToolRenderer
			.renderResult({ content: [{ type: "text", text }] }, { expanded: true, isPartial: false }, theme, { action })
			.render(100)
			.join("\n");

	it("highlights a definition's source as one run in the file's language, so a comment carries across rows", () => {
		const text = [
			"Found 1 definition(s):",
			"  src/a.ts:2:1",
			"    1: /* a long",
			"    2: comment */ export const a = 1;",
		];
		const highlighted = highlightCode("/* a long\ncomment */ export const a = 1;", "typescript", theme);
		expect(highlighted[1]).not.toBe(highlightCode("comment */ export const a = 1;", "typescript", theme)[0]);
		expect(render(text.join("\n"), "definition")).toContain(highlighted[1]!);
	});

	it("highlights a reference's preview in the file's language", () => {
		const text = ["Found 1 reference(s):", "  src/a.ts:3:7", "    3: const claims = validate(token);"];
		const highlighted = highlightCode("const claims = validate(token);", "typescript", theme)[0]!;
		expect(render(text.join("\n"), "references")).toContain(highlighted);
	});
});
