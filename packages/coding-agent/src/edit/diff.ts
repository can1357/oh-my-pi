/**
 * Diff generation and replace-mode utilities for the edit tool.
 *
 * Provides diff string generation and the replace-mode edit logic
 * used when not in patch mode.
 */
import { diffLines, structuredPatchHunks } from "@oh-my-pi/pi-natives";
import { resolveToCwd } from "../tools/path-utils";
import { type BlockContextSource, findBlockContextLines } from "../utils/block-context";
import { DEFAULT_FUZZY_THRESHOLD, EditMatchError, findMatch } from "./modes/replace";
import { adjustIndentation, normalizeToLF, stripBom } from "./normalize";
import { readEditFileText } from "./read-file";

export interface DiffResult {
	diff: string;
	firstChangedLine: number | undefined;
}

export interface DiffError {
	error: string;
}

export interface DiffHunk {
	changeContext?: string;
	oldStartLine?: number;
	newStartLine?: number;
	hasContextLines: boolean;
	oldLines: string[];
	newLines: string[];
	isEndOfFile: boolean;
}

export class ParseError extends Error {
	constructor(
		message: string,
		readonly lineNumber?: number,
	) {
		super(lineNumber !== undefined ? `Line ${lineNumber}: ${message}` : message);
		this.name = "ParseError";
	}
}

export class ApplyPatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ApplyPatchError";
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Diff String Generation
// ═══════════════════════════════════════════════════════════════════════════

function formatNumberedDiffLine(prefix: "+" | "-" | " ", lineNum: number, content: string): string {
	return `${prefix}${lineNum}|${content}`;
}

interface ParsedNumberedDiffRow {
	prefix: "+" | "-" | " ";
	lineNumber: number;
	content: string;
}

function parseNumberedDiffRow(row: string): ParsedNumberedDiffRow | undefined {
	const match = /^([+\- ])(\d+)\|(.*)$/s.exec(row);
	if (!match) return undefined;
	const prefix = match[1] as "+" | "-" | " ";
	const lineNumber = Number.parseInt(match[2], 10);
	if (!Number.isFinite(lineNumber)) return undefined;
	return { prefix, lineNumber, content: match[3] ?? "" };
}

function isDiffChangeRow(row: string | undefined): boolean {
	return row !== undefined && (row.startsWith("+") || row.startsWith("-"));
}

/** Blank row separating non-contiguous regions of a numbered diff. */
const DIFF_GAP_ROW = "";

/** Old-file line number of a source-visible row (`-` or context); `+`/gap/other rows yield undefined. */
function parseSourceRowLineNumber(row: string): number | undefined {
	const parsed = parseNumberedDiffRow(row);
	return parsed === undefined || parsed.prefix === "+" ? undefined : parsed.lineNumber;
}

/**
 * Drop gap rows that no longer separate anything. Context rows are inserted
 * one at a time, each adding its own gap rows from a snapshot of the diff, so
 * the raw result can contain adjacent gap rows, gap rows whose neighbors
 * became contiguous after a later insert filled the hole, and gap rows at the
 * diff edges. The sweep keeps a gap row only when it sits between two
 * source-numbered rows (old-file coordinates — the same numbering the
 * insertion gap test uses) that are actually non-contiguous, and never keeps
 * two in a row.
 */
function normalizeDiffGapRows(rows: string[]): void {
	const kept: string[] = [];
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		if (row !== DIFF_GAP_ROW) {
			kept.push(row);
			continue;
		}
		if (kept.length === 0 || kept[kept.length - 1] === DIFF_GAP_ROW) continue;
		let before: number | undefined;
		for (let j = kept.length - 1; j >= 0 && before === undefined; j--) {
			before = parseSourceRowLineNumber(kept[j]);
		}
		let after: number | undefined;
		for (let j = i + 1; j < rows.length && after === undefined; j++) {
			if (rows[j] === DIFF_GAP_ROW) continue;
			after = parseSourceRowLineNumber(rows[j]);
		}
		if (before === undefined || after === undefined || after <= before + 1) continue;
		kept.push(row);
	}
	if (kept.length !== rows.length) rows.splice(0, rows.length, ...kept);
}

