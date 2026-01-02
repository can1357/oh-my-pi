import { describe, expect, it } from "bun:test";
import { Chalk } from "chalk";
import { TruncatedText } from "../src/components/truncated-text.js";
import { visibleWidth } from "../src/utils.js";

// Force full color in CI so ANSI assertions are deterministic
const chalk = new Chalk({ level: 3 });

describe("TruncatedText component", () => {
	it("pads output lines to exactly match width", () => {
		const text = new TruncatedText("Hello world", 1, 0);
		const lines = text.render(50);

		// Should have exactly one content line (no vertical padding)
		expect(lines.length).toBe(1);

		// Line should be exactly 50 visible characters
		const visibleLen = visibleWidth(lines[0]);
		expect(visibleLen).toBe(50);
	});

	it("pads output with vertical padding lines to width", () => {
		const text = new TruncatedText("Hello", 0, 2);
		const lines = text.render(40);

		// Should have 2 padding lines + 1 content line + 2 padding lines = 5 total
		expect(lines.length).toBe(5);

		// All lines should be exactly 40 characters
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(40);
		}
	});

	it("truncates long text and pads to width", () => {
		const longText = "This is a very long piece of text that will definitely exceed the available width";
		const text = new TruncatedText(longText, 1, 0);
		const lines = text.render(30);

		expect(lines.length).toBe(1);

		// Should be exactly 30 characters
		expect(visibleWidth(lines[0])).toBe(30);

		// Should contain ellipsis
		const stripped = lines[0].replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped.includes("...")).toBeTruthy();
	});

	it("preserves ANSI codes in output and pads correctly", () => {
		const styledText = `${chalk.red("Hello")} ${chalk.blue("world")}`;
		const text = new TruncatedText(styledText, 1, 0);
		const lines = text.render(40);

		expect(lines.length).toBe(1);

		// Should be exactly 40 visible characters (ANSI codes don't count)
		expect(visibleWidth(lines[0])).toBe(40);

		// Should preserve the color codes
		expect(lines[0].includes("\x1b[")).toBeTruthy();
	});

	it("truncates styled text and adds reset code before ellipsis", () => {
		const longStyledText = chalk.red("This is a very long red text that will be truncated");
		const text = new TruncatedText(longStyledText, 1, 0);
		const lines = text.render(20);

		expect(lines.length).toBe(1);

		// Should be exactly 20 visible characters
		expect(visibleWidth(lines[0])).toBe(20);

		// Should contain reset code before ellipsis
		expect(lines[0].includes("\x1b[0m...")).toBeTruthy();
	});

	it("handles text that fits exactly", () => {
		// With paddingX=1, available width is 30-2=28
		// "Hello world" is 11 chars, fits comfortably
		const text = new TruncatedText("Hello world", 1, 0);
		const lines = text.render(30);

		expect(lines.length).toBe(1);
		expect(visibleWidth(lines[0])).toBe(30);

		// Should NOT contain ellipsis
		const stripped = lines[0].replace(/\x1b\[[0-9;]*m/g, "");
		expect(!stripped.includes("...")).toBeTruthy();
	});

	it("handles empty text", () => {
		const text = new TruncatedText("", 1, 0);
		const lines = text.render(30);

		expect(lines.length).toBe(1);
		expect(visibleWidth(lines[0])).toBe(30);
	});

	it("stops at newline and only shows first line", () => {
		const multilineText = "First line\nSecond line\nThird line";
		const text = new TruncatedText(multilineText, 1, 0);
		const lines = text.render(40);

		expect(lines.length).toBe(1);
		expect(visibleWidth(lines[0])).toBe(40);

		// Should only contain "First line"
		const stripped = lines[0].replace(/\x1b\[[0-9;]*m/g, "").trim();
		expect(stripped.includes("First line")).toBeTruthy();
		expect(!stripped.includes("Second line")).toBeTruthy();
		expect(!stripped.includes("Third line")).toBeTruthy();
	});

	it("truncates first line even with newlines in text", () => {
		const longMultilineText = "This is a very long first line that needs truncation\nSecond line";
		const text = new TruncatedText(longMultilineText, 1, 0);
		const lines = text.render(25);

		expect(lines.length).toBe(1);
		expect(visibleWidth(lines[0])).toBe(25);

		// Should contain ellipsis and not second line
		const stripped = lines[0].replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped.includes("...")).toBeTruthy();
		expect(!stripped.includes("Second line")).toBeTruthy();
	});
});
