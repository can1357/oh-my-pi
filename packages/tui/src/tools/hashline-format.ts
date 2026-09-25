import {
	hashlineFileHash,
	hashlineFormatHeader,
	hashlineFormatNumberedLines,
	hashlineIsReadTruncationNotice,
	hashlineStripPrefixes,
} from "@oh-my-pi/pi-natives";

/** Opening delimiter of a hashline file header. */
export const HL_FILE_PREFIX = "[";
/** Closing delimiter of a hashline file header. */
export const HL_FILE_SUFFIX = "]";
/** Separator between the file path and content hash. */
export const HL_FILE_HASH_SEP = "#";
/** Number of characters in a displayed file hash. */
export const HL_FILE_HASH_LENGTH = 4;
/** Keyword identifying a file move operation. */
export const HL_MOVE_KEYWORD = "MV";
/** Keyword identifying a file removal operation. */
export const HL_REM_KEYWORD = "REM";
/** Separator between a line number and its body. */
export const HL_LINE_BODY_SEP = ":";

/** Format a file path and content hash as a hashline header. */
export function formatHashlineHeader(path: string, tag: string): string {
	return hashlineFormatHeader(path, tag);
}

/** Prefix each addressable line with its file line number. */
export function formatNumberedLines(text: string, startLine?: number): string {
	return hashlineFormatNumberedLines(text, startLine);
}

/** Prefix one line with its file line number. */
export function formatNumberedLine(lineNumber: number, line: string): string {
	return `${lineNumber}:${line}`;
}

/** Split file lines without treating a trailing newline as an empty address. */
export function splitAddressableFileLines(text: string): string[] {
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

/** Remove model-facing hashline anchors from copied file content. */
export function stripHashlinePrefixes(lines: string[]): string[] {
	return hashlineStripPrefixes(lines);
}

/** Whether a row is a truncation notice emitted by `read`. */
export function isReadTruncationNotice(line: string): boolean {
	return hashlineIsReadTruncationNotice(line);
}

/** Compute the native hashline content fingerprint. */
export function computeFileHash(text: string): string {
	return hashlineFileHash(text);
}
