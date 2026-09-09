import * as path from "node:path";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { getEditStore } from "../edit/store";
import {
	formatHashlineHeader,
	formatNumberedLine,
	formatNumberedLines,
	splitAddressableFileLines,
} from "./hashline-format";
import { normalizeToLF } from "../edit/normalize";
import { isMarkdownPath } from "../modes/theme/theme";
import type { ToolSession } from "../sdk";
import {
	DEFAULT_MAX_BYTES,
	noTruncResult,
	type TruncationResult,
	truncateHead,
	truncateHeadBytes,
} from "../session/streaming-output";
import { buildLineEntriesWithBlockContext, type LineEntry, lineEntriesToPlainText } from "../utils/block-context";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import { formatPathRelativeToCwd, type LineRange } from "./path-utils";
import type { ReadToolDetails } from "./read";
import { isRawSelector, type ParsedSelector, resolveTailSelector, selToOffsetLimit } from "./read-selector";
import { formatBytes, shortenPath } from "./render-utils";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

function prependLineNumbers(text: string, startNum: number): string {
	const textLines = text.split("\n");
	return textLines.map((line, i) => `${startNum + i}|${line}`).join("\n");
}

export interface HashlineHeaderContext {
	header: string;
	tag: string;
	fullText?: string;
}

export function formatReadHashlineHeader(displayPath: string, tag: string): string {
	// In-workspace reads keep their workspace-relative path (e.g.
	// `src/settings.json`), not just the basename: collapsing to the bare name
	// made a header ambiguous whenever another same-named file exists at cwd —
	// the edit tool would resolve the bare name against cwd, hit the wrong
	// file, and reject the valid edit via the snapshot-tag guard (the authored
	// path exists, so Patcher's tag-path recovery never runs). The relative
	// path stays directly resolvable against cwd and names the file uniquely.
	// Out-of-workspace reads use an absolute displayPath; `shortenPath` keeps
	// `~/.claude/...` (round-trips through resolveToCwd's ~ expansion) instead
	// of leaking the full home path into the read output.
	const anchor = path.isAbsolute(displayPath) ? shortenPath(displayPath) : displayPath;
	return formatHashlineHeader(anchor, tag);
}

function recordFullHashlineContext(
	session: ToolSession,
	absolutePath: string | undefined,
	displayPath: string,
	fullText: string,
): HashlineHeaderContext | undefined {
	if (!absolutePath || !path.isAbsolute(absolutePath)) return undefined;
	const normalized = normalizeToLF(fullText);
	const tag = getEditStore(session).recordSnapshot(absolutePath, normalized);
	return {
		header: formatReadHashlineHeader(displayPath, tag),
		tag,
		fullText: normalized,
	};
}

export async function readHashlineHeaderContext(
	session: ToolSession,
	absolutePath: string,
	cwd: string,
): Promise<HashlineHeaderContext> {
	return hashlineHeaderContextForText(session, absolutePath, cwd, await Bun.file(absolutePath).text());
}

/**
 * {@link readHashlineHeaderContext} for a caller that already holds the file's
 * full text, so the file is not reopened just to hash it. Line endings are
 * normalized here, exactly as the reading variant does.
 */
export function hashlineHeaderContextForText(
	session: ToolSession,
	absolutePath: string,
	cwd: string,
	fullText: string,
): HashlineHeaderContext {
	const context = recordFullHashlineContext(
		session,
		absolutePath,
		formatPathRelativeToCwd(absolutePath, cwd),
		fullText,
	);
	if (!context) throw new ToolError(`Cannot record hashline snapshot for non-absolute path: ${absolutePath}`);
	return context;
}

export function hashlineHeaderContext(displayPath: string, tag: string): HashlineHeaderContext {
	return { header: formatReadHashlineHeader(displayPath, tag), tag };
}

export function prependHashlineHeader(text: string, context: HashlineHeaderContext | undefined): string {
	return context ? `${context.header}\n${text}` : text;
}

export function formatTextWithMode(
	text: string,
	startNum: number,
	shouldAddHashLines: boolean,
	shouldAddLineNumbers: boolean,
): string {
	if (shouldAddHashLines) return formatNumberedLines(text, startNum);
	if (shouldAddLineNumbers) return prependLineNumbers(text, startNum);
	return text;
}

export const BRACKET_CONTEXT_ELLIPSIS = "…";

