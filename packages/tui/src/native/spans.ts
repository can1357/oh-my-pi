/**
 * ANSI-styled text → escape-free spans and plain text.
 *
 * Most components receive text that callers already styled for the ANSI
 * renderer (`theme.fg("toolTitle", x)`, opaque `(text) => string` stylers).
 * The native path must not carry escapes, so {@link styledSpans} parses SGR
 * and OSC 8 back into spans whose `s` tokens are the omp theme colour names
 * the escapes came from (reverse-mapped through the active theme), plus the
 * semantic attribute tokens (`strong`, `em`, `dim`, `del`, `mark`).
 *
 * Every described string is sanitized the same way: escapes dropped (one
 * escape grammar for spans and plain text), control characters and lone
 * surrogates removed, tabs expanded.
 */
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { TspSpan, TspText } from "@oh-my-pi/pi-wire";
import darkThemeJson from "../theme/dark.json" with { type: "json" };
import { isValidThemeColor, type Theme, type ThemeBg, type ThemeColor, theme } from "../theme/theme";
import { replaceTabs } from "../utils";
import { span, text } from "./describe";
import type { NativeNode } from "./node";

/** Theme colour names in schema order; basic tokens (`accent`, `success`, …) precede derived ones, so they win ties. */
const THEME_COLOR_NAMES: readonly ThemeColor[] = Object.keys(darkThemeJson.colors).filter(isValidThemeColor);

/** Background tokens in tie-breaking priority. */
const THEME_BG_NAMES: readonly ThemeBg[] = [
	"userMessageBg",
	"toolErrorBg",
	"toolSuccessBg",
	"toolPendingBg",
	"customMessageBg",
	"selectedBg",
	"statusLineBg",
];

/** Basic 16-colour SGR foregrounds mapped to semantic tokens. */
const BASIC_FG_TOKENS: Readonly<Record<number, string>> = {
	31: "error",
	32: "success",
	33: "warning",
	34: "info",
	35: "accent",
	36: "info",
	90: "dim",
	91: "error",
	92: "success",
	93: "warning",
	94: "info",
	95: "accent",
	96: "info",
};

/**
 * CSI, OSC and DCS/APC/PM/SOS strings (BEL or ST terminated: the TUI's cursor
 * marker is a BEL-terminated APC), and two-byte escapes.
 */
