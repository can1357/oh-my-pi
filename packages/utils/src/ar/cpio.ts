import * as path from "node:path";
import { readUInt16BE, readUInt16LE } from "./bytes";
import { ensureParentDirectories, upsertArchiveEntry } from "./entries";
import { ArchiveError } from "./error";
import { assertArchiveMemberSize, assertEntryCount, assertIndexSize, assertInMemorySize } from "./limits";
import { assertArchivePathBytes, normalizeArchiveEntryPath, normalizeArchiveLookupPath } from "./paths";
import { readAllBytes } from "./source";
import type { ArchiveIndexEntry, FormatReader, FormatReadOptions, MemberSource } from "./types";

const NEWC_HEADER_SIZE = 110;
const ODC_HEADER_SIZE = 76;
const BINARY_HEADER_SIZE = 26;
const TRAILER_NAME = "TRAILER!!!";
const FILE_TYPE_MASK = 0o170000;
const FILE_TYPE_REGULAR = 0o100000;
const FILE_TYPE_DIRECTORY = 0o040000;
const FILE_TYPE_SYMLINK = 0o120000;
const UTF8_FATAL_DECODER = new TextDecoder("utf-8", { fatal: true });

interface ParsedHeader {
	headerSize: number;
	alignment: number;
	inode: number;
	mode: number;
	nlink: number;
	mtime: number;
	fileSize: number;
	devMajor: number;
	devMinor: number;
	nameSize: number;
	checksum?: number;
}

interface ParsedRecord {
	path?: string;
	mode: number;
	mtimeMs: number;
	nlink: number;
	inode: number;
	devMajor: number;
	devMinor: number;
	fileSize: number;
	dataOffset: number;
	checksum?: number;
}

interface LinkTarget {
	path: string;
	resolveTarget: boolean;
}

class CpioMemberSource implements MemberSource {
	readonly #bytes: Uint8Array;
	readonly #offset: number;
	readonly #size: number;
	readonly #checksum?: number;

	constructor(bytes: Uint8Array, offset: number, size: number, checksum?: number) {
		this.#bytes = bytes;
		this.#offset = offset;
		this.#size = size;
		this.#checksum = checksum;
	}

	async read(size: number, memberPath: string): Promise<Uint8Array> {
		if (size !== this.#size) {
			throw new ArchiveError(`CPIO member '${memberPath}' has an inconsistent declared size`);
		}
		const end = this.#offset + this.#size;
		if (end > this.#bytes.byteLength) {
			throw new ArchiveError(`CPIO member '${memberPath}' is truncated`);
		}
		const bytes = this.#bytes.subarray(this.#offset, end);
		if (this.#checksum !== undefined && checksumBytes(bytes) !== this.#checksum) {
			throw new ArchiveError(`CPIO member '${memberPath}' has an invalid CRC checksum`);
		}
		return bytes;
	}
}

function checksumBytes(bytes: Uint8Array): number {
	let checksum = 0;
	for (const byte of bytes) checksum = (checksum + byte) >>> 0;
	return checksum;
}

function align(value: number, alignment: number): number {
	const remainder = value % alignment;
	return remainder === 0 ? value : value + alignment - remainder;
}

function requireRange(bytes: Uint8Array, start: number, end: number, what: string): void {
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(end) ||
		start < 0 ||
		end < start ||
		end > bytes.byteLength
	) {
		throw new ArchiveError(`Invalid CPIO archive: truncated ${what}`);
	}
}

function parseDigits(bytes: Uint8Array, offset: number, length: number, radix: 8 | 16, field: string): number {
	requireRange(bytes, offset, offset + length, `${field} field`);
	let value = 0;
	for (let index = offset; index < offset + length; index++) {
		const code = bytes[index]!;
		let digit: number;
		if (code >= 0x30 && code <= 0x39) digit = code - 0x30;
		else if (radix === 16 && code >= 0x41 && code <= 0x46) digit = code - 0x41 + 10;
		else if (radix === 16 && code >= 0x61 && code <= 0x66) digit = code - 0x61 + 10;
		else throw new ArchiveError(`Invalid CPIO archive: ${field} is not a valid base-${radix} number`);
		if (digit >= radix) throw new ArchiveError(`Invalid CPIO archive: ${field} is not a valid base-${radix} number`);
		value = value * radix + digit;
	}
	if (!Number.isSafeInteger(value)) throw new ArchiveError(`Invalid CPIO archive: ${field} is too large`);
	return value;
}