function adjustedContextInsertIndex(rows: readonly string[], index: number): number {
	let start = index;
	while (start > 0 && isDiffChangeRow(rows[start - 1])) start--;
	let end = index;
	while (end < rows.length && isDiffChangeRow(rows[end])) end++;
	return index > start && index < end ? end : index;
}

function insertBracketContextRows(
	rows: string[],
	contextLines: ReadonlyMap<number, string>,
	seenRows: Set<string>,
): void {
	const context = [...contextLines].sort(([left], [right]) => left - right);
	for (const [lineNumber, text] of context) {
		const row = formatNumberedDiffLine(" ", lineNumber, text);
		if (seenRows.has(row)) continue;

		let insertIndex = rows.length;
		let previousSourceLine: number | undefined;
		let nextSourceLine: number | undefined;
		for (let i = 0; i < rows.length; i++) {
			const parsed = parseNumberedDiffRow(rows[i]);
			if (!parsed || parsed.prefix === "+") continue;
			if (parsed.lineNumber < lineNumber) {
				previousSourceLine = parsed.lineNumber;
				continue;
			}
			nextSourceLine = parsed.lineNumber;
			insertIndex = i;
			break;
		}

		const chunk: string[] = [];
		if (previousSourceLine !== undefined && lineNumber > previousSourceLine + 1) chunk.push(DIFF_GAP_ROW);
		chunk.push(row);
		if (nextSourceLine !== undefined && nextSourceLine > lineNumber + 1) chunk.push(DIFF_GAP_ROW);

		const adjustedIndex = adjustedContextInsertIndex(rows, insertIndex);
		rows.splice(adjustedIndex, 0, ...chunk);
		seenRows.add(row);
	}
}

/**
 * Insert off-window block-boundary rows (enclosing header, matching closing
 * bracket, …) into a numbered diff. Context rows carry pre-edit line numbers —
 * the renumbering contract of `buildCompactDiffPreview` — so boundary lines
 * discovered in the new file are translated back to their pre-edit numbers
 * and merged with the old-file pass before a single insertion sweep. Without
 * the translation, a context line sitting in a net-offset region would be
 * re-inserted under its post-edit number: duplicated, out of order, and
 * renumbered incorrectly by the preview.
 */
function addMatchingBracketContextRows(
	rows: string[],
	oldLines: readonly string[],
	newLines: readonly string[],
	source: BlockContextSource,
): void {
	const oldVisible: number[] = [];
	const newVisible: number[] = [];
	const seenRows = new Set(rows);
	// Change positions in new-file coordinates, used to translate an unchanged
	// new-file line number back to its pre-edit equivalent.
	const changes: { newPos: number; delta: 1 | -1 }[] = [];
	let offset = 0;

	for (const row of rows) {
		const parsed = parseNumberedDiffRow(row);
		if (!parsed) continue;
		switch (parsed.prefix) {
			case "-":
				oldVisible.push(parsed.lineNumber);
				changes.push({ newPos: parsed.lineNumber + offset, delta: -1 });
				offset--;
				break;
			case "+":
				newVisible.push(parsed.lineNumber);
				changes.push({ newPos: parsed.lineNumber, delta: 1 });
				offset++;
				break;
			default:
				// Context rows are visible in BOTH files: pre-edit number as
				// written, post-edit number shifted by the net change so far.
				oldVisible.push(parsed.lineNumber);
				newVisible.push(parsed.lineNumber + offset);
				break;
		}
	}

	const toOldLineNumber = (newLineNumber: number): number => {
		let shift = 0;
		for (const change of changes) {
			if (change.newPos <= newLineNumber) shift += change.delta;
		}
		return newLineNumber - shift;
	};

	const contextRows = findBlockContextLines(oldLines, oldVisible, source);
	for (const [lineNumber, text] of findBlockContextLines(newLines, newVisible, source)) {
		const oldLineNumber = toOldLineNumber(lineNumber);
		if (!contextRows.has(oldLineNumber)) contextRows.set(oldLineNumber, text);
	}
	insertBracketContextRows(rows, contextRows, seenRows);
	normalizeDiffGapRows(rows);
}

