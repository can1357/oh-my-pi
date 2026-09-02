import * as path from "node:path";
import * as zlib from "node:zlib";
import { readUInt16LE, readUInt32LE, readUInt64LE, writeUInt16LE, writeUInt32LE, writeUInt64LE } from "./bytes";
import { crc32 } from "./checksums";
import { bzip2Decompress } from "./codecs/bzip2";
import { lzmaDecompress } from "./codecs/lzma";
import { xzDecompress } from "./codecs/xz";
import { zstdDecompress } from "./codecs/zstd";
import { ArchiveError } from "./error";
import {
	type ArchiveLimits,
	assertArchiveMemberSize,
	assertEntryCount,
	assertIndexSize,
	DEFAULT_ARCHIVE_LIMITS,
} from "./limits";
import {
	assertArchivePathBytes,
	assertArchivePathString,
	isArchiveDirectoryName,
	normalizeArchiveEntryPath,
	normalizeArchiveLookupPath,
} from "./paths";
import { type ByteSource, memoryByteSource } from "./source";
import type { ArchiveIndexEntry, FormatReader, FormatReadOptions, MemberSource } from "./types";

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const EOCD_SIGNATURE = 0x06054b50;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const EOCD_LENGTH = 22;
const ZIP64_EOCD_LENGTH = 56;
const ZIP64_LOCATOR_LENGTH = 20;
const MAX_COMMENT_LENGTH = 0xffff;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;
const UTF8_FLAG = 0x0800;
const ENCRYPTED_FLAG = 0x0001;
const STRONG_ENCRYPTION_FLAG = 0x0040;
const UNIX_HOST = 3;
const OSX_HOST = 19;
const FILE_TYPE_MASK = 0o170000;
const DIRECTORY_TYPE = 0o040000;
const SYMLINK_TYPE = 0o120000;
const WINDOWS_EPOCH_FILETIME_MS = 11_644_473_600_000n;
const SUPPORTED_METHODS: Readonly<Partial<Record<number, true>>> = {
	0: true,
	8: true,
	12: true,
	14: true,
	20: true,
	93: true,
	95: true,
};

const UTF8_DECODER = new TextDecoder("utf-8");
const UTF8_FATAL_DECODER = new TextDecoder("utf-8", { fatal: true });
const LEGACY_NAME_DECODER = new TextDecoder("windows-1252");
const TEXT_ENCODER = new TextEncoder();

interface CentralDirectoryInfo {
	entries: number;
	offset: number;
	size: number;
	physicalEnd: number;
	archiveOffset: number;
}

interface Zip64Values {
	compressedSize: number;
	uncompressedSize: number;
	localHeaderOffset: number;
	diskStart: number;
}

interface Zip64Placeholders {
	compressedSize: boolean;
	uncompressedSize: boolean;
	localHeaderOffset: boolean;
	diskStart: boolean;
}

interface ParsedExtra {
	zip64?: Uint8Array;
	unicodePath?: string;
	mtimeMs?: number;
}

interface ParsedZipEntry {
	entry: ArchiveIndexEntry;
	isSymlink: boolean;
}

function archiveError(error: unknown, context: string): ArchiveError {
	if (error instanceof ArchiveError) return error;
	return new ArchiveError(`${context}: ${error instanceof Error ? error.message : String(error)}`);
}

function checkedEnd(start: number, size: number, archiveSize: number, what: string): number {
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(size) || start < 0 || size < 0) {
		throw new ArchiveError(`Invalid ZIP archive: ${what} has an invalid range`);
	}
	const end = start + size;
	if (!Number.isSafeInteger(end) || end > archiveSize) {
		throw new ArchiveError(`Invalid ZIP archive: ${what} exceeds archive size`);
	}
	return end;
}

function findEocd(tail: Uint8Array): number {
	for (let offset = tail.byteLength - EOCD_LENGTH; offset >= 0; offset--) {
		if (readUInt32LE(tail, offset) !== EOCD_SIGNATURE) continue;
		if (offset + EOCD_LENGTH + readUInt16LE(tail, offset + 20) === tail.byteLength) return offset;
	}
	throw new ArchiveError("Invalid ZIP archive: missing end of central directory");
}

