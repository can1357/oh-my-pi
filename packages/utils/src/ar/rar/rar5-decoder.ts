/*
 * Decompression structure adapted from unrar5j by Stephane Bury
 * (Copyright 2025, Apache License 2.0).
 */
import { ArchiveError } from "../error";

const MAIN_SIZE = 306;
const DIST_SIZE = 80;
const ALIGN_SIZE = 16;
const LEN_SIZE = 44;
const TABLE_SIZE = MAIN_SIZE + DIST_SIZE + ALIGN_SIZE + LEN_SIZE;
const LEN_PLUS = [
	0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
	3,
] as const;
const MAX_MATCH = 0x1004;
const MAX_FILTER_SIZE = 1 << 22;

class Bits {
	readonly bytes: Uint8Array;
	pos = 0;
	bit = 0;
	blockEnd = 0;
	blockEndBit = 0;

	constructor(bytes: Uint8Array) {
		this.bytes = new Uint8Array(bytes.byteLength + 16);
		this.bytes.set(bytes);
		this.bytes.fill(0xff, bytes.byteLength);
	}

	read(n: number): number {
		if (n === 0) return 0;
		if (n < 0 || n > 31) fail("invalid bit count");
		let value = 0;
		for (let left = n; left > 0; ) {
			if (this.pos >= this.bytes.byteLength - 16) fail("truncated compressed data");
			const take = Math.min(left, 8 - this.bit);
			value = value * 2 ** take + ((this.bytes[this.pos]! >>> (8 - this.bit - take)) & (2 ** take - 1));
			this.bit += take;
			left -= take;
			if (this.bit === 8) {
				this.bit = 0;
				this.pos++;
			}
		}
		return value;
	}

	peek15(): number {
		const pos = this.pos;
		const bit = this.bit;
		const value = this.read(15);
		this.pos = pos;
		this.bit = bit;
		return value;
	}

	align(): void {
		if (this.bit !== 0) {
			this.pos++;
			this.bit = 0;
		}
	}

	byte(): number {
		if (this.bit !== 0) fail("unaligned compressed data");
		if (this.pos >= this.bytes.byteLength - 16) fail("truncated compressed data");
		return this.bytes[this.pos++]!;
	}

	atBlockEnd(): boolean {
		return this.pos > this.blockEnd || (this.pos === this.blockEnd && this.bit >= this.blockEndBit);
	}
}

class Huffman {
	readonly #maxBits: number;
	readonly #size: number;
	#counts: Int32Array;
	#firstCode: Int32Array;
	#firstSymbol: Int32Array;
	#symbols: Int32Array;
	#ready = false;

	constructor(size: number, maxBits = 15) {
		this.#size = size;
		this.#maxBits = maxBits;
		this.#counts = new Int32Array(maxBits + 1);
		this.#firstCode = new Int32Array(maxBits + 1);
		this.#firstSymbol = new Int32Array(maxBits + 1);
		this.#symbols = new Int32Array(size);
	}

