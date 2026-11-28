/**
 * Key hints in the active theme: every key the UI shows renders through
 * here, so a key reads the same everywhere. Reading the theme subscribes a
 * reactive caller, so hints re-render when the symbol preset changes.
 */
import type { TspSpan } from "@oh-my-pi/pi-wire";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { Keybinding } from "../../config/keybindings/app-keybindings";
import { getKeybindings, type KeybindingsManager } from "../../config/keybindings/keybindings";
import { canonicalKeyId } from "../../config/keybindings/key-id";
import { appInterruptKeys } from "../../config/keybindings/matchers";
import {
	formatKey,
	formatKeys,
	formatKeyTwice,
	type KeyStyle,
	kbdKeys,
	keyHintPlatform,
} from "@oh-my-pi/pi-tui/theme/keys";

/** The active theme's symbol preset on the key-hint platform. */
export function activeKeyStyle(): KeyStyle {
	return { preset: currentTheme().symbols.preset, platform: keyHintPlatform() };
}

/** One key as `theme`'s symbol preset draws it, for painters handed a theme (`alt+up` → `⌥↑` on macOS). */
export function keyLabel(theme: Theme, key: string): string {
	return formatKey(key, { preset: theme.symbols.preset, platform: keyHintPlatform() });
}

/** The primary tool expansion key in `theme`'s symbol preset. */
export function expandKeyLabel(theme: Theme, keybindings: KeybindingsManager = getKeybindings()): string {
	return keyLabel(theme, keybindings.keysFor("app.tools.expand")[0] ?? "ctrl+o");
}

/** One key in the active theme (`ctrl+shift+c` → `⌃⇧C` on macOS, `Ctrl+⇧C` elsewhere). */
export function formatKeyHint(key: string): string {
	return formatKey(key, activeKeyStyle());
}

/** Alternative keys, slash-separated (`["f5", "alt+r"]` → `F5/⌥R`). */
export function formatKeyHints(keys: string | readonly string[]): string {
	return formatKeys(keys, activeKeyStyle());
}

/** A double tap of `key` (`←←`, `Left Left`). */
export function formatDoubleTap(key: string): string {
	return formatKeyTwice(key, activeKeyStyle());
}

/**
 * One key for a native tooltip (a TSP `title`): unicode keycaps whatever the
 * preset (Tern's UI font lacks the nerd icons, and its tooltip splits glyph
 * keycaps), and Escape as `esc`, Tern's own keycap.
 */
export function formatTooltipKey(key: string): string {
	return key === "escape" ? "esc" : formatKey(key, { preset: "unicode", platform: keyHintPlatform() });
}

/** A double tap of `key` in a tooltip (`←←`, `Tab Tab`). */
export function formatTooltipDoubleTap(key: string): string {
	const label = formatTooltipKey(key);
	return `${label}${/[A-Za-z0-9]/.test(label) ? " " : ""}${label}`;
}

/** The primary key bound to `action`, formatted; empty when unbound. */
export function actionKey(action: Keybinding, keybindings: KeybindingsManager = getKeybindings()): string {
	const [key] = keybindings.keysFor(action);
	return key === undefined ? "" : formatKeyHint(key);
}

/** Every key bound to `action`, slash-separated; empty when unbound. */
export function actionKeys(action: Keybinding, keybindings: KeybindingsManager = getKeybindings()): string {
	return formatKeyHints(keybindings.keysFor(action));
}

/** A hint row part: `keys` dim, then ` description` muted (`⏎ select`). */
export function keyHintSpans(keys: string | readonly string[], description: string): TspSpan[] {
	return [
		{ t: formatKeyHints(keys), s: "dim" },
		{ t: ` ${description}`, s: "muted" },
	];
}

/** {@link keyHintSpans} for the primary key bound to `action`. */
export function actionHintSpans(
	action: Keybinding,
	description: string,
	keybindings: KeybindingsManager = getKeybindings(),
): TspSpan[] {
	return [
		{ t: actionKey(action, keybindings), s: "dim" },
		{ t: ` ${description}`, s: "muted" },
	];
}

/** The keycaps of the chord `key` (`kbd` parts, picker action `keys`), in canonical key names (`ctrl+pageup` → `["ctrl", "pageUp"]`). */
export function kbdOf(key: string): string[] {
	return kbdKeys(canonicalKeyId(key));
}

/** The keycaps (`kbd` parts, picker action `keys`) of the primary key bound to `action`, else of `fallback`. */
export function actionKbd(
	action: Keybinding,
	fallback: string,
	keybindings: KeybindingsManager = getKeybindings(),
): string[] {
	return kbdOf(keybindings.keysFor(action)[0] ?? fallback);
}

/** Keycaps of the selector cancel key (`tui.select.cancel`, Escape by default). */
export function cancelKbd(keybindings: KeybindingsManager = getKeybindings()): string[] {
	return actionKbd("tui.select.cancel", "escape", keybindings);
}

/** Keycaps of the selector confirm key (`tui.select.confirm`, Enter by default). */
export function confirmKbd(keybindings: KeybindingsManager = getKeybindings()): string[] {
	return actionKbd("tui.select.confirm", "enter", keybindings);
}

/** Keycaps of the interrupt key (`app.interrupt`, Escape when unbound). */
export function interruptKbd(keybindings: KeybindingsManager = getKeybindings()): string[] {
	return kbdOf(appInterruptKeys(keybindings)[0] ?? "escape");
}

/** The key id (`KeyEvent` form: `pageUp`, `ctrl+shift+k`) of the primary key bound to `action`, else `fallback`. */
export function actionKeyId(
	action: Keybinding,
	fallback: string,
	keybindings: KeybindingsManager = getKeybindings(),
): string {
	const [key] = keybindings.keysFor(action);
	return key === undefined ? fallback : canonicalKeyId(key);
}
