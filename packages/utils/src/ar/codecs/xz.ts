import { crc32, crc64 } from "../checksums";
import { ArchiveError } from "../error";
import { lzma2Decompress } from "./lzma";

const XZ_MAGIC = Uint8Array.of(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00);

function read32LE(bytes: Uint8Array, offset: number): number {
	if (offset < 0 || offset + 4 > bytes.byteLength) throw new ArchiveError("Invalid XZ stream: truncated integer");
	return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

function write32LE(bytes: Uint8Array, offset: number, value: number): void {
	bytes[offset] = value & 0xff;
	bytes[offset + 1] = (value >>> 8) & 0xff;
	bytes[offset + 2] = (value >>> 16) & 0xff;
	bytes[offset + 3] = value >>> 24;
}

function read32BE(bytes: Uint8Array, offset: number): number {
	return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
}

function write32BE(bytes: Uint8Array, offset: number, value: number): void {
	bytes[offset] = value >>> 24;
	bytes[offset + 1] = (value >>> 16) & 0xff;
	bytes[offset + 2] = (value >>> 8) & 0xff;
	bytes[offset + 3] = value & 0xff;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) return false;
	for (let index = 0; index < left.byteLength; index++) if (left[index] !== right[index]) return false;
	return true;
}

interface Cursor {
	bytes: Uint8Array;
	pos: number;
	limit: number;
}

function readVarInt(cursor: Cursor): number {
	let value = 0;
	for (let index = 0; index < 9; index++) {
		if (cursor.pos >= cursor.limit) throw new ArchiveError("Invalid XZ stream: truncated variable-length integer");
		const byte = cursor.bytes[cursor.pos++]!;
		if (index > 0 && byte === 0) throw new ArchiveError("Invalid XZ stream: non-canonical variable-length integer");
		value += (byte & 0x7f) * 2 ** (index * 7);
		if (!Number.isSafeInteger(value)) throw new ArchiveError("XZ stream uses sizes too large to read safely");
		if ((byte & 0x80) === 0) return value;
	}
	throw new ArchiveError("Invalid XZ stream: variable-length integer is too long");
}

interface XzRecord {
	unpaddedSize: number;
	uncompressedSize: number;
}

interface XzStream {
	start: number;
	indexStart: number;
	footerStart: number;
	checkId: number;
	records: XzRecord[];
}

function checkSize(checkId: number): number {
	switch (checkId) {
		case 0:
			return 0;
		case 1:
			return 4;
		case 4:
			return 8;
		case 10:
			return 32;
		default:
			throw new ArchiveError(`Unsupported XZ integrity check ID 0x${checkId.toString(16)}`);
	}
}

function parseIndex(bytes: Uint8Array, start: number, size: number): XzRecord[] {
	if (size < 8 || start < 0 || start + size > bytes.byteLength)
		throw new ArchiveError("Invalid XZ stream: index range is invalid");
	const end = start + size;
	if (bytes[start] !== 0) throw new ArchiveError("Invalid XZ stream: missing index indicator");
	if (crc32(bytes.subarray(start, end - 4)) !== read32LE(bytes, end - 4))
		throw new ArchiveError("Invalid XZ stream: index CRC32 mismatch");
	const cursor: Cursor = { bytes, pos: start + 1, limit: end - 4 };
	const count = readVarInt(cursor);
	if (count > Math.floor(size / 2)) throw new ArchiveError("Invalid XZ stream: impossible index record count");
	const records: XzRecord[] = [];
	for (let index = 0; index < count; index++) {
		const unpaddedSize = readVarInt(cursor);
		const uncompressedSize = readVarInt(cursor);
		if (unpaddedSize === 0) throw new ArchiveError("Invalid XZ stream: zero unpadded block size");
		records.push({ unpaddedSize, uncompressedSize });
	}
	while (cursor.pos < cursor.limit)
		if (bytes[cursor.pos++] !== 0) throw new ArchiveError("Invalid XZ stream: non-zero index padding");
	return records;
}

