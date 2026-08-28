import * as zlib from "node:zlib";
import { readUInt16LE, readUInt32LE } from "./bytes";
import { LzxDecoder } from "./codecs/lzx";
import { ArchiveError } from "./error";
import {
	type ArchiveLimits,
	assertArchiveMemberSize,
	assertEntryCount,
	assertIndexSize,
	assertInMemorySize,
} from "./limits";
import { assertArchivePathBytes, normalizeArchiveEntryPath } from "./paths";
import type { ByteSource } from "./source";
import type { ArchiveIndexEntry, FormatReader, MemberSource } from "./types";

const CAB_SIGNATURE = "MSCF";
const FIXED_HEADER_SIZE = 36;
const DATA_BLOCK_SIZE = 8;
const MAX_DATA_OUTPUT = 32 * 1024;
const ATTRIBUTE_READ_ONLY = 0x01;
const ATTRIBUTE_DIRECTORY = 0x10;
const ATTRIBUTE_EXECUTE = 0x40;
const ATTRIBUTE_UTF8_NAME = 0x80;
const UTF8_FATAL_DECODER = new TextDecoder("utf-8", { fatal: true });
const LEGACY_NAME_DECODER = new TextDecoder("windows-1252");

interface CabFolderDescription {
	dataStart: number;
	dataEnd: number;
	blockCount: number;
	method: number;
	parameter: number;
	requiredSize: number;
}