/**
 * Generate a unified diff string with line numbers and context.
 * Returns both the diff string and the first changed line number (in the new file).
 */
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 2,
	source: BlockContextSource = {},
): DiffResult {
	const parts = diffLines(oldContent, newContent);
	const output: string[] = [];

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") {
			raw.pop();
		}

		if (part.added || part.removed) {
			// Capture the first changed line (in the new file)
			if (firstChangedLine === undefined) {
				firstChangedLine = newLineNum;
			}

			// Show the change
			for (const line of raw) {
				if (part.added) {
					output.push(formatNumberedDiffLine("+", newLineNum, line));
					newLineNum++;
				} else {
					output.push(formatNumberedDiffLine("-", oldLineNum, line));
					oldLineNum++;
				}
			}
			lastWasChange = true;
		} else {
			// Context lines - only show a few before/after changes
			const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);

			if (lastWasChange || nextPartIsChange) {
				const contextLimit = Math.max(0, contextLines);
				let leadingSkip = 0;
				let middleSkip = 0;
				let trailingSkip = 0;
				let linesToShow: string[];

				if (lastWasChange && nextPartIsChange) {
					if (raw.length > contextLimit * 2) {
						const leadingContext = raw.slice(0, contextLimit);
						const trailingContext = raw.slice(raw.length - contextLimit);
						middleSkip = raw.length - leadingContext.length - trailingContext.length;
						linesToShow = [...leadingContext, ...trailingContext];
					} else {
						linesToShow = raw;
					}
				} else if (nextPartIsChange) {
					leadingSkip = Math.max(0, raw.length - contextLimit);
					linesToShow = raw.slice(leadingSkip);
				} else {
					trailingSkip = Math.max(0, raw.length - contextLimit);
					linesToShow = raw.slice(0, contextLimit);
				}

				// Leading-skip placeholder is omitted: the first emitted line's
				// number already conveys that earlier lines were trimmed.
				if (leadingSkip > 0) {
					oldLineNum += leadingSkip;
					newLineNum += leadingSkip;
				}

				const firstChunkLength = middleSkip > 0 ? contextLimit : linesToShow.length;
				for (const line of linesToShow.slice(0, firstChunkLength)) {
					output.push(formatNumberedDiffLine(" ", oldLineNum, line));
					oldLineNum++;
					newLineNum++;
				}

				// Mid-skip placeholder is omitted too: the jump between the trailing
				// number of the leading context and the leading number of the
				// trailing context conveys the gap, just like leading/trailing skips.
				if (middleSkip > 0) {
					oldLineNum += middleSkip;
					newLineNum += middleSkip;
					for (const line of linesToShow.slice(firstChunkLength)) {
						output.push(formatNumberedDiffLine(" ", oldLineNum, line));
						oldLineNum++;
						newLineNum++;
					}
				}

				// Trailing-skip placeholder is omitted for the same reason: the
				// final emitted line's number tells the reader the file continues.
				if (trailingSkip > 0) {
					oldLineNum += trailingSkip;
					newLineNum += trailingSkip;
				}
			} else {
				// Skip these context lines entirely
				oldLineNum += raw.length;
				newLineNum += raw.length;
			}

			lastWasChange = false;
		}
	}

	addMatchingBracketContextRows(output, oldContent.split("\n"), newContent.split("\n"), source);

	return { diff: output.join("\n"), firstChangedLine };
}

// ═══════════════════════════════════════════════════════════════════════════
// Replace Mode Logic
// ═══════════════════════════════════════════════════════════════════════════

export interface ReplaceOptions {
	/** Allow fuzzy matching */
	fuzzy: boolean;
	/** Replace all occurrences */
	all: boolean;
	/** Similarity threshold for fuzzy matching */
	threshold?: number;
}

export interface ReplaceResult {
	/** The new content after replacements */
	content: string;
	/** Number of replacements made */
	count: number;
}

/**
 * Generate a unified diff string without file headers.
 * Returns both the diff string and the first changed line number (in the new file).
 */
