/**
 * Theme colors → SGR at the terminal's color depth, plus the hex math theme
 * resolution needs (defaults, luminance, palette slots).
 */
import { colorLuma, hexToOklch, hueDistance, paletteToRgb, rgbToHex } from "@oh-my-pi/pi-utils/color";
import type { TerminalCapabilities } from "../driver/contract";
import type { ColorValue } from "./schema";

/** How many colors the terminal shows: 24-bit, the xterm 256 palette, or the 16 ANSI colors. */
export type ColorDepth = "truecolor" | "256" | "16";

export const FG_DEFAULT = "\x1b[39m";
export const BG_DEFAULT = "\x1b[49m";
export const UNDERLINE_COLOR_DEFAULT = "\x1b[59m";

/** Depth of a terminal the driver probed. */
export function depthOf(capabilities: Pick<TerminalCapabilities, "truecolor" | "colors">): ColorDepth {
	if (capabilities.truecolor || capabilities.colors > 256) return "truecolor";
	return capabilities.colors >= 256 ? "256" : "16";
}

/** Hex of a palette index, or throws for an index outside 0–255. */
export function paletteHex(index: number): string {
	const rgb = paletteToRgb(index);
	if (!rgb) throw new Error(`Invalid palette index: ${index}`);
	return rgbToHex(rgb);
}

/** `#rrggbb` of a CSS color string; throws for anything Bun cannot parse. */
export function normalizeHex(color: string): string {
	const hex = Bun.color(color, "hex");
	if (hex === null) throw new Error(`Invalid color value: ${color}`);
	return hex;
}

/** Hex a resolved color stands for; `""` (terminal default) guesses black on light themes, near-white on dark. */
export function colorHex(value: ColorValue, light: boolean): string {
	if (typeof value === "number") return paletteHex(value);
	if (value === "") return light ? "#000000" : "#e5e5e7";
	return value;
}

/** True when `value` is a light surface (Rec. 709 luma above one half). */
export function isLightColor(value: ColorValue | undefined): boolean {
	if (value === undefined) return false;
	const luma = colorLuma(value);
	return luma !== undefined && luma > 0.5;
}

/** OKLCH hue of each chromatic ANSI color (index 1–6: red, green, yellow, blue, magenta, cyan). */
const ANSI_HUES: readonly { readonly index: number; readonly hue: number }[] = [
	{ index: 1, hue: 29 },
	{ index: 3, hue: 110 },
	{ index: 2, hue: 142 },
	{ index: 6, hue: 195 },
	{ index: 4, hue: 264 },
	{ index: 5, hue: 328 },
];
/** Below this OKLCH chroma a color reads as gray. */
const GRAY_CHROMA = 0.04;
/** At or above this OKLCH lightness a chromatic color takes the bright variant. */
const BRIGHT_LIGHTNESS = 0.6;

/**
 * The ANSI color (index 0–15) closest in meaning to `hex`: grays by
 * lightness, other colors by hue family, bright when light. Terminals
 * re-tint the 16 colors, so hue and brightness carry more than RGB distance.
 */
function nearestAnsi16(hex: string): number {
	const { l, c, h } = hexToOklch(hex);
	if (c < GRAY_CHROMA) {
		if (l < 0.3) return 0;
		if (l < 0.6) return 8;
		return l < 0.85 ? 7 : 15;
	}
	let best = ANSI_HUES[0]!;
	for (const candidate of ANSI_HUES) if (hueDistance(h, candidate.hue) < hueDistance(h, best.hue)) best = candidate;
	return l >= BRIGHT_LIGHTNESS ? best.index + 8 : best.index;
}

function ansi16Code(index: number, background: boolean): number {
	const base = index < 8 ? 30 + index : 90 + index - 8;
	return background ? base + 10 : base;
}

const sgrCache: Record<ColorDepth, Map<string, string>> = { truecolor: new Map(), "256": new Map(), "16": new Map() };
const SGR_CACHE_LIMIT = 512;

/** Foreground SGR of a CSS color string at `depth`. */
function stringFg(color: string, depth: ColorDepth): string {
	const cache = sgrCache[depth];
	const cached = cache.get(color);
	if (cached !== undefined) return cached;
	let sgr: string | null;
	if (depth === "16") sgr = `\x1b[${ansi16Code(nearestAnsi16(normalizeHex(color)), false)}m`;
	else sgr = Bun.color(color, depth === "truecolor" ? "ansi-16m" : "ansi-256");
	if (sgr === null) throw new Error(`Invalid color value: ${color}`);
	if (cache.size >= SGR_CACHE_LIMIT) cache.clear();
	cache.set(color, sgr);
	return sgr;
}

/** Foreground SGR of a resolved color: `""` is the terminal default, numbers are palette indices. */
export function fgSgr(value: ColorValue, depth: ColorDepth): string {
	if (value === "") return FG_DEFAULT;
	if (typeof value === "number") {
		if (depth !== "16") return `\x1b[38;5;${value}m`;
		return `\x1b[${ansi16Code(value < 16 ? value : nearestAnsi16(paletteHex(value)), false)}m`;
	}
	return stringFg(value, depth);
}

/**
 * Underline-color SGR (colon-form `58`) of a resolved color; `""` follows the
 * text color. Only for terminals with `TerminalCapabilities.styledUnderlines`.
 */
export function underlineSgr(value: ColorValue, depth: ColorDepth): string {
	const fg = fgSgr(value, depth);
	if (fg === FG_DEFAULT) return UNDERLINE_COLOR_DEFAULT;
	const params = fg.slice(2, -1).split(";");
	if (params[0] === "38") {
		return params[1] === "2" ? `\x1b[58:2::${params.slice(2).join(":")}m` : `\x1b[58:5:${params[2]}m`;
	}
	const code = Number(params[0]);
	return `\x1b[58:5:${code >= 90 ? code - 82 : code - 30}m`;
}

/** Background SGR of a resolved color. */
export function bgSgr(value: ColorValue, depth: ColorDepth): string {
	if (value === "") return BG_DEFAULT;
	if (typeof value === "number") {
		if (depth !== "16") return `\x1b[48;5;${value}m`;
		return `\x1b[${ansi16Code(value < 16 ? value : nearestAnsi16(paletteHex(value)), true)}m`;
	}
	const fg = stringFg(value, depth);
	if (fg.startsWith("\x1b[38;")) return `\x1b[48;${fg.slice(5)}`;
	return `\x1b[${Number(fg.slice(2, -1)) + 10}m`;
}
