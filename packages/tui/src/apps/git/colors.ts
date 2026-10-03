/**
 * Truecolor helpers for the git TUI, all derived from the active theme so the
 * view follows the user's palette: surface tints mix theme colors toward the
 * theme's own canvas, and filled pill buttons pick their label contrast from
 * the button color's luminance.
 */
import { colorLuma, hexToRgb, rgbToHex } from "@oh-my-pi/pi-utils/color";
import { colorToAnsi } from "../../theme/color";
import { theme } from "../../theme/theme";

/** Decode a hex color into RGB channels. */
export function hexChannels(hex: string): [number, number, number] {
	const { r, g, b } = hexToRgb(hex);
	return [r, g, b];
}

/** Linear blend of two hex colors (`t` = 0 → `a`, 1 → `b`). */
export function mixHex(a: string, b: string, t: number): string {
	const ca = hexToRgb(a);
	const cb = hexToRgb(b);
	return rgbToHex({
		r: ca.r + (cb.r - ca.r) * t,
		g: ca.g + (cb.g - ca.g) * t,
		b: ca.b + (cb.b - ca.b) * t,
	});
}

/** Encode a truecolor background escape sequence. */
export function bgAnsiHex(hex: string): string {
	return colorToAnsi(hex, "truecolor").replace("\x1b[38;", "\x1b[48;");
}

/** Encode a truecolor foreground escape sequence. */
export function fgAnsiHex(hex: string): string {
	return colorToAnsi(hex, "truecolor");
}

/** True when the theme sits on a dark surface. */
export function isDark(): boolean {
	const luminance = theme.statusLineLuminance;
	return luminance === undefined || luminance <= 0.5;
}

/** The theme's canvas color: the surface diff tints and pills blend toward. */
export function canvasHex(): string {
	const hex = theme.getBgHex("statusLineBg");
	return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : isDark() ? "#000000" : "#ffffff";
}

/** The theme's default text color, used as the "bright" mix pole. */
export function textHex(): string {
	return theme.getColorHex("text");
}

/** Perceptual luminance of a hex color (0..1). */
export function luminance(hex: string): number {
	return colorLuma(hex)!;
}

/**
 * Re-assert a background after any reset inside syntax-highlighted text so a
 * row tint survives token boundaries emitted by the highlighter.
 */
export function withBg(text: string, bg: string): string {
	return bg + text.replaceAll("\x1b[0m", `\x1b[0m${bg}`).replaceAll("\x1b[49m", bg);
}

/**
 * Filled pill button with half-block end caps (`▐ label ▌`), colored from a
 * theme hex. Label contrast follows the fill's luminance. Visible width is
 * `label.length + 2`.
 */
export function pill(label: string, hex: string, options: { selected?: boolean; dim?: boolean } = {}): string {
	const fill = options.selected ? mixHex(hex, textHex(), 0.22) : options.dim ? mixHex(hex, canvasHex(), 0.55) : hex;
	const labelHex = luminance(fill) > 0.5 ? mixHex(fill, "#000000", 0.82) : mixHex(fill, "#ffffff", 0.92);
	return `${fgAnsiHex(fill)}▐${bgAnsiHex(fill)}${fgAnsiHex(labelHex)}${label}\x1b[0m${fgAnsiHex(fill)}▌\x1b[0m`;
}

/**
 * Flat filled chip with a contrast-computed label — readable on any theme,
 * unlike accent-on-selection combinations that can collapse (e.g. dark blue
 * on light blue).
 */
export function chipFill(label: string, hex: string): string {
	const labelHex = luminance(hex) > 0.5 ? mixHex(hex, "#000000", 0.82) : mixHex(hex, "#ffffff", 0.92);
	return `${bgAnsiHex(hex)}${fgAnsiHex(labelHex)}${label}\x1b[0m`;
}

/**
 * Selection-row background: a canvas-adjacent surface (canvas nudged toward
 * the text color) so every theme foreground stays readable on it — unlike
 * `selectedBg`, which some themes define as a saturated color.
 * `dim` renders a fainter band for cursors in unfocused panes.
 */
export function selectionBgAnsi(dim = false): string {
	return bgAnsiHex(mixHex(canvasHex(), textHex(), dim ? 0.08 : 0.14));
}

/** Tinted chip: faint fill of a theme color with the full color as label. */
export function tintChip(label: string, hex: string): string {
	return `${bgAnsiHex(mixHex(canvasHex(), hex, 0.18))}${fgAnsiHex(hex)}${label}\x1b[0m`;
}

/** Subtle toggle chip: accent fill when active, neutral surface otherwise. */
export function softPill(label: string, options: { active?: boolean } = {}): string {
	if (options.active) return chipFill(label, theme.getColorHex("accent"));
	const canvas = canvasHex();
	return `${bgAnsiHex(mixHex(canvas, textHex(), 0.1))}${fgAnsiHex(mixHex(canvas, textHex(), 0.62))}${label}\x1b[0m`;
}
