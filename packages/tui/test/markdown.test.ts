import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import {
	autolinkSchemeScanIndex,
	clearRenderCache,
	Markdown,
	renderInlineMarkdown,
	urlTokenPossible,
} from "@oh-my-pi/pi-tui/components/markdown";
import { setTerminalTextSizing, TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { type Component, TUI } from "@oh-my-pi/pi-tui/tui";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
import { Chalk } from "@oh-my-pi/pi-utils/chalk";
import { mathStartIndex } from "@oh-my-pi/pi-utils/math-delimiters";
import { defaultMarkdownTheme } from "./test-themes.js";
import { VirtualTerminal } from "./virtual-terminal.js";

// Force full color in CI so ANSI assertions are deterministic
const chalk = new Chalk({ level: 3 });

function getCellItalic(terminal: VirtualTerminal, row: number, col: number): boolean {
	return terminal.getCellItalic(row, col);
}

describe("renderInlineMarkdown", () => {
	it("preserves ST-terminated OSC 8 links before inline lexing", () => {
		const st = "\x1b\\";
		const input = `\x1b]8;;file:///tmp/example.ts${st}\`example.ts\`\x1b]8;;${st}`;
		const rendered = renderInlineMarkdown(input, defaultMarkdownTheme);
		const plain = stripVTControlCharacters(rendered.replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, ""));

		expect(rendered.includes("\x1b]8;;file:///tmp/example.ts\x07")).toBeTruthy();
		expect(plain).toBe("example.ts");
	});

	it("preserves ordered list items as visible inline text", () => {
		const rendered = renderInlineMarkdown("1. Review against a base branch (PR Style)", defaultMarkdownTheme);
		const plain = stripVTControlCharacters(rendered);

		expect(plain).toBe("1. Review against a base branch (PR Style)");
	});

	it("returns empty string for undefined input (streaming guard)", () => {
		// During streaming, partial JSON can leave option label fields as undefined.
		// renderInlineMarkdown must not throw in that case.
		const rendered = renderInlineMarkdown(undefined as unknown as string, defaultMarkdownTheme);
		expect(rendered).toBe("");
	});

	it("applies baseColor to fallback for non-string input", () => {
		const rendered = renderInlineMarkdown(null as unknown as string, defaultMarkdownTheme, t => `[${t}]`);
		expect(rendered).toBe("[]");
	});
});