async function readZip64Info(
	source: ByteSource,
	tail: Uint8Array,
	tailStart: number,
	eocdOffset: number,
): Promise<CentralDirectoryInfo | undefined> {
	const locatorOffset = eocdOffset - ZIP64_LOCATOR_LENGTH;
	if (locatorOffset < 0) return undefined;
	const locator =
		locatorOffset >= tailStart
			? tail.subarray(locatorOffset - tailStart, locatorOffset - tailStart + ZIP64_LOCATOR_LENGTH)
			: await source.read(locatorOffset, eocdOffset);
	if (locator.byteLength !== ZIP64_LOCATOR_LENGTH || readUInt32LE(locator, 0) !== ZIP64_LOCATOR_SIGNATURE) {
		return undefined;
	}
	if (readUInt32LE(locator, 4) !== 0 || readUInt32LE(locator, 16) !== 1) {
		throw new ArchiveError("Multi-volume ZIP archives are not supported");
	}

	const declaredOffset = readUInt64LE(locator, 8);
	const candidates = [declaredOffset];
	const adjacentOffset = locatorOffset - ZIP64_EOCD_LENGTH;
	if (adjacentOffset >= 0 && adjacentOffset !== declaredOffset) candidates.push(adjacentOffset);
	for (const candidate of candidates) {
		if (candidate < 0 || candidate + ZIP64_EOCD_LENGTH > source.size) continue;
		const record = await source.read(candidate, candidate + ZIP64_EOCD_LENGTH);
		if (record.byteLength !== ZIP64_EOCD_LENGTH || readUInt32LE(record, 0) !== ZIP64_EOCD_SIGNATURE) continue;
		const extensibleSize = readUInt64LE(record, 4);
		if (extensibleSize < 44 || candidate + 12 + extensibleSize !== locatorOffset) continue;
		if (readUInt32LE(record, 16) !== 0 || readUInt32LE(record, 20) !== 0) {
			throw new ArchiveError("Multi-volume ZIP archives are not supported");
		}
		const entriesOnDisk = readUInt64LE(record, 24);
		const entries = readUInt64LE(record, 32);
		if (entriesOnDisk !== entries) throw new ArchiveError("Multi-volume ZIP archives are not supported");
		return {
			entries,
			size: readUInt64LE(record, 40),
			offset: readUInt64LE(record, 48),
			physicalEnd: candidate,
			archiveOffset: 0,
		};
	}
	throw new ArchiveError("Invalid ZIP archive: missing ZIP64 end of central directory");
}

async function locateCentralDirectory(source: ByteSource, info: CentralDirectoryInfo): Promise<number> {
	if (info.entries === 0) return info.offset;
	const candidates = [info.offset];
	const adjacent = info.physicalEnd - info.size;
	if (adjacent !== info.offset) candidates.push(adjacent);
	for (const offset of candidates) {
		if (offset < 0 || offset + 4 > source.size || offset + info.size > source.size) continue;
		const signature = await source.read(offset, offset + 4);
		if (signature.byteLength === 4 && readUInt32LE(signature, 0) === CENTRAL_HEADER_SIGNATURE) return offset;
	}
	throw new ArchiveError("Invalid ZIP archive: central directory is out of bounds or malformed");
}

