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
import { truncateHead } from "@oh-my-pi/pi-tui/tools/streaming-output";
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
export const WRITE_MAP_MAX_CHARS = 32_768;
/**
 * Byte budget of the head window the write map reads. UTF-8 encodes at most
 * three bytes per UTF-16 code unit, so this budget never binds before
 * {@link WRITE_MAP_MAX_CHARS}: the map is cut by lines and characters, never
 * by encoding.
 */
const WRITE_MAP_MAX_BYTES = WRITE_MAP_MAX_CHARS * 3;

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
 * The leading lines of `content` the write result numbers, bounded so a large
 * write cannot flood the transcript.
 *
 * The head window is cut on line boundaries before anything is split, so a
 * file with millions of rows never materializes millions of strings: only the
 * rows the map can show are split out, while the totals come from the scan
 * that cut the window.
 */
function takeWriteMap(content: string): { shown: string[]; hiddenLines: number } {
	const head = truncateHead(content, { maxLines: WRITE_MAP_MAX_LINES, maxBytes: WRITE_MAP_MAX_BYTES });
	const shown: string[] = [];
	let chars = 0;
	for (const line of splitAddressableFileLines(head.content)) {
		if (shown.length >= WRITE_MAP_MAX_LINES) break;
		chars += line.length + 1;
		if (chars > WRITE_MAP_MAX_CHARS) break;
		shown.push(line);
	}
	// `truncateHead` counts the segment after a trailing newline as a line; a
	// trailing newline opens no addressable row.
	const totalLines = content.length === 0 ? 0 : content.endsWith("\n") ? head.totalLines - 1 : head.totalLines;
	return { shown, hiddenLines: totalLines - shown.length };
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
 * snapshot's seen lines: the model displayed them, so it may edit them. A
 * write that numbered no row at all (an empty file, or a first line past the
 * map cap) records the empty set instead, which the guard reads as "no line
 * was displayed" — every anchor on it is unseen.
 *
 * The rows number the file's own lines: `content` is what the write put on
 * disk, so a row shows the line the model will find there, not the row it
 * authored. A row is a display prefix in front of that line, exactly as a
 * `read` prints it, so copying the result back into a write behaves as
 * copying read output does. Numbers that are content rather than display (a
 * hex dump's addresses, a log's timestamps) were never display prefixes, so
 * they stay as written and are numbered like any other line.
 */
export function maybeWriteSnapshotDisplay(
	session: ToolSession,
	absolutePath: string,
	content: string,
	displayPath = formatPathRelativeToCwd(absolutePath, session.cwd),
): WriteSnapshotDisplay | undefined {
	if (!resolveFileDisplayMode(session).hashLines) return undefined;
	const normalized = normalizeToLF(content);
	const { shown, hiddenLines } = takeWriteMap(normalized);
	const seenLines = shown.map((_, index) => index + 1);
	// The numbered rows are the snapshot's seen lines: the model displayed
	// them, so it may edit them. An empty set is not "unrestricted" — it says
	// the write displayed no line at all, so every anchor on this tag is
	// unseen and the guard rejects it. Only a snapshot with no seen-line
	// record (`None`) skips the guard, and that is what the handler-owned
	// writes (`maybeWriteSnapshotHeader`) mint.
	const tag = getEditStore(session).recordSnapshot(absolutePath, normalized, seenLines);
	// A display prefix in front of the file's own line, in the shape a `read` prints.
	const rows = shown.map((line, index) => formatNumberedLine(index + 1, line)).join("\n");
	return {
		header: formatHashlineHeader(displayPath, tag),
		rows,
		seenLines,
		hiddenLines,
	};
}

/**
 * The note that tells the model which lines the write numbered and where the
 * numbered map stops. A write that numbered nothing (an empty file, or a
 * first line past the map cap) says so plainly: no line was displayed, so an
 * anchor on the tag is unseen until the file is read.
 */
function formatWriteMapNote(numbered: number, hidden: number): string {
	const total = numbered + hidden;
	if (numbered === 0) {
		if (total === 0) return " (the file is empty; there is nothing to anchor)";
		return ` (${total} line${total === 1 ? "" : "s"}; none were numbered — read the file before anchoring an edit)`;
	}
	if (hidden === 0) return "";
	return ` (${total} lines; the first ${numbered} are numbered below — read the file before anchoring edits past line ${numbered})`;
}

/**
 * Assemble a write result from its hashline display: the `[path#TAG]` header,
 * the summary line, and the numbered rows of the written content that give the
 * model the line numbers it anchors on.
 */
export function formatWriteSnapshotText(display: WriteSnapshotDisplay | undefined, summary: string): string {
	if (!display) return summary;
	const note = formatWriteMapNote(display.seenLines.length, display.hiddenLines);
	const rows = display.rows ? `\n${display.rows}` : "";
	return `${display.header}\n${summary}${note}${rows}`;
}
