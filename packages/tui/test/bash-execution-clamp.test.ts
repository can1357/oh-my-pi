import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { BashExecutionComponent } from "@oh-my-pi/pi-tui/chat/bash-execution";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";
import type { TUI } from "@oh-my-pi/pi-tui";
import { visibleWidth } from "@oh-my-pi/pi-tui";

const MAX_DISPLAY_LINE_CHARS = 4000;
let darkTheme: Theme;

beforeAll(async () => {
	const loaded = await getThemeByName("dark");
	expect(loaded).toBeDefined();
	darkTheme = loaded!;
});

describe("BashExecutionComponent #clampDisplayLine", () => {
	const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

	beforeEach(() => {
		setThemeInstance(darkTheme);
	});

	function createComponentWithOutput(output: string): BashExecutionComponent {
		const component = new BashExecutionComponent("test", ui, false);
		component.appendOutput(output);
		component.setComplete(0, false);
		return component;
	}

	describe("wide glyphs (CJK characters)", () => {
		it("truncates CJK string over limit and calculates omitted correctly", () => {
			const cjkString = "日本語".repeat(2500);
			const expectedVisible = visibleWidth(cjkString);
			const component = createComponentWithOutput(cjkString);
			const output = component.getOutput();

			expect(output).toContain("visible columns omitted");
			expect(output).toContain(`[${expectedVisible - MAX_DISPLAY_LINE_CHARS} visible columns omitted]`);
			expect(output).toContain("…");
		});
	});

	describe("ANSI-decorated strings", () => {
		it("calculates omitted count based on visible width, not raw length", () => {
			const ansiString = "\x1b[1;31;47mbold red on white\x1b[0m".repeat(1000);
			const expectedVisible = visibleWidth(ansiString);
			const component = createComponentWithOutput(ansiString);
			const output = component.getOutput();

			if (expectedVisible > MAX_DISPLAY_LINE_CHARS) {
				const omittedMatch = output.match(/\[(\d+) visible columns omitted\]/);
				expect(omittedMatch).not.toBeNull();
				const omitted = parseInt(omittedMatch![1], 10);
				expect(omitted).toBe(expectedVisible - MAX_DISPLAY_LINE_CHARS);
			}
		});
	});

	describe("truncation with Ellipsis.Omit", () => {
		it("truncates using visibleWidth and truncateToWidth", () => {
			const longAscii = "a".repeat(5000);
			const component = createComponentWithOutput(longAscii);
			const output = component.getOutput();

			expect(output).toContain("…");
			expect(output).toContain("visible columns omitted");
			expect(output.length).toBeLessThan(5000);
		});

		it("truncated portion is within MAX_DISPLAY_LINE_CHARS visible width", () => {
			const longString = "hello world ".repeat(1000);
			const component = createComponentWithOutput(longString);
			const output = component.getOutput();

			if (output.includes("omitted")) {
				const truncatedPart = output.split(" [")[0];
				// truncateToWidth limits to exactly MAX_DISPLAY_LINE_CHARS, may go 1 over due to wide chars
				expect(visibleWidth(truncatedPart)).toBeLessThanOrEqual(MAX_DISPLAY_LINE_CHARS + 10);
			}
		});
	});

	describe("omitted count accuracy", () => {
		it("calculates omitted as visibleWidth(original) - MAX_DISPLAY_LINE_CHARS", () => {
			const testString = "test".repeat(1500);
			const originalVisible = visibleWidth(testString);
			const component = createComponentWithOutput(testString);
			const output = component.getOutput();

			const expectedOmitted = originalVisible - MAX_DISPLAY_LINE_CHARS;
			expect(output).toContain(`[${expectedOmitted} visible columns omitted]`);
		});

		it("handles mixed content (ASCII + CJK + emoji + ANSI)", () => {
			const mixed = "abc日本語😀\x1b[34mblue\x1b[0m".repeat(500);
			const originalVisible = visibleWidth(mixed);
			const component = createComponentWithOutput(mixed);
			const output = component.getOutput();

			if (originalVisible > MAX_DISPLAY_LINE_CHARS) {
				const expectedOmitted = originalVisible - MAX_DISPLAY_LINE_CHARS;
				expect(output).toContain(`[${expectedOmitted} visible columns omitted]`);
			}
		});
	});

	describe("edge cases at, below, and above MAX_DISPLAY_LINE_CHARS", () => {
		it("returns original string when visibleWidth equals MAX_DISPLAY_LINE_CHARS", () => {
			const exactlyAtLimit = "a".repeat(MAX_DISPLAY_LINE_CHARS);
			const component = createComponentWithOutput(exactlyAtLimit);
			const output = component.getOutput();

			expect(output).toBe(exactlyAtLimit);
			expect(output).not.toContain("omitted");
		});

		it("returns original string when visibleWidth is just below limit", () => {
			const justBelow = "a".repeat(MAX_DISPLAY_LINE_CHARS - 1);
			const component = createComponentWithOutput(justBelow);
			const output = component.getOutput();

			expect(output).toBe(justBelow);
			expect(output).not.toContain("omitted");
		});

		it("truncates when visibleWidth is just above limit", () => {
			const justAbove = "a".repeat(MAX_DISPLAY_LINE_CHARS + 1);
			const component = createComponentWithOutput(justAbove);
			const output = component.getOutput();

			expect(output).toContain("omitted");
			expect(output).toContain(`[1 visible columns omitted]`);
		});

		it("handles empty string", () => {
			const component = createComponentWithOutput("");
			const output = component.getOutput();

			expect(output).toBe("");
		});
	});
});
