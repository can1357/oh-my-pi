/**
 * Content helpers shared by every whole-file writer: the `write` tool's file
 * pipeline and handler-owned writes that splice files directly (conflict://).
 */
import {
	formatHashlineHeader,
	formatNumberedLine,
	splitAddressableFileLines,
	stripHashlinePrefixes,
} from "@oh-my-pi/pi-tui/tools/hashline-format";
import { normalizeToLF } from "../edit/normalize";
import { getEditStore } from "../edit/store";
import { resolveFileDisplayMode } from "../utils/file-display-mode";
import type { ToolSession } from "./index";
import { formatPathRelativeToCwd } from "./path-utils";

const LOOSE_HASHLINE_HEADER_RE = /^\s*\[[^#\r\n]+#[^ \t\r\n]*\]\s*$/;
/**
 * The first non-empty row, past leading whitespace (JS `\s` plus U+0085, a
 * superset of the native `\s`/`trim`), starts with a character no hashline
 * prefix, file header, loose header or read metadata row can start with.
 * Native stripping only fires when every content row is prefixed, and this
 * row is then a plain content row that also is not the loose header — so the
 * content cannot change.
 */
const PLAIN_FIRST_ROW_RE = /^\n*(?:[^\S\n]|\u0085)*[^\s\u0085[>+*\-.…\p{Nd}]/u;

/**
 * `stripHashlinePrefixes(lines).join("\n")`, or `undefined` when that equals `text`
 * (`lines.join("\n")`, joined only if the rows differ). Rows are compared first so
 * unprefixed content is never re-joined.
 */
function joinStrippedLines(lines: string[], text?: string): string | undefined {
	const cleaned = stripHashlinePrefixes(lines);
	if (cleaned.length === lines.length) {
		let index = 0;
		while (index < lines.length && cleaned[index] === lines[index]) index++;
		if (index === lines.length) return undefined;
	}
	const cleanedText = cleaned.join("\n");
	return cleanedText === (text ?? lines.join("\n")) ? undefined : cleanedText;
}

/**
 * Strip hashline display prefixes from write content.
 *
 * Includes a fallback for loosely-formed section headers that still carry
 * line-number prefixes (for example legacy or malformed hashline echoes).
 */
function stripWriteContentWithPotentialLooseHeader(content: string): { text: string; stripped: boolean } {
	// Lone surrogates still take the native path: its UTF-8 round trip rewrites them.
	if (PLAIN_FIRST_ROW_RE.test(content) && content.isWellFormed()) {
		return { text: content, stripped: false };
	}
	const lines = content.split("\n");
	const cleanedText = joinStrippedLines(lines, content);
	if (cleanedText !== undefined) {
		return { text: cleanedText, stripped: true };
	}

	const headerIndex = lines.findIndex(line => line.trim().length > 0);
	if (headerIndex === -1 || !LOOSE_HASHLINE_HEADER_RE.test(lines[headerIndex])) {
		return { text: content, stripped: false };
	}

	const linesWithoutHeader = lines.slice(0, headerIndex).concat(lines.slice(headerIndex + 1));
	const cleanedWithoutHeader = joinStrippedLines(linesWithoutHeader);
	if (cleanedWithoutHeader === undefined) {
		return { text: content, stripped: false };
	}
	return { text: cleanedWithoutHeader, stripped: true };
}

/**
 * Strip hashline display prefixes from write content.
 *
 * Only active when hashline edit mode is enabled — the model sees `[PATH#HASH]`
 * headers plus `LINE:` prefixes in read output and sometimes copies them into write content.
 */
export function stripWriteContent(session: ToolSession, content: string): { text: string; stripped: boolean } {
	if (!resolveFileDisplayMode(session).hashLines) {
		return { text: content, stripped: false };
	}
	return stripWriteContentWithPotentialLooseHeader(content);
}

/** Lines of the written content the write result numbers for the model. */
export const WRITE_MAP_MAX_LINES = 1000;
/** Characters of numbered map the write result may carry. */
const WRITE_MAP_MAX_CHARS = 32_768;

/**
 * A write's hashline display: the `[path#TAG]` header plus the numbered rows
 * of the written content that tell the model which line holds what.
 */
export interface WriteSnapshotDisplay {
	/** `[displayPath#TAG]` header for the written file. */
	header: string;
	/** Numbered rows (`N:text`) of the written content. */
	rows: string;
	/** Line numbers the rows display. */
	seenLines: number[];
	/** Lines of the written content the rows do not cover. */
	hiddenLines: number;
}

/**
 * The leading lines of `lines` the write result numbers, bounded so a large
 * write cannot flood the transcript.
 */
function takeWriteMapLines(lines: readonly string[]): string[] {
	const shown: string[] = [];
	let chars = 0;
	for (const line of lines) {
		if (shown.length >= WRITE_MAP_MAX_LINES) break;
		chars += line.length + 1;
		if (chars > WRITE_MAP_MAX_CHARS) break;
		shown.push(line);
	}
	return shown;
}

/**
 * Record a snapshot of a handler-written file and return its `[path#TAG]`
 * header (`displayPath` defaults to `absolutePath` relative to cwd; URL writes
 * pass their URL). Returns `undefined` when the session is not in hashline mode
 * so callers can no-op cheaply.
 *
 * The handler's result shows no numbered lines, so the tag carries no
 * seen-line provenance: it marks the content, not what the model saw.
 */
export function maybeWriteSnapshotHeader(
	session: ToolSession,
	absolutePath: string,
	content: string,
	displayPath = formatPathRelativeToCwd(absolutePath, session.cwd),
): string | undefined {
	if (!resolveFileDisplayMode(session).hashLines) return undefined;
	const normalized = normalizeToLF(content);
	const tag = getEditStore(session).recordSnapshot(absolutePath, normalized);
	return formatHashlineHeader(displayPath, tag);
}

/**
 * Record a snapshot of the freshly-written `content` for `absolutePath`
 * so subsequent hashline edits address the new file with a current tag,
 * and return the matching `[displayPath#TAG]` header (`displayPath` defaults to
 * `absolutePath` relative to cwd; URL writes pass their URL). Returns `undefined`
 * when the session is not in hashline mode so callers can no-op cheaply.
 *
 * Mirrors the post-commit snapshot recording the hashline patcher performs
 * after a successful edit — the model gets a tag without an extra `read` —
 * and numbers the written lines the same way, so the model knows the line
 * numbers it anchors on instead of guessing them. The numbered rows are the
 * snapshot's seen lines: the model displayed them, so it may edit them.
 */
export function maybeWriteSnapshotDisplay(
	session: ToolSession,
	absolutePath: string,
	content: string,
	displayPath = formatPathRelativeToCwd(absolutePath, session.cwd),
): WriteSnapshotDisplay | undefined {
	if (!resolveFileDisplayMode(session).hashLines) return undefined;
	const normalized = normalizeToLF(content);
	const lines = splitAddressableFileLines(normalized);
	const shown = takeWriteMapLines(lines);
	const seenLines = shown.map((_, index) => index + 1);
	// A file with no lines has no provenance to record: an empty set would say
	// "no line was displayed", which the guard reads as "every anchor is
	// unseen".
	const tag = getEditStore(session).recordSnapshot(
		absolutePath,
		normalized,
		seenLines.length > 0 ? seenLines : undefined,
	);
	const rows = shown.map((line, index) => formatNumberedLine(index + 1, line)).join("\n");
	return {
		header: formatHashlineHeader(displayPath, tag),
		rows,
		seenLines,
		hiddenLines: lines.length - shown.length,
	};
}

/**
 * Assemble a write result from its hashline display: the `[path#TAG]` header,
 * the summary line, and the numbered rows of the written content that give the
 * model the line numbers it anchors on.
 */
export function formatWriteSnapshotText(display: WriteSnapshotDisplay | undefined, summary: string): string {
	if (!display) return summary;
	const numbered = display.seenLines.length;
	const note =
		display.hiddenLines > 0
			? ` (${numbered + display.hiddenLines} lines; the first ${numbered} are numbered below — read the file before anchoring edits past line ${numbered})`
			: "";
	const rows = display.rows ? `\n${display.rows}` : "";
	return `${display.header}\n${summary}${note}${rows}`;
}
