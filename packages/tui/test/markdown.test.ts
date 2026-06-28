import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { clearRenderCache, Markdown, renderInlineMarkdown } from "@pk-nerdsaver-ai/pi-tui/components/markdown";
import { setTerminalTextSizing, TERMINAL } from "@pk-nerdsaver-ai/pi-tui/terminal-capabilities";
import { type Component, TUI } from "@pk-nerdsaver-ai/pi-tui/tui";
import { visibleWidth } from "@pk-nerdsaver-ai/pi-tui/utils";
import { Chalk } from "chalk";
import { defaultMarkdownTheme } from "./test-themes.js";
import { VirtualTerminal } from "./virtual-terminal.js";

// Force full color in CI so ANSI assertions are deterministic
const chalk = new Chalk({ level: 3 });

function getCellItalic(terminal: VirtualTerminal, row: number, col: number): boolean {
	return terminal.getCellItalic(row, col);
}

describe("renderInlineMarkdown", () => {
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

			// Check that we have content
			expect(lines.length > 0).toBeTruthy();

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

			// Should render without errors
			expect(lines.length > 0).toBeTruthy();

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
			expect(tableLines.length > 0, "Expected table rows to render").toBeTruthy();
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

			// Should not crash and should produce output
			expect(lines.length > 0, "Should produce output").toBeTruthy();

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

			const closingBackticksIndex = plainLines.indexOf("```");
			expect(closingBackticksIndex !== -1, "Should have closing backticks").toBeTruthy();

			const afterBackticks = plainLines.slice(closingBackticksIndex + 1);
			const emptyLineCount = afterBackticks.findIndex(line => line !== "");

			expect(
				emptyLineCount,
				`Expected 1 empty line after code block, but found ${emptyLineCount}. Lines after backticks: ${JSON.stringify(afterBackticks.slice(0, 5))}`,
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
			const expectedLines = ["hello this is text", "", "```", "  code block", "```", "", "more text"];

			for (const text of cases) {
				const markdown = new Markdown(text, 0, 0, defaultMarkdownTheme);
				const lines = markdown.render(80);
				const plainLines = lines.map(line => stripVTControlCharacters(line).trimEnd());

				expect(plainLines).toEqual(expectedLines);
			}
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

		it("falls back to the original fenced code block when mermaid resolution returns null", () => {
			const invalidMermaid = "```mermaid\nflowchart TD\n  A --\n```";
			const invalidSource = "flowchart TD\n  A --";
			const seenSources: string[] = [];

			const plainLines = renderMermaidLines(invalidMermaid, source => {
				seenSources.push(source);
				return null;
			});

			expect(seenSources).toEqual([invalidSource]);
			expect(plainLines).toEqual(["```mermaid", "  flowchart TD", "    A --", "```"]);
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

			expect(plainOutput.includes("```js")).toBeTruthy();
			expect(plainOutput.includes("console.log(1)")).toBeTruthy();
			expect(plainOutput.includes("```")).toBeTruthy();
			expect(output.includes("\x1b[35m")).toBeFalsy();
			expect(output.includes("\x1b[3m")).toBeTruthy();
		});
	});

	const stripTerminalSequences = (line: string): string => stripVTControlCharacters(line);

	describe("Links", () => {
		// CI environments often resolve to the "base" terminal which has hyperlinks
		// disabled; force them on so OSC 8 assertions are deterministic. The render
		// cache keys on TERMINAL.hyperlinks, so flipping the bit invalidates entries.
		const terminalState = TERMINAL as unknown as { hyperlinks: boolean };
		const originalHyperlinks = terminalState.hyperlinks;
		beforeAll(() => {
			terminalState.hyperlinks = true;
		});
		afterAll(() => {
			terminalState.hyperlinks = originalHyperlinks;
		});

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

		it("should keep wrapped URLs inside a single OSC 8 hyperlink span", () => {
			const markdown = new Markdown(
				"Visit https://example.com/really/long/path/that/will/wrap/on/narrow/width for more",
				0,
				0,
				defaultMarkdownTheme,
			);

			const lines = markdown.render(32);
			expect(lines.length).toBeGreaterThan(1);
			const output = lines.join("\n");
			const openMatches =
				output.match(
					/\x1b\]8;;https:\/\/example\.com\/really\/long\/path\/that\/will\/wrap\/on\/narrow\/width\x07/g,
				) || [];
			const closeMatches = output.match(/\x1b\]8;;\x07/g) || [];
			expect(openMatches.length).toBe(1);
			expect(closeMatches.length).toBeGreaterThan(0);
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

	it("paints a colored swatch before a bare hex color in prose", () => {
		const out = new Markdown("Accent is #C5FFD6 today.", 0, 0, defaultMarkdownTheme).render(80).join("\n");
		// Swatch (color SGR + chip glyph + fg reset + space) sits immediately before the code.
		expect(out.includes(`${swatchFor("C5FFD6")}\x1b[39m `)).toBeTruthy();
		expect(out.includes("#C5FFD6")).toBeTruthy();
	});

	it("paints a swatch before a backticked hex color", () => {
		const out = new Markdown("Use `#C5FFD6` for the bg.", 0, 0, defaultMarkdownTheme).render(80).join("\n");
		expect(out.includes(swatchFor("C5FFD6"))).toBeTruthy();
		// The code text survives as inline code (theme styles it yellow).
		expect(out.includes("#C5FFD6")).toBeTruthy();
	});

	it("does not swatch short numeric references that resemble issue numbers", () => {
		const out = new Markdown("Fixed #1011, see #123, dark #000.", 0, 0, defaultMarkdownTheme).render(80).join("");
		expect(out.includes("■")).toBe(false);
	});

	it("swatches a 3-digit shorthand that contains a hex letter", () => {
		const out = new Markdown("White is #fff.", 0, 0, defaultMarkdownTheme).render(80).join("\n");
		expect(out.includes(swatchFor("fff"))).toBeTruthy();
	});

	it("does not swatch 4-digit hashline #TAG snapshot tags", () => {
		// Hashline tags are 4 hex digits with letters (e.g. #6C5E) and would
		// otherwise be read as #RGBA colors. Neither prose nor codespans swatch them.
		const prose = new Markdown("Re-anchor on #6C5E before editing.", 0, 0, defaultMarkdownTheme).render(80).join("");
		expect(prose.includes("■")).toBe(false);
		const code = new Markdown("Tag `#6C5E` stays plain.", 0, 0, defaultMarkdownTheme).render(80).join("");
		expect(code.includes("■")).toBe(false);
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
		// Gray (\x1b[90m) is re-opened for the code text — the swatch's fg reset must not bleed.
		expect(out.includes("\x1b[90m#C5FFD6")).toBeTruthy();
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

	it("skips code-block highlighting for transient streaming renders", () => {
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
		const plain = stripVTControlCharacters(markdown.render(80).join("\n"));

		expect(highlightCallCount).toBe(0);
		expect(plain).toContain("const streamed = true;");
		expect(plain).not.toContain("HIGHLIGHTED");
	});

	it("re-renders code-block highlighting when a transient instance becomes stable", () => {
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
		const plain = stripVTControlCharacters(markdown.render(80).join("\n"));
		expect(highlightCallCount).toBe(0);
		expect(plain).toContain("const streamed = true;");

		markdown.transientRenderCache = false;
		const highlighted = stripVTControlCharacters(markdown.render(80).join("\n"));
		expect(highlightCallCount).toBe(1);
		expect(highlighted).toContain("HIGHLIGHTED");
	});

	it("skips nested list code-block highlighting for transient streaming renders", () => {
		clearRenderCache();
		let highlightCallCount = 0;
		const themeWithSpy = {
			...defaultMarkdownTheme,
			highlightCode: (_code: string, _lang?: string): string[] => {
				highlightCallCount++;
				return ["HIGHLIGHTED"];
			},
		};

		const markdown = new Markdown("- item\n\n  ```ts\n  const streamed = true;\n  ```", 0, 0, themeWithSpy);
		markdown.transientRenderCache = true;
		const plain = stripVTControlCharacters(markdown.render(80).join("\n"));

		expect(highlightCallCount).toBe(0);
		expect(plain).toContain("const streamed = true;");
		expect(plain).not.toContain("HIGHLIGHTED");
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

	it("converts a $$-delimited matrix block to multi-line Unicode", () => {
		const md = new Markdown("$$\n\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}\n$$", 0, 0, defaultMarkdownTheme);
		const out = plain(md);
		expect(out).toContain("(a");
		expect(out).toContain("d)");
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
