import {
	type HighlightColors as NativeHighlightColors,
	HighlightStream as NativeHighlightStream,
	highlightCode as nativeHighlightCode,
	supportsLanguage as nativeSupportsLanguage,
	warmHighlighter as nativeWarmHighlighter,
} from "@oh-my-pi/pi-natives";
import type { EditorTheme, MarkdownTheme, SelectListTheme, SettingsListTheme, SymbolTheme } from "@oh-my-pi/pi-tui";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { LRUCache } from "@oh-my-pi/pi-utils/lru";
import { resolveMermaidAscii } from "./mermaid-cache";
import type { SlashCommandIconName } from "./symbols";
import { theme } from "./theme";
import type { Theme } from "./theme-class";

// ============================================================================
// TUI Helpers
// ============================================================================

let cachedHighlightColorsFor: Theme | undefined;
let cachedHighlightColors: NativeHighlightColors | undefined;

function getHighlightColors(t: Theme): NativeHighlightColors {
	if (cachedHighlightColorsFor !== t || !cachedHighlightColors) {
		cachedHighlightColorsFor = t;
		cachedHighlightColors = {
			comment: t.getFgAnsi("syntaxComment"),
			keyword: t.getFgAnsi("syntaxKeyword"),
			function: t.getFgAnsi("syntaxFunction"),
			variable: t.getFgAnsi("syntaxVariable"),
			string: t.getFgAnsi("syntaxString"),
			number: t.getFgAnsi("syntaxNumber"),
			type: t.getFgAnsi("syntaxType"),
			operator: t.getFgAnsi("syntaxOperator"),
			punctuation: t.getFgAnsi("syntaxPunctuation"),
			inserted: t.getFgAnsi("toolDiffAdded"),
			deleted: t.getFgAnsi("toolDiffRemoved"),
		};
	}
	return cachedHighlightColors;
}

/**
 * Memoized native syntax highlight. Returns the joined ANSI string, or `null`
 * when the native tokenizer throws so callers can apply their own fallback.
 *
 * Keyed on `(lang, code)` and reset whenever the active `theme` instance
 * changes — the ANSI colors are baked into the highlighted output, so a theme
 * switch (which always reassigns `theme`) must invalidate every entry.
 *
 * Why this exists: animated tool blocks (eval/bash) repaint their box on every
 * ~33ms border-shimmer frame, and markdown re-lexes on every streamed delta.
 * Without memoization each frame can re-tokenize an unchanged code body through
 * the Rust FFI — ~26ms for 100 lines, ~40ms for 150 — consuming or overrunning
 * the 33ms frame budget and starving the spinner/render timers (the "TUI freeze").
 */
const HIGHLIGHT_CACHE_MAX = 256;
const highlightCache = new LRUCache<string, string>({ max: HIGHLIGHT_CACHE_MAX });
let highlightCacheTheme: Theme | undefined;

function highlightCached(code: string, validLang: string | undefined, highlightTheme: Theme): string | null {
	if (validLang === undefined) return code;
	if (highlightCacheTheme !== highlightTheme) {
		highlightCache.clear();
		highlightCacheTheme = highlightTheme;
	}
	const key = `${validLang ?? ""}\x00${code}`;
	const hit = highlightCache.get(key);
	if (hit !== undefined) {
		return hit;
	}
	let highlighted: string;
	try {
		highlighted = nativeHighlightCode(code, validLang, getHighlightColors(highlightTheme));
	} catch {
		return null;
	}
	highlightCache.set(key, highlighted);
	return highlighted;
}

/**
 * Highlight code with syntax coloring based on file extension or language.
 * Returns array of highlighted lines.
 */
export function highlightCode(code: string, lang?: string, highlightTheme: Theme = theme): string[] {
	const validLang = lang && nativeSupportsLanguage(lang) ? lang : undefined;
	const highlighted = highlightCached(code, validLang, highlightTheme);
	// Always return a fresh array: callers (e.g. renderCodeCell) push extra lines
	// onto the result, which would corrupt the cached string otherwise.
	return (highlighted ?? code).split("\n");
}

/** Create a stateful highlighter for progressive terminal rendering. */
export function createHighlightStream(lang?: string, highlightTheme: Theme = theme): NativeHighlightStream | null {
	const validLang = lang && nativeSupportsLanguage(lang) ? lang : undefined;
	if (!validLang) return null;
	// Workspace loads skip the natives version sentinel, so a stale local
	// `.node` can omit `HighlightStream` after a pull. Napi constructors can
	// also throw; callers degrade to plain text instead of aborting a render.
	try {
		if (typeof NativeHighlightStream !== "function") return null;
		return new NativeHighlightStream(validLang, getHighlightColors(highlightTheme));
	} catch {
		return null;
	}
}

