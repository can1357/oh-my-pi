import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-tui/theme";
import { PROBE_WINDOW_BYTES } from "@oh-my-pi/pi-tui/components/markdown";
import { renderMarkdownCell } from "@oh-my-pi/pi-tui/render/code-cell";
import { renderOutputBlock } from "@oh-my-pi/pi-tui/render/output-block";
import { OverlayPanel, PanelRows } from "@oh-my-pi/pi-tui/chrome/overlay-box";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";

describe("renderOutputBlock", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("keeps tool and overlay frame rows inside a one-column viewport", async () => {
		const theme = (await getThemeByName("dark"))!;
		const panel = new OverlayPanel("Heading");
		const body = new PanelRows();
		body.setLines(["x"]);
		panel.addChild(body);

		const frames = [
			renderOutputBlock({ width: 1, header: "Heading", sections: [{ lines: ["x"] }] }, theme),
			panel.render(1),
		];
		for (const rows of frames) {
			expect(Math.max(...rows.map(line => visibleWidth(line)))).toBe(1);
		}
	});

	it("reserves symmetric default padding inside content borders", async () => {
		const theme = (await getThemeByName("dark"))!;
		const lines = renderOutputBlock(
			{
				width: 16,
				applyBg: false,
				sections: [{ lines: ["abcdefghijklmnop"] }],
			},
			theme,
		).map(line => stripVTControlCharacters(line));

		expect(lines.filter(line => line.startsWith("│"))).toEqual(["│ abcdefghijkl │", "│ mnop         │"]);
	});

	it("keeps explicitly flush content flush on both sides", async () => {
		const theme = (await getThemeByName("dark"))!;
		const lines = renderOutputBlock(
			{
				width: 16,
				applyBg: false,
				contentPaddingLeft: 0,
				sections: [{ lines: ["abcdefghijklmn"] }],
			},
			theme,
		).map(line => stripVTControlCharacters(line));

		expect(lines.filter(line => line.startsWith("│"))).toEqual(["│abcdefghijklmn│"]);
	});

	it("budgets collapsed Markdown rows against the padded block width", async () => {
		const theme = (await getThemeByName("dark"))!;
		const lines = renderMarkdownCell(
			{
				content: "x".repeat(27),
				contentMaxLines: 1,
				status: "complete",
				title: "Read",
				width: 30,
			},
			theme,
		).map(line => stripVTControlCharacters(line));

		expect(lines[1]).toBe(`│ ${"x".repeat(26)} │`);
		expect(lines[2]).toStartWith("│ … 1 more line");
	});
});

