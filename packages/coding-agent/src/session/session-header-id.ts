import { jsonContainerEnd, peekFileSync, tryParseJson } from "@oh-my-pi/pi-utils";
import type { FileEntry, SessionHeader } from "./session-entries";
import { parseTitleSlotLine } from "./session-title-slot";

/** Upper bound on the bytes read to find a header: real headers (and the title slot before them) are far smaller. */
export const SESSION_HEADER_READ_LIMIT = 1024 * 1024;

function isValidSessionHeader(entry: FileEntry | undefined): entry is SessionHeader {
	return entry?.type === "session" && typeof entry.id === "string";
}

/**
 * The header id from a file's leading bytes, past the optional title slot
 * line. Parses only the first record, which may span lines (a pretty-printed
 * header); `undefined` when the window ends inside that record.
 */
export function sessionHeaderIdFromPrefix(prefix: Uint8Array): string | undefined {
	let records = prefix;
	const newline = prefix.indexOf(0x0a);
	if (newline !== -1) {
		const firstLine = new TextDecoder().decode(prefix.subarray(0, newline)).trim();
		if (firstLine && parseTitleSlotLine(firstLine)) records = prefix.subarray(newline + 1);
	}
	// Like the full parser, skip blank lines (and other JSON whitespace) before the first record.
	let start = 0;
	while (start < records.length) {
		const byte = records[start];
		if (byte !== 0x20 && byte !== 0x0a && byte !== 0x0d && byte !== 0x09) break;
		start++;
	}
	records = records.subarray(start);
	if (records.length === 0) return undefined;
	// A header is an object; anything else is not a session file.
	if (records[0] !== 0x7b) return undefined;
	const text = new TextDecoder().decode(records);
	const end = jsonContainerEnd(text, 0);
	if (end === -1) return undefined;
	const entry = tryParseJson<FileEntry>(text.slice(0, end)) ?? undefined;
	return isValidSessionHeader(entry) ? entry.id : undefined;
}

/**
 * The session id in `content`'s header, past the optional title slot, using
 * the same tolerant rules as the file readers (leading whitespace, title
 * slot, multi-line pretty-printed headers). Returns `undefined` for content
 * whose first record is still truncated.
 */
export function sessionIdFromContent(content: string): string | undefined {
	return sessionHeaderIdFromPrefix(Buffer.from(content, "utf8"));
}

/**
 * Synchronous session-header id reader shared by synchronous delete paths:
 * the session id in `filePath`'s header, read from a bounded prefix (title
 * slot plus the 1 MiB header budget), or `undefined` when there is no
 * readable file or no valid header. Never throws: `claimSession` and the
 * delete purge both promise not to fail on an unreadable transcript. Parses
 * like the async `readSessionHeaderId` in `./session-loader` (kept there to
 * avoid a storage/loader import cycle); change both together.
 */
export function readSessionHeaderIdSync(filePath: string): string | undefined {
	try {
		return peekFileSync(filePath, SESSION_HEADER_READ_LIMIT, sessionHeaderIdFromPrefix);
	} catch {
		return undefined;
	}
}
