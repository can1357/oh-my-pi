import {
	hashlineFileHash,
	hashlineFormatHeader,
	hashlineFormatNumberedLines,
	hashlineIsReadTruncationNotice,
	hashlineStripPrefixes,
} from "@oh-my-pi/pi-natives";

export const HL_FILE_PREFIX = "[";
export const HL_FILE_SUFFIX = "]";
export const HL_FILE_HASH_SEP = "#";
export const HL_FILE_HASH_LENGTH = 4;
export const HL_MOVE_KEYWORD = "MV";
export const HL_REM_KEYWORD = "REM";
export const HL_LINE_BODY_SEP = ":";

export function formatHashlineHeader(path: string, tag: string): string {
	return hashlineFormatHeader(path, tag);
}

export function formatNumberedLines(text: string, startLine?: number): string {
	return hashlineFormatNumberedLines(text, startLine);
}

export function formatNumberedLine(lineNumber: number, line: string): string {
	return `${lineNumber}:${line}`;
}

export function splitAddressableFileLines(text: string): string[] {
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

export function stripHashlinePrefixes(lines: string[]): string[] {
	return hashlineStripPrefixes(lines);
}

/**
 * Whether a row is a truncation notice emitted by `read`.
 *
 * Falls back to a JS mirror when the loaded addon predates the native export
 * (PR lanes run last-release addons): crashing on stale installs is worse
 * than a duplicated predicate. Parity with the native version is pinned by
 * `test/tools/hashline-format-parity.test.ts`.
 */
export function isReadTruncationNotice(line: string): boolean {
	if (typeof hashlineIsReadTruncationNotice === "function") return hashlineIsReadTruncationNotice(line);
	return isReadTruncationNoticeFallback(line);
}

/**
 * JS mirror of `hashlineIsReadTruncationNotice` for addons that predate it.
 * Must stay branch-for-branch identical to
 * `crates/pi-edit/src/modes/hashline/prefixes.rs::is_read_truncation_notice`.
 *
 * @internal Exported for parity tests.
 */
export function isReadTruncationNoticeFallback(line: string): boolean {
	const trimmed = line.trim();
	if (!(trimmed.startsWith("[") && trimmed.endsWith("]"))) return false;
	const body = trimmed.slice(1, -1);
	const showingNotice =
		body.startsWith("Showing ") &&
		(body.includes(" line") || body.includes("lines ") || body.includes("bytes ")) &&
		(body.includes(" of ") || body.includes(" elided"));
	const countSeparator = body.indexOf(" more line");
	const moreNotice =
		(body.startsWith("More lines in ") || (countSeparator > 0 && /^[+]?\d+$/.test(body.slice(0, countSeparator)))) &&
		body.includes(" in ") &&
		body.includes(". Use ") &&
		body.endsWith(" to continue");
	const elidedNotice =
		(body.startsWith("…") || body.startsWith("...")) &&
		body.includes("ln elided;") &&
		body.includes("re-read needed ranges");
	const oversizedLineNotice = body.startsWith("Line ") && body.includes(" exceeds ") && body.includes(" limit.");
	return showingNotice || moreNotice || elidedNotice || oversizedLineNotice;
}

export function computeFileHash(text: string): string {
	return hashlineFileHash(text);
}
