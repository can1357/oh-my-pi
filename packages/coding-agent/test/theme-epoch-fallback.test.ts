import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
	getThemeByName,
	getThemeEpoch,
	setTheme,
	setThemeInstance,
	type Theme,
} from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

/**
 * Contract: every change to the *active* theme bumps the theme epoch — including
 * setTheme()'s fallback path. ToolExecutionComponent (and other memoized
 * renderers) fold getThemeEpoch() into their dirty key, so a failed theme load
 * that swapped to the dark fallback without bumping the epoch would leave those
 * renderers holding the failed theme's stale colors until some other state moved.
 */
describe("theme epoch — setTheme fallback", () => {
	let dark: Theme;

	beforeAll(async () => {
		const t = await getThemeByName("dark");
		if (!t) throw new Error("Expected dark theme to exist");
		dark = t;
	});

	afterEach(() => {
		// Leave a deterministic active theme for any later case in this process.
		setThemeInstance(dark);
	});

	it("bumps the epoch when an invalid theme name falls back to dark", async () => {
		setThemeInstance(dark);
		const before = getThemeEpoch();

		const result = await setTheme("__definitely_not_a_real_theme__");

		// Invalid theme → load throws → dark fallback applied.
		expect(result.success).toBe(false);
		// The active theme changed, so the epoch must advance for memoized renderers.
		expect(getThemeEpoch()).toBeGreaterThan(before);
	});
});
