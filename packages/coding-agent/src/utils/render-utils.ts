import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";
import { Ellipsis } from "@oh-my-pi/pi-natives";
import { expandWindowsLongPath, getWindowsShortPath } from "@oh-my-pi/pi-natives/path";
import { flattenLine } from "@oh-my-pi/pi-tui/text/sanitize";
import { pluralize, sanitizeText } from "@oh-my-pi/pi-utils";
import { replaceTabs, truncateToWidth } from "./text-width";

/** A thinking selector configured as a concrete level or automatic selection. */
export type ConfiguredThinkingLevel = ThinkingLevel | "auto";

/** The glyph of a thinking level: `status.disabled` for off, none for inherit, else the level symbol's first glyph. */
export function thinkingLevelGlyph(glyph: (key: string) => string, level: string | undefined): string {
	if (!level || level === "inherit") return "";
	if (level === "off") return glyph("status.disabled");
	const symbol = glyph(`thinking.${level === "auto" ? "autoPending" : level}`);
	const space = symbol.indexOf(" ");
	return space < 0 ? symbol : symbol.slice(0, space);
}

/**
 * Normalize stray carriage returns in model-authored display text. Some models
 * (observed with GLM via OpenRouter) degenerate into injecting `\r` runs between
 * words inside JSON string values; CommonMark treats a lone `\r` as a line
 * ending, which splatters the text one word per row. CRLF becomes LF, CR runs
 * collapse to a single space — word separators in prose, one indent unit in
 * mangled code previews.
 */
export function sanitizeCarriageReturns(text: string): string {
	if (!text.includes("\r")) return text;
	return text.replaceAll("\r\n", "\n").replace(/\r+/g, " ");
}

/**
 * Sanitize raw ask option labels into unique, action-safe display copies.
 * Degenerate input can sanitize alike (`Retry\rnow`/`Retry now`) or match a
 * runtime action row (`Other (type your own)`); both would answer the wrong
 * row, so colliding entries take a numeric suffix. Order and length are
 * preserved, so indices still align with the original labels for mapping
 * answers and dialog state back. Every ask race participant (local dialog,
 * guest selector) must call this with the same `reservedLabels` so a
 * question renders identically wherever it is answered.
 */
export function disambiguateDisplayLabels(rawLabels: string[], reservedLabels: readonly string[]): string[] {
	const taken = new Set<string>(reservedLabels);
	return rawLabels.map(raw => {
		const base = sanitizeCarriageReturns(raw);
		let candidate = base;
		for (let suffix = 2; taken.has(candidate); suffix++) candidate = `${base} (${suffix})`;
		taken.add(candidate);
		return candidate;
	});
}

/** Preview limits for collapsed/expanded views */
export const PREVIEW_LIMITS = {
	/** Lines shown in collapsed view */
	COLLAPSED_LINES: 3,
	/** Lines shown in expanded view */
	EXPANDED_LINES: 12,
	/** Items (files, results) shown in collapsed view */
	COLLAPSED_ITEMS: 8,
	/** Definition, type-definition and implementation locations shown in collapsed view */
	LOCATIONS_COLLAPSED: 2,
	/** Output preview lines in collapsed view */
	OUTPUT_COLLAPSED: 3,
	/** Output preview lines in expanded view */
	OUTPUT_EXPANDED: 10,
	/** Computer script lines shown in collapsed view */
	COMPUTER_CODE_COLLAPSED: 10,
	/** Max hunks shown when collapsed (edit tool) */
	DIFF_COLLAPSED_HUNKS: 8,
	/** Max diff lines shown when collapsed (edit tool) */
	DIFF_COLLAPSED_LINES: 40,
} as const;

