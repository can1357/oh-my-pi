import * as path from "node:path";
import { bytesMatchAscii } from "./bytes";
import { resolveArchiveLinkPath, upsertArchiveEntry } from "./entries";
import { ArchiveError } from "./error";
import {
	type ArchiveLimits,
	assertArchiveMemberSize,
	assertEntryCount,
	assertIndexSize,
	assertInMemorySize,
} from "./limits";
import {
	assertArchivePathBytes,
	assertArchivePathString,
	formatArchivePathForError,
	normalizeArchiveEntryPath,
	normalizeArchiveLookupPath,
} from "./paths";
import type { ByteSource } from "./source";
import type { ArchiveIndexEntry, FormatReader, FormatReadOptions, MemberSource } from "./types";

const BLOCK_SIZE = 512;
const NAME_OFFSET = 0;
const NAME_LENGTH = 100;
const MODE_OFFSET = 100;
const MODE_LENGTH = 8;
const SIZE_OFFSET = 124;
const SIZE_LENGTH = 12;
const MTIME_OFFSET = 136;
const MTIME_LENGTH = 12;
const CHECKSUM_OFFSET = 148;
const CHECKSUM_LENGTH = 8;
const TYPEFLAG_OFFSET = 156;
const LINKNAME_OFFSET = 157;
const LINKNAME_LENGTH = 100;
const MAGIC_OFFSET = 257;
const MAGIC = "ustar\0";
const VERSION_OFFSET = 263;
const VERSION = "00";
const PREFIX_OFFSET = 345;
const PREFIX_LENGTH = 155;
const GNU_SPARSE_ISEXTENDED_OFFSET = 482;
const GNU_SPARSE_CONT_ISEXTENDED_OFFSET = 504;
const MAX_PAX_NUMERIC_BYTES = 32;
const PAX_SPARSE_MARKER = "GNU.sparse.";
const TEXT_DECODER = new TextDecoder();
const TEXT_ENCODER = new TextEncoder();
const MAX_OCTAL_SIZE = 0o77777777777;
const MAX_OCTAL_MTIME = 0o77777777777;

interface PendingTarLink {
	kind: "hard link" | "symlink";
	targetPath: string;
}

interface TarCursor {
	readonly position: number;
	read(length: number): Promise<Uint8Array>;
	skip(length: number): Promise<boolean>;
}

/** Seek over plain tar payloads without fetching their bytes. */
class TarSourceCursor implements TarCursor {
	readonly #source: ByteSource;
	#position = 0;

	constructor(source: ByteSource) {
		this.#source = source;
	}

	get position(): number {
		return this.#position;
	}

