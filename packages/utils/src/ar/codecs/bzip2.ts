import { ArchiveError } from "../error";

const BLOCK_MAGIC = [0x31, 0x41, 0x59, 0x26, 0x53, 0x59] as const;
const STREAM_END_MAGIC = [0x17, 0x72, 0x45, 0x38, 0x50, 0x90] as const;
const MAX_HUFFMAN_LENGTH = 20;
const MAX_SELECTORS = 18_002;
const GROUP_SIZE = 50;

// The fixed randomization sequence from the original bzip2 format. Randomized
// blocks are obsolete, but remain part of the bitstream and occur in old data.
const RANDOM_NUMBERS = new Uint16Array([
	619, 720, 127, 481, 931, 816, 813, 233, 566, 247, 985, 724, 205, 454, 863, 491, 741, 242, 949, 214, 733, 859, 335,
	708, 621, 574, 73, 654, 730, 472, 419, 436, 278, 496, 867, 210, 399, 680, 480, 51, 878, 465, 811, 169, 869, 675, 611,
	697, 867, 561, 862, 687, 507, 283, 482, 129, 807, 591, 733, 623, 150, 238, 59, 379, 684, 877, 625, 169, 643, 105,
	170, 607, 520, 932, 727, 476, 693, 425, 174, 647, 73, 122, 335, 530, 442, 853, 695, 249, 445, 515, 909, 545, 703,
	919, 874, 474, 882, 500, 594, 612, 641, 801, 220, 162, 819, 984, 589, 513, 495, 799, 161, 604, 958, 533, 221, 400,
	386, 867, 600, 782, 382, 596, 414, 171, 516, 375, 682, 485, 911, 276, 98, 553, 163, 354, 666, 933, 424, 341, 533,
	870, 227, 730, 475, 186, 263, 647, 537, 686, 600, 224, 469, 68, 770, 919, 190, 373, 294, 822, 808, 206, 184, 943,
	795, 384, 383, 461, 404, 758, 839, 887, 715, 67, 618, 276, 204, 918, 873, 777, 604, 560, 951, 160, 578, 722, 79, 804,
	96, 409, 713, 940, 652, 934, 970, 447, 318, 353, 859, 672, 112, 785, 645, 863, 803, 350, 139, 93, 354, 99, 820, 908,
	609, 772, 154, 274, 580, 184, 79, 626, 630, 742, 653, 282, 762, 623, 680, 81, 927, 626, 789, 125, 411, 521, 938, 300,
	821, 78, 343, 175, 128, 250, 170, 774, 972, 275, 999, 639, 495, 78, 352, 126, 857, 956, 358, 619, 580, 124, 737, 594,
	701, 612, 669, 112, 134, 694, 363, 992, 809, 743, 168, 974, 944, 375, 748, 52, 600, 747, 642, 182, 862, 81, 344, 805,
	988, 739, 511, 655, 814, 334, 249, 515, 897, 955, 664, 981, 649, 113, 974, 459, 893, 228, 433, 837, 553, 268, 926,
	240, 102, 654, 459, 51, 686, 754, 806, 760, 493, 403, 415, 394, 687, 700, 946, 670, 656, 610, 738, 392, 760, 799,
	887, 653, 978, 321, 576, 617, 626, 502, 894, 679, 243, 440, 680, 879, 194, 572, 640, 724, 926, 56, 204, 700, 707,
	151, 457, 449, 797, 195, 791, 558, 945, 679, 297, 59, 87, 824, 713, 663, 412, 693, 342, 606, 134, 108, 571, 364, 631,
	212, 174, 643, 304, 329, 343, 97, 430, 751, 497, 314, 983, 374, 822, 928, 140, 206, 73, 263, 980, 736, 876, 478, 430,
	305, 170, 514, 364, 692, 829, 82, 855, 953, 676, 246, 369, 970, 294, 750, 807, 827, 150, 790, 288, 923, 804, 378,
	215, 828, 592, 281, 565, 555, 710, 82, 896, 831, 547, 261, 524, 462, 293, 465, 502, 56, 661, 821, 976, 991, 658, 869,
	905, 758, 745, 193, 768, 550, 608, 933, 378, 286, 215, 979, 792, 961, 61, 688, 793, 644, 986, 403, 106, 366, 905,
	644, 372, 567, 466, 434, 645, 210, 389, 550, 919, 135, 780, 773, 635, 389, 707, 100, 626, 958, 165, 504, 920, 176,
	193, 713, 857, 265, 203, 50, 668, 108, 645, 990, 626, 197, 510, 357, 358, 850, 858, 364, 936, 638,
]);

