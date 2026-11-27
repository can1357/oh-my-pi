import { describe, expect, it } from "bun:test";
import { UiNode } from "@oh-my-pi/pi-tui/node";
import type { Block } from "@oh-my-pi/pi-tui/term/paint";
import { edgeScrollStep, type SelectionDocument, TranscriptSelection } from "@oh-my-pi/pi-tui/term/selection";
import type { RenderedText, RenderedTextLine, RenderedTextRow } from "@oh-my-pi/pi-tui/term/text-layout";

/** A block whose rows carry logical text. */
function textBlock(rows: readonly string[], text: RenderedText): Block {
	return { rows, text: () => text };
}

/** Greedy word wrap of one logical line at `width` cells from `column`; spaces at wraps are elided. */
function wrapLine(line: RenderedTextLine, width: number, column = 0): { rows: string[]; text: RenderedTextRow[] } {
	const rows: string[] = [];
	const text: RenderedTextRow[] = [];
	let start = 0;
	while (start < line.text.length) {
		let end = Math.min(line.text.length, start + width);
		if (end < line.text.length) {
			const space = line.text.lastIndexOf(" ", end);
			if (space > start) end = space;
		}
		rows.push(" ".repeat(column) + line.text.slice(start, end));
		text.push({ line, start, end, column });
		start = end;
		while (line.text[start] === " ") start++;
	}
	return { rows, text };
}

/** A paragraph block of logical lines wrapped at `width`. */
function paragraph(lines: readonly RenderedTextLine[], width: number): Block {
	const rows: string[] = [];
	const text: RenderedTextRow[] = [];
	for (const line of lines) {
		const wrapped = wrapLine(line, width);
		rows.push(...wrapped.rows);
		text.push(...wrapped.text);
	}
	return textBlock(rows, text);
}

/** Nodes stacked in order; each is preceded by `separators` separator rows (default one, none before the first). */
function documentOf(entries: readonly (readonly [UiNode, Block, separators?: number])[]): SelectionDocument {
	const blocks = new Map(entries.map(([node, block]) => [node, block] as const));
	const tops = new Map<UiNode, number>();
	const rowsAt: ({ node: UiNode; row: number } | undefined)[] = [];
	for (const [node, block, separators = 1] of entries) {
		if (rowsAt.length > 0) for (let gap = 0; gap < separators; gap++) rowsAt.push(undefined);
		tops.set(node, rowsAt.length);
		for (let row = 0; row < block.rows.length; row++) rowsAt.push({ node, row });
	}
	return {
		nodes: entries.map(([node]) => node),
		rows: rowsAt.length,
		block: node => blocks.get(node)!,
		top: node => tops.get(node),
		at: row => rowsAt[row],
	};
}

function node(): UiNode {
	return new UiNode("col", {});
}

/** A selection whose clock only moves when the test says so. */
function selection(): { sel: TranscriptSelection; advance(ms: number): void } {
	let now = 1_000;
	return { sel: new TranscriptSelection({ now: () => now }), advance: ms => (now += ms) };
}

function click(sel: TranscriptSelection, doc: SelectionDocument, row: number, col: number): boolean {
	const started = sel.press(doc, row, col);
	sel.release(doc, row, col);
	return started;
}

