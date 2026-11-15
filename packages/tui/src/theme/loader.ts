import * as fs from "node:fs";
import * as path from "node:path";
import { adjustHsv } from "@oh-my-pi/pi-utils/color";
import { getCustomThemesDir } from "@oh-my-pi/pi-utils/dirs";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { detectColorMode, isLightSurface, mixThemeColors, resolveThemeColors, resolveVarRefs } from "./color";
import darkThemeJson from "./dark.json" with { type: "json" };
import defaultThemes from "./defaults.json" with { type: "json" };
import lightThemeJson from "./light.json" with { type: "json" };
import type { ColorMode, ThemeBg, ThemeColor, ThemeJson } from "./schema";
import { normalizeSpinnerFramesOverride, type SymbolPreset } from "./symbols";
import { Theme } from "./theme-class";

// ============================================================================
// Theme Loading
// ============================================================================

const BUILTIN_THEMES: Record<string, ThemeJson> = {
	dark: darkThemeJson as ThemeJson,
	light: lightThemeJson as ThemeJson,
	...(defaultThemes as Record<string, ThemeJson>),
};

export function getBuiltinThemes(): Record<string, ThemeJson> {
	return BUILTIN_THEMES;
}

export async function getAvailableThemes(): Promise<string[]> {
	const themes = new Set<string>(Object.keys(getBuiltinThemes()));
	const customThemesDir = getCustomThemesDir();
	try {
		const files = await fs.promises.readdir(customThemesDir);
		for (const file of files) {
			if (file.endsWith(".json")) {
				themes.add(file.slice(0, -5));
			}
		}
	} catch {
		// Directory doesn't exist or isn't readable
	}
	return Array.from(themes).sort();
}

export interface ThemeInfo {
	name: string;
	path: string | undefined;
}

export async function getAvailableThemesWithPaths(): Promise<ThemeInfo[]> {
	const result: ThemeInfo[] = [];

	// Built-in themes (embedded, no file path)
	for (const name of Object.keys(getBuiltinThemes())) {
		result.push({ name, path: undefined });
	}

	// Custom themes
	const customThemesDir = getCustomThemesDir();
	try {
		const files = await fs.promises.readdir(customThemesDir);
		for (const file of files) {
			if (file.endsWith(".json")) {
				const name = file.slice(0, -5);
				if (!result.some(themeInfo => themeInfo.name === name)) {
					result.push({ name, path: path.join(customThemesDir, file) });
				}
			}
		}
	} catch {
		// Directory doesn't exist or isn't readable
	}

	return result.sort((a, b) => a.name.localeCompare(b.name));
}

function parseThemeJson(name: string, content: string): ThemeJson {
	let json: unknown;
	try {
		json = JSON.parse(content);
	} catch (error) {
		throw new Error(`Failed to parse theme ${name}: ${error}`);
	}
	let parsed: ThemeJson;
	try {
		// Custom-theme-only boundary: built-in first-frame themes do not need to
		// load or construct the omptype validation graph.
		const { validateThemeJson } = require("./schema-validation");
		parsed = validateThemeJson(json);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		// Extract color key information if available
		const missingColorMatch = errorMessage.match(/missing keys: (.+)/i);
		const missingColors: string[] = missingColorMatch ? missingColorMatch[1].split(",").map(s => s.trim()) : [];

		let fullErrorMessage = `Invalid theme "${name}":\n`;
		if (missingColors.length > 0) {
			fullErrorMessage += `\nMissing required color tokens:\n`;
			fullErrorMessage += missingColors.map(c => `  - ${c}`).join("\n");
			fullErrorMessage += `\n\nPlease add these colors to your theme's "colors" object.`;
			fullErrorMessage += `\nSee the built-in themes (dark.json, light.json) for reference values.`;
		}
		fullErrorMessage += `\n\nValidation error:\n  - ${errorMessage}`;

		throw new Error(fullErrorMessage);
	}
	return parsed;
}

export async function loadThemeJson(name: string): Promise<ThemeJson> {
	const builtinThemes = getBuiltinThemes();
	if (name in builtinThemes) {
		return builtinThemes[name];
	}
	const customThemesDir = getCustomThemesDir();
	const themePath = path.join(customThemesDir, `${name}.json`);
	try {
		return parseThemeJson(name, await Bun.file(themePath).text());
	} catch (error) {
		if (isEnoent(error)) throw new Error(`Theme not found: ${name}`);
		throw error;
	}
}