async function readCentralDirectoryInfo(source: ByteSource, limits: ArchiveLimits): Promise<CentralDirectoryInfo> {
	if (source.size < EOCD_LENGTH) throw new ArchiveError("Invalid ZIP archive: missing end of central directory");
	const tailLength = Math.min(source.size, EOCD_LENGTH + MAX_COMMENT_LENGTH);
	const tailStart = source.size - tailLength;
	const tail = await source.read(tailStart, source.size);
	if (tail.byteLength !== tailLength)
		throw new ArchiveError("Invalid ZIP archive: truncated end of central directory");
	const eocdIndex = findEocd(tail);
	const eocdOffset = tailStart + eocdIndex;
	const disk = readUInt16LE(tail, eocdIndex + 4);
	const centralDisk = readUInt16LE(tail, eocdIndex + 6);
	const entriesOnDisk = readUInt16LE(tail, eocdIndex + 8);
	let entries = readUInt16LE(tail, eocdIndex + 10);
	let size = readUInt32LE(tail, eocdIndex + 12);
	let offset = readUInt32LE(tail, eocdIndex + 16);
	if (
		disk !== 0 ||
		centralDisk !== 0 ||
		(entriesOnDisk !== U16_MAX && entries !== U16_MAX && entriesOnDisk !== entries)
	) {
		throw new ArchiveError("Multi-volume ZIP archives are not supported");
	}
	const needsZip64 = entriesOnDisk === U16_MAX || entries === U16_MAX || size === U32_MAX || offset === U32_MAX;
	const zip64 = await readZip64Info(source, tail, tailStart, eocdOffset);
	let physicalEnd = eocdOffset;
	if (zip64) {
		({ entries, size, offset, physicalEnd } = zip64);
	} else if (needsZip64) {
		throw new ArchiveError("Invalid ZIP archive: missing ZIP64 central-directory metadata");
	}
	assertEntryCount(entries, limits);
	assertIndexSize(size, limits, "ZIP central directory");
	if (entries > Math.floor(size / 46)) throw new ArchiveError("Invalid ZIP archive: truncated central directory");
	const declaredOffset = offset;
	const info = { entries, size, offset, physicalEnd, archiveOffset: 0 };
	info.offset = await locateCentralDirectory(source, info);
	info.archiveOffset = info.offset - declaredOffset;
	checkedEnd(info.offset, info.size, source.size, "central directory");
	return info;
}

function filetimeToMs(bytes: Uint8Array, offset: number): number | undefined {
	let value = 0n;
	for (let index = 7; index >= 0; index--) value = (value << 8n) | BigInt(bytes[offset + index]!);
	const milliseconds = value / 10_000n - WINDOWS_EPOCH_FILETIME_MS;
	const number = Number(milliseconds);
	return Number.isSafeInteger(number) ? number : undefined;
}

function parseNtfsMtime(data: Uint8Array): number | undefined {
	if (data.byteLength < 4) return undefined;
	let offset = 4;
	while (offset + 4 <= data.byteLength) {
		const tag = readUInt16LE(data, offset);
		const size = readUInt16LE(data, offset + 2);
		const end = offset + 4 + size;
		if (end > data.byteLength) throw new ArchiveError("Invalid ZIP archive: malformed NTFS extra field");
		if (tag === 1 && size >= 8) return filetimeToMs(data, offset + 4);
		offset = end;
	}
	return undefined;
}

