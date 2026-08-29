import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { generateThemeVars } from "@oh-my-pi/pi-coding-agent/export/html";
import { defaultThemes } from "@oh-my-pi/pi-coding-agent/modes/theme/defaults";
import { createTheme, getBuiltinThemes } from "@oh-my-pi/pi-coding-agent/modes/theme/loader";
import {
	getEditorTheme,
	getResolvedThemeColors,
	getThemeByName,
	isLightTheme,
	setThemeInstance,
} from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { getAgentDir, getCustomThemesDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

function createBaseThemes() {
	const builtins = getBuiltinThemes();
	const lightJson = builtins.light;
	const darkJson = builtins.dark;
	if (!lightJson || !darkJson) throw new Error("Base light/dark themes are unavailable");
	return {
		light: createTheme(lightJson, { mode: "truecolor" }),
		dark: createTheme(darkJson, { mode: "truecolor" }),
	};
}

describe("Theme.isLight", () => {
	it("classifies built-in themes by their status-line surface", async () => {
		// porcelain styles a dark chat bubble (userMessageBg) on an otherwise-light
		// theme with a light status line. Session accents render on the status line,
		// so it must read as light — classifying by userMessageBg got this wrong.
		expect((await getThemeByName("porcelain"))?.isLight).toBe(true);
		expect((await getThemeByName("light-catppuccin"))?.isLight).toBe(true);
		expect((await getThemeByName("dark-catppuccin"))?.isLight).toBe(false);
	});

	it("exposes the status-line surface luminance for accent sizing", async () => {
		const light = await getThemeByName("light-catppuccin");
		const dark = await getThemeByName("dark-catppuccin");
		// Light themes hand the real surface luminance to getSessionAccentHex...
		expect(light?.accentSurfaceLuminance).toBeGreaterThan(0.5);
		// ...dark themes pass undefined so accents stay vivid.
		expect(dark?.accentSurfaceLuminance).toBeUndefined();
	});
});

describe("empty foreground contrast", () => {
	it("preserves terminal-default foregrounds for unpainted empty tokens", () => {
		const { light, dark } = createBaseThemes();

		expect(light.getFgAnsi("text")).toBe("\x1b[39m");
		expect(light.getFgAnsi("userMessageText")).toBe("\x1b[39m");
		expect(dark.getFgAnsi("text")).toBe("\x1b[39m");
	});

	it("chooses empty-token contrast from the controlled background", () => {
		const { light } = createBaseThemes();
		const porcelain = createTheme(defaultThemes.porcelain, { mode: "truecolor" });

		expect(light.getFgOnBgAnsi("userMessageText", "userMessageBg")).toBe("\x1b[38;2;0;0;0m");
		expect(porcelain.getFgOnBgAnsi("userMessageText", "userMessageBg")).toBe("\x1b[38;2;229;229;231m");
	});

	it("preserves terminal defaults when the message background is also default", () => {
		const { dark } = createBaseThemes();
		const darkJson = getBuiltinThemes().dark;
		if (!darkJson) throw new Error("Base dark theme is unavailable");
		const terminalDefault = createTheme(
			{
				...darkJson,
				colors: { ...darkJson.colors, userMessageBg: "", userMessageText: "" },
			},
			{ mode: "truecolor" },
		);
		try {
			setThemeInstance(terminalDefault);
			const surfaceColor = getEditorTheme().surfaceColor;
			if (!surfaceColor) throw new Error("Editor surface color is unavailable");

			expect(surfaceColor("typed")).toBe("\x1b[49m\x1b[39mtyped\x1b[39m\x1b[49m");
		} finally {
			setThemeInstance(dark);
		}
	});

	it("pairs the editor surface with its user-message foreground", () => {
		const { light, dark } = createBaseThemes();
		try {
			setThemeInstance(light);
			const surfaceColor = getEditorTheme().surfaceColor;
			if (!surfaceColor) throw new Error("Editor surface color is unavailable");

			expect(surfaceColor("typed")).toContain("\x1b[48;2;232;232;232m\x1b[38;2;0;0;0mtyped");
		} finally {
			setThemeInstance(dark);
		}
	});

	it("reapplies the editor surface foreground after nested decorator resets", () => {
		const { light, dark } = createBaseThemes();
		try {
			setThemeInstance(light);
			const surfaceColor = getEditorTheme().surfaceColor;
			if (!surfaceColor) throw new Error("Editor surface color is unavailable");

			const styled = surfaceColor("before\x1b[39mafter-default\x1b[0mafter-full");
			expect(styled).toContain("\x1b[39m\x1b[38;2;0;0;0mafter-default");
			expect(styled).toContain("\x1b[0m\x1b[48;2;232;232;232m\x1b[38;2;0;0;0mafter-full");
		} finally {
			setThemeInstance(dark);
		}
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

		const { export: _ignoredExport, ...themeWithoutExport } = defaultThemes.porcelain;
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
