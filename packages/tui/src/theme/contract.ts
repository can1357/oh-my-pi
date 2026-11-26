/**
 * What painters need from a theme. The theme subsystem (`theme/*`) loads
 * theme files and implements this; painters never hard-code colors.
 */
import type { ColorDepth } from "./color";

/** Box-drawing glyphs of one border style. */
export interface BoxGlyphs {
	readonly topLeft: string;
	readonly topRight: string;
	readonly bottomLeft: string;
	readonly bottomRight: string;
	readonly horizontal: string;
	readonly vertical: string;
	readonly teeDown: string;
	readonly teeUp: string;
	readonly teeLeft: string;
	readonly teeRight: string;
	readonly cross: string;
}

/** Glyph sets that depend on the symbol preset (unicode, nerd, ascii). */
export interface SymbolSet {
	/** The preset the glyphs come from. */
	readonly preset: "unicode" | "nerd" | "ascii";
	/** Outlined chrome: rounded corners and edges, sharp junctions. */
	readonly box: BoxGlyphs;
	/** Fully sharp box (markdown tables). */
	readonly sharp: BoxGlyphs;
	/** Glyph of a symbol key (`status.success`, `tool.bash`, `icon.session`, `md.bullet`); "" for unknown keys. */
	symbol(key: string): string;
	/** Named icon: a symbol key, an `icon.*` name (`warning`, `rewind`, `session`) or a slash-command icon name; "" when unknown. */
	icon(name: string): string;
	/** Icon of a language or file-type name (`ts`, `python`, `png`); the default language icon when unknown. */
	langIcon(lang: string | undefined): string;
	/** Status spinner frames (loaders, running tools). */
	readonly spinnerFrames: readonly string[];
	/** Activity spinner frames (fast progress indicators). */
	readonly activityFrames: readonly string[];
	readonly ellipsis: string;
}

/** A resolved theme. */
export interface Theme {
	readonly name: string;
	readonly dark: boolean;
	/** Color depth the theme's escapes target. */
	readonly depth: ColorDepth;
	/**
	 * Style `text` with space-separated TSP span tokens: theme colors
	 * (`accent`, `muted`, `dim`, `toolTitle`, …; `dim` is the theme color),
	 * background keys (`selectedBg`, …), tones (`info`, `pending`, `user`, …),
	 * attributes (`strong`, `em`, `faint` = SGR 2, `underline`, `strike`,
	 * `inverse`) and semantic tokens (`path`, `code`, `link`, `num`, `ins`/`del`
	 * diff colors, `mark`, `typo`, `hide`, …).
	 */
	style(tokens: string | undefined, text: string): string;
	/** Foreground color by theme key. */
	fg(color: string, text: string): string;
	/** Foreground by key, with terminal-default colors replaced by the theme's contrast fallback. */
	fgResolved(color: string, text: string): string;
	/** Background color by theme key. */
	bg(color: string, text: string): string;
	/** Color of `terminal.ansi` slot 0–15 (the terminal's own slot when the theme has none). */
	palette(slot: number, text: string): string;
	/** Whether the theme paints `color` with a real color (not the terminal default). */
	has(color: string): boolean;
	/** Foreground SGR of a color key (for looks that compose raw escapes); throws for unknown keys. */
	fgSgr(color: string): string;
	/** Hex a color key stands for (gradients, accent blends); throws for unknown keys. */
	hex(color: string): string;
	readonly symbols: SymbolSet;
}