function formatLineEntryWithMode(entry: LineEntry, shouldAddHashLines: boolean, shouldAddLineNumbers: boolean): string {
	if (entry.kind === "ellipsis") return BRACKET_CONTEXT_ELLIPSIS;
	return formatSingleLine(entry.lineNumber, entry.text, shouldAddHashLines, shouldAddLineNumbers);
}

export function formatLineEntriesWithMode(
	entries: readonly LineEntry[],
	shouldAddHashLines: boolean,
	shouldAddLineNumbers: boolean,
): string {
	return entries.map(entry => formatLineEntryWithMode(entry, shouldAddHashLines, shouldAddLineNumbers)).join("\n");
}

const BRACE_PAIRS: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
const BRACE_TAIL_TRAILING_RE = /^[;,)\]}]*$/;

/**
 * Decide whether the kept lines surrounding an elided range collapse to a
 * single brace-pair line in the rendered summary. Returns true when the head
 * line ends with `{` / `(` / `[` and the tail line is the matching closer
 * (optionally followed by terminating punctuation like `;`, `,`, or further
 * closers — e.g. `};`, `})`, `]);`).
 */
export function canMergeBracePair(headLine: string, tailLine: string): boolean {
	const head = headLine.trimEnd();
	const tail = tailLine.trim();
	const opener = head.slice(-1);
	const closer = BRACE_PAIRS[opener];
	if (!closer) return false;
	if (!tail.startsWith(closer)) return false;
	return BRACE_TAIL_TRAILING_RE.test(tail.slice(closer.length));
}

export function formatSingleLine(
	line: number,
	text: string,
	shouldAddHashLines: boolean,
	shouldAddLineNumbers: boolean,
): string {
	if (shouldAddHashLines) return formatNumberedLine(line, text);
	if (shouldAddLineNumbers) return `${line}|${text}`;
	return text;
}

export function formatMergedBraceLine(
	startLine: number,
	endLine: number,
	headText: string,
	tailText: string,
	shouldAddHashLines: boolean,
	shouldAddLineNumbers: boolean,
): { model: string; display: string } {
	const merged = `${headText.trimEnd()} … ${tailText.trim()}`;
	if (shouldAddHashLines) {
		return { model: `${startLine}-${endLine}:${merged}`, display: merged };
	}
	if (shouldAddLineNumbers) {
		return { model: `${startLine}-${endLine}|${merged}`, display: merged };
	}
	return { model: merged, display: merged };
}

export function countTextLines(text: string): number {
	if (text.length === 0) return 0;
	// Count newlines directly instead of allocating an array via split("\n").
	// Called on every read of file content; the result is identical (N newlines
	// ⇒ N+1 lines for non-empty text).
	let lines = 1;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10) lines++;
	}
	return lines;
}

export function contiguousLineNumbers(startLine: number, count: number): number[] {
	const lines: number[] = [];
	for (let offset = 0; offset < count; offset++) lines.push(startLine + offset);
	return lines;
}

export function lineNumbersFromSpans(spans: readonly { startLine: number; endLine: number }[]): number[] {
	const lines: number[] = [];
	for (const span of spans) {
		for (let line = span.startLine; line <= span.endLine; line++) lines.push(line);
	}
	return lines;
}

function recordInMemorySeenLines(
	session: ToolSession,
	absolutePath: string | undefined,
	fullText: string,
	seenLines: readonly number[] | undefined,
): void {
	if (!absolutePath || !path.isAbsolute(absolutePath) || !seenLines || seenLines.length === 0) return;
	getEditStore(session).recordSnapshot(absolutePath, normalizeToLF(fullText), [...seenLines]);
}

function lineNumbersFromEntries(entries: readonly LineEntry[]): number[] {
	const lines: number[] = [];
	for (const entry of entries) {
		if (entry.kind === "line") lines.push(entry.lineNumber);
	}
	return lines;
}

/** Inclusive line range describing one elided span in a structural summary. */
export interface ElidedRange {
	start: number;
	end: number;
}

/** Sample ranges shown in the footer to demonstrate the multi-range syntax. */
const FOOTER_RANGE_SAMPLES = 2;

/**
 * Footer appended to summarized reads telling the model how to recover the
 * elided body. Without this hint, agents either ignore the `…`/`{ … }`
 * markers or burn a turn guessing the right selector (see issue #1046). The
 * footer demonstrates the multi-range selector syntax with concrete sample
 * ranges drawn from the actual elision so the model re-reads only what it
 * needs instead of falling back to `:raw` or whole-file reads.
 */
