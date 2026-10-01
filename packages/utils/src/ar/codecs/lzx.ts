import { ArchiveError } from "../error";

const FRAME_SIZE = 32 * 1024;
const MIN_MATCH = 2;
const NUM_PRIMARY_LENGTHS = 7;
const NUM_SECONDARY_LENGTHS = 249;
const POSITION_SLOTS = [30, 32, 34, 36, 38, 42, 50] as const;

class LzxBitReader {
	readonly #bytes: Uint8Array;
	#offset = 0;
	#word = 0;
	#remaining = 0;

	constructor(bytes: Uint8Array) {
		this.#bytes = bytes;
	}

	readBits(count: number): number {
		let value = 0;
		let needed = count;
		while (needed > 0) {
			if (this.#remaining === 0) {
				if (this.#offset + 2 > this.#bytes.byteLength) {
					throw new ArchiveError("Invalid CAB archive: truncated LZX bitstream");
				}
				this.#word = this.#bytes[this.#offset]! | (this.#bytes[this.#offset + 1]! << 8);
				this.#offset += 2;
				this.#remaining = 16;
			}
			const take = Math.min(needed, this.#remaining);
			value = value * 2 ** take + ((this.#word >>> (this.#remaining - take)) & (2 ** take - 1));
			this.#remaining -= take;
			needed -= take;
		}
		return value;
	}

	alignWord(): void {
		this.#remaining = 0;
	}

	readByte(): number {
		if (this.#remaining !== 0) {
			throw new ArchiveError("Invalid CAB archive: misaligned LZX byte stream");
		}
		if (this.#offset >= this.#bytes.byteLength) {
			throw new ArchiveError("Invalid CAB archive: truncated LZX data");
		}
		return this.#bytes[this.#offset++]!;
	}

	readUInt32LE(): number {
		const b0 = this.readByte();
		const b1 = this.readByte();
		const b2 = this.readByte();
		const b3 = this.readByte();
		return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
	}
}

class LzxHuffmanTable {
	readonly #counts = new Uint32Array(17);
	readonly #firstCodes = new Uint32Array(17);
	readonly #firstSymbols = new Uint32Array(17);
	readonly #symbols: Uint16Array;
	readonly empty: boolean;

	constructor(lengths: Uint8Array, allowEmpty = false) {
		let symbolCount = 0;
		for (const length of lengths) {
			if (length > 16) throw new ArchiveError("Invalid CAB archive: invalid LZX Huffman code length");
			if (length !== 0) {
				this.#counts[length]++;
				symbolCount++;
			}
		}
		this.empty = symbolCount === 0;
		if (this.empty && !allowEmpty) {
			throw new ArchiveError("Invalid CAB archive: empty LZX Huffman tree");
		}

		let code = 0;
		let symbolOffset = 0;
		for (let length = 1; length <= 16; length++) {
			code = (code + this.#counts[length - 1]!) * 2;
			if (code + this.#counts[length]! > 2 ** length) {
				throw new ArchiveError("Invalid CAB archive: oversubscribed LZX Huffman tree");
			}
			this.#firstCodes[length] = code;
			this.#firstSymbols[length] = symbolOffset;
			symbolOffset += this.#counts[length]!;
		}

		this.#symbols = new Uint16Array(symbolCount);
		const next = this.#firstSymbols.slice();
		for (let symbol = 0; symbol < lengths.byteLength; symbol++) {
			const length = lengths[symbol]!;
			if (length !== 0) this.#symbols[next[length]!] = symbol;
			next[length]!++;
		}
	}

	decode(reader: LzxBitReader): number {
		if (this.empty) throw new ArchiveError("Invalid CAB archive: LZX stream uses an empty Huffman tree");
		let code = 0;
		for (let length = 1; length <= 16; length++) {
			code = code * 2 + reader.readBits(1);
			const relative = code - this.#firstCodes[length]!;
			if (relative >= 0 && relative < this.#counts[length]!) {
				return this.#symbols[this.#firstSymbols[length]! + relative]!;
			}
		}
		throw new ArchiveError("Invalid CAB archive: invalid LZX Huffman symbol");
	}
}

function readCodeLengths(reader: LzxBitReader, lengths: Uint8Array, first: number, last: number): void {
	const pretreeLengths = new Uint8Array(20);
	for (let index = 0; index < pretreeLengths.byteLength; index++) pretreeLengths[index] = reader.readBits(4);
	const pretree = new LzxHuffmanTable(pretreeLengths);
	let index = first;
	while (index < last) {
		const symbol = pretree.decode(reader);
		if (symbol === 17 || symbol === 18) {
			const run = reader.readBits(symbol === 17 ? 4 : 5) + (symbol === 17 ? 4 : 20);
			if (index + run > last) throw new ArchiveError("Invalid CAB archive: LZX code-length run exceeds its tree");
			lengths.fill(0, index, index + run);
			index += run;
			continue;
		}
		if (symbol === 19) {
			const run = reader.readBits(1) + 4;
			if (index + run > last) throw new ArchiveError("Invalid CAB archive: LZX code-length run exceeds its tree");
			const delta = pretree.decode(reader);
			const length = (lengths[index]! - delta + 17) % 17;
			lengths.fill(length, index, index + run);
			index += run;
			continue;
		}
		lengths[index] = (lengths[index]! - symbol + 17) % 17;
		index++;
	}
}

function signedUInt32(value: number): number {
	return value > 0x7fffffff ? value - 0x100000000 : value;
}

/** Stateful Microsoft LZX decoder used by CAB folders, retaining trees and window history between 32 KiB frames. */
export class LzxDecoder {
	readonly #window: Uint8Array;
	readonly #positionBase: Uint32Array;
	readonly #extraBits: Uint8Array;
	readonly #mainLengths: Uint8Array;
	readonly #lengthLengths = new Uint8Array(NUM_SECONDARY_LENGTHS);
	#mainTable?: LzxHuffmanTable;
	#lengthTable?: LzxHuffmanTable;
	#alignedTable?: LzxHuffmanTable;
	#windowPosition = 0;
	#decodedSize = 0;
	#frame = 0;
	#r0 = 1;
	#r1 = 1;
	#r2 = 1;
	#headerRead = false;
	#intelFileSize = 0;
	#intelStarted = false;
	#blockType = 0;
	#blockLength = 0;
	#blockRemaining = 0;
	#uncompressedPadding = false;

	constructor(windowBits: number) {
		if (!Number.isInteger(windowBits) || windowBits < 15 || windowBits > 21) {
			throw new ArchiveError(`Unsupported CAB LZX window size: ${windowBits} bits (expected 15-21)`);
		}
		this.#window = new Uint8Array(2 ** windowBits);
		const slots = POSITION_SLOTS[windowBits - 15]!;
		this.#mainLengths = new Uint8Array(256 + slots * 8);
		this.#extraBits = new Uint8Array(slots);
		this.#positionBase = new Uint32Array(slots);
		for (let slot = 0; slot < slots; slot++) {
			this.#extraBits[slot] = slot < 4 ? 0 : Math.min(17, Math.floor(slot / 2) - 1);
			if (slot > 0) this.#positionBase[slot] = this.#positionBase[slot - 1]! + 2 ** this.#extraBits[slot - 1]!;
		}
	}

	/** Decode one CAB CFDATA LZX frame while preserving the folder's dictionary and Huffman state. */
	decompressFrame(bytes: Uint8Array, outputSize: number): Uint8Array {
		if (!Number.isInteger(outputSize) || outputSize < 0 || outputSize > FRAME_SIZE) {
			throw new ArchiveError(`Invalid CAB archive: LZX frame size ${outputSize} exceeds 32768 bytes`);
		}
		if (outputSize === 0) return new Uint8Array(0);
		const reader = new LzxBitReader(bytes);
		if (!this.#headerRead) {
			if (reader.readBits(1) !== 0) {
				const high = reader.readBits(16);
				const low = reader.readBits(16);
				this.#intelFileSize = signedUInt32((high * 0x10000 + low) >>> 0);
			}
			this.#headerRead = true;
		}

		const raw = new Uint8Array(outputSize);
		let outputPosition = 0;
		while (outputPosition < outputSize) {
			if (this.#blockRemaining === 0) this.#readBlockHeader(reader);
			const run = Math.min(this.#blockRemaining, outputSize - outputPosition);
			const produced = this.#decodeRun(reader, raw, outputPosition, run);
			if (produced !== run) throw new ArchiveError("Invalid CAB archive: LZX block produced the wrong byte count");
			outputPosition += produced;
			this.#blockRemaining -= produced;
		}
		if (this.#blockRemaining === 0 && this.#blockType === 3 && this.#uncompressedPadding) {
			reader.readByte();
			this.#uncompressedPadding = false;
		}
		reader.alignWord();

		const translated = this.#translateE8(raw);
		this.#frame++;
		return translated;
	}

	#readBlockHeader(reader: LzxBitReader): void {
		if (this.#blockType === 3 && this.#uncompressedPadding) reader.readByte();
		this.#uncompressedPadding = false;
		this.#blockType = reader.readBits(3);
		this.#blockLength = reader.readBits(16) * 256 + reader.readBits(8);
		if (this.#blockLength === 0) throw new ArchiveError("Invalid CAB archive: zero-length LZX block");
		this.#blockRemaining = this.#blockLength;

		if (this.#blockType === 1 || this.#blockType === 2) {
			if (this.#blockType === 2) {
				const alignedLengths = new Uint8Array(8);
				for (let index = 0; index < alignedLengths.byteLength; index++) alignedLengths[index] = reader.readBits(3);
				this.#alignedTable = new LzxHuffmanTable(alignedLengths);
			}
			readCodeLengths(reader, this.#mainLengths, 0, 256);
			readCodeLengths(reader, this.#mainLengths, 256, this.#mainLengths.byteLength);
			this.#mainTable = new LzxHuffmanTable(this.#mainLengths);
			if (this.#mainLengths[0xe8] !== 0) this.#intelStarted = true;
			readCodeLengths(reader, this.#lengthLengths, 0, this.#lengthLengths.byteLength);
			this.#lengthTable = new LzxHuffmanTable(this.#lengthLengths, true);
			return;
		}
		if (this.#blockType === 3) {
			this.#intelStarted = true;
			reader.alignWord();
			this.#r0 = reader.readUInt32LE();
			this.#r1 = reader.readUInt32LE();
			this.#r2 = reader.readUInt32LE();
			if (this.#r0 === 0 || this.#r1 === 0 || this.#r2 === 0) {
				throw new ArchiveError("Invalid CAB archive: invalid LZX repeated offset");
			}
			this.#uncompressedPadding = (this.#blockLength & 1) !== 0;
			return;
		}
		throw new ArchiveError(`Invalid CAB archive: unsupported LZX block type ${this.#blockType}`);
	}

	#decodeRun(reader: LzxBitReader, output: Uint8Array, outputStart: number, count: number): number {
		if (this.#blockType === 3) {
			for (let index = 0; index < count; index++) this.#writeByte(reader.readByte(), output, outputStart + index);
			return count;
		}
		if (!this.#mainTable || !this.#lengthTable)
			throw new ArchiveError("Invalid CAB archive: missing LZX decode trees");

		let produced = 0;
		while (produced < count) {
			const element = this.#mainTable.decode(reader);
			if (element < 256) {
				this.#writeByte(element, output, outputStart + produced);
				produced++;
				continue;
			}

			const match = element - 256;
			let matchLength = match & NUM_PRIMARY_LENGTHS;
			if (matchLength === NUM_PRIMARY_LENGTHS) matchLength += this.#lengthTable.decode(reader);
			matchLength += MIN_MATCH;
			if (matchLength > count - produced || matchLength > this.#blockRemaining - produced) {
				throw new ArchiveError("Invalid CAB archive: LZX match crosses a frame or block boundary");
			}

			const slot = match >>> 3;
			let matchOffset: number;
			if (slot === 0) {
				matchOffset = this.#r0;
			} else if (slot === 1) {
				matchOffset = this.#r1;
				this.#r1 = this.#r0;
				this.#r0 = matchOffset;
			} else if (slot === 2) {
				matchOffset = this.#r2;
				this.#r2 = this.#r0;
				this.#r0 = matchOffset;
			} else {
				if (slot >= this.#positionBase.byteLength)
					throw new ArchiveError("Invalid CAB archive: LZX position slot is out of range");
				const extra = this.#extraBits[slot]!;
				matchOffset = this.#positionBase[slot]! - 2;
				if (this.#blockType === 2 && extra >= 3) {
					if (extra > 3) matchOffset += reader.readBits(extra - 3) * 8;
					if (!this.#alignedTable) throw new ArchiveError("Invalid CAB archive: missing LZX aligned tree");
					matchOffset += this.#alignedTable.decode(reader);
				} else if (extra !== 0) {
					matchOffset += reader.readBits(extra);
				}
				this.#r2 = this.#r1;
				this.#r1 = this.#r0;
				this.#r0 = matchOffset;
			}

			if (matchOffset <= 0 || matchOffset > Math.min(this.#decodedSize, this.#window.byteLength)) {
				throw new ArchiveError("Invalid CAB archive: LZX match offset exceeds available history");
			}
			for (let index = 0; index < matchLength; index++) {
				const source = (this.#windowPosition - matchOffset + this.#window.byteLength) % this.#window.byteLength;
				this.#writeByte(this.#window[source]!, output, outputStart + produced + index);
			}
			produced += matchLength;
		}
		return produced;
	}

	#writeByte(value: number, output: Uint8Array, outputPosition: number): void {
		output[outputPosition] = value;
		this.#window[this.#windowPosition] = value;
		this.#windowPosition = (this.#windowPosition + 1) % this.#window.byteLength;
		this.#decodedSize++;
	}

	#translateE8(raw: Uint8Array): Uint8Array {
		if (!this.#intelStarted || this.#intelFileSize === 0 || this.#frame >= 32768 || raw.byteLength <= 10) return raw;
		const output = raw.slice();
		let position = 0;
		let current = this.#decodedSize - raw.byteLength;
		const end = output.byteLength - 10;
		while (position < end) {
			if (output[position++] !== 0xe8) {
				current++;
				continue;
			}
			const absolute = signedUInt32(
				(output[position]! |
					(output[position + 1]! << 8) |
					(output[position + 2]! << 16) |
					(output[position + 3]! << 24)) >>>
					0,
			);
			if (absolute >= -current && absolute < this.#intelFileSize) {
				const relative = absolute >= 0 ? absolute - current : absolute + this.#intelFileSize;
				output[position] = relative & 0xff;
				output[position + 1] = (relative >>> 8) & 0xff;
				output[position + 2] = (relative >>> 16) & 0xff;
				output[position + 3] = (relative >>> 24) & 0xff;
			}
			position += 4;
			current += 5;
		}
		return output;
	}
}
