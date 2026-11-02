import type { TabBarTheme } from "../components/tab-bar";
import { sanitizeDisplaySingleLine } from "../overlays/extensions/display-text";
import { theme } from "../theme/index";
// ═══════════════════════════════════════════════════════════════════════════
// Text Sanitization
// ═══════════════════════════════════════════════════════════════════════════

/** Compact single-line display text for statuses; unlike titles, collapse padding and trim. */
export function sanitizeStatusText(text: string): string {
	return sanitizeDisplaySingleLine(text).replace(/ +/g, " ").trim();
}

/** 7-bit SGR (`ESC [ <params> m`) — the one escape family a hook status may keep. */
const SGR_RE = /\x1b\[[0-9;:]*m/g;
const SGR_RESET = "\x1b[0m";
const WHITESPACE_RE = /\s/;

/**
 * Like {@link sanitizeStatusText}, but keeps 7-bit SGR so extensions can colour
 * `ctx.ui.setStatus` text. Every other escape (OSC links/titles, DCS/PM/APC,
 * 7- and 8-bit CSI), C0/C1, lone surrogates, newlines and tabs are sanitized at
 * least as strictly as in `sanitizeStatusText`; space runs collapse and edges
 * trim (`String#trim` whitespace) by visible text, regardless of SGR placement.
 * A styled result always ends with `\x1b[0m`.
 */
export function sanitizeHookStatusText(input: string): string {
	// Drop lone surrogates before splitting, as `sanitizeText` does, so stripped escapes
	// cannot fuse surrogate halves from neighbouring chunks into a new character.
	const wellFormed = input.toWellFormed();
	const text = wellFormed === input ? input : wellFormed.replaceAll("\ufffd", "");
	SGR_RE.lastIndex = 0;
	if (!SGR_RE.test(text)) return sanitizeStatusText(text); // byte-identical for unstyled input
	let out = "";
	// SGR codes and whitespace seen since the last visible char, in source order.
	let pending = "";
	let lastWasSpace = false;
	let hasVisible = false;
	let cursor = 0;
	SGR_RE.lastIndex = 0;
	for (;;) {
		const match = SGR_RE.exec(text);
		// `sanitizeText` runs `Bun.stripANSI` only when an ESC is present; a chunk between SGR
		// codes often has none, so strip explicitly to drop 8-bit (C1) sequence payloads.
		const chunk = sanitizeDisplaySingleLine(Bun.stripANSI(text.slice(cursor, match ? match.index : text.length)));
		for (const ch of chunk) {
			if (WHITESPACE_RE.test(ch)) {
				// Leading whitespace drops; ASCII space runs collapse even across SGR codes.
				if (hasVisible && !(ch === " " && lastWasSpace)) pending += ch;
				lastWasSpace = ch === " ";
				continue;
			}
			out += pending + ch;
			pending = "";
			lastWasSpace = false;
			hasVisible = true;
		}
		if (!match) break;
		pending += match[0];
		cursor = match.index + match[0].length;
	}
	if (!hasVisible) return "";
	// Trailing whitespace trims; trailing SGR codes stay (they never contain whitespace).
	return out + pending.replace(/\s+/g, "") + SGR_RESET;
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