export function formatSummaryElisionFooter(
	readPath: string,
	elidedRanges: ReadonlyArray<ElidedRange>,
	elidedLines: number,
): string {
	if (elidedRanges.length === 0) return "";
	const sampleCount = Math.min(elidedRanges.length, FOOTER_RANGE_SAMPLES);
	const selector = elidedRanges
		.slice(0, sampleCount)
		.map(r => `${r.start}-${r.end}`)
		.join(",");
	const example = `${readPath}:${selector}`;
	const tail = elidedRanges.length > sampleCount ? `, e.g. ${example}` : ` with ${example}`;
	return `[…${elidedLines}ln elided; re-read needed ranges${tail}]`;
}
export const READ_CHUNK_SIZE = 8 * 1024;

/**
 * Context lines added around an explicit range read. Anchor-stale failures
 * cluster on edits whose anchors land just outside the most recent read
 * window, but the data (`scripts/session-stats/analyze_selector_reads.py`)
 * shows most follow-up reads are disjoint hops, not adjacent extensions —
 * so symmetric padding rarely pays for itself.
 *
 * Leading=1 catches accidental single-line reads where the anchor is the
 * line immediately above the requested start. Trailing=3 buffers the
 * common case where the agent asks for a narrow range and then needs the
 * next few lines to disambiguate an anchor.
 */
export const RANGE_LEADING_CONTEXT_LINES = 1;
export const RANGE_TRAILING_CONTEXT_LINES = 3;

/**
 * Expand a [start, end) range with leading/trailing context lines on the
 * sides where the user actually constrained the range. A start of 0 (no
 * explicit offset) does not get leading context — that's already an
 * open-ended read from the top.
 */
function expandRangeWithContext(
	requestedStart: number,
	requestedEnd: number,
	totalLines: number,
	expandStart: boolean,
	expandEnd: boolean,
): { startLine: number; endLine: number } {
	return {
		startLine: expandStart ? Math.max(0, requestedStart - RANGE_LEADING_CONTEXT_LINES) : requestedStart,
		endLine: expandEnd ? Math.min(totalLines, requestedEnd + RANGE_TRAILING_CONTEXT_LINES) : requestedEnd,
	};
}

/** Options shared by the in-memory text builders; `raw` flips the line split to verbatim `\n` segments. */
export interface InMemoryTextOptions {
	details?: ReadToolDetails;
	sourcePath?: string;
	sourceUrl?: string;
	sourceInternal?: string;
	entityLabel: string;
	ignoreResultLimits?: boolean;
	raw?: boolean;
	immutable?: boolean;
}

/**
 * Render any read selector against in-memory text. Pins `:-N` tails to the
 * text's own line count (raw mode addresses `\n` segments verbatim; otherwise
 * the hashline-addressable split), then dispatches multi-range selectors to
 * {@link buildInMemoryMultiRangeResult} and everything else to
 * {@link buildInMemoryTextResult}. Raw mode is derived from the selector.
 */
export function buildInMemorySelectorResult(
	session: ToolSession,
	text: string,
	parsed: ParsedSelector,
	options: Omit<InMemoryTextOptions, "raw">,
): AgentToolResult<ReadToolDetails> {
	const raw = isRawSelector(parsed);
	const totalLines = raw ? text.split("\n").length : splitAddressableFileLines(text).length;
	const sel = resolveTailSelector(parsed, totalLines);
	if (sel.kind === "lines" && sel.ranges.length > 1) {
		return buildInMemoryMultiRangeResult(session, text, sel.ranges, { ...options, raw });
	}
	const { offset, limit } = selToOffsetLimit(sel);
	return buildInMemoryTextResult(session, text, offset, limit, { ...options, raw });
}