function parseHeader(bytes: Uint8Array, offset: number): ParsedHeader {
	requireRange(bytes, offset, offset + 2, "header");
	const first = bytes[offset]!;
	const second = bytes[offset + 1]!;
	if ((first === 0xc7 && second === 0x71) || (first === 0x71 && second === 0xc7)) {
		requireRange(bytes, offset, offset + BINARY_HEADER_SIZE, "old binary header");
		const littleEndian = first === 0xc7;
		const read16 = littleEndian ? readUInt16LE : readUInt16BE;
		const read32Words = (fieldOffset: number): number =>
			read16(bytes, offset + fieldOffset) * 0x10000 + read16(bytes, offset + fieldOffset + 2);
		return {
			headerSize: BINARY_HEADER_SIZE,
			alignment: 2,
			devMajor: 0,
			devMinor: read16(bytes, offset + 2),
			inode: read16(bytes, offset + 4),
			mode: read16(bytes, offset + 6),
			nlink: read16(bytes, offset + 12),
			mtime: read32Words(16),
			nameSize: read16(bytes, offset + 20),
			fileSize: read32Words(22),
		};
	}

	requireRange(bytes, offset, offset + 6, "magic");
	const magic = String.fromCharCode(...bytes.subarray(offset, offset + 6));
	if (magic === "070701" || magic === "070702") {
		requireRange(bytes, offset, offset + NEWC_HEADER_SIZE, "new ASCII header");
		const field = (index: number, name: string): number => parseDigits(bytes, offset + 6 + index * 8, 8, 16, name);
		const checksum = field(12, "checksum");
		if (magic === "070701" && checksum !== 0) {
			throw new ArchiveError("Invalid CPIO archive: newc checksum field must be zero");
		}
		return {
			headerSize: NEWC_HEADER_SIZE,
			alignment: 4,
			inode: field(0, "inode"),
			mode: field(1, "mode"),
			nlink: field(4, "link count"),
			mtime: field(5, "modification time"),
			fileSize: field(6, "file size"),
			devMajor: field(7, "device major"),
			devMinor: field(8, "device minor"),
			nameSize: field(11, "name size"),
			checksum: magic === "070702" ? checksum : undefined,
		};
	}
	if (magic === "070707") {
		requireRange(bytes, offset, offset + ODC_HEADER_SIZE, "portable ASCII header");
		const field6 = (fieldOffset: number, name: string): number =>
			parseDigits(bytes, offset + fieldOffset, 6, 8, name);
		return {
			headerSize: ODC_HEADER_SIZE,
			alignment: 1,
			devMajor: 0,
			devMinor: field6(6, "device"),
			inode: field6(12, "inode"),
			mode: field6(18, "mode"),
			nlink: field6(36, "link count"),
			mtime: parseDigits(bytes, offset + 48, 11, 8, "modification time"),
			nameSize: field6(59, "name size"),
			fileSize: parseDigits(bytes, offset + 65, 11, 8, "file size"),
		};
	}
	throw new ArchiveError(`Invalid CPIO archive: unsupported or corrupt magic at offset ${offset}`);
}

function decodeUtf8(bytes: Uint8Array): string | undefined {
	try {
		return UTF8_FATAL_DECODER.decode(bytes);
	} catch {
		return undefined;
	}
}

function validateZeroPadding(bytes: Uint8Array, start: number, end: number, what: string): void {
	for (let offset = start; offset < end; offset++) {
		if (bytes[offset] !== 0) throw new ArchiveError(`Invalid CPIO archive: non-zero ${what} padding`);
	}
}