	async read(length: number): Promise<Uint8Array> {
		const size = Math.min(length, this.#source.size - this.#position);
		if (size === 0) return new Uint8Array(0);
		const end = this.#position + size;
		const bytes = await this.#source.read(this.#position, end);
		if (bytes.byteLength !== size) throw new ArchiveError("Invalid archive: truncated data");
		this.#position = end;
		return bytes;
	}

	async skip(length: number): Promise<boolean> {
		if (length > this.#source.size - this.#position) return false;
		this.#position += length;
		return true;
	}
}

/** Forward-only reader over tar bytes that arrive in chunks: one buffer, or a decompressing stream. */
class TarByteStream implements TarCursor {
	readonly #chunks: AsyncIterator<Uint8Array> | Iterator<Uint8Array>;
	#chunk: Uint8Array = new Uint8Array(0);
	#position = 0;

	constructor(chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>) {
		this.#chunks = Symbol.asyncIterator in chunks ? chunks[Symbol.asyncIterator]() : chunks[Symbol.iterator]();
	}

	/** Bytes consumed so far. */
	get position(): number {
		return this.#position;
	}

	/** The next `length` bytes; shorter only when the stream ends first. */
	async read(length: number): Promise<Uint8Array> {
		if (this.#chunk.byteLength >= length) {
			const bytes = this.#chunk.subarray(0, length);
			this.#chunk = this.#chunk.subarray(length);
			this.#position += length;
			return bytes;
		}
		const bytes = new Uint8Array(length);
		let filled = 0;
		while (filled < length && (this.#chunk.byteLength > 0 || (await this.#next()))) {
			const take = Math.min(length - filled, this.#chunk.byteLength);
			bytes.set(this.#chunk.subarray(0, take), filled);
			this.#chunk = this.#chunk.subarray(take);
			filled += take;
		}
		this.#position += filled;
		return filled === length ? bytes : bytes.subarray(0, filled);
	}

	/** Step over `length` bytes; false when the stream ends first. */
	async skip(length: number): Promise<boolean> {
		let remaining = length;
		while (remaining > 0) {
			if (this.#chunk.byteLength === 0 && !(await this.#next())) return false;
			const take = Math.min(remaining, this.#chunk.byteLength);
			this.#chunk = this.#chunk.subarray(take);
			this.#position += take;
			remaining -= take;
		}
		return true;
	}

	/** Stop the underlying stream without draining it. */
	async close(): Promise<void> {
		await this.#chunks.return?.();
	}

	async #next(): Promise<boolean> {
		const result = await this.#chunks.next();
		if (result.done) return false;
		this.#chunk = result.value;
		return true;
	}
}

/** Where an indexed tar's member bytes come from, by offset into the tar stream. */
interface TarPayload {
	read(offset: number, size: number, memberPath: string): Promise<Uint8Array>;
}

class TarSourcePayload implements TarPayload {
	readonly #source: ByteSource;

	constructor(source: ByteSource) {
		this.#source = source;
	}

	async read(offset: number, size: number, memberPath: string): Promise<Uint8Array> {
		try {
			const bytes = await this.#source.read(offset, offset + size);
			if (bytes.byteLength !== size) {
				throw new ArchiveError(`Archive member '${formatArchivePathForError(memberPath)}' is truncated`);
			}
			return bytes;
		} catch (error) {
			if (error instanceof ArchiveError) throw error;
			throw new ArchiveError(error instanceof Error ? error.message : "Failed to read tar member");
		}
	}
}

class TarBufferPayload implements TarPayload {
	readonly #buffer: Uint8Array;

	constructor(buffer: Uint8Array) {
		this.#buffer = buffer;
	}

	async read(offset: number, size: number, memberPath: string): Promise<Uint8Array> {
		if (size > this.#buffer.byteLength - offset) {
			throw new ArchiveError(`Archive member '${formatArchivePathForError(memberPath)}' is truncated`);
		}
		const bytes = this.#buffer.subarray(offset, offset + size);
		if (bytes.byteLength !== size) {
			throw new ArchiveError(`Archive member '${formatArchivePathForError(memberPath)}' has an invalid size`);
		}
		return bytes;
	}
}

/**
 * Member bytes of a tar too large to hold decompressed: each read decompresses
 * the stream again up to the member. Reads are serialized, and a read ahead of
 * the previous one continues that pass, so reading every member in archive
 * order decompresses the stream once.
 */
class TarStreamPayload implements TarPayload {
	readonly #open: () => AsyncIterable<Uint8Array>;
	#stream: TarByteStream | undefined;
	#pending: Promise<unknown> = Promise.resolve();

	constructor(open: () => AsyncIterable<Uint8Array>) {
		this.#open = open;
	}

	read(offset: number, size: number, memberPath: string): Promise<Uint8Array> {
		const bytes = this.#pending.then(() => this.#readAt(offset, size, memberPath));
		this.#pending = bytes.catch(() => undefined);
		return bytes;
	}

	async #readAt(offset: number, size: number, memberPath: string): Promise<Uint8Array> {
		let stream = this.#stream;
		this.#stream = undefined;
		if (!stream || stream.position > offset) {
			await stream?.close();
			stream = new TarByteStream(this.#open());
		}
		try {
			const bytes = (await stream.skip(offset - stream.position)) ? await stream.read(size) : undefined;
			if (bytes?.byteLength !== size) {
				throw new ArchiveError(`Archive member '${formatArchivePathForError(memberPath)}' is truncated`);
			}
			this.#stream = stream;
			// A view into a decoder chunk would keep the whole chunk alive with the member.
			return bytes.byteLength === bytes.buffer.byteLength ? bytes : new Uint8Array(bytes);
		} catch (error) {
			await stream.close();
			throw error;
		}
	}
}

class TarMemberSource implements MemberSource {
	readonly #payload: TarPayload;
	readonly #dataOffset: number;
	readonly #sparse: boolean;

	constructor(payload: TarPayload, dataOffset: number, sparse: boolean) {
		this.#payload = payload;
		this.#dataOffset = dataOffset;
		this.#sparse = sparse;
	}

	async read(size: number, memberPath: string): Promise<Uint8Array> {
		if (this.#sparse) {
			throw new ArchiveError(
				`Archive member '${formatArchivePathForError(memberPath)}' is a sparse file and cannot be read`,
			);
		}
		return this.#payload.read(this.#dataOffset, size, memberPath);
	}
}

function readTarString(buffer: Uint8Array, offset: number, length: number): string {
	const limit = Math.min(offset + length, buffer.byteLength);
	let end = offset;
	while (end < limit && buffer[end] !== 0) end++;
	return TEXT_DECODER.decode(buffer.subarray(offset, end));
}

function bytesEqualAscii(bytes: Uint8Array, value: string): boolean {
	return bytes.byteLength === value.length && bytesMatchAscii(bytes, 0, value);
}

function isUstarHeader(buffer: Uint8Array, offset: number): boolean {
	return (
		bytesMatchAscii(buffer, offset + MAGIC_OFFSET, MAGIC) && bytesMatchAscii(buffer, offset + VERSION_OFFSET, VERSION)
	);
}

function readMetadataPath(data: Uint8Array, field: string, limits: ArchiveLimits): string {
	const nul = data.indexOf(0);
	const value = data.subarray(0, nul === -1 ? data.byteLength : nul);
	assertArchivePathBytes(value.byteLength, field, limits.maxPathBytes);
	return TEXT_DECODER.decode(value);
}

function readPaxPath(data: Uint8Array, field: string, limits: ArchiveLimits): string {
	assertArchivePathBytes(data.byteLength, field, limits.maxPathBytes);
	return TEXT_DECODER.decode(data);
}

function readTarNumeric(buffer: Uint8Array, offset: number, length: number): number {
	if (offset < 0 || length <= 0 || offset + length > buffer.byteLength) {
		throw new ArchiveError("Invalid tar numeric field");
	}
	const first = buffer[offset]!;
	let value = 0n;
	if ((first & 0x80) !== 0) {
		value = BigInt(first & 0x7f);
		for (let index = 1; index < length; index++) {
			value = (value << 8n) | BigInt(buffer[offset + index]!);
		}
		if ((first & 0x40) !== 0) value -= 1n << BigInt(length * 8 - 1);
	} else {
		for (let index = 0; index < length; index++) {
			const byte = buffer[offset + index]!;
			if (byte >= 0x30 && byte <= 0x37) value = value * 8n + BigInt(byte - 0x30);
		}
	}
	return Number(value);
}

function readTarSize(buffer: Uint8Array, offset: number): number {
	const size = readTarNumeric(buffer, offset, SIZE_LENGTH);
	if (!Number.isSafeInteger(size) || size < 0) throw new ArchiveError("Invalid tar member size");
	return size;
}

function paddedSize(size: number): number {
	const remainder = size % BLOCK_SIZE;
	const padded = size + (remainder === 0 ? 0 : BLOCK_SIZE - remainder);
	if (!Number.isSafeInteger(padded)) throw new ArchiveError("Invalid tar member size");
	return padded;
}

function parsePaxSize(value: string, field: string): number {
	if (!/^\d+$/.test(value)) throw new ArchiveError(`Invalid tar ${field}`);
	const size = Number(value);
	if (!Number.isSafeInteger(size) || size < 0) throw new ArchiveError(`Invalid tar ${field}`);
	return size;
}

function isZeroBlock(buffer: Uint8Array, offset: number): boolean {
	for (let index = 0; index < BLOCK_SIZE; index++) {
		if (buffer[offset + index] !== 0) return false;
	}
	return true;
}

function checksumMatches(buffer: Uint8Array, offset: number): boolean {
	const stored = readTarNumeric(buffer, offset + CHECKSUM_OFFSET, CHECKSUM_LENGTH);
	let unsigned = 0;
	let signed = 0;
	for (let index = 0; index < BLOCK_SIZE; index++) {
		const inChecksum = index >= CHECKSUM_OFFSET && index < CHECKSUM_OFFSET + CHECKSUM_LENGTH;
		const byte = inChecksum ? 0x20 : (buffer[offset + index] ?? 0);
		unsigned += byte;
		signed += (byte << 24) >> 24;
	}
	return stored === unsigned || stored === signed;
}

function parsePaxRecords(data: Uint8Array, limits: ArchiveLimits): Map<string, string> {
	const attrs = new Map<string, string>();
	let pos = 0;
	while (pos < data.byteLength) {
		let space = pos;
		while (space < data.byteLength && data[space] !== 0x20) space++;
		if (space === pos || space >= data.byteLength || space - pos > 16) {
			throw new ArchiveError("Invalid tar PAX record");
		}
		let length = 0;
		for (let index = pos; index < space; index++) {
			const byte = data[index]!;
			if (byte < 0x30 || byte > 0x39) throw new ArchiveError("Invalid tar PAX record");
			length = length * 10 + (byte - 0x30);
			if (length > data.byteLength - pos) throw new ArchiveError("Invalid tar PAX record");
		}
		if (length <= 0 || pos + length > data.byteLength || data[pos + length - 1] !== 0x0a) {
			throw new ArchiveError("Invalid tar PAX record");
		}
		const record = data.subarray(space + 1, pos + length - 1);
		const equals = record.indexOf(0x3d);
		if (equals >= 0) {
			const key = record.subarray(0, equals);
			const value = record.subarray(equals + 1);
			if (bytesMatchAscii(key, 0, PAX_SPARSE_MARKER)) {
				attrs.set(PAX_SPARSE_MARKER, value.byteLength === 0 ? "" : "1");
				if (bytesEqualAscii(key, "GNU.sparse.name")) {
					attrs.set("GNU.sparse.name", readPaxPath(value, "PAX sparse path", limits));
				} else if (bytesEqualAscii(key, "GNU.sparse.realsize") || bytesEqualAscii(key, "GNU.sparse.size")) {
					if (value.byteLength > MAX_PAX_NUMERIC_BYTES) {
						throw new ArchiveError("Invalid tar sparse real size");
					}
					attrs.set("GNU.sparse.realsize", TEXT_DECODER.decode(value));
				}
			} else if (bytesEqualAscii(key, "path") || bytesEqualAscii(key, "linkpath")) {
				const field = bytesEqualAscii(key, "path") ? "PAX path" : "PAX link target";
				attrs.set(field === "PAX path" ? "path" : "linkpath", readPaxPath(value, field, limits));
			} else if (bytesEqualAscii(key, "size")) {
				if (value.byteLength > MAX_PAX_NUMERIC_BYTES) throw new ArchiveError("Invalid tar member size");
				attrs.set("size", TEXT_DECODER.decode(value));
			}
		}
		pos += length;
	}
	return attrs;
}

function applyGlobalPax(globalPax: Map<string, string>, update: ReadonlyMap<string, string>): void {
	for (const [key, value] of update) {
		if (value === "") globalPax.delete(key);
		else globalPax.set(key, value);
	}
}

function paxAttribute(
	globalPax: ReadonlyMap<string, string>,
	localPax: ReadonlyMap<string, string> | undefined,
	key: string,
): string | undefined {
	if (localPax?.has(key)) return localPax.get(key);
	return globalPax.get(key);
}

function paxDeclaresSparse(
	globalPax: ReadonlyMap<string, string>,
	localPax: ReadonlyMap<string, string> | undefined,
): boolean {
	return paxAttribute(globalPax, localPax, PAX_SPARSE_MARKER) === "1";
}

function indexOfAscii(bytes: Uint8Array, value: string, start: number): number {
	for (let offset = start; offset <= bytes.byteLength - value.length; offset++) {
		if (bytesMatchAscii(bytes, offset, value)) return offset;
	}
	return -1;
}

function normalizeOldGnuName(value: string, field: string, limits: ArchiveLimits): string {
	const portable = value.replace(/\\/g, "/");
	if (path.posix.isAbsolute(portable)) throw new ArchiveError(`Invalid old-GNU ${field}`);
	const normalized = normalizeArchiveEntryPath(portable);
	if (!normalized) throw new ArchiveError(`Invalid old-GNU ${field}`);
	assertArchivePathString(normalized, field, limits.maxPathBytes);
	return normalized;
}

function renameOldGnuEntries(
	entries: Map<string, ArchiveIndexEntry>,
	pendingLinks: Map<ArchiveIndexEntry, PendingTarLink>,
	fromPath: string,
	toPath: string,
	limits: ArchiveLimits,
): void {
	const moved = [...entries.entries()].filter(
		([entryPath]) => entryPath === fromPath || entryPath.startsWith(`${fromPath}/`),
	);
	if (moved.length === 0) return;
	for (const [entryPath] of moved) entries.delete(entryPath);
	for (const [entryPath, entry] of moved) {
		const suffix = entryPath.slice(fromPath.length);
		const nextPath = `${toPath}${suffix}`;
		assertArchivePathString(nextPath, "member path", limits.maxPathBytes);
		entry.path = nextPath;
		const replaced = entries.get(nextPath);
		if (replaced) pendingLinks.delete(replaced);
		entries.set(nextPath, entry);
	}
	for (const pending of pendingLinks.values()) {
		if (
			pending.kind === "hard link" &&
			(pending.targetPath === fromPath || pending.targetPath.startsWith(`${fromPath}/`))
		) {
			pending.targetPath = `${toPath}${pending.targetPath.slice(fromPath.length)}`;
		}
	}
}

function applyOldGnuNameRecords(
	data: Uint8Array,
	entries: Map<string, ArchiveIndexEntry>,
	pendingLinks: Map<ArchiveIndexEntry, PendingTarLink>,
	limits: ArchiveLimits,
): void {
	const terminator = data.indexOf(0);
	const end = terminator === -1 ? data.byteLength : terminator;
	let start = 0;
	while (start < end) {
		const newline = data.indexOf(0x0a, start);
		const lineEnd = newline === -1 || newline > end ? end : newline;
		const line = data.subarray(start, lineEnd);
		if (bytesMatchAscii(line, 0, "Rename ")) {
			const separator = indexOfAscii(line, " to ", "Rename ".length);
			if (separator === -1) throw new ArchiveError("Invalid old-GNU name record");
			const source = readMetadataPath(line.subarray("Rename ".length, separator), "old-GNU source path", limits);
			const targetEnd = line[line.byteLength - 1] === 0x2f ? line.byteLength - 1 : line.byteLength;
			const target = readMetadataPath(
				line.subarray(separator + " to ".length, targetEnd),
				"old-GNU target path",
				limits,
			);
			renameOldGnuEntries(
				entries,
				pendingLinks,
				normalizeOldGnuName(source, "source path", limits),
				normalizeOldGnuName(target, "target path", limits),
				limits,
			);
		}
		start = lineEnd + 1;
	}
}

function resolvePendingLinks(
	entries: Map<string, ArchiveIndexEntry>,
	pendingLinks: Map<ArchiveIndexEntry, PendingTarLink>,
	limits: ArchiveLimits,
): void {
	if (pendingLinks.size === 0) return;
	const directoryPrefixes = new Set<string>();
	for (const entry of entries.values()) {
		for (let cut = entry.path.lastIndexOf("/"); cut > 0; cut = entry.path.lastIndexOf("/", cut - 1)) {
			const prefix = entry.path.slice(0, cut);
			if (directoryPrefixes.has(prefix)) break;
			directoryPrefixes.add(prefix);
		}
	}
	const unresolved = new Set(pendingLinks.keys());
	const dependents = new Map<ArchiveIndexEntry, ArchiveIndexEntry[]>();
	const findUnresolvedBlocker = (targetPath: string): ArchiveIndexEntry | null => {
		for (let end = targetPath.length; end > 0; end = targetPath.lastIndexOf("/", end - 1)) {
			const prefixEntry = entries.get(targetPath.slice(0, end));
			if (prefixEntry && unresolved.has(prefixEntry)) return prefixEntry;
		}
		return null;
	};
	const queue = [...unresolved];
	while (queue.length > 0) {
		const entry = queue.pop()!;
		if (!unresolved.has(entry)) continue;
		const pending = pendingLinks.get(entry)!;
		let blocker = findUnresolvedBlocker(pending.targetPath);
		let targetPath = pending.targetPath;
		if (blocker === null) {
			try {
				targetPath = resolveArchiveLinkPath(entries, targetPath, limits.maxLinkDepth);
			} catch (error) {
				if (!(error instanceof ArchiveError)) throw new ArchiveError("Invalid archive link");
			}
			if (targetPath !== pending.targetPath) blocker = findUnresolvedBlocker(targetPath);
		}
		if (blocker !== null && blocker !== entry) {
			const waiting = dependents.get(blocker);
			if (waiting) waiting.push(entry);
			else dependents.set(blocker, [entry]);
			continue;
		}
		unresolved.delete(entry);
		const settled = dependents.get(entry);
		if (settled) {
			dependents.delete(entry);
			queue.push(...settled);
		}
		if (blocker === entry) {
			if (pending.kind === "hard link") {
				throw new ArchiveError(
					`Archive hard link '${formatArchivePathForError(entry.path)}' has a cyclic target '${formatArchivePathForError(pending.targetPath)}'`,
				);
			}
			entry.storage = { type: "link", targetPath: pending.targetPath, resolveTarget: false };
			continue;
		}
		const target = entries.get(targetPath);
		if (target?.storage && !target.isDirectory && !unresolved.has(target)) {
			entry.size = target.size;
			entry.storage = target.storage;
			continue;
		}
		const targetIsDirectory = targetPath === "" || target?.isDirectory === true || directoryPrefixes.has(targetPath);
		if (!targetIsDirectory) {
			if (pending.kind === "symlink") {
				entry.storage = { type: "link", targetPath: pending.targetPath, resolveTarget: false };
				continue;
			}
			const reason = target ? "unreadable member" : "missing member";
			throw new ArchiveError(
				`Archive hard link '${formatArchivePathForError(entry.path)}' targets ${reason} '${formatArchivePathForError(pending.targetPath)}'`,
			);
		}
		if (pending.kind === "hard link") {
			throw new ArchiveError(
				`Archive hard link '${formatArchivePathForError(entry.path)}' targets directory '${formatArchivePathForError(pending.targetPath)}'`,
			);
		}
		entry.isDirectory = true;
		entry.storage = { type: "link", targetPath: pending.targetPath, resolveTarget: false };
	}
	if (unresolved.size > 0) throw new ArchiveError("Archive contains cyclic or unsupported links");
}

/** Read one metadata record's payload, bounded by `maxIndexSize`, and step over its padding. */
async function readTarMetadata(
	stream: TarCursor,
	size: number,
	limits: ArchiveLimits,
	what: string,
): Promise<Uint8Array> {
	assertIndexSize(size, limits, what);
	const data = await stream.read(size);
	if (data.byteLength !== size || !(await stream.skip(paddedSize(size) - size))) {
		throw new ArchiveError("Archive member data is truncated");
	}
	return data;
}

/**
 * Walk tar headers with bounded GNU, ustar, and PAX handling. Member data is
 * stepped over, never held: entries point into `payload` by stream offset.
 */
async function readTarEntries(
	stream: TarCursor,
	payload: TarPayload,
	options: FormatReadOptions,
): Promise<ArchiveIndexEntry[]> {
	const { limits } = options;
	const entries = new Map<string, ArchiveIndexEntry>();
	const pendingLinks = new Map<ArchiveIndexEntry, PendingTarLink>();
	const addEntry = (entry: ArchiveIndexEntry, pendingLink?: PendingTarLink): void => {
		const existing = entries.get(entry.path);
		const indexed = upsertArchiveEntry(entries, entry);
		if (!indexed) return;
		if (existing) pendingLinks.delete(existing);
		if (pendingLink) pendingLinks.set(indexed, pendingLink);
		assertEntryCount(entries.size, limits);
	};
	let longName: string | undefined;
	let longLink: string | undefined;
	let localPax: Map<string, string> | undefined;
	const globalPax = new Map<string, string>();
	let sawTerminator = false;

	for (
		let header = await stream.read(BLOCK_SIZE);
		header.byteLength === BLOCK_SIZE;
		header = await stream.read(BLOCK_SIZE)
	) {
		if (isZeroBlock(header, 0)) {
			sawTerminator = true;
			break;
		}
		if (!checksumMatches(header, 0)) throw new ArchiveError("Invalid or corrupt tar archive header");
		const typeFlag = String.fromCharCode(header[TYPEFLAG_OFFSET] || 0x30);
		let size = readTarSize(header, SIZE_OFFSET);
		let name = readTarString(header, NAME_OFFSET, NAME_LENGTH);
		if (isUstarHeader(header, 0)) {
			const prefix = readTarString(header, PREFIX_OFFSET, PREFIX_LENGTH);
			if (prefix) name = `${prefix}/${name}`;
		}
		let linkName = readTarString(header, LINKNAME_OFFSET, LINKNAME_LENGTH);
		const mtime = readTarNumeric(header, MTIME_OFFSET, MTIME_LENGTH);
		const rawMode = readTarNumeric(header, MODE_OFFSET, MODE_LENGTH);
		const mode = Number.isSafeInteger(rawMode) && rawMode >= 0 ? rawMode : undefined;

		if (typeFlag === "L") {
			const data = await readTarMetadata(stream, size, limits, "GNU long-name metadata");
			longName = readMetadataPath(data, "GNU long path", limits);
			continue;
		}
		if (typeFlag === "K") {
			const data = await readTarMetadata(stream, size, limits, "GNU long-link metadata");
			longLink = readMetadataPath(data, "GNU long link target", limits);
			continue;
		}
		if (typeFlag === "N") {
			const data = await readTarMetadata(stream, size, limits, "old-GNU name metadata");
			applyOldGnuNameRecords(data, entries, pendingLinks, limits);
			continue;
		}
		if (typeFlag === "x" || typeFlag === "X") {
			localPax = parsePaxRecords(await readTarMetadata(stream, size, limits, "tar PAX metadata"), limits);
			continue;
		}
		if (typeFlag === "g") {
			applyGlobalPax(
				globalPax,
				parsePaxRecords(await readTarMetadata(stream, size, limits, "tar PAX metadata"), limits),
			);
			continue;
		}
		if (typeFlag === "M") throw new ArchiveError("GNU multi-volume tar members are not supported");

		if (longName !== undefined) name = longName;
		if (longLink !== undefined) linkName = longLink;
		const paxPath = paxAttribute(globalPax, localPax, "path");
		if (paxPath !== undefined) name = paxPath;
		const paxLinkPath = paxAttribute(globalPax, localPax, "linkpath");
		if (paxLinkPath !== undefined) linkName = paxLinkPath;
		const paxSize = paxAttribute(globalPax, localPax, "size");
		if (paxSize !== undefined) size = parsePaxSize(paxSize, "member size");
		const paxSparseName = paxAttribute(globalPax, localPax, "GNU.sparse.name");
		if (paxSparseName !== undefined) name = paxSparseName;
		let displaySize = size;
		const paxSparseRealSize = paxAttribute(globalPax, localPax, "GNU.sparse.realsize");
		if (paxSparseRealSize !== undefined) displaySize = parsePaxSize(paxSparseRealSize, "sparse real size");
		const sparse = typeFlag === "S" || paxDeclaresSparse(globalPax, localPax);
		if (typeFlag === "S" && header[GNU_SPARSE_ISEXTENDED_OFFSET] === 1) {
			let extended = true;
			while (extended) {
				const block = await stream.read(BLOCK_SIZE);
				if (block.byteLength < BLOCK_SIZE) throw new ArchiveError("Archive sparse metadata is truncated");
				extended = block[GNU_SPARSE_CONT_ISEXTENDED_OFFSET] === 1;
			}
		}
		const dataOffset = stream.position;
		if (!(await stream.skip(paddedSize(size)))) {
			throw new ArchiveError(`Archive member '${formatArchivePathForError(name)}' is truncated`);
		}
		longName = undefined;
		longLink = undefined;
		localPax = undefined;

		const isDirectory = typeFlag === "5" || name.endsWith("/");
		const normalizedPath = normalizeArchiveEntryPath(name);
		if (!normalizedPath) continue;
		assertArchivePathString(normalizedPath, "member path", limits.maxPathBytes);
		const scaledMtime = mtime * 1000;
		const mtimeMs = mtime !== 0 && Number.isSafeInteger(scaledMtime) ? scaledMtime : undefined;
		if (isDirectory) {
			addEntry({ path: normalizedPath, isDirectory: true, size: 0, mtimeMs, mode });
			continue;
		}
		if (typeFlag === "1" || typeFlag === "2") {
			const kind = typeFlag === "1" ? "hard link" : "symlink";
			const portableLinkName = linkName.replace(/\\/g, "/");
			assertArchivePathString(portableLinkName, "link target", limits.maxPathBytes);
			const targetPath =
				typeFlag === "1"
					? normalizeArchiveEntryPath(portableLinkName)
					: path.posix.isAbsolute(portableLinkName)
						? undefined
						: normalizeArchiveLookupPath(path.posix.join(path.posix.dirname(normalizedPath), portableLinkName));
			const entry: ArchiveIndexEntry = {
				path: normalizedPath,
				isDirectory: false,
				size: 0,
				mtimeMs,
				mode,
			};
			if (targetPath === undefined || Buffer.byteLength(targetPath, "utf-8") > limits.maxPathBytes) {
				if (kind === "hard link") {
					throw new ArchiveError(
						`Archive hard link '${formatArchivePathForError(normalizedPath)}' has an invalid target`,
					);
				}
				entry.storage = { type: "link", targetPath: portableLinkName, resolveTarget: false };
				addEntry(entry);
				continue;
			}
			addEntry(entry, { kind, targetPath });
			continue;
		}
		if (typeFlag !== "0" && typeFlag !== "\0" && typeFlag !== "7" && typeFlag !== "S") continue;
		assertArchiveMemberSize(displaySize, normalizedPath, limits);
		addEntry({
			path: normalizedPath,
			isDirectory: false,
			size: displaySize,
			mtimeMs,
			mode,
			storage: { type: "member", source: new TarMemberSource(payload, dataOffset, sparse) },
		});
	}
	if (!sawTerminator) throw new ArchiveError("Not a valid tar archive: missing terminating zero block");
	resolvePendingLinks(entries, pendingLinks, limits);
	return [...entries.values()];
}

/** Index an already-decompressed tar buffer; members are views into it. */
export async function readTarEntriesFromBuffer(
	buffer: Uint8Array,
	options: FormatReadOptions,
): Promise<ArchiveIndexEntry[]> {
	assertInMemorySize(buffer.byteLength, options.limits);
	return readTarEntries(new TarByteStream([buffer]), new TarBufferPayload(buffer), options);
}

/**
 * Index a decompressed tar stream that is too large to hold in memory: one
 * pass over `open()` walks the headers, and member reads open it again.
 */
export async function readTarEntriesFromStream(
	open: () => AsyncIterable<Uint8Array>,
	options: FormatReadOptions,
): Promise<ArchiveIndexEntry[]> {
	const stream = new TarByteStream(open());
	try {
		const entries = await readTarEntries(stream, new TarStreamPayload(open), options);
		// Decompress past the terminator to the end, so the codec still checks the
		// stream's trailer (gzip CRC and length) as a whole-stream decompression does.
		await stream.skip(Number.POSITIVE_INFINITY);
		return entries;
	} finally {
		await stream.close();
	}
}

/** Index a plain tar by ranging over headers and retaining lazy member offsets. */
export const readTar: FormatReader = async (source, options) => {
	if (!Number.isSafeInteger(source.size) || source.size < 0) {
		throw new ArchiveError("Archive is too large to read safely");
	}
	try {
		return await readTarEntries(new TarSourceCursor(source), new TarSourcePayload(source), options);
	} catch (error) {
		if (error instanceof ArchiveError) throw error;
		throw new ArchiveError(error instanceof Error ? error.message : "Failed to read tar archive");
	}
};

/** Detect a tar header, including legacy pre-ustar archives, by its checksum. */
export function sniffTar(bytes: Uint8Array): boolean {
	if (bytes.byteLength < BLOCK_SIZE) return false;
	if (isZeroBlock(bytes, 0)) return true;
	try {
		if (readTarString(bytes, NAME_OFFSET, NAME_LENGTH).length === 0) return false;
		const size = readTarSize(bytes, SIZE_OFFSET);
		return Number.isSafeInteger(paddedSize(size)) && checksumMatches(bytes, 0);
	} catch {
		return false;
	}
}

function writeField(target: Uint8Array, offset: number, length: number, value: Uint8Array): void {
	if (value.byteLength > length) throw new ArchiveError("Tar header field is too long");
	target.set(value, offset);
}

function writeOctal(target: Uint8Array, offset: number, length: number, value: number): void {
	if (!Number.isSafeInteger(value) || value < 0) throw new ArchiveError("Invalid tar numeric value");
	const digits = value.toString(8);
	if (digits.length > length - 1) throw new ArchiveError("Tar numeric value does not fit its header field");
	for (let index = offset; index < offset + length - 1 - digits.length; index++) target[index] = 0x30;
	for (let index = 0; index < digits.length; index++)
		target[offset + length - 1 - digits.length + index] = digits.charCodeAt(index);
	target[offset + length - 1] = 0;
}

function splitUstarPath(pathBytes: Uint8Array): readonly [Uint8Array, Uint8Array] | undefined {
	if (pathBytes.byteLength <= NAME_LENGTH) return [pathBytes, new Uint8Array(0)];
	for (let index = pathBytes.byteLength - 1; index > 0; index--) {
		if (pathBytes[index] !== 0x2f) continue;
		const prefix = pathBytes.subarray(0, index);
		const name = pathBytes.subarray(index + 1);
		if (prefix.byteLength <= PREFIX_LENGTH && name.byteLength > 0 && name.byteLength <= NAME_LENGTH) {
			return [name, prefix];
		}
	}
	return undefined;
}

function makePaxRecord(key: string, value: string): Uint8Array {
	const body = TEXT_ENCODER.encode(`${key}=${value}\n`);
	let length = body.byteLength + 2;
	for (;;) {
		const digits = String(length).length;
		const next = digits + 1 + body.byteLength;
		if (next === length) break;
		length = next;
	}
	const prefix = TEXT_ENCODER.encode(`${length} `);
	const record = new Uint8Array(length);
	record.set(prefix);
	record.set(body, prefix.byteLength);
	return record;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
	let length = 0;
	for (const part of parts) {
		length += part.byteLength;
		if (!Number.isSafeInteger(length)) throw new ArchiveError("Tar archive is too large to encode safely");
	}
	const output = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.byteLength;
	}
	return output;
}

function makeHeader(
	name: Uint8Array,
	prefix: Uint8Array,
	size: number,
	mtime: number,
	mode: number,
	typeFlag: number,
): Uint8Array {
	const header = new Uint8Array(BLOCK_SIZE);
	writeField(header, NAME_OFFSET, NAME_LENGTH, name);
	writeOctal(header, MODE_OFFSET, MODE_LENGTH, mode);
	writeOctal(header, 108, 8, 0);
	writeOctal(header, 116, 8, 0);
	writeOctal(header, SIZE_OFFSET, SIZE_LENGTH, size);
	writeOctal(header, MTIME_OFFSET, MTIME_LENGTH, mtime);
	header.fill(0x20, CHECKSUM_OFFSET, CHECKSUM_OFFSET + CHECKSUM_LENGTH);
	header[TYPEFLAG_OFFSET] = typeFlag;
	writeField(header, MAGIC_OFFSET, MAGIC.length, TEXT_ENCODER.encode(MAGIC));
	writeField(header, VERSION_OFFSET, VERSION.length, TEXT_ENCODER.encode(VERSION));
	writeField(header, PREFIX_OFFSET, PREFIX_LENGTH, prefix);
	let checksum = 0;
	for (const byte of header) checksum += byte;
	const digits = checksum.toString(8).padStart(6, "0");
	for (let index = 0; index < 6; index++) header[CHECKSUM_OFFSET + index] = digits.charCodeAt(index);
	header[CHECKSUM_OFFSET + 6] = 0;
	header[CHECKSUM_OFFSET + 7] = 0x20;
	return header;
}

function appendPayload(parts: Uint8Array[], payload: Uint8Array): void {
	parts.push(payload);
	const padding = paddedSize(payload.byteLength) - payload.byteLength;
	if (padding > 0) parts.push(new Uint8Array(padding));
}

function appendTarEntry(
	parts: Uint8Array[],
	archivePath: string,
	payload: Uint8Array,
	directory: boolean,
	sequence: number,
): void {
	const pathBytes = TEXT_ENCODER.encode(directory ? `${archivePath}/` : archivePath);
	const split = splitUstarPath(pathBytes);
	const size = directory ? 0 : payload.byteLength;
	const mtime = 0;
	const paxRecords: Uint8Array[] = [];
	if (!split) paxRecords.push(makePaxRecord("path", directory ? `${archivePath}/` : archivePath));
	if (size > MAX_OCTAL_SIZE) paxRecords.push(makePaxRecord("size", String(size)));
	if (mtime > MAX_OCTAL_MTIME) paxRecords.push(makePaxRecord("mtime", String(mtime)));
	if (paxRecords.length > 0) {
		const paxPayload = concatBytes(paxRecords);
		const paxName = TEXT_ENCODER.encode(`PaxHeaders/${String(sequence).padStart(8, "0")}`);
		parts.push(makeHeader(paxName, new Uint8Array(0), paxPayload.byteLength, 0, 0o644, 0x78));
		appendPayload(parts, paxPayload);
	}
	const effectiveSplit = split ?? [
		TEXT_ENCODER.encode(`PaxFile/${String(sequence).padStart(8, "0")}`),
		new Uint8Array(0),
	];
	parts.push(
		makeHeader(
			effectiveSplit[0],
			effectiveSplit[1],
			size <= MAX_OCTAL_SIZE ? size : 0,
			mtime,
			directory ? 0o755 : 0o644,
			directory ? 0x35 : 0x30,
		),
	);
	if (!directory) appendPayload(parts, payload);
}

/** Encode files as a deterministic ustar archive, using PAX records for overflow paths. */
export async function encodeTar(members: Iterable<readonly [string, Uint8Array]>): Promise<Uint8Array> {
	const parts: Uint8Array[] = [];
	const kinds = new Map<string, "directory" | "file">();
	let sequence = 0;
	for (const [rawPath, bytes] of members) {
		const directory = rawPath.endsWith("/") || rawPath.endsWith("\\");
		const normalized = normalizeArchiveEntryPath(rawPath);
		if (!normalized) throw new ArchiveError(`Invalid tar member path '${formatArchivePathForError(rawPath)}'`);
		const pathBytes = TEXT_ENCODER.encode(normalized);
		if (pathBytes.byteLength === 0) throw new ArchiveError("Invalid empty tar member path");
		if (directory && bytes.byteLength !== 0) {
			throw new ArchiveError(`Tar directory '${formatArchivePathForError(normalized)}' cannot contain file data`);
		}
		const segments = normalized.split("/");
		for (let index = 1; index < segments.length; index++) {
			const parent = segments.slice(0, index).join("/");
			const kind = kinds.get(parent);
			if (kind === "file")
				throw new ArchiveError(`Tar member '${formatArchivePathForError(parent)}' is not a directory`);
			if (kind === "directory") continue;
			kinds.set(parent, "directory");
			appendTarEntry(parts, parent, new Uint8Array(0), true, sequence++);
		}
		const existing = kinds.get(normalized);
		if (existing) {
			if (directory && existing === "directory") continue;
			throw new ArchiveError(`Duplicate tar member path '${formatArchivePathForError(normalized)}'`);
		}
		kinds.set(normalized, directory ? "directory" : "file");
		appendTarEntry(parts, normalized, bytes, directory, sequence++);
	}
	parts.push(new Uint8Array(BLOCK_SIZE * 2));
	return concatBytes(parts);
}
