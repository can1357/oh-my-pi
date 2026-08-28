/*
 * Decompression structure adapted from unrar5j by Stephane Bury
 * (Copyright 2025, Apache License 2.0).
 */
import { crc32 } from "../checksums";
import { ArchiveError } from "../error";

const MAIN_SIZE = 299;
const DIST_SIZE = 60;
const LOW_DIST_SIZE = 17;
const LEN_SIZE = 28;
const TOTAL_SIZE = MAIN_SIZE + DIST_SIZE + LOW_DIST_SIZE + LEN_SIZE;
const LEN_BASE = [
	0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224,
] as const;
const LEN_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5] as const;
const SHORT_DIST_BASE = [0, 4, 8, 16, 32, 64, 128, 192] as const;
const SHORT_DIST_BITS = [2, 2, 3, 4, 5, 6, 6, 6] as const;
const DIST_BASE = new Int32Array(DIST_SIZE);
const DIST_BITS = new Uint8Array(DIST_SIZE);
{
	const counts = [4, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 14, 0, 12];
	let distance = 0;
	let slot = 0;
	for (let bits = 0; bits < counts.length; bits++) {
		for (let count = 0; count < counts[bits]!; count++) {
			DIST_BASE[slot] = distance;
			DIST_BITS[slot] = bits;
			distance += 2 ** bits;
			slot++;
		}
	}
}

class Bits {
	readonly bytes: Uint8Array;
	pos = 0;
	bit = 0;

	constructor(packed: Uint8Array) {
		this.bytes = new Uint8Array(packed.byteLength + 4);
		this.bytes.set(packed);
	}

