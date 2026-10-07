/**
 * Content helpers shared by every whole-file writer: the `write` tool's file
 * pipeline and handler-owned writes that splice files directly (conflict://).
 */
import { formatHashlineHeader, stripHashlinePrefixes } from "@oh-my-pi/pi-tui/tools/hashline-format";
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

/**
 * Record a snapshot of the freshly-written `content` for `absolutePath`
 * so subsequent hashline edits address the new file with a current tag,
 * and return the matching `[displayPath#TAG]` header (`displayPath` defaults to
 * `absolutePath` relative to cwd; URL writes pass their URL). Returns `undefined`
 * when the session is not in hashline mode so callers can no-op cheaply.
 *
 * Mirrors the post-commit snapshot recording the hashline patcher performs
 * after a successful edit — the model gets a tag without an extra `read` —
 * but with EMPTY seen-line provenance: a write displays no numbered lines,
 * so anchored edits against this tag must first see the anchor content (the
 * patcher rejects them with an inline reveal). Authoring content is not
 * knowing its line numbers.
 */
export function maybeWriteSnapshotHeader(
	session: ToolSession,
	absolutePath: string,
	content: string,
	displayPath = formatPathRelativeToCwd(absolutePath, session.cwd),
): string | undefined {
	if (!resolveFileDisplayMode(session).hashLines) return undefined;
	const normalized = normalizeToLF(content);
	const tag = getEditStore(session).recordSnapshot(absolutePath, normalized, []);
	return formatHashlineHeader(displayPath, tag);
}
