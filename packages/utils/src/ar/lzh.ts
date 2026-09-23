import { crc16Arc } from "./checksums";
import { ArchiveError } from "./error";
import { assertArchiveMemberSize, assertEntryCount, assertIndexSize, assertInMemorySize } from "./limits";
import { assertArchivePathBytes, assertArchivePathString, normalizeArchiveEntryPath } from "./paths";
import { type ByteSource, readAllBytes } from "./source";
import type { ArchiveIndexEntry, FormatReader, FormatReadOptions, MemberSource } from "./types";

const LEGACY_DECODER = new TextDecoder("windows-1252");
// WHATWG maps the "utf-16" label to the UTF-16LE decoder used by LZH name extensions.
const UTF16LE_DECODER = new TextDecoder("utf-16");
const LHA_METHOD_PATTERN = /^-(?:lh[0-7d]|lz[45s])-$/;

class MsbBitReader {
	readonly #bytes: Uint8Array;
	readonly #label: string;
	#position = 0;

	constructor(bytes: Uint8Array, label: string) {
		this.#bytes = bytes;
		this.#label = label;
	}

	read(count: number): number {
		if (!Number.isInteger(count) || count < 0 || count > 24 || this.#position + count > this.#bytes.byteLength * 8) {
			throw new ArchiveError(`Invalid ${this.#label} compressed data: truncated bitstream`);
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
			if (this.read(1) !== 0) {
				throw new ArchiveError(`Invalid ${this.#label} compressed data: non-zero trailing bits`);
			}
		}
	}
}

class CanonicalHuffman {
	readonly #zero: number[] = [-1];
	readonly #one: number[] = [-1];
	readonly #symbol: number[] = [-1];
	readonly #label: string;

	private constructor(label: string) {
		this.#label = label;
	}

	static single(symbol: number, symbolCount: number, label: string): CanonicalHuffman {
		if (!Number.isInteger(symbol) || symbol < 0 || symbol >= symbolCount) {
			throw new ArchiveError(`Invalid ${label} Huffman table: symbol is out of range`);
		}
		const tree = new CanonicalHuffman(label);
		tree.#symbol[0] = symbol;
		return tree;
	}

	static build(lengths: Uint8Array, symbolCount: number, label: string): CanonicalHuffman {
		const counts = new Uint32Array(17);
		let maximumLength = 0;
		for (let symbol = 0; symbol < symbolCount; symbol++) {
			const length = lengths[symbol]!;
			if (length > 16) throw new ArchiveError(`Invalid ${label} Huffman table: code is too long`);
			if (length !== 0) {
				counts[length]++;
				maximumLength = Math.max(maximumLength, length);
			}
		}
		if (maximumLength === 0) throw new ArchiveError(`Invalid ${label} Huffman table: no symbols`);

		const nextCodes = new Uint32Array(17);
		let code = 0;
		for (let length = 1; length <= 16; length++) {
			code = (code + counts[length - 1]!) * 2;
			if (code + counts[length]! > 2 ** length) {
				throw new ArchiveError(`Invalid ${label} Huffman table: oversubscribed codes`);
			}
			nextCodes[length] = code;
		}
		if (nextCodes[maximumLength]! + counts[maximumLength]! !== 2 ** maximumLength) {
			throw new ArchiveError(`Invalid ${label} Huffman table: incomplete codes`);
		}

		const tree = new CanonicalHuffman(label);
		for (let symbol = 0; symbol < symbolCount; symbol++) {
			const length = lengths[symbol]!;
			if (length === 0) continue;
			const symbolCode = nextCodes[length]!;
			nextCodes[length] = symbolCode + 1;
			let node = 0;
			for (let bitIndex = length - 1; bitIndex >= 0; bitIndex--) {
				if (tree.#symbol[node]! >= 0) {
					throw new ArchiveError(`Invalid ${label} Huffman table: prefix collision`);
				}
				const bit = (symbolCode >>> bitIndex) & 1;
				let child = bit === 0 ? tree.#zero[node]! : tree.#one[node]!;
				if (child < 0) {
					child = tree.#symbol.length;
					tree.#zero.push(-1);
					tree.#one.push(-1);
					tree.#symbol.push(-1);
					if (bit === 0) tree.#zero[node] = child;
					else tree.#one[node] = child;
				}
				node = child;
			}
			if (tree.#symbol[node]! >= 0 || tree.#zero[node]! >= 0 || tree.#one[node]! >= 0) {
				throw new ArchiveError(`Invalid ${label} Huffman table: duplicate code`);
			}
			tree.#symbol[node] = symbol;
		}
		return tree;
	}

