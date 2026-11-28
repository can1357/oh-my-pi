import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	applyTerminalCapabilities,
	enableAutoTheme,
	endThemePreview,
	getAvailableThemesWithPaths,
	getCurrentThemeName,
	getResolvedThemeColors,
	initTheme,
	isAutoTheme,
	isLightTheme,
	onThemeChange,
	previewTheme,
	setColorBlindMode,
	setSymbolPreset,
	setTerminalAppearance,
	setTheme,
	setThemeSlot,
	stopThemeWatcher,
	type ThemeChange,
} from "@oh-my-pi/pi-coding-agent/ui/theme/service";
import { CONSERVATIVE_EMOJI } from "@oh-my-pi/pi-tui/theme/contract";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const DARK_TRUECOLOR = {
	truecolor: true,
	colors: 16_777_216,
	dark: true,
	emoji: CONSERVATIVE_EMOJI,
	styledUnderlines: false,
} as const;

let changes: ThemeChange[];
let unsubscribe: () => void;

beforeEach(() => {
	initTheme({
		dark: "dark",
		light: "light",
		symbolPreset: "unicode",
		colorBlindMode: false,
		capabilities: DARK_TRUECOLOR,
	});
	changes = [];
	unsubscribe = onThemeChange(change => changes.push(change));
});

afterEach(() => {
	unsubscribe();
	stopThemeWatcher();
});

afterAll(() => {
	// Preferences outlive a restart; leave the defaults for later test files.
	initTheme({ dark: "dark", light: "light", symbolPreset: undefined, colorBlindMode: false });
});

describe("theme service", () => {
	it("starts in auto mode on the slot the terminal's appearance picks", () => {
		expect(isAutoTheme()).toBe(true);
		expect(getCurrentThemeName()).toBe("dark");
		expect(currentTheme().dark).toBe(true);
		expect(currentTheme().depth).toBe("truecolor");

		initTheme({
			capabilities: {
				truecolor: false,
				colors: 256,
				dark: false,
				emoji: CONSERVATIVE_EMOJI,
				styledUnderlines: false,
			},
		});
		expect(getCurrentThemeName()).toBe("light");
		expect(currentTheme().dark).toBe(false);
		expect(currentTheme().depth).toBe("256");
	});

	it("follows appearance changes in auto mode as transient repaints", async () => {
		expect(await setTerminalAppearance("light")).toBe(true);
		expect(getCurrentThemeName()).toBe("light");
		expect(changes).toEqual([{ cause: "terminal", ephemeral: true }]);
		// The same appearance again publishes nothing.
		expect(await setTerminalAppearance("light")).toBe(false);
		expect(changes).toHaveLength(1);
	});

	it("re-resolves emoji glyph forms when the terminal's emoji support changes", async () => {
		expect(currentTheme().symbols.symbol("status.success")).toBe("✓");
		expect(await applyTerminalCapabilities({ ...DARK_TRUECOLOR, emoji: { vs16Wide: true, bareFits: true } })).toBe(
			true,
		);
		expect(currentTheme().symbols.symbol("status.success")).toBe("✔");
		expect(currentTheme().symbols.symbol("tool.irc")).toBe("✉\uFE0F");
		expect(changes).toEqual([{ cause: "terminal", ephemeral: true }]);
	});

	it("changes a slot's theme live in auto mode", async () => {
		await setThemeSlot("dark", "titanium");
		expect(getCurrentThemeName()).toBe("titanium");
		expect(currentTheme().name).toBe("titanium");
		expect(changes).toEqual([{ cause: "settings", ephemeral: false }]);
	});

	it("leaves auto mode on an explicit switch until auto is enabled again", async () => {
		expect(await setTheme("light")).toEqual({ success: true });
		expect(isAutoTheme()).toBe(false);
		expect(changes.at(-1)).toEqual({ cause: "switch", ephemeral: false });

		// A dark terminal no longer picks the dark slot.
		await setTerminalAppearance("light");
		await setTerminalAppearance("dark");
		expect(getCurrentThemeName()).toBe("light");

		await enableAutoTheme();
		expect(isAutoTheme()).toBe(true);
		expect(getCurrentThemeName()).toBe("dark");
	});

	it("falls back to the built-in dark theme when a switch fails", async () => {
		const result = await setTheme("no-such-theme-for-tests");
		expect(result.success).toBe(false);
		expect(result.error).toContain("no-such-theme-for-tests");
		expect(getCurrentThemeName()).toBe("dark");
	});

	it("previews without changing the remembered theme and restores it", async () => {
		expect(await previewTheme("light")).toEqual({ success: true });
		expect(currentTheme().name).toBe("light");
		expect(getCurrentThemeName()).toBe("dark");
		expect(changes).toEqual([{ cause: "preview", ephemeral: true }]);

		expect((await previewTheme("no-such-theme-for-tests")).success).toBe(false);
		expect(currentTheme().name).toBe("light");

		await endThemePreview();
		expect(currentTheme().name).toBe("dark");
		expect(changes.at(-1)).toEqual({ cause: "preview", ephemeral: true });
	});

	it("applies the symbol preset and color-blind mode", async () => {
		const added = currentTheme().fgSgr("toolDiffAdded");
		await setSymbolPreset("ascii");
		expect(currentTheme().symbols.preset).toBe("ascii");
		await setColorBlindMode(true);
		expect(currentTheme().fgSgr("toolDiffAdded")).not.toBe(added);
		expect(currentTheme().symbols.preset).toBe("ascii");
	});

	it("remembers preferences that arrive before the service starts", () => {
		stopThemeWatcher();
		void setThemeSlot("dark", "titanium");
		initTheme({ capabilities: DARK_TRUECOLOR });
		expect(getCurrentThemeName()).toBe("titanium");
	});
});

describe("theme queries", () => {
	it("classifies themes by their status-line background", () => {
		expect(isLightTheme("light")).toBe(true);
		expect(isLightTheme("dark")).toBe(false);
		expect(isLightTheme("no-such-theme-for-tests")).toBe(false);
	});

	it("lists built-ins without a file", async () => {
		const themes = await getAvailableThemesWithPaths();
		expect(themes.find(theme => theme.name === "dark")).toEqual({ name: "dark", path: undefined });
		const names = themes.map(theme => theme.name);
		expect(names).toEqual([...names].sort());
	});

	it("resolves export colors to CSS colors", async () => {
		const colors = await getResolvedThemeColors("dark");
		for (const key in colors) expect(colors[key]).toMatch(/^#[0-9a-f]{6}$/i);
		expect(colors.accent).toBe(currentTheme().hex("accent"));
	});
});