const CRC_TABLE = makeCrcTable();

function makeCrcTable(): Uint32Array {
	const table = new Uint32Array(256);
	for (let index = 0; index < table.length; index++) {
		let value = index << 24;
		for (let bit = 0; bit < 8; bit++) {
			value = (value & 0x8000_0000) !== 0 ? (value << 1) ^ 0x04c1_1db7 : value << 1;
		}
		table[index] = value >>> 0;
	}
	return table;
}

function updateCrc(crc: number, byte: number): number {
	return (CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]! ^ (crc << 8)) >>> 0;
}

class BitReader {
	readonly #bytes: Uint8Array;
	#bitPosition = 0;

	constructor(bytes: Uint8Array) {
		this.#bytes = bytes;
	}

	get done(): boolean {
		return this.#bitPosition === this.#bytes.byteLength * 8;
	}

	readBit(): number {
		if (this.#bitPosition >= this.#bytes.byteLength * 8) {
			throw new ArchiveError("Truncated bzip2 stream");
		}
		const byte = this.#bytes[this.#bitPosition >>> 3]!;
		const bit = (byte >>> (7 - (this.#bitPosition & 7))) & 1;
		this.#bitPosition++;
		return bit;
	}

	readBits(count: number): number {
		let value = 0;
		for (let bit = 0; bit < count; bit++) {
			value = value * 2 + this.readBit();
		}
		return value;
	}

	readUint32(): number {
		return (this.readBits(16) * 0x1_0000 + this.readBits(16)) >>> 0;
	}

	readMarker(): readonly number[] {
		return [
			this.readBits(8),
			this.readBits(8),
			this.readBits(8),
			this.readBits(8),
			this.readBits(8),
			this.readBits(8),
		];
	}

	alignToByte(): void {
		while ((this.#bitPosition & 7) !== 0) {
			if (this.readBit() !== 0) {
				throw new ArchiveError("Invalid non-zero bzip2 stream padding");
			}
		}
	}
}

class BoundedOutput {
	readonly #limit: number;
	#bytes: Uint8Array;
	#length = 0;

	constructor(limit: number, inputSize: number) {
		this.#limit = limit;
		this.#bytes = new Uint8Array(Math.min(limit, Math.max(64, Math.min(inputSize * 2, 64 * 1024))));
	}

	push(byte: number): void {
		this.#ensure(1);
		this.#bytes[this.#length++] = byte;
	}

	pushRepeated(byte: number, count: number): void {
		this.#ensure(count);
		this.#bytes.fill(byte, this.#length, this.#length + count);
		this.#length += count;
	}

	finish(): Uint8Array {
		return this.#bytes.slice(0, this.#length);
	}

	#ensure(additional: number): void {
		const needed = this.#length + additional;
		if (!Number.isSafeInteger(needed) || needed > this.#limit) {
			throw new ArchiveError(`Bzip2 output exceeds the ${this.#limit}-byte limit`);
		}
		if (needed <= this.#bytes.byteLength) {
			return;
		}
		let capacity = Math.max(needed, Math.min(this.#limit, Math.max(64, this.#bytes.byteLength * 2)));
		if (capacity > this.#limit) {
			capacity = this.#limit;
		}
		const grown = new Uint8Array(capacity);
		grown.set(this.#bytes.subarray(0, this.#length));
		this.#bytes = grown;
	}
}

class HuffmanTable {
	readonly #counts = new Uint16Array(MAX_HUFFMAN_LENGTH + 1);
	readonly #firstCodes = new Uint32Array(MAX_HUFFMAN_LENGTH + 1);
	readonly #offsets = new Uint16Array(MAX_HUFFMAN_LENGTH + 1);
	readonly #symbols: Uint16Array;

	constructor(lengths: Uint8Array) {
		for (const length of lengths) {
			if (length < 1 || length > MAX_HUFFMAN_LENGTH) {
				throw new ArchiveError("Invalid bzip2 Huffman code length");
			}
			this.#counts[length]++;
		}

		let code = 0;
		let offset = 0;
		for (let length = 1; length <= MAX_HUFFMAN_LENGTH; length++) {
			code = (code + this.#counts[length - 1]!) * 2;
			if (code + this.#counts[length]! > 2 ** length) {
				throw new ArchiveError("Oversubscribed bzip2 Huffman table");
			}
			this.#firstCodes[length] = code;
			this.#offsets[length] = offset;
			offset += this.#counts[length]!;
		}

		this.#symbols = new Uint16Array(lengths.length);
		const next = new Uint16Array(this.#offsets);
		for (let symbol = 0; symbol < lengths.length; symbol++) {
			const length = lengths[symbol]!;
			this.#symbols[next[length]!] = symbol;
			next[length]++;
		}
	}

	decode(reader: BitReader): number {
		let code = 0;
		for (let length = 1; length <= MAX_HUFFMAN_LENGTH; length++) {
			code = code * 2 + reader.readBit();
			const relative = code - this.#firstCodes[length]!;
			if (relative >= 0 && relative < this.#counts[length]!) {
				return this.#symbols[this.#offsets[length]! + relative]!;
			}
		}
		throw new ArchiveError("Invalid bzip2 Huffman code");
	}
}

function markerEquals(actual: readonly number[], expected: readonly number[]): boolean {
	return actual.every((byte, index) => byte === expected[index]);
}

function readStreamHeader(reader: BitReader): number {
	if (reader.readBits(8) !== 0x42 || reader.readBits(8) !== 0x5a || reader.readBits(8) !== 0x68) {
		throw new ArchiveError("Invalid bzip2 stream header");
	}
	const level = reader.readBits(8) - 0x30;
	if (level < 1 || level > 9) {
		throw new ArchiveError("Invalid bzip2 block-size level");
	}
	return level * 100_000;
}

function readHuffmanTables(
	reader: BitReader,
	usedBytes: Uint8Array,
): { selectors: Uint8Array; tables: HuffmanTable[] } {
	const groupCount = reader.readBits(3);
	if (groupCount < 2 || groupCount > 6) {
		throw new ArchiveError("Invalid bzip2 Huffman group count");
	}
	const selectorCount = reader.readBits(15);
	if (selectorCount < 1 || selectorCount > MAX_SELECTORS) {
		throw new ArchiveError("Invalid bzip2 selector count");
	}

	const selectors = new Uint8Array(selectorCount);
	const selectorMtf = new Uint8Array(groupCount);
	for (let index = 0; index < groupCount; index++) {
		selectorMtf[index] = index;
	}
	for (let index = 0; index < selectorCount; index++) {
		let position = 0;
		while (reader.readBit() !== 0) {
			position++;
			if (position >= groupCount) {
				throw new ArchiveError("Invalid bzip2 selector MTF value");
			}
		}
		const selector = selectorMtf[position]!;
		selectors[index] = selector;
		selectorMtf.copyWithin(1, 0, position);
		selectorMtf[0] = selector;
	}

	const alphaSize = usedBytes.length + 2;
	const tables: HuffmanTable[] = [];
	for (let group = 0; group < groupCount; group++) {
		const lengths = new Uint8Array(alphaSize);
		let length = reader.readBits(5);
		for (let symbol = 0; symbol < alphaSize; symbol++) {
			while (reader.readBit() !== 0) {
				length += reader.readBit() === 0 ? 1 : -1;
				if (length < 1 || length > MAX_HUFFMAN_LENGTH) {
					throw new ArchiveError("Invalid bzip2 Huffman code length");
				}
			}
			lengths[symbol] = length;
		}
		tables.push(new HuffmanTable(lengths));
	}
	return { selectors, tables };
}

function decodeBlockData(
	reader: BitReader,
	blockSizeLimit: number,
	usedBytes: Uint8Array,
	selectors: Uint8Array,
	tables: HuffmanTable[],
): Uint8Array {
	const mtf = new Uint8Array(usedBytes);
	const block = new Uint8Array(blockSizeLimit);
	let blockLength = 0;
	let selectorIndex = 0;
	let groupRemaining = 0;
	let table: HuffmanTable | undefined;

	const nextSymbol = (): number => {
		if (groupRemaining === 0) {
			if (selectorIndex >= selectors.length) {
				throw new ArchiveError("Bzip2 block exhausted its Huffman selectors");
			}
			table = tables[selectors[selectorIndex++]!];
			groupRemaining = GROUP_SIZE;
		}
		groupRemaining--;
		return table!.decode(reader);
	};

	const append = (byte: number, count: number): void => {
		if (count < 0 || blockLength + count > blockSizeLimit) {
			throw new ArchiveError("Bzip2 block exceeds its declared block-size level");
		}
		block.fill(byte, blockLength, blockLength + count);
		blockLength += count;
	};

	const endSymbol = usedBytes.length + 1;
	let symbol = nextSymbol();
	while (symbol !== endSymbol) {
		if (symbol === 0 || symbol === 1) {
			let runLength = 0;
			let power = 1;
			do {
				runLength += symbol === 0 ? power : power * 2;
				if (runLength > blockSizeLimit || power > blockSizeLimit) {
					throw new ArchiveError("Invalid bzip2 RLE run length");
				}
				power *= 2;
				symbol = nextSymbol();
			} while (symbol === 0 || symbol === 1);
			append(mtf[0]!, runLength);
			if (symbol === endSymbol) {
				break;
			}
		}

		const position = symbol - 1;
		if (position < 0 || position >= mtf.length) {
			throw new ArchiveError("Invalid bzip2 MTF symbol");
		}
		const byte = mtf[position]!;
		mtf.copyWithin(1, 0, position);
		mtf[0] = byte;
		append(byte, 1);
		symbol = nextSymbol();
	}
	return block.slice(0, blockLength);
}

function inverseBwt(block: Uint8Array, originalPointer: number): Uint8Array {
	if (block.length === 0 || originalPointer < 0 || originalPointer >= block.length) {
		throw new ArchiveError("Invalid bzip2 BWT origin pointer");
	}
	const counts = new Uint32Array(257);
	for (const byte of block) {
		counts[byte + 1]++;
	}
	for (let index = 1; index < counts.length; index++) {
		counts[index] += counts[index - 1]!;
	}
	const positions = new Uint32Array(counts.subarray(0, 256));
	const next = new Uint32Array(block.length);
	for (let index = 0; index < block.length; index++) {
		const byte = block[index]!;
		next[positions[byte]!] = index;
		positions[byte]++;
	}
	const decoded = new Uint8Array(block.length);
	let position = next[originalPointer]!;
	for (let index = 0; index < decoded.length; index++) {
		decoded[index] = block[position]!;
		position = next[position]!;
	}
	return decoded;
}

function appendRle1(decoded: Uint8Array, randomized: boolean, output: BoundedOutput): number {
	let crc = 0xffff_ffff;
	let previous = -1;
	let repetitions = 0;
	let randomIndex = 0;
	let randomRemaining = 0;

	const appendByte = (byte: number): void => {
		output.push(byte);
		crc = updateCrc(crc, byte);
	};
	const appendRepeated = (byte: number, count: number): void => {
		output.pushRepeated(byte, count);
		for (let index = 0; index < count; index++) {
			crc = updateCrc(crc, byte);
		}
	};

	for (let byte of decoded) {
		if (randomized) {
			if (randomRemaining === 0) {
				randomRemaining = RANDOM_NUMBERS[randomIndex]!;
				randomIndex = (randomIndex + 1) & 511;
			}
			randomRemaining--;
			if (randomRemaining === 1) {
				byte ^= 1;
			}
		}

		if (repetitions === 4) {
			appendRepeated(previous, byte);
			repetitions = 0;
			continue;
		}
		appendByte(byte);
		if (byte === previous) {
			repetitions++;
		} else {
			previous = byte;
			repetitions = 1;
		}
	}
	if (repetitions === 4) {
		throw new ArchiveError("Truncated bzip2 RLE run");
	}
	return (crc ^ 0xffff_ffff) >>> 0;
}

function decode(bytes: Uint8Array, maxOutput: number): Uint8Array {
	if (!Number.isSafeInteger(maxOutput) || maxOutput < 0) {
		throw new ArchiveError("Invalid bzip2 output limit");
	}
	const reader = new BitReader(bytes);
	const output = new BoundedOutput(maxOutput, bytes.byteLength);

	for (;;) {
		const blockSizeLimit = readStreamHeader(reader);
		let combinedCrc = 0;
		for (;;) {
			const marker = reader.readMarker();
			if (markerEquals(marker, STREAM_END_MAGIC)) {
				const expectedCombinedCrc = reader.readUint32();
				if (combinedCrc !== expectedCombinedCrc) {
					throw new ArchiveError("Bzip2 stream CRC mismatch");
				}
				reader.alignToByte();
				break;
			}
			if (!markerEquals(marker, BLOCK_MAGIC)) {
				throw new ArchiveError("Invalid bzip2 block marker");
			}

			const expectedBlockCrc = reader.readUint32();
			const randomized = reader.readBit() !== 0;
			const originalPointer = reader.readBits(24);
			const usedRanges = reader.readBits(16);
			const used = new Uint8Array(256);
			let usedCount = 0;
			for (let range = 0; range < 16; range++) {
				if ((usedRanges & (0x8000 >>> range)) === 0) {
					continue;
				}
				for (let low = 0; low < 16; low++) {
					if (reader.readBit() !== 0) {
						used[usedCount++] = range * 16 + low;
					}
				}
			}
			if (usedCount === 0) {
				throw new ArchiveError("Bzip2 block has an empty symbol map");
			}
			const usedBytes = used.slice(0, usedCount);
			const { selectors, tables } = readHuffmanTables(reader, usedBytes);
			const block = decodeBlockData(reader, blockSizeLimit, usedBytes, selectors, tables);
			const decoded = inverseBwt(block, originalPointer);
			const actualBlockCrc = appendRle1(decoded, randomized, output);
			if (actualBlockCrc !== expectedBlockCrc) {
				throw new ArchiveError("Bzip2 block CRC mismatch");
			}
			combinedCrc = (((combinedCrc << 1) | (combinedCrc >>> 31)) ^ actualBlockCrc) >>> 0;
		}
		if (reader.done) {
			return output.finish();
		}
	}
}

/** Return whether bytes begin with a valid bzip2 stream signature. */
export function isBzip2(bytes: Uint8Array): boolean {
	return (
		bytes.byteLength >= 4 &&
		bytes[0] === 0x42 &&
		bytes[1] === 0x5a &&
		bytes[2] === 0x68 &&
		bytes[3]! >= 0x31 &&
		bytes[3]! <= 0x39
	);
}

/** Decompress concatenated bzip2 streams while enforcing a hard output bound. */
export async function bzip2Decompress(bytes: Uint8Array, maxOutput: number): Promise<Uint8Array> {
	try {
		return decode(bytes, maxOutput);
	} catch (error) {
		if (error instanceof ArchiveError) {
			throw error;
		}
		throw new ArchiveError(error instanceof Error ? error.message : String(error));
	}
}
