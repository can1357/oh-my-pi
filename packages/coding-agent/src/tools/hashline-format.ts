import {
	hashlineFileHash,
	hashlineFormatHeader,
	hashlineFormatNumberedLines,
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

export function computeFileHash(text: string): string {
	return hashlineFileHash(text);
}
