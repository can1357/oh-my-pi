/**
 * Truecolor helpers for the git TUI, all derived from the active theme so the
 * view follows the user's palette: surface tints mix theme colors toward the
 * theme's own canvas, and filled pill buttons pick their label contrast from
 * the button color's luminance.
 */
import { theme } from "../../modes/theme/theme";

export function hexChannels(hex: string): [number, number, number] {
	const value = Number.parseInt(hex.replace("#", ""), 16);
	return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/** Linear blend of two hex colors (`t` = 0 → `a`, 1 → `b`). */
export function mixHex(a: string, b: string, t: number): string {
	const ca = hexChannels(a);
	const cb = hexChannels(b);
	const out = ca.map((channel, i) => Math.round(channel + (cb[i] - channel) * t));
	return `#${out.map(channel => channel.toString(16).padStart(2, "0")).join("")}`;
}

export function bgAnsi(hex: string): string {
	const [r, g, b] = hexChannels(hex);
	return `\x1b[48;2;${r};${g};${b}m`;
}

export function fgAnsi(hex: string): string {
	const [r, g, b] = hexChannels(hex);
	return `\x1b[38;2;${r};${g};${b}m`;
}

/** True when the theme sits on a dark surface. */
export function isDark(): boolean {
	return theme.statusLineLuminance === undefined || theme.statusLineLuminance <= 0.5;
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
	const [r, g, b] = hexChannels(hex);
	return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
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
	return `${fgAnsi(fill)}▐${bgAnsi(fill)}${fgAnsi(labelHex)}${label}\x1b[0m${fgAnsi(fill)}▌\x1b[0m`;
}

/**
 * Flat filled chip with a contrast-computed label — readable on any theme,
 * unlike accent-on-selection combinations that can collapse (e.g. dark blue
 * on light blue).
 */
export function chipFill(label: string, hex: string): string {
	const labelHex = luminance(hex) > 0.5 ? mixHex(hex, "#000000", 0.82) : mixHex(hex, "#ffffff", 0.92);
	return `${bgAnsi(hex)}${fgAnsi(labelHex)}${label}\x1b[0m`;
}

/**
 * Selection-row background: a canvas-adjacent surface (canvas nudged toward
 * the text color) so every theme foreground stays readable on it — unlike
 * `selectedBg`, which some themes define as a saturated color.
 * `dim` renders a fainter band for cursors in unfocused panes.
 */
export function selectionBgAnsi(dim = false): string {
	return bgAnsi(mixHex(canvasHex(), textHex(), dim ? 0.08 : 0.14));
}

/** Tinted chip: faint fill of a theme color with the full color as label. */
export function tintChip(label: string, hex: string): string {
	return `${bgAnsi(mixHex(canvasHex(), hex, 0.18))}${fgAnsi(hex)}${label}\x1b[0m`;
}

/** Subtle toggle chip: accent fill when active, neutral surface otherwise. */
export function softPill(label: string, options: { active?: boolean } = {}): string {
	if (options.active) return chipFill(label, theme.getColorHex("accent"));
	const canvas = canvasHex();
	return `${bgAnsi(mixHex(canvas, textHex(), 0.1))}${fgAnsi(mixHex(canvas, textHex(), 0.62))}${label}\x1b[0m`;
}
