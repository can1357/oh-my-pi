/**
 * A theme without colors or attributes: text passes through. For tests and
 * for terminals that asked for no color.
 */
import type { Theme } from "./contract";
import { ThemeSymbols } from "./symbols";

/** The colorless theme (unicode glyphs). */
export const PLAIN_THEME: Theme = {
	name: "plain",
	dark: true,
	style: (tokens, text) => (tokens !== undefined && tokens.split(" ").includes("hide") ? "" : text),
	fg: (_color, text) => text,
	fgResolved: (_color, text) => text,
	bg: (_color, text) => text,
	palette: (_slot, text) => text,
	has: () => false,
	depth: "16",
	fgSgr: () => "",
	hex: () => "#000000",
	symbols: new ThemeSymbols({ preset: "unicode" }),
};