function makeLinkTarget(recordPath: string, targetBytes: Uint8Array, maxPathBytes: number): LinkTarget {
	assertArchivePathBytes(targetBytes.byteLength, "link target", maxPathBytes);
	const rawTarget = decodeUtf8(targetBytes);
	if (rawTarget === undefined || rawTarget.includes("\0")) {
		throw new ArchiveError(`Invalid CPIO archive: symlink '${recordPath}' has an invalid UTF-8 target`);
	}
	const portableTarget = rawTarget.replace(/\\/g, "/");
	if (path.posix.isAbsolute(portableTarget)) return { path: portableTarget, resolveTarget: false };
	const normalized = normalizeArchiveLookupPath(path.posix.join(path.posix.dirname(recordPath), portableTarget));
	return normalized === undefined
		? { path: portableTarget, resolveTarget: false }
		: { path: normalized, resolveTarget: true };
}

/** Parse an already-materialized CPIO stream for direct and RPM-composed readers. */
export function readCpioEntriesFromBuffer(bytes: Uint8Array, options: FormatReadOptions): ArchiveIndexEntry[] {
	assertInMemorySize(bytes.byteLength, options.limits);
	const records: ParsedRecord[] = [];
	let offset = 0;
	let metadataSize = 0;
	let foundTrailer = false;

	while (offset < bytes.byteLength) {
		const header = parseHeader(bytes, offset);
		if (header.mode > 0xffff) throw new ArchiveError("Invalid CPIO archive: mode exceeds 16 bits");
		if (header.nameSize < 1) throw new ArchiveError("Invalid CPIO archive: name size must include a NUL terminator");
		assertArchivePathBytes(header.nameSize - 1, "member path", options.limits.maxPathBytes);
		assertArchiveMemberSize(header.fileSize, "(CPIO entry)", options.limits);

		const nameStart = offset + header.headerSize;
		const nameEnd = nameStart + header.nameSize;
		const dataOffset = align(nameEnd, header.alignment);
		const dataEnd = dataOffset + header.fileSize;
		const nextOffset = align(dataEnd, header.alignment);
		requireRange(bytes, nameStart, nameEnd, "member name");
		requireRange(bytes, dataOffset, dataEnd, "member data");
		requireRange(bytes, dataEnd, nextOffset, "member padding");
		if (bytes[nameEnd - 1] !== 0) throw new ArchiveError("Invalid CPIO archive: member name is not NUL-terminated");
		for (let index = nameStart; index < nameEnd - 1; index++) {
			if (bytes[index] === 0) throw new ArchiveError("Invalid CPIO archive: member name contains an embedded NUL");
		}
		validateZeroPadding(bytes, nameEnd, dataOffset, "name");
		validateZeroPadding(bytes, dataEnd, nextOffset, "data");

		metadataSize += dataOffset - offset;
		assertIndexSize(metadataSize, options.limits, "CPIO index");
		const rawName = decodeUtf8(bytes.subarray(nameStart, nameEnd - 1));
		if (rawName === TRAILER_NAME) {
			if (header.fileSize !== 0) throw new ArchiveError("Invalid CPIO archive: TRAILER!!! has non-empty data");
			foundTrailer = true;
			offset = nextOffset;
			break;
		}

		const fileType = header.mode & FILE_TYPE_MASK;
		if ((fileType === FILE_TYPE_DIRECTORY || fileType === 0o010000) && header.fileSize !== 0) {
			throw new ArchiveError("Invalid CPIO archive: directory or FIFO has non-empty data");
		}
		assertEntryCount(records.length + 1, options.limits);
		const normalizedPath = rawName === undefined ? undefined : normalizeArchiveEntryPath(rawName);
		records.push({
			path: normalizedPath,
			mode: header.mode,
			mtimeMs: header.mtime * 1000,
			nlink: header.nlink,
			inode: header.inode,
			devMajor: header.devMajor,
			devMinor: header.devMinor,
			fileSize: header.fileSize,
			dataOffset,
			checksum: header.checksum,
		});
		offset = nextOffset;
	}

	if (!foundTrailer) throw new ArchiveError("Invalid CPIO archive: missing TRAILER!!! terminator");
	validateZeroPadding(bytes, offset, bytes.byteLength, "trailing");

	const entriesByPath = new Map<string, ArchiveIndexEntry>();
	const handledHardLinks = new Set<ParsedRecord>();
	const hardLinkGroups = new Map<string, ParsedRecord[]>();
	for (const record of records) {
		if ((record.mode & FILE_TYPE_MASK) !== FILE_TYPE_REGULAR || record.nlink <= 1) continue;
		const key = `${record.devMajor}:${record.devMinor}:${record.inode}`;
		const group = hardLinkGroups.get(key);
		if (group) group.push(record);
		else hardLinkGroups.set(key, [record]);
	}

	for (const group of hardLinkGroups.values()) {
		if (group.length < 2) continue;
		for (const record of group) handledHardLinks.add(record);
		const retained = group.filter((record): record is ParsedRecord & { path: string } => record.path !== undefined);
		if (retained.length === 0) continue;
		const payload = group.find(record => record.fileSize !== 0) ?? group[0]!;
		const canonical = retained.find(record => record === payload) ?? retained[0]!;
		for (const record of retained) {
			const entry: ArchiveIndexEntry = {
				path: record.path,
				isDirectory: false,
				size: payload.fileSize,
				mtimeMs: record.mtimeMs,
				mode: record.mode,
				storage:
					record === canonical
						? {
								type: "member",
								source: new CpioMemberSource(bytes, payload.dataOffset, payload.fileSize, payload.checksum),
							}
						: { type: "link", targetPath: canonical.path, resolveTarget: false },
			};
			upsertArchiveEntry(entriesByPath, entry);
		}
	}

	for (const record of records) {
		if (handledHardLinks.has(record) || record.path === undefined) continue;
		const fileType = record.mode & FILE_TYPE_MASK;
		if (fileType === FILE_TYPE_DIRECTORY) {
			upsertArchiveEntry(entriesByPath, {
				path: record.path,
				isDirectory: true,
				size: 0,
				mtimeMs: record.mtimeMs,
				mode: record.mode,
			});
			continue;
		}
		if (fileType === FILE_TYPE_SYMLINK) {
			const targetBytes = bytes.subarray(record.dataOffset, record.dataOffset + record.fileSize);
			if (record.checksum !== undefined && checksumBytes(targetBytes) !== record.checksum) {
				throw new ArchiveError(`CPIO symlink '${record.path}' has an invalid CRC checksum`);
			}
			const linkTarget = makeLinkTarget(record.path, targetBytes, options.limits.maxPathBytes);
			upsertArchiveEntry(entriesByPath, {
				path: record.path,
				isDirectory: false,
				size: 0,
				mtimeMs: record.mtimeMs,
				mode: record.mode,
				storage: {
					type: "link",
					targetPath: linkTarget.path,
					resolveTarget: linkTarget.resolveTarget,
				},
			});
			continue;
		}
		if (fileType !== FILE_TYPE_REGULAR) continue;
		upsertArchiveEntry(entriesByPath, {
			path: record.path,
			isDirectory: false,
			size: record.fileSize,
			mtimeMs: record.mtimeMs,
			mode: record.mode,
			storage: {
				type: "member",
				source: new CpioMemberSource(bytes, record.dataOffset, record.fileSize, record.checksum),
			},
		});
	}

	ensureParentDirectories(entriesByPath, options.limits);
	return [...entriesByPath.values()];
}

/** Read and index a CPIO archive, materializing its inherently sequential stream once. */
export const readCpio: FormatReader = async (source, options) => {
	try {
		assertInMemorySize(source.size, options.limits);
		return readCpioEntriesFromBuffer(await readAllBytes(source), options);
	} catch (error) {
		if (error instanceof ArchiveError) throw error;
		throw new ArchiveError(error instanceof Error ? error.message : String(error));
	}
};

/** Detect newc, CRC, odc, or either-endian old binary CPIO headers. */
export function sniffCpio(bytes: Uint8Array): boolean {
	try {
		const header = parseHeader(bytes, 0);
		if (header.mode > 0xffff || header.nameSize < 1) return false;
		const nameEnd = header.headerSize + header.nameSize;
		return nameEnd <= bytes.byteLength && bytes[nameEnd - 1] === 0;
	} catch {
		return false;
	}
}
