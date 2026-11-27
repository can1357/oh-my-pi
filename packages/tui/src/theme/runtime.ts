/**
 * The active theme: a reactive signal painters read (re-painting on every
 * switch), and the controller that picks it from settings, the terminal's
 * appearance and color depth, explicit switches, previews and live reloads
 * of custom theme files.
 */
import * as fs from "node:fs";
import { pollFile } from "@oh-my-pi/pi-natives/file-poll";
import { errorMessage, logger } from "@oh-my-pi/pi-utils";
import type { TerminalCapabilities } from "../driver/contract";
import { type Accessor, signal } from "../reactive";
import { type ColorDepth, depthOf } from "./color";
import { CONSERVATIVE_EMOJI, type EmojiSupport } from "./contract";
import DARK from "./data/dark.json" with { type: "json" };
import { customThemePath, loadTheme, loadThemeSync } from "./loader";
import type { SymbolPreset, ThemeJson } from "./schema";
import { createTheme, type ResolvedTheme, type ThemeOptions } from "./theme";

const active = signal<ResolvedTheme>(createTheme(DARK as ThemeJson));

/** The active theme; reading it inside a computation subscribes to theme switches. */
export const currentTheme: Accessor<ResolvedTheme> = active;

/** Make `theme` the active theme (notifies every reader). */
export function setCurrentTheme(theme: ResolvedTheme): void {
	active.set(theme);
}

/** Terminal capabilities the theme follows: color support, the background's appearance, emoji drawing. */
export type ThemeCapabilities = Pick<TerminalCapabilities, "truecolor" | "colors" | "dark" | "emoji">;

/** Theme settings the controller reads. */
export interface ThemeSettings {
	/** Theme for dark terminals in auto mode (default `dark`). */
	readonly dark?: string;
	/** Theme for light terminals in auto mode (default `light`). */
	readonly light?: string;
	/** Symbol preset override; unset uses the theme file's preset, then unicode. */
	readonly symbolPreset?: SymbolPreset;
	readonly colorBlindMode?: boolean;
}

/**
 * Why the controller published a theme: an explicit switch (`setTheme`, the
 * fallback after a failed one), a preview or its end (`preview`, `restore`),
 * a settings change (auto slots, symbol preset, color-blind mode, back to
 * auto), the terminal (appearance, color depth), or a watched custom theme
 * file changing on disk. Apps use it to tell transient repaints from
 * switches that should also redraw history.
 */
export type ThemeChangeCause = "switch" | "preview" | "settings" | "terminal" | "file";

/** Outcome of a switch or preview. */
export interface ThemeResult {
	readonly success: boolean;
	readonly error?: string;
}

/** Built-in theme a failed explicit switch falls back to. */
const FALLBACK_THEME = "dark";
/** Delay after the last change to a watched theme file before reloading it. */
const RELOAD_DEBOUNCE_MS = 100;
/** Stat-poll interval for the watched custom theme file. */
const POLL_INTERVAL_MS = 500;

/**
 * Chooses and publishes the active theme. In auto mode the terminal's
 * appearance picks the dark or light slot; an explicit {@link setTheme}
 * leaves auto mode until {@link enableAuto}.
 */
export class ThemeController {
	#darkName: string;
	#lightName: string;
	#symbolPreset: SymbolPreset | undefined;
	#colorBlindMode: boolean;
	#depth: ColorDepth = "truecolor";
	#appearance: "dark" | "light" = "dark";
	#emoji: EmojiSupport = CONSERVATIVE_EMOJI;
	#auto = true;
	#name: string;
	#request = 0;
	#stopPoll: (() => void) | undefined;
	#reloadTimer: NodeJS.Timeout | undefined;
	#watching = false;
	readonly #publish: (theme: ResolvedTheme, cause: ThemeChangeCause) => void;

	constructor(
		settings: ThemeSettings = {},
		publish: (theme: ResolvedTheme, cause: ThemeChangeCause) => void = setCurrentTheme,
	) {
		this.#darkName = settings.dark ?? "dark";
		this.#lightName = settings.light ?? "light";
		this.#symbolPreset = settings.symbolPreset;
		this.#colorBlindMode = settings.colorBlindMode ?? false;
		this.#publish = publish;
		this.#name = this.#darkName;
	}

	/** Name of the theme the controller last chose (the fallback's name after a failed switch). */
	get name(): string {
		return this.#name;
	}

	get auto(): boolean {
		return this.#auto;
	}

	get depth(): ColorDepth {
		return this.#depth;
	}

	get appearance(): "dark" | "light" {
		return this.#appearance;
	}

	get options(): ThemeOptions {
		return {
			depth: this.#depth,
			symbolPreset: this.#symbolPreset,
			colorBlindMode: this.#colorBlindMode,
			emoji: this.#emoji,
		};
	}

