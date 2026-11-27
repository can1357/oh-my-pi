/**
 * The app's theme service: one pi-tui {@link ThemeController} that publishes
 * the active theme to `currentTheme()`.
 *
 * - Settings drive it: the dark/light theme slots, the symbol preset and
 *   color-blind mode (the `effect(...)` registrations in `modes/settings.ts`
 *   call {@link setThemeSlot}, {@link setSymbolPreset}, {@link setColorBlindMode}).
 *   Values that arrive before {@link initTheme} are remembered and used by it.
 * - The terminal drives auto mode and color depth: {@link followTerminal}
 *   feeds driver capabilities (appearance, color support) to the controller.
 *   Before a driver runs, the environment's capabilities stand in.
 * - Explicit switches ({@link setTheme}) leave auto mode until
 *   {@link enableAutoTheme}; the theme picker previews with
 *   {@link previewTheme} and ends the preview with {@link endThemePreview}.
 * - With `watch`, the active custom theme file reloads when it changes.
 *
 * Non-reactive callers (CLI output, commands) read `currentTheme()` at use
 * time; reactive UI reads it inside painters and components, which repaint on
 * every switch. {@link onThemeChange} tells the shell whether a switch was
 * transient (preview, terminal appearance) or should also redraw history.
 */
import * as path from "node:path";
import { getCustomThemesDir } from "@oh-my-pi/pi-utils/dirs";
import { capabilitiesFromEnv, isWsl } from "@oh-my-pi/pi-tui/driver/caps/env";
import { detectTerminalId } from "@oh-my-pi/pi-tui/driver/caps/identity";
import type { TerminalCapabilities, TerminalDriver } from "@oh-my-pi/pi-tui/driver/contract";
import { colorHex, isLightColor, paletteHex } from "@oh-my-pi/pi-tui/theme/color";
import { builtinThemes, listThemes, loadTheme, loadThemeJson, loadThemeJsonSync } from "@oh-my-pi/pi-tui/theme/loader";
import { untrack } from "@oh-my-pi/pi-tui/reactive";
import {
	currentTheme,
	setCurrentTheme,
	type ThemeChangeCause,
	ThemeController,
	type ThemeResult,
} from "@oh-my-pi/pi-tui/theme/runtime";
import type { ColorValue, SymbolPreset, ThemeJson } from "@oh-my-pi/pi-tui/theme/schema";
import { type ResolvedTheme, resolveColorValue } from "@oh-my-pi/pi-tui/theme/theme";

/** Capabilities the theme follows: color support and the background's appearance. */
export type ThemeCapabilities = Pick<TerminalCapabilities, "truecolor" | "colors" | "dark">;

/** Theme preferences (the `theme.dark`, `theme.light`, `symbolPreset` and `colorBlindMode` settings). */
export interface ThemePreferences {
	/** Theme for dark terminals in auto mode (default `dark`). */
	readonly dark?: string;
	/** Theme for light terminals in auto mode (default `light`). */
	readonly light?: string;
	readonly symbolPreset?: SymbolPreset;
	readonly colorBlindMode?: boolean;
}

/** How {@link initTheme} starts the service. */
export interface ThemeInitOptions extends ThemePreferences {
	/** Reload the active custom theme file when it changes on disk. */
	readonly watch?: boolean;
	/** The terminal to follow until {@link followTerminal} attaches a driver (default: the environment's). */
	readonly capabilities?: ThemeCapabilities;
	/**
	 * The background's appearance until a terminal reports it, in place of the environment's guess
	 * (the startup frame passes what the terminal reported last launch).
	 */
	readonly appearance?: "dark" | "light";
}

/** A published theme switch. */
export interface ThemeChange {
	readonly cause: ThemeChangeCause;
	/**
	 * A transient repaint (preview or its end, terminal appearance or depth):
	 * the live UI repaints, history already written stays as it is. Other
	 * switches also redraw history so scrolled-back output matches.
	 */
	readonly ephemeral: boolean;
}

/** A theme the user can pick: built-ins have no file. */
export interface ThemeInfo {
	readonly name: string;
	readonly path: string | undefined;
}

/** Colors an HTML export pins explicitly (the theme file's `export` section). */
export interface ThemeExportColors {
	readonly pageBg?: string;
	readonly cardBg?: string;
	readonly infoBg?: string;
}

