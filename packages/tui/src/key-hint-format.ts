/**
 * Key-hint formatting, kept free of the native addon: it imports only types
 * plus the theme symbol mirror, so addon-free CLI paths (`omp --version`,
 * help text in cli/command-help.ts) can format keys without loading
 * `@oh-my-pi/pi-natives` through the keybindings registry.
 */
import type { KeyId } from "./keybindings";
import type { ModifierName } from "./keys";
import { activeThemeSymbol } from "./theme/active-symbols";
import type { SymbolKey } from "./theme/symbols";

/**
 * Key hint formatting: every key shown to the user renders through
 * {@link formatKeyHint}, so a key reads the same everywhere in the UI.
 *
 * Keys resolve through the active theme's `key.*` symbols — words in the
 * ascii preset, keycap glyphs in unicode, icons in nerd — falling back to the
 * ascii words before a theme loads. Modifiers are platform-aware: macOS
 * keycaps are labelled ⌃ ⌥ ⌘ (`key.*Mac`), while other platforms keep
 * `Ctrl`/`Alt`/`Super`, since those glyphs name no key on a PC keyboard.
 */

/**
 * Platform override for key-hint rendering; `undefined` resolves to the host
 * `process.platform`. Mirrors `setKittyProtocolActive` in the TUI keys module:
 * a single seam that keeps hint output deterministic in tests without mutating
 * the global `process.platform`.
 */
let keyHintPlatformOverride: NodeJS.Platform | undefined;

/** Pin the platform used to render modifier labels (test seam). */
export function setKeyHintPlatform(platform: NodeJS.Platform | undefined): void {
	keyHintPlatformOverride = platform;
}

/** Platform currently used for key-hint rendering. */
export function keyHintPlatform(): NodeJS.Platform {
	return keyHintPlatformOverride ?? process.platform;
}

/** Modifier → [generic symbol, macOS symbol], in display order (⌃⌥⇧⌘, as macOS menus list them). */
const MODIFIER_SYMBOLS: Record<string, readonly [SymbolKey, SymbolKey] | undefined> = {
	ctrl: ["key.ctrl", "key.ctrlMac"],
	alt: ["key.alt", "key.altMac"],
	shift: ["key.shift", "key.shift"],
	super: ["key.super", "key.superMac"],
};
const KEY_SYMBOLS: Record<string, SymbolKey | undefined> = {
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
const KEY_WORDS: Record<string, string | undefined> = {
	home: "Home",
	end: "End",
	pageup: "PgUp",
	pagedown: "PgDn",
	insert: "Ins",
};

function keySymbol(key: SymbolKey): string {
	return activeThemeSymbol(key);
}

const HAS_LETTER = /[A-Za-z0-9]/;

/** A displayable key: a chord, or a bare modifier for "hold ⇧" style hints. */
export type KeyName = KeyId | ModifierName;

/**
 * Format one key for display: `"ctrl+shift+c"` → `⌃⇧C` (macOS) / `Ctrl+⇧C`,
 * `"escape"` → `⎋`, `"alt+up"` → `⌥↑` / `Alt+↑`, `"shift"` → `⇧`.
 * A glyph modifier is followed by the preset's `key.joiner` (nothing in
 * unicode, a space in nerd, whose icons blur together when adjacent); a word
 * modifier takes a `+`. Modifiers
 * render in canonical order whatever the binding says (`shift+ctrl+p` → `⌃⇧P`).
 * A bare letter stays lowercase (`q`) since `Q` would read as ⇧Q; in a chord it
 * is capitalized. Other keys are capitalized (`f5` → `F5`).
 */
export function formatKeyHint(key: KeyName): string {
	const mac = keyHintPlatform() === "darwin";
	// A trailing `+` is the plus key itself (`+`, `ctrl++`), not a separator.
	const parts = key.endsWith("+") ? [...key.slice(0, -1).split("+").slice(0, -1), "+"] : key.split("+");
	const base = parts.pop()!;
	let out = "";
	for (const modifier in MODIFIER_SYMBOLS) {
		if (!parts.includes(modifier)) continue;
		const label = keySymbol(MODIFIER_SYMBOLS[modifier]![mac ? 1 : 0]);
		out += HAS_LETTER.test(label) ? `${label}+` : label + keySymbol("key.joiner");
	}
	const lower = base.toLowerCase();
	const modifier = MODIFIER_SYMBOLS[lower];
	const symbol = KEY_SYMBOLS[lower];
	if (modifier) out += keySymbol(modifier[mac ? 1 : 0]);
	else if (symbol !== undefined) out += keySymbol(symbol);
	else if (KEY_WORDS[lower] !== undefined) out += KEY_WORDS[lower];
	else if (base.length === 1) out += parts.length === 0 ? base : base.toUpperCase();
	else out += base[0]!.toUpperCase() + base.slice(1);
	return out;
}

/** Format alternative keys as a slash-separated hint (`["f5", "alt+r"]` → `F5/⌥R`). */
export function formatKeyHints(keys: KeyName | readonly KeyName[]): string {
	return typeof keys === "string" ? formatKeyHint(keys) : keys.map(formatKeyHint).join("/");
}

/** Format a double-tap gesture: `←←` with glyphs, `Left Left` with words. */
export function formatDoubleTap(key: KeyName): string {
	const label = formatKeyHint(key);
	return `${label}${HAS_LETTER.test(label) ? " " : keySymbol("key.joiner")}${label}`;
}