export function generateUnifiedDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 3,
	source: BlockContextSource = {},
): DiffResult {
	const hunks = structuredPatchHunks(oldContent, newContent, contextLines);
	const output: string[] = [];
	let firstChangedLine: number | undefined;
	for (const hunk of hunks) {
		output.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
		let oldLine = hunk.oldStart;
		let newLine = hunk.newStart;
		for (const line of hunk.lines) {
			if (line.startsWith("-")) {
				if (firstChangedLine === undefined) firstChangedLine = newLine;
				output.push(formatNumberedDiffLine("-", oldLine, line.slice(1)));
				oldLine++;
				continue;
			}
			if (line.startsWith("+")) {
				if (firstChangedLine === undefined) firstChangedLine = newLine;
				output.push(formatNumberedDiffLine("+", newLine, line.slice(1)));
				newLine++;
				continue;
			}
			if (line.startsWith(" ")) {
				output.push(formatNumberedDiffLine(" ", oldLine, line.slice(1)));
				oldLine++;
				newLine++;
				continue;
			}
			output.push(line);
		}
	}

	addMatchingBracketContextRows(output, oldContent.split("\n"), newContent.split("\n"), source);

	return { diff: output.join("\n"), firstChangedLine };
}

const EOF_MARKER = "*** End of File";
const CHANGE_CONTEXT_MARKER = "@@ ";
const EMPTY_CHANGE_CONTEXT_MARKER = "@@";
const UNIFIED_HUNK_HEADER_REGEX = /^@@\s*-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s*@@(?:\s*(.*))?$/;
const LINE_HINT_REGEX = /^lines?\s+(\d+)(?:\s*-\s*(\d+))?(?:\s*@@)?$/i;
const TOP_OF_FILE_REGEX = /^(top|start|beginning)\s+of\s+file$/i;
const MULTI_FILE_MARKERS = ["*** Update File:", "*** Add File:", "*** Delete File:", "diff --git "];
const DIFF_METADATA_PREFIXES = [
	"*** Update File:",
	"*** Add File:",
	"*** Delete File:",
	"diff --git ",
	"index ",
	"--- ",
	"+++ ",
	"new file mode ",
	"deleted file mode ",
	"rename from ",
	"rename to ",
	"similarity index ",
	"dissimilarity index ",
	"old mode ",
	"new mode ",
];
const PATCH_WRAPPER_PREFIXES = ["*** Begin Patch", "*** End Patch"];
const MAX_OCCURRENCE_PREVIEWS = 5;

function isDiffContentLine(line: string): boolean {
	const firstChar = line[0];
	if (firstChar === " ") return true;
	if (firstChar === "+") {
		return !line.startsWith("+++ ");
	}
	if (firstChar === "-") {
		return !line.startsWith("--- ");
	}
	return false;
}

function matchesTrimmedPrefix(line: string, prefixes: string[]): boolean {
	return prefixes.some(prefix => line.startsWith(prefix));
}

function isPatchWrapperLine(line: string): boolean {
	return line === "***" || matchesTrimmedPrefix(line, PATCH_WRAPPER_PREFIXES);
}

function formatOccurrenceMatchError(
	occurrences: number,
	occurrencePreviews: string[] | undefined,
	path?: string,
): string {
	const previews = occurrencePreviews?.join("\n\n") ?? "";
	const moreMsg =
		occurrences > MAX_OCCURRENCE_PREVIEWS ? ` (showing first ${MAX_OCCURRENCE_PREVIEWS} of ${occurrences})` : "";
	const pathSuffix = path ? ` in ${path}` : "";
	return `Found ${occurrences} occurrences${pathSuffix}${moreMsg}:\n\n${previews}\n\nAdd more context lines to disambiguate.`;
}

export function normalizeDiff(diff: string): string {
	let lines = diff.split("\n");

	while (lines.length > 0) {
		const lastLine = lines[lines.length - 1];
		if (lastLine === "" || (lastLine?.trim() === "" && !isDiffContentLine(lastLine ?? ""))) {
			lines = lines.slice(0, -1);
		} else {
			break;
		}
	}

	if (lines[0] && isPatchWrapperLine(lines[0].trim())) {
		lines = lines.slice(1);
	}
	if (lines.length > 0 && isPatchWrapperLine(lines[lines.length - 1]?.trim() ?? "")) {
		lines = lines.slice(0, -1);
	}

	lines = lines.filter(line => {
		if (isDiffContentLine(line)) {
			return true;
		}

		return !matchesTrimmedPrefix(line.trim(), DIFF_METADATA_PREFIXES);
	});

	return lines.join("\n");
}