/** Match a Markdown fenced-code opener and capture its indentation and marker. */
export const FENCE_RE = /^( {0,3})([`~]{3,})/;

/** Default display width reserved for a resolved model badge. */
export const FEED_MODEL_BADGE_WIDTH = 30;

let feedModelBadgeEnabled = false;

/** Set whether feed rows (task, wait and eval agent rows) show their resolved model badge (`task.showResolvedModelBadge`). */
export function setFeedModelBadgeEnabled(enabled: boolean): void {
	feedModelBadgeEnabled = enabled;
}

/** Whether feed rows show their resolved model badge; false until settings load. */
export function isFeedModelBadgeEnabled(): boolean {
	return feedModelBadgeEnabled;
}

/** Truncation lengths for different content types */
export const TRUNCATE_LENGTHS = {
	/** Short titles, labels */
	TITLE: 60,
	/** Medium-length content (messages, previews) */
	CONTENT: 80,
	/** Longer content (code, explanations) */
	LONG: 100,
	/** Full line content */
	LINE: 110,
	/** Very short (task previews, badges) */
	SHORT: 40,
	/** Idle recap status line (~40-word LLM reply) */
	RECAP: 280,
} as const;

/**
 * Collapse a possibly multi-line string into a single line, then truncate it to
 * `maxWidth` display cells. {@link truncateToWidth} alone caps width but
 * newlines are zero-width, so multi-line content (markdown briefs, tool args,
 * provider errors) would otherwise spill a single status row across several
 * visual lines.
 */
export function previewLine(text: string, maxWidth: number, ellipsis?: Ellipsis): string {
	return truncateToWidth(flattenLine(text), maxWidth, ellipsis);
}

/**
 * Build a "more items" suffix line for truncated lists.
 * Uses consistent wording pattern.
 */
export function formatMoreItems(remaining: number, itemType: string): string {
	const safeRemaining = Number.isFinite(remaining) ? remaining : 0;
	return `… ${safeRemaining} more ${pluralize(itemType, safeRemaining)}`;
}

/**
 * Collapsed command/code previews render a tail window sized from the live
 * viewport: terminal rows minus a reserve for the rest of the block (frame,
 * Output section, stats line) and the editor/status area below the
 * transcript. This keeps a volatile streaming block from growing past the
 * viewport and stranding its top, while letting tall terminals show more.
 */
const PREVIEW_WINDOW_RESERVED_ROWS = 20;

/** Floor so tiny or unknown viewports still show a useful window. */
const PREVIEW_WINDOW_MIN_LINES = 6;

/** Assumed viewport when rows are unknown (non-TTY, tests). */
const PREVIEW_WINDOW_FALLBACK_ROWS = 30;

/** Tail-window height for collapsed command/code previews. */
export function previewWindowRows(): number {
	const rows = process.stdout.rows || PREVIEW_WINDOW_FALLBACK_ROWS;
	return Math.max(PREVIEW_WINDOW_MIN_LINES, rows - PREVIEW_WINDOW_RESERVED_ROWS);
}

/**
 * Split multi-line tool text into TUI-safe display lines.
 * Splits CRLF/LF, collapses stray `\r` progress overwrites to the final
 * segment (mirroring terminal rendering), and expands tabs — so raw
 * subprocess or fetched output (e.g. Windows ssh emitting CRLF, tab-indented
 * web content) can't corrupt the framed block layout with cursor-moving
 * control characters or tab-stop width mismatches.
 */
export function sanitizeDisplayLines(text: string): string[] {
	return text.split(/\r?\n/).map(line => {
		const idx = line.lastIndexOf("\r");
		return replaceTabs(sanitizeText(idx < 0 ? line : line.slice(idx + 1)));
	});
}

// =============================================================================
// Code Frame Formatting
// =============================================================================

/** Marker displayed in the gutter of a code frame. */
export type CodeFrameMarker = "" | " " | "*" | "+" | "-" | ">";

/** Format a code-frame row with a padded line-number gutter. */
export function formatCodeFrameLine(
	marker: CodeFrameMarker,
	lineNumber: string | number,
	content: string,
	lineNumberWidth: number,
): string {
	const markerText = marker.trim();
	const lineNumberText = String(lineNumber).trim();
	const gutterText = markerText && lineNumberText ? `${markerText}${lineNumberText}` : lineNumberText || markerText;
	return `${gutterText.padStart(lineNumberWidth + 1, " ")}│${content}`;
}

// =============================================================================
// Path Utilities
// =============================================================================

let cachedHomeDir: string | undefined;

let cachedHomedir: typeof os.homedir | undefined;

function defaultHomeDir(): string {
	const homedir = os.homedir;
	if (cachedHomeDir === undefined || cachedHomedir !== homedir) {
		cachedHomedir = homedir;
		cachedHomeDir = homedir();
	}
	return cachedHomeDir;
}

interface HomePattern {
	leading: RegExp;
	embedded: RegExp;
}

const homePatternCache = new Map<string, HomePattern>();

function homePatternFor(homeDir: string, windowsStyle: boolean): HomePattern {
	const key = `${windowsStyle ? 1 : 0} ${homeDir}`;
	let pattern = homePatternCache.get(key);
	if (pattern === undefined) {
		// A trailing separator (`C:\Users\me\`, `/home/me/`) must still match `<home>/child`;
		// roots such as `/` and `C:\` keep theirs.
		const home = homeDir.replace(/(?<=[^\\/:])[\\/]+$/, "");
		let escapedHome = RegExp.escape(home);
		if (windowsStyle) {
			// Query only home, once per cached pattern: descendants need not exist,
			// and rendering must neither resolve junctions nor probe output paths.
			const parts = home.replaceAll("/", "\\").split("\\");
			const longHome = expandWindowsLongPath(home);
			const aliases = [longHome, getWindowsShortPath(longHome)]
				.map(alias => alias.replaceAll("/", "\\").split("\\"))
				.filter(alias => alias.length === parts.length);
			escapedHome = parts
				.map((part, index) => {
					// Each component may independently use its long or short spelling.
					const names = [...new Set([part, ...aliases.map(alias => alias[index]!)])].map(name =>
						RegExp.escape(name),
					);
					return names.length === 1 ? names[0]! : `(?:${names.join("|")})`;
				})
				.join("[\\\\/]");
		}
		// `*` and `_` are also identifier and glob characters (`/home/me_old`, `src/**/home/me/**`), so they
		// bound the home directory only as Markdown emphasis: opened at start or after whitespace, and
		// closed before end, whitespace, or punctuation.
		const end = `[\\\\/\\s"'\\x60)\\]},;:<>&|]`;
		pattern = {
			leading: new RegExp(`^${escapedHome}(?=$|[\\\\/])`, windowsStyle ? "i" : ""),
			embedded: new RegExp(
				`[a-zA-Z][a-zA-Z0-9+.-]*://[^\\s"'<>]+` +
					`|(^|[\\s"'\\x60([{=,:<>&|])(${escapedHome})(?=$|${end})` +
					`|((?:^|\\s)[*_]{1,3})(${escapedHome})(?=$|${end}|[*_]{1,3}(?=$|[\\s.,;:!?)\\]}"'\\x60]))`,
				windowsStyle ? "gi" : "g",
			),
		};
		if (homePatternCache.size >= 16) homePatternCache.clear();
		homePatternCache.set(key, pattern);
	}
	return pattern;
}

/** Replace a leading home directory with a portable tilde prefix. */
export function shortenPath(filePath: unknown, homeDir?: string): string {
	if (typeof filePath !== "string") {
		return "";
	}
	const home = homeDir ?? defaultHomeDir();
	if (!home) return filePath;
	const windowsStyle = /^[A-Za-z]:[\\/]/.test(home) || home.startsWith("\\\\");
	const match = homePatternFor(home, windowsStyle).leading.exec(filePath);
	if (match) {
		const suffix = filePath.slice(match[0].length);
		return `~${suffix.replaceAll(path.win32.sep, path.posix.sep)}`;
	}
	return filePath;
}

/** Shorten embedded home paths; normalize Windows separators unless the caller preserves native error text. */
export function shortenEmbeddedPaths(text: string, homeDir?: string, preserveSeparators = false): string {
	const resolvedHome = homeDir ?? defaultHomeDir();
	if (!resolvedHome || resolvedHome.length <= 1) return text;
	const windowsStyle = /^[A-Za-z]:[\\/]/.test(resolvedHome) || resolvedHome.startsWith("\\\\");
	const homePattern = homePatternFor(resolvedHome, windowsStyle);
	const textWithShortenedHome = text.replace(
		homePattern.embedded,
		(
			match,
			boundary: string | undefined,
			candidate: string | undefined,
			emphasis: string | undefined,
			emphasized: string | undefined,
		) => (candidate !== undefined ? `${boundary}~` : emphasized !== undefined ? `${emphasis}~` : match),
	);
	if (preserveSeparators) return textWithShortenedHome;
	return textWithShortenedHome
		.split(" ")
		.map(segment => {
			const leading = segment.match(/^[("'`[]*/)?.[0] ?? "";
			const trailing = segment.match(/[)"'`,.;:\]]*$/)?.[0] ?? "";
			const end = segment.length - trailing.length;
			if (leading.length >= end) return segment;
			const shortened = shortenPath(segment.slice(leading.length, end), resolvedHome);
			const normalized = shortened.startsWith("~")
				? shortened.replaceAll(path.win32.sep, path.posix.sep)
				: shortened;
			return `${leading}${normalized}${trailing}`;
		})
		.join(" ");
}

/**
 * Shorten filesystem and command arguments without rewriting literal search patterns. A producer that
 * names no argument key gets the general embedded-path shortening.
 */
export function shortenToolArgumentPaths(text: string, key: string | undefined, homeDir?: string): string {
	if (key === "url") {
		try {
			const url = new URL(text);
			if (url.protocol === "file:") {
				let decodedPath = url.pathname;
				try {
					decodedPath = decodeURIComponent(decodedPath);
				} catch {
					/* Retain malformed percent escapes as literal path bytes. */
				}
				const filePath = url.hostname
					? `//${url.hostname}${decodedPath}`
					: /^[A-Za-z]:$/.test(decodedPath.slice(1, 3))
						? decodedPath.slice(1)
						: decodedPath;
				return shortenEmbeddedPaths(filePath, homeDir);
			}
		} catch {
			// Preserve malformed and non-file URL arguments verbatim.
		}
		return text;
	}
	return key === undefined ||
		key === "path" ||
		key === "file_path" ||
		key === "command" ||
		key === "task" ||
		key === "prompt"
		? shortenEmbeddedPaths(text, homeDir)
		: text;
}

/** Sanitize warning text before showing it in TUI, including embedded home paths. */
export function sanitizeDisplayWarning(text: string): string {
	return shortenEmbeddedPaths(
		replaceTabs(sanitizeText(text))
			.replace(/[\r\n]+/g, " ")
			.trim(),
	);
}

/** Sanitize and bound warning text before showing it in TUI. */
export function sanitizeDisplayWarnings(warnings: readonly string[]): string[] {
	const visible = warnings
		.slice(0, PREVIEW_LIMITS.COLLAPSED_ITEMS)
		.map(warning => truncateToWidth(sanitizeDisplayWarning(warning), TRUNCATE_LENGTHS.LONG));
	const hidden = warnings.length - visible.length;
	if (hidden > 0) visible.push(`… ${hidden} more ${pluralize("warning", hidden)}`);
	return visible;
}

/** Maximum number of parse errors displayed in expanded details. */
export const PARSE_ERRORS_LIMIT = 20;

/** Deduplicate parse errors while preserving their original order. */
export function dedupeParseErrors(errors: string[] | undefined): string[] {
	if (!errors || errors.length === 0) return [];
	const seen = new Set<string>();
	const deduped: string[] = [];
	for (const error of errors) {
		if (seen.has(error)) continue;
		seen.add(error);
		deduped.push(error);
	}
	return deduped;
}

/** Format deduplicated parse errors with a bounded detail list. */
export function formatParseErrors(errors: string[], total?: number): string[] {
	const deduped = dedupeParseErrors(errors);
	if (deduped.length === 0) return [];
	const fullCount = total ?? deduped.length;
	const capped = deduped.slice(0, PARSE_ERRORS_LIMIT);
	const header = fullCount > capped.length ? `Parse issues (${capped.length} / ${fullCount}):` : "Parse issues:";
	return [header, ...capped.map(err => `- ${err}`)];
}

/**
 * Cap an upstream parse-error list to {@link PARSE_ERRORS_LIMIT} unique entries,
 * preserving the original deduplicated total. Use this at the source so tool
 * details never carry thousands of per-file parse errors into traces or
 * renderers.
 */
export function capParseErrors(
	errors: string[] | undefined,
	limit: number = PARSE_ERRORS_LIMIT,
): { errors: string[]; total: number } {
	const deduped = dedupeParseErrors(errors);
	return { errors: deduped.slice(0, limit), total: deduped.length };
}

/**
 * Parse a JSON-encoded array of path strings (e.g. `'["a.ts","b.ts"]'`).
 * Returns `null` when the input is not a bracketed JSON string array, so the
 * caller can fall back to treating the input as a single literal path.
 */
function parseStringEncodedPathArray(input: string): string[] | null {
	const trimmed = input.trim();
	if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}

	if (!Array.isArray(parsed) || parsed.some(entry => typeof entry !== "string")) {
		return null;
	}
	return parsed;
}

/**
 * Normalize a path argument that may arrive as a single string, a JSON-encoded
 * string array (`'["a.ts"]'`), or an actual array into a flat `string[]`.
 * Delimited single strings (`"a.ts b.ts"`) remain literal.
 */
export function toPathList(input: string | string[] | undefined): string[] {
	if (typeof input === "string") return parseStringEncodedPathArray(input) ?? [input];
	return input ?? [];
}

/** Which characters separate the parts of a flattened path list ({@link splitTopLevelDelimitedPath}). */
export type DelimitedPathSplitMode = "comma" | "semicolon" | "whitespace" | "mixed";

const TOP_LEVEL_WHITESPACE_RE = /\s/;

export function isDelimitedPathSeparator(ch: string, mode: DelimitedPathSplitMode): boolean {
	if (mode === "comma") return ch === ",";
	if (mode === "semicolon") return ch === ";";
	if (mode === "whitespace") return TOP_LEVEL_WHITESPACE_RE.test(ch);
	return ch === "," || ch === ";" || TOP_LEVEL_WHITESPACE_RE.test(ch);
}

/**
 * Split a flattened path list at its `mode` separators outside `{…}` braces; a
 * backslash keeps the character after it. One part when nothing separates.
 */
export function splitTopLevelDelimitedPath(entry: string, mode: DelimitedPathSplitMode): string[] {
	const parts: string[] = [];
	let braceDepth = 0;
	let start = 0;
	for (let i = 0; i < entry.length; i++) {
		const ch = entry[i];
		if (ch === "\\" && i + 1 < entry.length) {
			i++;
			continue;
		}
		if (ch === "{") {
			braceDepth++;
			continue;
		}
		if (ch === "}") {
			if (braceDepth > 0) braceDepth--;
			continue;
		}
		if (braceDepth !== 0 || !isDelimitedPathSeparator(ch, mode)) continue;
		parts.push(entry.slice(start, i));
		start = i + 1;
	}
	parts.push(entry.slice(start));
	return parts;
}
