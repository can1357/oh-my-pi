import { describe, expect, test } from "bun:test";
import type { UiNode } from "@oh-my-pi/pi-tui";
import { RESERVED_ROW } from "@oh-my-pi/pi-tui/driver/images/anchor";
import { KITTY_PLACEHOLDER } from "@oh-my-pi/pi-tui/driver/images/kitty";
import { jsx } from "@oh-my-pi/pi-tui/jsx-runtime";
import { type Block, staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { stack } from "@oh-my-pi/pi-tui/term/painters/layout";
import { renderBlock } from "@oh-my-pi/pi-tui/term/render";
import {
	blockText,
	lazyText,
	literalRenderedText,
	mapWrappedText,
	offsetRenderedText,
	type RenderedText,
	type RenderedTextRow,
	sliceRenderedText,
} from "@oh-my-pi/pi-tui/term/text-layout";
import { sliceCells, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";

const theme = loadThemeSync("dark");

function el(kind: string, props: Record<string, unknown> = {}, ...children: UiNode[]): UiNode {
	return jsx(kind, children.length > 0 ? { ...props, children } : props) as UiNode;
}

/** Paint `node` at `width` and check its own text report describes every row. */
function paint(node: UiNode, width: number): { block: Block; rows: string[]; text: RenderedText } {
	const block = renderBlock(node, width, { env: staticEnvironment(theme) });
	expect(block.text).toBeFunction();
	expect(block.text!().length).toBe(block.rows.length);
	return { block, rows: block.rows.map(row => Bun.stripANSI(row)), text: blockText(block) };
}

/** Every run of every row is what the row paints at the run's columns. */
function expectPainted(rows: readonly string[], text: RenderedText): void {
	expect(text.length).toBe(rows.length);
	text.forEach((row, i) => {
		for (const span of row?.spans ?? (row ? [row] : [])) {
			const run = row!.line.text.slice(span.start, span.end);
			expect(sliceCells(rows[i]!, span.column, visibleWidth(run)).text).toBe(run);
		}
	});
}

/** The runs of `row` as text. */
function runs(row: RenderedTextRow | undefined): string[] {
	return (row?.spans ?? (row ? [row] : [])).map(span => row!.line.text.slice(span.start, span.end));
}

const PARAGRAPH = "Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu.";

describe("text-layout helpers", () => {
	test("literal rows drop escapes and trailing blanks; image rows are decoration", () => {
		expect(literalRenderedText("\x1b[31m  red\x1b[0m \x1b]8;;https://e.test\x07link\x1b]8;;\x07   ")).toEqual({
			line: { text: "  red link" },
			start: 0,
			end: 10,
			column: 0,
		});
		expect(literalRenderedText(RESERVED_ROW)).toBeUndefined();
		expect(literalRenderedText(`\x1b[38;2;0;0;1m${KITTY_PLACEHOLDER}\x1b[39m`)).toBeUndefined();
		expect(literalRenderedText("\x1b_Gf=100,a=T;AAAA\x1b\\")).toBeUndefined();
		expect(literalRenderedText("\x1b]1337;File=inline=1:AAAA\x07")).toBeUndefined();
		expect(literalRenderedText("\x1b7\x1b[2A\x1bP0;1;0q#0~\x1b\\\x1b8")).toBeUndefined();
	});

	test("blockText reads rows literally without a usable report, keeping line identities", () => {
		const plain: Block = { rows: ["one", "two"] };
		const first = blockText(plain);
		expect(first.map(row => row?.line.text)).toEqual(["one", "two"]);
		expect(blockText(plain)[0]!.line).toBe(first[0]!.line);
		const short: Block = { rows: ["one", "two"], text: () => [undefined] };
		expect(blockText(short).map(row => row?.line.text)).toEqual(["one", "two"]);
	});

	test("lazyText computes once, on the first call", () => {
		let calls = 0;
		const text = lazyText(() => {
			calls++;
			return [undefined];
		});
		expect(calls).toBe(0);
		expect(text()).toBe(text());
		expect(calls).toBe(1);
	});

	test("mapWrappedText finds each row's run in order across lines, blank rows included", () => {
		const text = mapWrappedText("alpha beta\n\n  gamma delta", ["alpha", "beta", "", "  gamma", "delta"]);
		expect(text.map(row => row && [row.line.text, row.start, row.end, row.column])).toEqual([
			["alpha beta", 0, 5, 0],
			["alpha beta", 6, 10, 0],
			["", 0, 0, 0],
			["  gamma delta", 2, 7, 2],
			["  gamma delta", 8, 13, 0],
		]);
		expect(text[0]!.line).toBe(text[1]!.line);
	});

	test("mapWrappedText maps a cut row to the run before its ellipsis and reads unknown rows literally", () => {
		const text = mapWrappedText("abcdef\nnext", ["abc…", "made up", "next"]);
		expect(text.map(row => row && runs(row))).toEqual([["abc"], ["made up"], ["next"]]);
		expect(text[0]!.line.text).toBe("abcdef");
		expect(text[2]!.line.text).toBe("next");
	});

	test("offsetRenderedText moves a row and its runs", () => {
		const row: RenderedTextRow = {
			line: { text: "a │ b" },
			start: 0,
			end: 1,
			column: 2,
			spans: [
				{ start: 0, end: 1, column: 2 },
				{ start: 4, end: 5, column: 6 },
			],
		};
		expect(offsetRenderedText(row, 3)).toEqual({
			line: row.line,
			start: 0,
			end: 1,
			column: 5,
			spans: [
				{ start: 0, end: 1, column: 5 },
				{ start: 4, end: 5, column: 9 },
			],
		});
		expect(offsetRenderedText(undefined, 3)).toBeUndefined();
	});

	test("sliceRenderedText keeps only what the kept rows show of lines they share with dropped rows", () => {
		const text = mapWrappedText("one two three\nfour five", ["one two", "three", "four", "five"]);
		const tail = sliceRenderedText(text, 1, 3);
		expect(tail.map(row => row?.line.text)).toEqual(["three", "four"]);
		expect(tail.map(row => runs(row))).toEqual([["three"], ["four"]]);
		expect(sliceRenderedText(text, 0, 2)).toEqual(text.slice(0, 2));
	});
});

describe("layout painters", () => {
	test("a wrapped text node maps every row to one line whose runs rebuild the source", () => {
		const { rows, text } = paint(el("text", { text: PARAGRAPH }), 20);
		expect(rows.length).toBeGreaterThan(2);
		const line = text[0]!.line;
		expect(line.text).toBe(PARAGRAPH);
		for (const row of text) expect(row!.line).toBe(line);
		expect(text.map(row => runs(row).join("")).join(" ")).toBe(PARAGRAPH);
		expectPainted(rows, text);
	});

	test("a cut or line-limited text node keeps only what it shows", () => {
		const cut = paint(el("text", { text: `${PARAGRAPH}\nsecond`, truncate: "end" }), 20);
		expect(cut.rows.length).toBe(2);
		expect(cut.text[0]!.line.text).toBe(PARAGRAPH.slice(0, 19));
		expect(cut.text[1]!.line.text).toBe("second");
		expectPainted(cut.rows, cut.text);
		const limited = paint(el("text", { text: PARAGRAPH, lines: 2 }), 20);
		expect(limited.rows.length).toBe(2);
		const shown = limited.text.map(row => runs(row).join("")).join(" ");
		expect(limited.text[1]!.line.text).toBe(shown);
		expect(PARAGRAPH.startsWith(shown)).toBe(true);
		expectPainted(limited.rows, limited.text);
	});

	test("a column stacks its children's text with gap rows as decoration", () => {
		const { rows, text } = paint(
			el("col", { gap: "sm" }, el("text", { text: "first" }), el("text", { text: PARAGRAPH })),
			20,
		);
		expect(text[0]!.line.text).toBe("first");
		expect(text[1]).toBeUndefined();
		expect(text.slice(2).every(row => row?.line.text === PARAGRAPH)).toBe(true);
		expectPainted(rows, text);
	});

	test("stack places each child's text at its row offset", () => {
		const env = staticEnvironment(theme);
		const a = renderBlock(el("text", { text: "a b c" }), 1, { env });
		const b = renderBlock(el("text", { text: "d" }), 1, { env });
		const block = stack([a, { rows: [] }, b], 2);
		expect(block.text!().length).toBe(block.rows.length);
		const text = blockText(block);
		expect(text.map(row => row?.line.text)).toEqual(["a b c", "a b c", "a b c", undefined, undefined, "d"]);
		expect(text.map(row => row?.column)).toEqual([0, 0, 0, undefined, undefined, 0]);
	});

	test("a row reads as one line of disjoint runs at their columns", () => {
		const { rows, text } = paint(
			el("row", { gap: "sm" }, el("text", { text: "Name:" }), el("text", { text: "Alice" })),
			30,
		);
		expect(rows).toEqual(["Name: Alice"]);
		expect(text[0]!.line.text).toBe("Name: Alice");
		expect(text[0]!.spans).toEqual([
			{ start: 0, end: 5, column: 0 },
			{ start: 6, end: 11, column: 6 },
		]);
		expectPainted(rows, text);
	});

	test("a row keeps a wrapped child's line whole beside a one-row gutter", () => {
		const { rows, text } = paint(
			el("row", {}, el("text", { text: "●" }), el("text", { text: "wrapped paragraph text here" })),
			14,
		);
		const line = text[0]!.line;
		expect(line.text).toBe("wrapped paragraph text here");
		expect(text.every(row => row?.line === line)).toBe(true);
		expect(text[0]!.column).toBe(rows[0]!.indexOf("wrapped"));
		expectPainted(rows, text);
	});

	test("a rule's label is text and its line is not", () => {
		expect(paint(el("rule"), 20).text).toEqual([undefined]);
		const { rows, text } = paint(el("rule", { label: "Section" }), 30);
		expect(runs(text[0])).toEqual(["Section"]);
		expect(text[0]!.column).toBe(4);
		expectPainted(rows, text);
	});
});

describe("container and content painters", () => {
	test("a card's frame is decoration; its head and body are text at their columns", () => {
		const { rows, text } = paint(el("card", { head: "Head" }, el("text", { text: "inside the card body text" })), 20);
		expect(text[0]!.line.text).toBe("Head");
		expect(text[0]!.column).toBe(3);
		expect(text.at(-1)).toBeUndefined();
		const body = text.slice(1, -1);
		expect(body.every(row => row?.line.text === "inside the card body text" && row.column === 2)).toBe(true);
		expectPainted(rows, text);
	});

	test("a collapsed card keeps only its preview's text", () => {
		const { rows, text } = paint(
			el("card", { head: "H", collapsed: true, preview: { lines: 1 } }, el("text", { text: "one two three four" })),
			12,
		);
		expect(text.map(row => row?.line.text)).toEqual(["H", "one two", undefined, undefined]);
		expectPainted(rows, text);
	});

	test("a tool's status glyph is chrome and its body follows the head", () => {
		const { rows, text } = paint(
			el(
				"tool",
				{ status: "done", title: "Read", target: "file.ts", frame: "inline" },
				el("text", { text: "body" }),
			),
			30,
		);
		expect(text.map(row => row?.line.text)).toEqual(["Read file.ts", "body"]);
		expect(text[1]!.column).toBe(2);
		expectPainted(rows, text);
	});

	test("a section's marker is chrome; its children are indented text", () => {
		const { rows, text } = paint(
			el("section", { head: "Details", collapsible: true }, el("text", { text: "inner text" })),
			30,
		);
		expect(text.map(row => row && [row.line.text, row.column])).toEqual([
			["Details", 2],
			["inner text", 2],
		]);
		expectPainted(rows, text);
	});

	test("an overlay's frame and padding are decoration", () => {
		const { rows, text } = paint(el("overlay", { head: "Sheet" }, el("text", { text: "inside" })), 20);
		expect(text.map(row => row?.line.text)).toEqual(["Sheet", "inside", undefined]);
		expectPainted(rows, text);
	});

	test("a tree keeps its connector glyphs as text; a cut row keeps what it shows", () => {
		const { rows, text } = paint(
			el("tree", { nodes: [{ label: "root", open: true, children: [{ label: "leaf" }, { label: "last" }] }] }),
			30,
		);
		expect(text.map(row => row?.line.text)).toEqual(rows.map(row => row.trimEnd()));
		expect(text[1]!.line.text).toContain("├");
		expect(text[2]!.line.text).toContain("└");
		expectPainted(rows, text);
		const cut = paint(el("tree", { nodes: [{ label: "a label far too long for the row" }] }), 12);
		expect(cut.rows[0]!.endsWith(theme.symbols.ellipsis)).toBe(true);
		expect(cut.text[0]!.line.text).toBe("└─ a label");
		expectPainted(cut.rows, cut.text);
		const json = paint(el("json", { value: { a: 1, b: { c: [1, 2] } }, open: 1 }), 30);
		expect(json.text.map(row => row?.line.text)).toEqual(json.rows.map(row => row.trimEnd()));
		expectPainted(json.rows, json.text);
	});

	test("code is a line per source line, without its gutter", () => {
		const { rows, text } = paint(
			el("code", { text: "const a = 1;\n\treturn a + b + c;", numbers: true, wrap: true }),
			16,
		);
		expect(text[0]!.line.text).toBe("const a = 1;");
		const second = text.slice(1);
		expect(second.every(row => row?.line === second[0]!.line)).toBe(true);
		expect(second[0]!.line.text.trimStart()).toBe("return a + b + c;");
		expect(text.every(row => row!.column >= 3)).toBe(true);
		expectPainted(rows, text);
	});

	test("a diff line is its source content, gutter and indentation markers aside", () => {
		const { rows, text } = paint(el("diff", { text: "-1|old line\n+1|    new line long enough to wrap" }), 24);
		expect(text[0]!.line.text).toBe("old line");
		const added = text.slice(1);
		expect(added.length).toBeGreaterThan(1);
		const line = added[0]!.line;
		expect(line.text).toBe("    new line long enough to wrap");
		expect(added.every(row => row?.line === line)).toBe(true);
		// Indentation shows as markers as long as it is: the runs index the source content.
		expect(added.map(row => runs(row).join("")).join(" ")).toBe(line.text);
		const gutter = rows[1]!.indexOf("│") + 1;
		expect(added.every(row => row!.column >= gutter)).toBe(true);
	});

	test("an image is decoration", () => {
		const { text } = paint(el("image", { alt: "[Image]" }), 20);
		expect(text).toEqual([undefined]);
	});

	test("a key/value grid reads each pair as one line of two runs", () => {
		const { rows, text } = paint(el("kv", { items: [{ k: "cost", v: "$1" }] }), 24);
		expect(text[0]!.line.text).toBe("cost $1");
		expect(runs(text[0])).toEqual(["cost", "$1"]);
		expectPainted(rows, text);
	});

	test("command output is a line per output line; a clamp keeps what it shows", () => {
		const full = paint(el("ansi", { text: "one\ntwo is long enough to wrap" }), 12);
		expect(full.text.map(row => row?.line.text)).toEqual([
			"one",
			...full.rows.slice(1).map(() => "two is long enough to wrap"),
		]);
		expectPainted(full.rows, full.text);
		const clamped = paint(el("ansi", { text: "one\ntwo is long enough to wrap", preview: { lines: 1 } }), 12);
		expect(clamped.text).toEqual([full.text[0], undefined]);
	});
});
