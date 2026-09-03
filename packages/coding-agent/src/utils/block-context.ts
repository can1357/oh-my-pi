import { enclosingBlockBoundaries } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";

const OPEN_TO_CLOSE: Record<string, string> = {
	"(": ")",
	"[": "]",
	"{": "}",
};

const CLOSE_TO_OPEN: Record<string, string> = {
	")": "(",
	"]": "[",
	"}": "{",
};

export interface LineSpan {
	startLine: number;
	endLine: number;
}

/** Where the source came from, so tree-sitter can pick a grammar. */
export interface BlockContextSource {
	path?: string;
	lang?: string;
	/**
	 * The whole source `fullLines` was split from, when the caller still holds it.
	 * Supplying it skips re-joining every line into a fresh whole-file string on
	 * the way to the parser. It MUST be the same content as `fullLines`; a
	 * differing trailing newline is the only tolerated variation, since it moves
	 * no node's line number.
	 *
	 * Every current supplier derives both from one buffer in the same breath, so
	 * the two cannot drift. Do NOT set it on a source object that is reused
	 * across two different line arrays — a before/after diff pair, say — because
	 * the boundary lines tree-sitter reports would then be indexed into the wrong
	 * array and surface off-by-N context rows.
	 */
	text?: string;
}

export type LineEntry = { kind: "line"; lineNumber: number; text: string; context: boolean } | { kind: "ellipsis" };

interface StackEntry {
	opener: string;
	lineNumber: number;
	text: string;
	visible: boolean;
}

type ScannerMode = "code" | "single" | "double" | "template" | "blockComment";

function normalizeLineSpans(spans: readonly LineSpan[], totalLines: number): LineSpan[] {
	if (totalLines <= 0) return [];
	const normalized: LineSpan[] = [];
	for (const span of spans) {
		const startLine = Math.max(1, Math.trunc(span.startLine));
		const endLine = Math.min(totalLines, Math.trunc(span.endLine));
		if (endLine < startLine) continue;
		normalized.push({ startLine, endLine });
	}
	if (normalized.length <= 1) return normalized;
	normalized.sort((left, right) => left.startLine - right.startLine || left.endLine - right.endLine);
	const merged: LineSpan[] = [];
	for (const span of normalized) {
		const previous = merged[merged.length - 1];
		if (previous && span.startLine <= previous.endLine + 1) {
			previous.endLine = Math.max(previous.endLine, span.endLine);
			continue;
		}
		merged.push({ ...span });
	}
	return merged;
}

function visibleLineNumbers(spans: readonly LineSpan[]): Set<number> {
	const visible = new Set<number>();
	for (const span of spans) {
		for (let line = span.startLine; line <= span.endLine; line++) {
			visible.add(line);
		}
	}
	return visible;
}

function hasEveryLineVisible(visible: ReadonlySet<number>, totalLines: number): boolean {
	return totalLines > 0 && visible.size >= totalLines;
}

/** Collapse a set of visible line numbers into sorted, merged inclusive spans. */
function visibleSetToSpans(visible: ReadonlySet<number>): LineSpan[] {
	const sorted = [...visible].sort((left, right) => left - right);
	const spans: LineSpan[] = [];
	for (const line of sorted) {
		const previous = spans[spans.length - 1];
		if (previous && line <= previous.endLine + 1) {
			previous.endLine = line;
			continue;
		}
		spans.push({ startLine: line, endLine: line });
	}
	return spans;
}

/**
 * Tree-sitter-backed block boundaries. For each multi-line named node whose
 * span crosses the visible window, the native side returns the boundary line
 * outside that window (closer when the opener is shown, opener when the closer
 * is shown). Returns `null` when the language is unrecognized or the source has
 * a syntax error so the caller can fall back to a lexical bracket scan.
 */
function nativeBlockContext(
	fullLines: readonly string[],
	visible: ReadonlySet<number>,
	source: BlockContextSource,
): Map<number, string> | null {
	if (!source.path && !source.lang) return null;
	const ranges = visibleSetToSpans(visible);
	if (ranges.length === 0) return new Map();
	let boundaries: number[] | null;
	try {
		boundaries = enclosingBlockBoundaries({
			code: source.text ?? fullLines.join("\n"),
			path: source.path,
			lang: source.lang,
			ranges,
		});
	} catch (error) {
		logger.debug("enclosingBlockBoundaries failed; using lexical bracket fallback", { error });
		return null;
	}
	if (boundaries === null) return null;
	const context = new Map<number, string>();
	for (const lineNumber of boundaries) {
		if (visible.has(lineNumber)) continue;
		context.set(lineNumber, fullLines[lineNumber - 1] ?? "");
	}
	return context;
}

function findMatchingStackIndex(stack: readonly StackEntry[], opener: string): number {
	for (let index = stack.length - 1; index >= 0; index--) {
		if (stack[index].opener === opener) return index;
	}
	return -1;
}

function isHashCommentStart(line: string, index: number): boolean {
	if (line[index] !== "#") return false;
	for (let i = 0; i < index; i++) {
		const ch = line[i];
		if (ch !== " " && ch !== "\t") return false;
	}
	return true;
}