const listeners = new Set<(change: ThemeChange) => void>();
let preferences: ThemePreferences = {};
let controller: ThemeController | undefined;
/** What the theme last followed: the driver's capabilities, else the environment's. */
let followed: ThemeCapabilities | undefined;

function publish(theme: ResolvedTheme, cause: ThemeChangeCause): void {
	setCurrentTheme(theme);
	const change: ThemeChange = { cause, ephemeral: cause === "preview" || cause === "terminal" };
	for (const listener of listeners) listener(change);
}

/** Capabilities the environment implies (before, or without, a terminal driver). */
function environmentCapabilities(): ThemeCapabilities {
	const env = Bun.env;
	return capabilitiesFromEnv(env, {
		id: detectTerminalId(env),
		platform: process.platform,
		wsl: isWsl(env, process.platform),
		tmuxPassthrough: false,
	});
}

/**
 * Start (or restart) the service: auto mode, the slot the terminal's
 * appearance picks, loaded synchronously so the first paint already has it.
 * An unloadable theme falls back to the built-in `dark`.
 */
export function initTheme(options: ThemeInitOptions = {}): void {
	const { watch, capabilities, appearance, ...given } = options;
	preferences = { ...preferences, ...given };
	followed = capabilities ?? environmentCapabilities();
	if (appearance) followed = { ...followed, dark: appearance === "dark" };
	controller?.dispose();
	controller = new ThemeController(preferences, publish);
	controller.initSync(followed);
	if (watch) controller.watch();
}

/** Start the service with defaults unless it already runs. */
export function ensureTheme(): void {
	if (!controller) initTheme();
}

/** Name of the active theme (the remembered one while a preview shows). */
export function getCurrentThemeName(): string | undefined {
	return controller?.name;
}

/** The preferences in effect (settings values and session overrides such as the Glyph Protocol `nerd` upgrade). */
export function getThemePreferences(): ThemePreferences {
	return preferences;
}

/** The background's appearance the theme follows: the terminal's report, else the startup guess. */
export function getTerminalAppearance(): "dark" | "light" | undefined {
	if (!followed) return undefined;
	return followed.dark ? "dark" : "light";
}

/** Whether the terminal's appearance picks the theme. */
export function isAutoTheme(): boolean {
	return controller?.auto ?? true;
}

/**
 * Follow a terminal driver: its color depth and, in auto mode, its
 * appearance. Returns a function that stops following.
 */
export function followTerminal(driver: Pick<TerminalDriver, "capabilities" | "onCapabilities">): () => void {
	void applyTerminalCapabilities(driver.capabilities);
	return driver.onCapabilities(capabilities => {
		void applyTerminalCapabilities(capabilities);
	});
}

/**
 * Follow capabilities reported outside a driver (embedders, tests). Resolves
 * true when they changed the theme (depth, or the auto slot).
 */
export async function applyTerminalCapabilities(capabilities: ThemeCapabilities): Promise<boolean> {
	ensureTheme();
	followed = capabilities;
	const before = untrack(currentTheme);
	await controller!.applyCapabilities(capabilities);
	return untrack(currentTheme) !== before;
}

/** The terminal reported its background as dark or light (color support unchanged). */
export async function setTerminalAppearance(appearance: "dark" | "light"): Promise<boolean> {
	ensureTheme();
	return await applyTerminalCapabilities({ ...followed!, dark: appearance === "dark" });
}

/** Switch to `name` and leave auto mode. On failure the built-in `dark` theme is applied. */
export async function setTheme(name: string): Promise<ThemeResult> {
	ensureTheme();
	return await controller!.setTheme(name);
}

/** Show `name` without changing the remembered theme or the mode; a failure keeps the current theme. */
export async function previewTheme(name: string): Promise<ThemeResult> {
	ensureTheme();
	return await controller!.preview(name);
}

/** End a preview: re-apply the remembered theme. */
export async function endThemePreview(): Promise<void> {
	await controller?.restore();
}

/** Return to auto mode: the terminal's appearance picks the dark or light slot. */
export async function enableAutoTheme(): Promise<void> {
	ensureTheme();
	await controller!.enableAuto();
}

/** Theme of the dark or light slot (`theme.dark` / `theme.light`). */
export async function setThemeSlot(appearance: "dark" | "light", name: string): Promise<void> {
	preferences = { ...preferences, [appearance]: name };
	await controller?.setSlot(appearance, name);
}