	#autoName(): string {
		return this.#appearance === "light" ? this.#lightName : this.#darkName;
	}

	/** Load the starting theme synchronously (first paint); falls back to `dark` when it cannot load. */
	initSync(capabilities?: ThemeCapabilities): void {
		if (capabilities) this.#absorb(capabilities);
		const name = this.#auto ? this.#autoName() : this.#name;
		try {
			this.#apply(name, loadThemeSync(name, this.options), "switch");
		} catch (error) {
			logger.debug("Theme loading failed, falling back to dark theme", { name, error: errorMessage(error) });
			this.#apply(FALLBACK_THEME, loadThemeSync(FALLBACK_THEME, this.options), "switch");
		}
	}

	/**
	 * Follow the terminal: depth from its color support, the auto slot from its
	 * appearance, emoji glyph forms from its emoji support. Reloads only when one changed.
	 */
	async applyCapabilities(capabilities: ThemeCapabilities): Promise<void> {
		if (!this.#absorb(capabilities)) return;
		await this.#reload("terminal");
	}

	#absorb(capabilities: ThemeCapabilities): boolean {
		const depth = depthOf(capabilities);
		const appearance = capabilities.dark ? "dark" : "light";
		const { emoji } = capabilities;
		const changed =
			depth !== this.#depth ||
			(this.#auto && appearance !== this.#appearance) ||
			emoji.vs16Wide !== this.#emoji.vs16Wide ||
			emoji.bareFits !== this.#emoji.bareFits;
		this.#depth = depth;
		this.#appearance = appearance;
		this.#emoji = emoji;
		return changed;
	}

	/** Switch to `name` and leave auto mode. On failure the built-in dark theme is applied. */
	async setTheme(name: string): Promise<ThemeResult> {
		this.#auto = false;
		const request = ++this.#request;
		try {
			const theme = await loadTheme(name, this.options);
			if (request !== this.#request) return { success: false, error: "Theme change superseded by a newer request" };
			this.#apply(name, theme, "switch");
			return { success: true };
		} catch (error) {
			if (request !== this.#request) return { success: false, error: "Theme change superseded by a newer request" };
			const fallback = await loadTheme(FALLBACK_THEME, this.options);
			this.#apply(FALLBACK_THEME, fallback, "switch");
			return { success: false, error: errorMessage(error) };
		}
	}

	/** Show `name` without changing the mode or the remembered theme; a failure keeps the current theme. */
	async preview(name: string): Promise<ThemeResult> {
		const request = ++this.#request;
		try {
			const theme = await loadTheme(name, this.options);
			if (request !== this.#request) return { success: false, error: "Theme preview superseded by a newer request" };
			this.#publish(theme, "preview");
			return { success: true };
		} catch (error) {
			return { success: false, error: errorMessage(error) };
		}
	}

	/** Re-apply the remembered theme (ends a preview). */
	async restore(): Promise<void> {
		await this.#reload("preview");
	}

	/** Return to auto mode: the appearance picks the dark or light slot. */
	async enableAuto(): Promise<void> {
		this.#auto = true;
		await this.#reload("settings");
	}

	/** Change the theme of one auto slot; re-evaluates when auto mode is on. */
	async setSlot(appearance: "dark" | "light", name: string): Promise<void> {
		if (appearance === "dark") this.#darkName = name;
		else this.#lightName = name;
		if (this.#auto) await this.#reload("settings");
	}

	async setSymbolPreset(preset: SymbolPreset | undefined): Promise<void> {
		this.#symbolPreset = preset;
		await this.#reload("settings");
	}

	async setColorBlindMode(enabled: boolean): Promise<void> {
		this.#colorBlindMode = enabled;
		await this.#reload("settings");
	}

	/**
	 * Reload the active custom theme file when it changes on disk (debounced).
	 * Built-ins are not watched; a failed reload keeps the last good theme.
	 */
	watch(): void {
		this.#watching = true;
		this.#rewatch();
	}

	/** Stop watching and cancel pending reloads. */
	dispose(): void {
		this.#watching = false;
		this.#unwatch();
	}

	async #reload(cause: ThemeChangeCause): Promise<void> {
		const name = this.#auto ? this.#autoName() : this.#name;
		const request = ++this.#request;
		try {
			const theme = await loadTheme(name, this.options);
			if (request === this.#request) this.#apply(name, theme, cause);
		} catch (error) {
			logger.debug("Theme reload failed", { name, error: errorMessage(error) });
			if (request !== this.#request || !this.#auto) return;
			const fallback = await loadTheme(FALLBACK_THEME, this.options);
			if (request === this.#request) this.#apply(FALLBACK_THEME, fallback, cause);
		}
	}

	#apply(name: string, theme: ResolvedTheme, cause: ThemeChangeCause): void {
		const renamed = name !== this.#name;
		this.#name = name;
		this.#publish(theme, cause);
		if (renamed && this.#watching) this.#rewatch();
	}

	#unwatch(): void {
		this.#stopPoll?.();
		this.#stopPoll = undefined;
		clearTimeout(this.#reloadTimer);
		this.#reloadTimer = undefined;
	}

	#rewatch(): void {
		this.#unwatch();
		const name = this.#name;
		const file = customThemePath(name);
		if (!fs.existsSync(file)) return;
		// A poll, not `fs.watch`: editors that save by renaming a new file over
		// the old one would leave an inode watch on the deleted file.
		this.#stopPoll = pollFile(
			file,
			() => {
				clearTimeout(this.#reloadTimer);
				this.#reloadTimer = setTimeout(() => {
					this.#reloadTimer = undefined;
					void this.#reloadWatched(name);
				}, RELOAD_DEBOUNCE_MS);
			},
			POLL_INTERVAL_MS,
		);
	}

	async #reloadWatched(name: string): Promise<void> {
		if (name !== this.#name) return;
		const request = ++this.#request;
		try {
			const theme = await loadTheme(name, this.options);
			if (request === this.#request && name === this.#name) this.#publish(theme, "file");
		} catch (error) {
			logger.debug("Theme file reload failed; keeping the last good theme", { name, error: errorMessage(error) });
		}
	}
}
