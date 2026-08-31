import { detectTerminalId, getTerminalInfo } from "@oh-my-pi/pi-tui";
import { relativeLuminance } from "@oh-my-pi/pi-utils";
import type { ColorMode, ColorValue } from "./schema";

// ============================================================================
// Color Utilities
// ============================================================================

/** Resolve theme color depth from the shared terminal capability model. */
export function detectColorMode(env: NodeJS.ProcessEnv = Bun.env): ColorMode {
	if (env.WT_SESSION) return "truecolor";
	const terminal = getTerminalInfo(detectTerminalId(env), process.platform, env);
	return terminal.trueColor ? "truecolor" : "256color";
}

export function colorToAnsi(color: string, mode: ColorMode): string {
	const format = mode === "truecolor" ? "ansi-16m" : "ansi-256";
	const ansi = Bun.color(color, format);
	if (ansi === null) {
		throw new Error(`Invalid color value: ${color}`);
	}
	return ansi;
}

export function fgAnsi(color: string | number, mode: ColorMode): string {
	if (color === "") return "\x1b[39m";
	if (typeof color === "number") return `\x1b[38;5;${color}m`;
	if (typeof color === "string") {
		return colorToAnsi(color, mode);
	}
	throw new Error(`Invalid color value: ${color}`);
}

export function bgAnsi(color: string | number, mode: ColorMode): string {
	if (color === "") return "\x1b[49m";
	if (typeof color === "number") return `\x1b[48;5;${color}m`;
	const ansi = colorToAnsi(color, mode);
	return ansi.replace("\x1b[38;", "\x1b[48;");
}

export function resolveVarRefs(
	value: ColorValue,
	vars: Record<string, ColorValue>,
	visited = new Set<string>(),
): string | number {
	if (typeof value === "number" || value === "" || value.startsWith("#")) {
		return value;
	}
	if (visited.has(value)) {
		throw new Error(`Circular variable reference detected: ${value}`);
	}
	if (!(value in vars)) {
		throw new Error(`Variable reference not found: ${value}`);
	}
	visited.add(value);
	return resolveVarRefs(vars[value], vars, visited);
}

export function resolveThemeColors<T extends Record<string, ColorValue>>(
	colors: T,
	vars: Record<string, ColorValue> = {},
): Record<keyof T, string | number> {
	const resolved: Record<string, string | number> = {};
	for (const [key, value] of Object.entries(colors)) {
		resolved[key] = resolveVarRefs(value, vars);
	}
	return resolved as Record<keyof T, string | number>;
}

/**
 * Minimum WCAG contrast ratio for the accent to qualify as user bubble text —
 * the AA bar for large text / UI components. Body text asks for 4.5, but the
 * state this replaces offered no distinction at all, and any theme can set
 * `userMessageText` explicitly to opt out.
 */
const USER_MESSAGE_ACCENT_CONTRAST_MIN = 3;

/**
 * Themes that leave `userMessageText` unset paint user input with the terminal
 * default — indistinguishable from assistant output (#1633). Inherit the theme
 * accent when it stays readable on the bubble background; otherwise return the
 * token unchanged so `Theme.getFgOnBgAnsi` keeps its near-black/near-white
 * fallback. Explicit non-empty theme values always win; `""` derives.
 */
export function deriveUserMessageTextDefault(
	resolved: Record<string, string | number>,
	surface?: string,
	mode?: ColorMode,
): string | number {
	const current = resolved.userMessageText;
	if (current !== undefined && current !== "") return current;
	const accent = resolved.accent;
	if (accent === undefined || accent === "") return current ?? "";
	const background = surface ?? resolved.userMessageBg;
	const accentLuminance = relativeLuminance(renderedHex(accent, mode));
	const backgroundLuminance = relativeLuminance(renderedHex(background, mode));
	if (accentLuminance === undefined || backgroundLuminance === undefined) return current ?? "";
	const contrast =
		(Math.max(accentLuminance, backgroundLuminance) + 0.05) / (Math.min(accentLuminance, backgroundLuminance) + 0.05);
	return contrast >= USER_MESSAGE_ACCENT_CONTRAST_MIN ? accent : (current ?? "");
}

/**
 * Hex actually painted for a color token in `mode`. Truecolor terminals render
 * the value as-is; 256-color terminals quantize both the accent and the bubble
 * to the xterm palette, so contrast decisions must use the quantized pair —
 * e.g. limestone passes 3.38:1 in truecolor but its palette colors (137 on
 * 255) only reach 2.80:1 (#10344 review).
 */
function renderedHex(value: string | number, mode: ColorMode | undefined): string | number {
	if (mode !== "256color") return value;
	const ansi = colorToAnsi(typeof value === "number" ? ansi256ToHex(value) : value, mode);
	const paletteIndex = /38;5;(\d+)/.exec(ansi);
	return paletteIndex ? ansi256ToHex(Number(paletteIndex[1])) : value;
}

/**
 * Resolve a theme color value (hex string or 256-color index) to a CSS hex string.
 * Empty string represents the default terminal color.
 */
export function resolveToHex(value: string | number, isLight: boolean): string {
	if (typeof value === "number") return ansi256ToHex(value);
	if (value === "") return isLight ? "#000000" : "#e5e5e7";
	return value;
}

/**
 * Convert a 256-color index to hex string.
 * Indices 0-15: basic colors (approximate)
 * Indices 16-231: 6x6x6 color cube
 * Indices 232-255: grayscale ramp
 */
export function ansi256ToHex(index: number): string {
	// Basic colors (0-15) - approximate common terminal values
	const basicColors = [
		"#000000",
		"#800000",
		"#008000",
		"#808000",
		"#000080",
		"#800080",
		"#008080",
		"#c0c0c0",
		"#808080",
		"#ff0000",
		"#00ff00",
		"#ffff00",
		"#0000ff",
		"#ff00ff",
		"#00ffff",
		"#ffffff",
	];
	if (index < 16) {
		return basicColors[index];
	}

	// Color cube (16-231): 6x6x6 = 216 colors
	if (index < 232) {
		const cubeIndex = index - 16;
		const r = Math.floor(cubeIndex / 36);
		const g = Math.floor((cubeIndex % 36) / 6);
		const b = cubeIndex % 6;
		const toHex = (n: number) => (n === 0 ? 0 : 55 + n * 40).toString(16).padStart(2, "0");
		return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
	}

	// Grayscale (232-255): 24 shades
	const gray = 8 + (index - 232) * 10;
	const grayHex = gray.toString(16).padStart(2, "0");
	return `#${grayHex}${grayHex}${grayHex}`;
}
