import { afterEach, describe, expect, it } from "bun:test";
import { TERMINAL, setTerminalHyperlinks } from "@oh-my-pi/pi-tui";
import { applyHyperlinkSetting } from "@oh-my-pi/pi-tui/render/hyperlink";
import * as themeModule from "@oh-my-pi/pi-tui/theme";
import { readToolRenderer } from "@oh-my-pi/pi-tui/tools/read";

const ORIGINAL_HYPERLINKS = TERMINAL.hyperlinks;

afterEach(() => {
	applyHyperlinkSetting("auto");
	setTerminalHyperlinks(ORIGINAL_HYPERLINKS);
});

describe("pending read path rendering", () => {
	it("links a relative path before the read result exists", async () => {
		applyHyperlinkSetting("always");
		await themeModule.initTheme();
		const uiTheme = (await themeModule.getThemeByName("dark")) ?? (await themeModule.getThemeByName("light"));
		if (!uiTheme) throw new Error("expected an initialized theme");
		const relativePath = ".tricky/reports/pending/interval.json";
		const component = readToolRenderer.renderCall(
			{ path: relativePath },
			{ expanded: false, isPartial: true },
			uiTheme,
		);

		const rendered = component.render(120).join("\n");
		const target = rendered.match(/\x1b\]8;[^;]*;([^\x1b]+)\x1b\\/)?.[1];
		expect(target).toBeDefined();
		expect(target).toMatch(/^file:/);
		expect(decodeURIComponent(new URL(target!).pathname)).toEndWith(`/${relativePath}`);
	});

	it("leaves scheme-less web hosts plain without hiding explicit local paths", async () => {
		applyHyperlinkSetting("always");
		await themeModule.initTheme();
		const uiTheme = (await themeModule.getThemeByName("dark")) ?? (await themeModule.getThemeByName("light"));
		if (!uiTheme) throw new Error("expected an initialized theme");
		for (const input of ["localhost:3000/", "server:8080/docs", "127.0.0.1:3000/", "example.com/docs"]) {
			const rendered = readToolRenderer
				.renderCall({ path: input }, { expanded: false, isPartial: true }, uiTheme)
				.render(120)
				.join("\n");
			expect(rendered).toContain(input);
			expect(rendered).not.toContain("\x1b]8;");
		}
		const local = readToolRenderer
			.renderCall({ path: "./example.com/docs" }, { expanded: false, isPartial: true }, uiTheme)
			.render(120)
			.join("\n");
		expect(local).toContain("\x1b]8;");
	});
});