export function normalizeCreateContent(content: string): string {
	const lines = content.split("\n");
	const nonEmptyLines = lines.filter(line => line.length > 0);

	if (nonEmptyLines.length > 0 && nonEmptyLines.every(line => line.startsWith("+ ") || line.startsWith("+"))) {
		return lines
			.map(line => {
				if (line.startsWith("+ ")) return line.slice(2);
				if (line.startsWith("+")) return line.slice(1);
				return line;
			})
			.join("\n");
	}

	return content;
}

interface UnifiedHunkHeader {
	oldStartLine: number;
	oldLineCount: number;
	newStartLine: number;
	newLineCount: number;
	changeContext?: string;
}

function parseUnifiedHunkHeader(line: string): UnifiedHunkHeader | undefined {
	const match = line.match(UNIFIED_HUNK_HEADER_REGEX);
	if (!match) return undefined;

	const oldStartLine = Number(match[1]);
	const oldLineCount = match[2] ? Number(match[2]) : 1;
	const newStartLine = Number(match[3]);
	const newLineCount = match[4] ? Number(match[4]) : 1;
	const changeContext = match[5]?.trim();

	return {
		oldStartLine,
		oldLineCount,
		newStartLine,
		newLineCount,
		changeContext: changeContext && changeContext.length > 0 ? changeContext : undefined,
	};
}

function isUnifiedDiffMetadataLine(line: string): boolean {
	return matchesTrimmedPrefix(
		line,
		DIFF_METADATA_PREFIXES.filter(prefix => !prefix.startsWith("*** ")),
	);
}

interface ParseHunkResult {
	hunk: DiffHunk;
	linesConsumed: number;
}

