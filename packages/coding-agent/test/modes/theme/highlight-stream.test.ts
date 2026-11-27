import { afterAll, describe, expect, it } from "bun:test";
import { plainRows } from "@oh-my-pi/pi-tui/testing/cells";
import { renderMarkdown } from "@oh-my-pi/pi-tui/text/markdown/index";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

describe("markdown highlight stream", () => {
	it("renders a streaming lua fence without aborting", () => {
		const theme = loadThemeSync("dark");
		let rows: readonly string[] = [];
		expect(() => {
			rows = renderMarkdown("```lua\nlocal x = 1\nmore", 80, { theme, stream: true });
		}).not.toThrow();
		expect(plainRows(rows).join("\n")).toContain("local x = 1");
	});
});