function discoverStreams(bytes: Uint8Array): XzStream[] {
	if (bytes.byteLength === 0 || (bytes.byteLength & 3) !== 0)
		throw new ArchiveError("Invalid XZ stream: size is not a multiple of four bytes");
	const streams: XzStream[] = [];
	let end = bytes.byteLength;
	while (end > 0) {
		let padding = 0;
		while (end >= 4 && bytes[end - 1] === 0 && bytes[end - 2] === 0 && bytes[end - 3] === 0 && bytes[end - 4] === 0) {
			end -= 4;
			padding += 4;
		}
		if (end === 0) throw new ArchiveError("Invalid XZ stream: padding without a stream");
		if (end < 24) throw new ArchiveError("Invalid XZ stream: truncated stream framing");
		const footerStart = end - 12;
		if (bytes[footerStart + 10] !== 0x59 || bytes[footerStart + 11] !== 0x5a)
			throw new ArchiveError("Invalid XZ stream: footer magic mismatch");
		if (crc32(bytes.subarray(footerStart + 4, footerStart + 10)) !== read32LE(bytes, footerStart))
			throw new ArchiveError("Invalid XZ stream: footer CRC32 mismatch");
		const flag0 = bytes[footerStart + 8]!;
		const flag1 = bytes[footerStart + 9]!;
		if (flag0 !== 0 || (flag1 & 0xf0) !== 0) throw new ArchiveError("Unsupported XZ stream flags");
		const checkId = flag1 & 0x0f;
		checkSize(checkId);
		const indexSize = (read32LE(bytes, footerStart + 4) + 1) * 4;
		if (!Number.isSafeInteger(indexSize) || indexSize > footerStart)
			throw new ArchiveError("Invalid XZ stream: backward index size is invalid");
		const indexStart = footerStart - indexSize;
		const records = parseIndex(bytes, indexStart, indexSize);
		let blocksSize = 0;
		for (const record of records) {
			blocksSize += Math.ceil(record.unpaddedSize / 4) * 4;
			if (!Number.isSafeInteger(blocksSize)) throw new ArchiveError("XZ stream uses sizes too large to read safely");
		}
		const start = indexStart - blocksSize - 12;
		if (start < 0 || start + 12 > bytes.byteLength || !equalBytes(bytes.subarray(start, start + 6), XZ_MAGIC)) {
			throw new ArchiveError("Invalid XZ stream: header position or magic is invalid");
		}
		if (bytes[start + 6] !== flag0 || bytes[start + 7] !== flag1)
			throw new ArchiveError("Invalid XZ stream: header and footer flags differ");
		if (crc32(bytes.subarray(start + 6, start + 8)) !== read32LE(bytes, start + 8))
			throw new ArchiveError("Invalid XZ stream: header CRC32 mismatch");
		streams.unshift({ start, indexStart, footerStart, checkId, records });
		end = start;
		void padding;
	}
	return streams;
}

interface XzFilter {
	id: number;
	properties: Uint8Array;
}

function deltaDecode(bytes: Uint8Array, distance: number): void {
	const history = new Uint8Array(256);
	let position = 0;
	for (let index = 0; index < bytes.byteLength; index++) {
		const value = (bytes[index]! + history[(distance + position) & 0xff]!) & 0xff;
		history[position] = value;
		bytes[index] = value;
		position = (position - 1) & 0xff;
	}
}

function x86Decode(bytes: Uint8Array, startOffset: number): void {
	const maskToBitNumber = [0, 1, 2, 2, 3] as const;
	let previousMask = 0;
	let previousPosition = 0xfffffffb;
	if (bytes.byteLength < 5) return;
	let position = 0;
	const limit = bytes.byteLength - 5;
	while (position <= limit) {
		let byte = bytes[position]!;
		if (byte !== 0xe8 && byte !== 0xe9) {
			position++;
			continue;
		}
		const absolutePosition = (startOffset + position) >>> 0;
		const offset = (absolutePosition - previousPosition) >>> 0;
		previousPosition = absolutePosition;
		if (offset > 5) previousMask = 0;
		else for (let index = 0; index < offset; index++) previousMask = ((previousMask & 0x77) << 1) >>> 0;
		byte = bytes[position + 4]!;
		if ((byte === 0 || byte === 0xff) && previousMask >>> 1 <= 4 && previousMask >>> 1 !== 3) {
			let source = read32LE(bytes, position + 1);
			let destination = 0;
			for (;;) {
				destination = (source - absolutePosition - 5) >>> 0;
				if (previousMask === 0) break;
				const bitIndex = maskToBitNumber[previousMask >>> 1]! * 8;
				const testByte = (destination >>> (24 - bitIndex)) & 0xff;
				if (testByte !== 0 && testByte !== 0xff) break;
				const lowMask = bitIndex === 0 ? 0xffffffff : 2 ** (32 - bitIndex) - 1;
				source = (destination ^ lowMask) >>> 0;
			}
			bytes[position + 4] = ~(((destination >>> 24) & 1) - 1) & 0xff;
			bytes[position + 3] = destination >>> 16;
			bytes[position + 2] = destination >>> 8;
			bytes[position + 1] = destination;
			position += 5;
			previousMask = 0;
		} else {
			position++;
			previousMask |= 1;
			if (byte === 0 || byte === 0xff) previousMask |= 0x10;
		}
	}
}

