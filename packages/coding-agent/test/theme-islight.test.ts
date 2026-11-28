import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { generateThemeVars } from "@oh-my-pi/pi-coding-agent/export/html";
import { sessionAccentHex } from "@oh-my-pi/pi-coding-agent/ui/status/accent";
import { getResolvedThemeColors, getThemeByName, isLightTheme } from "@oh-my-pi/pi-coding-agent/ui/theme/service";
import { builtinThemes } from "@oh-my-pi/pi-tui/theme/loader";
import { getAgentDir, getCustomThemesDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

describe("theme lightness", () => {
	it("classifies built-in themes by their status-line surface", async () => {
		// porcelain styles a dark chat bubble (userMessageBg) on an otherwise-light
		// theme with a light status line. Session accents render on the status line,
		// so it must read as light — classifying by userMessageBg got this wrong.
		expect((await getThemeByName("porcelain"))?.dark).toBe(false);
		expect((await getThemeByName("light-catppuccin"))?.dark).toBe(false);
		expect((await getThemeByName("dark-catppuccin"))?.dark).toBe(true);
	});

	it("sizes session accents against a light status-line surface", async () => {
		const light = await getThemeByName("light-catppuccin");
		const dark = await getThemeByName("dark-catppuccin");
		if (!light || !dark) throw new Error("Catppuccin themes are unavailable");
		// The same title picks a different accent once the light surface luminance applies.
		expect(sessionAccentHex(light, "session")).not.toBe(sessionAccentHex(dark, "session"));
	});
});

describe("isLightTheme (standalone)", () => {
	// Regression for #2516: the standalone helper used to classify on
	// userMessageBg, mismatching Theme.isLight (statusLineBg). porcelain is the
	// canonical mismatch (dark bubble, light status line); sandstone/limestone
	// exercise the custom-light path.
	it.each([
		["sandstone", true],
		["limestone", true],
		["porcelain", true],
		["light", true],
		["dark", false],
		["dark-catppuccin", false],
	])("classifies %s as isLight=%s", (name, expected) => {
		expect(isLightTheme(name)).toBe(expected);
	});
});

describe("getResolvedThemeColors HTML export defaults", () => {
	// Regression for #2516: empty color tokens fell back to #e5e5e7 (the
	// dark-theme grey) for every theme not literally named "light", making the
	// session transcript text illegible on every custom light theme.
	it("uses near-black for empty text tokens on light themes", async () => {
		const colors = await getResolvedThemeColors("sandstone");
		expect(colors.text).toBe("#000000");
		expect(colors.userMessageText).toBe("#000000");
		expect(colors.customMessageText).toBe("#000000");
		expect(colors.toolTitle).toBe("#000000");
	});

	it("uses light grey for empty text tokens on dark themes", async () => {
		const colors = await getResolvedThemeColors("dark");
		expect(colors.text).toBe("#e5e5e7");
		expect(colors.userMessageText).toBe("#e5e5e7");
	});

	// Regression for #16374: these palettes define `text` but left the slots
	// empty, so composer and message text fell back to the generic grey/black.
	it.each([
		["dark-catppuccin", "#cdd6f4"],
		["light-catppuccin", "#4c4f69"],
		["dark-rose-pine", "#e0def4"],
		["dark-github", "#c9d1d9"],
		["dark-celestial", "#d5d8da"],
	])("uses the %s palette text color", async (name, hex) => {
		const colors = await getResolvedThemeColors(name);
		expect(colors.text.toLowerCase()).toBe(hex);
		expect(colors.userMessageText.toLowerCase()).toBe(hex);
	});
	let tempAgentDir: string | undefined;
	let originalAgentDir = "";
	let originalAgentDirEnv: string | undefined;

	afterEach(async () => {
		if (tempAgentDir === undefined) return;
		setAgentDir(originalAgentDir);
		if (originalAgentDirEnv === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = originalAgentDirEnv;
		}
		await removeWithRetries(tempAgentDir);
		tempAgentDir = undefined;
	});

	it("uses light text when a light-status custom theme derives dark export surfaces from userMessageBg", async () => {
		originalAgentDir = getAgentDir();
		originalAgentDirEnv = process.env.PI_CODING_AGENT_DIR;
		tempAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-theme-export-"));
		setAgentDir(tempAgentDir);

		const { export: _ignoredExport, ...themeWithoutExport } = builtinThemes().porcelain;
		const customThemeName = "light-status-dark-export-derived";
		await Bun.write(
			path.join(getCustomThemesDir(), `${customThemeName}.json`),
			JSON.stringify({ ...themeWithoutExport, name: customThemeName }),
		);

		const vars = await generateThemeVars(customThemeName);
		expect(vars).toContain("--body-bg: rgb(56, 78, 112);");
		expect(vars).toContain("--container-bg: rgb(68, 95, 136);");
		expect(vars).toContain("--text: #e5e5e7;");
		expect(vars).toContain("--userMessageText: #e5e5e7;");
	});
});