	decode(reader: MsbBitReader): number {
		let node = 0;
		for (let depth = 0; depth <= 16; depth++) {
			const symbol = this.#symbol[node]!;
			if (symbol >= 0) return symbol;
			node = reader.read(1) === 0 ? this.#zero[node]! : this.#one[node]!;
			if (node < 0) throw new ArchiveError(`Invalid ${this.#label} Huffman code`);
		}
		throw new ArchiveError(`Invalid ${this.#label} Huffman code: excessive depth`);
	}
}

function readCodeLength(reader: MsbBitReader, label: string): number {
	let length = reader.read(3);
	if (length === 7) {
		while (reader.read(1) !== 0) {
			length++;
			if (length > 16) throw new ArchiveError(`Invalid ${label} Huffman table: code is too long`);
		}
	}
	return length;
}

function readTemporaryTree(reader: MsbBitReader, label: string): CanonicalHuffman {
	const symbolCount = 19;
	const encodedCount = reader.read(5);
	if (encodedCount === 0) return CanonicalHuffman.single(reader.read(5), symbolCount, label);
	if (encodedCount > symbolCount) throw new ArchiveError(`Invalid ${label} temporary Huffman table size`);
	const lengths = new Uint8Array(symbolCount);
	let index = 0;
	while (index < encodedCount) {
		lengths[index++] = readCodeLength(reader, label);
		if (index === 3) {
			const skipped = reader.read(2);
			if (index + skipped > encodedCount) throw new ArchiveError(`Invalid ${label} temporary Huffman table`);
			index += skipped;
		}
	}
	return CanonicalHuffman.build(lengths, symbolCount, label);
}

function readCommandTree(reader: MsbBitReader, temporary: CanonicalHuffman, label: string): CanonicalHuffman {
	const symbolCount = 510;
	const encodedCount = reader.read(9);
	if (encodedCount === 0) return CanonicalHuffman.single(reader.read(9), symbolCount, label);
	if (encodedCount > symbolCount) throw new ArchiveError(`Invalid ${label} command Huffman table size`);
	const lengths = new Uint8Array(symbolCount);
	let index = 0;
	while (index < encodedCount) {
		const code = temporary.decode(reader);
		if (code <= 2) {
			const skipped = code === 0 ? 1 : code === 1 ? reader.read(4) + 3 : reader.read(9) + 20;
			if (index + skipped > encodedCount) throw new ArchiveError(`Invalid ${label} command Huffman table`);
			index += skipped;
		} else {
			lengths[index++] = code - 2;
		}
	}
	return CanonicalHuffman.build(lengths, symbolCount, label);
}

function readPositionTree(
	reader: MsbBitReader,
	positionBits: number,
	symbolCount: number,
	label: string,
): CanonicalHuffman {
	const encodedCount = reader.read(positionBits);
	if (encodedCount === 0) return CanonicalHuffman.single(reader.read(positionBits), symbolCount, label);
	if (encodedCount > symbolCount) throw new ArchiveError(`Invalid ${label} position Huffman table size`);
	const lengths = new Uint8Array(symbolCount);
	for (let index = 0; index < encodedCount; index++) lengths[index] = readCodeLength(reader, label);
	return CanonicalHuffman.build(lengths, symbolCount, label);
}

/** @internal Decode the static-Huffman LZSS stream shared by LZH and ARJ methods 1-3. */
export function decompressLhStatic(
	packed: Uint8Array,
	outSize: number,
	dictionarySize: number,
	positionBits: number,
	positionSymbols: number,
	label: string,
): Uint8Array {
	const reader = new MsbBitReader(packed, label);
	const output = new Uint8Array(outSize);
	let outputPosition = 0;
	let blockRemaining = 0;
	let commands: CanonicalHuffman | undefined;
	let positions: CanonicalHuffman | undefined;
	while (outputPosition < outSize) {
		if (blockRemaining === 0) {
			blockRemaining = reader.read(16);
			if (blockRemaining === 0) throw new ArchiveError(`Invalid ${label} compressed data: empty block`);
			const temporary = readTemporaryTree(reader, label);
			commands = readCommandTree(reader, temporary, label);
			positions = readPositionTree(reader, positionBits, positionSymbols, label);
		}
		blockRemaining--;
		const symbol = commands!.decode(reader);
		if (symbol < 256) {
			output[outputPosition++] = symbol;
			continue;
		}
		const length = symbol - 256 + 3;
		if (length > outSize - outputPosition) {
			throw new ArchiveError(`Invalid ${label} compressed data: match exceeds declared size`);
		}
		const positionCode = positions!.decode(reader);
		let distance = positionCode;
		if (positionCode > 1) {
			const lowBitCount = positionCode - 1;
			distance = 2 ** lowBitCount + reader.read(lowBitCount);
		}
		if (distance >= dictionarySize || distance >= outputPosition) {
			throw new ArchiveError(`Invalid ${label} compressed data: history distance is out of range`);
		}
		let sourcePosition = outputPosition - distance - 1;
		for (let index = 0; index < length; index++) output[outputPosition++] = output[sourcePosition++]!;
	}
	if (blockRemaining !== 0) throw new ArchiveError(`Invalid ${label} compressed data: block exceeds declared size`);
	reader.assertZeroPadding();
	return output;
}