describe("TranscriptSelection", () => {
	it("selects a drag across two blocks and highlights both rows", () => {
		const first = node();
		const second = node();
		const doc = documentOf([
			[first, paragraph([{ text: "alpha one" }], 40)],
			[second, paragraph([{ text: "bravo two" }], 40)],
		]);
		const { sel } = selection();
		expect(sel.press(doc, 0, 6)).toBe(true);
		expect(sel.dragging).toBe(true);
		sel.drag(doc, 2, 4);
		sel.release(doc, 2, 4);
		expect(sel.dragging).toBe(false);
		expect(sel.active).toBe(true);
		expect(sel.text(doc)).toBe("one\n\nbravo");
		expect(sel.highlight(doc, 0, doc.rows)).toEqual([
			{ row: 0, ranges: [[6, 9]] },
			{ row: 2, ranges: [[0, 5]] },
		]);
		expect(sel.highlight(doc, 1, 2)).toEqual([]);
	});

	it("joins blocks with a blank line only across separator rows", () => {
		const alpha = node();
		const bravo = node();
		const rule = node();
		const charlie = node();
		const delta = node();
		const doc = documentOf([
			[alpha, paragraph([{ text: "alpha" }], 40)],
			// A compact run: no separator rows, and a decoration-only block is not a separator.
			[bravo, paragraph([{ text: "bravo" }], 40), 0],
			[rule, textBlock(["─────"], [undefined]), 0],
			[charlie, paragraph([{ text: "charlie" }], 40), 0],
			// Several separator rows still copy as one blank line.
			[delta, paragraph([{ text: "delta" }], 40), 3],
		]);
		expect(doc.top(delta)).toBe(7);
		const { sel } = selection();
		sel.press(doc, 0, 0);
		sel.release(doc, 7, 4);
		expect(sel.text(doc)).toBe("alpha\nbravo\ncharlie\n\ndelta");
	});

	it("selects words and whole logical lines on double and triple clicks", () => {
		const block = node();
		const line = { text: "alpha beta_gamma2 delta--epsilon zeta eta theta" };
		const doc = documentOf([[block, paragraph([line, { text: "next" }], 18)]]);
		// Rows: "alpha" | "beta_gamma2" ... wrapped at 18 cells.
		expect(doc.rows).toBeGreaterThan(2);
		const { sel, advance } = selection();
		const row0 = doc.block(block).rows[0]!;
		const col = row0.indexOf("beta") + 2;
		click(sel, doc, 0, col);
		expect(sel.active).toBe(false);
		advance(100);
		click(sel, doc, 0, col);
		expect(sel.text(doc)).toBe("beta_gamma2");
		advance(100);
		click(sel, doc, 0, col);
		expect(sel.text(doc)).toBe(line.text);
		const lineRows = doc.block(block).rows.length - 1;
		expect(sel.highlight(doc, 0, doc.rows).map(h => h.row)).toEqual(Array.from({ length: lineRows }, (_, i) => i));

		// Too slow: a single click again.
		advance(1_000);
		click(sel, doc, 0, col);
		expect(sel.active).toBe(false);

		// Punctuation selects its run of one repeated character.
		const dashRow = doc.block(block).rows.findIndex(row => row.includes("--"));
		const dashCol = doc.block(block).rows[dashRow]!.indexOf("--");
		advance(1_000);
		click(sel, doc, dashRow, dashCol);
		advance(50);
		click(sel, doc, dashRow, dashCol);
		expect(sel.text(doc)).toBe("--");

		// A drag after a double click extends by whole words.
		advance(1_000);
		click(sel, doc, 0, 1);
		advance(50);
		sel.press(doc, 0, 1);
		sel.drag(doc, 0, col);
		sel.release(doc, 0, col);
		expect(sel.text(doc)).toBe("alpha beta_gamma2");
	});

	it("copies a soft-wrapped paragraph as one logical line", () => {
		const block = node();
		const text = "the quick brown fox jumps over the lazy dog again and again";
		const doc = documentOf([[block, paragraph([{ text }, { text: "second line" }], 12)]]);
		const last = doc.rows - 1;
		const { sel } = selection();
		expect(sel.press(doc, 0, 0)).toBe(true);
		sel.release(doc, last, 40);
		expect(sel.text(doc)).toBe(`${text}\nsecond line`);
	});

	it("keeps literal diagram and tree glyphs of rows without logical text", () => {
		const rows = ["┌─────┐", "│ foo │", "└─────┘", "├── branch", "│   └── leaf"];
		const block = node();
		const doc = documentOf([[block, { rows }]]);
		const { sel } = selection();
		expect(sel.press(doc, 0, 0)).toBe(true);
		sel.release(doc, 4, 11);
		expect(sel.text(doc)).toBe(rows.join("\n"));
	});

	it("excludes borders and padding from presses, copies and highlights", () => {
		const block = node();
		const alpha = { text: "alpha" };
		const beta = { text: "beta" };
		const doc = documentOf([
			[
				block,
				textBlock(
					["╭───────╮", "│ alpha │", "│ beta  │", "╰───────╯"],
					[
						undefined,
						{ line: alpha, start: 0, end: 5, column: 2 },
						{ line: beta, start: 0, end: 4, column: 2 },
						undefined,
					],
				),
			],
		]);
		const { sel } = selection();
		expect(sel.press(doc, 0, 3)).toBe(false);
		expect(sel.active).toBe(false);
		// A press on the left border lands on the row's first text cell.
		expect(sel.press(doc, 1, 0)).toBe(true);
		sel.release(doc, 3, 8);
		expect(sel.text(doc)).toBe("alpha\nbeta");
		expect(sel.highlight(doc, 0, doc.rows)).toEqual([
			{ row: 1, ranges: [[2, 7]] },
			{ row: 2, ranges: [[2, 6]] },
		]);
	});

	it("snaps a release over a gap to the nearest text in the drag direction", () => {
		const first = node();
		const second = node();
		const doc = documentOf([
			[first, paragraph([{ text: "alpha one" }], 40)],
			[second, paragraph([{ text: "bravo two" }], 40)],
		]);
		const { sel } = selection();
		// The separator row starts nothing.
		expect(sel.press(doc, 1, 0)).toBe(false);
		// Downward into the gap: through the end of the text above.
		sel.press(doc, 0, 6);
		sel.release(doc, 1, 30);
		expect(sel.text(doc)).toBe("one");
		// Upward into the gap: from the start of the text below.
		sel.press(doc, 2, 4);
		sel.release(doc, 1, 0);
		expect(sel.text(doc)).toBe("bravo");
		// Past a row's text: the end of that row.
		sel.press(doc, 0, 0);
		sel.release(doc, 0, 30);
		expect(sel.text(doc)).toBe("alpha one");
		// Beyond the document: the nearest end.
		sel.press(doc, 2, 6);
		sel.release(doc, doc.rows + 5, 0);
		expect(sel.text(doc)).toBe("two");
	});

	it("keeps anchors through re-layout at another width and repaints with new line objects", () => {
		const block = node();
		const other = node();
		const line = { text: "alpha beta gamma delta epsilon" };
		const wide = documentOf([
			[block, paragraph([line], 40)],
			[other, paragraph([{ text: "tail" }], 40)],
		]);
		const { sel } = selection();
		sel.press(wide, 0, 6);
		sel.release(wide, 0, 15);
		expect(sel.text(wide)).toBe("beta gamma");
		expect(sel.highlight(wide, 0, wide.rows)).toEqual([{ row: 0, ranges: [[6, 16]] }]);

		// Narrower: the same line object wraps into more rows.
		const narrow = documentOf([
			[block, paragraph([line], 11)],
			[other, paragraph([{ text: "tail" }], 40)],
		]);
		sel.validate(narrow);
		expect(sel.active).toBe(true);
		expect(sel.text(narrow)).toBe("beta gamma");
		expect(sel.highlight(narrow, 0, narrow.rows)).toEqual([
			{ row: 0, ranges: [[6, 10]] },
			{ row: 1, ranges: [[0, 5]] },
		]);

		// A repaint with fresh line objects of equal text still resolves.
		const repainted = documentOf([
			[block, paragraph([{ text: line.text }], 40)],
			[other, paragraph([{ text: "tail" }], 40)],
		]);
		sel.validate(repainted);
		expect(sel.text(repainted)).toBe("beta gamma");

		// Different text at the anchored line drops the selection.
		const changed = documentOf([
			[block, paragraph([{ text: "something else entirely" }], 40)],
			[other, paragraph([{ text: "tail" }], 40)],
		]);
		sel.validate(changed);
		expect(sel.active).toBe(false);
		expect(sel.text(changed)).toBeUndefined();
	});

	it("clears when an endpoint node is removed", () => {
		const first = node();
		const second = node();
		const doc = documentOf([
			[first, paragraph([{ text: "alpha" }], 40)],
			[second, paragraph([{ text: "bravo" }], 40)],
		]);
		const { sel } = selection();
		sel.press(doc, 0, 0);
		sel.release(doc, 2, 4);
		expect(sel.text(doc)).toBe("alpha\n\nbravo");
		const without = documentOf([[first, doc.block(first)]]);
		sel.validate(without);
		expect(sel.active).toBe(false);
		expect(sel.clear()).toBe(false);
		expect(sel.highlight(without, 0, without.rows)).toEqual([]);
	});

	it("highlights wide graphemes by their cell widths, per span", () => {
		const block = node();
		const wide = { text: "a界b😀c" };
		const table = { text: "left │ right" };
		const doc = documentOf([
			[
				block,
				textBlock(
					["  a界b😀c", "  left      right"],
					[
						{ line: wide, start: 0, end: wide.text.length, column: 2 },
						{
							line: table,
							start: 0,
							end: table.text.length,
							column: 2,
							spans: [
								{ start: 0, end: 4, column: 2 },
								{ start: 7, end: 12, column: 12 },
							],
						},
					],
				),
			],
		]);
		const { sel } = selection();
		// Columns: a=2, 界=3-4, b=5, 😀=6-7, c=8. The right half of 界 still hits it.
		expect(sel.press(doc, 0, 4)).toBe(true);
		sel.release(doc, 0, 7);
		expect(sel.text(doc)).toBe("界b😀");
		expect(sel.highlight(doc, 0, 1)).toEqual([{ row: 0, ranges: [[3, 8]] }]);

		sel.press(doc, 1, 3);
		sel.release(doc, 1, 13);
		expect(sel.text(doc)).toBe("eft │ ri");
		expect(sel.highlight(doc, 1, 2)).toEqual([
			{
				row: 1,
				ranges: [
					[3, 6],
					[12, 14],
				],
			},
		]);
	});

	it("clear reports whether a selection existed", () => {
		const block = node();
		const doc = documentOf([[block, paragraph([{ text: "alpha" }], 40)]]);
		const { sel } = selection();
		expect(sel.clear()).toBe(false);
		sel.press(doc, 0, 0);
		sel.release(doc, 0, 4);
		expect(sel.clear()).toBe(true);
		expect(sel.active).toBe(false);
	});
});

describe("edgeScrollStep", () => {
	it("is zero inside and bounded outside", () => {
		expect(edgeScrollStep(5, 0, 10)).toBe(0);
		expect(edgeScrollStep(0, 0, 10)).toBe(0);
		expect(edgeScrollStep(9, 0, 10)).toBe(0);
		expect(edgeScrollStep(-1, 0, 10)).toBe(-1);
		expect(edgeScrollStep(-2, 0, 10)).toBe(-2);
		expect(edgeScrollStep(-50, 0, 10)).toBe(-3);
		expect(edgeScrollStep(10, 0, 10)).toBe(1);
		expect(edgeScrollStep(11, 0, 10)).toBe(2);
		expect(edgeScrollStep(500, 0, 10)).toBe(3);
	});
});
