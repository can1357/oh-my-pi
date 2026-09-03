import { replaceTabs, type TabBarTheme } from "@oh-my-pi/pi-tui";
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

/**
 * Sanitize extension-provided status content for a single-line status while
 * preserving a segment's themed color. Only complete SGR sequences (`\x1b[…m`)
 * survive; every other escape sequence (cursor moves, OSC hyperlinks, screen
 * clears) is stripped, and all C0/C1 controls — including tabs, newlines, and
 * carriage returns that would break the one-row status bar — are mapped to a
 * space. Runs are then collapsed and the ends trimmed.
 */
export function sanitizeStyledStatusText(text: string): string {
	// A capturing split isolates SGR sequences at odd indices (kept verbatim);
	// the surrounding text has tabs expanded via the central helper, then any
	// remaining ANSI and C0/C1 control bytes scrubbed to spaces.
	return text
		.split(/(\x1b\[[0-9;:]*m)/g)
		.map((part, index) =>
			index % 2 === 1 ? part : Bun.stripANSI(replaceTabs(part)).replace(/[\u0000-\u001f\u007f-\u009f]/g, " "),
		)
		.join("")
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

export { parseCommandArgs } from "../utils/command-args";
