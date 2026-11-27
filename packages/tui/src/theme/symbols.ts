/**
 * Symbol presets: the glyph tables (`data/symbols.json`) and the
 * `SymbolSet` a theme hands painters.
 */
// The logger subpath, not the `@oh-my-pi/pi-utils` barrel (which loads the native addon):
// key-hint formatting reads these tables on addon-free CLI paths (`omp --help`).
import * as logger from "@oh-my-pi/pi-utils/logger";
import { type BoxGlyphs, CONSERVATIVE_EMOJI, type EmojiSupport, type SymbolSet } from "./contract";
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
/** One-cell slot keys → the plain text glyph drawn when a bare emoji-capable glyph would spill. */
const FALLBACKS: Readonly<Record<string, string>> = SYMBOL_DATA.fallbacks;
/** An emoji-capable char that defaults to text presentation, with any variation selector after it. */
const TEXT_EMOJI = /((?=\p{Extended_Pictographic})\P{Emoji_Presentation})[\uFE0E\uFE0F]?/u;
const TEXT_EMOJI_ALL = new RegExp(TEXT_EMOJI.source, "gu");
/** Key groups drawn as icons: their emoji-capable glyphs may take the two-cell emoji form. */
const ICON_GROUP = /^(?:status|icon|cmd|tab|tool|lang|chip)\./;

/**
 * The form of `glyph` (at symbol `key`) to emit on a terminal with `emoji` support:
 * one-cell slots stay bare when it fits, else take their fallback; icons take
 * U+FE0F (two cells) when the terminal advances it so; everything else stays bare.
 */
function emojiForm(key: string, glyph: string, emoji: EmojiSupport): string {
	if (!TEXT_EMOJI.test(glyph)) return glyph;
	const fallback = FALLBACKS[key];
	if (fallback !== undefined && !emoji.bareFits) return fallback;
	const wide = fallback === undefined && emoji.vs16Wide && ICON_GROUP.test(key);
	return glyph.replace(TEXT_EMOJI_ALL, wide ? "$1\uFE0F" : "$1");
}

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
	/** How the terminal draws emoji-capable glyphs (default {@link CONSERVATIVE_EMOJI}). */
	readonly emoji?: EmojiSupport;
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
		const emoji = options.emoji ?? CONSERVATIVE_EMOJI;
		// A theme's override is drawn as written: the rule only picks forms of the preset's own glyphs.
		for (const key in table) if (!(key in overrides)) table[key] = emojiForm(key, table[key]!, emoji);
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