function parseDosMtime(time: number, date: number): number | undefined {
	if (date === 0) return undefined;
	const year = 1980 + ((date >>> 9) & 0x7f);
	const month = ((date >>> 5) & 0x0f) - 1;
	const day = date & 0x1f;
	const hour = (time >>> 11) & 0x1f;
	const minute = (time >>> 5) & 0x3f;
	const second = (time & 0x1f) * 2;
	if (month < 0 || month > 11 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return undefined;
	const value = new Date(year, month, day, hour, minute, second).getTime();
	return Number.isFinite(value) ? value : undefined;
}

function parseExtra(extra: Uint8Array, rawName: Uint8Array): ParsedExtra {
	const result: ParsedExtra = {};
	let offset = 0;
	while (offset < extra.byteLength) {
		if (offset + 4 > extra.byteLength) throw new ArchiveError("Invalid ZIP archive: truncated extra-field header");
		const id = readUInt16LE(extra, offset);
		const size = readUInt16LE(extra, offset + 2);
		const dataStart = offset + 4;
		const dataEnd = dataStart + size;
		if (dataEnd > extra.byteLength) throw new ArchiveError("Invalid ZIP archive: malformed extra field");
		const data = extra.subarray(dataStart, dataEnd);
		if (id === 0x0001) {
			result.zip64 = data;
		} else if (id === 0x7075) {
			if (data.byteLength < 5) throw new ArchiveError("Invalid ZIP archive: Unicode path extra field is too small");
			if (data[0] === 1 && readUInt32LE(data, 1) === crc32(rawName)) {
				try {
					result.unicodePath = UTF8_FATAL_DECODER.decode(data.subarray(5));
				} catch {
					// A bad optional Unicode path falls back to the header name.
				}
			}
		} else if (id === 0x5455) {
			if (data.byteLength < 1)
				throw new ArchiveError("Invalid ZIP archive: extended timestamp extra field is too small");
			if ((data[0]! & 1) !== 0) {
				if (data.byteLength < 5)
					throw new ArchiveError("Invalid ZIP archive: extended timestamp extra field is too small");
				result.mtimeMs = (readUInt32LE(data, 1) | 0) * 1000;
			}
		} else if (id === 0x000a && result.mtimeMs === undefined) {
			result.mtimeMs = parseNtfsMtime(data);
		}
		offset = dataEnd;
	}
	return result;
}

function applyZip64Values(
	extra: Uint8Array | undefined,
	current: Zip64Values,
	placeholders: Zip64Placeholders,
): Zip64Values {
	const needs =
		placeholders.uncompressedSize ||
		placeholders.compressedSize ||
		placeholders.localHeaderOffset ||
		placeholders.diskStart;
	if (!needs) return current;
	if (!extra) throw new ArchiveError("Invalid ZIP archive: missing ZIP64 extra field");
	let offset = 0;
	const result = { ...current };
	if (placeholders.uncompressedSize) {
		if (offset + 8 > extra.byteLength) throw new ArchiveError("Invalid ZIP archive: malformed ZIP64 extra field");
		result.uncompressedSize = readUInt64LE(extra, offset);
		offset += 8;
	}
	if (placeholders.compressedSize) {
		if (offset + 8 > extra.byteLength) throw new ArchiveError("Invalid ZIP archive: malformed ZIP64 extra field");
		result.compressedSize = readUInt64LE(extra, offset);
		offset += 8;
	}
	if (placeholders.localHeaderOffset) {
		if (offset + 8 > extra.byteLength) throw new ArchiveError("Invalid ZIP archive: malformed ZIP64 extra field");
		result.localHeaderOffset = readUInt64LE(extra, offset);
		offset += 8;
	}
	if (placeholders.diskStart) {
		if (offset + 4 > extra.byteLength) throw new ArchiveError("Invalid ZIP archive: malformed ZIP64 extra field");
		result.diskStart = readUInt32LE(extra, offset);
	}
	return result;
}

async function decodeMember(
	compressed: Uint8Array,
	method: number,
	size: number,
	memberPath: string,
): Promise<Uint8Array> {
	try {
		switch (method) {
			case 0:
				return compressed;
			case 8:
				return zlib.inflateRawSync(compressed, { maxOutputLength: Math.max(size, 1) });
			case 12:
				return await bzip2Decompress(compressed, size);
			case 14: {
				if (compressed.byteLength < 9 || compressed[2] !== 5 || compressed[3] !== 0) {
					throw new ArchiveError(`Invalid ZIP archive: malformed LZMA properties for '${memberPath}'`);
				}
				return await lzmaDecompress(compressed.subarray(4, 9), compressed.subarray(9), size);
			}
			case 20:
			case 93:
				return await zstdDecompress(compressed, size);
			case 95:
				return await xzDecompress(compressed, size);
			default:
				throw new ArchiveError(`Unsupported ZIP compression method ${method} for '${memberPath}'`);
		}
	} catch (error) {
		throw archiveError(error, `Failed to decompress ZIP member '${memberPath}'`);
	}
}

class ZipMemberSource implements MemberSource {
	readonly #source: ByteSource;
	readonly #compressedSize: number;
	readonly #method: number;
	readonly #flags: number;
	readonly #crc: number;
	readonly #localHeaderOffset: number;
	readonly #limits: ArchiveLimits;

	constructor(
		source: ByteSource,
		compressedSize: number,
		method: number,
		flags: number,
		crc: number,
		localHeaderOffset: number,
		limits: ArchiveLimits,
	) {
		this.#source = source;
		this.#compressedSize = compressedSize;
		this.#method = method;
		this.#flags = flags;
		this.#crc = crc;
		this.#localHeaderOffset = localHeaderOffset;
		this.#limits = limits;
	}

	async read(size: number, memberPath: string): Promise<Uint8Array> {
		try {
			assertArchiveMemberSize(Math.max(size, this.#compressedSize), memberPath, this.#limits);
			if ((this.#flags & (ENCRYPTED_FLAG | STRONG_ENCRYPTION_FLAG)) !== 0 || this.#method === 99) {
				throw new ArchiveError(`Encrypted ZIP member '${memberPath}' is not supported`);
			}
			if (SUPPORTED_METHODS[this.#method] !== true) {
				throw new ArchiveError(`Unsupported ZIP compression method ${this.#method} for '${memberPath}'`);
			}
			const headerEnd = checkedEnd(
				this.#localHeaderOffset,
				30,
				this.#source.size,
				`local header for '${memberPath}'`,
			);
			const header = await this.#source.read(this.#localHeaderOffset, headerEnd);
			if (header.byteLength !== 30 || readUInt32LE(header, 0) !== LOCAL_HEADER_SIGNATURE) {
				throw new ArchiveError(`Invalid ZIP archive: malformed local header for '${memberPath}'`);
			}
			const localFlags = readUInt16LE(header, 6);
			if ((localFlags & (ENCRYPTED_FLAG | STRONG_ENCRYPTION_FLAG)) !== 0) {
				throw new ArchiveError(`Encrypted ZIP member '${memberPath}' is not supported`);
			}
			if (readUInt16LE(header, 8) !== this.#method) {
				throw new ArchiveError(
					`Invalid ZIP archive: local and central compression methods disagree for '${memberPath}'`,
				);
			}
			const dataStart = this.#localHeaderOffset + 30 + readUInt16LE(header, 26) + readUInt16LE(header, 28);
			const dataEnd = checkedEnd(dataStart, this.#compressedSize, this.#source.size, `data for '${memberPath}'`);
			if (this.#method === 0 && this.#compressedSize !== size) {
				throw new ArchiveError(
					`Invalid ZIP archive: size mismatch for '${memberPath}' (expected ${size}, got ${this.#compressedSize})`,
				);
			}
			const compressed = await this.#source.read(dataStart, dataEnd);
			if (compressed.byteLength !== this.#compressedSize) {
				throw new ArchiveError(`Invalid ZIP archive: truncated data for '${memberPath}'`);
			}
			const decoded = await decodeMember(compressed, this.#method, size, memberPath);
			if (decoded.byteLength !== size) {
				throw new ArchiveError(
					`Invalid ZIP archive: size mismatch for '${memberPath}' (expected ${size}, got ${decoded.byteLength})`,
				);
			}
			const actualCrc = crc32(decoded);
			if (actualCrc !== this.#crc) {
				throw new ArchiveError(`Invalid ZIP archive: CRC mismatch for '${memberPath}'`);
			}
			return decoded;
		} catch (error) {
			throw archiveError(error, `Failed to read ZIP member '${memberPath}'`);
		}
	}
}

function parseCentralDirectory(
	source: ByteSource,
	directory: Uint8Array,
	info: CentralDirectoryInfo,
	options: FormatReadOptions,
): ParsedZipEntry[] {
	const parsed: ParsedZipEntry[] = [];
	let offset = 0;
	for (let index = 0; index < info.entries; index++) {
		if (offset + 46 > directory.byteLength)
			throw new ArchiveError("Invalid ZIP archive: truncated central directory");
		if (readUInt32LE(directory, offset) !== CENTRAL_HEADER_SIGNATURE) {
			throw new ArchiveError("Invalid ZIP archive: malformed central directory");
		}
		const versionMadeBy = readUInt16LE(directory, offset + 4);
		const flags = readUInt16LE(directory, offset + 8);
		const method = readUInt16LE(directory, offset + 10);
		const dosTime = readUInt16LE(directory, offset + 12);
		const dosDate = readUInt16LE(directory, offset + 14);
		const crc = readUInt32LE(directory, offset + 16);
		const compressedRaw = readUInt32LE(directory, offset + 20);
		const uncompressedRaw = readUInt32LE(directory, offset + 24);
		const nameLength = readUInt16LE(directory, offset + 28);
		const extraLength = readUInt16LE(directory, offset + 30);
		const commentLength = readUInt16LE(directory, offset + 32);
		const diskStartRaw = readUInt16LE(directory, offset + 34);
		const externalAttributes = readUInt32LE(directory, offset + 38);
		const localOffsetRaw = readUInt32LE(directory, offset + 42);
		const nameStart = offset + 46;
		const extraStart = nameStart + nameLength;
		const commentStart = extraStart + extraLength;
		const end = commentStart + commentLength;
		if (!Number.isSafeInteger(end) || end > directory.byteLength) {
			throw new ArchiveError("Invalid ZIP archive: truncated central-directory entry");
		}
		assertArchivePathBytes(nameLength, "member path", options.limits.maxPathBytes);
		const rawName = directory.subarray(nameStart, extraStart);
		const extra = parseExtra(directory.subarray(extraStart, commentStart), rawName);
		const values = applyZip64Values(
			extra.zip64,
			{
				compressedSize: compressedRaw,
				uncompressedSize: uncompressedRaw,
				localHeaderOffset: localOffsetRaw,
				diskStart: diskStartRaw,
			},
			{
				compressedSize: compressedRaw === U32_MAX,
				uncompressedSize: uncompressedRaw === U32_MAX,
				localHeaderOffset: localOffsetRaw === U32_MAX,
				diskStart: diskStartRaw === U16_MAX,
			},
		);
		if (values.diskStart !== 0) throw new ArchiveError("Multi-volume ZIP archives are not supported");
		const rawPath =
			extra.unicodePath ?? ((flags & UTF8_FLAG) !== 0 ? UTF8_DECODER : LEGACY_NAME_DECODER).decode(rawName);
		assertArchivePathString(rawPath, "member path", options.limits.maxPathBytes);
		if ((flags & (ENCRYPTED_FLAG | STRONG_ENCRYPTION_FLAG)) !== 0 || method === 99) {
			throw new ArchiveError(`Encrypted ZIP member '${rawPath}' is not supported`);
		}
		const normalizedPath = normalizeArchiveEntryPath(rawPath);
		if (normalizedPath) {
			assertArchiveMemberSize(
				Math.max(values.uncompressedSize, values.compressedSize),
				normalizedPath,
				options.limits,
			);
			const host = versionMadeBy >>> 8;
			const mode = host === UNIX_HOST || host === OSX_HOST ? externalAttributes >>> 16 : undefined;
			const fileType = mode === undefined ? 0 : mode & FILE_TYPE_MASK;
			const isDirectory =
				isArchiveDirectoryName(rawPath) || fileType === DIRECTORY_TYPE || (externalAttributes & 0x10) !== 0;
			const isSymlink = fileType === SYMLINK_TYPE && !isDirectory;
			const localHeaderOffset = values.localHeaderOffset + info.archiveOffset;
			checkedEnd(localHeaderOffset, 30, source.size, `local header for '${normalizedPath}'`);
			const member = new ZipMemberSource(
				source,
				values.compressedSize,
				method,
				flags,
				crc,
				localHeaderOffset,
				options.limits,
			);
			const entry: ArchiveIndexEntry = {
				path: normalizedPath,
				isDirectory,
				size: isDirectory ? 0 : values.uncompressedSize,
				mtimeMs: extra.mtimeMs ?? parseDosMtime(dosTime, dosDate),
				mode: mode || undefined,
				storage: isDirectory ? undefined : { type: "member", source: member },
			};
			parsed.push({ entry, isSymlink });
			assertEntryCount(parsed.length, options.limits);
		}
		offset = end;
	}
	return parsed;
}

async function readZipImpl(source: ByteSource, options: FormatReadOptions): Promise<ArchiveIndexEntry[]> {
	const info = await readCentralDirectoryInfo(source, options.limits);
	if (info.size === 0) return [];
	const directory = await source.read(info.offset, info.offset + info.size);
	if (directory.byteLength !== info.size) throw new ArchiveError("Invalid ZIP archive: truncated central directory");
	const parsed = parseCentralDirectory(source, directory, info, options);
	for (const item of parsed) {
		if (!item.isSymlink) continue;
		assertArchivePathBytes(item.entry.size, "symlink target", options.limits.maxPathBytes);
		if (item.entry.storage?.type !== "member") throw new ArchiveError("Invalid ZIP archive: symlink has no payload");
		const bytes = await item.entry.storage.source.read(item.entry.size, item.entry.path);
		const target = UTF8_DECODER.decode(bytes);
		assertArchivePathString(target, "symlink target", options.limits.maxPathBytes);
		const portable = target.replace(/\\/g, "/");
		const absolute = path.posix.isAbsolute(portable) || /^[A-Za-z]:/.test(portable) || portable.includes("\0");
		const targetPath = absolute
			? undefined
			: normalizeArchiveLookupPath(path.posix.join(path.posix.dirname(item.entry.path), portable));
		item.entry.size = 0;
		item.entry.storage = {
			type: "link",
			targetPath: targetPath === undefined ? portable : targetPath,
			resolveTarget: targetPath !== undefined,
		};
	}
	return parsed.map(item => item.entry);
}

/** Index a ZIP/ZIP64 archive lazily from its central directory. */
export const readZip: FormatReader = async (source, options) => {
	try {
		return await readZipImpl(source, options);
	} catch (error) {
		throw archiveError(error, "Failed to read ZIP archive");
	}
};

/** Detect a ZIP local header, empty-archive end record, or leading data descriptor. */
export function sniffZip(bytes: Uint8Array): boolean {
	if (bytes.byteLength < 4) return false;
	const signature = readUInt32LE(bytes, 0);
	return (
		signature === LOCAL_HEADER_SIGNATURE || signature === EOCD_SIGNATURE || signature === DATA_DESCRIPTOR_SIGNATURE
	);
}

/** Materialize every regular ZIP member into a path-to-bytes map for document converters. */
export async function readZipEager(
	bytes: Uint8Array,
	limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): Promise<Map<string, Uint8Array>> {
	try {
		const entries = await readZip(memoryByteSource(bytes), { limits });
		const files = new Map<string, Uint8Array>();
		for (const entry of entries) {
			if (entry.isDirectory || entry.storage?.type !== "member") continue;
			files.set(entry.path, await entry.storage.source.read(entry.size, entry.path));
		}
		return files;
	} catch (error) {
		throw archiveError(error, "Failed to eagerly read ZIP archive");
	}
}

/** Encode deterministic stored/deflated ZIP bytes, emitting ZIP64 end records when the entry count requires them. */
export async function encodeZip(members: Iterable<readonly [string, Uint8Array]>): Promise<Uint8Array> {
	try {
		const localParts: Uint8Array[] = [];
		const centralParts: Uint8Array[] = [];
		let localSize = 0;
		let centralSize = 0;
		let count = 0;
		for (const [inputName, data] of members) {
			const portableName = inputName.replace(/\\/g, "/");
			const normalizedName = normalizeArchiveEntryPath(portableName);
			if (
				!normalizedName ||
				normalizedName !== portableName.replace(/^\.\//, "") ||
				portableName.startsWith("/") ||
				/^[A-Za-z]:/.test(portableName) ||
				portableName.includes("\0")
			) {
				throw new ArchiveError(`Cannot write unsafe ZIP member path '${inputName}'`);
			}
			const name = normalizedName;
			const nameBytes = TEXT_ENCODER.encode(name);
			if (nameBytes.byteLength > U16_MAX) throw new ArchiveError(`ZIP member path '${name}' is too long to write`);
			if (data.byteLength >= U32_MAX) throw new ArchiveError(`ZIP member '${name}' is too large to write`);
			const deflated = data.byteLength === 0 ? undefined : zlib.deflateRawSync(data);
			const payload = deflated && deflated.byteLength < data.byteLength ? deflated : data;
			const method = payload === data ? 0 : 8;
			if (payload.byteLength >= U32_MAX || localSize >= U32_MAX) {
				throw new ArchiveError("ZIP archive is too large to write member offsets safely");
			}
			const checksum = crc32(data);
			const local = new Uint8Array(30 + nameBytes.byteLength);
			writeUInt32LE(local, 0, LOCAL_HEADER_SIGNATURE);
			writeUInt16LE(local, 4, 20);
			writeUInt16LE(local, 6, UTF8_FLAG);
			writeUInt16LE(local, 8, method);
			writeUInt16LE(local, 10, 0);
			writeUInt16LE(local, 12, 0x21);
			writeUInt32LE(local, 14, checksum);
			writeUInt32LE(local, 18, payload.byteLength);
			writeUInt32LE(local, 22, data.byteLength);
			writeUInt16LE(local, 26, nameBytes.byteLength);
			local.set(nameBytes, 30);
			localParts.push(local, payload);

			const central = new Uint8Array(46 + nameBytes.byteLength);
			writeUInt32LE(central, 0, CENTRAL_HEADER_SIGNATURE);
			writeUInt16LE(central, 4, (UNIX_HOST << 8) | 20);
			writeUInt16LE(central, 6, 20);
			writeUInt16LE(central, 8, UTF8_FLAG);
			writeUInt16LE(central, 10, method);
			writeUInt16LE(central, 12, 0);
			writeUInt16LE(central, 14, 0x21);
			writeUInt32LE(central, 16, checksum);
			writeUInt32LE(central, 20, payload.byteLength);
			writeUInt32LE(central, 24, data.byteLength);
			writeUInt16LE(central, 28, nameBytes.byteLength);
			writeUInt32LE(central, 38, (0o100644 << 16) >>> 0);
			writeUInt32LE(central, 42, localSize);
			central.set(nameBytes, 46);
			centralParts.push(central);
			localSize += local.byteLength + payload.byteLength;
			centralSize += central.byteLength;
			count++;
			if (!Number.isSafeInteger(localSize + centralSize) || count > U32_MAX) {
				throw new ArchiveError("ZIP archive is too large to write");
			}
		}
		if (localSize >= U32_MAX || centralSize >= U32_MAX) {
			throw new ArchiveError("ZIP archive is too large to write member offsets safely");
		}
		const zip64 = count >= U16_MAX;
		const trailerLength = EOCD_LENGTH + (zip64 ? ZIP64_EOCD_LENGTH + ZIP64_LOCATOR_LENGTH : 0);
		const totalSize = localSize + centralSize + trailerLength;
		if (!Number.isSafeInteger(totalSize)) throw new ArchiveError("ZIP archive is too large to write");
		const output = new Uint8Array(totalSize);
		let outputOffset = 0;
		for (const part of localParts) {
			output.set(part, outputOffset);
			outputOffset += part.byteLength;
		}
		for (const part of centralParts) {
			output.set(part, outputOffset);
			outputOffset += part.byteLength;
		}
		if (zip64) {
			const zip64EocdOffset = outputOffset;
			writeUInt32LE(output, outputOffset, ZIP64_EOCD_SIGNATURE);
			writeUInt64LE(output, outputOffset + 4, 44);
			writeUInt16LE(output, outputOffset + 12, 45);
			writeUInt16LE(output, outputOffset + 14, 45);
			writeUInt64LE(output, outputOffset + 24, count);
			writeUInt64LE(output, outputOffset + 32, count);
			writeUInt64LE(output, outputOffset + 40, centralSize);
			writeUInt64LE(output, outputOffset + 48, localSize);
			outputOffset += ZIP64_EOCD_LENGTH;
			writeUInt32LE(output, outputOffset, ZIP64_LOCATOR_SIGNATURE);
			writeUInt64LE(output, outputOffset + 8, zip64EocdOffset);
			writeUInt32LE(output, outputOffset + 16, 1);
			outputOffset += ZIP64_LOCATOR_LENGTH;
		}
		writeUInt32LE(output, outputOffset, EOCD_SIGNATURE);
		writeUInt16LE(output, outputOffset + 8, zip64 ? U16_MAX : count);
		writeUInt16LE(output, outputOffset + 10, zip64 ? U16_MAX : count);
		writeUInt32LE(output, outputOffset + 12, centralSize);
		writeUInt32LE(output, outputOffset + 16, localSize);
		return output;
	} catch (error) {
		throw archiveError(error, "Failed to encode ZIP archive");
	}
}
