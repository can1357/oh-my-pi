import { describe, expect, spyOn, test } from "bun:test";
import { logger } from "@oh-my-pi/pi-utils";
import type { UiNode } from "@oh-my-pi/pi-tui";
import { jsx } from "@oh-my-pi/pi-tui/jsx-runtime";
import { staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { setLinkSchemes } from "@oh-my-pi/pi-tui/term/painters/md";
import { renderBlock } from "@oh-my-pi/pi-tui/term/render";
import { blockText, type RenderedText, type RenderedTextRow } from "@oh-my-pi/pi-tui/term/text-layout";
import { type MarkdownOptions, renderMarkdown, renderMarkdownFrame } from "@oh-my-pi/pi-tui/text/markdown/index";
import { sliceCells, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";

const theme = loadThemeSync("dark");

/** A frame's rows (escapes stripped) and text, checked to describe every row. */
function frame(source: string, width: number, options: Partial<MarkdownOptions> = {}) {
	const drawn = renderMarkdownFrame(source, width, { theme, ...options });
	const text = drawn.text();
	expect(text.length).toBe(drawn.rows.length);
	expect(drawn.text()).toBe(text);
	return { rows: drawn.rows.map(row => Bun.stripANSI(row)), text, stable: drawn.stable };
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

describe("markdown text", () => {
	test("the md painter reports a wrapped paragraph as one line whose runs rebuild the source", () => {
		const block = renderBlock(jsx("md", { text: PARAGRAPH }) as UiNode, 20, { env: staticEnvironment(theme) });
		expect(block.text!().length).toBe(block.rows.length);
		const text = blockText(block);
		const line = text[0]!.line;
		expect(line.text).toBe(PARAGRAPH);
		expect(text.every(row => row?.line === line)).toBe(true);
		expect(text.map(row => runs(row).join("")).join(" ")).toBe(PARAGRAPH);
		expectPainted(
			block.rows.map(row => Bun.stripANSI(row)),
			text,
		);
	});

	test("source lines are lines of their own; blank rows between blocks are empty lines", () => {
		const { rows, text } = frame("**bold** first\nsecond line\n\nnext paragraph", 40);
		expect(text.map(row => row && [row.line.text, ...runs(row)])).toEqual([
			["bold first", "bold first"],
			["second line", "second line"],
			["", ""],
			["next paragraph", "next paragraph"],
		]);
		expectPainted(rows, text);
	});

	test("a code block is a line per code line; its fences and indent are not text", () => {
		const { rows, text } = frame("```ts\nconst a = 1;\n    return a + b;\n\nend\n```", 30);
		expect(text[0]).toBeUndefined();
		expect(text.at(-1)).toBeUndefined();
		expect(text.slice(1, -1).map(row => row?.line.text)).toEqual(["const a = 1;", "    return a + b;", "", "end"]);
		expect(text[1]!.column).toBe(2);
		expect(runs(text[2])).toEqual(["return a + b;"]);
		expectPainted(rows, text);
	});

	test("a wrapped code line stays one line; literal code rows keep column 0", () => {
		const code = "const value = compute(alpha, beta, gamma);";
		const { rows, text } = frame(`- item\n\n  \`\`\`\n  ${code}\n  \`\`\``, 20, { codeIndent: 0 });
		const lines = text.filter(row => row?.line.text === code);
		expect(lines.length).toBeGreaterThan(1);
		expect(lines.every(row => row?.line === lines[0]!.line && row.column === 0)).toBe(true);
		expect(lines.map(row => runs(row).join("")).join(" ")).toBe(code);
		expectPainted(rows, text);
	});

	test("a table row is one line with its cells as runs; borders are decoration", () => {
		const { rows, text } = frame(
			"| label | detail |\n| --- | --- |\n| alpha beta gamma delta epsilon | literal ┌─┐ |",
			32,
		);
		const borders = rows.flatMap((row, i) => (/^[┌├└]/.test(row) ? [text[i]] : []));
		expect(borders.length).toBe(3);
		expect(borders.every(row => row === undefined)).toBe(true);
		const header = text[rows.findIndex(row => row.includes("label"))]!;
		expect(header.line.text).toBe("label │ detail");
		expect(runs(header)).toEqual(["label", "detail"]);
		const body = text.filter(row => row?.line.text.startsWith("alpha"));
		expect(body.length).toBeGreaterThan(1);
		expect(body[0]!.line.text).toBe("alpha beta gamma delta epsilon │ literal ┌─┐");
		expect(body.every(row => row?.line === body[0]!.line && row.spans?.length === 2)).toBe(true);
		expect(body[0]!.spans!.map(span => span.column)).toEqual([2, rows[1]!.indexOf("detail")]);
		expectPainted(rows, text);
	});

	test("a cell too narrow to show its text keeps the text in its line", () => {
		const { rows, text } = frame("| h |\n| --- |\n| 界界 |", 5);
		const cut = text.filter(row => row?.line.text === "界界");
		expect(cut.length).toBeGreaterThan(0);
		expect(cut.every(row => runs(row).join("") === "")).toBe(true);
		expectPainted(rows, text);
	});

	test("a list item's text leaves out its bullet, number and checkbox", () => {
		const { rows, text } = frame(
			"- first item that wraps around\n- second\n  - nested\n\n1. ordered\n\n- [x] done",
			20,
		);
		const lines = [...new Set(text.flatMap(row => (row?.line.text ? [row.line] : [])))].map(line => line.text);
		expect(lines).toEqual(["first item that wraps around", "second", "nested", "ordered", "done"]);
		const at = (needle: string) => text.find(row => row?.line.text === needle)!.column;
		expect([at("first item that wraps around"), at("second"), at("nested"), at("ordered"), at("done")]).toEqual([
			2, 2, 4, 3, 6,
		]);
		expectPainted(rows, text);
	});

	test("a quote's text leaves out its bar", () => {
		const { rows, text } = frame("> quoted text that wraps around the bar\n>\n> second para", 20);
		const quoted = text.filter(row => row?.line.text === "quoted text that wraps around the bar");
		expect(quoted.length).toBeGreaterThan(1);
		expect(quoted.every(row => row!.column === 2)).toBe(true);
		expect(text.at(-1)!.line.text).toBe("second para");
		expectPainted(rows, text);
	});

	test("a diagram keeps its glyphs as text", () => {
		const { rows, text } = frame("```mermaid\ngraph LR\nA-->B\n```", 40);
		expect(rows.some(row => /[┌│└►]/.test(row))).toBe(true);
		expect(text.map(row => row?.line.text)).toEqual(rows.map(row => row.trimEnd()));
	});

	test("rules and padding are decoration; horizontal padding moves the text", () => {
		const { rows, text } = frame("above\n\n---\n\nbelow", 20, { paddingX: 2, paddingY: 1 });
		expect(text.map(row => row && [row.line.text, row.column])).toEqual([
			undefined,
			["above", 2],
			["", 0],
			undefined,
			["", 0],
			["below", 2],
			undefined,
		]);
		expectPainted(rows, text);
	});

	test("a sized heading's text is the heading over its reserved rows", () => {
		const { text } = frame("# Big Title\n\nbody", 40, { textSizing: true });
		expect(text.slice(0, 2).map(row => row?.line.text)).toEqual(["Big Title", undefined]);
	});

	test("streaming frames keep their rows and stable head, and settled lines keep their identity", () => {
		const source = "First paragraph that is settled.\n\nSecond paragraph\n\nThird still being written";
		const one = frame(source, 20, { stream: true });
		const two = frame(`${source} and more`, 20, { stream: true });
		expect(one.rows).toEqual(renderMarkdown(source, 20, { theme, stream: true }).map(row => Bun.stripANSI(row)));
		expect(one.stable).toBeGreaterThan(0);
		expect(two.stable).toBe(one.stable);
		expect(two.text[0]!.line).toBe(one.text[0]!.line);
		expect(two.text.at(-1)!.line.text).toBe("Third still being written and more");
		expectPainted(two.rows, two.text);
	});

	const CORPUS = [
		PARAGRAPH,
		"# Heading\n\n## Second\n\n### Third level heading that wraps\n\ntext",
		"- a\n  - b\n    - c with a longer item text\n- [ ] task\n\n3. three\n4. four",
		"> quote\n>\n> - list in quote\n>\n> ```\n> code in quote\n> ```",
		"| a | b | c |\n| :-- | :-: | --: |\n| left | center | right aligned cell |\n| x | | z |",
		"- container:\n\n  | Item |\n  | --- |\n  | TABLE_CELL alpha beta gamma delta |",
		"<b>bold</b> and <i>italic</i>\n\n<details>raw html</details>",
		"Inline `code` and [a link](https://example.com/path) and $x^2$.\n\n$$\n\\frac{a}{b}\n$$",
		"```python\ndef f(x):\n\treturn x  # a comment long enough to wrap around\n```",
		"Text\n\n***\n\nMore text\n\n1. one\n\n   para in item\n2. two",
		"See [the docs][d] here.\n\n[d]: https://example.com/docs\n\nMore text that refers to [d] again",
	];

	test("an extension link's label stays text once its markers come out of the rows", () => {
		setLinkSchemes(["demo"]);
		try {
			const block = renderBlock(jsx("md", { text: "Open [the demo](demo:x) now" }) as UiNode, 40, {
				env: staticEnvironment(theme),
			});
			expect(block.hits?.length).toBe(1);
			const text = blockText(block);
			expect(text[0]!.line.text).toBe("Open the demo now");
			expectPainted(
				block.rows.map(row => Bun.stripANSI(row)),
				text,
			);
		} finally {
			setLinkSchemes([]);
		}
	});

	test("every frame's text describes every row and points at what the row paints", () => {
		const warn = spyOn(logger, "warn");
		try {
			for (const source of CORPUS) {
				for (const width of [12, 20, 33, 80]) {
					for (const options of [{}, { paddingX: 1, paddingY: 1 }, { codeIndent: 0 }, { stream: true }]) {
						const { rows, text } = frame(source, width, options);
						expectPainted(rows, text);
					}
				}
			}
			// Every prefix of a document as it streams in: settled heads, open fences, growing tables.
			const document = CORPUS.join("\n\n");
			for (let end = 1; end <= document.length; end += 5) {
				const { rows, text } = frame(document.slice(0, end), 30, { stream: true });
				expectPainted(rows, text);
			}
			// Drawing a frame's text again draws the frame's own rows: it never falls back to reading them.
			expect(warn.mock.calls.filter(([message]) => String(message).includes("markdown text"))).toEqual([]);
		} finally {
			warn.mockRestore();
		}
	});
});
