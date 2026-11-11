import * as path from "node:path";
import {
	isEisdir,
	isEnoent,
	isEnotdir,
	jsonContainerEnd,
	peekFile,
	peekFileSync,
	tryParseJson,
} from "@oh-my-pi/pi-utils";
import type { FileEntry, SessionHeader } from "./session-entries";
import {
	parseTitleSlotFromContent,
	parseTitleSlotLine,
	type SessionTitleUpdate,
	titleUpdateFromSlot,
} from "./session-title-slot";

/** Upper bound on the bytes read to find a header: real headers (and the title slot before them) are far smaller. */
export const SESSION_HEADER_READ_LIMIT = 1024 * 1024;
/** First read; holds the title slot and any normal header, so the full limit is read only for outliers. */
const SESSION_HEADER_FIRST_READ = 16 * 1024;

/** {@link sessionHeaderFromPrefix} result when the window ends inside the first record. */
const HEADER_INCOMPLETE = Symbol("header-incomplete");
const UTF8_DECODER = new TextDecoder("utf-8", { ignoreBOM: true });

interface LocatedSessionHeader {
	start: number;
	end: number;
	header: SessionHeader;
	titleSlot: SessionTitleUpdate | undefined;
}

function isJsonWhitespaceCode(code: number): boolean {
	return code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09;
}

export function isValidSessionHeader(entry: FileEntry | undefined): entry is SessionHeader {
	return entry?.type === "session" && typeof entry.id === "string";
}

export function applyTitleSlot(entry: FileEntry | undefined, slot: SessionTitleUpdate | undefined): void {
	if (!slot || !isValidSessionHeader(entry)) return;
	if (slot.title && slot.title.length > 0) {
		entry.title = slot.title;
	} else {
		delete entry.title;
	}
	if (slot.source) {
		entry.titleSource = slot.source;
	} else {
		delete entry.titleSource;
	}
}

/**
 * The creation time (epoch milliseconds) and session id a generated
 * `<file-safe timestamp>_<id>.jsonl` name records
 * (`2026-10-26T18-29-27-740Z_…`, the ISO time with `:` and `.` replaced);
 * `undefined` for any other name or an invalid timestamp.
 */
export function parseSessionFileName(file: string): { createdAt: number; id: string } | undefined {
	const base = path.posix.basename(file.replaceAll("\\", "/"));
	const match = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z_(.+)\.jsonl$/.exec(base);
	if (!match) return undefined;
	const createdAt = Date.parse(`${match[1]}:${match[2]}:${match[3]}.${match[4]}Z`);
	return Number.isFinite(createdAt) ? { createdAt, id: match[5] } : undefined;
}

function locateSessionHeaderWindow(
	text: string,
	final: boolean,
): LocatedSessionHeader | undefined | typeof HEADER_INCOMPLETE {
	let offset = 0;
	const parsedSlot = parseTitleSlotFromContent(text);
	const titleSlot = titleUpdateFromSlot(parsedSlot);
	if (parsedSlot) {
		offset = text.indexOf("\n") + 1;
	}
	while (offset < text.length && isJsonWhitespaceCode(text.charCodeAt(offset))) {
		offset++;
	}
	if (offset >= text.length) return final ? undefined : HEADER_INCOMPLETE;
	// A header is an object; anything else (including a leading UTF-8 BOM) is not a session header.
	if (text.charCodeAt(offset) !== 0x7b) return undefined;
	const end = jsonContainerEnd(text, offset);
	if (end === -1) return final ? undefined : HEADER_INCOMPLETE;
	const rawRecord = text.slice(offset, end);
	const entry = tryParseJson<FileEntry>(rawRecord) ?? undefined;
	if (!isValidSessionHeader(entry)) {
		if (!final && !titleSlot && parseTitleSlotLine(rawRecord)) return HEADER_INCOMPLETE;
		return undefined;
	}
	return { start: offset, end, header: entry, titleSlot };
}

function parseSessionHeaderWindow(text: string, final: boolean): SessionHeader | undefined | typeof HEADER_INCOMPLETE {
	const located = locateSessionHeaderWindow(text, final);
	if (!located || located === HEADER_INCOMPLETE) return located;
	applyTitleSlot(located.header, located.titleSlot);
	return located.header;
}