function decompressLzs(packed: Uint8Array, outSize: number): Uint8Array {
	const reader = new MsbBitReader(packed, "LZH -lzs-");
	const output = new Uint8Array(outSize);
	const history = new Uint8Array(2048);
	history.fill(0x20);
	let historyPosition = 2048 - 17;
	let outputPosition = 0;
	const emit = (value: number): void => {
		if (outputPosition >= outSize) throw new ArchiveError("Invalid LZH -lzs- data: output exceeds declared size");
		output[outputPosition++] = value;
		history[historyPosition] = value;
		historyPosition = (historyPosition + 1) & 2047;
	};
	while (outputPosition < outSize) {
		if (reader.read(1) !== 0) {
			emit(reader.read(8));
		} else {
			const position = reader.read(11);
			const length = reader.read(4) + 2;
			if (length > outSize - outputPosition)
				throw new ArchiveError("Invalid LZH -lzs- data: match exceeds declared size");
			for (let index = 0; index < length; index++) emit(history[(position + index) & 2047]!);
		}
	}
	reader.assertZeroPadding();
	return output;
}

const ZERO_CRC16_BYTES = new Uint8Array(2);

function crc16WithZeroRange(bytes: Uint8Array, zeroStart: number, zeroEnd: number): number {
	if (zeroStart < 0) return crc16Arc(bytes);
	let value = crc16Arc(bytes.subarray(0, zeroStart));
	value = crc16Arc(ZERO_CRC16_BYTES.subarray(0, zeroEnd - zeroStart), value);
	return crc16Arc(bytes.subarray(zeroEnd), value);
}

function u16(bytes: Uint8Array, offset: number): number {
	return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function u32(bytes: Uint8Array, offset: number): number {
	return (bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24)) >>> 0;
}

function u64(bytes: Uint8Array, offset: number): number {
	const value = u32(bytes, offset) + u32(bytes, offset + 4) * 0x100000000;
	if (!Number.isSafeInteger(value)) throw new ArchiveError("LZH uses sizes too large to read safely");
	return value;
}

function assertRange(bytes: Uint8Array, start: number, end: number, what: string): void {
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(end) ||
		start < 0 ||
		end < start ||
		end > bytes.byteLength
	) {
		throw new ArchiveError(`Invalid LZH archive: truncated ${what}`);
	}
}

function decodeLegacy(bytes: Uint8Array): string {
	let end = bytes.indexOf(0);
	if (end < 0) end = bytes.byteLength;
	return LEGACY_DECODER.decode(bytes.subarray(0, end));
}

