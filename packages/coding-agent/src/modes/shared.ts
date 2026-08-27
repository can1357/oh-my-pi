import type { TabBarTheme } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { theme } from "./theme/theme";

// ═══════════════════════════════════════════════════════════════════════════
// Text Sanitization
// ═══════════════════════════════════════════════════════════════════════════

/** Sanitize text for display in a single-line status. Strips ANSI/VT escape sequences, maps remaining C0/C1 control characters to spaces, collapses whitespace, trims. */

export function sanitizeStatusText(text: string): string {
	return sanitizeText(text)
		.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

// ═══════════════════════════════════════════════════════════════════════════
// Tab Bar Theme
// ═══════════════════════════════════════════════════════════════════════════

/** Shared tab bar theme used by fullscreen overlays (settings, agent hub). */
export function getTabBarTheme(): TabBarTheme {
	return {
		label: (text: string) => theme.bold(theme.fg("accent", text)),
		activeTab: (text: string) => theme.bold(theme.bg("selectedBg", theme.fg("text", text))),
		inactiveTab: (text: string) => theme.fg("muted", text),
		mutedTab: (text: string) => theme.fg("dim", text),
		hoverTab: (text: string) => theme.bg("selectedBg", theme.fg("text", text)),
		hint: (text: string) => theme.fg("dim", text),
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Working-message hint
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Suffix appended to the loader's working message to remind users they can
 * abort with Esc. Rendered with the active theme's bracket glyphs so it stays
 * visually consistent with badges and other bracketed UI affordances.
 *
 * The leading space separates the hint from the message body and is consumed
 * by `endsWith`/`slice` matching in the loader renderer.
 */
export function interruptHint(): string {
	return ` ${theme.format.bracketLeft}esc${theme.format.bracketRight}`;
}

export { parseCommandArgs } from "../utils/command-args";