async function readExact(
	source: ByteSource,
	start: number,
	end: number,
	cabinetSize = source.size,
): Promise<Uint8Array> {
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > cabinetSize) {
		throw new ArchiveError("Invalid CAB archive: metadata range is out of bounds");
	}
	let bytes: Uint8Array;
	try {
		bytes = await source.read(start, end);
	} catch (error) {
		if (error instanceof ArchiveError) throw error;
		throw new ArchiveError(`Unable to read CAB archive: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (bytes.byteLength !== end - start) throw new ArchiveError("Invalid CAB archive: truncated data");
	return bytes;
}

function hasSignature(bytes: Uint8Array): boolean {
	return bytes.byteLength >= 4 && bytes[0] === 0x4d && bytes[1] === 0x53 && bytes[2] === 0x43 && bytes[3] === 0x46;
}

function cabChecksum(bytes: Uint8Array, initial = 0): number {
	let checksum = initial >>> 0;
	let offset = 0;
	while (offset + 4 <= bytes.byteLength) {
		checksum ^= readUInt32LE(bytes, offset);
		offset += 4;
	}
	const remaining = bytes.byteLength - offset;
	let remainder = 0;
	if (remaining === 3) {
		remainder = (bytes[offset]! << 16) | (bytes[offset + 1]! << 8) | bytes[offset + 2]!;
	} else if (remaining === 2) {
		remainder = (bytes[offset]! << 8) | bytes[offset + 1]!;
	} else if (remaining === 1) {
		remainder = bytes[offset]!;
	}
	return (checksum ^ remainder) >>> 0;
}

function decodeName(bytes: Uint8Array, utf8: boolean): string {
	try {
		return utf8 ? UTF8_FATAL_DECODER.decode(bytes) : LEGACY_NAME_DECODER.decode(bytes);
	} catch {
		throw new ArchiveError("Invalid CAB archive: file name is not valid UTF-8");
	}
}

function dosTimestamp(date: number, time: number): number | undefined {
	if (date === 0 && time === 0) return undefined;
	const year = 1980 + (date >>> 9);
	const month = (date >>> 5) & 0x0f;
	const day = date & 0x1f;
	const hour = time >>> 11;
	const minute = (time >>> 5) & 0x3f;
	const second = (time & 0x1f) * 2;
	if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
		throw new ArchiveError("Invalid CAB archive: file has an invalid DOS timestamp");
	}
	return new Date(year, month - 1, day, hour, minute, second).getTime();
}

function modeFromAttributes(attributes: number, directory: boolean): number {
	if (directory) return 0o040755;
	let permissions = attributes & ATTRIBUTE_READ_ONLY ? 0o444 : 0o644;
	if (attributes & ATTRIBUTE_EXECUTE) permissions |= 0o111;
	return 0o100000 | permissions;
}

class CabFolder {
	readonly #source: ByteSource;
	readonly #description: CabFolderDescription;
	readonly #dataReserveSize: number;
	readonly #limits: ArchiveLimits;
	#decoded?: Promise<Uint8Array>;

	constructor(source: ByteSource, description: CabFolderDescription, dataReserveSize: number, limits: ArchiveLimits) {
		this.#source = source;
		this.#description = description;
		this.#dataReserveSize = dataReserveSize;
		this.#limits = limits;
	}

	readAll(): Promise<Uint8Array> {
		this.#decoded ??= this.#decode();
		return this.#decoded;
	}

	async #decode(): Promise<Uint8Array> {
		const description = this.#description;
		if (description.method === 2) {
			throw new ArchiveError(`Unsupported CAB compression method: Quantum (level ${description.parameter})`);
		}
		if (description.method > 3) {
			throw new ArchiveError(`Unsupported CAB compression method: ${description.method}`);
		}
		if (description.method === 3 && (description.parameter < 15 || description.parameter > 21)) {
			throw new ArchiveError(`Unsupported CAB LZX window size: ${description.parameter} bits (expected 15-21)`);
		}

		const compressedSize = description.dataEnd - description.dataStart;
		assertInMemorySize(compressedSize, this.#limits);
		const bytes = await readExact(this.#source, description.dataStart, description.dataEnd);
		let position = 0;
		let outputSize = 0;
		for (let block = 0; block < description.blockCount; block++) {
			if (position + DATA_BLOCK_SIZE + this.#dataReserveSize > bytes.byteLength) {
				throw new ArchiveError("Invalid CAB archive: truncated CFDATA header");
			}
			const compressed = readUInt16LE(bytes, position + 4);
			const uncompressed = readUInt16LE(bytes, position + 6);
			if (uncompressed === 0) throw new ArchiveError("Unsupported multi-volume CAB archive: split CFDATA block");
			if (uncompressed > MAX_DATA_OUTPUT) {
				throw new ArchiveError(`Invalid CAB archive: CFDATA expands to ${uncompressed} bytes (maximum 32768)`);
			}
			const payloadStart = position + DATA_BLOCK_SIZE + this.#dataReserveSize;
			const payloadEnd = payloadStart + compressed;
			if (payloadEnd > bytes.byteLength) throw new ArchiveError("Invalid CAB archive: truncated CFDATA payload");
			const expectedChecksum = readUInt32LE(bytes, position);
			if (expectedChecksum !== 0) {
				const payloadChecksum = cabChecksum(bytes.subarray(payloadStart, payloadEnd));
				const actualChecksum = cabChecksum(bytes.subarray(position + 4, payloadStart), payloadChecksum);
				if (actualChecksum !== expectedChecksum) {
					throw new ArchiveError(`Invalid CAB archive: CFDATA block ${block} checksum mismatch`);
				}
			}
			outputSize += uncompressed;
			assertInMemorySize(outputSize, this.#limits);
			position = payloadEnd;
		}
		if (outputSize < description.requiredSize) {
			throw new ArchiveError("Invalid CAB archive: folder data is shorter than its file table declares");
		}

		const output = new Uint8Array(outputSize);
		const lzx = description.method === 3 ? new LzxDecoder(description.parameter) : undefined;
		position = 0;
		let outputPosition = 0;
		for (let block = 0; block < description.blockCount; block++) {
			const compressed = readUInt16LE(bytes, position + 4);
			const uncompressed = readUInt16LE(bytes, position + 6);
			const payloadStart = position + DATA_BLOCK_SIZE + this.#dataReserveSize;
			const payloadEnd = payloadStart + compressed;
			const payload = bytes.subarray(payloadStart, payloadEnd);
			let decoded: Uint8Array;
			if (description.method === 0) {
				if (compressed !== uncompressed) {
					throw new ArchiveError("Invalid CAB archive: uncompressed CFDATA sizes do not match");
				}
				decoded = payload;
			} else if (description.method === 1) {
				if (payload.byteLength < 2 || payload[0] !== 0x43 || payload[1] !== 0x4b) {
					throw new ArchiveError("Invalid CAB archive: MSZIP block is missing its CK signature");
				}
				try {
					const dictionary = output.subarray(Math.max(0, outputPosition - MAX_DATA_OUTPUT), outputPosition);
					decoded = new Uint8Array(
						zlib.inflateRawSync(payload.subarray(2), { dictionary, maxOutputLength: uncompressed }),
					);
				} catch (error) {
					throw new ArchiveError(
						`Invalid CAB archive: MSZIP decompression failed${error instanceof Error ? `: ${error.message}` : ""}`,
					);
				}
			} else {
				decoded = lzx!.decompressFrame(payload, uncompressed);
			}
			if (decoded.byteLength !== uncompressed) {
				throw new ArchiveError(
					`Invalid CAB archive: CFDATA block ${block} produced ${decoded.byteLength} bytes, expected ${uncompressed}`,
				);
			}
			output.set(decoded, outputPosition);
			outputPosition += decoded.byteLength;
			position = payloadEnd;
		}
		return output;
	}
}

class CabMemberSource implements MemberSource {
	readonly #folder: CabFolder;
	readonly #offset: number;
	readonly #declaredSize: number;

	constructor(folder: CabFolder, offset: number, size: number) {
		this.#folder = folder;
		this.#offset = offset;
		this.#declaredSize = size;
	}

	async read(size: number, memberPath: string): Promise<Uint8Array> {
		if (size !== this.#declaredSize) {
			throw new ArchiveError(`Invalid CAB archive: size changed while extracting '${memberPath}'`);
		}
		const folder = await this.#folder.readAll();
		const end = this.#offset + size;
		if (!Number.isSafeInteger(end) || this.#offset < 0 || end > folder.byteLength) {
			throw new ArchiveError(`Invalid CAB archive: member '${memberPath}' is outside its folder data`);
		}
		return folder.slice(this.#offset, end);
	}
}

async function readCabArchive(source: ByteSource, options: Parameters<FormatReader>[1]): Promise<ArchiveIndexEntry[]> {
	if (source.size < FIXED_HEADER_SIZE) throw new ArchiveError("Invalid CAB archive: truncated CFHEADER");
	const fixed = await readExact(source, 0, FIXED_HEADER_SIZE);
	if (!hasSignature(fixed)) throw new ArchiveError(`Invalid CAB archive: expected ${CAB_SIGNATURE} signature`);
	if (readUInt32LE(fixed, 4) !== 0 || readUInt32LE(fixed, 12) !== 0 || readUInt32LE(fixed, 20) !== 0) {
		throw new ArchiveError("Invalid CAB archive: reserved CFHEADER fields must be zero");
	}
	const cabinetSize = readUInt32LE(fixed, 8);
	if (cabinetSize < FIXED_HEADER_SIZE || cabinetSize > source.size) {
		throw new ArchiveError("Invalid CAB archive: declared cabinet size is out of bounds");
	}
	const fileTableOffset = readUInt32LE(fixed, 16);
	if (fileTableOffset < FIXED_HEADER_SIZE || fileTableOffset > cabinetSize) {
		throw new ArchiveError("Invalid CAB archive: CFFILE table offset is out of bounds");
	}
	if (fixed[24] !== 3 || fixed[25] !== 1) {
		throw new ArchiveError(`Unsupported CAB format version ${fixed[25]}.${fixed[24]} (expected 1.3)`);
	}
	const folderCount = readUInt16LE(fixed, 26);
	const fileCount = readUInt16LE(fixed, 28);
	const flags = readUInt16LE(fixed, 30);
	if (flags & 0x0003) throw new ArchiveError("Unsupported multi-volume CAB archive (previous/next cabinet link)");
	assertEntryCount(folderCount + fileCount, options.limits);
	if (folderCount === 0 && fileCount !== 0)
		throw new ArchiveError("Invalid CAB archive: files exist without a folder");

	let headerReserveSize = 0;
	let folderReserveSize = 0;
	let dataReserveSize = 0;
	let folderTableOffset = FIXED_HEADER_SIZE;
	if (flags & 0x0004) {
		const reserveHeader = await readExact(source, FIXED_HEADER_SIZE, FIXED_HEADER_SIZE + 4, cabinetSize);
		headerReserveSize = readUInt16LE(reserveHeader, 0);
		folderReserveSize = reserveHeader[2]!;
		dataReserveSize = reserveHeader[3]!;
		if (headerReserveSize > 60_000)
			throw new ArchiveError("Invalid CAB archive: CFHEADER reserve area exceeds 60000 bytes");
		folderTableOffset += 4 + headerReserveSize;
	}
	const folderRecordSize = 8 + folderReserveSize;
	const folderTableEnd = folderTableOffset + folderCount * folderRecordSize;
	if (!Number.isSafeInteger(folderTableEnd) || folderTableEnd > cabinetSize || folderTableEnd > fileTableOffset) {
		throw new ArchiveError("Invalid CAB archive: CFFOLDER table is out of bounds");
	}
	assertIndexSize(folderTableEnd, options.limits, "CAB header");
	const header = await readExact(source, 0, folderTableEnd, cabinetSize);
	const descriptions: CabFolderDescription[] = [];
	for (let index = 0; index < folderCount; index++) {
		const offset = folderTableOffset + index * folderRecordSize;
		const type = readUInt16LE(header, offset + 6);
		descriptions.push({
			dataStart: readUInt32LE(header, offset),
			dataEnd: cabinetSize,
			blockCount: readUInt16LE(header, offset + 4),
			method: type & 0x000f,
			parameter: type >>> 8,
			requiredSize: 0,
		});
	}
	for (const description of descriptions) {
		if (description.dataStart < folderTableEnd || description.dataStart > cabinetSize) {
			throw new ArchiveError("Invalid CAB archive: CFFOLDER data offset is out of bounds");
		}
		for (const candidate of descriptions) {
			if (candidate.dataStart > description.dataStart && candidate.dataStart < description.dataEnd) {
				description.dataEnd = candidate.dataStart;
			}
		}
	}
	const firstDataOffset = descriptions.reduce(
		(minimum, description) => Math.min(minimum, description.dataStart),
		cabinetSize,
	);
	if (fileTableOffset > firstDataOffset)
		throw new ArchiveError("Invalid CAB archive: CFFILE table overlaps folder data");
	assertIndexSize(folderTableEnd + (firstDataOffset - fileTableOffset), options.limits, "CAB index");
	const fileTable = await readExact(source, fileTableOffset, firstDataOffset, cabinetSize);
	const folders = descriptions.map(description => new CabFolder(source, description, dataReserveSize, options.limits));
	const entries: ArchiveIndexEntry[] = [];
	let position = 0;
	for (let index = 0; index < fileCount; index++) {
		if (position + 16 > fileTable.byteLength) throw new ArchiveError("Invalid CAB archive: truncated CFFILE entry");
		const size = readUInt32LE(fileTable, position);
		const folderOffset = readUInt32LE(fileTable, position + 4);
		const folderIndex = readUInt16LE(fileTable, position + 8);
		const date = readUInt16LE(fileTable, position + 10);
		const time = readUInt16LE(fileTable, position + 12);
		const attributes = readUInt16LE(fileTable, position + 14);
		position += 16;
		const nameEnd = fileTable.indexOf(0, position);
		if (nameEnd < 0) throw new ArchiveError("Invalid CAB archive: unterminated CFFILE name");
		const nameBytes = fileTable.subarray(position, nameEnd);
		if (nameBytes.byteLength > 256) throw new ArchiveError("Invalid CAB archive: CFFILE name exceeds 256 bytes");
		assertArchivePathBytes(nameBytes.byteLength, "member path", options.limits.maxPathBytes);
		position = nameEnd + 1;
		if (folderIndex >= 0xfffd) throw new ArchiveError("Unsupported multi-volume CAB archive: continued file");
		if (folderIndex >= folders.length)
			throw new ArchiveError("Invalid CAB archive: CFFILE references a missing folder");
		const rawName = decodeName(nameBytes, (attributes & ATTRIBUTE_UTF8_NAME) !== 0);
		assertArchiveMemberSize(size, rawName, options.limits);
		const end = folderOffset + size;
		if (!Number.isSafeInteger(end)) throw new ArchiveError("Invalid CAB archive: CFFILE range is too large");
		if (end > descriptions[folderIndex]!.requiredSize) descriptions[folderIndex]!.requiredSize = end;
		const path = normalizeArchiveEntryPath(rawName);
		if (!path) continue;
		const isDirectory = (attributes & ATTRIBUTE_DIRECTORY) !== 0;
		entries.push({
			path,
			isDirectory,
			size,
			mtimeMs: dosTimestamp(date, time),
			mode: modeFromAttributes(attributes, isDirectory),
			storage: isDirectory
				? undefined
				: { type: "member", source: new CabMemberSource(folders[folderIndex]!, folderOffset, size) },
		});
	}
	for (const description of descriptions) assertInMemorySize(description.requiredSize, options.limits);
	return entries;
}

/** Probe a byte prefix for the Microsoft Cabinet `MSCF` signature. */
export function sniffCab(bytes: Uint8Array): boolean {
	return hasSignature(bytes);
}

/** Index a Microsoft Cabinet archive and defer folder decompression until a member is read. */
export const readCab: FormatReader = async (source, options) => {
	try {
		return await readCabArchive(source, options);
	} catch (error) {
		if (error instanceof ArchiveError) throw error;
		throw new ArchiveError(`Invalid CAB archive: ${error instanceof Error ? error.message : String(error)}`);
	}
};
