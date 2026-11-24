/**
 * A theme file resolved at a color depth: SGR per color key, span-token
 * styling, symbols.
 */
import { adjustHsv, mixHex } from "@oh-my-pi/pi-utils/color";
import { BG_DEFAULT, type ColorDepth, colorHex, FG_DEFAULT, fgSgr, bgSgr, isLightColor, normalizeHex } from "./color";
import type { Theme } from "./contract";
import {
	BACKGROUND_KEYS,
	type ColorValue,
	FOREGROUND_KEYS,
	OPTIONAL_KEYS,
	type SymbolPreset,
	type ThemeJson,
} from "./schema";
import { LANGUAGE_BRAND_COLORS, languageKey, ThemeSymbols } from "./symbols";

/** How to resolve a theme file. */
export interface ThemeOptions {
	/** Color depth of the terminal (default truecolor). */
	readonly depth?: ColorDepth;
	/** Symbol preset chosen in settings; wins over the theme file's `symbols.preset`. */
	readonly symbolPreset?: SymbolPreset;
	/** Shift `toolDiffAdded` from green toward blue (red–green color blindness). */
	readonly colorBlindMode?: boolean;
}

/** TSP tones → the theme color that draws them. */
const TONE_COLORS: Readonly<Record<string, string>> = {
	neutral: "text",
	accent: "accent",
	info: "accent",
	success: "success",
	warning: "warning",
	pending: "warning",
	error: "error",
	muted: "muted",
	user: "customMessageLabel",
};

/**
 * Semantic span tokens → the theme color drawn when no explicit color token is
 * present; when several are, the more specific wins (`ins num` is an insertion).
 */
const SEMANTIC_COLORS: Readonly<Record<string, { readonly color: string; readonly rank: number }>> = {
	ins: { color: "toolDiffAdded", rank: 5 },
	del: { color: "toolDiffRemoved", rank: 5 },
	link: { color: "mdLink", rank: 4 },
	code: { color: "mdCode", rank: 3 },
	path: { color: "accent", rank: 2 },
	num: { color: "accent", rank: 1 },
};

interface Attribute {
	readonly open: string;
	readonly close: string;
}

const BOLD: Attribute = { open: "\x1b[1m", close: "\x1b[22m" };
const FAINT: Attribute = { open: "\x1b[2m", close: "\x1b[22m" };
const ITALIC: Attribute = { open: "\x1b[3m", close: "\x1b[23m" };
const UNDERLINE: Attribute = { open: "\x1b[4m", close: "\x1b[24m" };
const INVERSE: Attribute = { open: "\x1b[7m", close: "\x1b[27m" };
const STRIKE: Attribute = { open: "\x1b[9m", close: "\x1b[29m" };

/** Attribute tokens, innermost first. */
const ATTRIBUTE_TOKENS: Readonly<Record<string, Attribute>> = {
	strong: BOLD,
	em: ITALIC,
	underline: UNDERLINE,
	typo: UNDERLINE,
	strike: STRIKE,
	inverse: INVERSE,
	faint: FAINT,
};
const ATTRIBUTE_ORDER: readonly Attribute[] = [ITALIC, UNDERLINE, STRIKE, INVERSE, FAINT, BOLD];

/**
 * Wrap `text` in an attribute: a nested close re-opens it, and it closes
 * before each line break and re-opens after. Empty text stays empty.
 */
export function withAttribute(attribute: Attribute, text: string): string {
	if (text === "") return text;
	const { open, close } = attribute;
	let body = text.includes(close) ? text.split(close).join(close + open) : text;
	if (body.includes("\n")) body = body.replace(/\r?\n/g, match => `${close}${match}${open}`);
	return open + body + close;
}

export const bold = (text: string): string => withAttribute(BOLD, text);
export const italic = (text: string): string => withAttribute(ITALIC, text);
export const underline = (text: string): string => withAttribute(UNDERLINE, text);
export const strikethrough = (text: string): string => withAttribute(STRIKE, text);
export const inverse = (text: string): string => withAttribute(INVERSE, text);
export const faint = (text: string): string => withAttribute(FAINT, text);