function powerPcDecode(bytes: Uint8Array, startOffset: number): void {
	for (let index = 0; index + 4 <= bytes.byteLength; index += 4) {
		if (bytes[index]! >>> 2 !== 0x12 || (bytes[index + 3]! & 3) !== 1) continue;
		const source =
			(((bytes[index]! & 3) << 24) |
				(bytes[index + 1]! << 16) |
				(bytes[index + 2]! << 8) |
				(bytes[index + 3]! & 0xfc)) >>>
			0;
		const destination = (source - startOffset - index) >>> 0;
		bytes[index] = 0x48 | ((destination >>> 24) & 3);
		bytes[index + 1] = destination >>> 16;
		bytes[index + 2] = destination >>> 8;
		bytes[index + 3] = (bytes[index + 3]! & 3) | (destination & 0xfc);
	}
}

function armDecode(bytes: Uint8Array, startOffset: number): void {
	for (let index = 0; index + 4 <= bytes.byteLength; index += 4) {
		if (bytes[index + 3] !== 0xeb) continue;
		const source = ((bytes[index + 2]! << 18) | (bytes[index + 1]! << 10) | (bytes[index]! << 2)) >>> 0;
		const destination = (source - startOffset - index - 8) >>> 2;
		bytes[index] = destination;
		bytes[index + 1] = destination >>> 8;
		bytes[index + 2] = destination >>> 16;
	}
}

function armThumbDecode(bytes: Uint8Array, startOffset: number): void {
	for (let index = 0; index + 4 <= bytes.byteLength; index += 2) {
		if ((bytes[index + 1]! & 0xf8) !== 0xf0 || (bytes[index + 3]! & 0xf8) !== 0xf8) continue;
		const source =
			((((bytes[index + 1]! & 7) << 19) |
				(bytes[index]! << 11) |
				((bytes[index + 3]! & 7) << 8) |
				bytes[index + 2]!) <<
				1) >>>
			0;
		const destination = (source - startOffset - index - 4) >>> 1;
		bytes[index + 1] = 0xf0 | ((destination >>> 19) & 7);
		bytes[index] = destination >>> 11;
		bytes[index + 3] = 0xf8 | ((destination >>> 8) & 7);
		bytes[index + 2] = destination;
		index += 2;
	}
}

function sparcDecode(bytes: Uint8Array, startOffset: number): void {
	for (let index = 0; index + 4 <= bytes.byteLength; index += 4) {
		if (
			!(
				(bytes[index] === 0x40 && (bytes[index + 1]! & 0xc0) === 0) ||
				(bytes[index] === 0x7f && (bytes[index + 1]! & 0xc0) === 0xc0)
			)
		)
			continue;
		const source = (read32BE(bytes, index) << 2) >>> 0;
		let destination = (source - startOffset - index) >>> 2;
		destination = (((0 - ((destination >>> 22) & 1)) << 22) & 0x3fffffff) | (destination & 0x3fffff) | 0x40000000;
		write32BE(bytes, index, destination >>> 0);
	}
}

