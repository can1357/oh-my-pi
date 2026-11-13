import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Markdown } from "@oh-my-pi/pi-tui/components/markdown";
import { setExtensionLinks } from "@oh-my-pi/pi-tui/render/extension-links";
import { getMarkdownTheme, setThemeInstance, type Theme, theme } from "@oh-my-pi/pi-tui/theme";
import { createTheme, getBuiltinThemes } from "@oh-my-pi/pi-tui/theme/loader";
import type { ThemeJson } from "@oh-my-pi/pi-tui/theme/schema";

function darkWith(colors: Partial<ThemeJson["colors"]>, terminal?: ThemeJson["terminal"]): Theme {
	const json = getBuiltinThemes().dark;
	if (!json) throw new Error("dark theme unavailable");
	return createTheme(
		{ ...json, colors: { ...json.colors, ...colors }, terminal: terminal ?? json.terminal },
		{ mode: "truecolor" },
	);
}

describe("mdExtensionLink", () => {
	it("derives a 45% link / 55% text blend when the theme omits it", () => {
		// 0.55 * 255 = 140 on red and green, blue stays 255.
		const t = darkWith({ mdLink: "#0000ff", text: "#ffffff" });
		expect(t.getColorHex("mdExtensionLink")).toBe("#8c8cff");
	});

	it("resolves a palette-index mdLink before blending", () => {
		// Index 21 is #0000ff in the 6x6x6 cube.
		const t = darkWith({ mdLink: 21, text: "#ffffff" });
		expect(t.getColorHex("mdExtensionLink")).toBe("#8c8cff");
	});

	it("blends a terminal-default text with the theme's terminal foreground", () => {
		const t = darkWith({ mdLink: "#0000ff", text: "" }, { foreground: "#ffffff" });
		expect(t.getColorHex("mdExtensionLink")).toBe("#8c8cff");
	});

	it("reads a basic palette index through the theme's terminal.ansi", () => {
		const ansi = Array.from({ length: 16 }, () => "#000000");
		ansi[4] = "#0000ff";
		const t = darkWith({ mdLink: 4, text: "#ffffff" }, { ansi });
		expect(t.getColorHex("mdExtensionLink")).toBe("#8c8cff");
	});

	it("keeps an explicit theme value", () => {
		const t = darkWith({ mdLink: "#0000ff", text: "#ffffff", mdExtensionLink: "#123456" });
		expect(t.getColorHex("mdExtensionLink")).toBe("#123456");
	});
});

describe("extension link rendering", () => {
	let previous: Theme;
	let t: Theme;

	beforeAll(() => {
		previous = theme;
		t = darkWith({ mdLink: "#0000ff", text: "#ffffff" });
		setThemeInstance(t);
	});
	afterEach(() => setExtensionLinks([]));
	afterAll(() => setThemeInstance(previous));

	it("paints extension links with mdExtensionLink and web links with mdLink", () => {
		setExtensionLinks(["demo"]);
		const text = "Open [the details](demo:open/7) or [the docs](https://example.com/docs).";
		const out = new Markdown(text, 0, 0, getMarkdownTheme()).render(80).join("\n");

		expect(out).toContain(t.fg("mdExtensionLink", "the details"));
		expect(out).not.toContain(t.fg("mdLink", "the details"));
		expect(out).toContain(t.fg("mdLink", t.underline("the docs")));
	});
});