const FOREGROUND_RESET = /\x1b\[(?:0|39)m/g;
const BACKGROUND_RESET = /\x1b\[(?:0|49)m/g;

/** Color `text` with foreground `sgr`, restoring it after every nested reset; ends with a foreground reset. */
function wrapForeground(sgr: string, text: string): string {
	const body = text.includes("\x1b[") ? text.replace(FOREGROUND_RESET, `$&${sgr}`) : text;
	return `${sgr}${body}${FG_DEFAULT}`;
}

const BACKGROUND_KEY_SET: Readonly<Record<string, true>> = Object.fromEntries(BACKGROUND_KEYS.map(key => [key, true]));

/**
 * A theme file's color with `vars` references followed: hex strings, palette
 * indices and `""` (terminal default) pass through. Throws on unknown or
 * circular references.
 */
export function resolveColorValue(
	value: ColorValue,
	vars: Readonly<Record<string, ColorValue>>,
	seen: string[] = [],
): ColorValue {
	if (typeof value === "number" || value === "" || value.startsWith("#")) return value;
	if (seen.includes(value)) throw new Error(`Circular variable reference detected: ${[...seen, value].join(" -> ")}`);
	const next = vars[value];
	if (next === undefined) throw new Error(`Variable reference not found: ${value}`);
	seen.push(value);
	return resolveColorValue(next, vars, seen);
}

/** Share of `mdLink` in a derived `mdExtensionLink`; the rest is `text`. */
const EXTENSION_LINK_TINT = 0.45;
const COLOR_BLIND_SHIFT = { h: 60, s: 0.71 };

/** A theme resolved at one color depth. */
export class ResolvedTheme implements Theme {
	readonly name: string;
	readonly dark: boolean;
	readonly depth: ColorDepth;
	readonly symbols: ThemeSymbols;
	/** The file the theme came from (for exports and previews). */
	readonly json: ThemeJson;
	readonly #colors: Readonly<Record<string, ColorValue>>;
	readonly #fg: Record<string, string> = {};
	readonly #bg: Record<string, string> = {};
	readonly #fgResolved: Record<string, string> = {};
	readonly #palette: readonly string[];
	readonly #paletteHex: readonly (string | undefined)[];

	constructor(json: ThemeJson, options: ThemeOptions = {}) {
		const depth = options.depth ?? "truecolor";
		const vars = json.vars ?? {};
		const colors: Record<string, ColorValue> = {};
		const declared = json.colors;
		for (const key in declared) {
			const value = declared[key as keyof typeof declared];
			if (value !== undefined) colors[key] = resolveColorValue(value, vars);
		}
		const light = isLightColor(colors.statusLineBg);
		const ansi = json.terminal?.ansi?.map(value => resolveColorValue(value, vars));
		if (options.colorBlindMode) {
			const added = colors.toolDiffAdded;
			if (typeof added === "string" && added.startsWith("#"))
				colors.toolDiffAdded = adjustHsv(added, COLOR_BLIND_SHIFT);
		}
		if (colors.mdExtensionLink === undefined && colors.text !== undefined && colors.mdLink !== undefined) {
			const foreground = json.terminal?.foreground;
			const terminalForeground = foreground === undefined ? undefined : resolveColorValue(foreground, vars);
			const intended = (value: ColorValue): string => {
				let color = value === "" ? (terminalForeground ?? value) : value;
				if (typeof color === "number" && color < 16) color = ansi?.[color] ?? color;
				return normalizeHex(colorHex(color, light));
			};
			colors.mdExtensionLink = mixHex(intended(colors.text), intended(colors.mdLink), EXTENSION_LINK_TINT);
		}
		colors.thinkingMax ??= colors.thinkingXhigh ?? "";

		this.name = json.name;
		this.json = json;
		this.dark = !light;
		this.depth = depth;
		this.#colors = colors;
		for (const key of FOREGROUND_KEYS) {
			const value = colors[key] ?? (OPTIONAL_KEYS[key] ? "" : undefined);
			if (value === undefined) continue;
			this.#fg[key] = fgSgr(value, depth);
			this.#fgResolved[key] = value === "" ? fgSgr(colorHex("", light), depth) : this.#fg[key]!;
		}
		for (const key of BACKGROUND_KEYS) {
			const value = colors[key];
			if (value !== undefined) this.#bg[key] = bgSgr(value, depth);
		}
		this.#palette = Array.from({ length: 16 }, (_, slot) => fgSgr(ansi?.[slot] ?? slot, depth));
		this.#paletteHex = Array.from({ length: 16 }, (_, slot) => {
			const value = ansi?.[slot];
			return value === undefined || value === "" ? undefined : colorHex(value, light);
		});
		this.symbols = new ThemeSymbols({
			preset: options.symbolPreset ?? json.symbols?.preset ?? "unicode",
			overrides: json.symbols?.overrides,
			spinnerFrames: json.symbols?.spinnerFrames,
		});
	}

	/** Foreground SGR of a color key; throws for unknown keys. */
	fgSgr(color: string): string {
		const sgr = this.#fg[color];
		if (sgr === undefined) throw new Error(`Unknown theme color: ${color}`);
		return sgr;
	}

	/** Background SGR of a background key; throws for unknown keys. */
	bgSgr(color: string): string {
		const sgr = this.#bg[color];
		if (sgr === undefined) throw new Error(`Unknown theme background color: ${color}`);
		return sgr;
	}

	/** Hex a color key stands for (terminal-default colors guess black/near-white by theme brightness). */
	hex(color: string): string {
		const value = this.#colors[color];
		if (value === undefined) throw new Error(`Unknown theme color: ${color}`);
		if (value === "" && BACKGROUND_KEY_SET[color]) return this.dark ? "#000000" : "#ffffff";
		return colorHex(value, !this.dark);
	}

	/** Hex of `terminal.ansi` slot `slot`, when the theme declares it. */
	paletteHex(slot: number): string | undefined {
		return this.#paletteHex[slot];
	}

	fg(color: string, text: string): string {
		return wrapForeground(this.fgSgr(color), text);
	}

	fgResolved(color: string, text: string): string {
		const sgr = this.#fgResolved[color];
		if (sgr === undefined) throw new Error(`Unknown theme color: ${color}`);
		return wrapForeground(sgr, text);
	}

	bg(color: string, text: string): string {
		return `${this.bgSgr(color)}${text}${BG_DEFAULT}`;
	}

	/** Background that resumes after nested full or background resets (rows holding styled text). */
	bgFill(color: string, text: string): string {
		const sgr = this.bgSgr(color);
		return `${sgr}${text.replace(BACKGROUND_RESET, `$&${sgr}`)}${BG_DEFAULT}`;
	}

	palette(slot: number, text: string): string {
		const sgr = this.#palette[slot];
		if (sgr === undefined) throw new Error(`Invalid palette slot: ${slot}`);
		return wrapForeground(sgr, text);
	}

	has(color: string): boolean {
		const sgr = this.#fg[color] ?? this.#bg[color];
		return sgr !== undefined && sgr !== FG_DEFAULT && sgr !== BG_DEFAULT;
	}

	/** Language icon tinted with the language's brand color, else muted. */
	langIconStyled(lang: string | undefined): string {
		const icon = this.symbols.langIcon(lang);
		if (!icon) return icon;
		const brand = LANGUAGE_BRAND_COLORS[languageKey(lang) ?? ""];
		return brand === undefined ? this.fg("muted", icon) : wrapForeground(fgSgr(brand, this.depth), icon);
	}

	style(tokens: string | undefined, text: string): string {
		if (!tokens) return text;
		let color: string | undefined;
		let semantic: { readonly color: string; readonly rank: number } | undefined;
		let background: string | undefined;
		let attributes: Attribute[] | undefined;
		for (const token of tokens.split(" ")) {
			if (token === "") continue;
			if (token === "hide") return "";
			const attribute = ATTRIBUTE_TOKENS[token];
			if (attribute !== undefined) (attributes ??= []).push(attribute);
			else if (this.#fg[token] !== undefined) color = token;
			else if (TONE_COLORS[token] !== undefined) color = TONE_COLORS[token];
			else if (this.#bg[token] !== undefined) background = token;
			else if (token === "mark") background = "selectedBg";
			else {
				const meaning = SEMANTIC_COLORS[token];
				if (meaning !== undefined && (semantic === undefined || meaning.rank > semantic.rank)) semantic = meaning;
			}
		}
		let out = text;
		if (attributes !== undefined) {
			for (const attribute of ATTRIBUTE_ORDER)
				if (attributes.includes(attribute)) out = withAttribute(attribute, out);
		}
		color ??= semantic?.color;
		if (color !== undefined) out = this.fg(color, out);
		if (background !== undefined) out = this.bg(background, out);
		return out;
	}
}

/** Resolve a theme file. Throws on unresolvable variables or invalid colors. */
export function createTheme(json: ThemeJson, options: ThemeOptions = {}): ResolvedTheme {
	return new ResolvedTheme(json, options);
}
