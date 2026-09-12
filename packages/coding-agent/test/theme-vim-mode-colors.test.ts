import { describe, expect, it } from "bun:test";
import { createTheme, getBuiltinThemes } from "@oh-my-pi/pi-coding-agent/modes/theme/loader";
import type { ColorValue, ThemeColor, ThemeJson } from "@oh-my-pi/pi-coding-agent/modes/theme/schema";
import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme-class";

/** Optional keys: a theme that omits one must keep rendering in the token the segment used before. */

const dark = getBuiltinThemes().dark;

/** Opening SGR sequence for a color, which is what the segment actually emits. */
function sgr(theme: Theme, color: ThemeColor): string {
	const styled = theme.fg(color, "\u0001");
	return styled.slice(0, styled.indexOf("\u0001"));
}

function themeWith(colors: Partial<Record<ThemeColor, ColorValue>>): Theme {
	return createTheme({ ...dark, colors: { ...dark.colors, ...colors } } as ThemeJson, { mode: "truecolor" });
}

describe("vim mode theme colors", () => {
	it("falls back to the pre-existing tokens when a theme omits the keys", () => {
		// `dark` states its colors as `vars` references, so the fallback has to be resolved too.
		const theme = createTheme(dark, { mode: "truecolor" });
		expect(sgr(theme, "statusLineVimNormal")).toBe(sgr(theme, "accent"));
		expect(sgr(theme, "statusLineVimInsert")).toBe(sgr(theme, "success"));
		expect(sgr(theme, "statusLineVimVisual")).toBe(sgr(theme, "warning"));
		expect(sgr(theme, "statusLineVimVisualLine")).toBe(sgr(theme, "warning"));
	});

	it("takes the theme's own values, and defaults the keys the theme leaves out", () => {
		const theme = themeWith({
			statusLineVimNormal: dark.colors.success,
			statusLineVimInsert: dark.colors.accent,
			statusLineVimVisualLine: dark.colors.error,
		});
		expect(sgr(theme, "statusLineVimNormal")).toBe(sgr(theme, "success"));
		expect(sgr(theme, "statusLineVimNormal")).not.toBe(sgr(theme, "accent"));
		expect(sgr(theme, "statusLineVimInsert")).toBe(sgr(theme, "accent"));
		expect(sgr(theme, "statusLineVimVisualLine")).toBe(sgr(theme, "error"));
		// An unset key keeps defaulting even when its siblings are overridden.
		expect(sgr(theme, "statusLineVimVisual")).toBe(sgr(theme, "warning"));
	});
});
