import { describe, expect, test } from "bun:test";
import { relativeLuminance } from "@oh-my-pi/pi-utils";
import { loadTheme, loadThemeJson } from "@oh-my-pi/pi-tui/theme/loader";
import { resolveColorValue } from "@oh-my-pi/pi-tui/theme/theme";

/** WCAG contrast ratio between two resolved colors. */
function contrastRatio(foreground: string | number, background: string | number, label: string): number {
	const foregroundLuminance = relativeLuminance(foreground);
	const backgroundLuminance = relativeLuminance(background);
	if (foregroundLuminance === undefined || backgroundLuminance === undefined) {
		throw new Error(`${label} has an invalid foreground or background color`);
	}
	return (
		(Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
		(Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
	);
}

/**
 * The fence border paints the whole ```lang / ```start:end:path info-string line
 * (the markdown fence styles in pi-tui text/markdown), so it carries real
 * navigation info and must stay legible as secondary chrome against the theme's
 * own page background, not sink into a near-background surface tone.
 */
describe("code fence border contrast", () => {
	/** Themes whose palettes once pinned mdCodeBlockBorder to a near-bg surface tone. */
	const NEAR_BG_BORDER_THEMES = ["dark", "dark-catppuccin", "dark-nord", "dark-eclipse", "dark-retro"];
	/** Just below Nord's 2.43:1, the lowest contrast available in its muted palette. */
	const MIN_CONTRAST = 2.4;

	for (const name of NEAR_BG_BORDER_THEMES) {
		test(`${name}: mdCodeBlockBorder is legible against the theme page background`, async () => {
			const [theme, themeJson] = await Promise.all([loadTheme(name, { depth: "truecolor" }), loadThemeJson(name)]);
			const border = theme.hex("mdCodeBlockBorder");
			const pageBgToken = themeJson.export?.pageBg;
			expect(pageBgToken).toBeDefined();
			if (pageBgToken === undefined) throw new Error(`${name} does not define export.pageBg`);
			const pageBg = resolveColorValue(pageBgToken, themeJson.vars ?? {});
			expect(typeof pageBg).toBe("string");
			if (typeof pageBg !== "string") throw new Error(`${name} export.pageBg is not an RGB color`);

			expect(contrastRatio(border, pageBg, name)).toBeGreaterThanOrEqual(MIN_CONTRAST);
		});
	}
});

describe("Obsidian muted text contrast", () => {
	const MIN_TEXT_CONTRAST = 4.5;

	test("task instructions and usage limits remain readable on their backgrounds", async () => {
		const [theme, themeJson] = await Promise.all([
			loadTheme("obsidian", { depth: "truecolor" }),
			loadThemeJson("obsidian"),
		]);
		const pageBgToken = themeJson.export?.pageBg;
		if (pageBgToken === undefined) throw new Error("Obsidian does not define export.pageBg");

		const muted = theme.hex("muted");
		const surfaces: [string, string | number][] = [
			["task/page", resolveColorValue(pageBgToken, themeJson.vars ?? {})],
			["usage/status", theme.hex("statusLineBg")],
		];
		for (const [name, background] of surfaces) {
			expect(contrastRatio(muted, background, "Obsidian"), name).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
		}
	});
});