function ia64Decode(bytes: Uint8Array, startOffset: number): void {
	const branchTable = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 4, 6, 6, 0, 0, 7, 7, 4, 4, 0, 0, 4, 4, 0, 0];
	for (let index = 0; index + 16 <= bytes.byteLength; index += 16) {
		const mask = branchTable[bytes[index]! & 0x1f]!;
		let bitPosition = 5;
		for (let slot = 0; slot < 3; slot++, bitPosition += 41) {
			if (((mask >>> slot) & 1) === 0) continue;
			const bytePosition = bitPosition >>> 3;
			const bitOffset = bitPosition & 7;
			let instruction = 0n;
			for (let byte = 0; byte < 6; byte++)
				instruction |= BigInt(bytes[index + bytePosition + byte]!) << BigInt(byte * 8);
			let normalized = instruction >> BigInt(bitOffset);
			if (((normalized >> 37n) & 15n) !== 5n || ((normalized >> 9n) & 7n) !== 0n) continue;
			let source = Number((normalized >> 13n) & 0xfffffn) | (Number((normalized >> 36n) & 1n) << 20);
			source = (source << 4) >>> 0;
			const destination = ((source - startOffset - index) >>> 4) >>> 0;
			normalized &= ~(0x8fffffn << 13n);
			normalized |= BigInt(destination & 0xfffff) << 13n;
			normalized |= BigInt(destination & 0x100000) << 16n;
			instruction &= (1n << BigInt(bitOffset)) - 1n;
			instruction |= normalized << BigInt(bitOffset);
			for (let byte = 0; byte < 6; byte++)
				bytes[index + bytePosition + byte] = Number(instruction >> BigInt(byte * 8)) & 0xff;
		}
	}
}

function arm64Decode(bytes: Uint8Array, startOffset: number): void {
	for (let index = 0; index + 4 <= bytes.byteLength; index += 4) {
		const pc = (startOffset + index) >>> 0;
		let instruction = read32LE(bytes, index);
		if (instruction >>> 26 === 0x25) {
			instruction = (0x94000000 | ((instruction - (pc >>> 2)) & 0x03ffffff)) >>> 0;
			write32LE(bytes, index, instruction);
		} else if ((instruction & 0x9f000000) === 0x90000000) {
			const source = ((instruction >>> 29) & 3) | ((instruction >>> 3) & 0x001ffffc);
			if (((source + 0x20000) & 0x1c0000) !== 0) continue;
			const destination = (source - (pc >>> 12)) >>> 0;
			instruction &= 0x9000001f;
			instruction |= (destination & 3) << 29;
			instruction |= (destination & 0x3fffc) << 3;
			instruction |= (0 - (destination & 0x20000)) & 0xe00000;
			write32LE(bytes, index, instruction >>> 0);
		}
	}
}

function riscvDecode(bytes: Uint8Array, startOffset: number): void {
	if (bytes.byteLength < 8) return;
	for (let index = 0; index <= bytes.byteLength - 8; index += 2) {
		let instruction = bytes[index]!;
		if (instruction === 0xef) {
			const byte1 = bytes[index + 1]!;
			if ((byte1 & 0x0d) !== 0) continue;
			const address =
				((((byte1 & 0xf0) << 13) | (bytes[index + 2]! << 9) | (bytes[index + 3]! << 1)) - startOffset - index) >>>
				0;
			bytes[index + 1] = (byte1 & 0x0f) | ((address >>> 8) & 0xf0);
			bytes[index + 2] = ((address >>> 16) & 0x0f) | ((address >>> 7) & 0x10) | ((address << 4) & 0xe0);
			bytes[index + 3] = ((address >>> 4) & 0x7f) | ((address >>> 13) & 0x80);
			index += 2;
			continue;
		}
		if ((instruction & 0x7f) !== 0x17) continue;
		instruction = read32LE(bytes, index);
		let instruction2: number;
		if ((instruction & 0xe80) !== 0) {
			instruction2 = read32LE(bytes, index + 4);
			if (((instruction << 8) ^ ((instruction2 - 3) & 0xf8003)) !== 0) {
				index += 4;
				continue;
			}
			const address = (instruction & 0xfffff000) + (instruction2 >>> 20);
			instruction = (0x17 | (2 << 7) | (instruction2 << 12)) >>> 0;
			instruction2 = address >>> 0;
		} else {
			const register = instruction >>> 27;
			if (((instruction - 0x3117) << 18) >>> 0 >= (register & 0x1d)) {
				index += 2;
				continue;
			}
			const address = (read32BE(bytes, index + 4) - startOffset - index) >>> 0;
			instruction2 = ((instruction >>> 12) | (address << 20)) >>> 0;
			instruction = (0x17 | (register << 7) | ((address + 0x800) & 0xfffff000)) >>> 0;
		}
		write32LE(bytes, index, instruction);
		write32LE(bytes, index + 4, instruction2);
		index += 6;
	}
}