	build(lengths: Uint8Array, offset = 0): void {
		this.#counts.fill(0);
		for (let i = 0; i < this.#size; i++) {
			const length = lengths[offset + i]!;
			if (length > this.#maxBits) fail("invalid Huffman code length");
			if (length !== 0) this.#counts[length]++;
		}
		let code = 0;
		let symbols = 0;
		for (let bits = 1; bits <= this.#maxBits; bits++) {
			code = (code + this.#counts[bits - 1]!) << 1;
			this.#firstCode[bits] = code;
			this.#firstSymbol[bits] = symbols;
			symbols += this.#counts[bits]!;
		}
		if (symbols !== 0 && code + this.#counts[this.#maxBits]! !== 1 << this.#maxBits) fail("incomplete Huffman table");
		const next = this.#firstSymbol.slice();
		for (let symbol = 0; symbol < this.#size; symbol++) {
			const length = lengths[offset + symbol]!;
			if (length !== 0) this.#symbols[next[length]++] = symbol;
		}
		this.#ready = symbols !== 0;
	}

	decode(bits: Bits): number {
		if (!this.#ready) fail("empty Huffman table");
		let code = 0;
		for (let length = 1; length <= this.#maxBits; length++) {
			code = (code << 1) | bits.read(1);
			const index = code - this.#firstCode[length]!;
			if (index >= 0 && index < this.#counts[length]!) return this.#symbols[this.#firstSymbol[length]! + index]!;
		}
		fail("invalid Huffman symbol");
	}
}

interface Filter {
	type: number;
	channels: number;
	start: number;
	size: number;
}

/** Stateful RAR5 LZSS decoder; reuse one instance for members in a solid chain. */
export class Rar5Decoder {
	#history = new Uint8Array(0);
	#reps = [0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff];
	#lastLen = 0;
	#main = new Huffman(MAIN_SIZE);
	#dist = new Huffman(DIST_SIZE);
	#align = new Huffman(ALIGN_SIZE);
	#length = new Huffman(LEN_SIZE);
	#useAlign = false;

	reset(): void {
		this.#history = new Uint8Array(0);
		this.#reps = [0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff];
		this.#lastLen = 0;
		this.#main = new Huffman(MAIN_SIZE);
		this.#dist = new Huffman(DIST_SIZE);
		this.#align = new Huffman(ALIGN_SIZE);
		this.#length = new Huffman(LEN_SIZE);
		this.#useAlign = false;
	}

	decode(
		packed: Uint8Array,
		unpackedSize: number,
		dictionarySize: number,
		solid: boolean,
		version: number,
	): Uint8Array {
		if (version !== 0 && version !== 1) {
			throw new ArchiveError(`Unsupported RAR5 compression algorithm version ${version}`);
		}
		if (!solid) this.reset();
		if (!Number.isSafeInteger(dictionarySize) || dictionarySize < 128 * 1024) fail("invalid dictionary size");
		const prior =
			this.#history.byteLength > dictionarySize
				? this.#history.subarray(this.#history.byteLength - dictionarySize)
				: this.#history;
		const data = new Uint8Array(prior.byteLength + unpackedSize + MAX_MATCH);
		data.set(prior);
		let outPos = prior.byteLength;
		const outStart = outPos;
		const outEnd = outStart + unpackedSize;
		const filters: Filter[] = [];
		const bits = new Bits(packed);
		const main = this.#main;
		const dist = this.#dist;
		const align = this.#align;
		const lenDecoder = this.#length;
		let lastBlock = false;

		const readTables = (): void => {
			bits.align();
			const flags = bits.byte();
			let checksum = flags ^ bits.byte();
			const sizeBytes = (flags >>> 3) & 3;
			if (sizeBytes === 3) fail("invalid compressed block header");
			let blockSize = bits.byte();
			checksum ^= blockSize;
			for (let i = 0; i < sizeBytes; i++) {
				const b = bits.byte();
				checksum ^= b;
				blockSize += b * 2 ** (8 * (i + 1));
			}
			if (checksum !== 0x5a) fail("compressed block checksum mismatch");
			let endBits = (flags & 7) + 1;
			blockSize += endBits >>> 3;
			if (blockSize === 0) fail("empty compressed block");
			blockSize--;
			endBits &= 7;
			bits.blockEnd = bits.pos + blockSize;
			bits.blockEndBit = endBits;
			lastBlock = (flags & 0x40) !== 0;
			if ((flags & 0x80) === 0) return;

			const levelLengths = new Uint8Array(20);
			for (let i = 0; i < 20; ) {
				const length = bits.read(4);
				if (length === 15) {
					const zeros = bits.read(4);
					if (zeros !== 0) {
						i = Math.min(20, i + zeros + 2);
						continue;
					}
				}
				levelLengths[i++] = length;
			}
			const level = new Huffman(20);
			level.build(levelLengths);
			const tableLength = version === 1 ? TABLE_SIZE : TABLE_SIZE - 16;
			const lengthsCompact = new Uint8Array(tableLength);
			for (let i = 0; i < tableLength; ) {
				const symbol = level.decode(bits);
				if (symbol < 16) {
					lengthsCompact[i++] = symbol;
					continue;
				}
				let count = ((symbol - 16) & 1) * 4;
				count += count + 3 + bits.read(count + 3);
				const value = symbol < 18 ? (i === 0 ? fail("invalid Huffman repeat") : lengthsCompact[i - 1]!) : 0;
				const end = Math.min(tableLength, i + count);
				lengthsCompact.fill(value, i, end);
				i = end;
			}
			const lengths = new Uint8Array(TABLE_SIZE);
			if (version === 0) {
				lengths.set(lengthsCompact.subarray(0, MAIN_SIZE + 64));
				lengths.set(lengthsCompact.subarray(MAIN_SIZE + 64), MAIN_SIZE + DIST_SIZE);
			} else {
				lengths.set(lengthsCompact);
			}
			main.build(lengths);
			dist.build(lengths, MAIN_SIZE);
			align.build(lengths, MAIN_SIZE + DIST_SIZE);
			lenDecoder.build(lengths, MAIN_SIZE + DIST_SIZE + ALIGN_SIZE);
			this.#useAlign = false;
			for (let i = 0; i < ALIGN_SIZE; i++) {
				if (lengths[MAIN_SIZE + DIST_SIZE + i] !== 4) this.#useAlign = true;
			}
		};

		readTables();
		while (outPos < outEnd) {
			if (bits.atBlockEnd()) {
				if (bits.pos > bits.blockEnd || (bits.pos === bits.blockEnd && bits.bit > bits.blockEndBit))
					fail("compressed block overread");
				bits.align();
				if (lastBlock) break;
				readTables();
				continue;
			}
			const symbol = main.decode(bits);
			if (symbol < 256) {
				data[outPos++] = symbol;
				continue;
			}
			if (symbol === 256) {
				const bytes = (bits.read(2) + 1) * 8;
				let start = 0;
				for (let shift = 0; shift < bytes; shift += 8) start += bits.read(8) * 2 ** shift;
				const sizeBytes = (bits.read(2) + 1) * 8;
				let size = 0;
				for (let shift = 0; shift < sizeBytes; shift += 8) size += bits.read(8) * 2 ** shift;
				const type = bits.read(3);
				const channels = type === 0 ? bits.read(5) + 1 : 0;
				if (type > 3) throw new ArchiveError(`Unsupported RAR5 filter type ${type}`);
				if (size > MAX_FILTER_SIZE || outPos - outStart + start + size > unpackedSize) fail("invalid filter range");
				filters.push({ type, channels, start: outPos - outStart + start, size });
				continue;
			}

			let length: number;
			let distance = this.#reps[0]!;
			if (symbol < 262) {
				if (symbol >= 258) {
					const repIndex = symbol - 258;
					distance = this.#reps[repIndex]!;
					for (let i = repIndex; i > 0; i--) this.#reps[i] = this.#reps[i - 1]!;
					this.#reps[0] = distance;
					const slot = lenDecoder.decode(bits);
					length = slot >= 8 ? slotToLength(bits, slot) : slot;
					length += 2;
					this.#lastLen = length;
				} else {
					length = this.#lastLen;
					if (length === 0) continue;
				}
			} else {
				this.#reps[3] = this.#reps[2]!;
				this.#reps[2] = this.#reps[1]!;
				this.#reps[1] = this.#reps[0]!;
				const slot = symbol - 262;
				length = slot >= 8 ? slotToLength(bits, slot) : slot;
				length += 2;
				let distanceSlot = dist.decode(bits);
				if (distanceSlot >= 4) {
					const extraBits = (distanceSlot - 2) >>> 1;
					distanceSlot = (2 | (distanceSlot & 1)) * 2 ** extraBits;
					if (extraBits < 4) distanceSlot += bits.read(extraBits);
					else {
						length += LEN_PLUS[extraBits] ?? 3;
						if (this.#useAlign) distanceSlot += bits.read(extraBits - 4) * 16 + align.decode(bits);
						else distanceSlot += bits.read(extraBits);
					}
				}
				distance = distanceSlot + 1;
				this.#reps[0] = distance;
				this.#lastLen = length;
			}
			if (distance <= 0 || distance > dictionarySize || distance > outPos) fail("invalid LZ distance");
			if (outPos + length > data.byteLength) fail("invalid LZ match length");
			for (let i = 0; i < length; i++) data[outPos + i] = data[outPos + i - distance]!;
			outPos += length;
		}
		if (outPos !== outEnd) fail(`decompressed size mismatch (${outPos - outStart} != ${unpackedSize})`);
		const output = data.slice(outStart, outEnd);
		applyFilters(output, filters);
		const historyStart = Math.max(0, outEnd - dictionarySize);
		this.#history = data.slice(historyStart, outEnd);
		return output;
	}
}

function slotToLength(bits: Bits, slot: number): number {
	const count = (slot >>> 2) - 1;
	return ((4 | (slot & 3)) << count) + bits.read(count);
}

function applyFilters(output: Uint8Array, filters: Filter[]): void {
	for (const filter of filters) {
		const data = output.subarray(filter.start, filter.start + filter.size);
		if (filter.type === 0) {
			const source = data.slice();
			let sourcePos = 0;
			for (let channel = 0; channel < filter.channels; channel++) {
				let previous = 0;
				for (let pos = channel; pos < data.byteLength; pos += filter.channels) {
					previous = (previous - source[sourcePos++]!) & 0xff;
					data[pos] = previous;
				}
			}
		} else if (filter.type === 1 || filter.type === 2) {
			const fileSize = 1 << 24;
			for (let pos = 0; pos + 4 < data.byteLength; ) {
				const opcode = data[pos++]!;
				if (opcode !== 0xe8 && (filter.type === 1 || opcode !== 0xe9)) continue;
				const offset = (filter.start + pos) & (fileSize - 1);
				let address = readI32(data, pos);
				if (address >>> 0 < fileSize) address -= offset;
				else if (address >>> 0 >= -offset >>> 0) address += fileSize;
				else {
					pos += 4;
					continue;
				}
				writeI32(data, pos, address);
				pos += 4;
			}
		} else {
			for (let pos = 0; pos + 3 < data.byteLength; pos += 4) {
				if (data[pos + 3] !== 0xeb) continue;
				const instruction = readI32(data, pos);
				const address =
					((instruction & 0xff000000) | ((instruction - ((filter.start + pos) >> 2)) & 0xffffff)) >>> 0;
				writeI32(data, pos, address);
			}
		}
	}
}

function readI32(bytes: Uint8Array, offset: number): number {
	return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24);
}

function writeI32(bytes: Uint8Array, offset: number, value: number): void {
	bytes[offset] = value;
	bytes[offset + 1] = value >>> 8;
	bytes[offset + 2] = value >>> 16;
	bytes[offset + 3] = value >>> 24;
}

function fail(reason: string): never {
	throw new ArchiveError(`Invalid RAR5 archive: ${reason}`);
}
