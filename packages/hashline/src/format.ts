/**
 * Hashline format primitives: sigils, separators, regex fragments, and
 * display helpers. These are the single source of truth for the parser, the
 * tokenizer, the prompt, and the formal grammar.
 */

import type { Cursor } from "./types";

/** File-section header delimiters: `[path#hash]`. */
export const HL_FILE_PREFIX = "[";
export const HL_FILE_SUFFIX = "]";

/** Payload sigil for literal body rows. */
export const HL_PAYLOAD_REPLACE = "+";

/** Hunk-header keyword: `PUT` writes content (body rows) or a register at a span or gap. */
export const HL_PUT_KEYWORD = "PUT";
/** Hunk-header keyword: `CUT N.=M` / `CUT N*` deletes lines and captures them (anonymous register, or `@name` when given). */
export const HL_CUT_KEYWORD = "CUT";
/** File-level keyword: `REM` deletes the whole file named by the section header. */
export const HL_REM_KEYWORD = "REM";
/** File-level keyword: `MV DEST` renames/moves the section file to `DEST`. */
export const HL_MOVE_KEYWORD = "MV";
export const HL_HEADER_COLON = ":";

/** Gap sigil: `<N` targets the gap before line N (`<1` = head). */
export const HL_GAP_BEFORE = "<";
/** Gap sigil: `>N` targets the gap after line N (`>$` = tail). */
export const HL_GAP_AFTER = ">";
/** Locator suffix: `N*` extends the anchor to the syntactic block opening at N. */
export const HL_BLOCK_SUFFIX = "*";
/** Gap anchor: `$` names the last line, so `>$` is end-of-file. */
export const HL_EOF_ANCHOR = "$";
/** Register sigil: `@name` selects a named clipboard register on `PUT`/`CUT`. */
export const HL_REGISTER_SIGIL = "@";

/** Separator between a hashline file path and its opaque snapshot tag. */
export const HL_FILE_HASH_SEP = "#";

/** Canonical separator between inclusive range endpoints, e.g. `5.=10`. */
export const HL_RANGE_SEP = ".=";

/** Separator between a line number and displayed line content in hashline mode. */
export const HL_LINE_BODY_SEP = ":";

function regexEscape(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Bare positive line-number Lid (no decorations, no captures, no anchors). */
export const HL_LINE_RE_RAW = `[1-9]\\d*`;

/** Capture-group form of {@link HL_LINE_RE_RAW}. */
export const HL_LINE_CAPTURE_RE_RAW = `(${HL_LINE_RE_RAW})`;

/** Format a concrete replacement hunk header (`PUT 5.=9:`). */
export function formatReplaceHeader(start: number, end: number): string {
	return `${HL_PUT_KEYWORD} ${start}${HL_RANGE_SEP}${end}${HL_HEADER_COLON}`;
}

/** Format a concrete cut hunk header (`CUT 5.=9`). */
export function formatCutHeader(start: number, end = start): string {
	return `${HL_CUT_KEYWORD} ${start}${HL_RANGE_SEP}${end}`;
}

/** Format a gap locator for a cursor position (`<5`, `>5`, `<1`, `>$`). */
export function formatGapLocator(cursor: Cursor): string {
	switch (cursor.kind) {
		case "before_anchor":
			return `${HL_GAP_BEFORE}${cursor.anchor.line}`;
		case "after_anchor":
			return `${HL_GAP_AFTER}${cursor.anchor.line}`;
		case "bof":
			return `${HL_GAP_BEFORE}1`;
		case "eof":
			return `${HL_GAP_AFTER}${HL_EOF_ANCHOR}`;
	}
}

/** Format an insertion hunk header for a cursor position (`PUT <5:`, `PUT >$:`). */
export function formatInsertHeader(cursor: Cursor): string {
	return `${HL_PUT_KEYWORD} ${formatGapLocator(cursor)}${HL_HEADER_COLON}`;
}

/** Format a register reference (`@name`). */
export function formatRegister(name: string): string {
	return `${HL_REGISTER_SIGIL}${name}`;
}

/** Number of hex characters in a content-derived file-hash tag. */
export const HL_FILE_HASH_LENGTH = 4;
/** Canonical uppercase hexadecimal content-hash tag carried by a hashline section header. */
export const HL_FILE_HASH_RE_RAW = `[0-9A-F]{${HL_FILE_HASH_LENGTH}}`;
/** Capture-group form of {@link HL_FILE_HASH_RE_RAW}. */
export const HL_FILE_HASH_CAPTURE_RE_RAW = `(${HL_FILE_HASH_RE_RAW})`;
/** Regex-escaped form of {@link HL_LINE_BODY_SEP}, safe for embedding inside a regex. */
export const HL_LINE_BODY_SEP_RE_RAW = regexEscape(HL_LINE_BODY_SEP);
/**
 * Representative file-hash tags for use in user-facing error messages and
 * prompt examples.
 */
export const HL_FILE_HASH_EXAMPLES = ["1A2B", "3C4D", "9F3E"] as const;
/**
 * Normalize text before hashing: trim trailing `[ \t\r]` from every line (and
 * the final line) in a single pass so CRLF endings and display-trimmed lines
 * do not invalidate a tag.
 */
function normalizeFileHashText(text: string): string {
	return text.replace(/[ \t\r]+(?=\n|$)/g, "");
}
/**
 * Compute the content-derived hash tag carried by a hashline section header.
 * The tag is a 4-hex fingerprint of the whole file's normalized text: any read
 * of byte-identical content mints the same tag, and a follow-up edit anchored
 * at any line validates whenever the live file still hashes to it.
 */
export function computeFileHash(text: string): string {
	const normalized = normalizeFileHashText(text);
	const low16 = Bun.hash.xxHash32(normalized, 0) & 0xffff;
	return low16.toString(16).padStart(HL_FILE_HASH_LENGTH, "0").toUpperCase();
}

/**
 * Format a comma-separated list of example anchors with an optional line-number
 * prefix, quoted for inclusion in error messages: `"160", "42", "7"`.
 */
export function describeAnchorExamples(linePrefix = ""): string {
	const examples = linePrefix ? [linePrefix, `${linePrefix.slice(0, -1) || "4"}2`, "7"] : ["160", "42", "7"];
	return examples.map(e => `"${e}"`).join(", ");
}

/** Format a hashline section header for a file path and snapshot tag. */
export function formatHashlineHeader(filePath: string, fileHash: string): string {
	return `${HL_FILE_PREFIX}${filePath}${HL_FILE_HASH_SEP}${fileHash}${HL_FILE_SUFFIX}`;
}

/** Formats a single numbered line as `LINE:TEXT`. */
export function formatNumberedLine(lineNumber: number, line: string): string {
	return `${lineNumber}${HL_LINE_BODY_SEP}${line}`;
}

/**
 * Split LF-delimited file text into lines hashline anchors can address.
 * A terminal newline terminates the preceding line; it is not content.
 */
export function splitAddressableFileLines(text: string): string[] {
	const lines = text.split("\n");
	if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
	return lines;
}

/** Format file text with hashline-mode line-number prefixes for display. */
export function formatNumberedLines(text: string, startLine = 1): string {
	return text
		.split("\n")
		.map((line, i) => formatNumberedLine(startLine + i, line))
		.join("\n");
}
