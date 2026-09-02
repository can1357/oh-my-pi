import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { renderMarkdownCell } from "@oh-my-pi/pi-coding-agent/tui/code-cell";
import { outputBlockContentWidth, renderOutputBlock } from "@oh-my-pi/pi-coding-agent/tui/output-block";

describe("renderOutputBlock", () => {
	beforeAll(async () => {
		await initTheme();
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

	it("truncates flat section labels to their indented width", async () => {
		const theme = (await getThemeByName("dark"))!;
		const lines = renderOutputBlock(
			{
				width: 12,
				flat: true,
				sections: [{ label: "ask questions[].id", lines: [] }],
			},
			theme,
		).map(line => stripVTControlCharacters(line));

		expect(lines).toEqual(["  ask quest…"]);
	});

	it("keeps the original positional contract of outputBlockContentWidth", () => {
		// Pre-opencode signature: (width, contentPaddingLeft?, contentPaddingRight?).
		// Precompiled JS extension callers rely on these positions.
		expect(outputBlockContentWidth(40)).toBe(36);
		expect(outputBlockContentWidth(40, 0)).toBe(38);
		expect(outputBlockContentWidth(40, 2, 3)).toBe(33);
		// The opencode `flat` flag is appended LAST so the positions above never shift.
		expect(outputBlockContentWidth(40, undefined, undefined, true)).toBe(38);
	});
});