export function buildInMemoryTextResult(
	session: ToolSession,
	text: string,
	offset: number | undefined,
	limit: number | undefined,
	options: InMemoryTextOptions,
): AgentToolResult<ReadToolDetails> {
	const displayMode = resolveFileDisplayMode(session, { raw: options.raw, immutable: options.immutable });
	const details = options.details ?? {};
	const allLines = options.raw === true ? text.split("\n") : splitAddressableFileLines(text);
	const totalLines = allLines.length;
	details.totalLines = totalLines;
	// User-requested 0-indexed range start. Lines BEFORE this are leading
	// context (added below if offset is explicit).
	const requestedStart = offset ? Math.max(0, offset - 1) : 0;
	const ignoreResultLimits = options.ignoreResultLimits ?? false;
	const requestedEnd = limit !== undefined ? Math.min(requestedStart + limit, allLines.length) : allLines.length;
	// Expand only on sides the user actually constrained: leading context
	// when offset>1, trailing context when a finite limit was set. Raw mode
	// never expands — without line numbers the padding is indistinguishable
	// from requested content, so `raw:31-31` must return line 31 and nothing
	// else (verbatim-extraction contract).
	const rawDisplay = options.raw === true;
	const expanded = expandRangeWithContext(
		requestedStart,
		requestedEnd,
		allLines.length,
		!rawDisplay && offset !== undefined && offset > 1,
		!rawDisplay && limit !== undefined,
	);
	const startLine = expanded.startLine;
	const endLineExpanded = expanded.endLine;
	const startLineDisplay = startLine + 1;

	const resultBuilder = toolResult(details);
	if (options.sourcePath) {
		resultBuilder.sourcePath(options.sourcePath);
	}
	if (options.sourceUrl) {
		resultBuilder.sourceUrl(options.sourceUrl);
	}
	if (options.sourceInternal) {
		resultBuilder.sourceInternal(options.sourceInternal);
	}

	if (requestedStart >= allLines.length) {
		const suggestion =
			allLines.length === 0
				? `The ${options.entityLabel} is empty.`
				: `Use :1 to read from the start, or :${allLines.length} to read the last line.`;
		return resultBuilder
			.text(
				`Line ${requestedStart + 1} is beyond end of ${options.entityLabel} (${allLines.length} lines total). ${suggestion}`,
			)
			.done();
	}

	const endLine = endLineExpanded;
	const selectedContent = allLines.slice(startLine, endLine).join("\n");
	const userLimitedLines = limit !== undefined ? endLine - startLine : undefined;
	const truncation = ignoreResultLimits ? noTruncResult(selectedContent) : truncateHead(selectedContent);

	const shouldAddHashLines = displayMode.hashLines;
	const shouldAddLineNumbers = shouldAddHashLines ? false : displayMode.lineNumbers;
	const hashContext =
		shouldAddHashLines && options.sourcePath
			? recordFullHashlineContext(
					session,
					options.sourcePath,
					formatPathRelativeToCwd(options.sourcePath, session.cwd),
					text,
				)
			: undefined;
	let emittedHashlineHeader = false;
	let seenLines: number[] | undefined;
	let rawSeenLines: number[] | undefined;
	const formatText = (content: string, startNum: number): string => {
		const lineCount = countTextLines(content);
		details.displayContent = {
			text: content,
			startLine: startNum,
			lineNumbers: Array.from({ length: lineCount }, (_, i) => startNum + i),
		};
		if (shouldAddHashLines) seenLines = contiguousLineNumbers(startNum, lineCount);
		const formatted = formatTextWithMode(content, startNum, shouldAddHashLines, shouldAddLineNumbers);
		if (!hashContext || emittedHashlineHeader) return formatted;
		emittedHashlineHeader = true;
		return prependHashlineHeader(formatted, hashContext);
	};
	const formatLineEntries = (entries: readonly LineEntry[], startNum: number): string => {
		const firstLine = entries.find(entry => entry.kind === "line");
		details.displayContent = {
			text: lineEntriesToPlainText(entries, BRACKET_CONTEXT_ELLIPSIS),
			startLine: firstLine?.kind === "line" ? firstLine.lineNumber : startNum,
			lineNumbers: entries.map(entry => (entry.kind === "line" ? entry.lineNumber : null)),
		};
		if (shouldAddHashLines) seenLines = lineNumbersFromEntries(entries);
		const formatted = formatLineEntriesWithMode(entries, shouldAddHashLines, shouldAddLineNumbers);
		if (!hashContext || emittedHashlineHeader) return formatted;
		emittedHashlineHeader = true;
		return prependHashlineHeader(formatted, hashContext);
	};
	const buildLineEntries = (endLineDisplay: number): LineEntry[] =>
		buildLineEntriesWithBlockContext(allLines, [{ startLine: startLineDisplay, endLine: endLineDisplay }], {
			path: options.sourcePath,
			text,
		});

	let outputText: string;
	let truncationInfo:
		| { result: TruncationResult; options: { direction: "head"; startLine?: number; totalFileLines?: number } }
		| undefined;

	if (truncation.firstLineExceedsLimit) {
		const firstLine = allLines[startLine] ?? "";
		const firstLineBytes = Buffer.byteLength(firstLine, "utf-8");
		const snippet = truncateHeadBytes(firstLine, DEFAULT_MAX_BYTES);

		if (shouldAddHashLines) {
			outputText = `[Line ${startLineDisplay} is ${formatBytes(
				firstLineBytes,
			)}, exceeds ${formatBytes(DEFAULT_MAX_BYTES)} limit. Hashline output requires full lines; cannot emit an editable numbered preview for a truncated line.]`;
		} else {
			outputText = formatText(snippet.text, startLineDisplay);
		}

		if (snippet.text.length === 0) {
			outputText = `[Line ${startLineDisplay} is ${formatBytes(
				firstLineBytes,
			)}, exceeds ${formatBytes(DEFAULT_MAX_BYTES)} limit. Unable to display a valid UTF-8 snippet.]`;
		}

		details.truncation = truncation;
		truncationInfo = {
			result: truncation,
			options: { direction: "head", startLine: startLineDisplay, totalFileLines: totalLines },
		};
	} else if (truncation.truncated) {
		const outputLines = truncation.outputLines ?? countTextLines(truncation.content);
		const endLineDisplay = startLineDisplay + Math.max(0, outputLines - 1);
		if (options.raw === true) {
			rawSeenLines = contiguousLineNumbers(startLineDisplay, outputLines);
			outputText = formatText(truncation.content, startLineDisplay);
		} else {
			outputText = formatLineEntries(buildLineEntries(endLineDisplay), startLineDisplay);
		}
		details.truncation = truncation;
		truncationInfo = {
			result: truncation,
			options: { direction: "head", startLine: startLineDisplay, totalFileLines: totalLines },
		};
	} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
		const remaining = allLines.length - (startLine + userLimitedLines);
		const nextOffset = startLine + userLimitedLines + 1;

		if (options.raw === true) {
			rawSeenLines = contiguousLineNumbers(startLineDisplay, userLimitedLines);
			outputText = formatText(selectedContent, startLineDisplay);
		} else {
			outputText = formatLineEntries(buildLineEntries(endLine), startLineDisplay);
		}
		outputText += `\n\n[${remaining} more lines in ${options.entityLabel}. Use :${nextOffset} to continue]`;
	} else {
		if (options.raw === true) {
			rawSeenLines = contiguousLineNumbers(startLineDisplay, endLine - startLine);
			outputText = formatText(truncation.content, startLineDisplay);
		} else {
			outputText = formatLineEntries(buildLineEntries(endLine), startLineDisplay);
		}
	}

	if (hashContext?.tag && options.sourcePath && seenLines) {
		getEditStore(session).recordSeenLines(options.sourcePath, hashContext.tag, seenLines);
	}
	if (options.raw === true && options.sourcePath && options.immutable !== true && rawSeenLines) {
		recordInMemorySeenLines(session, options.sourcePath, text, rawSeenLines);
	}
	resultBuilder.text(outputText);
	if (truncationInfo) {
		resultBuilder.truncation(truncationInfo.result, truncationInfo.options);
	}
	return resultBuilder.done();
}

