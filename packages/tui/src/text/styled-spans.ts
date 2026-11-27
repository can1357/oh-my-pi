/**
 * ANSI-styled text as escape-free spans and plain text.
 *
 * Reports and status text arrive already styled for terminal rows
 * (`theme.fg("accent", x)`). The native path carries no escapes, so
 * {@link styledSpans} reads SGR and OSC 8 back into spans whose `s` tokens are
 * the theme color keys the escapes came from (reverse-mapped through the
 * active theme), plus the attribute tokens `strong`, `dim`, `em`, `del` and
 * `mark`. Every other escape is dropped; control characters and lone
 * surrogates are removed and tabs expanded.
 */
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import DARK from "../theme/data/dark.json" with { type: "json" };
import { currentTheme } from "../theme/runtime";
import { type BackgroundKey, type ForegroundKey, isForegroundKey } from "../theme/schema";
import type { ResolvedTheme } from "../theme/theme";
import { sgrParams, stripEscapes, tokens } from "./ansi";
import { replaceTabs } from "./width";

/** Foreground keys in theme-file order: basic keys (`accent`, `success`, …) precede derived ones, so they win ties. */
const FOREGROUND_NAMES: readonly ForegroundKey[] = Object.keys(DARK.colors).filter(isForegroundKey);

/** Background keys in tie-breaking priority. */
const BACKGROUND_NAMES: readonly BackgroundKey[] = [
	"userMessageBg",
	"toolErrorBg",
	"toolSuccessBg",
	"toolPendingBg",
	"customMessageBg",
	"selectedBg",
	"statusLineBg",
];

/** Basic 16-color SGR foregrounds as semantic tokens. */
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

/** The target of an OSC 8 hyperlink sequence (empty: the link ends). */
const HYPERLINK = /^\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)/;

interface ThemeReverse {
	readonly fg: Map<string, ForegroundKey>;
	readonly bg: Map<string, BackgroundKey>;
}

/** Reverse map of the last theme seen; one theme is active at a time. */
let reverseCache: { readonly theme: ResolvedTheme; readonly reverse: ThemeReverse } | undefined;

function parseParams(raw: string): number[] {
	if (raw === "") return [0];
	return raw.split(/[;:]/).map(part => (part === "" ? 0 : Number.parseInt(part, 10)));
}

/** Canonical key of the extended color selector (`38`/`48`) at `index`, and the parameters it takes. */
function colorKey(params: readonly number[], index: number): { key: string; consumed: number } | undefined {
	const mode = params[index + 1];
	if (mode === 5 && params[index + 2] !== undefined) return { key: `5;${params[index + 2]}`, consumed: 2 };
	if (mode === 2 && params[index + 4] !== undefined) {
		return { key: `2;${params[index + 2]};${params[index + 3]};${params[index + 4]}`, consumed: 4 };
	}
	return undefined;
}

/** Color key of a single-color SGR like `ESC[38;2;1;2;3m`; undefined for default and reset sequences. */
function sgrColorKey(sgr: string): string | undefined {
	const raw = sgrParams(sgr);
	if (raw === undefined) return undefined;
	const params = parseParams(raw);
	const first = params[0];
	if (first === undefined) return undefined;
	if (first === 38 || first === 48) return colorKey(params, 0)?.key;
	if ((first >= 30 && first <= 37) || (first >= 90 && first <= 97)) return `b;${first}`;
	if ((first >= 40 && first <= 47) || (first >= 100 && first <= 107)) return `b;${first - 10}`;
	return undefined;
}

function reverseFor(theme: ResolvedTheme): ThemeReverse {
	if (reverseCache?.theme === theme) return reverseCache.reverse;
	const reverse: ThemeReverse = { fg: new Map(), bg: new Map() };
	for (const name of FOREGROUND_NAMES) {
		const key = theme.has(name) ? sgrColorKey(theme.fgSgr(name)) : undefined;
		if (key !== undefined && !reverse.fg.has(key)) reverse.fg.set(key, name);
	}
	for (const name of BACKGROUND_NAMES) {
		const key = theme.has(name) ? sgrColorKey(theme.bgSgr(name)) : undefined;
		if (key !== undefined && !reverse.bg.has(key)) reverse.bg.set(key, name);
	}
	reverseCache = { theme, reverse };
	return reverse;
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

function applySgr(state: SgrState, raw: string): void {
	const params = parseParams(raw);
	for (let i = 0; i < params.length; i++) {
		const code = params[i]!;
		if (code === 0) {
			state.bold = false;
			state.dim = false;
			state.italic = false;
			state.strike = false;
			state.inverse = false;
			state.fg = undefined;
			state.bg = undefined;
		} else if (code === 1) state.bold = true;
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
			if (!color) continue;
			if (code === 38) state.fg = color.key;
			else state.bg = color.key;
			i += color.consumed;
		}
	}
}

function foregroundToken(key: string | undefined, reverse: ThemeReverse): string | undefined {
	if (key === undefined) return undefined;
	const named = reverse.fg.get(key);
	// `text` is the terminal's own foreground: it says nothing natively.
	if (named !== undefined) return named === "text" ? undefined : named;
	return key.startsWith("b;") ? BASIC_FG_TOKENS[Number(key.slice(2))] : undefined;
}

function styleTokens(state: SgrState, reverse: ThemeReverse): string | undefined {
	const style: string[] = [];
	const fg = foregroundToken(state.fg, reverse);
	if (fg !== undefined) style.push(fg);
	if (state.bold) style.push("strong");
	if (state.dim) style.push("dim");
	if (state.italic) style.push("em");
	if (state.strike) style.push("del");
	if (state.inverse || (state.bg !== undefined && reverse.bg.get(state.bg) === "selectedBg")) style.push("mark");
	return style.length > 0 ? style.join(" ") : undefined;
}

function pushSpan(spans: TspSpan[], content: string, s: string | undefined, href: string | undefined): void {
	const cleaned = replaceTabs(sanitizeText(content));
	if (cleaned === "") return;
	const last = spans[spans.length - 1];
	if (last !== undefined && last.s === s && last.href === href) {
		last.t += cleaned;
		return;
	}
	const span: TspSpan = { t: cleaned };
	if (s !== undefined) span.s = s;
	if (href !== undefined) span.href = href;
	spans.push(span);
}

/**
 * ANSI-styled text as escape-free spans: SGR colors become the theme keys they
 * came from, OSC 8 becomes `href`, every other escape is dropped.
 */
export function styledSpans(styled: string): TspSpan[] {
	const spans: TspSpan[] = [];
	if (!styled.includes("\x1b")) {
		pushSpan(spans, styled, undefined, undefined);
		return spans;
	}
	const reverse = reverseFor(currentTheme());
	const state: SgrState = {
		bold: false,
		dim: false,
		italic: false,
		strike: false,
		inverse: false,
		fg: undefined,
		bg: undefined,
		href: undefined,
	};
	for (const token of tokens(styled)) {
		if (!token.escape) {
			pushSpan(spans, token.text, styleTokens(state, reverse), state.href);
			continue;
		}
		const sgr = sgrParams(token.text);
		if (sgr !== undefined) {
			applySgr(state, sgr);
			continue;
		}
		const link = HYPERLINK.exec(token.text);
		if (link) state.href = link[1] === "" ? undefined : link[1];
	}
	return spans;
}

/** The visible characters of ANSI-styled text: every escape dropped, sanitized like {@link styledSpans}. */
export function unstyledText(styled: string): string {
	return replaceTabs(sanitizeText(stripEscapes(styled)));
}
