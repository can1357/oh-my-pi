import { describe, expect, it } from "bun:test";
import { plainRows } from "../../src/testing/cells";
import {
	holdPartialTableRow,
	repairOrphanClosingFence,
	type MarkdownOptions,
	renderMarkdown,
	renderMarkdownFrame,
	speculativeStreamingSource,
} from "../../src/text/markdown";
import { visibleWidth } from "../../src/text/width";
import { loadThemeSync } from "../../src/theme";

const theme = loadThemeSync("dark");
const stream: MarkdownOptions = { theme, paddingX: 1, stream: true };

const DOCUMENTS = [
	[
		"## Streaming",
		"",
		"Some **bold text** and a list:",
		"",
		"- one",
		"- two",
		"",
		"| a | b |",
		"|---|---|",
		"| 1 | 2 |",
		"| 3 | 4 |",
		"",
		"```ts",
		"const x = 1;",
		"const y = 2;",
		"```",
		"",
		"Done.",
	].join("\n"),
	[
		"Intro paragraph that is long enough to wrap at narrow widths.",
		"",
		"* loose one",
		"",
		"* loose two",
		"",
		"  continuation",
		"",
		"> quoted **text**",
		"> continues",
		"",
		"1. first",
		"2. second",
		"",
		"Math $x^2$ and [a link](https://example.com/path).",
		"",
		"$$",
		"a + b",
		"$$",
		"",
		"Title",
		"=====",
		"",
		"Final words.",
	].join("\n"),
];

describe("stable prefix", () => {
	for (const [index, document] of DOCUMENTS.entries()) {
		for (const width of [20, 40, 80]) {
			it(`never changes a stable row as document ${index} grows (width ${width})`, () => {
				const final = renderMarkdown(document, width, { ...stream, stream: false });
				let stableSeen = 0;
				for (let length = 1; length <= document.length; length++) {
					const frame = renderMarkdownFrame(document.slice(0, length), width, stream);
					expect(frame.stable).toBeLessThanOrEqual(frame.rows.length);
					// Every stable row is already the row the finished document shows.
					expect(frame.rows.slice(0, frame.stable)).toEqual(final.slice(0, frame.stable));
					stableSeen = Math.max(stableSeen, frame.stable);
				}
				expect(stableSeen).toBeGreaterThan(0);
			});
		}
	}

	it("settles everything before the block being written", () => {
		const frame = renderMarkdownFrame("# Title\n\nFirst paragraph.\n\nSecond par", 40, stream);
		expect(plainRows(frame.rows)).toEqual([" Title", "", " First paragraph.", "", " Second par"]);
		expect(frame.stable).toBe(4);
	});

	it("does not settle a list a later item could still continue", () => {
		expect(renderMarkdownFrame("- one\n- two\n\n", 40, stream).stable).toBe(0);
		expect(renderMarkdownFrame("- one\n- two\n\nNext", 40, stream).stable).toBe(3);
	});

	it("does not settle a paragraph a following line could still turn into a heading", () => {
		expect(renderMarkdownFrame("Title\n=", 40, stream).stable).toBe(0);
	});

	it("counts the top padding as stable and nothing without streaming", () => {
		const options = { ...stream, paddingY: 2 };
		expect(renderMarkdownFrame("a\n\nb", 40, options).stable).toBe(4);
		expect(renderMarkdownFrame("a\n\nb", 40, { ...options, stream: false }).stable).toBe(0);
	});
});

describe("speculatively closed spans", () => {
	const prose = "Opening prose long enough to wrap across a couple of terminal rows here.";
	const render = (text: string, open: boolean): string[] => renderMarkdown(text, 60, { theme, stream: open });

	it("renders an open link or math span as the closed form it streams toward", () => {
		for (const [open, closed] of [
			[`${prose} See [the docs](https://example.com/a/b`, `${prose} See [the docs](https://example.com/a/b)`],
			[`${prose} Value $\\frac{a+b}{c`, `${prose} Value $\\frac{a+b}{c}$`],
			[`${prose} Value \\(x^2 + \\sqr`, `${prose} Value \\(x^2 + \\)`],
			["- item\n- see [docs](https://ex", "- item\n- see [docs](https://ex)"],
			[`${prose} See [wiki](https://e.org/F_(m`, `${prose} See [wiki](https://e.org/F_(m))`],
			[`${prose} Value $$x^2$`, `${prose} Value $$x^2$$`],
		]) {
			expect(render(open!, true)).toEqual(render(closed!, false));
		}
	});

	it("leaves currency, escapes, images and code spans literal", () => {
		for (const text of [
			`${prose} It costs $5 per mo`,
			`${prose} Escaped \\$x^2`,
			`${prose} Escaped \\[docs](https://ex`,
			`${prose} ![alt](https://ex`,
			`${prose} Code \`[docs](https://ex`,
			`${prose} Code \`$x^2`,
			`${prose} Code \`$x^2\` and`,
		]) {
			expect(render(text, true)).toEqual(render(text, false));
		}
	});

	it("closes only the last block's span, and nothing inside an open fence", () => {
		expect(speculativeStreamingSource("Paid $5 and $\n\nValue $x^")).toBe("Paid $5 and $\n\nValue $x$");
		expect(speculativeStreamingSource("Value $x^\n\nNext")).toBe("Value $x^\n\nNext");
		expect(speculativeStreamingSource("Done.\n\n```md\nSee [docs](https://ex")).toBe(
			"Done.\n\n```md\nSee [docs](https://ex",
		);
		expect(speculativeStreamingSource("- item\n\n    ```md\n    See [docs](https://ex")).toBe(
			"- item\n\n    ```md\n    See [docs](https://ex",
		);
		expect(speculativeStreamingSource("    ```\n    code\n\nSee [docs](https://ex")).toBe(
			"    ```\n    code\n\nSee [docs](https://ex)",
		);
	});
});

