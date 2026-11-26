/**
 * Truecolor surfaces of the git app's terminal look, all derived from the
 * active theme: tints mix theme colors toward the theme's canvas (its status
 * line background), filled pills pick their label contrast from the fill's
 * luminance.
 */
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { colorLuma, hexToRgb, mixHex } from "@oh-my-pi/pi-utils/color";

const RESET = "\x1b[0m";

/** Truecolor foreground escape of a hex color. */
export function fgHex(hex: string): string {
	const { r, g, b } = hexToRgb(hex);
	return `\x1b[38;2;${r};${g};${b}m`;
}

/** Truecolor background escape of a hex color. */
export function bgHex(hex: string): string {
	const { r, g, b } = hexToRgb(hex);
	return `\x1b[48;2;${r};${g};${b}m`;
}

/** The surface tints blend toward: the theme's status line background. */
export function canvasHex(theme: Theme): string {
	const hex = theme.hex("statusLineBg");
	return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : theme.dark ? "#000000" : "#ffffff";
}

/** A label color readable on `fill`. */
function contrastOn(fill: string): string {
	return colorLuma(fill)! > 0.5 ? mixHex(fill, "#000000", 0.82) : mixHex(fill, "#ffffff", 0.92);
}

/** `text` on `bg`, the background re-opened after every reset inside it. */
export function withBg(text: string, bg: string): string {
	return bg + text.replaceAll(RESET, `${RESET}${bg}`).replaceAll("\x1b[49m", bg);
}

/** The selected-row band: the canvas nudged toward the text color (fainter when `dim`). */
export function selectionBg(theme: Theme, dim = false): string {
	return bgHex(mixHex(canvasHex(theme), theme.hex("text"), dim ? 0.08 : 0.14));
}

/** A row in the selection band (reset at its end). */
export function selectedRow(theme: Theme, text: string): string {
	return `${withBg(text, selectionBg(theme))}${RESET}`;
}

/** Filled pill button with half-block caps (`▐label▌`): `label` width plus two. */
export function pill(
	theme: Theme,
	label: string,
	hex: string,
	options: { selected?: boolean; dim?: boolean } = {},
): string {
	const fill = options.selected
		? mixHex(hex, theme.hex("text"), 0.22)
		: options.dim
			? mixHex(hex, canvasHex(theme), 0.55)
			: hex;
	return `${fgHex(fill)}▐${bgHex(fill)}${fgHex(contrastOn(fill))}${label}${RESET}${fgHex(fill)}▌${RESET}`;
}

/** Flat filled chip with a contrasting label. */
export function chipFill(label: string, hex: string): string {
	return `${bgHex(hex)}${fgHex(contrastOn(hex))}${label}${RESET}`;
}

/** Tinted chip: a faint fill of `hex` with the full color as label. */
export function tintChip(theme: Theme, label: string, hex: string): string {
	return `${bgHex(mixHex(canvasHex(theme), hex, 0.18))}${fgHex(hex)}${label}${RESET}`;
}

/** Toggle chip: accent fill when active, a neutral surface otherwise. */
export function softPill(theme: Theme, label: string, active: boolean): string {
	if (active) return chipFill(label, theme.hex("accent"));
	const canvas = canvasHex(theme);
	const text = theme.hex("text");
	return `${bgHex(mixHex(canvas, text, 0.1))}${fgHex(mixHex(canvas, text, 0.62))}${label}${RESET}`;
}