/**
 * Render a multi-range read against in-memory text. Each range emits a
 * formatted block with its own anchors / line numbers, blocks are joined
 * with an elision separator, and ranges past EOF surface as `[…]` notices
 * so the model can correct the next call. No leading/trailing context is
 * added — multi-range callers always specify exact bounds.
 */
export function buildInMemoryMultiRangeResult(
	session: ToolSession,
	text: string,
	ranges: readonly LineRange[],
	options: Omit<InMemoryTextOptions, "ignoreResultLimits">,
): AgentToolResult<ReadToolDetails> {
	const displayMode = resolveFileDisplayMode(session, { raw: options.raw, immutable: options.immutable });
	const details = options.details ?? {};
	const allLines = options.raw === true ? text.split("\n") : splitAddressableFileLines(text);
	const totalLines = allLines.length;
	details.totalLines = totalLines;
	const shouldAddHashLines = displayMode.hashLines;
	const shouldAddLineNumbers = shouldAddHashLines ? false : displayMode.lineNumbers;
	const hashContext =
		shouldAddHashLines && options.sourcePath
			? recordFullHashlineContext(
					session,
					options.sourcePath,
					formatPathRelativeToCwd(options.sourcePath, session.cwd),
					text,
				)
			: undefined;
	let emittedHashlineHeader = false;

	let seenLines: number[] | undefined;
	const resultBuilder = toolResult(details);
	if (options.sourcePath) resultBuilder.sourcePath(options.sourcePath);
	if (options.sourceUrl) resultBuilder.sourceUrl(options.sourceUrl);
	if (options.sourceInternal) resultBuilder.sourceInternal(options.sourceInternal);

	const outOfBounds: LineRange[] = [];
	const visibleSpans: Array<{ startLine: number; endLine: number }> = [];
	const rawParts: string[] = [];
	for (const range of ranges) {
		if (range.startLine > totalLines) {
			outOfBounds.push(range);
			continue;
		}
		const effectiveEnd = Math.min(range.endLine ?? totalLines, totalLines);
		visibleSpans.push({ startLine: range.startLine, endLine: effectiveEnd });
		if (options.raw === true) {
			rawParts.push(allLines.slice(range.startLine - 1, effectiveEnd).join("\n"));
		}
	}

	let outputText = "";
	if (options.raw === true) {
		outputText = rawParts.length > 0 ? rawParts.join("\n\n…\n\n") : "";
	} else if (visibleSpans.length > 0) {
		const entries = buildLineEntriesWithBlockContext(allLines, visibleSpans, { path: options.sourcePath, text });
		if (shouldAddHashLines) seenLines = lineNumbersFromEntries(entries);
		const firstLine = entries.find(entry => entry.kind === "line");
		if (firstLine?.kind === "line") {
			details.displayContent = {
				text: lineEntriesToPlainText(entries, BRACKET_CONTEXT_ELLIPSIS),
				startLine: firstLine.lineNumber,
				lineNumbers: entries.map(entry => (entry.kind === "line" ? entry.lineNumber : null)),
			};
		}
		const formatted = formatLineEntriesWithMode(entries, shouldAddHashLines, shouldAddLineNumbers);
		outputText = hashContext && !emittedHashlineHeader ? prependHashlineHeader(formatted, hashContext) : formatted;
		if (hashContext) emittedHashlineHeader = true;
	}
	const notices: string[] = [];
	for (const range of outOfBounds) {
		const bound = range.endLine !== undefined ? `${range.startLine}-${range.endLine}` : `${range.startLine}`;
		notices.push(`[Range ${bound} is beyond end of ${options.entityLabel} (${totalLines} lines total); skipped]`);
	}
	const finalText =
		notices.length > 0 ? (outputText ? `${outputText}\n${notices.join("\n")}` : notices.join("\n")) : outputText;
	if (hashContext?.tag && options.sourcePath && seenLines) {
		getEditStore(session).recordSeenLines(options.sourcePath, hashContext.tag, seenLines);
	}
	if (options.raw === true && options.sourcePath && options.immutable !== true && visibleSpans.length > 0) {
		recordInMemorySeenLines(session, options.sourcePath, text, lineNumbersFromSpans(visibleSpans));
	}
	resultBuilder.text(finalText);
	return resultBuilder.done();
}
export function decodeUtf8Text(bytes: Uint8Array): string | null {
	if (bytes.indexOf(0) !== -1) return null;

	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

export function prependSuffixResolutionNotice(text: string, suffixResolution?: { from: string; to: string }): string {
	if (!suffixResolution) return text;

	const notice = `[Path '${suffixResolution.from}' not found; resolved to '${suffixResolution.to}' via suffix match]`;
	return text ? `${notice}\n${text}` : notice;
}
/**
 * Tag Markdown reads for the TUI's formatted preview, gated on the opt-in
 * `read.renderMarkdown` setting. Off by default; when disabled, no local
 * read is tagged `text/markdown`, so the renderer output is identical to
 * the pre-setting behavior. Internal-URL reads keep their protocol-supplied
 * `contentType` and render as Markdown regardless of the setting.
 */
export function markMarkdownContentType(
	session: ToolSession,
	details: ReadToolDetails,
	filePath: string,
): ReadToolDetails {
	if (!details.contentType && session.settings.get("read.renderMarkdown") && isMarkdownPath(filePath)) {
		details.contentType = "text/markdown";
	}
	return details;
}
