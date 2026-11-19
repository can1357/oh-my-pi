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

/** SGR "off" code that undoes each attribute an inline status may switch on. */
const SGR_ATTRIBUTE_OFF: Readonly<Record<number, number>> = {
	1: 22,
	2: 22,
	3: 23,
	4: 24,
	5: 25,
	6: 25,
	7: 27,
	8: 28,
	9: 29,
};
const SGR_ATTRIBUTE_RESETS: ReadonlySet<number> = new Set(Object.values(SGR_ATTRIBUTE_OFF));

/** Sub-parameter count after the `5` / `2` selector of an extended colour (`38;5;n`, `38;2;r;g;b`). */
const EXTENDED_COLOR_ARGS: Readonly<Record<string, number>> = { "5": 1, "2": 3 };

/** What the surrounding bar paints that a status's own resets must not cancel. */
export interface InlineStatusInherit {
	/** Foreground ANSI to restore after a status resets its foreground (the segment's base colour). */
	fg?: string;
	/** The bar is faint (`ESC[2m`); `ESC[22m` closing a bold/dim re-opens it. */
	faint?: boolean;
}

interface InlineSgrState {
	fg: boolean;
	off: Set<number>;
	inherit: InlineStatusInherit;
}

/**
 * Rewrite one `ESC [ <params> m` into what an inline status may keep: foreground
 * colours, text attributes, and resets. `state` tracks what the status has switched on
 * so a reset closes only that, never the bar's own background, and the inherited
 * foreground and faint are re-applied after anything that would have cancelled them.
 */
function rewriteInlineSgr(body: string, state: InlineSgrState): string {
	const params = body === "" ? ["0"] : body.split(";");
	const kept: string[] = [];
	let fgReset = false;
	let faintOff = false;
	const close = (): void => {
		if (state.off.size > 0) kept.push([...state.off].sort((a, b) => a - b).join(";"));
		if (state.fg) {
			kept.push("39");
			fgReset = true;
		}
		faintOff ||= state.off.has(22);
		state.off.clear();
		state.fg = false;
	};
	for (let i = 0; i < params.length; i++) {
		const param = params[i];
		const code = param === "" ? 0 : Number.parseInt(param, 10);
		if (code === 0) close();
		else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
			kept.push(param);
			state.fg = true;
		} else if (code === 38 || code === 48 || code === 58) {
			// Colon form carries its arguments in this parameter; semicolon form spans the next ones.
			let consumed = 0;
			if (!param.includes(":")) {
				const args = EXTENDED_COLOR_ARGS[params[i + 1] ?? ""];
				consumed = args === undefined ? params.length : 1 + args;
			}
			const complete = consumed === 0 || i + consumed < params.length;
			if (code === 38 && complete) {
				kept.push(...params.slice(i, i + consumed + 1));
				state.fg = true;
			}
			i += consumed;
		} else if (code === 39) {
			if (state.fg) {
				kept.push(param);
				fgReset = true;
			}
			state.fg = false;
		} else if (SGR_ATTRIBUTE_OFF[code] !== undefined) {
			kept.push(param);
			state.off.add(SGR_ATTRIBUTE_OFF[code]);
		} else if (SGR_ATTRIBUTE_RESETS.has(code)) {
			if (state.off.delete(code)) {
				kept.push(param);
				faintOff ||= code === 22;
			}
		}
	}
	let out = kept.length > 0 ? `\x1b[${kept.join(";")}m` : "";
	if (faintOff && state.inherit.faint) out += "\x1b[2m";
	// A reset that leaves no foreground of the status's own falls back to the terminal default.
	if (fgReset && !state.fg && state.inherit.fg) out += state.inherit.fg;
	return out;
}

/**
 * {@link sanitizeHookStatusText} for text embedded in the status bar, which paints a
 * background (and, while focus-proxied, a faint) of its own. Keeps foreground colours and
 * text attributes but drops background colours and everything else, and turns each reset
 * into the exact closing of what the status opened, so the bar's background survives.
 * `inherit` names the bar's foreground and faint, which are re-applied after a reset
 * inside the status would otherwise cancel them. Unstyled input is byte-identical to
 * {@link sanitizeStatusText}.
 */
export function sanitizeInlineStatusText(input: string, inherit: InlineStatusInherit = {}): string {
	const text = sanitizeHookStatusText(input);
	if (!text.includes("\x1b")) return text;
	const state: InlineSgrState = { fg: false, off: new Set<number>(), inherit };
	return text.replace(/\x1b\[([0-9;:]*)m/g, (_, body: string) => rewriteInlineSgr(body, state));
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