function parseOneHunk(lines: string[], lineNumber: number, allowMissingContext: boolean): ParseHunkResult {
	if (lines.length === 0) {
		throw new ParseError("Diff does not contain any lines", lineNumber);
	}

	const changeContexts: string[] = [];
	let oldStartLine: number | undefined;
	let newStartLine: number | undefined;
	let startIndex: number;

	const headerLine = lines[0];
	const headerTrimmed = headerLine.trimEnd();
	const isHeaderLine = headerLine.startsWith("@@");
	const unifiedHeader = isHeaderLine ? parseUnifiedHunkHeader(headerTrimmed) : undefined;
	const isEmptyContextMarker = /^@@\s*@@$/.test(headerTrimmed);

	if (isHeaderLine && (headerTrimmed === EMPTY_CHANGE_CONTEXT_MARKER || isEmptyContextMarker)) {
		startIndex = 1;
	} else if (unifiedHeader) {
		if (unifiedHeader.oldStartLine < 1 || unifiedHeader.newStartLine < 1) {
			throw new ParseError("Line numbers in @@ header must be >= 1", lineNumber);
		}
		if (unifiedHeader.changeContext) {
			changeContexts.push(unifiedHeader.changeContext);
		}
		oldStartLine = unifiedHeader.oldStartLine;
		newStartLine = unifiedHeader.newStartLine;
		startIndex = 1;
	} else if (isHeaderLine && headerTrimmed.startsWith(CHANGE_CONTEXT_MARKER)) {
		const contextValue = headerTrimmed.slice(CHANGE_CONTEXT_MARKER.length);
		const trimmedContextValue = contextValue.trim();
		const normalizedContextValue = trimmedContextValue.replace(/^@@\s*/u, "");

		const lineHintMatch = normalizedContextValue.match(LINE_HINT_REGEX);
		if (lineHintMatch) {
			oldStartLine = Number(lineHintMatch[1]);
			newStartLine = oldStartLine;
			if (oldStartLine < 1) {
				throw new ParseError("Line hint must be >= 1", lineNumber);
			}
		} else if (TOP_OF_FILE_REGEX.test(normalizedContextValue)) {
			oldStartLine = 1;
			newStartLine = 1;
		} else if (trimmedContextValue.length > 0) {
			changeContexts.push(contextValue);
		}
		startIndex = 1;
	} else if (isHeaderLine) {
		const contextValue = headerTrimmed.slice(2).trim();
		if (contextValue.length > 0) {
			changeContexts.push(contextValue);
		}
		startIndex = 1;
	} else {
		if (!allowMissingContext) {
			throw new ParseError(`Expected hunk to start with @@ context marker, got: '${lines[0]}'`, lineNumber);
		}
		startIndex = 0;
	}

	if (oldStartLine !== undefined && oldStartLine < 1) {
		throw new ParseError(`Line numbers must be >= 1 (got ${oldStartLine})`, lineNumber);
	}
	if (newStartLine !== undefined && newStartLine < 1) {
		throw new ParseError(`Line numbers must be >= 1 (got ${newStartLine})`, lineNumber);
	}

	while (startIndex < lines.length) {
		const nextLine = lines[startIndex];
		if (!nextLine.startsWith("@@")) {
			break;
		}
		const trimmed = nextLine.trimEnd();
		if (trimmed.startsWith(CHANGE_CONTEXT_MARKER)) {
			const nestedContext = trimmed.slice(CHANGE_CONTEXT_MARKER.length);
			if (nestedContext.trim().length > 0) {
				changeContexts.push(nestedContext);
			}
			startIndex++;
		} else if (trimmed === EMPTY_CHANGE_CONTEXT_MARKER) {
			startIndex++;
		} else {
			break;
		}
	}

	if (startIndex >= lines.length) {
		throw new ParseError("Hunk does not contain any lines", lineNumber + 1);
	}

	const changeContext = changeContexts.length > 0 ? changeContexts.join("\n") : undefined;

	const hunk: DiffHunk = {
		changeContext,
		oldStartLine,
		newStartLine,
		hasContextLines: false,
		oldLines: [],
		newLines: [],
		isEndOfFile: false,
	};

	let parsedLines = 0;

	for (let i = startIndex; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		const nextLine = lines[i + 1];

		if (line === "" && parsedLines > 0 && nextLine?.trimStart().startsWith("@@")) {
			break;
		}

		if (!isDiffContentLine(line) && line.trimEnd() === EOF_MARKER && line.startsWith(EOF_MARKER)) {
			if (parsedLines === 0) {
				throw new ParseError("Hunk does not contain any lines", lineNumber + 1);
			}
			hunk.isEndOfFile = true;
			parsedLines++;
			break;
		}

		if (trimmed === "..." || trimmed === "…") {
			hunk.hasContextLines = true;
			parsedLines++;
			continue;
		}

		const firstChar = line[0];

		if (firstChar === undefined || firstChar === "") {
			hunk.hasContextLines = true;
			hunk.oldLines.push("");
			hunk.newLines.push("");
		} else if (firstChar === " ") {
			hunk.hasContextLines = true;
			hunk.oldLines.push(line.slice(1));
			hunk.newLines.push(line.slice(1));
		} else if (firstChar === "+") {
			hunk.newLines.push(line.slice(1));
		} else if (firstChar === "-") {
			hunk.oldLines.push(line.slice(1));
		} else if (!line.startsWith("@@")) {
			hunk.hasContextLines = true;
			hunk.oldLines.push(line);
			hunk.newLines.push(line);
		} else {
			if (parsedLines === 0) {
				throw new ParseError(
					`Unexpected line in hunk: '${line}'. Lines must start with ' ' (context), '+' (add), or '-' (remove)`,
					lineNumber + 1,
				);
			}
			break;
		}
		parsedLines++;
	}

	if (parsedLines === 0) {
		throw new ParseError("Hunk does not contain any lines", lineNumber + startIndex);
	}

	stripLineNumberPrefixes(hunk);
	return { hunk, linesConsumed: parsedLines + startIndex };
}