function applyFilter(bytes: Uint8Array, filter: XzFilter): void {
	if (filter.id === 3) {
		if (filter.properties.byteLength !== 1) throw new ArchiveError("Invalid XZ Delta filter properties");
		deltaDecode(bytes, filter.properties[0]! + 1);
		return;
	}
	if (filter.properties.byteLength !== 0 && filter.properties.byteLength !== 4)
		throw new ArchiveError(`Invalid XZ BCJ filter 0x${filter.id.toString(16)} properties`);
	const startOffset = filter.properties.byteLength === 4 ? read32LE(filter.properties, 0) : 0;
	const alignment = filter.id === 6 ? 16 : filter.id === 8 || filter.id === 11 ? 2 : filter.id === 4 ? 1 : 4;
	if ((startOffset & (alignment - 1)) !== 0)
		throw new ArchiveError(`Invalid XZ BCJ filter 0x${filter.id.toString(16)} start offset`);
	switch (filter.id) {
		case 4:
			x86Decode(bytes, startOffset);
			break;
		case 5:
			powerPcDecode(bytes, startOffset);
			break;
		case 6:
			ia64Decode(bytes, startOffset);
			break;
		case 7:
			armDecode(bytes, startOffset);
			break;
		case 8:
			armThumbDecode(bytes, startOffset);
			break;
		case 9:
			sparcDecode(bytes, startOffset);
			break;
		case 10:
			arm64Decode(bytes, startOffset);
			break;
		case 11:
			riscvDecode(bytes, startOffset);
			break;
		default:
			throw new ArchiveError(`Unsupported XZ filter ID 0x${filter.id.toString(16)}`);
	}
}

function verifyCheck(checkId: number, output: Uint8Array, expected: Uint8Array): void {
	if (checkId === 0) return;
	if (checkId === 1) {
		if (read32LE(expected, 0) !== crc32(output)) throw new ArchiveError("Invalid XZ stream: block CRC32 mismatch");
		return;
	}
	if (checkId === 4) {
		const actual = crc64(output);
		let stored = 0n;
		for (let index = 0; index < 8; index++) stored |= BigInt(expected[index]!) << BigInt(index * 8);
		if (actual !== stored) throw new ArchiveError("Invalid XZ stream: block CRC64 mismatch");
		return;
	}
	const actual = new Uint8Array(new Bun.CryptoHasher("sha256").update(output).digest());
	if (!equalBytes(actual, expected)) throw new ArchiveError("Invalid XZ stream: block SHA-256 mismatch");
}

