import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { TruncatedText } from "@oh-my-pi/pi-tui/components/truncated-text";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
import { Chalk } from "@oh-my-pi/pi-utils/chalk";

// Force full color in CI so ANSI assertions are deterministic
const chalk = new Chalk({ level: 3 });

describe("TruncatedText component", () => {
	it("applies horizontal padding without trailing spaces", () => {
		const text = new TruncatedText("Hello world", 1, 0);
		const lines = text.render(50);

		// Should have exactly one content line (no vertical padding)
		expect(lines.length).toBe(1);

		// Line should be: leftPad(1) + "Hello world"(11) + rightPad(1) = 13
		// No trailing padding to full width (avoids issues when copying)
		const visibleLen = visibleWidth(lines[0]);
		expect(visibleLen).toBe(13);
	});

	it("pads output with vertical padding lines to width", () => {
		const text = new TruncatedText("Hello", 0, 2);
		const lines = text.render(40);

		// Should have 2 padding lines + 1 content line + 2 padding lines = 5 total
		expect(lines.length).toBe(5);

		// Vertical padding lines are full width
		expect(visibleWidth(lines[0])).toBe(40);
		expect(visibleWidth(lines[1])).toBe(40);
		expect(visibleWidth(lines[3])).toBe(40);
		expect(visibleWidth(lines[4])).toBe(40);

		// Content line is just the text (no horizontal padding specified)
		expect(visibleWidth(lines[2])).toBe(5);
	});

	it("truncates long text with ellipsis", () => {
		const longText = "This is a very long piece of text that will definitely exceed the available width";
		const text = new TruncatedText(longText, 1, 0);
		const lines = text.render(30);

		expect(lines.length).toBe(1);

		// availableWidth = 30 - 2*1 = 28, so truncated text is 28 chars
		// plus padding: 1 + 28 + 1 = 30
		expect(visibleWidth(lines[0])).toBe(30);

		// Should contain ellipsis
		const stripped = stripVTControlCharacters(lines[0]);
		expect(stripped.includes("…")).toBeTruthy();
	});

	it("preserves ANSI codes in output", () => {
		const styledText = `${chalk.red("Hello")} ${chalk.blue("world")}`;
		const text = new TruncatedText(styledText, 1, 0);
		const lines = text.render(40);

		expect(lines.length).toBe(1);

		// "Hello world" = 11 chars + padding = 13
		expect(visibleWidth(lines[0])).toBe(13);

		// Should preserve the color codes
		expect(lines[0].includes("\x1b[")).toBeTruthy();
	});

	it("truncates styled text and adds reset code before ellipsis", () => {
		const longStyledText = chalk.red("This is a very long red text that will be truncated");
		const text = new TruncatedText(longStyledText, 1, 0);
		const lines = text.render(20);

		expect(lines.length).toBe(1);

		// availableWidth = 20 - 2 = 18, truncated to 18 + padding = 20
		expect(visibleWidth(lines[0])).toBe(20);

		// Should contain reset code before ellipsis
		expect(lines[0].includes("\x1b[0m…")).toBeTruthy();
	});

	it("handles text that fits without truncation", () => {
		// With paddingX=1, available width is 30-2=28
		// "Hello world" is 11 chars, fits comfortably
		const text = new TruncatedText("Hello world", 1, 0);
		const lines = text.render(30);

		expect(lines.length).toBe(1);
		// 1 + 11 + 1 = 13 (no trailing padding)
		expect(visibleWidth(lines[0])).toBe(13);

		// Should NOT contain ellipsis
		const stripped = stripVTControlCharacters(lines[0]);
		expect(!stripped.includes("…")).toBeTruthy();
	});

	it("handles empty text", () => {
		const text = new TruncatedText("", 1, 0);
		const lines = text.render(30);

		expect(lines.length).toBe(1);
		// Just the padding: 1 + 0 + 1 = 2
		expect(visibleWidth(lines[0])).toBe(2);
	});

	it("stops at newline and only shows first line", () => {
		const multilineText = "First line\nSecond line\nThird line";
		const text = new TruncatedText(multilineText, 1, 0);
		const lines = text.render(40);

		expect(lines.length).toBe(1);
		// "First line" = 10 + padding = 12
		expect(visibleWidth(lines[0])).toBe(12);

		// Should only contain "First line"
		const stripped = stripVTControlCharacters(lines[0]).trim();
		expect(stripped.includes("First line")).toBeTruthy();
		expect(!stripped.includes("Second line")).toBeTruthy();
		expect(!stripped.includes("Third line")).toBeTruthy();
	});

	it("truncates first line even with newlines in text", () => {
		const longMultilineText = "This is a very long first line that needs truncation\nSecond line";
		const text = new TruncatedText(longMultilineText, 1, 0);
		const lines = text.render(25);

		expect(lines.length).toBe(1);
		// availableWidth = 25 - 2 = 23, truncated to 23 + padding = 25
		expect(visibleWidth(lines[0])).toBe(25);

		// Should contain ellipsis and not second line
		const stripped = stripVTControlCharacters(lines[0]);
		expect(stripped.includes("…")).toBeTruthy();
		expect(!stripped.includes("Second line")).toBeTruthy();
	});
});