/**
 * Parse a complete session header (past an optional leading title-slot line and
 * JSON whitespace) from `text`, folding any title-slot update onto the header.
 */
export function parseSessionHeaderText(text: string): SessionHeader | undefined {
	const parsed = parseSessionHeaderWindow(text, true);
	return parsed === HEADER_INCOMPLETE ? undefined : parsed;
}

/**
 * Return `text` with its leading session header's `parentSession` replaced by
 * `parentSession`, preserving any title-slot line and every subsequent entry
 * byte-for-byte, or `undefined` when `text` has no valid session header.
 */
export function rewriteSessionHeaderParentText(text: string, parentSession: string): string | undefined {
	const located = locateSessionHeaderWindow(text, true);
	if (!located || located === HEADER_INCOMPLETE) return undefined;
	if (located.header.parentSession === parentSession) return text;
	const updated: SessionHeader = { ...located.header, parentSession };
	return `${text.slice(0, located.start)}${JSON.stringify(updated)}${text.slice(located.end)}`;
}

/**
 * The header from a file's leading bytes, past the optional title slot line.
 * Parses only the first record, which may span lines (a pretty-printed header).
 * {@link HEADER_INCOMPLETE} when that record runs past `prefix` and `final` is
 * false (more of the file can be read).
 */
function sessionHeaderFromPrefix(
	prefix: Uint8Array,
	final: boolean,
): SessionHeader | undefined | typeof HEADER_INCOMPLETE {
	return parseSessionHeaderWindow(UTF8_DECODER.decode(prefix), final);
}

/**
 * The parsed header in `filePath`, or `undefined` when there is no file there
 * or it does not start with a valid session header. Reads
 * {@link SESSION_HEADER_FIRST_READ} bytes, and up to
 * {@link SESSION_HEADER_READ_LIMIT} only when the first record runs past them.
 */
export async function readSessionHeader(filePath: string): Promise<SessionHeader | undefined> {
	try {
		const header = await peekFile(filePath, SESSION_HEADER_FIRST_READ, prefix =>
			sessionHeaderFromPrefix(prefix, prefix.length < SESSION_HEADER_FIRST_READ),
		);
		if (header !== HEADER_INCOMPLETE) return header;
		const full = await peekFile(filePath, SESSION_HEADER_READ_LIMIT, prefix => sessionHeaderFromPrefix(prefix, true));
		return full === HEADER_INCOMPLETE ? undefined : full;
	} catch (err) {
		if (isEnoent(err) || isEnotdir(err) || isEisdir(err)) return undefined;
		throw err;
	}
}

/** Synchronous counterpart to {@link readSessionHeader}. */
export function readSessionHeaderSync(filePath: string): SessionHeader | undefined {
	try {
		const header = peekFileSync(filePath, SESSION_HEADER_FIRST_READ, prefix =>
			sessionHeaderFromPrefix(prefix, prefix.length < SESSION_HEADER_FIRST_READ),
		);
		if (header !== HEADER_INCOMPLETE) return header;
		const full = peekFileSync(filePath, SESSION_HEADER_READ_LIMIT, prefix => sessionHeaderFromPrefix(prefix, true));
		return full === HEADER_INCOMPLETE ? undefined : full;
	} catch (err) {
		if (isEnoent(err) || isEnotdir(err) || isEisdir(err)) return undefined;
		throw err;
	}
}

/**
 * The session id in `filePath`'s header, or `undefined` when there is no file
 * there or it does not start with a valid session header.
 */
export async function readSessionHeaderId(filePath: string): Promise<string | undefined> {
	return (await readSessionHeader(filePath))?.id;
}

/** Best-effort {@link readSessionHeaderId} returning `undefined` on any read failure or blank id. */
export async function tryReadSessionHeaderId(filePath: string): Promise<string | undefined> {
	try {
		const id = await readSessionHeaderId(filePath);
		return id && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

/** Synchronous counterpart to {@link readSessionHeaderId}. */
export function readSessionHeaderIdSync(filePath: string): string | undefined {
	return readSessionHeaderSync(filePath)?.id;
}

/** Best-effort {@link readSessionHeaderIdSync} returning `undefined` on any read failure or blank id. */
export function tryReadSessionHeaderIdSync(filePath: string): string | undefined {
	try {
		const id = readSessionHeaderIdSync(filePath);
		return id && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}
