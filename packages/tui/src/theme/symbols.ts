/**
 * Symbol presets: the glyph tables (`data/symbols.json`) and the
 * `SymbolSet` a theme hands painters.
 */
// The logger subpath, not the `@oh-my-pi/pi-utils` barrel (which loads the native addon):
// key-hint formatting reads these tables on addon-free CLI paths (`omp --help`).
import * as logger from "@oh-my-pi/pi-utils/logger";
import type { BoxGlyphs, SymbolSet } from "./contract";
import SYMBOL_DATA from "./data/symbols.json" with { type: "json" };
import type { SpinnerFramesOverride, SymbolPreset } from "./schema";

/** Glyph of every symbol key, per preset. */
export type SymbolTable = Readonly<Record<string, string>>;

const PRESETS: Readonly<Record<SymbolPreset, SymbolTable>> = SYMBOL_DATA.presets;
const SPINNERS: Readonly<
	Record<SymbolPreset, { readonly status: readonly string[]; readonly activity: readonly string[] }>
> = SYMBOL_DATA.spinners;
/** Language / file-type name → `lang.*` key suffix. */
const LANGUAGES: Readonly<Record<string, string>> = SYMBOL_DATA.languages;
/** Slash-command icon names that reuse an `icon.*` glyph. */
const COMMAND_ICONS: Readonly<Record<string, string>> = SYMBOL_DATA.commandIcons;
/** Brand color of a language icon, by `lang.*` suffix. */
export const LANGUAGE_BRAND_COLORS: Readonly<Record<string, string>> = SYMBOL_DATA.languageBrandColors;

/** The `lang.*` key suffix of a language or file-type name, if known. */
export function languageKey(lang: string | undefined): string | undefined {
	return lang ? LANGUAGES[lang.toLowerCase()] : undefined;
}

/** The glyph table of a preset (no theme overrides). */
export function presetSymbols(preset: SymbolPreset): SymbolTable {
	return PRESETS[preset];
}

/** Options a theme file gives its symbols. */
export interface SymbolOptions {
	readonly preset: SymbolPreset;
	readonly overrides?: Readonly<Record<string, string>>;
	readonly spinnerFrames?: SpinnerFramesOverride;
}

function boxOf(table: SymbolTable, corners: "boxRound" | "boxSharp"): BoxGlyphs {
	return {
		topLeft: table[`${corners}.topLeft`]!,
		topRight: table[`${corners}.topRight`]!,
		bottomLeft: table[`${corners}.bottomLeft`]!,
		bottomRight: table[`${corners}.bottomRight`]!,
		horizontal: table[`${corners}.horizontal`]!,
		vertical: table[`${corners}.vertical`]!,
		// Junctions have no rounded form: every box takes them from `boxSharp.*`.
		teeDown: table["boxSharp.teeDown"]!,
		teeUp: table["boxSharp.teeUp"]!,
		teeLeft: table["boxSharp.teeLeft"]!,
		teeRight: table["boxSharp.teeRight"]!,
		cross: table["boxSharp.cross"]!,
	};
}

/** A preset's glyphs with a theme's overrides applied. */
export class ThemeSymbols implements SymbolSet {
	readonly preset: SymbolPreset;
	readonly box: BoxGlyphs;
	readonly sharp: BoxGlyphs;
	readonly spinnerFrames: readonly string[];
	readonly activityFrames: readonly string[];
	readonly ellipsis = "…";
	readonly #table: SymbolTable;

	constructor(options: SymbolOptions) {
		this.preset = options.preset;
		const base = PRESETS[options.preset];
		const table: Record<string, string> = { ...base };
		const overrides = options.overrides ?? {};
		for (const key in overrides) {
			if (key in base) table[key] = overrides[key]!;
			else logger.debug("Invalid symbol key in override", { key });
		}
		// `status.done` aliases `status.success` unless a theme overrides it.
		if (!("status.done" in overrides)) table["status.done"] = table["status.success"]!;
		this.#table = table;
		this.box = boxOf(table, "boxRound");
		this.sharp = boxOf(table, "boxSharp");
		const frames = options.spinnerFrames;
		const spinners = SPINNERS[options.preset];
		if (Array.isArray(frames)) {
			this.spinnerFrames = frames;
			this.activityFrames = frames;
		} else {
			this.spinnerFrames = frames?.status ?? spinners.status;
			this.activityFrames = frames?.activity ?? spinners.activity;
		}
	}

	symbol(key: string): string {
		return this.#table[key] ?? "";
	}

	icon(name: string): string {
		const table = this.#table;
		return table[name] ?? table[`icon.${name}`] ?? table[`cmd.${name}`] ?? table[COMMAND_ICONS[name] ?? ""] ?? "";
	}

	langIcon(lang: string | undefined): string {
		const key = languageKey(lang);
		return this.#table[key === undefined ? "lang.default" : `lang.${key}`]!;
	}
}