const ESCAPE_PATTERN =
	/\x1b(?:\[([0-?]*)[ -/]*([@-~])|\]([^\x07\x1b]*)(?:\x07|\x1b\\)|[P_^X][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

interface ThemeReverse {
	fg: Map<string, ThemeColor>;
	bg: Map<string, ThemeBg>;
}

/** Reverse map of the last theme seen; one theme is active at a time. */
let reverseCache: { theme: Theme; reverse: ThemeReverse } | undefined;

function parseParams(raw: string): number[] {
	if (raw === "") return [0];
	return raw.split(/[;:]/).map(part => (part === "" ? 0 : Number.parseInt(part, 10)));
}

/** Canonical colour key of an SGR colour selector (`38`/`48` extended or a basic code). */
function colorKey(params: readonly number[], index: number): { key: string; consumed: number } | undefined {
	const mode = params[index + 1];
	if (mode === 5 && params[index + 2] !== undefined) return { key: `5;${params[index + 2]}`, consumed: 2 };
	if (mode === 2 && params[index + 4] !== undefined) {
		return { key: `2;${params[index + 2]};${params[index + 3]};${params[index + 4]}`, consumed: 4 };
	}
	return undefined;
}

/** Colour key of a single-colour escape like `\x1b[38;2;1;2;3m`; undefined for default/reset escapes. */
function escapeColorKey(escape: string): string | undefined {
	const match = /^\x1b\[([0-9;:]*)m$/.exec(escape);
	if (!match) return undefined;
	const params = parseParams(match[1]!);
	const first = params[0];
	if (first === 38 || first === 48) return colorKey(params, 0)?.key;
	if (first !== undefined && ((first >= 30 && first <= 37) || (first >= 90 && first <= 97))) return `b;${first}`;
	if (first !== undefined && ((first >= 40 && first <= 47) || (first >= 100 && first <= 107))) {
		return `b;${first - 10}`;
	}
	return undefined;
}

function reverseFor(active: Theme): ThemeReverse {
	if (reverseCache?.theme === active) return reverseCache.reverse;
	const reverse: ThemeReverse = { fg: new Map(), bg: new Map() };
	for (const name of THEME_COLOR_NAMES) {
		let escape: string;
		try {
			escape = active.getFgAnsi(name);
		} catch {
			continue;
		}
		const key = escapeColorKey(escape);
		if (key !== undefined && !reverse.fg.has(key)) reverse.fg.set(key, name);
	}
	for (const name of THEME_BG_NAMES) {
		let escape: string;
		try {
			escape = active.getBgAnsi(name);
		} catch {
			continue;
		}
		const key = escapeColorKey(escape);
		if (key !== undefined && !reverse.bg.has(key)) reverse.bg.set(key, name);
	}
	reverseCache = { theme: active, reverse };
	return reverse;
}

/** The active theme's reverse map, or undefined before a theme is initialized. */
function activeReverse(): ThemeReverse | undefined {
	// `theme` is a live binding that stays undefined until initTheme runs.
	const active: Theme | undefined = theme;
	return active ? reverseFor(active) : undefined;
}

interface SgrState {
	bold: boolean;
	dim: boolean;
	italic: boolean;
	strike: boolean;
	inverse: boolean;
	fg: string | undefined;
	bg: string | undefined;
	href: string | undefined;
}

function initialState(): SgrState {
	return {
		bold: false,
		dim: false,
		italic: false,
		strike: false,
		inverse: false,
		fg: undefined,
		bg: undefined,
		href: undefined,
	};
}

function resetState(state: SgrState): void {
	state.bold = false;
	state.dim = false;
	state.italic = false;
	state.strike = false;
	state.inverse = false;
	state.fg = undefined;
	state.bg = undefined;
}

function applySgr(state: SgrState, raw: string): void {
	const params = parseParams(raw);
	for (let i = 0; i < params.length; i++) {
		const code = params[i]!;
		if (code === 0) resetState(state);
		else if (code === 1) state.bold = true;
		else if (code === 2) state.dim = true;
		else if (code === 3) state.italic = true;
		else if (code === 7) state.inverse = true;
		else if (code === 9) state.strike = true;
		else if (code === 22) {
			state.bold = false;
			state.dim = false;
		} else if (code === 23) state.italic = false;
		else if (code === 27) state.inverse = false;
		else if (code === 29) state.strike = false;
		else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) state.fg = `b;${code}`;
		else if (code === 39) state.fg = undefined;
		else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) state.bg = `b;${code - 10}`;
		else if (code === 49) state.bg = undefined;
		else if (code === 38 || code === 48) {
			const color = colorKey(params, i);
			if (color) {
				if (code === 38) state.fg = color.key;
				else state.bg = color.key;
				i += color.consumed;
			}
		}
	}
}

function fgToken(key: string | undefined, reverse: ThemeReverse | undefined): string | undefined {
	if (key === undefined) return undefined;
	const named = reverse?.fg.get(key);
	// `text` is the terminal's own foreground: no information on the native path.
	if (named !== undefined) return named === "text" ? undefined : named;
	if (key.startsWith("b;")) return BASIC_FG_TOKENS[Number(key.slice(2))];
	return undefined;
}

function styleTokens(state: SgrState, reverse: ThemeReverse | undefined): string | undefined {
	const tokens: string[] = [];
	const fg = fgToken(state.fg, reverse);
	if (fg !== undefined) tokens.push(fg);
	if (state.bold) tokens.push("strong");
	if (state.dim) tokens.push("dim");
	if (state.italic) tokens.push("em");
	if (state.strike) tokens.push("del");
	if (state.inverse || (state.bg !== undefined && reverse?.bg.get(state.bg) === "selectedBg")) tokens.push("mark");
	return tokens.length > 0 ? tokens.join(" ") : undefined;
}

/** Escape-free display text: control characters and lone surrogates removed, tabs expanded. */
function clean(content: string): string {
	return replaceTabs(sanitizeText(content));
}

function pushSpan(spans: TspSpan[], content: string, s: string | undefined, href: string | undefined): void {
	const cleaned = clean(content);
	if (cleaned === "") return;
	const last = spans[spans.length - 1];
	if (last !== undefined && last.s === s && last.href === href) {
		last.t += cleaned;
		return;
	}
	spans.push(href === undefined ? span(cleaned, s) : span(cleaned, s, { href }));
}

/**
 * Convert ANSI-styled text into escape-free spans. SGR colours map back to
 * the omp theme tokens that produced them; OSC 8 becomes `href`; every other
 * escape (cursor moves, APC markers) is dropped.
 */
export function styledSpans(styled: string): TspSpan[] {
	const spans: TspSpan[] = [];
	if (!styled.includes("\x1b")) {
		pushSpan(spans, styled, undefined, undefined);
		return spans;
	}
	const reverse = activeReverse();
	const state = initialState();
	let cursor = 0;
	ESCAPE_PATTERN.lastIndex = 0;
	for (let match = ESCAPE_PATTERN.exec(styled); match !== null; match = ESCAPE_PATTERN.exec(styled)) {
		if (match.index > cursor) {
			pushSpan(spans, styled.slice(cursor, match.index), styleTokens(state, reverse), state.href);
		}
		cursor = match.index + match[0].length;
		if (match[2] === "m") applySgr(state, match[1] ?? "");
		else if (match[3]?.startsWith("8;")) {
			const uri = match[3].slice(match[3].indexOf(";", 2) + 1);
			state.href = uri === "" ? undefined : uri;
		}
	}
	if (cursor < styled.length) pushSpan(spans, styled.slice(cursor), styleTokens(state, reverse), state.href);
	return spans;
}

/** The visible characters of ANSI-styled text: every escape dropped, sanitized like {@link styledSpans}. */
export function plainText(styled: string): string {
	return clean(styled.includes("\x1b") ? styled.replace(ESCAPE_PATTERN, "") : styled);
}

/** {@link plainText} as a single-line label: line breaks and whitespace runs collapse to one space. */
export function plainLine(styled: string): string {
	return plainText(styled)
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Spans for plain text passed through an optional ANSI styler. */
export function styleSpans(content: string, style?: (text: string) => string): TspSpan[] {
	return styledSpans(style ? style(content) : content);
}

/** Collapse unstyled single-span text to a plain string (smaller frames). */
export function compactText(spans: readonly TspSpan[]): TspText {
	if (spans.length === 0) return "";
	if (spans.length === 1 && spans[0]!.s === undefined && spans[0]!.href === undefined && spans[0]!.fx === undefined) {
		return spans[0]!.t;
	}
	return spans;
}

/** Pre-rendered ANSI rows as one unwrapped text block (rows already carry their line breaks). */
export function rowsText(lines: readonly string[]): NativeNode {
	return text(compactText(styledSpans(lines.join("\n"))), { wrap: "none" });
}

/** Theme background token of the first SGR background in ANSI-styled text. */
export function styledBackground(styled: string): ThemeBg | undefined {
	const reverse = activeReverse();
	if (!reverse) return undefined;
	ESCAPE_PATTERN.lastIndex = 0;
	for (let match = ESCAPE_PATTERN.exec(styled); match !== null; match = ESCAPE_PATTERN.exec(styled)) {
		if (match[2] !== "m") continue;
		const state = initialState();
		applySgr(state, match[1] ?? "");
		if (state.bg !== undefined) return reverse.bg.get(state.bg);
	}
	return undefined;
}