function stripLineNumberPrefixes(hunk: DiffHunk): void {
	const allLines = [...hunk.oldLines, ...hunk.newLines].filter(line => line.trim().length > 0);
	if (allLines.length < 2) return;

	const numberMatches = allLines
		.map(line => line.match(/^\s*(\d{1,6})\s+(.+)$/u))
		.filter((match): match is RegExpMatchArray => match !== null);

	if (numberMatches.length < Math.max(2, Math.ceil(allLines.length * 0.6))) {
		return;
	}

	const numbers = numberMatches.map(match => Number(match[1]));
	let sequential = 0;
	for (let i = 1; i < numbers.length; i++) {
		if (numbers[i] === numbers[i - 1] + 1) {
			sequential++;
		}
	}

	if (numbers.length >= 3 && sequential < Math.max(1, numbers.length - 2)) {
		return;
	}

	const strip = (line: string): string => {
		const match = line.match(/^\s*\d{1,6}\s+(.+)$/u);
		return match ? match[1] : line;
	};

	hunk.oldLines = hunk.oldLines.map(strip);
	hunk.newLines = hunk.newLines.map(strip);
}

function countMultiFileMarkers(diff: string): number {
	const counts = new Map<string, number>();
	const paths = new Set<string>();
	const lines = diff.split("\n");
	for (const line of lines) {
		if (isDiffContentLine(line)) {
			continue;
		}
		const trimmed = line.trim();
		for (const marker of MULTI_FILE_MARKERS) {
			if (trimmed.startsWith(marker)) {
				const filePath = extractMarkerPath(trimmed);
				if (filePath) {
					paths.add(filePath);
				}
				counts.set(marker, (counts.get(marker) ?? 0) + 1);
				break;
			}
		}
	}
	if (paths.size > 0) {
		return paths.size;
	}
	let maxCount = 0;
	for (const count of counts.values()) {
		if (count > maxCount) {
			maxCount = count;
		}
	}
	return maxCount;
}

function extractMarkerPath(line: string): string | undefined {
	if (line.startsWith("diff --git ")) {
		const parts = line.split(/\s+/);
		const candidate = parts[3] ?? parts[2];
		if (!candidate) return undefined;
		return candidate.replace(/^(a|b)\//, "");
	}
	if (line.startsWith("*** Update File:")) {
		return line.slice("*** Update File:".length).trim();
	}
	if (line.startsWith("*** Add File:")) {
		return line.slice("*** Add File:".length).trim();
	}
	if (line.startsWith("*** Delete File:")) {
		return line.slice("*** Delete File:".length).trim();
	}
	return undefined;
}

export function parseDiffHunks(diff: string): DiffHunk[] {
	const multiFileCount = countMultiFileMarkers(diff);
	if (multiFileCount > 1) {
		throw new ApplyPatchError(
			`Diff contains ${multiFileCount} file markers. Single-file patches cannot contain multi-file markers.`,
		);
	}

	const normalizedDiff = normalizeDiff(diff);
	const lines = normalizedDiff.split("\n");
	const hunks: DiffHunk[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i];
		const trimmed = line.trim();

		if (trimmed === "") {
			i++;
			continue;
		}

		const firstChar = line[0];
		const isDiffContent = firstChar === " " || firstChar === "+" || firstChar === "-";
		if (!isDiffContent && isUnifiedDiffMetadataLine(trimmed)) {
			i++;
			continue;
		}

		if (trimmed.startsWith("@@") && lines.slice(i + 1).every(next => next.trim() === "")) {
			break;
		}

		const { hunk, linesConsumed } = parseOneHunk(lines.slice(i), i + 1, true);
		hunks.push(hunk);
		i += linesConsumed;
	}

	return hunks;
}

/**
 * Find and replace text in content using fuzzy matching.
 */