describe("holdPartialTableRow", () => {
	const table = "Intro.\n\n| PR | Title |\n| --- | :-: |\n| #1 | one |";

	it("drops only the growing row of a table, keeping the newline before it", () => {
		expect(holdPartialTableRow(`${table}\n| [#2](https://exa`)).toBe(`${table}\n`);
		expect(holdPartialTableRow(`${table}\n`)).toBe(`${table}\n`);
		const bare = "PR | Title\n--- | ---\n#1 | one";
		expect(holdPartialTableRow(`${bare}\n#2 | tw`)).toBe(`${bare}\n`);
	});

	it("only grows while a quoted table streams, whatever the chunk boundaries", () => {
		const source = "> | h |\n> | - |\n> | a |\n> | b |\n>\n> after";
		let sent = "";
		for (let length = 1; length <= source.length; length++) {
			const next = holdPartialTableRow(source.slice(0, length));
			expect(next.startsWith(sent)).toBe(true);
			sent = next;
		}
		expect(sent).toBe(source);
	});

	it("keeps pipe lines that are no table yet or sit inside an open fence", () => {
		for (const text of [
			"| a |\n| b",
			"| a |\n| --- | -",
			"\n| a |\n| b",
			`\`\`\`md\n${table}\n| #2`,
			`~~~~\n\`\`\`\n~~~\n${table}\n| #2`,
		]) {
			expect(holdPartialTableRow(text)).toBe(text);
		}
		expect(holdPartialTableRow(`\`\`\`ts\nx\n\`\`\`\n\n${table}\n| #2`)).toBe(`\`\`\`ts\nx\n\`\`\`\n\n${table}\n`);
		expect(holdPartialTableRow(`    \`\`\`\n    code\n\n${table}\n| #2`)).toBe(`    \`\`\`\n    code\n\n${table}\n`);
	});
});

describe("streaming tables", () => {
	it("keeps the rows above while the last row's open cell grows", () => {
		const table = "| PR | Title |\n| --- | --- |\n| [#1](https://example.com/pull/1) | short title |\n";
		const settled = plainRows(renderMarkdown(table, 60, { theme, stream: true }));
		for (const [partial, shown] of [
			["| [#2](https://example.com/pull/2", "#2 (https://example.com/pull/2)"],
			["| [#2](https://example.com/pull/2) | a much longer title than the others", "a much"],
		]) {
			const rows = plainRows(renderMarkdown(table + partial, 60, { theme, stream: true }));
			expect(rows.slice(0, settled.length - 1)).toEqual(settled.slice(0, -1));
			expect(rows.slice(settled.length - 1).some(row => row.includes(shown!))).toBe(true);
		}
	});

	it("holds the row's height while its open cell grows, then shows the cell whole", () => {
		const table = "| # | Name | Score |\n| --- | --- | --- |\n| 1 | black | 1.1 |\n| 2 | bright";
		const label = "green with a long label that wraps";
		const frame = (tail: string): string[] => plainRows(renderMarkdown(table + tail, 40, { theme, stream: true }));
		const open = [" gr", " green", ` ${label}`].map(frame);
		expect(open.map(rows => rows.length)).toEqual([open[0]!.length, open[0]!.length, open[0]!.length]);
		expect(open[2]!.some(row => row.includes("…"))).toBe(true);
		const closed = frame(` ${label} | 2.2 |`);
		expect(closed.length).toBeGreaterThanOrEqual(open[0]!.length);
		const words = closed.join(" ").replace(/│/g, " ").split(/\s+/);
		expect(label.split(" ").every(word => words.includes(word))).toBe(true);
	});

	it("marks the held lines of a one-cell column in place", () => {
		const rows = plainRows(
			renderMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |\n| x<br>y<br>z | defgh", 12, { theme, stream: true }),
		);
		expect(rows.slice(-4, -1)).toEqual(["│ x │ d │", "│ y │ e │", "│ z │ … │"]);
	});

	it("keeps the border column when the held cell holds wide glyphs", () => {
		const rows = renderMarkdown("| a | bb |\n| --- | --- |\n| 1 | 22 |\n| x<br>y | 漢字漢", 12, {
			theme,
			stream: true,
		});
		expect(new Set(plainRows(rows).map(row => visibleWidth(row))).size).toBe(1);
		expect(plainRows(rows).slice(-3, -1)).toEqual(["│ x │ 漢 │", "│ y │ …  │"]);
	});

	it("measures a finished last row without its trailing newline", () => {
		const text = "| PR | Title |\n| --- | --- |\n| #1 | short |\n| #2 | a considerably longer finished title here |";
		expect(renderMarkdown(text, 80, { theme, stream: true })).toEqual(renderMarkdown(text, 80, { theme }));
	});
});

describe("repairOrphanClosingFence", () => {
	const report = [
		"Average Latency: 1,240 ms",
		"```",
		"",
		"### Status",
		"",
		"| A | B |",
		"| :--- | :--- |",
		"| x | y |",
	];

	it("drops a bare closing fence with no opener before a heading and a table", () => {
		expect(repairOrphanClosingFence(report.join("\n"))).toBe(report.filter(line => line !== "```").join("\n"));
	});

	it("keeps a fence that an intro opens, and matched fences", () => {
		const example = ["Example:", ...report.slice(1)].join("\n");
		expect(repairOrphanClosingFence(example)).toBe(example);
		const matched = ["text", "```", "code", "```", "### H", "| A | B |", "| --- | --- |"].join("\n");
		expect(repairOrphanClosingFence(matched)).toBe(matched);
	});
});