	read(count: number): number {
		if (count === 0) return 0;
		let value = 0;
		for (let left = count; left > 0; ) {
			if (this.pos >= this.bytes.byteLength - 4) corrupt("truncated compressed data");
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

	align(): void {
		if (this.bit !== 0) {
			this.pos++;
			this.bit = 0;
		}
	}
}

class Huffman {
	#counts = new Int32Array(16);
	#firstCode = new Int32Array(16);
	#firstSymbol = new Int32Array(16);
	#symbols: Int32Array;
	#ready = false;

	constructor(size: number) {
		this.#symbols = new Int32Array(size);
	}

	build(lengths: Uint8Array, offset: number, size: number): void {
		this.#counts.fill(0);
		for (let i = 0; i < size; i++) {
			const length = lengths[offset + i]! & 15;
			if (length !== 0) this.#counts[length]++;
		}
		let code = 0;
		let symbolPosition = 0;
		for (let bits = 1; bits <= 15; bits++) {
			code = (code + this.#counts[bits - 1]!) << 1;
			this.#firstCode[bits] = code;
			this.#firstSymbol[bits] = symbolPosition;
			symbolPosition += this.#counts[bits]!;
		}
		const next = this.#firstSymbol.slice();
		for (let symbol = 0; symbol < size; symbol++) {
			const length = lengths[offset + symbol]! & 15;
			if (length !== 0) this.#symbols[next[length]++] = symbol;
		}
		this.#ready = symbolPosition !== 0;
	}

	decode(bits: Bits): number {
		if (!this.#ready) corrupt("empty Huffman table");
		let code = 0;
		for (let length = 1; length <= 15; length++) {
			code = (code << 1) | bits.read(1);
			const index = code - this.#firstCode[length]!;
			if (index >= 0 && index < this.#counts[length]!) return this.#symbols[this.#firstSymbol[length]! + index]!;
		}
		corrupt("invalid Huffman symbol");
	}
}

interface PendingFilter {
	type: number;
	start: number;
	size: number;
	channels: number;
	fileOffset: number;
}

/** Stateful decoder for the RAR 2.9 LZ/Huffman algorithm used by RAR3/4 archives. */
export class Rar4Decoder {
	#history = new Uint8Array(0);
	#oldDistances = [0, 0, 0, 0];
	#lastDistance = 0;
	#lastLength = 0;
	#previousLowDistance = 0;
	#lowDistanceRepeats = 0;
	#carriedLengths = new Uint8Array(TOTAL_SIZE);
	#filterTypes: number[] = [];
	#filterLengths: number[] = [];
	#lastFilter = 0;

	reset(): void {
		this.#history = new Uint8Array(0);
		this.#oldDistances = [0, 0, 0, 0];
		this.#lastDistance = 0;
		this.#lastLength = 0;
		this.#previousLowDistance = 0;
		this.#lowDistanceRepeats = 0;
		this.#carriedLengths.fill(0);
		this.#filterTypes = [];
		this.#filterLengths = [];
		this.#lastFilter = 0;
	}

	decode(
		packed: Uint8Array,
		unpackedSize: number,
		dictionarySize: number,
		solid: boolean,
		version: number,
	): Uint8Array {
		if (version < 29) throw new ArchiveError(`Unsupported RAR4 compression algorithm version ${version}`);
		if (!solid) this.reset();
		const prior =
			this.#history.byteLength > dictionarySize
				? this.#history.subarray(this.#history.byteLength - dictionarySize)
				: this.#history;
		const output = new Uint8Array(prior.byteLength + unpackedSize + 260);
		output.set(prior);
		const outputStart = prior.byteLength;
		const outputEnd = outputStart + unpackedSize;
		let outputPosition = outputStart;
		const bits = new Bits(packed);
		const main = new Huffman(MAIN_SIZE);
		const distanceDecoder = new Huffman(DIST_SIZE);
		const lowDistanceDecoder = new Huffman(LOW_DIST_SIZE);
		const lengthDecoder = new Huffman(LEN_SIZE);
		const filters: PendingFilter[] = [];

		const readTables = (): void => {
			bits.align();
			if (bits.read(1) !== 0) throw new ArchiveError("Unsupported RAR4 PPMd compressed block");
			const keepPrevious = bits.read(1) !== 0;
			this.#previousLowDistance = 0;
			this.#lowDistanceRepeats = 0;
			if (!keepPrevious) this.#carriedLengths.fill(0);
			const lengths = readLengthTable(bits, this.#carriedLengths, TOTAL_SIZE);
			let offset = 0;
			main.build(lengths, offset, MAIN_SIZE);
			offset += MAIN_SIZE;
			distanceDecoder.build(lengths, offset, DIST_SIZE);
			offset += DIST_SIZE;
			lowDistanceDecoder.build(lengths, offset, LOW_DIST_SIZE);
			offset += LOW_DIST_SIZE;
			lengthDecoder.build(lengths, offset, LEN_SIZE);
			this.#carriedLengths.set(lengths);
		};

		const copyMatch = (distance: number, length: number): void => {
			if (distance <= 0 || distance > dictionarySize || distance > outputPosition) corrupt("invalid LZ distance");
			length = Math.min(length, outputEnd - outputPosition);
			for (let i = 0; i < length; i++) output[outputPosition + i] = output[outputPosition + i - distance]!;
			outputPosition += length;
		};
		const rememberDistance = (distance: number): void => {
			this.#oldDistances[3] = this.#oldDistances[2]!;
			this.#oldDistances[2] = this.#oldDistances[1]!;
			this.#oldDistances[1] = this.#oldDistances[0]!;
			this.#oldDistances[0] = distance;
		};
		const readFilter = (): void => {
			const firstByte = bits.read(8);
			let size = (firstByte & 7) + 1;
			if (size === 7) size = bits.read(8) + 7;
			else if (size === 8) size = bits.read(16);
			const code = new Uint8Array(size);
			for (let index = 0; index < size; index++) code[index] = bits.read(8);
			const vm = new VmBits(code);
			let filterPosition: number;
			if ((firstByte & 0x80) !== 0) {
				filterPosition = vm.readData();
				if (filterPosition === 0) {
					this.#filterTypes = [];
					this.#filterLengths = [];
				} else filterPosition--;
			} else {
				filterPosition = this.#lastFilter;
			}
			if (filterPosition < 0 || filterPosition > this.#filterTypes.length) corrupt("invalid RarVM filter index");
			this.#lastFilter = filterPosition;
			const isNew = filterPosition === this.#filterTypes.length;
			let start = vm.readData();
			if ((firstByte & 0x40) !== 0) start += 258;
			start += outputPosition - outputStart;
			const blockSize = (firstByte & 0x20) !== 0 ? vm.readData() : (this.#filterLengths[filterPosition] ?? 0);
			const registers = new Int32Array(7);
			registers[3] = 0x3c000;
			registers[4] = blockSize;
			if ((firstByte & 0x10) !== 0) {
				const mask = vm.read(7);
				for (let register = 0; register < 7; register++) {
					if ((mask & (1 << register)) !== 0) registers[register] = vm.readData();
				}
			}
			let type: number;
			if (isNew) {
				const programSize = vm.readData();
				const program = new Uint8Array(programSize);
				for (let index = 0; index < programSize; index++) program[index] = vm.read(8);
				type = identifyFilter(program);
				this.#filterTypes.push(type);
				this.#filterLengths.push(blockSize);
			} else {
				type = this.#filterTypes[filterPosition]!;
				this.#filterLengths[filterPosition] = blockSize;
			}
			if (type !== 1 && type !== 2 && type !== 6) {
				throw new ArchiveError(`Unsupported RAR4 RarVM filter type ${type || "unknown"}`);
			}
			if (start < 0 || blockSize < 0 || start + blockSize > unpackedSize) corrupt("invalid RarVM filter range");
			filters.push({ type, start, size: blockSize, channels: registers[0]!, fileOffset: registers[6]! });
		};

		readTables();
		while (outputPosition < outputEnd) {
			const symbol = main.decode(bits);
			if (symbol < 256) {
				output[outputPosition++] = symbol;
			} else if (symbol >= 271) {
				const slot = symbol - 271;
				let length = LEN_BASE[slot]! + 3 + bits.read(LEN_BITS[slot]!);
				const distanceSlot = distanceDecoder.decode(bits);
				let distance = DIST_BASE[distanceSlot]! + 1;
				const extraBits = DIST_BITS[distanceSlot]!;
				if (extraBits !== 0) {
					if (distanceSlot > 9) {
						if (extraBits > 4) distance += bits.read(extraBits - 4) * 16;
						if (this.#lowDistanceRepeats > 0) {
							this.#lowDistanceRepeats--;
							distance += this.#previousLowDistance;
						} else {
							const low = lowDistanceDecoder.decode(bits);
							if (low === 16) {
								this.#lowDistanceRepeats = 15;
								distance += this.#previousLowDistance;
							} else {
								distance += low;
								this.#previousLowDistance = low;
							}
						}
					} else distance += bits.read(extraBits);
				}
				if (distance >= 0x2000) length++;
				if (distance >= 0x40000) length++;
				rememberDistance(distance);
				this.#lastDistance = distance;
				this.#lastLength = length;
				copyMatch(distance, length);
			} else if (symbol === 256) {
				if (bits.read(1) !== 0) {
					readTables();
				} else {
					const newTable = bits.read(1) !== 0;
					if (newTable) readTables();
					break;
				}
			} else if (symbol === 257) {
				readFilter();
			} else if (symbol === 258) {
				if (this.#lastLength !== 0) copyMatch(this.#lastDistance, this.#lastLength);
			} else if (symbol < 263) {
				const index = symbol - 259;
				const distance = this.#oldDistances[index]!;
				for (let i = index; i > 0; i--) this.#oldDistances[i] = this.#oldDistances[i - 1]!;
				this.#oldDistances[0] = distance;
				const slot = lengthDecoder.decode(bits);
				const length = LEN_BASE[slot]! + 2 + bits.read(LEN_BITS[slot]!);
				this.#lastDistance = distance;
				this.#lastLength = length;
				copyMatch(distance, length);
			} else {
				const slot = symbol - 263;
				const distance = SHORT_DIST_BASE[slot]! + 1 + bits.read(SHORT_DIST_BITS[slot]!);
				rememberDistance(distance);
				this.#lastDistance = distance;
				this.#lastLength = 2;
				copyMatch(distance, 2);
			}
		}
		if (outputPosition !== outputEnd)
			corrupt(`decompressed size mismatch (${outputPosition - outputStart} != ${unpackedSize})`);
		const extracted = output.slice(outputStart, outputEnd);
		applyFilters(extracted, filters);
		this.#history = output.slice(Math.max(0, outputEnd - dictionarySize), outputEnd);
		return extracted;
	}
}

class VmBits {
	readonly #bytes: Uint8Array;
	#position = 0;

	constructor(bytes: Uint8Array) {
		this.#bytes = bytes;
	}

	read(count: number): number {
		let value = 0;
		for (let left = count; left > 0; ) {
			const bytePosition = this.#position >>> 3;
			if (bytePosition >= this.#bytes.byteLength) corrupt("truncated RarVM code");
			const bitPosition = this.#position & 7;
			const take = Math.min(left, 8 - bitPosition);
			value = value * 2 ** take + ((this.#bytes[bytePosition]! >>> (8 - bitPosition - take)) & (2 ** take - 1));
			this.#position += take;
			left -= take;
		}
		return value;
	}

	readData(): number {
		const prefix = this.read(2);
		if (prefix === 0) return this.read(4);
		if (prefix === 1) {
			const first = this.read(4);
			if (first === 0) return this.read(8) | 0xffffff00 | 0;
			return first * 16 + this.read(4);
		}
		if (prefix === 2) return this.read(16);
		return this.read(16) * 0x10000 + this.read(16);
	}
}

function identifyFilter(program: Uint8Array): number {
	const checksum = crc32(program);
	if (program.byteLength === 53 && checksum === 0xad576887) return 1;
	if (program.byteLength === 57 && checksum === 0x3cd7e57e) return 2;
	if (program.byteLength === 29 && checksum === 0x0e06077d) return 6;
	if (program.byteLength === 120 && checksum === 0x3769893f) return 3;
	if (program.byteLength === 149 && checksum === 0x1c2c5dc8) return 4;
	if (program.byteLength === 216 && checksum === 0xbc85e701) return 5;
	if (program.byteLength === 40 && checksum === 0x46b9c560) return 7;
	return 0;
}

function applyFilters(output: Uint8Array, filters: PendingFilter[]): void {
	for (const filter of filters) {
		const data = output.subarray(filter.start, filter.start + filter.size);
		if (filter.type === 6) {
			const source = data.slice();
			let sourcePosition = 0;
			for (let channel = 0; channel < filter.channels; channel++) {
				let previous = 0;
				for (let position = channel; position < data.byteLength; position += filter.channels) {
					previous = (previous - source[sourcePosition++]!) & 0xff;
					data[position] = previous;
				}
			}
			continue;
		}
		const compareOpcode = filter.type === 2 ? 0xe9 : 0xe8;
		for (let position = 0; position + 4 < data.byteLength; ) {
			const opcode = data[position++]!;
			if (opcode !== 0xe8 && opcode !== compareOpcode) continue;
			const offset = position + (filter.fileOffset >>> 0);
			const address = readInt32(data, position);
			if (address < 0) {
				if (address + offset >= 0) writeInt32(data, position, address + 0x1000000);
			} else if (address - 0x1000000 < 0) {
				writeInt32(data, position, address - offset);
			}
			position += 4;
		}
	}
}

function readInt32(bytes: Uint8Array, offset: number): number {
	return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16) | (bytes[offset + 3]! << 24);
}

function writeInt32(bytes: Uint8Array, offset: number, value: number): void {
	bytes[offset] = value;
	bytes[offset + 1] = value >>> 8;
	bytes[offset + 2] = value >>> 16;
	bytes[offset + 3] = value >>> 24;
}

function readLengthTable(bits: Bits, previous: Uint8Array, size: number): Uint8Array {
	const preLengths = new Uint8Array(20);
	for (let index = 0; index < 20; index++) {
		const length = bits.read(4);
		if (length === 15) {
			let zeroCount = bits.read(4);
			if (zeroCount !== 0) {
				zeroCount += 2;
				while (zeroCount-- > 0 && index < 20) preLengths[index++] = 0;
				index--;
				continue;
			}
		}
		preLengths[index] = length;
	}
	const preTable = new Huffman(20);
	preTable.build(preLengths, 0, 20);
	const lengths = new Uint8Array(size);
	for (let position = 0; position < size; ) {
		const symbol = preTable.decode(bits);
		if (symbol < 16) {
			lengths[position] = (symbol + previous[position]!) & 15;
			position++;
		} else if (symbol === 16 || symbol === 17) {
			let count = bits.read(symbol === 16 ? 3 : 7) + (symbol === 16 ? 3 : 11);
			const value = position === 0 ? 0 : lengths[position - 1]!;
			while (count-- > 0 && position < size) lengths[position++] = value;
		} else {
			let count = bits.read(symbol === 18 ? 3 : 7) + (symbol === 18 ? 3 : 11);
			while (count-- > 0 && position < size) lengths[position++] = 0;
		}
	}
	return lengths;
}

function corrupt(reason: string): never {
	throw new ArchiveError(`Invalid RAR4 archive: ${reason}`);
}
