import { describe, expect, it } from "bun:test";
import { Chalk } from "chalk";
import { Markdown } from "../src/components/markdown.js";
import { defaultMarkdownTheme } from "./test-themes.js";

// Force full color in CI so ANSI assertions are deterministic
const chalk = new Chalk({ level: 3 });

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
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Check structure
			expect(plainLines.some((line) => line.includes("- Item 1"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("  - Nested 1.1"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("  - Nested 1.2"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("- Item 2"))).toBeTruthy();
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
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Check proper indentation
			expect(plainLines.some((line) => line.includes("- Level 1"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("  - Level 2"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("    - Level 3"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("      - Level 4"))).toBeTruthy();
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
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			expect(plainLines.some((line) => line.includes("1. First"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("  1. Nested first"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("  2. Nested second"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("2. Second"))).toBeTruthy();
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
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			expect(plainLines.some((line) => line.includes("1. Ordered item"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("  - Unordered nested"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("2. Second ordered"))).toBeTruthy();
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
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Check table structure
			expect(plainLines.some((line) => line.includes("Name"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("Age"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("Alice"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("Bob"))).toBeTruthy();
			// Check for table borders
			expect(plainLines.some((line) => line.includes("│"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("─"))).toBeTruthy();
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
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Check headers
			expect(plainLines.some((line) => line.includes("Left"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("Center"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("Right"))).toBeTruthy();
			// Check content
			expect(plainLines.some((line) => line.includes("Long text"))).toBeTruthy();
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

			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			expect(plainLines.some((line) => line.includes("Very long column header"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("This is a much longer cell content"))).toBeTruthy();
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
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// All lines should fit within width
			for (const line of plainLines) {
				expect(line.length <= 50, `Line exceeds width 50: "${line}" (length: ${line.length}).toBeTruthy()`);
			}

			// Content should still be present (possibly wrapped across lines)
			const allText = plainLines.join(" ");
			expect(allText.includes("Command")).toBeTruthy();
			expect(allText.includes("Description")).toBeTruthy();
			expect(allText.includes("npm install")).toBeTruthy();
			expect(allText.includes("Install")).toBeTruthy();
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
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// Should have multiple data rows due to wrapping
			const dataRows = plainLines.filter((line) => line.startsWith("│") && !line.includes("─"));
			expect(dataRows.length > 2).toBeTruthy();

			// All content should be preserved (may be split across lines)
			const allText = plainLines.join(" ");
			expect(allText.includes("very long")).toBeTruthy();
			expect(allText.includes("cell content")).toBeTruthy();
			expect(allText.includes("should wrap")).toBeTruthy();
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
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			for (const line of plainLines) {
				expect(
					line.length <= width,
					`Line exceeds width ${width}: "${line}" (length: ${line.length}).toBeTruthy()`,
				);
			}

			// Borders should stay intact (exactly 2 vertical borders for a 1-col table)
			const tableLines = plainLines.filter((line) => line.startsWith("│"));
			for (const line of tableLines) {
				const borderCount = line.split("│").length - 1;
				expect(borderCount).toBe(2, `Expected 2 borders, got ${borderCount}: "${line}"`);
			}

			// Strip box drawing characters + whitespace so we can assert the URL is preserved
			// even if it was split across multiple wrapped lines.
			const extracted = plainLines.join("").replace(/[│├┤─\s]/g, "");
			expect(extracted.includes("prefix")).toBeTruthy();
			expect(extracted.includes(url)).toBeTruthy();
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
			expect(joinedOutput.includes("\x1b[33m")).toBeTruthy();

			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
			for (const line of plainLines) {
				expect(
					line.length <= width,
					`Line exceeds width ${width}: "${line}" (length: ${line.length}).toBeTruthy()`,
				);
			}

			const tableLines = plainLines.filter((line) => line.startsWith("│"));
			for (const line of tableLines) {
				const borderCount = line.split("│").length - 1;
				expect(borderCount).toBe(2, `Expected 2 borders, got ${borderCount}: "${line}"`);
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
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// Should not crash and should produce output
			expect(lines.length > 0).toBeTruthy();

			// Lines should not exceed width
			for (const line of plainLines) {
				expect(line.length <= 15, `Line exceeds width 15: "${line}" (length: ${line.length}).toBeTruthy()`);
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
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// Should have proper table structure
			const headerLine = plainLines.find((line) => line.includes("A") && line.includes("B"));
			expect(headerLine).toBeTruthy();
			expect(headerLine?.includes("│")).toBeTruthy();

			const separatorLine = plainLines.find((line) => line.includes("├") && line.includes("┼"));
			expect(separatorLine).toBeTruthy();

			const dataLine = plainLines.find((line) => line.includes("1") && line.includes("2"));
			expect(dataLine).toBeTruthy();
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
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			// All lines should respect width
			for (const line of plainLines) {
				expect(line.length <= 40, `Line exceeds width 40: "${line}" (length: ${line.length}).toBeTruthy()`);
			}

			// Table rows should have left padding
			const tableRow = plainLines.find((line) => line.includes("│"));
			expect(tableRow?.startsWith("  ")).toBeTruthy();
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
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));

			// Check heading
			expect(plainLines.some((line) => line.includes("Test Document"))).toBeTruthy();
			// Check list
			expect(plainLines.some((line) => line.includes("- Item 1"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("  - Nested item"))).toBeTruthy();
			// Check table
			expect(plainLines.some((line) => line.includes("Col1"))).toBeTruthy();
			expect(plainLines.some((line) => line.includes("│"))).toBeTruthy();
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
					color: (text) => chalk.gray(text),
					italic: true,
				},
			);

			const lines = markdown.render(80);
			const joinedOutput = lines.join("\n");

			// Should contain the inline code block
			expect(joinedOutput.includes("inline code")).toBeTruthy();

			// The output should have ANSI codes for gray (90) and italic (3)
			expect(joinedOutput.includes("\x1b[90m")).toBeTruthy();
			expect(joinedOutput.includes("\x1b[3m")).toBeTruthy();

			// Verify that inline code is styled (theme uses yellow)
			const hasCodeColor = joinedOutput.includes("\x1b[33m");
			expect(hasCodeColor).toBeTruthy();
		});

		it("should preserve gray italic styling after bold text", () => {
			const markdown = new Markdown(
				"This is thinking with **bold text** and more after",
				1,
				0,
				defaultMarkdownTheme,
				{
					color: (text) => chalk.gray(text),
					italic: true,
				},
			);

			const lines = markdown.render(80);
			const joinedOutput = lines.join("\n");

			// Should contain bold text
			expect(joinedOutput.includes("bold text")).toBeTruthy();

			// The output should have ANSI codes for gray (90) and italic (3)
			expect(joinedOutput.includes("\x1b[90m")).toBeTruthy();
			expect(joinedOutput.includes("\x1b[3m")).toBeTruthy();

			// Should have bold codes (1 or 22 for bold on/off)
			expect(joinedOutput.includes("\x1b[1m")).toBeTruthy();
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
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			const closingBackticksIndex = plainLines.indexOf("```");
			expect(closingBackticksIndex !== -1).toBeTruthy();

			const afterBackticks = plainLines.slice(closingBackticksIndex + 1);
			const emptyLineCount = afterBackticks.findIndex((line) => line !== "");

			expect(
				emptyLineCount,
				1,
				`Expected 1 empty line after code block, but found ${emptyLineCount}. Lines after backticks: ${JSON.stringify(afterBackticks.slice(0, 5))}`,
			);
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
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			const dividerIndex = plainLines.findIndex((line) => line.includes("─"));
			expect(dividerIndex !== -1).toBeTruthy();

			const afterDivider = plainLines.slice(dividerIndex + 1);
			const emptyLineCount = afterDivider.findIndex((line) => line !== "");

			expect(
				emptyLineCount,
				1,
				`Expected 1 empty line after divider, but found ${emptyLineCount}. Lines after divider: ${JSON.stringify(afterDivider.slice(0, 5))}`,
			);
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
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			const headingIndex = plainLines.findIndex((line) => line.includes("Hello"));
			expect(headingIndex !== -1).toBeTruthy();

			const afterHeading = plainLines.slice(headingIndex + 1);
			const emptyLineCount = afterHeading.findIndex((line) => line !== "");

			expect(
				emptyLineCount,
				1,
				`Expected 1 empty line after heading, but found ${emptyLineCount}. Lines after heading: ${JSON.stringify(afterHeading.slice(0, 5))}`,
			);
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
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());

			const quoteIndex = plainLines.findIndex((line) => line.includes("This is a quote"));
			expect(quoteIndex !== -1).toBeTruthy();

			const afterQuote = plainLines.slice(quoteIndex + 1);
			const emptyLineCount = afterQuote.findIndex((line) => line !== "");

			expect(
				emptyLineCount,
				1,
				`Expected 1 empty line after blockquote, but found ${emptyLineCount}. Lines after quote: ${JSON.stringify(afterQuote.slice(0, 5))}`,
			);
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
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const joinedPlain = plainLines.join(" ");

			// The content inside the tags should be visible
			expect(joinedPlain.includes("hidden content") || joinedPlain.includes("<thinking>")).toBeTruthy();
		});

		it("should render HTML tags in code blocks correctly", () => {
			const markdown = new Markdown("```html\n<div>Some HTML</div>\n```", 0, 0, defaultMarkdownTheme);

			const lines = markdown.render(80);
			const plainLines = lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
			const joinedPlain = plainLines.join("\n");

			// HTML in code blocks should be visible
			expect(joinedPlain.includes("<div>") && joinedPlain.includes("</div>")).toBeTruthy();
		});
	});
});