describe("renderMarkdownCell collapsed previews", () => {
	beforeAll(async () => {
		await initTheme();
	});

	const prose = (label: string, count: number) =>
		Array.from(
			{ length: count },
			(_, i) => `${label} paragraph ${i} carries enough ordinary words to wrap across rows at narrow widths.`,
		).join("\n\n");
	const outro = prose("outro", 100);
	const numbered = (count: number, line: (i: number) => string) => Array.from({ length: count }, (_, i) => line(i));
	/**
	 * `Intro.`, then a construct (`open`, lines one blank line apart, `close`), then
	 * `rest`. The lines are padded so that a `"\n\n"` inside the construct ends
	 * exactly at PROBE_WINDOW_BYTES, the end of the first probe window, where a
	 * probe that stops at the window's end would cut it.
	 */
	const straddleFirstWindow = (open: string, line: (i: number) => string, close: string, rest: string) => {
		const prefix = `Intro.\n\n${open}\n`;
		let body = "";
		let i = 0;
		while (prefix.length + body.length < PROBE_WINDOW_BYTES - 60) body += `${line(i++)}\n\n`;
		body += `${"y".repeat(PROBE_WINDOW_BYTES - prefix.length - body.length - 2)}\n\n${line(i)}\n`;
		return `${prefix}${body}${close}\n\n${rest}`;
	};

	// Each document is over 8 KB and has a construct crossing the first 2 KB
	// probe window, so a collapsed preview renders a cut prefix (or, for the
	// reference definitions and the fence inside an HTML block, the whole
	// document).
	const documents: Record<string, string> = {
		"headings and paragraphs": numbered(60, i => `## Section ${i}\n\n${prose(`section ${i}`, 2)}`).join("\n\n"),
		"a loose list": `Intro.\n\n${numbered(60, i => `- item ${i} with a few words so the list spans the probe window`).join("\n\n")}\n\n${outro}`,
		"a fence": `Intro.\n\n\`\`\`ts\n${numbered(150, i => `const value${i} = ${i};`).join("\n")}\n\`\`\`\n\n${outro}`,
		"a table": `Intro.\n\n| key | value |\n|---|---|\n${numbered(120, i => `| key ${i} | value number ${i} |`).join("\n")}\n\n${outro}`,
		"a block quote": `Intro.\n\n${numbered(80, i => `> quoted line ${i} with some words in it`).join("\n")}\n\n${outro}`,
		"an HTML block": `Intro.\n\n<div>\n${numbered(200, i => `html line ${i}`).join("\n\n")}\n</div>\n\n${outro}`,
		"an HTML comment across the probe window's edge": straddleFirstWindow(
			"<!--",
			i => `comment line ${i}`,
			"-->",
			outro,
		),
		// The renderer's orphan-fence repair pairs the fence inside the <div>
		// with one after the cut; a prefix rendered alone would lose that line.
		"a fence line inside an HTML block": `Intro.\n\n<div>\n\`\`\`\n# H\n| a | b |\n|---|---|\n</div>\n\n${outro}\n\n\`\`\`\ncode\n\`\`\`\n`,
		"a display-math block": `Intro.\n\n$$\n${numbered(150, i => `x_{${i}} = y_{${i}} + z_{${i}}`).join("\n\n")}\n$$\n\n${outro}`,
		"a tab-indented list continuation": `${prose("head", 5)}\n\n- a\n- b\n- c\n\n\tcontinued ${"word ".repeat(600)}\n\n${outro}\n`,
		"a reference definition nested in a quote": `See [the docs][d] for details.\n\n${outro}\n\n> [d]: https://example.com/docs\n`,
		"a reference definition nested in a list": `See [the docs][d] for details.\n\n${outro}\n\n- [d]: https://example.com/docs\n`,
	};

	for (const [name, content] of Object.entries(documents)) {
		it(`shows the first rows of the full render for ${name}`, async () => {
			const theme = (await getThemeByName("dark"))!;
			expect(content.length).toBeGreaterThan(8 * 1024);
			for (const width of [40, 80, 120]) {
				const options = { content, status: "complete" as const, title: "Read", width };
				const collapsed = renderMarkdownCell(options, theme);
				const expanded = renderMarkdownCell({ ...options, expanded: true }, theme);
				// Row 0 is the header; rows 1-12 are the collapsed preview's content.
				expect(collapsed.slice(1, 13)).toEqual(expanded.slice(1, 13));
			}
		});
	}

	it("marks a cut preview's count as a minimum between 1 and the rows expanding shows", async () => {
		const theme = (await getThemeByName("dark"))!;
		// An HTML comment renders no rows, however many source lines it spans.
		const paragraphs = numbered(120, i => `Paragraph ${i} holds a single row of prose.`).join("\n\n");
		const content = `${paragraphs}\n\n<!--\n${numbered(5000, i => `comment line ${i}`).join("\n")}\n-->\n`;
		const options = { content, status: "complete" as const, title: "Read", width: 120 };
		const expandedRows = renderMarkdownCell({ ...options, expanded: true }, theme).length - 2;
		const footer = stripVTControlCharacters(renderMarkdownCell(options, theme)[13]);
		const hidden = /^│ … (\d+)\+ more lines/.exec(footer);
		expect(hidden).not.toBeNull();
		expect(Number(hidden![1])).toBeGreaterThan(0);
		expect(Number(hidden![1])).toBeLessThanOrEqual(expandedRows - 12);
	});

	it("keeps the whole-document count for a document that cannot be cut", async () => {
		const theme = (await getThemeByName("dark"))!;
		const paragraphs = numbered(4600, i => `Paragraph ${i} holds a single row of prose.`).join("\n\n");
		const content = `See [the docs][d] for details.\n\n${paragraphs}\n\n- [d]: https://example.com/docs\n`;
		expect(content.length).toBeGreaterThan(200 * 1024);
		const options = { content, status: "complete" as const, title: "Read", width: 120 };
		// The expanded preview has no footer: every row between header and bottom border is content.
		const expandedRows = renderMarkdownCell({ ...options, expanded: true }, theme).length - 2;
		const collapsed = renderMarkdownCell(options, theme).map(line => stripVTControlCharacters(line));
		expect(collapsed[13]).toStartWith(`│ … ${expandedRows - 12} more lines`);
	});
});