let highlighterWarmup: Promise<void> | undefined;

/** Warm native syntax grammars off-thread once per process. */
export function warmHighlighter(): Promise<void> {
	if (!highlighterWarmup) {
		highlighterWarmup =
			typeof nativeWarmHighlighter === "function"
				? nativeWarmHighlighter().catch(() => undefined)
				: Promise.resolve();
	}
	return highlighterWarmup;
}

export function getSymbolTheme(): SymbolTheme {
	// Guard against `theme` being undefined (pre-init or cross-module-instance
	// plugin calls). Fall back to the ASCII preset so the returned symbols are
	// usable instead of crashing. See #2998.
	if (typeof theme === "undefined") {
		const box = {
			topLeft: "+",
			topRight: "+",
			bottomLeft: "+",
			bottomRight: "+",
			horizontal: "-",
			vertical: "|",
			cross: "+",
			teeDown: "+",
			teeUp: "+",
			teeLeft: "+",
			teeRight: "+",
		};
		return {
			cursor: ">",
			inputCursor: "|",
			boxRound: box,
			boxSharp: box,
			table: box,
			quoteBorder: "|",
			hrChar: "-",
			colorSwatch: "[]",
			spinnerFrames: ["-", "\\", "|", "/"],
		};
	}
	const preset = theme.getSymbolPreset();

	return {
		cursor: theme.nav.cursor,
		inputCursor: preset === "ascii" ? "|" : "▏",
		boxRound: theme.boxRound,
		boxSharp: theme.boxSharp,
		table: theme.boxSharp,
		quoteBorder: theme.md.quoteBorder,
		hrChar: theme.md.hrChar,
		colorSwatch: theme.md.colorSwatch,
		spinnerFrames: theme.getSpinnerFrames("activity"),
	};
}

let cachedMarkdownTheme: MarkdownTheme | undefined;
let cachedMarkdownThemeRef: Theme | undefined;
let markdownMermaidRendering = true;

export function setMarkdownMermaidRendering(enabled: boolean): void {
	if (markdownMermaidRendering === enabled) return;
	markdownMermaidRendering = enabled;
	cachedMarkdownTheme = undefined;
}

export function getMarkdownTheme(): MarkdownTheme {
	if (cachedMarkdownTheme !== undefined && cachedMarkdownThemeRef === theme) {
		return cachedMarkdownTheme;
	}
	const mermaid = markdownMermaidRendering
		? (() => {
				// Diagram geometry is content, so keep every structural stroke on the
				// theme's readable muted foreground instead of subtle UI chrome borders.
				const mermaidColorMode =
					theme.getColorMode() === "truecolor" ? ("truecolor" as const) : ("ansi256" as const);
				const mermaidTheme = {
					fg: theme.getColorHex("text"),
					border: theme.getColorHex("muted"),
					line: theme.getColorHex("muted"),
					arrow: theme.getColorHex("accent"),
					corner: theme.getColorHex("muted"),
					junction: theme.getColorHex("muted"),
				};
				return { mermaidColorMode, mermaidTheme };
			})()
		: undefined;
	const markdownTheme: MarkdownTheme = {
		heading: (text: string) => theme.fg("mdHeading", text),
		link: (text: string) => theme.fg("mdLink", text),
		linkUrl: (text: string) => theme.fg("mdLinkUrl", text),
		code: (text: string) => theme.fg("mdCode", text),
		codeBlock: (text: string) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text: string) => theme.fg("mdCodeBlockBorder", text),
		quote: (text: string) => theme.fg("mdQuote", text),
		quoteBorder: (text: string) => theme.fg("mdQuoteBorder", text),
		hr: (text: string) => theme.fg("mdHr", text),
		listBullet: (text: string) => theme.fg("mdListBullet", text),
		bold: (text: string) => theme.bold(text),
		italic: (text: string) => theme.italic(text),
		underline: (text: string) => theme.underline(text),
		strikethrough: (text: string) => chalk.strikethrough(text),
		symbols: getSymbolTheme(),
		resolveMermaidAscii: mermaid
			? (source, maxWidth) =>
					resolveMermaidAscii(source, {
						maxWidth,
						theme: mermaid.mermaidTheme,
						colorMode: mermaid.mermaidColorMode,
					})
			: undefined,
		highlightCode: (code: string, lang?: string): string[] => {
			const validLang = lang && nativeSupportsLanguage(lang) ? lang : undefined;
			const highlighted = highlightCached(code, validLang, theme);
			if (highlighted !== null) return highlighted.split("\n");
			return code.split("\n").map(line => theme.fg("mdCodeBlock", line));
		},
		createHighlightStream: lang => createHighlightStream(lang, theme),
	};
	cachedMarkdownTheme = markdownTheme;
	cachedMarkdownThemeRef = theme;
	return markdownTheme;
}