/**
 * Lexical bracket-matching fallback for sources tree-sitter can't parse
 * (unknown extensions, syntax errors). Pairs `()[]{}` while skipping strings
 * and line/block comments, and reports the matching line when one endpoint is
 * visible and the other is not.
 */
function lexicalBracketContext(fullLines: readonly string[], visible: ReadonlySet<number>): Map<number, string> {
	const context = new Map<number, string>();
	const stack: StackEntry[] = [];
	let mode: ScannerMode = "code";
	let escaped = false;

	for (let lineIndex = 0; lineIndex < fullLines.length; lineIndex++) {
		const lineNumber = lineIndex + 1;
		const line = fullLines[lineIndex] ?? "";
		const lineVisible = visible.has(lineNumber);
		let index = 0;
		while (index < line.length) {
			const ch = line[index];
			const next = index + 1 < line.length ? line[index + 1] : "";

			if (mode === "blockComment") {
				if (ch === "*" && next === "/") {
					mode = "code";
					index += 2;
					continue;
				}
				index++;
				continue;
			}

			if (mode === "single" || mode === "double" || mode === "template") {
				if (escaped) {
					escaped = false;
					index++;
					continue;
				}
				if (ch === "\\") {
					escaped = true;
					index++;
					continue;
				}
				if (
					(mode === "single" && ch === "'") ||
					(mode === "double" && ch === '"') ||
					(mode === "template" && ch === "`")
				) {
					mode = "code";
				}
				index++;
				continue;
			}

			if (ch === "/" && next === "/") break;
			if (ch === "/" && next === "*") {
				mode = "blockComment";
				index += 2;
				continue;
			}
			if (isHashCommentStart(line, index)) break;
			if (ch === "'") {
				mode = "single";
				escaped = false;
				index++;
				continue;
			}
			if (ch === '"') {
				mode = "double";
				escaped = false;
				index++;
				continue;
			}
			if (ch === "`") {
				mode = "template";
				escaped = false;
				index++;
				continue;
			}

			if (OPEN_TO_CLOSE[ch]) {
				stack.push({ opener: ch, lineNumber, text: line, visible: lineVisible });
				index++;
				continue;
			}

			const opener = CLOSE_TO_OPEN[ch];
			if (opener) {
				const matchIndex = findMatchingStackIndex(stack, opener);
				if (matchIndex !== -1) {
					const [matched] = stack.splice(matchIndex);
					if (matched) {
						if (lineVisible && !matched.visible) context.set(matched.lineNumber, matched.text);
						if (matched.visible && !lineVisible) context.set(lineNumber, line);
					}
				}
			}

			index++;
		}

		if (mode === "single" || mode === "double") {
			mode = "code";
			escaped = false;
		}
	}

	for (const lineNumber of visible) context.delete(lineNumber);
	return context;
}

/**
 * Resolve the off-window boundary lines for a visible window: tree-sitter
 * syntactic spans first (covers brace and indentation languages), falling back
 * to a lexical bracket scan when the grammar is unavailable. Returns a map of
 * `lineNumber → source text` for the lines to surface, never including a line
 * already visible.
 */
export function findBlockContextLines(
	fullLines: readonly string[],
	visibleInput: ReadonlySet<number> | readonly number[],
	source: BlockContextSource = {},
): Map<number, string> {
	const visible = visibleInput instanceof Set ? visibleInput : new Set(visibleInput);
	if (visible.size === 0 || hasEveryLineVisible(visible, fullLines.length)) return new Map();
	return nativeBlockContext(fullLines, visible, source) ?? lexicalBracketContext(fullLines, visible);
}

/**
 * Build display entries for `visibleSpans` plus any off-window block-boundary
 * lines, in source order, with `{ kind: "ellipsis" }` markers inserted across
 * non-contiguous gaps. `options.lineText` lets callers substitute display text
 * (e.g. column-truncated lines) for a given line number.
 */
export function buildLineEntriesWithBlockContext(
	fullLines: readonly string[],
	visibleSpans: readonly LineSpan[],
	source: BlockContextSource = {},
	options: {
		lineText?: (lineNumber: number, sourceText: string, context: boolean) => string;
	} = {},
): LineEntry[] {
	const spans = normalizeLineSpans(visibleSpans, fullLines.length);
	const visible = visibleLineNumbers(spans);
	const context = findBlockContextLines(fullLines, visible, source);
	const allLines = new Set<number>(visible);
	for (const lineNumber of context.keys()) allLines.add(lineNumber);

	const sorted = [...allLines].sort((left, right) => left - right);
	const entries: LineEntry[] = [];
	let previousLine: number | undefined;
	for (const lineNumber of sorted) {
		if (previousLine !== undefined && lineNumber > previousLine + 1) {
			entries.push({ kind: "ellipsis" });
		}
		const sourceText = fullLines[lineNumber - 1] ?? "";
		const isContext = context.has(lineNumber);
		entries.push({
			kind: "line",
			lineNumber,
			text: options.lineText?.(lineNumber, sourceText, isContext) ?? sourceText,
			context: isContext,
		});
		previousLine = lineNumber;
	}

	return entries;
}

export function lineEntriesToPlainText(entries: readonly LineEntry[], ellipsis = "…"): string {
	return entries.map(entry => (entry.kind === "ellipsis" ? ellipsis : entry.text)).join("\n");
}