/** Load a theme definition synchronously for the first terminal frame. */
export function loadThemeJsonSync(name: string): ThemeJson {
	const builtinThemes = getBuiltinThemes();
	if (name in builtinThemes) {
		return builtinThemes[name];
	}
	const themePath = path.join(getCustomThemesDir(), `${name}.json`);
	try {
		return parseThemeJson(name, fs.readFileSync(themePath, "utf8"));
	} catch (error) {
		if (isEnoent(error)) throw new Error(`Theme not found: ${name}`);
		throw error;
	}
}

export interface CreateThemeOptions {
	mode?: ColorMode;
	symbolPresetOverride?: SymbolPreset;
	colorBlindMode?: boolean;
}

/** HSV adjustment to shift green toward blue for colorblind mode (red-green colorblindness) */
const COLORBLIND_ADJUSTMENT = { h: 60, s: 0.71 };

/** Share of `mdLink` in the derived `mdExtensionLink`; the rest is `text`, which mutes the link hue. */
const EXTENSION_LINK_TINT = 0.45;

/**
 * A blend input as the theme intends it: `""` becomes the theme's
 * `terminal.foreground` and an index 0–15 its `terminal.ansi` slot, when the
 * theme declares them. Otherwise the value stays and {@link mixThemeColors}
 * approximates it.
 */
function intendedColor(
	value: string | number,
	terminalForeground: string | number | undefined,
	ansiPalette: ReadonlyArray<string | number> | undefined,
): string | number {
	const color = value === "" ? (terminalForeground ?? value) : value;
	if (typeof color === "number" && color < 16) return ansiPalette?.[color] ?? color;
	return color;
}

export function createTheme(themeJson: ThemeJson, options: CreateThemeOptions = {}): Theme {
	const { mode, symbolPresetOverride, colorBlindMode } = options;
	const colorMode = mode ?? detectColorMode();
	const resolvedColors = resolveThemeColors(themeJson.colors, themeJson.vars);

	if (colorBlindMode) {
		const added = resolvedColors.toolDiffAdded;
		if (typeof added === "string" && added.startsWith("#")) {
			resolvedColors.toolDiffAdded = adjustHsv(added, COLORBLIND_ADJUSTMENT);
		}
	}
	const vars = themeJson.vars ?? {};
	const ansiPalette = themeJson.terminal?.ansi?.map(color => resolveVarRefs(color, vars));
	// A theme without `mdExtensionLink` gets a muted link tint, so links an
	// extension handles in place stay distinct from links that open a URL.
	if (resolvedColors.mdExtensionLink === undefined) {
		const foreground = themeJson.terminal?.foreground;
		const terminalForeground = foreground === undefined ? undefined : resolveVarRefs(foreground, vars);
		resolvedColors.mdExtensionLink = mixThemeColors(
			intendedColor(resolvedColors.text, terminalForeground, ansiPalette),
			intendedColor(resolvedColors.mdLink, terminalForeground, ansiPalette),
			EXTENSION_LINK_TINT,
			isLightSurface(resolvedColors.statusLineBg),
		);
	}

	const fgColors: Record<ThemeColor, string | number> = {} as Record<ThemeColor, string | number>;
	const bgColors: Record<ThemeBg, string | number> = {} as Record<ThemeBg, string | number>;
	const bgColorKeys: Set<string> = new Set([
		"selectedBg",
		"userMessageBg",
		"customMessageBg",
		"toolPendingBg",
		"toolSuccessBg",
		"toolErrorBg",
		"statusLineBg",
	]);
	for (const [key, value] of Object.entries(resolvedColors)) {
		if (bgColorKeys.has(key)) {
			bgColors[key as ThemeBg] = value;
		} else {
			fgColors[key as ThemeColor] = value;
		}
	}
	// Extract symbol configuration - settings override takes precedence over theme
	const symbolPreset: SymbolPreset = symbolPresetOverride ?? themeJson.symbols?.preset ?? "unicode";
	const symbolOverrides = themeJson.symbols?.overrides ?? {};
	const spinnerFramesOverrides = normalizeSpinnerFramesOverride(themeJson.symbols?.spinnerFrames);
	return new Theme(fgColors, bgColors, colorMode, symbolPreset, symbolOverrides, spinnerFramesOverrides, ansiPalette);
}

export async function loadTheme(name: string, options: CreateThemeOptions = {}): Promise<Theme> {
	const themeJson = await loadThemeJson(name);
	return createTheme(themeJson, options);
}

/** Load and construct a theme synchronously for latency-sensitive first paint. */
export function loadThemeSync(name: string, options: CreateThemeOptions = {}): Theme {
	return createTheme(loadThemeJsonSync(name), options);
}
export async function getThemeByName(name: string): Promise<Theme | undefined> {
	try {
		return await loadTheme(name);
	} catch {
		return undefined;
	}
}