/** Symbol preset override (`symbolPreset`); unset uses the theme file's preset. */
export async function setSymbolPreset(preset: SymbolPreset | undefined): Promise<void> {
	preferences = { ...preferences, symbolPreset: preset };
	await controller?.setSymbolPreset(preset);
}

/** Color-blind mode (`colorBlindMode`): diff additions shift from green toward blue. */
export async function setColorBlindMode(enabled: boolean): Promise<void> {
	preferences = { ...preferences, colorBlindMode: enabled };
	await controller?.setColorBlindMode(enabled);
}

/** Listen to published theme switches; returns the unsubscribe. */
export function onThemeChange(listener: (change: ThemeChange) => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Stop watching theme files (shutdown). The active theme stays. */
export function stopThemeWatcher(): void {
	controller?.dispose();
}

/** Every theme with the file it loads from (built-ins first on a name collision), sorted by name. */
export async function getAvailableThemesWithPaths(): Promise<ThemeInfo[]> {
	const builtins = builtinThemes();
	const dir = getCustomThemesDir();
	return (await listThemes()).map(name => ({
		name,
		path: Object.hasOwn(builtins, name) ? undefined : path.join(dir, `${name}.json`),
	}));
}

/** The theme named `name` resolved with the current depth and preferences, or undefined when it cannot load. */
export async function getThemeByName(name: string): Promise<ResolvedTheme | undefined> {
	try {
		return await loadTheme(name, controller?.options);
	} catch {
		return undefined;
	}
}

function statusLineIsLight(json: ThemeJson): boolean {
	try {
		const value = json.colors.statusLineBg;
		return value !== undefined && isLightColor(resolveColorValue(value, json.vars ?? {}));
	} catch {
		return false;
	}
}

/**
 * Whether theme `name` (default `dark`) is light, judged by its status-line
 * background. Synchronous for settings migration and setup; false when the
 * theme cannot load.
 */
export function isLightTheme(name = "dark"): boolean {
	try {
		return statusLineIsLight(loadThemeJsonSync(name));
	} catch {
		return false;
	}
}

/** The theme an export defaults to: the active theme, else the dark slot. */
function exportThemeName(name: string | undefined): string {
	return name ?? controller?.name ?? preferences.dark ?? "dark";
}

function hexOf(value: ColorValue): string {
	return typeof value === "number" ? paletteHex(value) : value;
}

function exportColorsOf(json: ThemeJson): ThemeExportColors {
	const section = json.export;
	if (!section) return {};
	const vars = json.vars ?? {};
	const resolve = (value: ColorValue | undefined): string | undefined => {
		if (value === undefined) return undefined;
		// Export sections may spell variables `$name`.
		const reference = typeof value === "string" && value.startsWith("$") ? value.slice(1) : value;
		try {
			return hexOf(resolveColorValue(reference, vars));
		} catch {
			return typeof value === "string" ? value : hexOf(value);
		}
	};
	return { pageBg: resolve(section.pageBg), cardBg: resolve(section.cardBg), infoBg: resolve(section.infoBg) };
}

/**
 * Every color of theme `name` (default: the active one) as a CSS color, for
 * HTML export. Terminal-default foregrounds become black or near-white by the
 * export surface (the `export` card or page color, else `userMessageBg`).
 */
export async function getResolvedThemeColors(name?: string): Promise<Record<string, string>> {
	const json = await loadThemeJson(exportThemeName(name));
	const vars = json.vars ?? {};
	const resolved: Record<string, ColorValue> = {};
	const colors: Readonly<Record<string, ColorValue | undefined>> = json.colors;
	for (const key in colors) {
		const value = colors[key];
		if (value !== undefined) resolved[key] = resolveColorValue(value, vars);
	}
	const exported = exportColorsOf(json);
	const light = isLightColor(exported.cardBg ?? exported.pageBg ?? resolved.userMessageBg);
	const css: Record<string, string> = {};
	for (const key in resolved) css[key] = colorHex(resolved[key]!, light);
	return css;
}

/** The colors theme `name` (default: the active one) pins for HTML export; empty when it cannot load. */
export async function getThemeExportColors(name?: string): Promise<ThemeExportColors> {
	try {
		return exportColorsOf(await loadThemeJson(exportThemeName(name)));
	} catch {
		return {};
	}
}
