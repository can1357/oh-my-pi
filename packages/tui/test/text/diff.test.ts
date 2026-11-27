import { describe, expect, it } from "bun:test";
import { type Cell, cellGrid, describeStyle, isBlankCell } from "@oh-my-pi/pi-tui/testing/cells";
import { hasCorpus, loadCase, stageNative } from "@oh-my-pi/pi-tui/testing/corpus";
import {
	compactDiffText,
	parseCompactDiff,
	parseUnifiedDiff,
	renderDiff,
	renderDiffHunks,
	wrapDiffRow,
} from "@oh-my-pi/pi-tui/text/diff";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";

const theme = loadThemeSync("dark");
const strip = (rows: readonly string[]): string[] => rows.map(row => Bun.stripANSI(row));

describe("renderDiff", () => {
	it("draws gutters, blanking a number repeated from the row above", () => {
		const rows = strip(renderDiff("@@ -10,3 +10,3 @@\n 10|a\n-11|b\n+11|c\n 12|d", { theme }));
		expect(rows).toEqual(["@@ -10,3 +10,3 @@", "  10│a", " -11│b", "   +│c", "  12│d"]);
	});

	it("widens the number column past three digits and keeps unnumbered rows bare", () => {
		expect(strip(renderDiff("+1234|x\n 1235|y", { theme }))).toEqual(["+1234│x", " 1235│y"]);
		expect(strip(renderDiff("+x", { theme }))).toEqual(["+x"]);
	});

	it("draws gap rows as a dim ellipsis", () => {
		const rows = renderDiff("-1|a\n\n...\n-9|b", { theme });
		expect(strip(rows)).toEqual(["  -1│a", "…", "…", "  -9│b"]);
		expect(rows[1]).toBe(theme.fg("toolDiffContext", "…"));
	});

	it("colors rows by kind", () => {
		const [removed, added, context] = renderDiff("-1|a\n-2|b\n+1|c\n 3|d", { theme }).filter((_, i) => i !== 1);
		expect(removed).toBe(theme.fg("toolDiffRemoved", "  -1│a"));
		expect(added).toBe(theme.fg("toolDiffAdded", "  +1│c"));
		expect(context).toBe(theme.fg("toolDiffContext", "   3│d"));
	});

	it("marks changed words of a one-for-one replacement in inverse, leaving indentation plain", () => {
		const [removed, added] = renderDiff("-1|  return a > 3;\n+1|  return a >= MAX;", { theme });
		const inverse = (text: string): string => theme.style("inverse", text);
		const dots = "\x1b[2m·\x1b[22m".repeat(2);
		expect(removed).toBe(theme.fg("toolDiffRemoved", `  -1│${dots}return a > ${inverse("3")};`));
		expect(added).toContain(inverse("= MAX"));
		expect(Bun.stripANSI(added!)).toBe("   +│··return a >= MAX;");
	});

	it("shows changed-row indentation as dim dots and tab arrows", () => {
		const [row] = renderDiff("+1|\t x\ty", { theme });
		expect(row).toBe(theme.fg("toolDiffAdded", "  +1│\x1b[2m → \x1b[22m\x1b[2m·\x1b[22mx   y"));
	});

	it("highlights context runs in the file's language", () => {
		const [row] = renderDiff(" 1|const x = 1;", { theme, path: "a.ts" });
		expect(row).toContain(theme.fg("syntaxKeyword", "const"));
		const [plain] = renderDiff(" 1|const x = 1;", { theme, path: "a.unknownext" });
		expect(plain).toBe(theme.fg("toolDiffContext", "   1│const x = 1;"));
	});
});

describe("wrapDiffRow", () => {
	it("hangs continuation rows under the gutter rule", () => {
		const [row] = renderDiff("+12|alpha beta gamma delta", { theme });
		const rows = wrapDiffRow(row!, 16);
		expect(strip(rows)).toEqual([" +12│alpha beta", "    │gamma delta"]);
		for (const wrapped of rows) expect(wrapped.endsWith("\x1b[39m")).toBe(true);
	});

	it("wraps rows without a gutter plainly", () => {
		expect(wrapDiffRow("plain words here", 6)).toEqual(["plain", "words", "here"]);
	});
});

describe("hunks", () => {
	it("parses compact diff text into hunks, splitting at gaps and number jumps", () => {
		expect(parseCompactDiff(" 1|a\n-2|b\n+2|c\n 3|d\n\n 9|anchor only\n…\n-20|x\n+20|y\n-40|z")).toEqual([
			{ oldStart: 1, newStart: 1, lines: [" a", "-b", "+c", " d"] },
			{ oldStart: 20, newStart: 20, lines: ["-x", "+y"] },
			{ oldStart: 40, newStart: 40, lines: ["-z"] },
		]);
	});

	it("parses unified diffs", () => {
		const text = [
			"diff --git a/x b/x",
			"--- a/x",
			"+++ b/x",
			"@@ -1,2 +1,3 @@ fn",
			" keep",
			"-old",
			"+new",
			"+more",
			"\\ No newline at end of file",
			"@@ -10 +11 @@",
			"-z",
		].join("\n");
		expect(parseUnifiedDiff(text)).toEqual([
			{ oldStart: 1, newStart: 1, lines: [" keep", "-old", "+new", "+more"] },
			{ oldStart: 10, newStart: 11, lines: ["-z"] },
		]);
	});

	it("numbers hunks back into compact text and renders them", () => {
		const hunks = [
			{ oldStart: 10, newStart: 12, lines: [" a", "-b", "+c"] },
			{ oldStart: 30, newStart: 32, lines: ["+d"] },
		];
		expect(compactDiffText(hunks)).toBe(" 10|a\n-11|b\n+13|c\n…\n+32|d");
		expect(strip(renderDiffHunks(hunks, 40, { theme }))).toEqual(["  10│a", " -11│b", " +13│c", "…", " +32│d"]);
	});
});

