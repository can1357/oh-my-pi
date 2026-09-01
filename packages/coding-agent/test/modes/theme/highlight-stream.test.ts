import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Markdown } from "@oh-my-pi/pi-tui";
import { Settings } from "../../../src/config/settings";
import { getMarkdownTheme, getThemeByName, setThemeInstance } from "../../../src/modes/theme/theme";

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("theme unavailable");
	setThemeInstance(theme);
});

describe("markdown highlight stream", () => {
	it("renders a streaming lua fence without aborting", () => {
		const markdown = new Markdown("```lua\nlocal x = 1\nmore", 0, 0, getMarkdownTheme());
		markdown.transientRenderCache = true;
		let lines: readonly string[] = [];
		expect(() => {
			lines = markdown.render(80);
		}).not.toThrow();
		const plain = stripVTControlCharacters(lines.join("\n"));
		expect(plain).toContain("local x = 1");
	});
});
