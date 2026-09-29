import * as fs from "node:fs";
import * as path from "node:path";
import { adjustHsv } from "@oh-my-pi/pi-utils/color";
import { getCustomThemesDir } from "@oh-my-pi/pi-utils/dirs";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import { detectColorMode, resolveThemeColors } from "./color";
import darkThemeJson from "./dark.json" with { type: "json" };
import { defaultThemes } from "./defaults";
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

/**
 * Theme files contributed at runtime by extensions (`resources_discover` `themePaths`),
 * one name → absolute `.json` path map per owner (a live top-level session). Owners keep
 * their first-registration order; a name two owners contribute resolves to the earlier owner.
 */
const extensionThemeOwners = new Map<object, ReadonlyMap<string, string>>();

/** Effective extension themes across every live owner. They rank below built-in and custom-directory themes. */
let extensionThemeFiles: ReadonlyMap<string, string> = new Map();

/** Source of each theme whose last load came from an extension-contributed file. */
const loadedExtensionThemes = new Map<string, { path: string; content: string }>();

/**
 * Replace `owner`'s extension-contributed theme files (name → absolute `.json` path).
 * Other owners' contributions are untouched. The first entry for a name wins; an empty
 * list unregisters the owner.
 */
export function setExtensionThemeFiles(owner: object, themes: Iterable<{ name: string; path: string }>): void {
	const files = new Map<string, string>();
	for (const { name, path: filePath } of themes) {
		if (!files.has(name)) files.set(name, filePath);
	}
	if (files.size === 0) extensionThemeOwners.delete(owner);
	else extensionThemeOwners.set(owner, files);

	const effective = new Map<string, string>();
	for (const ownerFiles of extensionThemeOwners.values()) {
		for (const [name, filePath] of ownerFiles) {
			if (!effective.has(name)) effective.set(name, filePath);
		}
	}
	extensionThemeFiles = effective;
}

/** Extension-contributed theme files currently registered across all owners, keyed by theme name. */
export function getExtensionThemeFiles(): ReadonlyMap<string, string> {
	return extensionThemeFiles;
}

/**
 * Whether theme `name` was last loaded from an extension-contributed file and the file now
 * registered for it is a different path or has different contents. False for built-in and
 * custom-directory themes, for dropped contributions, and for unreadable files.
 */
export async function isExtensionThemeStale(name: string): Promise<boolean> {
	const loaded = loadedExtensionThemes.get(name);
	const registeredPath = extensionThemeFiles.get(name);
	if (!loaded || registeredPath === undefined) return false;
	if (registeredPath !== loaded.path) return true;
	try {
		return (await Bun.file(registeredPath).text()) !== loaded.content;
	} catch {
		return false;
	}
}

function parseExtensionThemeJson(name: string, filePath: string, content: string): ThemeJson {
	const parsed = parseThemeJson(name, content);
	loadedExtensionThemes.set(name, { path: filePath, content });
	return parsed;
}

/** Parse and validate a theme file without registering it; throws the error theme loading would report. */
export async function readThemeFile(name: string, filePath: string): Promise<ThemeJson> {
	return parseThemeJson(name, await Bun.file(filePath).text());
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
	for (const name of extensionThemeFiles.keys()) themes.add(name);
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

	// Extension-contributed themes never shadow built-in or custom-directory names.
	for (const [name, filePath] of extensionThemeFiles) {
		if (!result.some(themeInfo => themeInfo.name === name)) {
			result.push({ name, path: filePath });
		}
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
		const parsed = parseThemeJson(name, await Bun.file(themePath).text());
		loadedExtensionThemes.delete(name);
		return parsed;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	const extensionThemePath = extensionThemeFiles.get(name);
	try {
		if (extensionThemePath) {
			return parseExtensionThemeJson(name, extensionThemePath, await Bun.file(extensionThemePath).text());
		}
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	throw new Error(`Theme not found: ${name}`);
}

/** Load a theme definition synchronously for the first terminal frame. */
export function loadThemeJsonSync(name: string): ThemeJson {
	const builtinThemes = getBuiltinThemes();
	if (name in builtinThemes) {
		return builtinThemes[name];
	}
	const themePath = path.join(getCustomThemesDir(), `${name}.json`);
	try {
		const parsed = parseThemeJson(name, fs.readFileSync(themePath, "utf8"));
		loadedExtensionThemes.delete(name);
		return parsed;
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	const extensionThemePath = extensionThemeFiles.get(name);
	try {
		if (extensionThemePath) {
			return parseExtensionThemeJson(name, extensionThemePath, fs.readFileSync(extensionThemePath, "utf8"));
		}
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	throw new Error(`Theme not found: ${name}`);
}

export interface CreateThemeOptions {
	mode?: ColorMode;
	symbolPresetOverride?: SymbolPreset;
	colorBlindMode?: boolean;
}

/** HSV adjustment to shift green toward blue for colorblind mode (red-green colorblindness) */
const COLORBLIND_ADJUSTMENT = { h: 60, s: 0.71 };

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
	return new Theme(fgColors, bgColors, colorMode, symbolPreset, symbolOverrides, spinnerFramesOverrides);
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