/** A cell as the comparison sees it: everything but the background (the card paints that). */
function look(cell: Cell | undefined): string {
	if (cell === undefined || isBlankCell({ ...cell, bg: "" })) return "blank";
	return `${JSON.stringify(cell.ch)} ${describeStyle({ ...cell, bg: "" })}`;
}

/** The first cell where two grids differ, as a readable message, or "" when they match. */
function firstLookDiff(expected: readonly Cell[][], actual: readonly Cell[][]): string {
	for (let row = 0; row < expected.length; row++) {
		const want = expected[row]!;
		const got = actual[row] ?? [];
		for (let col = 0; col < Math.max(want.length, got.length); col++) {
			if (look(want[col]) === look(got[col])) continue;
			const text = (cells: readonly Cell[]): string => cells.map(cell => cell.ch).join("");
			return `row ${row} col ${col}: expected ${look(want[col])}, got ${look(got[col])}\n  expected: ${text(want)}\n  actual:   ${text(got)}`;
		}
	}
	return "";
}

/**
 * Edit tool cards (tools/edit) draw their diff text with these helpers inside
 * a one-cell border. Every stage that shows the diff's first row must show
 * the rendered, card-width-wrapped rows cell for cell (glyph, colors and
 * attributes, inverse word emphasis included); only the card's background
 * is left out.
 */
describe.skipIf(!hasCorpus("tools/edit"))("corpus: edit tool diffs", () => {
	for (const name of [
		"call-replace-leading-blank-preview",
		"call-replace-preview-diff",
		"result-create-file",
		"result-hashline-input-header",
		"result-long-diff",
		"result-unicode-tabs-diff",
		"result-update-clean",
		"result-update-clean-partial",
		"result-update-with-diagnostics",
	]) {
		it(name, async () => {
			const corpusCase = await loadCase(`tools/edit/${name}.dark`);
			const inputs = corpusCase.inputs as {
				args: { path?: string; file_path?: string; previewDiff?: string };
				result?: { details?: { diff?: string } };
			};
			const text = inputs.args.previewDiff ?? inputs.result?.details?.diff ?? "";
			const path = inputs.args.path ?? inputs.args.file_path;
			const lines = renderDiff(text, { theme, path });
			for (const width of corpusCase.widths) {
				const mine = cellGrid(lines.flatMap(line => wrapDiffRow(line, width - 2)));
				const plain = (cells: readonly Cell[]): string =>
					cells
						.map(cell => cell.ch)
						.join("")
						.trimEnd();
				let shown = 0;
				for (const stage of corpusCase.stages) {
					const rows = stage.rows[String(width)];
					if (!Array.isArray(rows)) continue;
					const inner = cellGrid(rows).map(row => row.slice(1, width - 1));
					const at = inner.findIndex(row => plain(row) === plain(mine[0]!));
					if (at < 0) continue;
					shown++;
					const diff = firstLookDiff(inner.slice(at, at + mine.length), mine);
					expect(diff === "" ? "" : `${stage.label} w${width}: ${diff}`).toBe("");
				}
				expect(shown).toBeGreaterThan(0);
			}
		});
	}

	it("parses the cards' diff text into the hunks their native diff nodes carry", async () => {
		for (const name of [
			"call-replace-leading-blank-preview",
			"call-replace-long-preview-diff",
			"call-replace-preview-diff",
			"result-long-diff",
			"result-unicode-tabs-diff",
			"result-update-clean",
		]) {
			const corpusCase = await loadCase(`tools/edit/${name}.dark`);
			const inputs = corpusCase.inputs as {
				args: { previewDiff?: string };
				result?: { details?: { diff?: string } };
			};
			const text = inputs.args.previewDiff ?? inputs.result?.details?.diff ?? "";
			const diffNodes: unknown[] = [];
			const visit = (node: unknown): void => {
				if (node === null || typeof node !== "object") return;
				const { k, p, c } = node as { k?: string; p?: { hunks?: unknown }; c?: unknown[] };
				if (k === "diff") diffNodes.push(p?.hunks);
				for (const child of c ?? []) visit(child);
			};
			for (let i = 0; i < corpusCase.stages.length; i++) visit(stageNative(corpusCase, i));
			expect(diffNodes.length).toBeGreaterThan(0);
			expect(parseCompactDiff(text)).toEqual(diffNodes.at(-1) as never);
		}
	});
});
