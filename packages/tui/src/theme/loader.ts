/**
 * Theme lookup: the built-in palettes, then `<customThemesDir>/<name>.json`.
 * Built-ins win on a name collision.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { getCustomThemesDir } from "@oh-my-pi/pi-utils/dirs";
import { isEnoent } from "@oh-my-pi/pi-utils/fs-error";
import DARK from "./data/dark.json" with { type: "json" };
import DEFAULTS from "./data/defaults.json" with { type: "json" };
import LIGHT from "./data/light.json" with { type: "json" };
import { type ThemeJson, validateThemeJson } from "./schema";
import { createTheme, type ResolvedTheme, type ThemeOptions } from "./theme";

const BUILTIN_THEMES: Readonly<Record<string, ThemeJson>> = {
	dark: DARK as ThemeJson,
	light: LIGHT as ThemeJson,
	...(DEFAULTS as Record<string, ThemeJson>),
};

/** Built-in theme files by name. */
export function builtinThemes(): Readonly<Record<string, ThemeJson>> {
	return BUILTIN_THEMES;
}

/**
 * Path a custom theme named `name` is read from. A path separator is refused: it is the only way
 * a name leaves the themes directory, and a `..` segment needs one. The refusal is the unknown-theme
 * error, so the caller falls back as it does for any missing name.
 */
export function customThemePath(name: string): string {
	if (/[\\/]/.test(name)) throw new Error(`Theme not found: ${name}`);
	return path.join(getCustomThemesDir(), `${name}.json`);
}

function parseCustom(name: string, content: string): ThemeJson {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch (error) {
		throw new Error(`Failed to parse theme ${name}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return validateThemeJson(name, parsed);
}

/** The theme file named `name`. Throws `Theme not found: <name>` or a validation error. */
export async function loadThemeJson(name: string): Promise<ThemeJson> {
	const builtin = BUILTIN_THEMES[name];
	if (builtin !== undefined) return builtin;
	let content: string;
	try {
		content = await Bun.file(customThemePath(name)).text();
	} catch (error) {
		if (isEnoent(error)) throw new Error(`Theme not found: ${name}`);
		throw error;
	}
	return parseCustom(name, content);
}

/** {@link loadThemeJson} for the first paint, before the event loop runs. */
export function loadThemeJsonSync(name: string): ThemeJson {
	const builtin = BUILTIN_THEMES[name];
	if (builtin !== undefined) return builtin;
	let content: string;
	try {
		content = fs.readFileSync(customThemePath(name), "utf8");
	} catch (error) {
		if (isEnoent(error)) throw new Error(`Theme not found: ${name}`);
		throw error;
	}
	return parseCustom(name, content);
}

/** Load and resolve the theme named `name`. */
export async function loadTheme(name: string, options?: ThemeOptions): Promise<ResolvedTheme> {
	return createTheme(await loadThemeJson(name), options);
}

/** Load and resolve the theme named `name` synchronously. */
export function loadThemeSync(name: string, options?: ThemeOptions): ResolvedTheme {
	return createTheme(loadThemeJsonSync(name), options);
}

/** Every theme name: built-ins plus custom `*.json` files, sorted. */
export async function listThemes(): Promise<string[]> {
	const names = new Set(Object.keys(BUILTIN_THEMES));
	try {
		for (const entry of await fs.promises.readdir(getCustomThemesDir())) {
			if (entry.endsWith(".json")) names.add(entry.slice(0, -".json".length));
		}
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
	return [...names].sort();
}
