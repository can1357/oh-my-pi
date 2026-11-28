/**
 * Key names as the UI shows them, for one symbol preset and platform:
 * keycap glyphs in the unicode preset, icons in nerd, words in ascii.
 * Modifiers are platform-aware: macOS reads ⌃ ⌥ ⌘ (`key.*Mac`), other
 * platforms keep `Ctrl`/`Alt`/`Super`, which no PC keycap shows as a glyph.
 *
 * Addon-free, so CLI help can select a preset without loading the native addon.
 */
import type { SymbolSet } from "@oh-my-pi/pi-tui/theme/contract";
import type { SymbolPreset } from "@oh-my-pi/pi-tui/theme/schema";
import { presetSymbols } from "@oh-my-pi/pi-tui/theme/symbols";

/** How keys read: resolved theme symbols or a standalone preset, and the modifier platform. */
export type KeyStyle = { readonly platform: NodeJS.Platform } & (
	| { readonly symbols: SymbolSet }
	| { readonly preset: SymbolPreset }
);

/** Modifiers in display order (⌃⌥⇧⌘, as macOS menus list them). */
const MODIFIERS = ["ctrl", "alt", "shift", "super"] as const;
const NAMED_KEYS: Readonly<Record<string, string>> = {
	esc: "key.esc",
	escape: "key.esc",
	enter: "key.enter",
	return: "key.enter",
	space: "key.space",
	tab: "key.tab",
	backspace: "key.backspace",
	delete: "key.delete",
	up: "key.up",
	down: "key.down",
	left: "key.left",
	right: "key.right",
};
/** Keys without a keycap glyph; spelled out in every preset. */
const WORD_KEYS: Readonly<Record<string, string>> = {
	home: "Home",
	end: "End",
	pageup: "PgUp",
	pagedown: "PgDn",
	insert: "Ins",
};
const LETTERS = /[A-Za-z0-9]/;

let platformOverride: NodeJS.Platform | undefined;

/** Pin the platform key hints render modifiers for; `undefined` restores the host's (test seam). */
export function setKeyHintPlatform(platform: NodeJS.Platform | undefined): void {
	platformOverride = platform;
}

/** The platform key hints render modifiers for. */
export function keyHintPlatform(): NodeJS.Platform {
	return platformOverride ?? process.platform;
}

function modifierSymbol(modifier: string, mac: boolean): string {
	return modifier === "shift" ? "key.shift" : `key.${modifier}${mac ? "Mac" : ""}`;
}

function keySymbol(style: KeyStyle, key: string): string | undefined {
	return "symbols" in style ? style.symbols.symbol(key) : presetSymbols(style.preset)[key];
}

/** A chord's parts: modifiers then the key; a trailing `+` is the plus key itself (`+`, `ctrl++`). */
function chordParts(key: string): string[] {
	return key.endsWith("+") ? [...key.slice(0, -1).split("+").slice(0, -1), "+"] : key.split("+");
}

/**
 * One key as `style` draws it: `ctrl+shift+c` → `⌃⇧C` (macOS) / `Ctrl+⇧C`,
 * `escape` → `⎋`, `alt+up` → `⌥↑` / `Alt+↑`, a bare modifier `shift` → `⇧`.
 * A glyph modifier is followed by the style's `key.joiner` (nothing in
 * unicode, a space in nerd, whose icons blur together when adjacent); a word
 * modifier takes a `+`. Modifiers render in canonical order whatever the
 * binding says (`shift+ctrl+p` → `⌃⇧P`). A bare letter stays lowercase (`q`,
 * since `Q` would read as ⇧Q); in a chord it is capitalized. Other keys are
 * capitalized (`f5` → `F5`).
 */
export function formatKey(key: string, style: KeyStyle): string {
	const mac = style.platform === "darwin";
	const parts = chordParts(key);
	const base = parts.pop()!;
	const modifiers = parts.map(part => part.toLowerCase());
	let out = "";
	for (const modifier of MODIFIERS) {
		if (!modifiers.includes(modifier)) continue;
		const label = keySymbol(style, modifierSymbol(modifier, mac)) ?? modifier;
		out += LETTERS.test(label) ? `${label}+` : label + (keySymbol(style, "key.joiner") ?? "");
	}
	const lower = base.toLowerCase();
	if ((MODIFIERS as readonly string[]).includes(lower)) out += keySymbol(style, modifierSymbol(lower, mac)) ?? lower;
	else if (NAMED_KEYS[lower]) out += keySymbol(style, NAMED_KEYS[lower]) ?? lower;
	else if (WORD_KEYS[lower]) out += WORD_KEYS[lower];
	else if (base.length === 1) out += parts.length === 0 ? base : base.toUpperCase();
	else out += base[0]!.toUpperCase() + base.slice(1);
	return out;
}

/** Alternative keys slash-separated (`["f5", "alt+r"]` → `F5/⌥R`). */
export function formatKeys(keys: string | readonly string[], style: KeyStyle): string {
	return typeof keys === "string" ? formatKey(keys, style) : keys.map(key => formatKey(key, style)).join("/");
}

/** A double tap of `key`: `←←` with glyphs, `Left Left` with words. */
export function formatKeyTwice(key: string, style: KeyStyle): string {
	const label = formatKey(key, style);
	return `${label}${LETTERS.test(label) ? " " : (keySymbol(style, "key.joiner") ?? "")}${label}`;
}

/** The keycaps of a `kbd` node (`alt+up` → `["alt", "up"]`, `ctrl++` → `["ctrl", "+"]`). */
export function kbdKeys(key: string): string[] {
	return chordParts(key).filter(part => part.length > 0);
}
