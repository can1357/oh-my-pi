import { crc32 } from "./checksums";
import { ArchiveError } from "./error";
import { assertArchiveMemberSize, assertEntryCount, assertIndexSize, assertInMemorySize } from "./limits";
import { decompressLhStatic } from "./lzh";
import { assertArchivePathBytes, assertArchivePathString, normalizeArchiveEntryPath } from "./paths";
import { type ByteSource, readAllBytes } from "./source";
import type { ArchiveIndexEntry, FormatReader, FormatReadOptions, MemberSource } from "./types";

const ARJ_SIGNATURE_0 = 0x60;
const ARJ_SIGNATURE_1 = 0xea;
const ARJ_MAX_BASIC_HEADER = 2600;
const LEGACY_DECODER = new TextDecoder("windows-1252");

function u16(bytes: Uint8Array, offset: number): number {
	return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function u32(bytes: Uint8Array, offset: number): number {
	return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

function assertRange(bytes: Uint8Array, start: number, end: number, what: string): void {
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(end) ||
		start < 0 ||
		end < start ||
		end > bytes.byteLength
	) {
		throw new ArchiveError(`Invalid ARJ archive: truncated ${what}`);
	}
}

function dosTimeToMs(value: number): number | undefined {
	if (value === 0) return undefined;
	const year = 1980 + ((value >>> 25) & 0x7f);
	const month = (value >>> 21) & 0x0f;
	const day = (value >>> 16) & 0x1f;
	const hour = (value >>> 11) & 0x1f;
	const minute = (value >>> 5) & 0x3f;
	const second = (value & 0x1f) * 2;
	if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return undefined;
	return Date.UTC(year, month - 1, day, hour, minute, second);
}

function readCString(bytes: Uint8Array, start: number, end: number, field: string): { value: string; next: number } {
	let terminator = start;
	while (terminator < end && bytes[terminator] !== 0) terminator++;
	if (terminator === end) throw new ArchiveError(`Invalid ARJ ${field}: missing terminator`);
	return { value: LEGACY_DECODER.decode(bytes.subarray(start, terminator)), next: terminator + 1 };
}

interface ArjBlock {
	bodyStart: number;
	bodySize: number;
	nextOffset: number;
	metadataSize: number;
	isEnd: boolean;
}

function parseArjBlock(bytes: Uint8Array, offset: number, options: FormatReadOptions): ArjBlock {
	assertRange(bytes, offset, offset + 4, "header signature");
	if (bytes[offset] !== ARJ_SIGNATURE_0 || bytes[offset + 1] !== ARJ_SIGNATURE_1) {
		throw new ArchiveError("Invalid ARJ header signature");
	}
	const bodySize = u16(bytes, offset + 2);
	if (bodySize === 0)
		return { bodyStart: offset + 4, bodySize: 0, nextOffset: offset + 4, metadataSize: 4, isEnd: true };
	if (bodySize < 30 || bodySize > ARJ_MAX_BASIC_HEADER) throw new ArchiveError("Invalid ARJ basic header size");
	const bodyStart = offset + 4;
	const bodyEnd = bodyStart + bodySize;
	assertRange(bytes, bodyStart, bodyEnd + 4, "basic header");
	if (crc32(bytes.subarray(bodyStart, bodyEnd)) !== u32(bytes, bodyEnd)) {
		throw new ArchiveError("Invalid ARJ basic header CRC32");
	}
	let cursor = bodyEnd + 4;
	let extensionCount = 0;
	for (;;) {
		assertRange(bytes, cursor, cursor + 2, "extended header size");
		const extensionSize = u16(bytes, cursor);
		cursor += 2;
		if (extensionSize === 0) break;
		if (++extensionCount > 65_535) throw new ArchiveError("Invalid ARJ archive: too many extended headers");
		assertRange(bytes, cursor, cursor + extensionSize + 4, "extended header");
		if (crc32(bytes.subarray(cursor, cursor + extensionSize)) !== u32(bytes, cursor + extensionSize)) {
			throw new ArchiveError("Invalid ARJ extended header CRC32");
		}
		cursor += extensionSize + 4;
		assertIndexSize(cursor - offset, options.limits, "header metadata");
	}
	return { bodyStart, bodySize, nextOffset: cursor, metadataSize: cursor - offset, isEnd: false };
}

class ArjBitReader {
	readonly #bytes: Uint8Array;
	#position = 0;

	constructor(bytes: Uint8Array) {
		this.#bytes = bytes;
	}

	read(count: number): number {
		if (!Number.isInteger(count) || count < 0 || count > 24 || this.#position + count > this.#bytes.byteLength * 8) {
			throw new ArchiveError("Invalid ARJ method-4 compressed data: truncated bitstream");
		}
		let value = 0;
		for (let index = 0; index < count; index++) {
			const position = this.#position++;
			value = value * 2 + ((this.#bytes[position >>> 3]! >>> (7 - (position & 7))) & 1);
		}
		return value;
	}

	assertZeroPadding(): void {
		while (this.#position < this.#bytes.byteLength * 8) {
			if (this.read(1) !== 0) throw new ArchiveError("Invalid ARJ method-4 compressed data: non-zero trailing bits");
		}
	}
}

function decompressArjMethod4(packed: Uint8Array, outSize: number): Uint8Array {
	const reader = new ArjBitReader(packed);
	const output = new Uint8Array(outSize);
	let outputPosition = 0;
	while (outputPosition < outSize) {
		let lengthCode = 0;
		let lengthWidth = 0;
		for (; lengthWidth < 7; lengthWidth++) {
			if (reader.read(1) === 0) break;
			lengthCode += 2 ** lengthWidth;
		}
		if (lengthWidth !== 0) lengthCode += reader.read(lengthWidth);
		if (lengthCode === 0) {
			output[outputPosition++] = reader.read(8);
			continue;
		}
		const length = lengthCode + 2;
		if (length > outSize - outputPosition) {
			throw new ArchiveError("Invalid ARJ method-4 compressed data: match exceeds declared size");
		}
		let positionCode = 0;
		let positionWidth = 9;
		for (; positionWidth < 13; positionWidth++) {
			if (reader.read(1) === 0) break;
			positionCode += 2 ** positionWidth;
		}
		positionCode += reader.read(positionWidth);
		if (positionCode >= 26_624 || positionCode >= outputPosition) {
			throw new ArchiveError("Invalid ARJ method-4 compressed data: history distance is out of range");
		}
		let sourcePosition = outputPosition - positionCode - 1;
		for (let index = 0; index < length; index++) output[outputPosition++] = output[sourcePosition++]!;
	}
	reader.assertZeroPadding();
	return output;
}

class ArjMemberSource implements MemberSource {
	readonly #archive: Uint8Array;
	readonly #start: number;
	readonly #packedSize: number;
	readonly #method: number;
	readonly #crc: number;

	constructor(archive: Uint8Array, start: number, packedSize: number, method: number, crc: number) {
		this.#archive = archive;
		this.#start = start;
		this.#packedSize = packedSize;
		this.#method = method;
		this.#crc = crc;
	}

	async read(size: number, memberPath: string): Promise<Uint8Array> {
		const packed = this.#archive.subarray(this.#start, this.#start + this.#packedSize);
		let output: Uint8Array;
		switch (this.#method) {
			case 0:
				if (packed.byteLength !== size)
					throw new ArchiveError(`ARJ member '${memberPath}' has inconsistent stored size`);
				output = packed.slice();
				break;
			case 1:
			case 2:
			case 3:
				output = decompressLhStatic(packed, size, 26_624, 5, 17, `ARJ method ${this.#method}`);
				break;
			case 4:
				output = decompressArjMethod4(packed, size);
				break;
			case 8:
			case 9:
				if (size !== 0 || packed.byteLength !== 0) {
					throw new ArchiveError(`ARJ member '${memberPath}' has invalid no-data method sizes`);
				}
				output = new Uint8Array(0);
				break;
			default:
				throw new ArchiveError(`ARJ member '${memberPath}' uses unsupported compression method ${this.#method}`);
		}
		if (output.byteLength !== size)
			throw new ArchiveError(`ARJ member '${memberPath}' extracted to an unexpected size`);
		if (this.#method !== 8 && crc32(output) !== this.#crc) {
			throw new ArchiveError(`ARJ member '${memberPath}' failed CRC32 verification`);
		}
		return output;
	}
}

function normalizeHostPath(rawPath: string, hostOs: number): string {
	let path = rawPath.replaceAll("\\", "/");
	if (hostOs === 1) path = path.replaceAll(">", "/");
	else if (hostOs === 4) path = path.replaceAll(":", "/");
	return path;
}

/** Probe whether bytes begin with a CRC-framed ARJ main header. */
export function sniffArj(bytes: Uint8Array): boolean {
	if (bytes.byteLength < 34 || bytes[0] !== ARJ_SIGNATURE_0 || bytes[1] !== ARJ_SIGNATURE_1) return false;
	const size = u16(bytes, 2);
	if (size < 30 || size > ARJ_MAX_BASIC_HEADER || bytes.byteLength < size + 8) return false;
	const body = bytes.subarray(4, 4 + size);
	return body[0]! >= 30 && body[0]! <= size && body[6] === 2 && crc32(body) === u32(bytes, 4 + size);
}

/** Index an ARJ archive and lazily decode stored, static-Huffman, and fast-LZSS members. */
export const readArj: FormatReader = async (
	source: ByteSource,
	options: FormatReadOptions,
): Promise<ArchiveIndexEntry[]> => {
	assertInMemorySize(source.size, options.limits);
	let bytes: Uint8Array;
	try {
		bytes = await readAllBytes(source);
	} catch (error) {
		if (error instanceof ArchiveError) throw error;
		throw new ArchiveError(`Unable to read ARJ archive: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (bytes.byteLength !== source.size) throw new ArchiveError("Invalid ARJ archive: truncated data");
	if (!sniffArj(bytes)) throw new ArchiveError("Invalid ARJ archive header");

	const main = parseArjBlock(bytes, 0, options);
	if (main.isEnd) throw new ArchiveError("Invalid ARJ archive: missing main header");
	const mainFirstHeaderSize = bytes[main.bodyStart]!;
	if (mainFirstHeaderSize < 30 || mainFirstHeaderSize > main.bodySize || bytes[main.bodyStart + 6] !== 2) {
		throw new ArchiveError("Invalid ARJ main header");
	}
	const mainFlags = bytes[main.bodyStart + 4]!;
	if ((mainFlags & 0x01) !== 0) throw new ArchiveError("Encrypted ARJ archives are unsupported");
	if ((mainFlags & 0x04) !== 0) throw new ArchiveError("Multi-volume ARJ archives are unsupported");

	const entries: ArchiveIndexEntry[] = [];
	let offset = main.nextOffset;
	let metadataSize = main.metadataSize;
	let parsedCount = 0;
	for (;;) {
		const block = parseArjBlock(bytes, offset, options);
		metadataSize += block.metadataSize;
		assertIndexSize(metadataSize, options.limits, "index");
		if (block.isEnd) break;
		assertEntryCount(++parsedCount, options.limits);
		const firstHeaderSize = bytes[block.bodyStart]!;
		if (firstHeaderSize < 30 || firstHeaderSize > block.bodySize) throw new ArchiveError("Invalid ARJ local header");
		const hostOs = bytes[block.bodyStart + 3]!;
		const flags = bytes[block.bodyStart + 4]!;
		const method = bytes[block.bodyStart + 5]!;
		const fileType = bytes[block.bodyStart + 6]!;
		if ((flags & 0x01) !== 0) throw new ArchiveError("Encrypted ARJ members are unsupported");
		if ((flags & 0x0c) !== 0) throw new ArchiveError("Multi-volume ARJ members are unsupported");
		const packedSize = u32(bytes, block.bodyStart + 12);
		const size = u32(bytes, block.bodyStart + 16);
		const fileCrc = u32(bytes, block.bodyStart + 20);
		const accessMode = u16(bytes, block.bodyStart + 26);
		const filename = readCString(
			bytes,
			block.bodyStart + firstHeaderSize,
			block.bodyStart + block.bodySize,
			"filename",
		);
		readCString(bytes, filename.next, block.bodyStart + block.bodySize, "comment");
		assertArchivePathBytes(
			filename.next - (block.bodyStart + firstHeaderSize) - 1,
			"member path",
			options.limits.maxPathBytes,
		);
		const rawPath = normalizeHostPath(filename.value, hostOs);
		assertArchivePathString(rawPath, "member path", options.limits.maxPathBytes);
		assertArchiveMemberSize(size, rawPath || "<unnamed>", options.limits);
		const dataStart = block.nextOffset;
		assertRange(bytes, dataStart, dataStart + packedSize, "member data");
		offset = dataStart + packedSize;
		const path = normalizeArchiveEntryPath(rawPath);
		if (!path) continue;
		const isDirectory = fileType === 3;
		let mode: number | undefined;
		if ((hostOs === 2 || hostOs === 8) && accessMode !== 0) {
			mode = (isDirectory ? 0x4000 : 0x8000) | (accessMode & 0x0fff);
		}
		const rawMtime = u32(bytes, block.bodyStart + 8);
		const mtimeMs =
			hostOs === 2 || hostOs === 8 ? (rawMtime === 0 ? undefined : rawMtime * 1000) : dosTimeToMs(rawMtime);
		entries.push({
			path,
			isDirectory,
			size: isDirectory ? 0 : size,
			mtimeMs,
			mode,
			storage: isDirectory
				? undefined
				: { type: "member", source: new ArjMemberSource(bytes, dataStart, packedSize, method, fileCrc) },
		});
	}
	if (parsedCount === 0) throw new ArchiveError("Invalid ARJ archive: no members");
	return entries;
};