export function getSelectListTheme(): SelectListTheme {
	// Guard against `theme` being undefined (pre-init or cross-module-instance
	// plugin calls). See #2998.
	if (typeof theme === "undefined") {
		return {
			selectedPrefix: (text: string) => text,
			selectedText: (text: string) => text,
			description: (text: string) => text,
			scrollInfo: (text: string) => text,
			noMatch: (text: string) => text,
			symbols: getSymbolTheme(),
			icon: (text: string) => text,
			hovered: (text: string) => text,
		};
	}
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("muted", text),
		noMatch: (text: string) => theme.fg("muted", text),
		symbols: getSymbolTheme(),
		icon: (text: string) => theme.fg("muted", text),
		hovered: (text: string) => theme.bg("selectedBg", text),
	};
}
/**
 * Resolve the autocomplete type-indicator glyph for a slash command.
 * Returns `undefined` when no theme is initialized or the active preset is
 * ASCII (shared `icon.*` glyphs have ASCII forms, but a partially lettered
 * icon column reads as noise), which collapses the column entirely.
 */
export function getSlashCommandTypeIcon(name: SlashCommandIconName): string | undefined {
	if (typeof theme === "undefined" || theme.getSymbolPreset() === "ascii") return undefined;
	const icon = theme.cmd[name];
	return icon.length > 0 ? icon : undefined;
}

export function getEditorTheme(): EditorTheme {
	// Guard against `theme` being undefined (pre-init or cross-module-instance
	// plugin calls). See #2998.
	if (typeof theme === "undefined") {
		return {
			borderColor: (text: string) => text,
			accentColor: (text: string) => text,
			surfaceColor: (text: string) => text,
			selectList: getSelectListTheme(),
			symbols: getSymbolTheme(),
			hintStyle: (text: string) => text,
		};
	}
	return {
		borderColor: (text: string) => theme.fg("borderMuted", text),
		accentColor: (text: string) => theme.fg("accent", text),
		surfaceColor: (text: string) =>
			theme.bgFill("userMessageBg", theme.fgOnBg("userMessageText", "userMessageBg", text)),
		textColor: (text: string) => theme.fgResolved("text", text),
		selectList: getSelectListTheme(),
		symbols: getSymbolTheme(),
		hintStyle: (text: string) => theme.fg("dim", text),
	};
}

export function getSettingsListTheme(): SettingsListTheme {
	// Plugins (e.g. pi-rtk-optimizer) may call this before `initTheme()` assigns
	// the global `theme`, or from a separate module instance under npm-global
	// installs where the live binding was never initialized. Fall back to plain
	// text so the call returns a usable (unstyled) theme instead of crashing with
	// "undefined is not an object (evaluating 'theme.fg')". See #2998.
	if (typeof theme === "undefined") {
		return {
			label: (text: string) => text,
			value: (text: string) => text,
			description: (text: string) => text,
			warning: (text: string) => text,
			warningMark: "!",
			cursor: "> ",
			hint: (text: string) => text,
			heading: (text: string) => text,
			section: (text: string) => text,
			hovered: (text: string) => text,
		};
	}
	return {
		label: (text: string, selected: boolean, changed: boolean) =>
			changed ? theme.fg("statusLineGitDirty", text) : selected ? theme.fg("accent", text) : text,
		value: (text: string, selected: boolean, changed: boolean) =>
			changed ? theme.fg("statusLineGitDirty", text) : selected ? theme.fg("accent", text) : theme.fg("muted", text),
		description: (text: string) => theme.fg("dim", text),
		warning: (text: string) => theme.fg("warning", text),
		warningMark: theme.status.warning,
		cursor: theme.fg("accent", `${theme.nav.cursor} `),
		hint: (text: string) => theme.fg("dim", text),
		heading: (text: string, dimmed: boolean) =>
			dimmed ? theme.fg("dim", theme.underline(text)) : theme.fg("muted", theme.bold(theme.underline(text))),
		section: (text: string, active: boolean) =>
			active ? theme.fg("accent", theme.bold(text)) : theme.fg("muted", text),
		hovered: (text: string) => theme.bg("selectedBg", text),
	};
}