export function replaceText(content: string, oldText: string, newText: string, options: ReplaceOptions): ReplaceResult {
	if (oldText.length === 0) {
		throw new Error("oldText must not be empty.");
	}
	const threshold = options.threshold ?? DEFAULT_FUZZY_THRESHOLD;
	let normalizedContent = normalizeToLF(content);
	const normalizedOldText = normalizeToLF(oldText);
	const normalizedNewText = normalizeToLF(newText);

	if (options.all) {
		// Check for exact matches first
		const exactCount = normalizedContent.split(normalizedOldText).length - 1;
		if (exactCount > 0) {
			return {
				content: normalizedContent.split(normalizedOldText).join(normalizedNewText),
				count: exactCount,
			};
		}

		// Match against the immutable source so inserted replacement text cannot become a later candidate.
		const replacements: Array<{ startIndex: number; endIndex: number; text: string }> = [];
		while (true) {
			const matchOutcome = findMatch(normalizedContent, normalizedOldText, {
				allowFuzzy: options.fuzzy,
				threshold,
				excludedRanges: replacements,
			});

			const shouldUseClosest =
				options.fuzzy &&
				matchOutcome.closest &&
				matchOutcome.closest.confidence >= threshold &&
				(matchOutcome.fuzzyMatches === undefined || matchOutcome.fuzzyMatches <= 1);
			const match = matchOutcome.match || (shouldUseClosest ? matchOutcome.closest : undefined);
			if (!match) {
				break;
			}

			const adjustedNewText = adjustIndentation(normalizedOldText, match.actualText, normalizedNewText);
			if (adjustedNewText === match.actualText) {
				break;
			}
			replacements.push({
				startIndex: match.startIndex,
				endIndex: match.startIndex + Math.max(match.actualText.length, 1),
				text: adjustedNewText,
			});
		}

		replacements.sort((a, b) => a.startIndex - b.startIndex);
		const parts: string[] = [];
		let sourceIndex = 0;
		for (const replacement of replacements) {
			parts.push(normalizedContent.substring(sourceIndex, replacement.startIndex), replacement.text);
			sourceIndex = replacement.endIndex;
		}
		parts.push(normalizedContent.substring(sourceIndex));
		return { content: parts.join(""), count: replacements.length };
	}

	// Single replacement mode
	const matchOutcome = findMatch(normalizedContent, normalizedOldText, {
		allowFuzzy: options.fuzzy,
		threshold,
	});

	if (matchOutcome.occurrences && matchOutcome.occurrences > 1) {
		throw new Error(formatOccurrenceMatchError(matchOutcome.occurrences, matchOutcome.occurrencePreviews));
	}

	if (!matchOutcome.match) {
		return { content: normalizedContent, count: 0 };
	}

	const match = matchOutcome.match;
	const adjustedNewText = adjustIndentation(normalizedOldText, match.actualText, normalizedNewText);
	normalizedContent =
		normalizedContent.substring(0, match.startIndex) +
		adjustedNewText +
		normalizedContent.substring(match.startIndex + match.actualText.length);

	return { content: normalizedContent, count: 1 };
}

// ═══════════════════════════════════════════════════════════════════════════
// Preview/Diff Computation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute the diff for an edit operation without applying it.
 * Used for preview rendering in the TUI before the tool executes.
 */
export async function computeEditDiff(
	path: string,
	oldText: string,
	newText: string,
	cwd: string,
	fuzzy = true,
	all = false,
	threshold?: number,
): Promise<DiffResult | DiffError> {
	if (oldText.length === 0) {
		return { error: "oldText must not be empty." };
	}

	try {
		const absolutePath = resolveToCwd(path, cwd);
		let rawContent: string;
		try {
			rawContent = await readEditFileText(absolutePath, path);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { error: message || `Unable to read ${path}` };
		}

		const { text: content } = stripBom(rawContent);
		const normalizedContent = normalizeToLF(content);
		const normalizedOldText = normalizeToLF(oldText);
		const normalizedNewText = normalizeToLF(newText);

		const result = replaceText(normalizedContent, normalizedOldText, normalizedNewText, {
			fuzzy,
			all,
			threshold,
		});

		if (result.count === 0) {
			// Get closest match for error message
			const matchOutcome = findMatch(normalizedContent, normalizedOldText, {
				allowFuzzy: fuzzy,
				threshold: threshold ?? DEFAULT_FUZZY_THRESHOLD,
			});

			if (matchOutcome.occurrences && matchOutcome.occurrences > 1) {
				return {
					error: formatOccurrenceMatchError(matchOutcome.occurrences, matchOutcome.occurrencePreviews, path),
				};
			}

			return {
				error: EditMatchError.formatMessage(path, normalizedOldText, matchOutcome.closest, {
					allowFuzzy: fuzzy,
					threshold: threshold ?? DEFAULT_FUZZY_THRESHOLD,
					fuzzyMatches: matchOutcome.fuzzyMatches,
				}),
			};
		}

		if (normalizedContent === result.content) {
			return {
				error: `No changes would be made to ${path}. The replacement produces identical content.`,
			};
		}

		return generateDiffString(normalizedContent, result.content, undefined, { path });
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}