describe("Markdown component", () => {
	describe("Nested lists", () => {
		it("should render simple nested list", () => {
			const markdown = new Markdown(
				`- Item 1
  - Nested 1.1
  - Nested 1.2
- Item 2`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);

			// Strip ANSI codes for checking
			const plainLines = lines.map(line => stripVTControlCharacters(line));

			// Check structure
			expect(plainLines.some(line => line.includes("- Item 1"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("  - Nested 1.1"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("  - Nested 1.2"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("- Item 2"))).toBeTruthy();
		});

		it("should render deeply nested list", () => {
			const markdown = new Markdown(
				`- Level 1
  - Level 2
    - Level 3
      - Level 4`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => stripVTControlCharacters(line));

			// Check proper indentation
			expect(plainLines.some(line => line.includes("- Level 1"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("  - Level 2"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("    - Level 3"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("      - Level 4"))).toBeTruthy();
		});

		it("should render ordered nested list", () => {
			const markdown = new Markdown(
				`1. First
   1. Nested first
   2. Nested second
2. Second`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => stripVTControlCharacters(line));

			expect(plainLines.some(line => line.includes("1. First"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("  1. Nested first"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("  2. Nested second"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("2. Second"))).toBeTruthy();
		});

		it("should render mixed ordered and unordered nested lists", () => {
			const markdown = new Markdown(
				`1. Ordered item
   - Unordered nested
   - Another nested
2. Second ordered
   - More nested`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => stripVTControlCharacters(line));

			expect(plainLines.some(line => line.includes("1. Ordered item"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("  - Unordered nested"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("2. Second ordered"))).toBeTruthy();
		});

		it("wraps unordered list continuations under the item text", () => {
			const markdown = new Markdown("- Alpha beta gamma delta epsilon", 0, 0, defaultMarkdownTheme);

			const plainLines = markdown.render(16).map(line => stripVTControlCharacters(line).trimEnd());

			expect(plainLines).toEqual(["- Alpha beta", "  gamma delta", "  epsilon"]);
			expect(plainLines.every(line => visibleWidth(line) <= 16)).toBe(true);
		});

		it("uses the full ordered-list marker width as the hanging indent", () => {
			const markdown = new Markdown("10. Alpha beta gamma delta", 0, 0, defaultMarkdownTheme);

			const plainLines = markdown.render(16).map(line => stripVTControlCharacters(line).trimEnd());

			expect(plainLines).toEqual(["10. Alpha beta", "    gamma delta"]);
			expect(plainLines.every(line => visibleWidth(line) <= 16)).toBe(true);
		});

		it("keeps list rows within width when the marker consumes the line", () => {
			const markdown = new Markdown("123456789. x", 0, 0, defaultMarkdownTheme);

			const plainLines = markdown.render(8).map(line => stripVTControlCharacters(line).trimEnd());

			expect(plainLines.every(line => visibleWidth(line) <= 8)).toBe(true);
			expect(plainLines.join("")).toContain("x");
		});

		it("should maintain numbering when code blocks are not indented (LLM output)", () => {
			// When code blocks aren't indented, marked parses each item as a separate list.
			// We use token.start to preserve the original numbering.
			const markdown = new Markdown(
				`1. First item

\`\`\`typescript
// code block
\`\`\`

2. Second item

\`\`\`typescript
// another code block
\`\`\`

3. Third item`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => stripVTControlCharacters(line).trim());

			// Find all lines that start with a number and period
			const numberedLines = plainLines.filter(line => /^\d+\./.test(line));

			// Should have 3 numbered items
			expect(numberedLines.length, `Expected 3 numbered items, got: ${numberedLines.join(", ")}`).toBe(3);

			// Check the actual numbers
			expect(numberedLines[0].startsWith("1."), `First item should be "1.", got: ${numberedLines[0]}`).toBeTruthy();
			expect(numberedLines[1].startsWith("2."), `Second item should be "2.", got: ${numberedLines[1]}`).toBeTruthy();
			expect(numberedLines[2].startsWith("3."), `Third item should be "3.", got: ${numberedLines[2]}`).toBeTruthy();
		});
	});

	describe("Tables", () => {
		it("preserves ST-terminated OSC 8 links inside table cells", () => {
			const st = "\x1b\\";
			const fileLink = `\x1b]8;;file:///tmp/DisplayTypeEnum.java${st}\`DisplayTypeEnum.java\`\x1b]8;;${st}`;
			const markdown = new Markdown(
				`| Module | Local file | Change |
| --- | --- | --- |
| common | ${fileLink} | Added display type |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const width = 80;
			const lines = markdown.render(width);
			const output = lines.join("\n");
			const plainOutput = stripVTControlCharacters(output.replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, ""));

			expect(output.includes("\x1b]8;;file:///tmp/DisplayTypeEnum.java\x07")).toBeTruthy();
			expect(plainOutput.includes("DisplayTypeEnum.java")).toBeTruthy();
			expect(plainOutput.includes("`DisplayTypeEnum.java`")).toBeFalsy();
			for (const line of lines) {
				expect(visibleWidth(line), `Line exceeds width ${width}`).toBeLessThanOrEqual(width);
			}
		});

		it("should render simple table", () => {
			const markdown = new Markdown(
				`| Name | Age |
| --- | --- |
| Alice | 30 |
| Bob | 25 |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => stripVTControlCharacters(line));

			// Check table structure
			expect(plainLines.some(line => line.includes("Name"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("Age"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("Alice"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("Bob"))).toBeTruthy();
			// Check for table borders
			expect(plainLines.some(line => line.includes("|"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("-"))).toBeTruthy();
		});

		it("recovers rich Markdown after a lone closing fence from Gemini", () => {
			const markdown = new Markdown(
				`=== PACED IP ROTATION SOAK RESULTS ===
Total Queries: 20
Average Latency: 1,240 ms
\`\`\`

---

### Production Deployment Status

| Workload | Pod Status |
| :--- | :--- |
| google-scraper | **1/1 Running** |`,
				0,
				0,
				defaultMarkdownTheme,
			);
			markdown.transientRenderCache = true;
			markdown.render(80);

			markdown.transientRenderCache = false;
			const plainLines = markdown.render(80).map(line => stripVTControlCharacters(line).trimEnd());

			expect(plainLines.some(line => line.includes("| :--- | :--- |"))).toBe(false);
			expect(plainLines.filter(line => line.includes("+")).length).toBeGreaterThanOrEqual(2);
			expect(plainLines.some(line => line.includes("google-scraper") && line.includes("1/1 Running"))).toBe(true);
		});

		it("keeps an intentional unclosed fenced Markdown example literal", () => {
			const markdown = new Markdown(
				`Markdown source:
\`\`\`
### Production Deployment Status

| Workload | Pod Status |
| :--- | :--- |
| google-scraper | 1/1 Running |`,
				0,
				0,
				defaultMarkdownTheme,
			);
			const plainLines = markdown.render(80).map(line => stripVTControlCharacters(line).trimEnd());

			expect(plainLines.some(line => line.includes("| :--- | :--- |"))).toBe(true);
			expect(plainLines.filter(line => line.includes("+"))).toHaveLength(0);
		});

		it("keeps a four-space-indented tree child inside its paragraph", () => {
			const markdown = new Markdown(
				`Two verified cases:

├── **case 1** — first branch
│   └── each family has its own counter
└── **case 3: unnumbered limits**
    └── limits that carry **only a label** are dropped from the list`,
				0,
				0,
				defaultMarkdownTheme,
			);
			const plainLines = markdown.render(80).map(line => stripVTControlCharacters(line).trimEnd());

			// The attached indented line is a lazy paragraph continuation, never an
			// indented code block: no fence border rows, no literal bold markers.
			expect(plainLines.filter(line => line.includes("```"))).toHaveLength(0);
			expect(plainLines.some(line => line.includes("only a label"))).toBe(true);
			expect(plainLines.some(line => line.includes("**"))).toBe(false);
		});

		it("keeps an unfinished code block with a rule and heading literal when no table follows", () => {
			const markdown = new Markdown(
				`The process printed this
\`\`\`
---
### Still inside the unfinished block`,
				0,
				0,
				defaultMarkdownTheme,
			);
			const plainLines = markdown.render(80).map(line => stripVTControlCharacters(line).trimEnd());

			expect(plainLines.some(line => line.includes("---"))).toBe(true);
			expect(plainLines.some(line => line.includes("### Still inside the unfinished block"))).toBe(true);
		});

		it("should render row dividers between data rows", () => {
			const markdown = new Markdown(
				`| Name | Age |
| --- | --- |
| Alice | 30 |
| Bob | 25 |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => stripVTControlCharacters(line));
			const dividerLines = plainLines.filter(line => line.includes("+"));

			expect(dividerLines.length >= 2, "Expected header + row divider").toBeTruthy();
		});

		it("should keep column width at least the longest word", () => {
			const longestWord = "superlongword";
			const markdown = new Markdown(
				`| Column One | Column Two |
| --- | --- |
| ${longestWord} short | otherword |
| small | tiny |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(32);
			const plainLines = lines.map(line => stripVTControlCharacters(line));
			const dataLine = plainLines.find(line => line.includes(longestWord));
			expect(dataLine, "Expected data row containing longest word").toBeTruthy();

			const segments = dataLine!.split("|").slice(1, -1);
			const [firstSegment] = segments;
			expect(firstSegment, "Expected first column segment").toBeTruthy();
			const firstColumnWidth = firstSegment.length - 2;

			expect(
				firstColumnWidth >= longestWord.length,
				`Expected first column width >= ${longestWord.length}, got ${firstColumnWidth}`,
			).toBeTruthy();
		});

		it("should render table with alignment", () => {
			const markdown = new Markdown(
				`| Left | Center | Right |
| :--- | :---: | ---: |
| A | B | C |
| Long text | Middle | End |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => stripVTControlCharacters(line));

			// Check headers
			expect(plainLines.some(line => line.includes("Left"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("Center"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("Right"))).toBeTruthy();
			// Check content
			expect(plainLines.some(line => line.includes("Long text"))).toBeTruthy();
		});

		it("should handle tables with varying column widths", () => {
			const markdown = new Markdown(
				`| Short | Very long column header |
| --- | --- |
| A | This is a much longer cell content |
| B | Short |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);

			const plainLines = lines.map(line => stripVTControlCharacters(line));
			expect(plainLines.some(line => line.includes("Very long column header"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("This is a much longer cell content"))).toBeTruthy();
		});

		it("should wrap table cells when table exceeds available width", () => {
			const markdown = new Markdown(
				`| Command | Description | Example |
| --- | --- | --- |
| npm install | Install all dependencies | npm install |
| npm run build | Build the project | npm run build |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			// Render at narrow width that forces wrapping
			const lines = markdown.render(50);
			const plainLines = lines.map(line => stripVTControlCharacters(line).trimEnd());

			// All lines should fit within width
			for (const line of plainLines) {
				expect(line.length <= 50, `Line exceeds width 50: "${line}" (length: ${line.length})`).toBeTruthy();
			}

			// Content should still be present (possibly wrapped across lines)
			const allText = plainLines.join(" ");
			expect(allText.includes("Command"), "Should contain 'Command'").toBeTruthy();
			expect(allText.includes("Description"), "Should contain 'Description'").toBeTruthy();
			expect(allText.includes("npm install"), "Should contain 'npm install'").toBeTruthy();
			expect(allText.includes("Install"), "Should contain 'Install'").toBeTruthy();
		});

		it("should wrap long cell content to multiple lines", () => {
			const markdown = new Markdown(
				`| Header |
| --- |
| This is a very long cell content that should wrap |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			// Render at width that forces the cell to wrap
			const lines = markdown.render(25);
			const plainLines = lines.map(line => stripVTControlCharacters(line).trimEnd());

			// Should have multiple data rows due to wrapping
			const dataRows = plainLines.filter(line => line.startsWith("|") && !line.includes("-"));
			expect(dataRows.length > 2, `Expected wrapped rows, got ${dataRows.length} rows`).toBeTruthy();

			// All content should be preserved (may be split across lines)
			const allText = plainLines.join(" ");
			expect(allText.includes("very long"), "Should preserve 'very long'").toBeTruthy();
			expect(allText.includes("cell content"), "Should preserve 'cell content'").toBeTruthy();
			expect(allText.includes("should wrap"), "Should preserve 'should wrap'").toBeTruthy();
		});

		it("should wrap long unbroken tokens inside table cells (not only at line start)", () => {
			const url = "https://example.com/this/is/a/very/long/url/that/should/wrap";
			const markdown = new Markdown(
				`| Value |
| --- |
| prefix ${url} |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const width = 30;
			const lines = markdown.render(width);
			const plainLines = lines.map(line => stripVTControlCharacters(line).trimEnd());

			for (const line of plainLines) {
				expect(
					line.length <= width,
					`Line exceeds width ${width}: "${line}" (length: ${line.length})`,
				).toBeTruthy();
			}

			// Borders should stay intact (exactly 2 vertical borders for a 1-col table)
			const tableLines = plainLines.filter(line => line.startsWith("|"));
			for (const line of tableLines) {
				const borderCount = line.split("|").length - 1;
				expect(borderCount, `Expected 2 borders, got ${borderCount}: "${line}"`).toBe(2);
			}

			// Strip box drawing characters + whitespace so we can assert the URL is preserved
			// even if it was split across multiple wrapped lines.
			const extracted = plainLines.join("").replace(/[|+\-\s]/g, "");
			expect(extracted.includes("prefix"), "Should preserve 'prefix'").toBeTruthy();
			expect(extracted.includes(url), "Should preserve URL").toBeTruthy();
		});

		it("should wrap styled inline code inside table cells without breaking borders", () => {
			const markdown = new Markdown(
				`| Code |
| --- |
| \`averyveryveryverylongidentifier\` |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const width = 20;
			const lines = markdown.render(width);
			const joinedOutput = lines.join("\n");
			expect(joinedOutput.includes("\x1b[33m"), "Inline code should be styled (yellow)").toBeTruthy();

			const plainLines = lines.map(line => stripVTControlCharacters(line).trimEnd());
			for (const line of plainLines) {
				expect(
					line.length <= width,
					`Line exceeds width ${width}: "${line}" (length: ${line.length})`,
				).toBeTruthy();
			}

			const tableLines = plainLines.filter(line => line.startsWith("|"));
			for (const line of tableLines) {
				const borderCount = line.split("|").length - 1;
				expect(borderCount, `Expected 2 borders, got ${borderCount}: "${line}"`).toBe(2);
			}
		});

		it("does not leak inline-code color into table borders when cells wrap", () => {
			const markdown = new Markdown(
				`| Command | Notes |
| --- | --- |
| \`config.setupgrading(pendingRequests, emptyFlag)\` | plain |
| short | other |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			// Narrow enough to force the long codespan to wrap mid-run.
			const lines = markdown.render(24);
			const joinedOutput = lines.join("\n");
			expect(joinedOutput.includes("\x1b[33m"), "Inline code should be styled (yellow)").toBeTruthy();
			expect(lines.filter(line => line.includes("|")).length).toBeGreaterThan(3);

			// Walk SGR state through every table row: the "|" border glyphs (and
			// everything after them on the line) must never be rendered under an
			// open fg color or bold attribute.
			for (const line of lines) {
				if (!line.includes("|")) continue;
				let bold = false;
				let fgOpen = false;
				let i = 0;
				while (i < line.length) {
					if (line[i] === "\x1b") {
						const seq = line.slice(i).match(/^\x1b\[([0-9;]*)m/);
						expect(seq, `unparseable SGR in: ${JSON.stringify(line)}`).not.toBeNull();
						for (const p of seq![1]!.split(";")) {
							if (p === "1") bold = true;
							else if (p === "22") bold = false;
							else if (p === "0") {
								bold = false;
								fgOpen = false;
							} else if (p === "39") fgOpen = false;
							else if (p === "38" || /^3[0-7]$/.test(p) || /^9[0-7]$/.test(p)) fgOpen = true;
						}
						i += seq![0].length;
						continue;
					}
					if (line[i] === "|") {
						expect(fgOpen, `Border inherits fg color in: ${JSON.stringify(line)}`).toBe(false);
						expect(bold, `Border inherits bold in: ${JSON.stringify(line)}`).toBe(false);
					}
					i++;
				}
			}
		});

		it("should handle extremely narrow width gracefully", () => {
			const markdown = new Markdown(
				`| A | B | C |
| --- | --- | --- |
| 1 | 2 | 3 |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			// Very narrow width
			const lines = markdown.render(15);
			const plainLines = lines.map(line => stripVTControlCharacters(line).trimEnd());

			// Lines should not exceed width
			for (const line of plainLines) {
				expect(line.length <= 15, `Line exceeds width 15: "${line}" (length: ${line.length})`).toBeTruthy();
			}
		});

		it("should render table correctly when it fits naturally", () => {
			const markdown = new Markdown(
				`| A | B |
| --- | --- |
| 1 | 2 |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			// Wide width where table fits naturally
			const lines = markdown.render(80);
			const plainLines = lines.map(line => stripVTControlCharacters(line).trimEnd());

			// Should have proper table structure
			const headerLine = plainLines.find(line => line.includes("A") && line.includes("B"));
			expect(headerLine, "Should have header row").toBeTruthy();
			expect(headerLine?.includes("|"), "Header should have borders").toBeTruthy();

			const separatorLine = plainLines.find(line => line.includes("+") && line.includes("-"));
			expect(separatorLine, "Should have separator row").toBeTruthy();

			const dataLine = plainLines.find(line => line.includes("1") && line.includes("2"));
			expect(dataLine, "Should have data row").toBeTruthy();
		});

		it("should respect paddingX when calculating table width", () => {
			const markdown = new Markdown(
				`| Column One | Column Two |
| --- | --- |
| Data 1 | Data 2 |`,
				2, // paddingX = 2
				0,
				defaultMarkdownTheme,
			);

			// Width 40 with paddingX=2 means contentWidth=36
			const lines = markdown.render(40);
			const plainLines = lines.map(line => stripVTControlCharacters(line).trimEnd());

			// All lines should respect width
			for (const line of plainLines) {
				expect(line.length <= 40, `Line exceeds width 40: "${line}" (length: ${line.length})`).toBeTruthy();
			}

			// Table rows should have left padding
			const tableRow = plainLines.find(line => line.includes("|"));
			expect(tableRow?.startsWith("  "), "Table should have left padding").toBeTruthy();
		});

		it("should not add a trailing blank line when table is the last rendered block", () => {
			const markdown = new Markdown(
				`| Name |
| --- |
| Alice |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => stripVTControlCharacters(line).trimEnd());

			expect(plainLines.at(-1)).not.toBe("");
		});
	});

	describe("Combined features", () => {
		it("should render lists and tables together", () => {
			const markdown = new Markdown(
				`# Test Document

- Item 1
  - Nested item
- Item 2

| Col1 | Col2 |
| --- | --- |
| A | B |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => stripVTControlCharacters(line));

			// Check heading
			expect(plainLines.some(line => line.includes("Test Document"))).toBeTruthy();
			// Check list
			expect(plainLines.some(line => line.includes("- Item 1"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("  - Nested item"))).toBeTruthy();
			// Check table
			expect(plainLines.some(line => line.includes("Col1"))).toBeTruthy();
			expect(plainLines.some(line => line.includes("|"))).toBeTruthy();
		});
	});

	describe("Pre-styled text (thinking traces)", () => {
		it("should preserve gray italic styling after inline code", () => {
			// This replicates how thinking content is rendered in assistant-message.ts
			const markdown = new Markdown(
				"This is thinking with `inline code` and more text after",
				1,
				0,
				defaultMarkdownTheme,
				{
					color: text => chalk.gray(text),
					italic: true,
				},
			);

			const lines = markdown.render(80);
			const joinedOutput = lines.join("\n");

			// Should contain the inline code block
			expect(joinedOutput.includes("inline code")).toBeTruthy();

			// The output should have ANSI codes for gray (90) and italic (3)
			expect(joinedOutput.includes("\x1b[90m"), "Should have gray color code").toBeTruthy();
			expect(joinedOutput.includes("\x1b[3m"), "Should have italic code").toBeTruthy();

			// Verify that inline code is styled (theme uses yellow)
			const hasCodeColor = joinedOutput.includes("\x1b[33m");
			expect(hasCodeColor, "Should style inline code").toBeTruthy();
		});

		it("should preserve gray italic styling after bold text", () => {
			const markdown = new Markdown(
				"This is thinking with **bold text** and more after",
				1,
				0,
				defaultMarkdownTheme,
				{
					color: text => chalk.gray(text),
					italic: true,
				},
			);

			const lines = markdown.render(80);
			const joinedOutput = lines.join("\n");

			// Should contain bold text
			expect(joinedOutput.includes("bold text")).toBeTruthy();

			// The output should have ANSI codes for gray (90) and italic (3)
			expect(joinedOutput.includes("\x1b[90m"), "Should have gray color code").toBeTruthy();
			expect(joinedOutput.includes("\x1b[3m"), "Should have italic code").toBeTruthy();

			// Should have bold codes (1 or 22 for bold on/off)
			expect(joinedOutput.includes("\x1b[1m"), "Should have bold code").toBeTruthy();
		});

		it("should not leak styles into following lines when rendered in TUI", async () => {
			class MarkdownWithInput implements Component {
				markdownLineCount = 0;

				constructor(private readonly markdown: Markdown) {}

				render(width: number): string[] {
					const lines = this.markdown.render(width);
					this.markdownLineCount = lines.length;
					return [...lines, "INPUT"];
				}

				invalidate(): void {
					this.markdown.invalidate();
				}
			}

			const markdown = new Markdown("This is thinking with `inline code`", 1, 0, defaultMarkdownTheme, {
				color: text => chalk.gray(text),
				italic: true,
			});

			const terminal = new VirtualTerminal(80, 6);
			const tui = new TUI(terminal);
			const component = new MarkdownWithInput(markdown);
			tui.addChild(component);
			tui.start();
			// The first render is scheduled on the setImmediate hop; drain it before flushing.
			const firstRender = Promise.withResolvers<void>();
			setImmediate(firstRender.resolve);
			await firstRender.promise;
			await terminal.flush();

			expect(component.markdownLineCount > 0).toBeTruthy();
			const inputRow = component.markdownLineCount;
			expect(getCellItalic(terminal, inputRow, 0)).toBe(false);
			tui.stop();
		});
	});

	describe("Spacing after code blocks", () => {
		it("renders a JavaScript fenced code block and preserves its source", () => {
			const script = `const answer = 42;
console.log(answer);`;
			const markdown = new Markdown(`\`\`\`js\n${script}\n\`\`\``, 0, 0, defaultMarkdownTheme);
			const plainLines = markdown.render(80).map(line => stripVTControlCharacters(line).trimEnd());

			// Fences are framing only: one `[lang]` header, an ASCII-safe numbered
			// gutter, a compact frame, and no raw ``` rows.
			expect(plainLines[0]).toMatch(/^\+- \[js\] /);
			expect(plainLines.some(line => line.includes("| 1 | const answer = 42;"))).toBe(true);
			expect(plainLines.some(line => line.includes("| 2 | console.log(answer);"))).toBe(true);
			expect(plainLines.some(line => line.includes("```"))).toBe(false);
		});

		it("wraps long highlighted rows inside the same codeblock frame", () => {
			const source = [
				"```js",
				'const endpoint = "https://example.test/a-very-long-path-that-must-stay-inside-the-frame";',
				"```",
			].join("\n");
			const plainLines = new Markdown(source, 0, 0, defaultMarkdownTheme)
				.render(50)
				.map(line => stripVTControlCharacters(line).trimEnd());

			expect(plainLines[0]).toMatch(/^\+- \[js\] /);
			expect(plainLines.some(line => line.includes("example.test"))).toBe(true);
			for (const line of plainLines.slice(0, -1)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(50);
			}
			for (const line of plainLines.slice(1, -1)) {
				expect(line.startsWith("| ")).toBe(true);
				expect(line.endsWith("|"), `Unframed code row: ${line}`).toBe(true);
			}
			// ASCII preset keeps the numbered gutter ASCII-only and aligns wrapped
			// continuation rows under the code body.
			expect(plainLines[1]).toContain("1 | ");
			expect(plainLines[2]).not.toMatch(/[├└│]/);
		});

		it("uses the semantic language icon and one readable label", () => {
			const semanticTheme = {
				...defaultMarkdownTheme,
				codeBlockLanguage: (lang: string) => (lang === "rust" ? `\u{e7a8} ${lang}` : ""),
			};
			const markdown = new Markdown("```rust\nfn main() {}\n```", 0, 0, semanticTheme);
			const plainLines = markdown.render(80).map(line => stripVTControlCharacters(line).trimEnd());

			expect(plainLines[0]).toContain("\u{e7a8} rust");
			expect(plainLines[0]).not.toContain("rust rust");
		});

		it("re-applies border color after a colored title glyph so every frame side matches", () => {
			// A colored emoji in the title resets the terminal SGR foreground
			// mid-line. If the header were wrapped in one border() call, the
			// right-side fill and top-right corner would lose the border color
			// and render in default white — the exact mismatch users reported
			// (bright top-right, dim everywhere else). The header must be built
			// from independently colored segments so the frame reads as one shape.
			const emojiTheme = {
				...defaultMarkdownTheme,
				codeBlockBorder: (t: string) => chalk.dim(t),
				codeBlockLanguage: () => "\u{1F7E8} js",
			};
			const header = new Markdown("```js\nconst a = 1;\n```", 0, 0, emojiTheme).render(40)[0];
			// A dim-open sequence must appear AFTER the emoji: this guards the
			// top-right corner against SGR bleed from the glyph.
			const afterEmoji = header.slice(header.indexOf("\u{1F7E8}"));
			expect(afterEmoji).toContain("\x1b[2m");
			// The plain shape stays a single continuous top border.
			const plain = stripVTControlCharacters(header).trimEnd();
			expect(plain).toMatch(/^\+- \[\u{1F7E8} js\] -+\+$/u);
		});

		it("renders the copy chip as an OSC 8 hyperlink when the theme resolves a target", () => {
			const terminalState = TERMINAL as unknown as { hyperlinks: boolean };
			const originalHyperlinks = terminalState.hyperlinks;
			try {
				terminalState.hyperlinks = true;
				// The chip target makes `[copy]` a real click-to-copy link (opened by
				// the terminal via the omp-copy: URL scheme), so copy works with a
				// mouse click without main-screen mouse tracking, so scroll stays native.
				const linkTheme = {
					...defaultMarkdownTheme,
					copyChip: "copy",
					copyChipTarget: (code: string) => `omp-copy:${code.length.toString(16).padStart(16, "0")}`,
				};
				const lines = new Markdown("```js\nconst a = 1;\n```", 0, 0, linkTheme).render(40);
				const footer = lines.at(-1) ?? "";
				// OSC 8 open with the resolved target, the [copy] label, then OSC 8 close.
				expect(footer).toContain("\x1b]8;;omp-copy:");
				expect(footer).toContain("[copy]");
				expect(footer).toContain("\x1b]8;;\x07");
				// Plain footer shape is unchanged: one bottom rule ending in the chip.
				const plain = stripVTControlCharacters(footer).trimEnd();
				expect(plain).toMatch(/^\+-+\[copy\]-\+$/);
			} finally {
				terminalState.hyperlinks = originalHyperlinks;
			}
		});
		it("keeps the copy chip plain when hyperlink support is disabled", () => {
			const terminalState = TERMINAL as unknown as { hyperlinks: boolean };
			const originalHyperlinks = terminalState.hyperlinks;
			let targetCalls = 0;
			try {
				terminalState.hyperlinks = false;
				const copyTheme = {
					...defaultMarkdownTheme,
					copyChip: "copy",
					copyChipTarget: () => {
						targetCalls++;
						return "omp-copy:explicit";
					},
				};
				const footer = new Markdown("```js\nconst x = 1\n```", 0, 0, copyTheme).render(40).at(-1) ?? "";
				expect(targetCalls).toBe(0);
				expect(footer).not.toContain("\x1b]8;;");
				expect(stripVTControlCharacters(footer)).toContain("[copy]");
			} finally {
				terminalState.hyperlinks = originalHyperlinks;
			}
		});
		it("keeps the copy chip a plain label when the theme resolves no target", () => {
			const plainChipTheme = { ...defaultMarkdownTheme, copyChip: "copy" };
			const lines = new Markdown("```js\nconst a = 1;\n```", 0, 0, plainChipTheme).render(40);
			const footer = lines.at(-1) ?? "";
			expect(footer).not.toContain("\x1b]8;;");
			expect(stripVTControlCharacters(footer)).toContain("[copy]");
		});

		it("should have only one blank line between code block and following paragraph", () => {
			const markdown = new Markdown(
				`hello world

\`\`\`js
const hello = "world";
\`\`\`

again, hello world`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => stripVTControlCharacters(line).trimEnd());

			const languageIndex = plainLines.findIndex(line => line.startsWith("+- [js] "));
			expect(languageIndex !== -1, "Should render the code language label").toBeTruthy();
			expect(plainLines[languageIndex + 1]).toContain('1 | const hello = "world";');

			const afterCode = plainLines.slice(languageIndex + 3);
			const emptyLineCount = afterCode.findIndex(line => line !== "");

			expect(
				emptyLineCount,
				`Expected 1 empty line after code block, but found ${emptyLineCount}. Lines after code: ${JSON.stringify(afterCode.slice(0, 5))}`,
			).toBe(1);
		});

		it("should normalize paragraph and code block spacing to one blank line", () => {
			const cases = [
				`hello this is text
\`\`\`
code block
\`\`\`
more text`,
				`hello this is text

\`\`\`
code block
\`\`\`

more text`,
			];
			// The box hugs its content: width = gutter + longest code row, not the
			// full terminal width. defaultMarkdownTheme uses the ASCII preset (+-|),
			// so its gutter contains no Unicode guidance connector.
			const expectedLines = [
				"hello this is text",
				"",
				"+----------------+",
				"| 1 | code block |",
				"+----------------+",
				"",
				"more text",
			];

			for (const text of cases) {
				const markdown = new Markdown(text, 0, 0, defaultMarkdownTheme);
				const lines = markdown.render(80);
				const plainLines = lines.map(line => stripVTControlCharacters(line).trimEnd());

				expect(plainLines).toEqual(expectedLines);
			}
		});

		it("keeps coding-agent's padded fenced code body at column zero", () => {
			const markdown = new Markdown("```sh\ncat <<'EOF'\nEOF\n```", 1, 0, defaultMarkdownTheme, undefined, 0);

			const plainLines = markdown.render(80).map(line => stripVTControlCharacters(line).trimEnd());

			expect(plainLines[0]).toMatch(/^ \+- \[sh\] /);
			expect(plainLines.some(line => line.includes("1 | cat <<'EOF'"))).toBe(true);
			expect(plainLines.some(line => line.includes("2 | EOF"))).toBe(true);
		});

		it("keeps literal code body rows unprefixed through nested container wrapping", () => {
			const longCodeLine = "x".repeat(24);
			const cases = [
				`- shell:

  \`\`\`sh
  ${longCodeLine}
  EOF
  \`\`\``,
				`> \`\`\`sh
> ${longCodeLine}
> EOF
> \`\`\``,
			];

			for (const text of cases) {
				const markdown = new Markdown(text, 1, 0, defaultMarkdownTheme, undefined, 0);
				const plainLines = markdown.render(12).map(line => stripVTControlCharacters(line).trimEnd());
				const contentRows = plainLines;

				expect(plainLines.some(line => line.includes("```"))).toBe(false);
				expect(
					contentRows
						.join("")
						.split("")
						.filter(char => char === "x"),
				).toHaveLength(longCodeLine.length);
				expect(contentRows.join("")).toContain("E");
				expect(contentRows.join("")).toContain("O");
				expect(contentRows.join("")).toContain("F");
				expect(contentRows.length).toBeGreaterThan(2);
			}
		});

		it("aligns every framed row through padding and blockquote layout", () => {
			const plainLines = new Markdown(
				"> ```sh\n> printf test\n> EOF\n> ```",
				1,
				0,
				defaultMarkdownTheme,
				undefined,
				0,
			)
				.render(28)
				.map(line => stripVTControlCharacters(line).trimEnd());
			const frameRows = plainLines.filter(line => /[+|]/.test(line));

			expect(frameRows.length).toBeGreaterThanOrEqual(4);
			expect(
				frameRows.every(line => line.startsWith(" │ ")),
				frameRows.join("\n"),
			).toBe(true);
			expect(frameRows.map(line => line.search(/[+|]/))).toEqual(frameRows.map(() => 3));
		});

		it("preserves every code character across hard-wrapped frame rows", () => {
			const source = "left    right    tail";
			const plainLines = new Markdown(`\`\`\`txt\n${source}\n\`\`\``, 0, 0, defaultMarkdownTheme)
				.render(14)
				.map(line => stripVTControlCharacters(line));
			const body = plainLines
				.slice(1, -1)
				.map(line => {
					const left = line.indexOf("|");
					const right = line.lastIndexOf("|");
					let inner = line.slice(left + 1, right);
					// The frame adds one separator cell immediately before the right rail.
					if (inner.length > 0) inner = inner.slice(0, -1);
					const connector = Math.max(inner.indexOf("├─"), inner.indexOf("└─"));
					if (connector >= 0) inner = inner.slice(connector + 2).replace(/^ /, "");
					else if (/^ \d+ \| /.test(inner)) inner = inner.replace(/^ \d+ \| /, "");
					else if (/^ +\| /.test(inner)) inner = inner.replace(/^ +\| /, "");
					else {
						const rail = inner.indexOf("│");
						if (rail >= 0) inner = inner.slice(rail + 1).replace(/^ {2}/, "");
					}
					return inner;
				})
				.join("")
				.trimEnd();

			expect(body).toBe(source);
		});

		it("keeps narrow list code-frame borders contiguous", () => {
			const plainLines = new Markdown("- item\n\n  ```js\n  const value = 1\n  ```", 0, 0, defaultMarkdownTheme)
				.render(22)
				.map(line => stripVTControlCharacters(line).trimEnd());
			const frameRows = plainLines.filter(line => /[+|]/.test(line));

			expect(frameRows.some(line => /^\s+\+- \[js\] -+\+$/.test(line))).toBe(true);
			expect(frameRows.some(line => /^\s+\+-+\+$/.test(line))).toBe(true);
			expect(frameRows.some(line => /^\s*\|$/.test(line))).toBe(false);
			expect(
				frameRows.every(line => visibleWidth(line) <= 22),
				frameRows.join("\n"),
			).toBe(true);
		});

		it("fits oversized language and copy labels inside the frame width", () => {
			const width = 18;
			const boundedTheme = {
				...defaultMarkdownTheme,
				copyChip: "copy-label-that-is-far-too-long",
			};
			const language = "language".repeat(13);
			const plainLines = new Markdown(`\`\`\`${language}\nx\n\`\`\``, 0, 0, boundedTheme)
				.render(width)
				.map(line => stripVTControlCharacters(line).trimEnd());

			expect(
				plainLines.every(line => visibleWidth(line) <= width),
				plainLines.join("\n"),
			).toBe(true);
			expect(plainLines[0]).toMatch(/^\+-.*\+$/);
			expect(plainLines.at(-1)).toMatch(/^\+.*\+$/);
			expect(plainLines.slice(1, -1).every(line => /^\|.*\|$/.test(line))).toBe(true);
		});
		it("keeps a short language title complete when width allows", () => {
			const lines = new Markdown("```javascript\nx\n```", 0, 0, defaultMarkdownTheme)
				.render(80)
				.map(line => stripVTControlCharacters(line).trimEnd());
			expect(lines[0]).toContain("[javascript]");
		});
		it("keeps every framed row within very narrow widths", () => {
			for (const width of [1, 2, 3, 4]) {
				const lines = new Markdown("```js\nabcdef\n```", 0, 0, defaultMarkdownTheme)
					.render(width)
					.map(line => stripVTControlCharacters(line));
				expect(
					lines.every(line => visibleWidth(line) <= width),
					lines.join("\n"),
				).toBe(true);
			}
		});
		it("keeps code visible at the exact five-column frame width", () => {
			const width = 5;
			const plainLines = new Markdown("```js\nabc\n```", 0, 0, defaultMarkdownTheme)
				.render(width)
				.map(line => stripVTControlCharacters(line));

			expect(
				plainLines.every(line => visibleWidth(line) <= width),
				plainLines.join("\n"),
			).toBe(true);
			expect(plainLines.join("\n")).toContain("abc");
		});
		it("subtracts nested-list indentation before sizing a code frame", () => {
			const width = 24;
			const source = "- outer\n  - inner\n\n    ```js\n    const value = 123456789;\n    ```";
			const plainLines = new Markdown(source, 0, 0, defaultMarkdownTheme)
				.render(width)
				.map(line => stripVTControlCharacters(line).trimEnd());
			const frameRows = plainLines.filter(line => /^\s+\|.*\|$/.test(line));

			expect(frameRows.length).toBeGreaterThan(0);
			expect(frameRows.every(line => line.startsWith("    |"))).toBe(true);
			expect(
				plainLines.every(line => visibleWidth(line) <= width),
				plainLines.join("\n"),
			).toBe(true);
		});
		it("passes the original tabbed code body to copy-chip targets", () => {
			const terminalState = TERMINAL as unknown as { hyperlinks: boolean };
			const originalHyperlinks = terminalState.hyperlinks;
			let targetBody = "";
			try {
				terminalState.hyperlinks = true;
				const copyTheme = {
					...defaultMarkdownTheme,
					copyChip: "copy",
					copyChipTarget: (code: string) => {
						targetBody = code;
						return "omp-copy:raw-body";
					},
				};
				new Markdown("```make\n\tall:\n\t\t@echo hi\n```", 0, 0, copyTheme).render(40);
				expect(targetBody).toBe("\tall:\n\t\t@echo hi");
			} finally {
				terminalState.hyperlinks = originalHyperlinks;
			}
		});
		it("keeps ordinary prose NUL bytes as ordinary padded text", () => {
			const markdown = new Markdown("before\0after", 1, 0, defaultMarkdownTheme);

			const plainLines = markdown.render(80).map(line => stripVTControlCharacters(line).trimEnd());

			expect(plainLines).toEqual([" before\0after"]);
		});

		it("should not add a trailing blank line when code block is the last rendered block", () => {
			const cases = ["```js\nconst hello = 'world';\n```", "hello world\n\n```js\nconst hello = 'world';\n```"];

			for (const text of cases) {
				const markdown = new Markdown(text, 0, 0, defaultMarkdownTheme);
				const lines = markdown.render(80);
				const plainLines = lines.map(line => stripVTControlCharacters(line).trimEnd());

				expect(plainLines.at(-1)).not.toBe("");
			}
		});
	});

	describe("Mermaid fenced blocks", () => {
		const renderMermaidLines = (text: string, resolveMermaidAscii: (source: string) => string | null) => {
			const markdown = new Markdown(text, 0, 0, { ...defaultMarkdownTheme, resolveMermaidAscii });

			return markdown.render(80).map(line => stripVTControlCharacters(line).trimEnd());
		};

		it("renders resolver ASCII only when the mermaid source matches", () => {
			const fencedMermaid = "```mermaid\nflowchart TD\n  Start-->Stop\n```";
			const mermaidSource = "flowchart TD\n  Start-->Stop";
			const seenSources: string[] = [];

			const plainLines = renderMermaidLines(fencedMermaid, source => {
				seenSources.push(source);
				return source === mermaidSource ? "Start\n  |\nStop" : null;
			});

			expect(seenSources).toEqual([mermaidSource]);
			expect(plainLines).toEqual(["Start", "  |", "Stop"]);
			expect(plainLines.some(line => line.includes("```mermaid"))).toBeFalsy();
		});

		it("keeps resolved Mermaid art inside the coding-agent margin", () => {
			const markdown = new Markdown(
				"```mermaid\nflowchart TD\n```",
				1,
				0,
				{ ...defaultMarkdownTheme, resolveMermaidAscii: () => "Start\n  |\nStop" },
				undefined,
				0,
			);

			const plainLines = markdown.render(80).map(line => stripVTControlCharacters(line).trimEnd());

			expect(plainLines).toEqual([" Start", "   |", " Stop"]);
		});

		it("falls back to the original fenced code block when mermaid resolution returns null", () => {
			const invalidMermaid = "```mermaid\nflowchart TD\n  A --\n```";
			const invalidSource = "flowchart TD\n  A --";
			const seenSources: string[] = [];

			const plainLines = renderMermaidLines(invalidMermaid, source => {
				seenSources.push(source);
				return null;
			});

			expect(seenSources).toEqual([invalidSource]);
			expect(plainLines[0]).toMatch(/^\+- \[mermaid\] /);
			expect(plainLines.some(line => line.includes("flowchart TD"))).toBe(true);
			expect(plainLines.some(line => line.includes("A --"))).toBe(true);
		});
	});

	describe("Spacing after dividers", () => {
		it("should have only one blank line between divider and following paragraph", () => {
			const markdown = new Markdown(
				`hello world

---

again, hello world`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => stripVTControlCharacters(line).trimEnd());

			const dividerIndex = plainLines.findIndex(line => /^-+$/.test(line.trim()));
			expect(dividerIndex !== -1, "Should have divider").toBeTruthy();

			const afterDivider = plainLines.slice(dividerIndex + 1);
			const emptyLineCount = afterDivider.findIndex(line => line !== "");

			expect(
				emptyLineCount,
				`Expected 1 empty line after divider, but found ${emptyLineCount}. Lines after divider: ${JSON.stringify(afterDivider.slice(0, 5))}`,
			).toBe(1);
		});

		it("should not add a trailing blank line when divider is the last rendered block", () => {
			const markdown = new Markdown("---", 0, 0, defaultMarkdownTheme);
			const lines = markdown.render(80);
			const plainLines = lines.map(line => stripVTControlCharacters(line).trimEnd());

			expect(plainLines.at(-1)).not.toBe("");
		});
	});

	describe("Custom section dividers", () => {
		it("should render Unicode light line ───────────── as a horizontal rule with ─", () => {
			const unicodeTheme = {
				...defaultMarkdownTheme,
				symbols: {
					...defaultMarkdownTheme.symbols,
					hrChar: "─",
				},
			};
			const markdown = new Markdown("─────────────", 0, 0, unicodeTheme);
			const lines = markdown.render(80);
			const plainLines = lines.map(line => stripVTControlCharacters(line).trimEnd());
			expect(plainLines[0]).toBe("─".repeat(80));
		});

		it("should render double line ============ as a horizontal rule with =", () => {
			const markdown = new Markdown("============", 0, 0, defaultMarkdownTheme);
			const lines = markdown.render(80);
			const plainLines = lines.map(line => stripVTControlCharacters(line).trimEnd());
			expect(plainLines[0]).toBe("=".repeat(80));
		});

		it("should render em dash line ——— as a horizontal rule with —", () => {
			const unicodeTheme = {
				...defaultMarkdownTheme,
				symbols: {
					...defaultMarkdownTheme.symbols,
					hrChar: "─",
				},
			};
			const markdown = new Markdown("———", 0, 0, unicodeTheme);
			const lines = markdown.render(80);
			const plainLines = lines.map(line => stripVTControlCharacters(line).trimEnd());
			expect(plainLines[0]).toBe("—".repeat(80));
		});

		it("should render em dash line ——— as a horizontal rule with - in ASCII theme", () => {
			const asciiTheme = {
				...defaultMarkdownTheme,
				symbols: {
					...defaultMarkdownTheme.symbols,
					hrChar: "-",
				},
			};
			const markdown = new Markdown("———", 0, 0, asciiTheme);
			const lines = markdown.render(80);
			const plainLines = lines.map(line => stripVTControlCharacters(line).trimEnd());
			expect(plainLines[0]).toBe("-".repeat(80));
		});

		it("should preserve Setext H1 headings for Title\\n===", () => {
			const markdown = new Markdown("Title\n===", 0, 0, defaultMarkdownTheme);
			const lines = markdown.render(80);
			const plainLines = lines.map(line => stripVTControlCharacters(line).trimEnd());
			expect(plainLines.some(line => line.includes("Title"))).toBeTruthy();
			expect(plainLines.includes("=".repeat(80))).toBeFalsy();
		});

		it("should preserve Setext H2 headings for Title\\n---", () => {
			const markdown = new Markdown("Title\n---", 0, 0, defaultMarkdownTheme);
			const lines = markdown.render(80);
			const plainLines = lines.map(line => stripVTControlCharacters(line).trimEnd());
			expect(plainLines.some(line => line.includes("Title"))).toBeTruthy();
			expect(plainLines.includes("─".repeat(80))).toBeFalsy();
		});
	});

	describe("Spacing after headings", () => {
		it("should have only one blank line between heading and following paragraph", () => {
			const markdown = new Markdown(
				`# Hello

This is a paragraph`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => stripVTControlCharacters(line).trimEnd());

			const headingIndex = plainLines.findIndex(line => line.includes("Hello"));
			expect(headingIndex !== -1, "Should have heading").toBeTruthy();

			const afterHeading = plainLines.slice(headingIndex + 1);
			const emptyLineCount = afterHeading.findIndex(line => line !== "");

			expect(
				emptyLineCount,
				`Expected 1 empty line after heading, but found ${emptyLineCount}. Lines after heading: ${JSON.stringify(afterHeading.slice(0, 5))}`,
			).toBe(1);
		});

		it("should not add a trailing blank line when heading is the last rendered block", () => {
			const markdown = new Markdown("# Hello", 0, 0, defaultMarkdownTheme);
			const lines = markdown.render(80);
			const plainLines = lines.map(line => stripVTControlCharacters(line).trimEnd());

			expect(plainLines.at(-1)).not.toBe("");
		});
	});

	describe("Spacing after blockquotes", () => {
		it("should have only one blank line between blockquote and following paragraph", () => {
			const markdown = new Markdown(
				`hello world

> This is a quote

again, hello world`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => stripVTControlCharacters(line).trimEnd());

			const quoteIndex = plainLines.findIndex(line => line.includes("This is a quote"));
			expect(quoteIndex !== -1, "Should have blockquote").toBeTruthy();

			const afterQuote = plainLines.slice(quoteIndex + 1);
			const emptyLineCount = afterQuote.findIndex(line => line !== "");

			expect(
				emptyLineCount,
				`Expected 1 empty line after blockquote, but found ${emptyLineCount}. Lines after quote: ${JSON.stringify(afterQuote.slice(0, 5))}`,
			).toBe(1);
		});

		it("should not add a trailing blank line when blockquote is the last rendered block", () => {
			const markdown = new Markdown("> This is a quote", 0, 0, defaultMarkdownTheme);
			const lines = markdown.render(80);
			const plainLines = lines.map(line => stripVTControlCharacters(line).trimEnd());

			expect(plainLines.at(-1)).not.toBe("");
		});
	});

	describe("Blockquotes with multiline content", () => {
		it("should apply consistent styling to all lines in lazy continuation blockquote", () => {
			// Markdown "lazy continuation" - second line without > is still part of the quote
			const markdown = new Markdown(
				`>Foo
bar`,
				0,
				0,
				defaultMarkdownTheme,
				{
					color: text => chalk.magenta(text), // This should NOT be applied to blockquotes
				},
			);

			const lines = markdown.render(80);

			// Both lines should have the quote border
			const plainLines = lines.map(line => stripVTControlCharacters(line));
			const quotedLines = plainLines.filter(line => line.startsWith("│ "));
			expect(quotedLines.length).toBe(2);

			// Both lines should have italic (from theme.quote styling)
			const fooLine = lines.find(line => line.includes("Foo"));
			const barLine = lines.find(line => line.includes("bar"));
			expect(fooLine).toBeTruthy();
			expect(barLine).toBeTruthy();

			// Check that both have italic (\x1b[3m) - blockquotes use theme styling, not default message color
			expect(fooLine?.includes("\x1b[3m")).toBeTruthy();
			expect(barLine?.includes("\x1b[3m")).toBeTruthy();

			// Blockquotes should NOT have the default message color (magenta)
			expect(fooLine?.includes("\x1b[35m")).toBeFalsy();
			expect(barLine?.includes("\x1b[35m")).toBeFalsy();
		});

		it("should apply consistent styling to explicit multiline blockquote", () => {
			const markdown = new Markdown(
				`>Foo
>bar`,
				0,
				0,
				defaultMarkdownTheme,
				{
					color: text => chalk.cyan(text), // This should NOT be applied to blockquotes
				},
			);

			const lines = markdown.render(80);

			// Both lines should have the quote border
			const plainLines = lines.map(line => stripVTControlCharacters(line));
			const quotedLines = plainLines.filter(line => line.startsWith("│ "));
			expect(quotedLines.length).toBe(2);

			// Both lines should have italic (from theme.quote styling)
			const fooLine = lines.find(line => line.includes("Foo"));
			const barLine = lines.find(line => line.includes("bar"));
			expect(fooLine?.includes("\x1b[3m")).toBeTruthy();
			expect(barLine?.includes("\x1b[3m")).toBeTruthy();

			// Blockquotes should NOT have the default message color (cyan)
			expect(fooLine?.includes("\x1b[36m")).toBeFalsy();
			expect(barLine?.includes("\x1b[36m")).toBeFalsy();
		});

		it("should wrap long blockquote lines and add border to each wrapped line", () => {
			const longText = "This is a very long blockquote line that should wrap to multiple lines when rendered";
			const markdown = new Markdown(`> ${longText}`, 0, 0, defaultMarkdownTheme);

			// Render at narrow width to force wrapping
			const lines = markdown.render(30);
			const plainLines = lines.map(line => stripVTControlCharacters(line).trimEnd());

			// Filter to non-empty lines (exclude trailing blank line after blockquote)
			const contentLines = plainLines.filter(line => line.length > 0);

			// Should have multiple lines due to wrapping
			expect(contentLines.length > 1).toBeTruthy();

			// Every content line should start with the quote border
			for (const line of contentLines) {
				expect(line.startsWith("│ ")).toBeTruthy();
			}

			// All content should be preserved
			const allText = contentLines.join(" ");
			expect(allText.includes("very long")).toBeTruthy();
			expect(allText.includes("blockquote")).toBeTruthy();
			expect(allText.includes("multiple")).toBeTruthy();
		});

		it("should properly indent wrapped blockquote lines with styling", () => {
			const markdown = new Markdown(
				"> This is styled text that is long enough to wrap",
				0,
				0,
				defaultMarkdownTheme,
				{
					color: text => chalk.yellow(text), // This should NOT be applied to blockquotes
					italic: true,
				},
			);

			const lines = markdown.render(25);
			const plainLines = lines.map(line => stripVTControlCharacters(line).trimEnd());

			// Filter to non-empty lines
			const contentLines = plainLines.filter(line => line.length > 0);

			// All lines should have the quote border
			for (const line of contentLines) {
				expect(line.startsWith("│ ")).toBeTruthy();
			}

			// Check that italic is applied (from theme.quote)
			const allOutput = lines.join("\n");
			expect(allOutput.includes("\x1b[3m")).toBeTruthy();

			// Blockquotes should NOT have the default message color (yellow)
			expect(allOutput.includes("\x1b[33m")).toBeFalsy();
		});

		it("should render inline formatting inside blockquotes and reapply quote styling after", () => {
			const markdown = new Markdown("> Quote with **bold** and `code`", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => stripVTControlCharacters(line));

			// Should have the quote border
			expect(plainLines.some(line => line.startsWith("│ "))).toBeTruthy();

			// Content should be preserved
			const allPlain = plainLines.join(" ");
			expect(allPlain.includes("Quote with")).toBeTruthy();
			expect(allPlain.includes("bold")).toBeTruthy();
			expect(allPlain.includes("code")).toBeTruthy();

			const allOutput = lines.join("\n");

			// Should have bold styling (\x1b[1m)
			expect(allOutput.includes("\x1b[1m")).toBeTruthy();

			// Should have code styling (yellow = \x1b[33m from defaultMarkdownTheme)
			expect(allOutput.includes("\x1b[33m")).toBeTruthy();

			// Should have italic from quote styling (\x1b[3m)
			expect(allOutput.includes("\x1b[3m")).toBeTruthy();
		});
		it("should render list content inside blockquotes", () => {
			const markdown = new Markdown("> 1. bla bla\n>    - nested bullet", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => stripVTControlCharacters(line).trimEnd());
			const quotedLines = plainLines.filter(line => line.startsWith("│ "));

			expect(quotedLines.some(line => line.includes("1. bla bla"))).toBeTruthy();
			expect(quotedLines.some(line => line.includes("- nested bullet"))).toBeTruthy();
		});

		it("should render table content inside blockquotes", () => {
			const markdown = new Markdown("> | A | B |\n> | --- | --- |\n> | 1 | 2 |", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => stripVTControlCharacters(line).trimEnd());
			const quotedLines = plainLines.filter(line => line.startsWith("│ "));
			const quotedOutput = quotedLines.join("\n");

			expect(quotedOutput.includes("A")).toBeTruthy();
			expect(quotedOutput.includes("B")).toBeTruthy();
			expect(quotedOutput.includes("1")).toBeTruthy();
			expect(quotedOutput.includes("2")).toBeTruthy();
			expect(quotedOutput.includes("+---+")).toBeTruthy();
			expect(quotedOutput.includes("| A")).toBeTruthy();
		});

		it("should render fenced code blocks inside blockquotes without applying default text color", () => {
			const markdown = new Markdown("> ```js\n> console.log(1)\n> ```", 0, 0, defaultMarkdownTheme, {
				color: text => chalk.magenta(text),
			});

			const lines = markdown.render(80);
			const plainLines = lines.map(line => stripVTControlCharacters(line).trimEnd());
			const quotedLines = plainLines.filter(line => line.startsWith("│ "));
			const output = lines.join("\n");
			const plainOutput = quotedLines.join("\n");

			expect(plainOutput.includes("js")).toBeTruthy();
			expect(plainOutput.includes("console.log(1)")).toBeTruthy();
			expect(plainOutput.includes("```")).toBeFalsy();
			expect(output.includes("\x1b[35m")).toBeFalsy();
			expect(output.includes("\x1b[3m")).toBeTruthy();
		});
	});

	const stripTerminalSequences = (line: string): string => stripVTControlCharacters(line);

	describe("Links", () => {
		// CI environments often resolve to the "base" terminal which has hyperlinks
		// disabled; scope the capability override to each test so shared-process
		// suites cannot observe it between cases.
		const terminalState = TERMINAL as unknown as { hyperlinks: boolean };
		const originalHyperlinks = terminalState.hyperlinks;
		beforeEach(() => {
			terminalState.hyperlinks = true;
		});
		afterEach(() => {
			terminalState.hyperlinks = originalHyperlinks;
		});

		function inspectHyperlinks(line: string): { visible: string; targets: Array<string | null> } {
			let activeTarget: string | null = null;
			let visible = "";
			const targets: Array<string | null> = [];

			for (let i = 0; i < line.length; ) {
				if (line.startsWith("\x1b]8;;", i)) {
					const terminator = line.indexOf("\x07", i + 5);
					activeTarget = line.slice(i + 5, terminator) || null;
					i = terminator + 1;
					continue;
				}
				if (line.startsWith("\x1b[", i)) {
					i += 2;
					while (i < line.length && (line.charCodeAt(i) < 0x40 || line.charCodeAt(i) > 0x7e)) i++;
					i++;
					continue;
				}

				visible += line[i];
				targets.push(activeTarget);
				i++;
			}

			return { visible, targets };
		}

		it("should not duplicate URL for autolinked emails", () => {
			const markdown = new Markdown("Contact user@example.com for help", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map(stripTerminalSequences);
			const joinedPlain = plainLines.join(" ");

			// Should contain the email once, not duplicated with mailto:
			expect(joinedPlain.includes("user@example.com"), "Should contain email").toBeTruthy();
			expect(!joinedPlain.includes("mailto:"), "Should not show mailto: prefix for autolinked emails").toBeTruthy();
		});

		it("should not duplicate URL for bare URLs", () => {
			const markdown = new Markdown("Visit https://example.com for more", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map(stripTerminalSequences);
			const joinedPlain = plainLines.join(" ");

			// URL should appear only once
			const urlCount = (joinedPlain.match(/https:\/\/example\.com/g) || []).length;
			expect(urlCount, "URL should appear exactly once").toBe(1);
		});

		it("should emit OSC 8 hyperlink sequences for bare URLs", () => {
			const markdown = new Markdown("Visit https://example.com for more", 0, 0, defaultMarkdownTheme);

			const output = markdown.render(80).join("\n");
			expect(output.includes("\x1b]8;;https://example.com\x07")).toBeTruthy();
			expect(output.includes("\x1b]8;;\x07")).toBeTruthy();
		});

		it("should balance the complete OSC 8 target around every wrapped URL fragment", () => {
			const url = "https://example.com/really/long/path/that/will/wrap/on/narrow/width";
			const markdown = new Markdown(`Visit ${url} for more`, 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(32);
			const linkedLines = lines.filter(line => inspectHyperlinks(line).targets.includes(url));
			expect(linkedLines.length).toBeGreaterThan(1);
			for (const line of linkedLines) {
				expect(line.split(`\x1b]8;;${url}\x07`)).toHaveLength(2);
				expect(line.match(/\x1b\]8;;\x07/g)).toHaveLength(1);
				expect(new Set(inspectHyperlinks(line).targets.filter(target => target !== null))).toEqual(new Set([url]));
			}
		});

		it("should isolate wrapped OSC 8 links from adjacent table cells", () => {
			const issueUrl = "https://github.com/can1357/oh-my-pi/issues/5860";
			const markdown = new Markdown(
				`| Issue | Title |
|---|---|
| [#5860](${issueUrl}) | feat(extensions): expose live service-tier state (/fast) to extensions |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80).map(inspectHyperlinks);
			const issueRow = lines.find(line => line.visible.includes("#5860"));
			expect(issueRow).toBeDefined();
			if (!issueRow) throw new Error("Expected rendered issue row");

			for (const line of lines) {
				for (let i = 0; i < line.visible.length; i++) {
					if (line.visible[i] === "|") expect(line.targets[i]).toBeNull();
				}
			}

			const labelStart = issueRow.visible.indexOf("#5860");
			const separator = issueRow.visible.indexOf("|", labelStart);
			expect(issueRow.targets.slice(labelStart, labelStart + "#5860".length)).toEqual(
				new Array("#5860".length).fill(issueUrl),
			);
			expect(issueRow.targets.slice(labelStart + "#5860".length, separator)).toEqual(
				new Array(separator - labelStart - "#5860".length).fill(null),
			);

			const titleStart = issueRow.visible.indexOf("feat(extensions)");
			expect(issueRow.targets.slice(titleStart, titleStart + "feat(extensions)".length)).toEqual(
				new Array("feat(extensions)".length).fill(null),
			);

			const linkedText = lines
				.flatMap(line => [...line.visible].filter((_, index) => line.targets[index] === issueUrl))
				.join("");
			expect(linkedText).toContain("#5860");
			expect(linkedText).toContain(issueUrl);
			expect(new Set(lines.flatMap(line => line.targets).filter(target => target !== null))).toEqual(
				new Set([issueUrl]),
			);
		});

		it("should balance OSC 8 links across explicit newlines in a table cell", () => {
			const issueUrl = "https://github.com/can1357/oh-my-pi/issues/5860";
			const markdown = new Markdown(
				`| Issue | Title |
|---|---|
| [first<br>second](${issueUrl}) | plain title cell |`,
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(40).map(inspectHyperlinks);
			const firstRow = lines.find(line => line.visible.includes("first"));
			const secondRow = lines.find(line => line.visible.includes("second"));
			expect(firstRow).toBeDefined();
			expect(secondRow).toBeDefined();
			if (!firstRow || !secondRow) throw new Error("Expected both wrapped label rows");

			// No cell border or padding may carry the link on either physical row.
			for (const line of lines) {
				for (let i = 0; i < line.visible.length; i++) {
					if (line.visible[i] === "|") expect(line.targets[i]).toBeNull();
				}
			}

			// Both label fragments split by <br> must still target the full URL.
			for (const [row, label] of [
				[firstRow, "first"],
				[secondRow, "second"],
			] as const) {
				const start = row.visible.indexOf(label);
				expect(row.targets.slice(start, start + label.length)).toEqual(new Array(label.length).fill(issueUrl));
				const separator = row.visible.indexOf("|", start);
				expect(row.targets.slice(start + label.length, separator)).toEqual(
					new Array(separator - start - label.length).fill(null),
				);
			}

			expect(new Set(lines.flatMap(line => line.targets).filter(target => target !== null))).toEqual(
				new Set([issueUrl]),
			);
		});

		it("should show URL for explicit markdown links with different text", () => {
			const markdown = new Markdown("[click here](https://example.com)", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map(stripTerminalSequences);
			const joinedPlain = plainLines.join(" ");

			// Should show both link text and URL
			expect(joinedPlain.includes("click here"), "Should contain link text").toBeTruthy();
			expect(joinedPlain.includes("(https://example.com)"), "Should show URL in parentheses").toBeTruthy();
		});

		it("should show URL for explicit mailto links with different text", () => {
			const markdown = new Markdown("[Email me](mailto:test@example.com)", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map(stripTerminalSequences);
			const joinedPlain = plainLines.join(" ");

			// Should show both link text and mailto URL
			expect(joinedPlain.includes("Email me"), "Should contain link text").toBeTruthy();
			expect(
				joinedPlain.includes("(mailto:test@example.com)"),
				"Should show mailto URL in parentheses",
			).toBeTruthy();
		});

		it("does not autolink www. glued to a path separator (issue #5652)", () => {
			const filePath = "~/meta/www.share/blog/A5-memory-safety-type-system/index.dj";
			const markdown = new Markdown(filePath, 0, 0, defaultMarkdownTheme);

			const output = markdown.render(120).join("\n");
			const plain = stripTerminalSequences(output);

			// The bare path must render verbatim, with no injected `(http…)` URL.
			expect(plain).toContain(filePath);
			expect(plain.includes("http://www.share")).toBe(false);
			// No OSC 8 hyperlink target should be emitted for the path.
			expect(output.includes("\x1b]8;;http://www.share")).toBe(false);
		});

		it("does not autolink a scheme glued to preceding text", () => {
			const text = "path/to/foohttp://bar.com/x";
			const markdown = new Markdown(text, 0, 0, defaultMarkdownTheme);

			const plain = stripTerminalSequences(markdown.render(120).join("\n"));
			expect(plain).toContain(text);
			expect(plain.includes("(http")).toBe(false);
		});

		it("still autolinks www. at a valid left boundary", () => {
			const markdown = new Markdown("see www.example.com here", 0, 0, defaultMarkdownTheme);

			const output = markdown.render(80).join("\n");
			expect(output.includes("\x1b]8;;http://www.example.com\x07")).toBe(true);
		});
	});

	describe("HTML-like tags in text", () => {
		it("should render content with HTML-like tags as text", () => {
			// When the model emits something like <thinking>content</thinking> in regular text,
			// marked might treat it as HTML and hide the content
			const markdown = new Markdown(
				"This is text with <thinking>hidden content</thinking> that should be visible",
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => stripVTControlCharacters(line));
			const joinedPlain = plainLines.join(" ");

			// The content inside the tags should be visible
			expect(
				joinedPlain.includes("hidden content") || joinedPlain.includes("<thinking>"),
				"Should render HTML-like tags or their content as text, not hide them",
			).toBeTruthy();
		});

		it("should render HTML tags in code blocks correctly", () => {
			const markdown = new Markdown("```html\n<div>Some HTML</div>\n```", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => stripVTControlCharacters(line));
			const joinedPlain = plainLines.join("\n");

			// HTML in code blocks should be visible
			expect(
				joinedPlain.includes("<div>") && joinedPlain.includes("</div>"),
				"Should render HTML in code blocks",
			).toBeTruthy();
		});

		it("should hide standalone empty HTML comments between visible text", () => {
			const markdown = new Markdown(
				"Before visible text\n\n<!-- -->\n\nAfter visible text",
				0,
				0,
				defaultMarkdownTheme,
			);

			const plain = markdown
				.render(80)
				.map(line => stripVTControlCharacters(line))
				.join("\n");

			expect(plain).toContain("Before visible text");
			expect(plain).toContain("After visible text");
			expect(plain).not.toContain("<!--");
			expect(plain).not.toContain("-->");
		});

		it("should strip inline span and text HTML tags but keep their contents", () => {
			const markdown = new Markdown("<span></span><text>▃</text>", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => stripVTControlCharacters(line).trim());
			const joinedPlain = plainLines.join("");

			expect(joinedPlain).toBe("▃");
		});

		it("should preserve whitespace surrounding stripped inline HTML tags", () => {
			const markdown = new Markdown("some <span>inner</span> text", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => stripVTControlCharacters(line).trim());
			const joinedPlain = plainLines.join("");

			expect(joinedPlain).toBe("some inner text");
		});

		it("should unescape HTML entities inside and outside HTML tags", () => {
			const markdown = new Markdown(
				"<span>&lt;▃&gt;</span> &amp; &quot;test&quot; &#128512; &#x1F600;",
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(80);
			const plainLines = lines.map(line => stripVTControlCharacters(line).trim());
			const joinedPlain = plainLines.join("");

			expect(joinedPlain).toBe('<▃> & "test" 😀 😀');
		});
	});
});

describe("Inline color swatches", () => {
	const FMT = TERMINAL.trueColor ? "ansi-16m" : "ansi-256";
	// defaultMarkdownTheme supplies no `colorSwatch` symbol, so the renderer uses its ■ default.
	const swatchFor = (hex: string, glyph = "■"): string => `${Bun.color(`#${hex}`, FMT)}${glyph}`;
	// The `#hex` token itself is painted with the color as background and a
	// YIQ-contrast foreground (VS Code's Color.isLighter rule).
	const BLACK_FG = TERMINAL.trueColor ? "\x1b[38;2;0;0;0m" : "\x1b[38;5;16m";
	const WHITE_FG = TERMINAL.trueColor ? "\x1b[38;2;255;255;255m" : "\x1b[38;5;231m";
	const paintedFor = (hex: string, fg: string, text = `#${hex}`): string =>
		`${Bun.color(`#${hex}`, FMT)!.replace("[38;", "[48;")}${fg}${text}\x1b[39m\x1b[49m`;

	it("paints a colored swatch before a bare hex color in prose", () => {
		const out = new Markdown("Accent is #C5FFD6 today.", 0, 0, defaultMarkdownTheme).render(80).join("\n");
		// Swatch (color SGR + chip glyph + fg reset + space) sits immediately before the code.
		expect(out.includes(`${swatchFor("C5FFD6")}\x1b[39m `)).toBeTruthy();
		// The token itself sits on the color: bg + contrast fg (light fill → black text).
		expect(out.includes(paintedFor("C5FFD6", BLACK_FG))).toBeTruthy();
	});
	it("picks a white foreground on dark fills", () => {
		const out = new Markdown("Navy is #000080 here.", 0, 0, defaultMarkdownTheme).render(80).join("\n");
		expect(out.includes(paintedFor("000080", WHITE_FG))).toBeTruthy();
	});

	it("paints a swatch before a backticked hex color", () => {
		const out = new Markdown("Use `#C5FFD6` for the bg.", 0, 0, defaultMarkdownTheme).render(80).join("\n");
		expect(out.includes(swatchFor("C5FFD6"))).toBeTruthy();
		// The code text is painted onto the color instead of the codespan style.
		expect(out.includes(paintedFor("C5FFD6", BLACK_FG))).toBeTruthy();
	});

	it("does not swatch short numeric references that resemble issue numbers", () => {
		const out = new Markdown("Fixed #1011, see #123, dark #000.", 0, 0, defaultMarkdownTheme).render(80).join("");
		expect(out.includes("■")).toBe(false);
	});

	it("swatches a 3-digit shorthand that contains a hex letter", () => {
		const out = new Markdown("White is #fff.", 0, 0, defaultMarkdownTheme).render(80).join("\n");
		expect(out.includes(swatchFor("fff"))).toBeTruthy();
	});

	it("does not swatch hex-prefixed word fragments like #each", () => {
		// "#each" starts with hex digits ("eac") but the trailing "h" makes it a
		// word, not a color; hashtag-style prose must never sprout a swatch.
		const out = new Markdown("Loop with {{#each items}} in templates.", 0, 0, defaultMarkdownTheme)
			.render(80)
			.join("");
		expect(out.includes("■")).toBe(false);
	});

	it("does not swatch 4-digit hashline #TAG snapshot tags", () => {
		// Hashline tags are 4 hex digits with letters (e.g. #6C5E) and would
		// otherwise be read as #RGBA colors. Neither prose nor codespans swatch them.
		const prose = new Markdown("Re-anchor on #6C5E before editing.", 0, 0, defaultMarkdownTheme).render(80).join("");
		expect(prose.includes("■")).toBe(false);
		const code = new Markdown("Tag `#6C5E` stays plain.", 0, 0, defaultMarkdownTheme).render(80).join("");
		expect(code.includes("■")).toBe(false);
	});

	it("does not swatch hash-prefixed UUIDs in prose", () => {
		const uuid = new Markdown(
			"Use feedback ID #6635765d-4a44-4a5e-a536-a8b72b0395b5 for testing.",
			0,
			0,
			defaultMarkdownTheme,
		)
			.render(80)
			.join("");
		expect(uuid.includes("■")).toBe(false);

		const color = new Markdown("Use color #6635765d.", 0, 0, defaultMarkdownTheme).render(80).join("");
		expect(color.includes(swatchFor("6635765d"))).toBeTruthy();
	});

	it("uses the theme's colorSwatch symbol when provided", () => {
		const themed = { ...defaultMarkdownTheme, symbols: { ...defaultMarkdownTheme.symbols, colorSwatch: "▢" } };
		const out = new Markdown("Accent #C5FFD6.", 0, 0, themed).render(80).join("\n");
		expect(out.includes(swatchFor("C5FFD6", "▢"))).toBeTruthy();
		expect(out.includes(swatchFor("C5FFD6", "■"))).toBe(false);
	});

	it("re-applies the surrounding style after the swatch in thinking traces", () => {
		const out = new Markdown("Picked #C5FFD6 for accent.", 1, 0, defaultMarkdownTheme, {
			color: text => chalk.gray(text),
			italic: true,
		})
			.render(80)
			.join("\n");
		expect(out.includes(swatchFor("C5FFD6"))).toBeTruthy();
		// The token is painted with its own contrast fg; gray (\x1b[90m) re-opens
		// for the surrounding prose after the chip's fg/bg resets.
		expect(out.includes(paintedFor("C5FFD6", BLACK_FG))).toBeTruthy();
		expect(out.includes("\x1b[90m for accent")).toBeTruthy();
	});
});

describe("Module-level LRU render cache", () => {
	it("invokes highlightCode only once for two distinct instances with identical (text, width, theme)", () => {
		// Build a theme with a spy on highlightCode. The theme object reference
		// is stable across both instances so objectId() returns the same ID,
		// meaning the L2 cache key is identical for both renders.
		let highlightCallCount = 0;
		const themeWithSpy = {
			...defaultMarkdownTheme,
			highlightCode: (code: string, _lang?: string): string[] => {
				highlightCallCount++;
				return [code]; // trivial passthrough
			},
		};

		const text = "```js\nconst x = 1;\n```";
		const width = 80;

		// First instance: cold cache → highlightCode MUST be called.
		const md1 = new Markdown(text, 0, 0, themeWithSpy);
		const lines1 = md1.render(width);
		expect(highlightCallCount, "First render should call highlightCode exactly once").toBe(1);

		// Second distinct instance with identical inputs: L2 cache hit → highlightCode must NOT be called again.
		const md2 = new Markdown(text, 0, 0, themeWithSpy);
		const lines2 = md2.render(width);
		expect(highlightCallCount, "Second render (different instance, same key) must use L2 cache").toBe(1);

		// Output must be byte-identical — cache is transparent to callers.
		expect(lines2).toEqual(lines1);
	});

	it("returns the same array reference from L1 and L2 cache hits", () => {
		clearRenderCache();
		const text = "Cache identity sentinel";
		const width = 80;
		const markdown = new Markdown(text, 0, 0, defaultMarkdownTheme);

		// L1: same instance, same text, same width → exact same reference.
		// Reference identity is load-bearing: parents memoize their
		// concatenation on it (Container/TUI skip work for stable refs).
		const first = markdown.render(width);
		expect(markdown.render(width)).toBe(first);

		// L2: a distinct instance with identical inputs shares the module-level
		// cache entry — same reference, not just equal content.
		const l2Markdown = new Markdown(text, 0, 0, defaultMarkdownTheme);
		expect(l2Markdown.render(width)).toBe(first);
	});

	it("keeps an open non-diff fence plain during transient renders without a highlight stream", () => {
		clearRenderCache();
		let highlightCallCount = 0;
		const themeWithSpy = {
			...defaultMarkdownTheme,
			highlightCode: (_code: string, _lang?: string): string[] => {
				highlightCallCount++;
				return ["HIGHLIGHTED"];
			},
		};

		const markdown = new Markdown("```ts\nconst streamed = true;\n", 0, 0, themeWithSpy);
		markdown.transientRenderCache = true;
		const plain = stripVTControlCharacters(markdown.render(80).join("\n"));

		expect(highlightCallCount).toBe(0);
		expect(plain).toContain("const streamed = true;");
		expect(plain).not.toContain("HIGHLIGHTED");
	});

	it("highlights a fence whole-block once it closes, even during transient renders", () => {
		// Rows of a closed fence can enter native scrollback before the token
		// freezes; they must carry the same bytes the finalized render emits.
		clearRenderCache();
		let highlightCallCount = 0;
		const themeWithSpy = {
			...defaultMarkdownTheme,
			highlightCode: (_code: string, _lang?: string): string[] => {
				highlightCallCount++;
				return ["HIGHLIGHTED"];
			},
		};

		const markdown = new Markdown("```ts\nconst streamed = true;\n```", 0, 0, themeWithSpy);
		markdown.transientRenderCache = true;
		const transient = stripVTControlCharacters(markdown.render(80).join("\n"));
		expect(highlightCallCount).toBe(1);
		expect(transient).toContain("HIGHLIGHTED");

		markdown.transientRenderCache = false;
		const highlighted = stripVTControlCharacters(markdown.render(80).join("\n"));
		expect(highlighted).toContain("HIGHLIGHTED");
	});

	it("streams completed-line highlighting through the theme's highlight stream", () => {
		clearRenderCache();
		const pushes: string[] = [];
		const themeWithStream = {
			...defaultMarkdownTheme,
			highlightCode: (code: string, _lang?: string): string[] => code.split("\n").map(line => `F<${line}>`),
			createHighlightStream: (lang?: string) => {
				if (lang !== "python") return null;
				return {
					push: (chunk: string): string => {
						pushes.push(chunk);
						return chunk
							.split("\n")
							.map((line, i, arr) => (i === arr.length - 1 ? line : `S<${line}>`))
							.join("\n");
					},
				};
			},
		};

		const markdown = new Markdown("```python\ndef f():\n    x = 1", 0, 0, themeWithStream);
		markdown.transientRenderCache = true;
		const first = stripVTControlCharacters(markdown.render(80).join("\n"));
		// Completed line highlighted through the stream; partial tail stays plain.
		expect(first).toContain("S<def f():>");
		expect(first).toContain("    x = 1");
		expect(first).not.toContain("S<    x = 1");
		expect(pushes).toEqual(["def f():\n"]);

		// Append-only growth pushes only the newly completed lines — parser
		// state carries across renders instead of re-feeding the fence.
		markdown.setText("```python\ndef f():\n    x = 1\n    return x");
		const second = stripVTControlCharacters(markdown.render(80).join("\n"));
		expect(second).toContain("S<def f():>");
		expect(second).toContain("S<    x = 1>");
		expect(second).toContain("    return x");
		expect(pushes).toEqual(["def f():\n", "    x = 1\n"]);

		// Closing the fence switches to the whole-block highlightCode call the
		// finalized render uses.
		markdown.setText("```python\ndef f():\n    x = 1\n    return x\n```");
		const closed = stripVTControlCharacters(markdown.render(80).join("\n"));
		expect(closed).toContain("F<def f():>");
		expect(pushes).toEqual(["def f():\n", "    x = 1\n"]);
	});

	it("keeps an open fence plain when the highlight stream factory rejects the language", () => {
		clearRenderCache();
		const themeWithStream = {
			...defaultMarkdownTheme,
			highlightCode: (code: string, _lang?: string): string[] => [`F<${code}>`],
			createHighlightStream: (_lang?: string) => null,
		};

		const markdown = new Markdown("```someunknownlang\nplain text line\nmore", 0, 0, themeWithStream);
		markdown.transientRenderCache = true;
		const plain = stripVTControlCharacters(markdown.render(80).join("\n"));
		expect(plain).toContain("plain text line");
		expect(plain).not.toContain("S<");
		expect(plain).not.toContain("F<");
	});

	it("keeps an open fence plain when the highlight stream factory throws", () => {
		clearRenderCache();
		const themeWithStream = {
			...defaultMarkdownTheme,
			highlightCode: (code: string, _lang?: string): string[] => [`F<${code}>`],
			createHighlightStream: (_lang?: string) => {
				throw new TypeError("undefined is not a constructor");
			},
		};

		const markdown = new Markdown("```lua\nlocal x = 1\nmore", 0, 0, themeWithStream);
		markdown.transientRenderCache = true;
		const plain = stripVTControlCharacters(markdown.render(80).join("\n"));
		expect(plain).toContain("local x = 1");
		expect(plain).not.toContain("F<");
	});
});

describe("OSC 66 text-sizing headings", () => {
	const OSC66_INTRO = "\x1b]66;";

	afterEach(() => {
		// The capability gate is process-global; never let it leak into other suites.
		setTerminalTextSizing(false);
	});

	it("keeps H1 as plain ANSI when text-sizing is disabled (default)", () => {
		expect(TERMINAL.textSizing).toBe(false);
		const lines = new Markdown("# Hello", 0, 0, defaultMarkdownTheme).render(80);
		expect(lines.some(line => line.includes(OSC66_INTRO))).toBe(false);
		expect(lines.some(line => stripVTControlCharacters(line).includes("Hello"))).toBe(true);
	});

	it("emits a scale-2 OSC 66 span for H1 and reserves its second visual row", () => {
		setTerminalTextSizing(true);
		const lines = new Markdown("# Hello", 0, 0, defaultMarkdownTheme).render(80);

		const oscIndex = lines.findIndex(line => line.includes(OSC66_INTRO));
		expect(oscIndex).toBeGreaterThanOrEqual(0);
		const oscLine = lines[oscIndex]!;
		expect(oscLine).toContain("s=2");
		// The heading text rides inside the OSC 66 payload, so it survives in the
		// raw bytes (stripVTControlCharacters would drop the whole OSC span).
		expect(oscLine.includes("Hello")).toBe(true);
		expect(lines[oscIndex + 1]).toBe("");

		// Native + emit agree: a scale-2 span measures exactly twice the plain
		// heading width regardless of how the span is internally encoded.
		expect(visibleWidth(oscLine)).toBe(2 * visibleWidth("Hello"));
	});

	it("leaves the reserved row after a scale-2 H1 as a cursor-only blank", () => {
		setTerminalTextSizing(true);
		const lines = new Markdown("# Hello\n\nBody", 0, 0, defaultMarkdownTheme).render(80);
		const oscIndex = lines.findIndex(line => line.includes(OSC66_INTRO));
		expect(oscIndex).toBeGreaterThanOrEqual(0);
		expect(lines[oscIndex + 1]).toBe("");
		expect(lines.some(line => stripVTControlCharacters(line).includes("Body"))).toBe(true);
	});

	it("doubles the measured width for wide/emoji H1 glyphs", () => {
		setTerminalTextSizing(true);
		const lines = new Markdown("# 🚀 Hi", 0, 0, defaultMarkdownTheme).render(80);

		const oscLine = lines.find(line => line.includes(OSC66_INTRO));
		expect(oscLine).toBeTruthy();
		expect(visibleWidth(oscLine!)).toBe(2 * visibleWidth("🚀 Hi"));
	});

	it("falls back to ANSI when the doubled H1 width would overflow the render width", () => {
		setTerminalTextSizing(true);
		// "Hello" is 5 cells; 2*5 = 10 > 8 render columns, so the OSC path is skipped.
		const lines = new Markdown("# Hello", 0, 0, defaultMarkdownTheme).render(8);
		expect(lines.some(line => line.includes(OSC66_INTRO))).toBe(false);
		expect(lines.some(line => stripVTControlCharacters(line).includes("Hello"))).toBe(true);
	});

	it("keeps H2 as plain ANSI even when text-sizing is enabled", () => {
		setTerminalTextSizing(true);
		const lines = new Markdown("## Sub", 0, 0, defaultMarkdownTheme).render(80);
		expect(lines.some(line => line.includes(OSC66_INTRO))).toBe(false);
		expect(lines.some(line => stripVTControlCharacters(line).includes("Sub"))).toBe(true);
	});
});

describe("Markdown.render reference stability", () => {
	// History: render() used to return caller-owned copies because the ask tool
	// renderer did `md(question).push(...optionLines)` and grew the shared cache
	// array every frame. The contract is now the opposite — render() hands out
	// the live cached array by reference (parents memoize on reference identity)
	// and callers that decorate results must copy first; ask.ts was fixed to
	// copy. These tests pin the reference-identity contract.
	afterEach(() => clearRenderCache());

	it("returns the identical reference for repeated renders of an unchanged instance", () => {
		const md = new Markdown("Question text", 1, 0, defaultMarkdownTheme);
		const first = md.render(40);
		expect(md.render(40)).toBe(first);
		expect(md.render(40)).toBe(first);
	});

	it("shares one array across instances with identical inputs via the L2 cache", () => {
		const a = new Markdown("Shared markdown body", 1, 0, defaultMarkdownTheme);
		const b = new Markdown("Shared markdown body", 1, 0, defaultMarkdownTheme);
		expect(b.render(40)).toBe(a.render(40));
	});

	it("does not share oversized renders through the L2 cache", () => {
		// Fixture must exceed RENDER_CACHE_MAX_ENTRY_SIZE (256 KiB of rendered
		// lines) so the entry is rejected and each render owns its array.
		const width = 80;
		const paragraph = `cache-budget sentinel ${"x".repeat(120)}`;
		const largeText = Array.from({ length: 1400 }, (_, index) => `Paragraph ${index}: ${paragraph}`).join("\n\n");

		const first = new Markdown(largeText, 0, 0, defaultMarkdownTheme).render(width);
		const second = new Markdown(largeText, 0, 0, defaultMarkdownTheme).render(width);

		expect(second).toEqual(first);
		expect(second).not.toBe(first);
	});

	it("returns a new reference with updated content after setText", () => {
		const md = new Markdown("Before edit", 1, 0, defaultMarkdownTheme);
		const before = md.render(40);
		expect(before.some(line => stripVTControlCharacters(line).includes("Before edit"))).toBe(true);

		md.setText("After edit");
		const after = md.render(40);
		expect(after).not.toBe(before);
		expect(after.some(line => stripVTControlCharacters(line).includes("After edit"))).toBe(true);
		expect(after.some(line => stripVTControlCharacters(line).includes("Before edit"))).toBe(false);

		// Re-render after the change is stable again at the new reference.
		expect(md.render(40)).toBe(after);
	});

	it("skips invalidation when setText receives the same string (streaming re-emit guard)", () => {
		// #4353: streaming re-emits identical text on ticks with no visible delta
		// (throttled provider frames, reconciled tool-execution updates). Without
		// the equality guard, every re-emit would drop `#cachedLines` and force a
		// full lex + wrap — one of the top CPU hotspots during streaming. The
		// guard mirrors `Text.setText`.
		const md = new Markdown("streamed content", 1, 0, defaultMarkdownTheme);
		const before = md.render(40);
		const changed = md.setText("streamed content");
		expect(changed).toBe(false);
		expect(md.render(40)).toBe(before);

		const changedAgain = md.setText("new content");
		expect(changedAgain).toBe(true);
		expect(md.render(40)).not.toBe(before);
	});

	it("returns a different reference per width, each with correctly fitted rows", () => {
		const md = new Markdown("Width sentinel content", 1, 0, defaultMarkdownTheme);
		const narrow = md.render(30);
		const wide = md.render(60);
		expect(wide).not.toBe(narrow);
		expect(narrow.every(line => visibleWidth(line) <= 30)).toBe(true);
		expect(wide.every(line => visibleWidth(line) <= 60)).toBe(true);
	});

	it("formats common HTML tags inside table cells", () => {
		const md = new Markdown(
			"| Gemini result |\n| --- |\n| <ul><li>None. Static checks <br> are green.</li></ul> |",
			0,
			0,
			defaultMarkdownTheme,
		);
		const lines = md.render(80).map(line => stripVTControlCharacters(line).trimEnd());
		const bulletLineIndex = lines.findIndex(line => line.includes("• None. Static checks"));
		const continuationLineIndex = lines.findIndex(line => line.includes("are green."));

		expect(lines.some(line => /<\/?(?:br|ul|li)\b/i.test(line))).toBe(false);
		expect(bulletLineIndex).toBeGreaterThan(-1);
		expect(continuationLineIndex).toBeGreaterThan(bulletLineIndex);
	});

	it("preserves separators between adjacent HTML tags inside table cells", () => {
		const md = new Markdown(
			"| Result |\n| --- |\n| <ul><li>First</li></ul><p>Second&nbsp;result.</p> |",
			0,
			0,
			defaultMarkdownTheme,
		);
		const lines = md.render(80).map(line => stripVTControlCharacters(line).trimEnd());
		const firstLineIndex = lines.findIndex(line => line.includes("• First"));
		const secondLineIndex = lines.findIndex(line => line.includes("Second result."));

		expect(lines.some(line => /<\/?(?:p|ul|li)\b|&nbsp;/i.test(line))).toBe(false);
		expect(firstLineIndex).toBeGreaterThan(-1);
		expect(secondLineIndex).toBeGreaterThan(firstLineIndex);
	});

	it("preserves ordered HTML list numbering", () => {
		const md = new Markdown("<ol><li>First</li><li>Second</li></ol>", 0, 0, defaultMarkdownTheme);
		const lines = md.render(80).map(line => stripVTControlCharacters(line).trimEnd());

		expect(lines).toContain("1. First");
		expect(lines).toContain("2. Second");
		expect(lines.some(line => line.includes("• First") || line.includes("• Second"))).toBe(false);
	});

	it("keeps HTML list markers with paragraph-wrapped list text", () => {
		const unordered = new Markdown("<ul><li><p>First</p></li></ul>", 0, 0, defaultMarkdownTheme)
			.render(80)
			.map(line => stripVTControlCharacters(line).trimEnd());
		const ordered = new Markdown('<ol start="3"><li><p>Third</p></li></ol>', 0, 0, defaultMarkdownTheme)
			.render(80)
			.map(line => stripVTControlCharacters(line).trimEnd());
		const table = new Markdown("| Result |\n| --- |\n| <ul><li><p>First</p></li></ul> |", 0, 0, defaultMarkdownTheme)
			.render(80)
			.map(line => stripVTControlCharacters(line).trimEnd());

		expect(unordered).toContain("• First");
		expect(unordered).not.toContain("•");
		expect(unordered).not.toContain("First");
		expect(ordered).toContain("3. Third");
		expect(ordered).not.toContain("3.");
		expect(ordered).not.toContain("Third");
		expect(table).toContain("| • First |");
		expect(table).not.toContain("| •       |");
	});

	it("fits table columns to split HTML lines", () => {
		const md = new Markdown("| Result |\n| --- |\n| <ul><li>Pass<br>OK</li></ul> |", 0, 0, defaultMarkdownTheme);
		const lines = md.render(80).map(line => stripVTControlCharacters(line).trimEnd());
		const topBorder = lines.find(line => line.startsWith("+"));

		expect(topBorder).toBe("+--------+");
		expect(lines).toContain("| • Pass |");
		expect(lines).toContain("| OK     |");
	});

	it("preserves repeated HTML line breaks as intentional blank spacing", () => {
		const cases = ["First<br><br>Second", "First<br /><br />Second"];

		for (const input of cases) {
			const md = new Markdown(input, 0, 0, defaultMarkdownTheme);
			const lines = md.render(80).map(line => stripVTControlCharacters(line).trimEnd());
			const firstLineIndex = lines.indexOf("First");

			expect(firstLineIndex).toBeGreaterThan(-1);
			expect(lines[firstLineIndex + 1]).toBe("");
			expect(lines[firstLineIndex + 2]).toBe("Second");
		}
	});

	it("preserves repeated HTML line breaks inside table cells", () => {
		const md = new Markdown("| Result |\n| --- |\n| First<br><br>Second |", 0, 0, defaultMarkdownTheme);
		const lines = md.render(80).map(line => stripVTControlCharacters(line).trimEnd());
		const firstLineIndex = lines.findIndex(line => line.includes("| First"));

		expect(firstLineIndex).toBeGreaterThan(-1);
		expect(lines[firstLineIndex + 1]).toContain("|        |");
		expect(lines[firstLineIndex + 2]).toContain("| Second |");
	});

	it("indents nested HTML list items by list stack depth", () => {
		const md = new Markdown(
			'<ul><li>Parent<ul><li>Child</li><li>Second child</li></ul><ol start="3"><li>Ordered child</li></ol></li><li>Sibling</li></ul>',
			0,
			0,
			defaultMarkdownTheme,
		);
		const lines = md.render(80).map(line => stripVTControlCharacters(line).trimEnd());

		expect(lines).toContain("• Parent");
		expect(lines).toContain("  • Child");
		expect(lines).toContain("  • Second child");
		expect(lines).toContain("  3. Ordered child");
		expect(lines).toContain("• Sibling");
		expect(lines).not.toContain("• Child");
		expect(lines).not.toContain("• Second child");
		expect(lines).not.toContain("3. Ordered child");
	});

	it("indents nested HTML list items inside table cells", () => {
		const md = new Markdown(
			"| Result |\n| --- |\n| <ul><li>Parent<ul><li>Child</li></ul></li></ul> |",
			0,
			0,
			defaultMarkdownTheme,
		);
		const lines = md.render(80).map(line => stripVTControlCharacters(line).trimEnd());

		expect(lines.some(line => line.includes("| • Parent"))).toBe(true);
		expect(lines.some(line => line.includes("|   • Child"))).toBe(true);
		expect(lines.some(line => line.includes("| • Child"))).toBe(false);
	});

	it("does not emit ANSI-only lines for empty styled HTML replacements", () => {
		const md = new Markdown("<p></p>Visible", 0, 0, defaultMarkdownTheme, {
			color: text => chalk.gray(text),
			italic: true,
		});
		const lines = md.render(80);

		const blankLines = lines.filter(line => stripVTControlCharacters(line).trimEnd() === "");
		expect(blankLines.length).toBeGreaterThan(0);
		expect(blankLines.every(line => !line.includes("\x1b["))).toBe(true);
		expect(lines.some(line => stripVTControlCharacters(line).trimEnd() === "Visible")).toBe(true);
	});

	it("decodes non-breaking spaces in table text", () => {
		const md = new Markdown("| Result |\n| --- |\n| A&nbsp;B |", 0, 0, defaultMarkdownTheme);
		const lines = md.render(80).map(line => stripVTControlCharacters(line).trimEnd());

		expect(lines.some(line => line.includes("A B"))).toBe(true);
		expect(lines.some(line => line.includes("&nbsp;"))).toBe(false);
	});

	it("separates paragraph HTML tags instead of concatenating text", () => {
		const md = new Markdown("<p>First result.</p><p>Second result.</p>", 0, 0, defaultMarkdownTheme);
		const lines = md.render(80).map(line => stripVTControlCharacters(line).trimEnd());

		expect(lines).toContain("First result.");
		expect(lines).toContain("Second result.");
		expect(lines).not.toContain("First result.Second result.");
	});

	it("drops HTML formatting whitespace between pretty-printed list tags", () => {
		const md = new Markdown("<ul>\n  <li>First</li>\n  <li>Second</li>\n</ul>", 0, 0, defaultMarkdownTheme);
		const lines = md.render(80).map(line => stripVTControlCharacters(line).trimEnd());

		// Source indentation must not leak in front of the bullets, and the
		// formatting newlines between items must not become blank rows.
		expect(lines).toContain("• First");
		expect(lines).toContain("• Second");
		expect(lines.some(line => line.startsWith(" ") && line.includes("•"))).toBe(false);
		expect(lines.filter(line => line === "").length).toBe(0);
	});
});

describe("Inline and block HTML tag rendering", () => {
	const plainLines = (md: string, w = 80): string[] =>
		new Markdown(md, 0, 0, defaultMarkdownTheme).render(w).map(line => stripVTControlCharacters(line).trimEnd());

	it("renders inline <code> identically to a backtick codespan", () => {
		const html = new Markdown("call <code>install()</code> now", 0, 0, defaultMarkdownTheme).render(80);
		const span = new Markdown("call `install()` now", 0, 0, defaultMarkdownTheme).render(80);
		expect(html).toEqual(span);
		expect(html[0]).toContain(defaultMarkdownTheme.code("install()"));
		expect(stripVTControlCharacters(html[0])).not.toContain("<code>");
	});

	it("decodes HTML entities inside inline <code>", () => {
		const text = plainLines("Can <code>Tap::read(&amp;self)</code> be ok?").join("\n");
		expect(text).toContain("Tap::read(&self)");
		expect(text).not.toContain("&amp;");
		expect(text).not.toMatch(/<\/?code>/);
	});

	it("renders a block <hr> tag as a horizontal rule, not literal text", () => {
		const lines = plainLines("before\n\n<hr>\n\nafter", 40);
		expect(
			lines.some(line => line.length >= 10 && line === defaultMarkdownTheme.symbols.hrChar.repeat(line.length)),
		).toBe(true);
		expect(lines.join("\n")).not.toContain("<hr>");
		expect(lines).toContain("before");
		expect(lines).toContain("after");
	});

	it("styles inline <code> inside table cells without leaking tags or breaking the border", () => {
		const lines = plainLines("| Name | Note |\n| --- | --- |\n| <code>foo()</code> | <code>&amp;self</code> |", 60);
		expect(lines.some(line => line.includes("foo()"))).toBe(true);
		expect(lines.some(line => line.includes("&self"))).toBe(true);
		expect(lines.join("\n")).not.toMatch(/<\/?code>/);
		expect(lines.some(line => line.startsWith("+"))).toBe(true);
	});

	it("treats <hr> in a table cell as a line break, never a full-width rule", () => {
		const lines = plainLines("| A | B |\n| --- | --- |\n| x<hr>y | z |", 50);
		expect(lines.some(line => /^-{20,}$/.test(line))).toBe(false);
		expect(lines.join("\n")).not.toContain("<hr>");
		expect(lines.some(line => line.includes("| x"))).toBe(true);
		expect(lines.some(line => line.includes("| y"))).toBe(true);
	});

	it("renders a single-line <blockquote> with the quote border", () => {
		const lines = plainLines("<blockquote>heads up, this is a warning</blockquote>");
		const quoteLine = lines.find(line => line.includes("heads up"));
		expect(quoteLine).toBeDefined();
		expect(quoteLine?.startsWith(defaultMarkdownTheme.symbols.quoteBorder)).toBe(true);
		expect(lines.join("\n")).not.toMatch(/<\/?blockquote>/);
	});

	it("drops a stray unmatched <code> tag and keeps its content", () => {
		const text = plainLines("text <code>dangling content here").join(" ");
		expect(text).toContain("dangling content here");
		expect(text).not.toContain("<code>");
	});

	it("leaves <code>/<hr> verbatim inside fenced code blocks", () => {
		const lines = plainLines("```html\n<code>literal</code>\n<hr>\n```");
		expect(lines.some(line => line.includes("<code>literal</code>"))).toBe(true);
		expect(lines.some(line => line.includes("<hr>"))).toBe(true);
	});

	it("renderInlineMarkdown styles <code> and decodes entities", () => {
		const rendered = renderInlineMarkdown(
			"Use <code>&amp;self</code> not <code>&amp;mut self</code>",
			defaultMarkdownTheme,
		);
		const plain = stripVTControlCharacters(rendered);
		expect(plain).toContain("&self");
		expect(plain).toContain("&mut self");
		expect(plain).not.toContain("&amp;");
		expect(plain).not.toMatch(/<\/?code>/);
		expect(rendered).toContain(defaultMarkdownTheme.code("&self"));
	});
});

describe("Math rendering", () => {
	const plain = (c: Markdown): string =>
		c
			.render(80)
			.map(line => stripVTControlCharacters(line))
			.join("\n");

	it("converts a bare \\begin{cases} block (no $$ delimiters) to Unicode", () => {
		const md = new Markdown(
			"\\operatorname{sgn}(x) =\n\\begin{cases}\n-1 & x < 0 \\\\\n1 & x > 0\n\\end{cases}",
			0,
			0,
			defaultMarkdownTheme,
		);
		const out = plain(md);
		expect(out).toContain("sgn(x)");
		expect(out).toContain("x < 0");
		expect(out).not.toContain("begin{cases}");
	});

	it("converts a $$-delimited matrix block to a parenthesized grid", () => {
		const md = new Markdown("$$\n\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}\n$$", 0, 0, defaultMarkdownTheme);
		const out = plain(md);
		expect(out).toContain("⎛ a");
		expect(out).toContain("d ⎠");
		expect(out).not.toContain("pmatrix");
	});

	it("leaves a bare \\begin{itemize} block verbatim (non-math environment)", () => {
		const md = new Markdown(
			"\\begin{itemize}\n\\item first\n\\item second\n\\end{itemize}",
			0,
			0,
			defaultMarkdownTheme,
		);
		const out = plain(md);
		expect(out).toContain("begin{itemize}");
		expect(out).toContain("item first");
	});

	it("keeps a fenced tex block with \\begin{cases} as code, not math", () => {
		const md = new Markdown(
			"```tex\n\\begin{cases}\na & x > 0 \\\\\nb & x < 0\n\\end{cases}\n```",
			0,
			0,
			defaultMarkdownTheme,
		);
		const out = plain(md);
		expect(out).toContain("begin{cases}");
	});

	it("converts inline $…$ and \\(…\\) spans without breaking surrounding prose", () => {
		const md = new Markdown("Energy $E = mc^2$ and \\(a + b\\) end.", 0, 0, defaultMarkdownTheme);
		const out = plain(md);
		expect(out).toContain("Energy");
		expect(out).toContain("mc²");
		expect(out).toContain("a + b");
		expect(out).toContain("end.");
		expect(out).not.toContain("$");
	});

	it("folds a plain `f(x) =` prefix line into the bare cases block (no blank-line split)", () => {
		const md = new Markdown(
			"f(x) =\n\\begin{cases}\n1 & x > 0 \\\\\n0 & x < 0\n\\end{cases}",
			0,
			0,
			defaultMarkdownTheme,
		);
		const lines = md.render(80).map(line => stripVTControlCharacters(line));
		const fxIdx = lines.findIndex(line => line.includes("f(x)"));
		expect(fxIdx).toBeGreaterThanOrEqual(0);
		expect(lines.join("\n")).not.toContain("begin{cases}");
		// The cases body follows immediately: folding the lhs in avoids a blank-line paragraph split.
		expect(lines[fxIdx + 1]).toContain("x > 0");
	});
});

describe("inline start()/url-gate scanners (perf rewrites)", () => {
	// The hand-rolled scanners replaced regex scans that marked runs on the
	// remaining source at every inline position. They must return exactly what
	// the old regexes returned for every input.
	const OLD_MATH_START = /\$|\\\(|\\\[/;
	const OLD_AUTOLINK_SCAN = /www\.|https?:\/\/|ftp:\/\//i;
	// marked's bundled GFM inline url rule (verbatim, no flags).
	const GFM_URL_REGEX =
		/^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![-_])/;

	const fixtures = [
		"",
		"plain prose with no candidates at all",
		"$x$ math first",
		"prose then $inline$ math",
		"prose then \\(paren\\) math",
		"prose then \\[bracket\\] math",
		"\\( before $ dollar",
		"$ before \\( paren",
		"backslash only \\ then ( apart",
		"ends with backslash \\",
		"ends with dollar $",
		"www.example.com leading",
		"see www.example.com mid-string",
		"see WWW.EXAMPLE.COM upper",
		"mixed WwW.case.com scan",
		"http://example.com leading",
		"prose http://example.com mid",
		"prose HTTPS://EXAMPLE.COM upper",
		"HtTpS://mixed.example",
		"ftp://files.example mid ftp",
		"prose FTP://FILES.EXAMPLE",
		"ftps:// is not ftp:// until here ftp://x",
		"wwww.overlap.example",
		"hhttp://overlap.example",
		"http:/ missing slash then https://real.example",
		"www without dot www. with dot",
		"w h f teaser chars but no scheme",
		"user@example.com email",
		"prose user.name+tag@example.co.uk",
		"trailing at sign only@ ",
		"@leading-at no local part",
		"a".repeat(400), // long identifier run, no @
		`${"a".repeat(400)}@example.com`, // long local part (past gate scan limit)
		"short@x",
		"dots...and+plus_under-score@host.tld",
	];

	it("mathStartIndex matches the old /\\$|\\\\\\(|\\\\\\[/ scan on every fixture", () => {
		for (const src of fixtures) {
			const m = OLD_MATH_START.exec(src);
			expect(mathStartIndex(src)).toBe(m ? m.index : undefined);
		}
	});

	it("autolinkSchemeScanIndex matches the old /www\\.|https?:\\/\\/|ftp:\\/\\//i scan on every fixture", () => {
		for (const src of fixtures) {
			const m = OLD_AUTOLINK_SCAN.exec(src);
			expect(autolinkSchemeScanIndex(src)).toBe(m ? m.index : undefined);
		}
	});

	it("urlTokenPossible is conservative: never false when the GFM url regex matches", () => {
		for (const src of fixtures) {
			if (GFM_URL_REGEX.test(src)) {
				expect(urlTokenPossible(src)).toBeTrue();
			}
		}
		// And it actually gates: plain prose with no scheme/email head is rejected.
		expect(urlTokenPossible("plain prose, nothing linkable here")).toBeFalse();
		expect(urlTokenPossible("@leading-at no local part")).toBeFalse();
	});

	it("gated tokenizer still autolinks urls and emails end-to-end", () => {
		const rendered = renderInlineMarkdown("see https://example.com and mail user@example.com now", {
			...defaultMarkdownTheme,
			link: (text: string) => `<L>${text}</L>`,
		});
		const plain = stripVTControlCharacters(rendered);
		expect(plain).toContain("<L>https://example.com</L>");
		expect(plain).toContain("<L>user@example.com</L>");
	});
});

describe("windowed lexing (documents past WINDOWED_LEX_MIN_BYTES)", () => {
	// Large documents are lexed in bounded windows because Bun's regex engine
	// rescans the whole remaining source for marked's `^`-anchored block rules.
	// Every construct below straddles window cuts; a bad cut is visible in the
	// rendered output.
	afterEach(() => clearRenderCache());

	const filler = (label: string, lines: number) =>
		Array.from({ length: lines }, (_, i) => `${label} paragraph ${i} with enough prose to fill a window.`).join(
			"\n\n",
		);

	const plain = (text: string, width = 100) =>
		new Markdown(text, 0, 0, defaultMarkdownTheme)
			.render(width)
			.map(line => stripVTControlCharacters(line).trimEnd());

	it("resolves a reference definition that lands in a later window", () => {
		const doc = `Follow [the label][ref] first.\n\n${filler("body", 400)}\n\n[ref]: https://example.com/late\n`;
		expect(doc.length).toBeGreaterThan(16 * 1024);

		const rendered = plain(doc, 120);
		// The reflink resolved: marked emitted a link token (rendered as
		// `label (href)`), so the raw `[label][ref]` syntax is gone and the
		// definition line itself produced no output block of its own.
		expect(rendered[0]).toBe("Follow the label (https://example.com/late) first.");
		expect(rendered.filter(line => line.includes("https://example.com/late"))).toHaveLength(1);
	});

	it("keeps a fenced block longer than one window intact", () => {
		const code = Array.from({ length: 200 }, (_, i) => `const value${i} = ${i};`).join("\n");
		const doc = `${filler("intro", 300)}\n\n\`\`\`ts\n${code}\n\`\`\`\n\n${filler("outro", 20)}`;
		expect(code.length).toBeGreaterThan(2 * 1024);

		const rendered = plain(doc);
		// Exactly one language label: a window cut inside the block would split
		// the code token (or spill code lines into prose).
		expect(rendered.filter(line => line.startsWith("+- [ts] ")).length).toBe(1);
		const first = rendered.findIndex(line => line.includes("const value0 = 0;"));
		expect(first).toBeGreaterThan(-1);
		for (let i = 0; i < 200; i++) {
			expect(rendered[first + i]).toContain(`const value${i} = ${i};`);
		}
	});

	it("numbers an ordered list continuously across window cuts", () => {
		const items = Array.from({ length: 400 }, (_, i) => `${i + 1}. item ${i} padded with extra words to add bytes`);
		const doc = `${filler("intro", 60)}\n\n${items.join("\n")}\n`;
		expect(doc.length).toBeGreaterThan(16 * 1024);

		const rendered = plain(doc, 120);
		for (const n of [1, 137, 400]) {
			expect(rendered.some(line => line.includes(`${n}. item ${n - 1} `))).toBe(true);
		}
		// A window cut that restarted the list would renumber later items.
		expect(rendered.filter(line => line.includes(" 1. item 0 ")).length).toBeLessThanOrEqual(1);
	});
});

describe("framed code review regressions", () => {
	it("keeps every wide grapheme visible in a narrow frame", () => {
		const rendered = new Markdown("```js\n日本語\n```", 0, 0, defaultMarkdownTheme).render(8);
		const plainLines = rendered.map(line => stripVTControlCharacters(line));
		// The frame cannot hold all six cells at once at this width, but no
		// grapheme may be truncated out of existence.
		for (const glyph of ["日", "本", "語"]) {
			expect(plainLines.some(line => line.includes(glyph))).toBe(true);
		}
	});

	it("keeps delimiters on an unclosed fence inside a list", () => {
		const rendered = new Markdown("- item\n\n  ```js\n  const value = 1", 0, 0, defaultMarkdownTheme).render(60);
		const plainLines = rendered.map(line => stripVTControlCharacters(line).trimEnd());
		expect(plainLines.some(line => line.includes("```js"))).toBe(true);
		expect(plainLines.some(line => line.includes("const value = 1"))).toBe(true);
	});

	it("passes the raw nested-list code body to the copy target", () => {
		const terminalState = TERMINAL as unknown as { hyperlinks: boolean };
		const originalHyperlinks = terminalState.hyperlinks;
		let captured: string | undefined;
		try {
			// The copy target is only consulted when OSC 8 links are supported;
			// force that capability so this source-recovery assertion is portable
			// across headless/native CI workers.
			terminalState.hyperlinks = true;
			const theme = { ...defaultMarkdownTheme, copyChip: "copy" };
			Object.defineProperty(theme, "copyChipTarget", {
				value: (body: string) => {
					captured = body;
				},
				configurable: true,
			});
			new Markdown("- item\n\n  ```make\n  \tall\n  ```", 0, 0, theme as typeof defaultMarkdownTheme).render(60);
			expect(captured).toContain("\t");
		} finally {
			terminalState.hyperlinks = originalHyperlinks;
		}
	});
});

describe("framed code review follow-ups", () => {
	it("keeps every framed row within the requested width for wide graphemes", () => {
		for (const width of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
			const rendered = new Markdown("```js\n日本語\n```", 0, 0, defaultMarkdownTheme).render(width);
			expect(rendered.every(line => visibleWidth(line) <= width)).toBe(true);
			const plain = rendered.map(line => stripVTControlCharacters(line));
			if (width >= 2) {
				for (const glyph of ["日", "本", "語"]) expect(plain.some(line => line.includes(glyph))).toBe(true);
			}
		}
	});

	it("does not copy a trailing fence or reuse a tab-expanded cache entry", () => {
		const terminalState = TERMINAL as unknown as { hyperlinks: boolean };
		const originalHyperlinks = terminalState.hyperlinks;
		const captured: string[] = [];
		try {
			terminalState.hyperlinks = true;
			const theme = {
				...defaultMarkdownTheme,
				copyChip: "copy",
				copyChipTarget: (body: string) => {
					captured.push(body);
					return undefined;
				},
			};
			clearRenderCache();
			new Markdown("```make\n\tall\n```", 0, 0, theme).render(80);
			new Markdown("```make\n   all\n```", 0, 0, theme).render(80);
			new Markdown("```js\nconst value = 1;\n```\n\nnext", 0, 0, theme).render(80);
			expect(captured).toEqual(["\tall", "   all", "const value = 1;"]);
		} finally {
			terminalState.hyperlinks = originalHyperlinks;
		}
	});

	it("recovers nested copy payloads when raw ends with a newline", () => {
		const terminalState = TERMINAL as unknown as { hyperlinks: boolean };
		const originalHyperlinks = terminalState.hyperlinks;
		let captured: string | undefined;
		try {
			terminalState.hyperlinks = true;
			const theme = {
				...defaultMarkdownTheme,
				copyChip: "copy",
				copyChipTarget: (body: string) => {
					captured = body;
					return undefined;
				},
			};
			new Markdown("- item\n\n  ```make\n  \tall\n  ```\n- next", 0, 0, theme).render(80);
			expect(captured).toBe("\tall");
			expect(captured).not.toContain("```");
		} finally {
			terminalState.hyperlinks = originalHyperlinks;
		}
	});
	it("preserves marker-shaped code after reduced ordered-list indentation", () => {
		const terminalState = TERMINAL as unknown as { hyperlinks: boolean };
		const originalHyperlinks = terminalState.hyperlinks;
		let captured: string | undefined;
		try {
			terminalState.hyperlinks = true;
			const theme = {
				...defaultMarkdownTheme,
				copyChip: "copy",
				copyChipTarget: (body: string) => {
					captured = body;
					return undefined;
				},
			};
			new Markdown("1. ```js\n  1. x\n   ```", 0, 0, theme).render(80);
			expect(captured).toBe("1. x");
		} finally {
			terminalState.hyperlinks = originalHyperlinks;
		}
	});

	it("matches parsed code before stripping a shorter closing-fence prefix", () => {
		const terminalState = TERMINAL as unknown as { hyperlinks: boolean };
		const originalHyperlinks = terminalState.hyperlinks;
		let captured: string | undefined;
		try {
			terminalState.hyperlinks = true;
			const theme = {
				...defaultMarkdownTheme,
				copyChip: "copy",
				copyChipTarget: (body: string) => {
					captured = body;
					return undefined;
				},
			};
			new Markdown("- ```js\n  abc\n ```", 0, 0, theme).render(80);
			expect(captured).toBe("abc");
		} finally {
			terminalState.hyperlinks = originalHyperlinks;
		}
	});

	it("keeps nested list frames on the containing width budget", () => {
		const source = "- outer\n  - inner\n    ```js\n    const value = 1;\n    ```";
		const rendered = new Markdown(source, 0, 0, defaultMarkdownTheme).render(24);
		expect(rendered.every(line => visibleWidth(line) <= 24)).toBe(true);
		expect(rendered.some(line => stripVTControlCharacters(line).includes("+- [js]"))).toBe(true);
	});

	it("resolves duplicate post-tab-expansion fences to their own bodies", () => {
		const captured: string[] = [];
		const theme = { ...defaultMarkdownTheme, copyChip: "copy" };
		Object.defineProperty(theme, "copyChipTarget", {
			value: (body: string) => {
				captured.push(body);
			},
			configurable: true,
		});
		const originalHyperlinks = TERMINAL.hyperlinks;
		try {
			TERMINAL.hyperlinks = true;
			new Markdown("```make\n\tall\n```\n\n```sh\n   all\n```", 0, 0, theme as typeof defaultMarkdownTheme).render(
				60,
			);
			expect(captured.some(body => body.includes("\t"))).toBe(true);
			expect(captured).toEqual(["\tall", "   all"]);
		} finally {
			TERMINAL.hyperlinks = originalHyperlinks;
		}
	});

	it("advances copy search past a reused streaming prefix", () => {
		const terminalState = TERMINAL as unknown as { hyperlinks: boolean };
		const originalHyperlinks = terminalState.hyperlinks;
		const captured: string[] = [];
		try {
			terminalState.hyperlinks = true;
			const theme = {
				...defaultMarkdownTheme,
				copyChip: "copy",
				copyChipTarget: (body: string) => {
					captured.push(body);
					return undefined;
				},
			};
			const stable = "```make\n\tall\n```\n\nprose";
			const markdown = new Markdown(stable, 0, 0, theme);
			markdown.transientRenderCache = true;
			markdown.render(60);
			captured.length = 0;
			markdown.setText(`${stable}\n\n\`\`\`sh\n   all\n\`\`\``);
			markdown.render(60);
			expect(captured).toEqual(["   all"]);
		} finally {
			terminalState.hyperlinks = originalHyperlinks;
		}
	});

	it("recovers copy payloads from tokens newly added to a cached stable prefix", () => {
		const terminalState = TERMINAL as unknown as { hyperlinks: boolean };
		const originalHyperlinks = terminalState.hyperlinks;
		const captured: string[] = [];
		try {
			terminalState.hyperlinks = true;
			const theme = {
				...defaultMarkdownTheme,
				copyChip: "copy",
				copyChipTarget: (body: string) => {
					captured.push(body);
					return undefined;
				},
			};
			const markdown = new Markdown("prose\n\n", 0, 0, theme);
			markdown.transientRenderCache = true;
			markdown.render(60);
			captured.length = 0;
			markdown.setText("prose\n\n```make\n\tall\n```\n\n");
			markdown.render(60);
			expect(captured).toEqual(["\tall"]);
		} finally {
			terminalState.hyperlinks = originalHyperlinks;
		}
	});

	it("advances copy lookup across spliced tail fences", () => {
		const terminalState = TERMINAL as unknown as { hyperlinks: boolean };
		const originalHyperlinks = terminalState.hyperlinks;
		const captured: string[] = [];
		try {
			terminalState.hyperlinks = true;
			const theme = {
				...defaultMarkdownTheme,
				copyChip: "copy",
				copyChipTarget: (body: string) => {
					captured.push(body);
					return undefined;
				},
			};
			const firstFrame = "```make\n\tall\n```\n\n```make\n    all";
			const markdown = new Markdown(firstFrame, 0, 0, theme);
			markdown.transientRenderCache = true;
			markdown.render(60);
			captured.length = 0;
			markdown.setText(`${firstFrame}\n\`\`\``);
			markdown.render(60);
			expect(captured.at(-1)).toBe("    all");
		} finally {
			terminalState.hyperlinks = originalHyperlinks;
		}
	});

	it("keeps an open fence's list marker attached before closure", () => {
		const rows = new Markdown("- ```make\n  \tall", 0, 0, defaultMarkdownTheme)
			.render(40)
			.map(line => stripVTControlCharacters(line));
		expect(rows.some(line => line.startsWith("- ```make"))).toBe(true);
		expect(rows.some(line => line.includes("all"))).toBe(true);
	});

	it("clamps compact grapheme rows to the requested width", () => {
		for (const width of [1, 3]) {
			const rendered = new Markdown("```js\n\u65e5\u672c\u8a9e\n```", 0, 0, defaultMarkdownTheme).render(width);
			for (const line of rendered) {
				expect(Bun.stringWidth(stripVTControlCharacters(line))).toBeLessThanOrEqual(Math.max(1, width));
			}
		}
	});
	it("anchors copy lookup after preceding fence-like prose", () => {
		const terminalState = TERMINAL as unknown as { hyperlinks: boolean };
		const originalHyperlinks = terminalState.hyperlinks;
		const captured: string[] = [];
		try {
			terminalState.hyperlinks = true;
			const theme = {
				...defaultMarkdownTheme,
				copyChip: "copy",
				copyChipTarget: (body: string) => {
					captured.push(body);
					return undefined;
				},
			};
			const source = "<!--\n```make\n\twrong\n```\n-->\n\n```make\n   right\n```";
			new Markdown(source, 0, 0, theme).render(80);
			expect(captured).toEqual(["   right"]);
		} finally {
			terminalState.hyperlinks = originalHyperlinks;
		}
	});
	it("does not synthesize a fence around four-space-indented literal backticks", () => {
		const rows = new Markdown("    ```\n    literal", 0, 0, defaultMarkdownTheme)
			.render(40)
			.map(line => stripVTControlCharacters(line).trimEnd());
		expect(rows.filter(line => line.includes("```"))).toHaveLength(1);
		expect(rows.some(line => line.includes("literal"))).toBe(true);
		expect(rows.some(line => /^\+-/.test(line))).toBe(false);
	});

	it("matches the actual closing fence line when code contains delimiter text", () => {
		const terminalState = TERMINAL as unknown as { hyperlinks: boolean };
		const originalHyperlinks = terminalState.hyperlinks;
		let captured: string | undefined;
		try {
			terminalState.hyperlinks = true;
			const theme = {
				...defaultMarkdownTheme,
				copyChip: "copy",
				copyChipTarget: (body: string) => {
					captured = body;
					return undefined;
				},
			};
			const source = '- ```js\n  \tconsole.log("```")\n  \tvalue\n  ```';
			new Markdown(source, 0, 0, theme).render(80);
			expect(captured).toBe('\tconsole.log("```")\n\tvalue');
		} finally {
			terminalState.hyperlinks = originalHyperlinks;
		}
	});

	it("does not mistake delimiter text after code for a nested closing fence", () => {
		const terminalState = TERMINAL as unknown as { hyperlinks: boolean };
		const originalHyperlinks = terminalState.hyperlinks;
		let captured: string | undefined;
		try {
			terminalState.hyperlinks = true;
			const theme = {
				...defaultMarkdownTheme,
				copyChip: "copy",
				copyChipTarget: (body: string) => {
					captured = body;
					return undefined;
				},
			};
			new Markdown("- ```js\n y\n x```\n  ```", 0, 0, theme).render(40);
			expect(captured).toBe("y\nx```");
		} finally {
			terminalState.hyperlinks = originalHyperlinks;
		}
	});

	it("strips each available list indent from copied code rows", () => {
		const terminalState = TERMINAL as unknown as { hyperlinks: boolean };
		const originalHyperlinks = terminalState.hyperlinks;
		let captured: string | undefined;
		try {
			terminalState.hyperlinks = true;
			const theme = {
				...defaultMarkdownTheme,
				copyChip: "copy",
				copyChipTarget: (body: string) => {
					captured = body;
					return undefined;
				},
			};
			new Markdown("- ```js\n x\n  ````", 0, 0, theme).render(40);
			expect(captured).toBe("x");
		} finally {
			terminalState.hyperlinks = originalHyperlinks;
		}
	});

	it("preserves raw OSC terminators in copied fenced source", () => {
		const terminalState = TERMINAL as unknown as { hyperlinks: boolean };
		const originalHyperlinks = terminalState.hyperlinks;
		const st = "\x1b\\";
		const captured: string[] = [];
		try {
			terminalState.hyperlinks = true;
			const theme = {
				...defaultMarkdownTheme,
				copyChip: "copy",
				copyChipTarget: (body: string) => {
					captured.push(body);
					return undefined;
				},
			};
			new Markdown(`\`\`\`sh\nprintf '${st}'\n\`\`\``, 0, 0, theme).render(80);
			new Markdown(`\`\`\`sh\nprintf '\x07'\n\`\`\``, 0, 0, theme).render(80);
			expect(captured).toEqual([`printf '${st}'`, "printf '\x07'"]);
		} finally {
			terminalState.hyperlinks = originalHyperlinks;
		}
	});

	it("advances copy recovery past leaves whose OSC terminators normalize", () => {
		const terminalState = TERMINAL as unknown as { hyperlinks: boolean };
		const originalHyperlinks = terminalState.hyperlinks;
		let captured: string | undefined;
		try {
			terminalState.hyperlinks = true;
			const theme = {
				...defaultMarkdownTheme,
				copyChip: "copy",
				copyChipTarget: (body: string) => {
					captured = body;
					return undefined;
				},
			};
			const st = "\x1b\\";
			const source = `<!-- \x1b]8;;https://example.com${st}\n\`\`\`js\nwrong\n\`\`\`\n-->\n- \`\`\`js\n  right\n  \`\`\``;
			new Markdown(source, 0, 0, theme).render(80);
			expect(captured).toBe("right");
		} finally {
			terminalState.hyperlinks = originalHyperlinks;
		}
	});

	it("advances copy recovery past Mermaid code without a copy target", () => {
		const terminalState = TERMINAL as unknown as { hyperlinks: boolean };
		const originalHyperlinks = terminalState.hyperlinks;
		let captured: string | undefined;
		try {
			terminalState.hyperlinks = true;
			const theme = {
				...defaultMarkdownTheme,
				copyChip: "copy",
				copyChipTarget: (body: string) => {
					captured = body;
					return undefined;
				},
				resolveMermaidAscii: (source: string) => (source.includes("wrong") ? "diagram" : null),
			};
			const source = "```mermaid\nwrong\n```\n\n- ```mermaid\n  right\n  ```";
			new Markdown(source, 0, 0, theme).render(80);
			expect(captured).toBe("right");
		} finally {
			terminalState.hyperlinks = originalHyperlinks;
		}
	});

	it("anchors nested opening-fence recovery to a real fence line", () => {
		const terminalState = TERMINAL as unknown as { hyperlinks: boolean };
		const originalHyperlinks = terminalState.hyperlinks;
		let captured: string | undefined;
		try {
			terminalState.hyperlinks = true;
			const theme = {
				...defaultMarkdownTheme,
				copyChip: "copy",
				copyChipTarget: (body: string) => {
					captured = body;
					return undefined;
				},
			};
			const source = "> mention ```js here\n> continued\n>\n> ```js\n> const answer = 42\n> ```";
			new Markdown(source, 0, 0, theme).render(80);
			expect(captured).toBe("const answer = 42");
		} finally {
			terminalState.hyperlinks = originalHyperlinks;
		}
	});
	it("rejects indented-code rows while locating nested opening fences", () => {
		const terminalState = TERMINAL as unknown as { hyperlinks: boolean };
		const originalHyperlinks = terminalState.hyperlinks;
		let captured: string | undefined;
		try {
			terminalState.hyperlinks = true;
			const theme = {
				...defaultMarkdownTheme,
				copyChip: "copy",
				copyChipTarget: (body: string) => {
					captured = body;
					return undefined;
				},
			};
			const source = "    ```js\n    wrong\n    ```\n\n- ```js\n  right\n  ```";
			new Markdown(source, 0, 0, theme).render(80);
			expect(captured).toBe("right");
		} finally {
			terminalState.hyperlinks = originalHyperlinks;
		}
	});
	it("preserves list code when the marker fills the row", () => {
		const rows = new Markdown("- ```js\n  x\n  ```", 0, 0, defaultMarkdownTheme)
			.render(2)
			.map(line => stripVTControlCharacters(line));
		expect(rows.some(line => line.includes("x"))).toBe(true);
	});
	it("strips reduced indentation inside compound containers", () => {
		const terminalState = TERMINAL as unknown as { hyperlinks: boolean };
		const originalHyperlinks = terminalState.hyperlinks;
		let captured: string | undefined;
		try {
			terminalState.hyperlinks = true;
			const theme = {
				...defaultMarkdownTheme,
				copyChip: "copy",
				copyChipTarget: (body: string) => {
					captured = body;
					return undefined;
				},
			};
			new Markdown("> - ```js\n>  x\n>   ```", 0, 0, theme).render(40);
			expect(captured).toBe("x");
		} finally {
			terminalState.hyperlinks = originalHyperlinks;
		}
	});
});