async function decodeBlock(bytes: Uint8Array, offset: number, record: XzRecord, checkId: number): Promise<Uint8Array> {
	if (offset >= bytes.byteLength || bytes[offset] === 0)
		throw new ArchiveError("Invalid XZ stream: missing block header");
	const headerSize = (bytes[offset]! + 1) * 4;
	if (offset + headerSize > bytes.byteLength || headerSize < 8)
		throw new ArchiveError("Invalid XZ stream: truncated block header");
	if (crc32(bytes.subarray(offset, offset + headerSize - 4)) !== read32LE(bytes, offset + headerSize - 4))
		throw new ArchiveError("Invalid XZ stream: block header CRC32 mismatch");
	const cursor: Cursor = { bytes, pos: offset + 1, limit: offset + headerSize - 4 };
	const flags = bytes[cursor.pos++]!;
	if ((flags & 0x3c) !== 0) throw new ArchiveError("Unsupported XZ block flags");
	const filterCount = (flags & 3) + 1;
	const declaredCompressed = (flags & 0x40) !== 0 ? readVarInt(cursor) : undefined;
	const declaredUncompressed = (flags & 0x80) !== 0 ? readVarInt(cursor) : undefined;
	const filters: XzFilter[] = [];
	for (let index = 0; index < filterCount; index++) {
		const id = readVarInt(cursor);
		const propertySize = readVarInt(cursor);
		if (propertySize > cursor.limit - cursor.pos)
			throw new ArchiveError("Invalid XZ stream: truncated filter properties");
		filters.push({ id, properties: bytes.slice(cursor.pos, cursor.pos + propertySize) });
		cursor.pos += propertySize;
	}
	while (cursor.pos < cursor.limit)
		if (bytes[cursor.pos++] !== 0) throw new ArchiveError("Invalid XZ stream: non-zero block header padding");
	const integritySize = checkSize(checkId);
	const compressedSize = record.unpaddedSize - headerSize - integritySize;
	if (!Number.isSafeInteger(compressedSize) || compressedSize <= 0)
		throw new ArchiveError("Invalid XZ stream: compressed block size is invalid");
	if (declaredCompressed !== undefined && declaredCompressed !== compressedSize)
		throw new ArchiveError("Invalid XZ stream: block compressed size mismatch");
	if (declaredUncompressed !== undefined && declaredUncompressed !== record.uncompressedSize)
		throw new ArchiveError("Invalid XZ stream: block uncompressed size mismatch");
	const compressedStart = offset + headerSize;
	const compressedEnd = compressedStart + compressedSize;
	const paddingSize = (4 - ((headerSize + compressedSize) & 3)) & 3;
	const checkStart = compressedEnd + paddingSize;
	if (checkStart + integritySize > bytes.byteLength) throw new ArchiveError("Invalid XZ stream: truncated block data");
	const last = filters[filters.length - 1]!;
	if (last.id !== 0x21 || last.properties.byteLength !== 1)
		throw new ArchiveError(`Unsupported XZ terminal filter ID 0x${last.id.toString(16)} (LZMA2 required)`);
	let output = await lzma2Decompress(
		last.properties[0]!,
		bytes.subarray(compressedStart, compressedEnd),
		record.uncompressedSize,
	);
	if (output.byteLength !== record.uncompressedSize)
		throw new ArchiveError("Invalid XZ stream: decoded block size mismatch");
	output = output.slice();
	for (let index = filters.length - 2; index >= 0; index--) applyFilter(output, filters[index]!);
	for (let index = compressedEnd; index < checkStart; index++)
		if (bytes[index] !== 0) throw new ArchiveError("Invalid XZ stream: non-zero block padding");
	verifyCheck(checkId, output, bytes.subarray(checkStart, checkStart + integritySize));
	const paddedEnd = offset + Math.ceil(record.unpaddedSize / 4) * 4;
	if (checkStart + integritySize !== paddedEnd)
		throw new ArchiveError("Invalid XZ stream: block size does not match its index record");
	return output;
}

/** Whether bytes begin with the XZ stream-header magic. */
export function isXz(bytes: Uint8Array): boolean {
	return bytes.byteLength >= XZ_MAGIC.byteLength && equalBytes(bytes.subarray(0, XZ_MAGIC.byteLength), XZ_MAGIC);
}

/** Decompress all concatenated streams in an XZ container within `maxOutput`. */
export async function xzDecompress(bytes: Uint8Array, maxOutput: number): Promise<Uint8Array> {
	if (!Number.isSafeInteger(maxOutput) || maxOutput < 0) throw new ArchiveError("Invalid XZ output limit");
	try {
		const streams = discoverStreams(bytes);
		let totalSize = 0;
		for (const stream of streams)
			for (const record of stream.records) {
				totalSize += record.uncompressedSize;
				if (!Number.isSafeInteger(totalSize) || totalSize > maxOutput)
					throw new ArchiveError("XZ output exceeds its size limit");
			}
		const output = new Uint8Array(totalSize);
		let outputPosition = 0;
		for (const stream of streams) {
			let blockPosition = stream.start + 12;
			for (const record of stream.records) {
				const block = await decodeBlock(bytes, blockPosition, record, stream.checkId);
				output.set(block, outputPosition);
				outputPosition += block.byteLength;
				blockPosition += Math.ceil(record.unpaddedSize / 4) * 4;
			}
			if (blockPosition !== stream.indexStart)
				throw new ArchiveError("Invalid XZ stream: blocks do not align with index");
		}
		return output;
	} catch (error) {
		if (error instanceof ArchiveError) throw error;
		throw new ArchiveError(`Invalid XZ stream: ${error instanceof Error ? error.message : String(error)}`);
	}
}
