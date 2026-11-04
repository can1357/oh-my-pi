import { beforeAll, describe, expect, it } from "bun:test";
import { ReadToolGroupComponent } from "../src/chat/read-tool-group";
import { ToolExecutionComponent } from "../src/chat/tool-execution";
import { renderCodeCell } from "../src/render/code-cell";
import { PREVIEW_LIMITS, previewWindowRows } from "../src/render/render-utils";
import { askToolRenderer } from "../src/tools/ask";
import { editToolRenderer } from "../src/tools/edit";
import { renderResult as renderLspResult } from "../src/tools/lsp";
import { todoToolRenderer } from "../src/tools/todo";
import { getThemeByName, initTheme } from "../src/theme";
import type { TUI } from "../src/tui";

const width = 60;
const plain = (rows: readonly string[]) => rows.map(row => Bun.stripANSI(row).trimEnd());
const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;

beforeAll(async () => {
	await initTheme();
});

describe("prefixed tool rows", () => {
	it("keeps Write's streaming and finished CJK continuations under the code column", () => {
		const content = "짧은 한국어 문장도 한 글자가 두 칸이라서 금방 화면 끝에 닿아 접히게 됩니다.";
		const args = { path: "/tmp/notes.md", content };
		const streaming = new ToolExecutionComponent("write", args, {}, undefined, ui);
		const finished = new ToolExecutionComponent("write", args, {}, undefined, ui);
		finished.updateResult({ content: [{ type: "text", text: "Wrote /tmp/notes.md" }] }, false);
		for (const card of [streaming, finished]) {
			const rows = plain(card.render(width));
			const numbered = rows.findIndex(row => row.startsWith("│   1 "));
			expect(numbered).toBeGreaterThan(0);
			expect(rows[numbered + 1]).toStartWith("│     ");
			expect(rows[numbered + 1]).toContain("끝에 닿아");
		}
		streaming.dispose?.();
		finished.dispose?.();
	});

	it("keeps grouped Read's URL on its branch and follows the branch on continuations", () => {
		const group = new ReadToolGroupComponent();
		for (const [i, path] of [
			"https://example.com/docs/2026/10/a-fairly-long-article-slug-that-overflows-the-row",
			"https://example.com/short",
		].entries()) {
			group.updateArgs({ path }, `r${i}`);
			group.updateResult({ content: [{ type: "text", text: "ok" }] }, false, `r${i}`);
		}
		const rows = plain(group.render(width));
		expect(rows.find(row => row.startsWith("   ├─ "))).toContain("https://example.com/docs");
		expect(rows.find(row => row.startsWith("   │  "))).toContain("that-overflows-the-row");
		expect(rows.find(row => row.startsWith("   └─ "))).toContain("https://example.com/short");
	});

	it("keeps a numbered Read preview's long line beneath its gutter", async () => {
		const theme = (await getThemeByName("dark"))!;
		const rows = plain(
			renderCodeCell(
				{
					code: "This sentence is long enough that it has to wrap inside the card at sixty columns.",
					codeStartLine: 42,
					width,
				},
				theme,
			),
		);
		const numbered = rows.findIndex(row => row.startsWith("│ 42 "));
		expect(numbered).toBeGreaterThan(0);
		expect(rows[numbered + 1]).toStartWith("│    ");
		expect(rows[numbered + 1]).toContain("inside the card");
	});
	it("hangs streaming Edit diffs under the diff rail", async () => {
		const theme = (await getThemeByName("dark"))!;
		const diff = `@@ -1 +1 @@\n-123│${"before ".repeat(12)}\n+123│${"after ".repeat(12)}`;
		const rows = plain(
			editToolRenderer
				.renderCall({ path: "src/example.ts", previewDiff: diff }, { expanded: true, isPartial: true }, theme)
				.render(width),
		);
		const changed = rows.findIndex(row => row.includes("+123│"));
		expect(changed).toBeGreaterThan(0);
		expect(rows[changed + 1]).toMatch(/^│\s+│/);
		expect(rows[changed + 1]).toContain("after");
	});

	it("caps a streaming Edit tail by its gutter-hung rows", async () => {
		const theme = (await getThemeByName("dark"))!;
		const budget = Math.min(PREVIEW_LIMITS.EXPANDED_LINES, previewWindowRows());
		// Each raw line fits two generic rows at the inner width but three once its
		// content wraps beside the five-column gutter.
		const diff = Array.from({ length: 20 }, (_, i) => `+${i + 10}|${"x".repeat(108)}`).join("\n");
		const rows = plain(
			editToolRenderer
				.renderCall({ path: "src/example.ts", previewDiff: diff }, { expanded: false, isPartial: true }, theme)
				.render(width),
		);
		const diffRows = rows.filter(row => /^│[\s+\-\d]*│x/.test(row));
		expect(diffRows.length).toBeGreaterThan(0);
		expect(diffRows.length).toBeLessThanOrEqual(budget);
	});

	it("follows Todo tree connectors across wrapped task labels", async () => {
		const theme = (await getThemeByName("dark"))!;
		const rows = plain(
			todoToolRenderer
				.renderResult(
					{
						content: [],
						details: {
							storage: "memory",
							phases: [
								{
									name: "Tasks",
									tasks: [
										{
											content:
												"Review the extraordinarily long feature description and verify its remaining details",
											status: "in_progress",
										},
										{ content: "Finish", status: "pending" },
									],
								},
							],
						},
					},
					{ expanded: true, isPartial: false },
					theme,
				)
				.render(width),
		);
		const branch = rows.findIndex(row => row.includes("├─"));
		expect(branch).toBeGreaterThan(0);
		expect(rows[branch + 1]).toMatch(/^│\s+│/);
		expect(rows[branch + 1]).toContain("remaining details");
	});

	it("keeps long Ask answers beneath their markers after submission, including grouped questions", async () => {
		const theme = (await getThemeByName("dark"))!;
		const chosen = "Choose the longer alternative because it contains information important at the end of its label";
		const other = "Leave the other longer alternative visible so its ending still distinguishes the choices";
		const answers = { question: "Pick?", options: [chosen, other], selectedOptions: [chosen] };
		const cards = [
			askToolRenderer.renderResult({ content: [], details: answers }, { expanded: false, isPartial: false }, theme),
			askToolRenderer.renderResult(
				{ content: [], details: { results: [{ id: "choice", multi: false, ...answers }] } },
				{ expanded: false, isPartial: false },
				theme,
			),
		];
		for (const card of cards) {
			const rows = plain(card.render(width));
			const chosenRow = rows.findIndex(row => row.includes("◉ Choose"));
			const otherRow = rows.findIndex(row => row.includes("○ Leave"));
			expect(chosenRow).toBeGreaterThan(0);
			expect(rows[chosenRow + 1]).toStartWith("│    ");
			expect(rows[chosenRow + 1]).toContain("information important");
			expect(otherRow).toBeGreaterThan(0);
			expect(rows[otherRow + 1]).toStartWith("│    ");
			expect(rows[otherRow + 1]).toContain("ending still");
		}
	});

	it("hangs Ask option descriptions and LSP hover code beneath their prefix", async () => {
		const theme = (await getThemeByName("dark"))!;
		const ask = plain(
			askToolRenderer
				.renderCall(
					{
						question: "Pick?",
						options: [
							{
								label: "A",
								description:
									"This detailed description is long enough to require a second row inside the narrow card.",
							},
						],
					},
					{ expanded: false, isPartial: true },
					theme,
				)
				.render(width),
		);
		const description = ask.findIndex(row => row.includes("↳"));
		expect(description).toBeGreaterThan(0);
		expect(ask[description + 1]).toStartWith("│     ");
		expect(ask[description + 1]).toContain("card.");

		for (const expanded of [true, false]) {
			const hover = plain(
				renderLspResult(
					{ content: [{ type: "text", text: `\`\`\`ts\nconst note = "${"long text ".repeat(12)}";\n\`\`\`` }] },
					{ expanded, isPartial: false },
					theme,
				).render(width),
			);
			const codeRow = hover.findIndex(row => row.startsWith("│  │ "));
			expect(codeRow).toBeGreaterThan(0);
			expect(hover[codeRow + 1]).toStartWith("│  │ ");
			expect(hover[codeRow + 1]).toContain("long text");
		}
	});
});
