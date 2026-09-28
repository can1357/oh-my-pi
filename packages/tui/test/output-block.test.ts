import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { getThemeByName, initTheme } from "@oh-my-pi/pi-tui/theme";
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
