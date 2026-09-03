import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as themeModule from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UiHelpers } from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";

/**
 * Regression for issue #6337: a status message presented while the auto-theme
 * default guess (dark) was active must re-resolve its color when the terminal's
 * appearance reply later switches the active theme to light. The transient
 * status presenters supply the color via `Text.setStyleFn` (evaluated at render
 * time against the live `theme` binding) instead of baking `theme.fg()` into the
 * component, so invalidating on `onThemeChange` re-shapes it.
 */

/** Opening SGR sequence `theme.fg(color, ...)` emits, independent of color mode. */
function fgPrefix(color: "accent" | "muted" | "warning"): string {
	const styled = themeModule.theme.fg(color, "\u0001");
	return styled.slice(0, styled.indexOf("\u0001"));
}

function isSingleComponent(component: Component | readonly Component[]): component is Component {
	return !Array.isArray(component);
}

describe("lazy status color re-resolves on theme switch", () => {
	beforeEach(async () => {
		themeModule.stopThemeWatcher();
		const dark = await themeModule.getThemeByName("dark");
		if (!dark) throw new Error("Failed to load dark theme for tests");
		themeModule.setThemeInstance(dark);
		vi.restoreAllMocks();
	});

	afterEach(async () => {
		themeModule.stopThemeWatcher();
		const dark = await themeModule.getThemeByName("dark");
		if (dark) themeModule.setThemeInstance(dark);
		vi.restoreAllMocks();
	});

	it("swaps a presented warning from dark-catppuccin to light-catppuccin color", async () => {
		// Auto-theme resolves dark before the appearance reply arrives.
		themeModule.onTerminalAppearanceChange("dark");
		await themeModule.initTheme(false, undefined, undefined, "dark-catppuccin", "light-catppuccin");
		expect(themeModule.getCurrentThemeName()).toBe("dark-catppuccin");

		const darkPrefix = fgPrefix("warning");
		const warning = new Text("Warning: Failed to load extension", 1, 0).setStyleFn(t =>
			themeModule.theme.fg("warning", t),
		);
		expect(warning.render(80).join("")).toContain(darkPrefix);

		// The OSC 11 reply arrives → auto-theme switches to light-catppuccin.
		const switched = Promise.withResolvers<void>();
		const off = themeModule.onThemeChange(() => switched.resolve());
		themeModule.onTerminalAppearanceChange("light");
		await switched.promise;
		off();
		expect(themeModule.getCurrentThemeName()).toBe("light-catppuccin");

		const lightPrefix = fgPrefix("warning");
		expect(lightPrefix).not.toBe(darkPrefix);

		// The onThemeChange handler invalidates + repaints; the warning must now
		// render the light-mode color, not the baked dark one.
		warning.invalidate();
		const out = warning.render(80).join("");
		expect(out).toContain(lightPrefix);
		expect(out).not.toContain(darkPrefix);
	});
	it("recolors the presented update notification when auto-theme resolves light", async () => {
		themeModule.onTerminalAppearanceChange("dark");
		await themeModule.initTheme(false, undefined, undefined, "dark-catppuccin", "light-catppuccin");

		let presented: Component | undefined;
		const context: Pick<InteractiveModeContext, "present"> = {
			present(component) {
				if (!isSingleComponent(component)) throw new Error("Expected one update notification block");
				presented = component;
			},
		};
		new UiHelpers(context as InteractiveModeContext).showNewVersionNotification("1.2.3");
		const notification = presented;
		if (!notification) throw new Error("Update notification was not presented");

		const darkPrefixes = {
			warning: fgPrefix("warning"),
			muted: fgPrefix("muted"),
			accent: fgPrefix("accent"),
		};
		const darkOutput = notification.render(100).join("\n");
		expect(darkOutput).toContain(darkPrefixes.warning);
		expect(darkOutput).toContain(darkPrefixes.muted);
		expect(darkOutput).toContain(darkPrefixes.accent);

		const switched = Promise.withResolvers<void>();
		const off = themeModule.onThemeChange(() => switched.resolve());
		try {
			themeModule.onTerminalAppearanceChange("light");
			await switched.promise;
		} finally {
			off();
		}

		const lightPrefixes = {
			warning: fgPrefix("warning"),
			muted: fgPrefix("muted"),
			accent: fgPrefix("accent"),
		};
		expect(lightPrefixes.warning).not.toBe(darkPrefixes.warning);
		expect(lightPrefixes.muted).not.toBe(darkPrefixes.muted);
		expect(lightPrefixes.accent).not.toBe(darkPrefixes.accent);

		notification.invalidate?.();
		const lightOutput = notification.render(100).join("\n");
		for (const prefix of Object.values(lightPrefixes)) expect(lightOutput).toContain(prefix);
		for (const prefix of Object.values(darkPrefixes)) expect(lightOutput).not.toContain(prefix);

		const semanticLines = Bun.stripANSI(lightOutput)
			.split("\n")
			.map(line => line.trim())
			.filter(line => line === "Update Available" || line.startsWith("New version "));
		expect(semanticLines).toEqual(["Update Available", "New version 1.2.3 is available. Run: omp update"]);
	});
});
