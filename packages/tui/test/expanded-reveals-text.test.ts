import { beforeAll, describe, expect, it } from "bun:test";
import { getThemeByName, initTheme, type Theme } from "../src/theme";
import { loadTheme } from "../src/theme/loader";
import { debugToolRenderer } from "../src/tools/debug";
import { renderDefaultToolExecution } from "../src/tools/default-renderer";
import { renderResult as renderLspResult } from "../src/tools/lsp";
import { renderMCPResult } from "../src/tools/mcp";
import { renderResult as renderTaskResult } from "../src/tools/task";
import { webSearchToolRenderer } from "../src/tools/web-search";
import { yieldToolRenderer } from "../src/tools/yield";
import type { Component } from "../src/tui";

// Ctrl+O (#15824): an expanded result must show every character of a long row,
// wrapped to the frame, instead of re-clipping it to a fixed column budget.
const width = 100;
const MARK = "ENDMARK";
const long = `${"wide-content ".repeat(16)}${MARK}`;
let theme: Theme;

beforeAll(async () => {
	await initTheme();
	theme = (await getThemeByName("dark"))!;
});

const plain = (component: Component) => Bun.stripANSI(component.render(width).join("\n"));
const marks = (component: Component) => plain(component).split(MARK).length - 1;

describe("expanded tool results reveal clipped rows", () => {
	const cases: Array<[string, number, (expanded: boolean) => Component]> = [
		[
			"lsp generic",
			1,
			expanded =>
				renderLspResult({ content: [{ type: "text", text: long }] }, { expanded, isPartial: false }, theme),
		],
		[
			"lsp diagnostics message",
			1,
			expanded =>
				renderLspResult(
					{ content: [{ type: "text", text: `1 error(s)\nsrc/a.ts:3:5 [error] [ts] ${long} (2345)` }] },
					{ expanded, isPartial: false },
					theme,
				),
		],
		[
			"debug output",
			1,
			expanded =>
				debugToolRenderer.renderResult(
					{ content: [{ type: "text", text: long }] },
					{ expanded, isPartial: false },
					theme,
				),
		],
		[
			"default tool output",
			1,
			expanded =>
				renderDefaultToolExecution(
					{ label: "custom", args: {}, result: { output: long }, options: { expanded, isPartial: false } },
					theme,
				),
		],
		[
			"mcp text output",
			1,
			expanded =>
				renderMCPResult({ content: [{ type: "text", text: long }] }, { expanded, isPartial: false }, theme),
		],
		[
			"web search fallback",
			1,
			expanded =>
				webSearchToolRenderer.renderResult(
					{ content: [{ type: "text", text: long }] },
					{ expanded, isPartial: false },
					theme,
				),
		],
		[
			"yield string data",
			1,
			expanded => yieldToolRenderer.renderCall({ data: long }, { expanded, isPartial: false }, theme),
		],
		[
			"task assignment, output and error",
			3,
			expanded =>
				renderTaskResult(
					{
						content: [{ type: "text", text: "Ran 1 agent" }],
						details: {
							projectAgentsDir: null,
							totalDurationMs: 1,
							results: [
								{
									index: 0,
									id: "A",
									agent: "task",
									agentSource: "bundled",
									task: `assign ${long}`,
									exitCode: 1,
									error: `err ${long}`,
									output: `out ${long}`,
									stderr: "",
									truncated: false,
									durationMs: 5,
									tokens: 0,
									requests: 1,
								},
							],
						},
					},
					{ expanded, isPartial: false },
					theme,
				),
		],
	];

	for (const [name, expectedMarks, build] of cases) {
		it(`${name}: clipped while collapsed, whole once expanded`, () => {
			expect(marks(build(false))).toBe(0);
			const expanded = build(true);
			expect(marks(expanded)).toBe(expectedMarks);
			expect(expanded.render(width).every(row => Bun.stringWidth(row) <= width)).toBe(true);
		});
	}
});

describe("lsp expand hint", () => {
	const references = (count: number) =>
		`${count} reference(s)\n${Array.from({ length: count }, (_, i) => `  src/a.ts:${i + 1}:1`).join("\n")}`;

	it("lists every reference location once expanded", () => {
		const text = plain(
			renderLspResult(
				{ content: [{ type: "text", text: references(5) }] },
				{ expanded: true, isPartial: false },
				theme,
			),
		);
		expect(text).toContain("line 5, col 1");
		expect(text).not.toContain("more");
	});

	it("advertises Ctrl+O only when the collapsed view hides something", () => {
		const hint = (text: string) =>
			plain(
				renderLspResult({ content: [{ type: "text", text }] }, { expanded: false, isPartial: false }, theme),
			).includes("Expand");
		expect(hint(references(1))).toBe(false);
		expect(hint(references(2))).toBe(true);
		expect(hint("Reloaded")).toBe(false);
		expect(hint(long)).toBe(true);
		expect(hint(`1 error(s)\nsrc/a.ts:3:5 [error] [ts] ${long} (2345)`)).toBe(true);
	});
});

describe("expanded lsp detail rows", () => {
	it("keep the active preset's tree rail on wrapped continuation rows", async () => {
		const ascii = await loadTheme("dark", { symbolPresetOverride: "ascii" });
		const text = `2 error(s)\nsrc/a.ts:3:5 [error] [ts] ${long} (1)\nsrc/b.ts:9:1 [error] [ts] short (2)`;
		const rows = renderLspResult({ content: [{ type: "text", text }] }, { expanded: true, isPartial: false }, ascii)
			.render(70)
			.map(row => Bun.stripANSI(row));
		const first = rows.findIndex(row => row.includes("[ts] wide-content"));
		const last = rows.findIndex(row => row.includes(MARK));
		expect(last).toBeGreaterThan(first);
		for (const row of rows.slice(first, last + 1)) expect(row).toStartWith(`|  ${ascii.tree.vertical}  `);
	});
});
