/**
 * Content helpers shared by every whole-file writer: the `write` tool's file
 * pipeline and handler-owned writes that splice files directly (conflict://).
 */
import { formatHashlineHeader, stripHashlinePrefixes } from "./hashline-format";
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

/** A read/search row prefix (`12:`, `12|`, `+12:`, `>>12:`) and the text after it. */
const NUMBERED_ROW_RE = /^\s*(?:(?:>>>|>>)\s*)?(?:[+*-]\s*)?(\d+)[:|](.*)$/;

/**
 * Whether numbered rows are evidenced as copied display prefixes rather than
 * content (a TSV index column, numbered notes, `000:` rows): the payload
 * carries a `[path#TAG]` header, or at least two of its rows (its only row,
 * for one) repeat the line at that number of the target's latest snapshot.
 */
function prefixesEvidenced(session: ToolSession, lines: string[], absolutePath: string | undefined): boolean {
	if (lines.some(line => LOOSE_HASHLINE_HEADER_RE.test(line))) return true;
	if (!absolutePath) return false;
	const head = getEditStore(session).headText(absolutePath);
	if (head === null) return false;
	const source = head.split("\n");
	let numbered = 0;
	let matched = 0;
	for (const line of lines) {
		const row = NUMBERED_ROW_RE.exec(line);
		if (!row) continue;
		numbered++;
		if (source[Number(row[1]) - 1] === row[2]) matched++;
	}
	return matched > 0 && matched >= Math.min(2, numbered);
}

/**
 * Strip hashline display prefixes from write content.
 *
 * Includes a fallback for loosely-formed section headers that still carry
 * line-number prefixes (for example legacy or malformed hashline echoes).
 */
function stripWriteContentWithPotentialLooseHeader(
	session: ToolSession,
	content: string,
	evidence: WriteStripEvidence | undefined,
): { text: string; stripped: boolean } {
	// Lone surrogates still take the native path: its UTF-8 round trip rewrites them.
	if (PLAIN_FIRST_ROW_RE.test(content) && content.isWellFormed()) {
		return { text: content, stripped: false };
	}
	const lines = content.split("\n");
	const cleanedText = joinStrippedLines(lines, content);
	if (cleanedText !== undefined) {
		return evidence === undefined || prefixesEvidenced(session, lines, evidence.targetPath)
			? { text: cleanedText, stripped: true }
			: { text: content, stripped: false };
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

/** What a whole-file write checks before it strips numbered rows; `targetPath` is the file written, when known. */
export interface WriteStripEvidence {
	targetPath: string | undefined;
}

/**
 * Strip hashline display prefixes from write content.
 *
 * Only active when hashline edit mode is enabled — the model sees `[PATH#HASH]`
 * headers plus `LINE:` prefixes in read output and sometimes copies them into write content.
 * With `evidence`, numbered content (a TSV index column, numbered notes) is kept
 * unless it is evidenced as copied output ({@link prefixesEvidenced}); without it
 * (conflict:// regions, which are read with their numbers) every copied prefix is stripped.
 */
export function stripWriteContent(
	session: ToolSession,
	content: string,
	evidence?: WriteStripEvidence,
): { text: string; stripped: boolean } {
	if (!resolveFileDisplayMode(session).hashLines) {
		return { text: content, stripped: false };
	}
	return stripWriteContentWithPotentialLooseHeader(session, content, evidence);
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
 * but with EMPTY seen-line provenance: the model authored every line, so the
 * tag is unrestricted, and a later partial read of the same content does not
 * narrow it (see `merge_seen` in omp-edit's store).
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