function decodeUtf16(bytes: Uint8Array): string {
	if ((bytes.byteLength & 1) !== 0) throw new ArchiveError("Invalid LZH Unicode path header: odd UTF-16 length");
	let end = bytes.byteLength;
	while (end >= 2 && bytes[end - 1] === 0 && bytes[end - 2] === 0) end -= 2;
	return UTF16LE_DECODER.decode(bytes.subarray(0, end));
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

interface LzhExtendedFields {
	filename?: string;
	directory?: string;
	unicodeFilename?: string;
	unicodeDirectory?: string;
	mtimeMs?: number;
	mode?: number;
	packedSize?: number;
	size?: number;
	commonCrc?: number;
	commonCrcOffset?: number;
}

function processExtendedHeader(
	type: number,
	data: Uint8Array,
	absoluteDataOffset: number,
	fields: LzhExtendedFields,
): void {
	switch (type) {
		case 0x00:
			if (data.byteLength < 2) throw new ArchiveError("Invalid LZH common extended header");
			fields.commonCrc = u16(data, 0);
			fields.commonCrcOffset = absoluteDataOffset;
			break;
		case 0x01:
			fields.filename = decodeLegacy(data);
			break;
		case 0x02:
			fields.directory = decodeLegacy(data).replaceAll("ÿ", "/");
			break;
		case 0x39:
			throw new ArchiveError("Multi-volume LZH archives are unsupported");
		case 0x41:
			if (data.byteLength >= 16) {
				const low = u32(data, 8);
				const high = u32(data, 12);
				const filetime = low + high * 0x100000000;
				if (Number.isSafeInteger(filetime)) fields.mtimeMs = filetime / 10_000 - 11_644_473_600_000;
			}
			break;
		case 0x42:
			if (data.byteLength < 16) throw new ArchiveError("Invalid LZH 64-bit size extended header");
			fields.packedSize = u64(data, 0);
			fields.size = u64(data, 8);
			break;
		case 0x44:
			fields.unicodeFilename = decodeUtf16(data);
			break;
		case 0x45:
			fields.unicodeDirectory = decodeUtf16(data).replaceAll("ÿ", "/");
			break;
		case 0x50:
			if (data.byteLength < 2) throw new ArchiveError("Invalid LZH Unix permissions extended header");
			fields.mode = u16(data, 0);
			break;
		case 0x54:
			if (data.byteLength < 4) throw new ArchiveError("Invalid LZH Unix timestamp extended header");
			fields.mtimeMs = u32(data, 0) * 1000;
			break;
	}
}

class LzhMemberSource implements MemberSource {
	readonly #archive: Uint8Array;
	readonly #start: number;
	readonly #packedSize: number;
	readonly #method: string;
	readonly #crc: number;

	constructor(archive: Uint8Array, start: number, packedSize: number, method: string, crc: number) {
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
			case "-lh0-":
			case "-lz4-":
				if (packed.byteLength !== size)
					throw new ArchiveError(`LZH member '${memberPath}' has inconsistent stored size`);
				output = packed.slice();
				break;
			case "-lh4-":
				output = decompressLhStatic(packed, size, 1 << 12, 4, 13, "LZH -lh4-");
				break;
			case "-lh5-":
				output = decompressLhStatic(packed, size, 1 << 13, 4, 14, "LZH -lh5-");
				break;
			case "-lh6-":
				output = decompressLhStatic(packed, size, 1 << 15, 5, 16, "LZH -lh6-");
				break;
			case "-lh7-":
				output = decompressLhStatic(packed, size, 1 << 16, 5, 17, "LZH -lh7-");
				break;
			case "-lzs-":
				output = decompressLzs(packed, size);
				break;
			case "-lh1-":
				throw new ArchiveError(`LZH member '${memberPath}' uses unsupported dynamic-Huffman method -lh1-`);
			default:
				throw new ArchiveError(`LZH member '${memberPath}' uses unsupported compression method ${this.#method}`);
		}
		if (output.byteLength !== size)
			throw new ArchiveError(`LZH member '${memberPath}' extracted to an unexpected size`);
		if (crc16Arc(output) !== this.#crc)
			throw new ArchiveError(`LZH member '${memberPath}' failed CRC-16 verification`);
		return output;
	}
}

interface ParsedLzhHeader {
	method: string;
	packedSize: number;
	size: number;
	dataStart: number;
	nextOffset: number;
	crc: number;
	path?: string;
	mtimeMs?: number;
	mode?: number;
}

function parseLzhHeader(bytes: Uint8Array, offset: number, options: FormatReadOptions): ParsedLzhHeader {
	assertRange(bytes, offset, offset + 22, "header");
	const level = bytes[offset + 20]!;
	if (level > 2) throw new ArchiveError(`Unsupported LZH header level ${level}`);
	const method = String.fromCharCode(...bytes.subarray(offset + 2, offset + 7));
	if (!LHA_METHOD_PATTERN.test(method)) throw new ArchiveError(`Invalid LZH compression method '${method}'`);
	let packedSize = u32(bytes, offset + 7);
	let size = u32(bytes, offset + 11);
	let crc = 0;
	let legacyFilename: string | undefined;
	let mtimeMs: number | undefined;
	let osId = 0;
	let dataStart: number;
	const fields: LzhExtendedFields = {};

	if (level < 2) {
		const headerLength = bytes[offset]!;
		const minimum = level === 0 ? 22 : 25;
		if (headerLength < minimum) throw new ArchiveError(`Invalid LZH level-${level} header size`);
		const baseEnd = offset + headerLength + 2;
		assertRange(bytes, offset, baseEnd, "header");
		let sum = 0;
		for (let index = offset + 2; index < baseEnd; index++) sum = (sum + bytes[index]!) & 0xff;
		if (sum !== bytes[offset + 1]) throw new ArchiveError("Invalid LZH header checksum");
		const nameLength = bytes[offset + 21]!;
		if (22 + nameLength + 2 > headerLength + 2) throw new ArchiveError("Invalid LZH filename length");
		assertArchivePathBytes(nameLength, "member path", options.limits.maxPathBytes);
		legacyFilename = decodeLegacy(bytes.subarray(offset + 22, offset + 22 + nameLength));
		crc = u16(bytes, offset + 22 + nameLength);
		mtimeMs = dosTimeToMs(u32(bytes, offset + 15));
		if (level === 0) {
			const extendedStart = offset + 24 + nameLength;
			if (baseEnd - extendedStart >= 12) {
				const extended = bytes.subarray(extendedStart, baseEnd);
				if ((extended[0] === 0x55 || extended[0] === 0x4b) && extended[1] === 0) {
					osId = extended[0]!;
					fields.mtimeMs = u32(extended, 2) * 1000;
					fields.mode = u16(extended, extended.byteLength - 6);
				}
			}
			dataStart = baseEnd;
		} else {
			osId = bytes[offset + 24 + nameLength]!;
			let extensionSize = u16(bytes, baseEnd - 2);
			let cursor = baseEnd;
			let totalExtensionSize = 0;
			let extensionCount = 0;
			while (extensionSize !== 0) {
				if (extensionSize < 3) throw new ArchiveError("Invalid LZH extended header size");
				assertRange(bytes, cursor, cursor + extensionSize, "extended header");
				totalExtensionSize += extensionSize;
				assertIndexSize(headerLength + 2 + totalExtensionSize, options.limits, "header metadata");
				if (++extensionCount > 65_535) throw new ArchiveError("Invalid LZH archive: too many extended headers");
				const type = bytes[cursor]!;
				const dataEnd = cursor + extensionSize - 2;
				const data = bytes.subarray(cursor + 1, dataEnd);
				if (type === 0x01 || type === 0x02 || type === 0x44 || type === 0x45) {
					assertArchivePathBytes(data.byteLength, "member path", options.limits.maxPathBytes);
				}
				processExtendedHeader(type, data, cursor + 1, fields);
				const currentSize = extensionSize;
				extensionSize = u16(bytes, dataEnd);
				cursor += currentSize;
			}
			dataStart = baseEnd + totalExtensionSize;
			packedSize = fields.packedSize ?? packedSize - totalExtensionSize;
			if (packedSize < 0) throw new ArchiveError("Invalid LZH level-1 packed size");
		}
	} else {
		const headerLength = u16(bytes, offset);
		if (headerLength < 26) throw new ArchiveError("Invalid LZH level-2 header size");
		const headerEnd = offset + headerLength;
		assertRange(bytes, offset, headerEnd, "header");
		crc = u16(bytes, offset + 21);
		osId = bytes[offset + 23]!;
		mtimeMs = u32(bytes, offset + 15) * 1000;
		let cursor = offset + 24;
		let extensionCount = 0;
		while (cursor + 2 <= headerEnd) {
			const extensionSize = u16(bytes, cursor);
			if (extensionSize === 0) {
				cursor += 2;
				break;
			}
			if (extensionSize < 3 || cursor + extensionSize > headerEnd)
				throw new ArchiveError("Invalid LZH extended header size");
			if (++extensionCount > 65_535) throw new ArchiveError("Invalid LZH archive: too many extended headers");
			const type = bytes[cursor + 2]!;
			const data = bytes.subarray(cursor + 3, cursor + extensionSize);
			if (type === 0x01 || type === 0x02 || type === 0x44 || type === 0x45) {
				assertArchivePathBytes(data.byteLength, "member path", options.limits.maxPathBytes);
			}
			processExtendedHeader(type, data, cursor + 3, fields);
			cursor += extensionSize;
		}
		if (cursor !== headerEnd) throw new ArchiveError("Invalid LZH level-2 extended header chain");
		dataStart = headerEnd;
		packedSize = fields.packedSize ?? packedSize;
	}
	if (level === 1 && osId === 0x20 && method === "-lh7-") {
		throw new ArchiveError("LZH uses the incompatible LHARK -lh7- variant");
	}

	size = fields.size ?? size;
	mtimeMs = fields.mtimeMs ?? mtimeMs;
	const mode = fields.mode;
	if (fields.commonCrc !== undefined) {
		const relative = fields.commonCrcOffset! - offset;
		if (crc16WithZeroRange(bytes.subarray(offset, dataStart), relative, relative + 2) !== fields.commonCrc) {
			throw new ArchiveError("Invalid LZH common header CRC-16");
		}
	}
	const filename = fields.unicodeFilename ?? fields.filename ?? legacyFilename ?? "";
	const directory = fields.unicodeDirectory ?? fields.directory ?? "";
	const rawPath = `${directory}${directory && !/[\\/]$/.test(directory) ? "/" : ""}${filename}`;
	assertArchivePathString(rawPath, "member path", options.limits.maxPathBytes);
	assertArchiveMemberSize(size, rawPath || "<unnamed>", options.limits);
	assertRange(bytes, dataStart, dataStart + packedSize, "member data");
	return {
		method,
		packedSize,
		size,
		dataStart,
		nextOffset: dataStart + packedSize,
		crc,
		path: normalizeArchiveEntryPath(rawPath),
		mtimeMs,
		mode,
	};
}

/** Probe whether bytes begin with an LZH/LHA member header. */
export function sniffLzh(bytes: Uint8Array): boolean {
	if (bytes.byteLength < 22 || bytes[2] !== 0x2d || bytes[6] !== 0x2d || bytes[3] !== 0x6c) return false;
	const method = String.fromCharCode(...bytes.subarray(2, 7));
	return LHA_METHOD_PATTERN.test(method) && bytes[20]! <= 2;
}

/** Index an LZH/LHA archive and lazily decode its members from the bounded archive buffer. */
export const readLzh: FormatReader = async (
	source: ByteSource,
	options: FormatReadOptions,
): Promise<ArchiveIndexEntry[]> => {
	assertInMemorySize(source.size, options.limits);
	let bytes: Uint8Array;
	try {
		bytes = await readAllBytes(source);
	} catch (error) {
		if (error instanceof ArchiveError) throw error;
		throw new ArchiveError(`Unable to read LZH archive: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (bytes.byteLength !== source.size) throw new ArchiveError("Invalid LZH archive: truncated data");
	if (!sniffLzh(bytes)) throw new ArchiveError("Invalid LZH archive header");
	const entries: ArchiveIndexEntry[] = [];
	let offset = 0;
	let parsedCount = 0;
	let metadataSize = 0;
	while (offset < bytes.byteLength && bytes[offset] !== 0) {
		const header = parseLzhHeader(bytes, offset, options);
		metadataSize += header.dataStart - offset;
		assertIndexSize(metadataSize, options.limits, "index");
		assertEntryCount(++parsedCount, options.limits);
		if (header.nextOffset <= offset) throw new ArchiveError("Invalid LZH archive: header did not advance");
		offset = header.nextOffset;
		if (!header.path) continue;
		const isDirectory = header.method === "-lhd-";
		if (isDirectory && header.mode !== undefined && (header.mode & 0xf000) === 0xa000) {
			const separator = header.path.indexOf("|");
			if (separator < 1) throw new ArchiveError(`Invalid LZH symbolic link '${header.path}'`);
			const path = normalizeArchiveEntryPath(header.path.slice(0, separator));
			const targetPath = normalizeArchiveEntryPath(header.path.slice(separator + 1));
			if (!path || !targetPath) continue;
			entries.push({
				path,
				isDirectory: false,
				size: 0,
				mtimeMs: header.mtimeMs,
				mode: header.mode,
				storage: { type: "link", targetPath, resolveTarget: false },
			});
			continue;
		}
		entries.push({
			path: header.path,
			isDirectory,
			size: isDirectory ? 0 : header.size,
			mtimeMs: header.mtimeMs,
			mode: header.mode,
			storage: isDirectory
				? undefined
				: {
						type: "member",
						source: new LzhMemberSource(bytes, header.dataStart, header.packedSize, header.method, header.crc),
					},
		});
	}
	if (entries.length === 0 && parsedCount === 0) throw new ArchiveError("Invalid LZH archive: no members");
	return entries;
};
