import { ArchiveError } from "../error";

const TOP_VALUE = 1 << 24;
const BIT_MODEL_TOTAL = 1 << 11;
const MOVE_BITS = 5;
const LITERAL_SIZE = 0x300;
const NUM_STATES = 12;
const NUM_POS_STATES_MAX = 16;
const MATCH_MIN_LEN = 2;

class RangeDecoder {
	readonly bytes: Uint8Array;
	pos = 0;
	range = 0xffffffff;
	code = 0;

	constructor(bytes: Uint8Array) {
		this.bytes = bytes;
		if (bytes.byteLength < 5 || bytes[0] !== 0) throw new ArchiveError("Invalid LZMA range-coded stream");
		for (let index = 0; index < 5; index++) this.code = ((this.code << 8) | bytes[this.pos++]!) >>> 0;
	}

	#normalize(): void {
		if (this.range < TOP_VALUE) {
			if (this.pos >= this.bytes.byteLength) throw new ArchiveError("Invalid LZMA stream: truncated range data");
			this.range = (this.range << 8) >>> 0;
			this.code = ((this.code << 8) | this.bytes[this.pos++]!) >>> 0;
		}
	}

	decodeBit(probs: Uint16Array, index: number): number {
		this.#normalize();
		const probability = probs[index]!;
		const bound = Math.imul(this.range >>> 11, probability) >>> 0;
		if (this.code < bound) {
			this.range = bound;
			probs[index] = probability + ((BIT_MODEL_TOTAL - probability) >>> MOVE_BITS);
			return 0;
		}
		this.range = (this.range - bound) >>> 0;
		this.code = (this.code - bound) >>> 0;
		probs[index] = probability - (probability >>> MOVE_BITS);
		return 1;
	}

	decodeDirectBits(count: number): number {
		let result = 0;
		for (let index = 0; index < count; index++) {
			this.#normalize();
			this.range >>>= 1;
			let bit = 0;
			if (this.code >= this.range) {
				this.code = (this.code - this.range) >>> 0;
				bit = 1;
			}
			result = ((result << 1) | bit) >>> 0;
		}
		return result;
	}
}

function initializedProbabilities(size: number): Uint16Array {
	const probabilities = new Uint16Array(size);
	probabilities.fill(BIT_MODEL_TOTAL >>> 1);
	return probabilities;
}

class LengthDecoder {
	readonly choice = initializedProbabilities(2);
	readonly low = initializedProbabilities(NUM_POS_STATES_MAX << 3);
	readonly mid = initializedProbabilities(NUM_POS_STATES_MAX << 3);
	readonly high = initializedProbabilities(1 << 8);

	reset(): void {
		this.choice.fill(BIT_MODEL_TOTAL >>> 1);
		this.low.fill(BIT_MODEL_TOTAL >>> 1);
		this.mid.fill(BIT_MODEL_TOTAL >>> 1);
		this.high.fill(BIT_MODEL_TOTAL >>> 1);
	}

	decode(range: RangeDecoder, posState: number): number {
		if (range.decodeBit(this.choice, 0) === 0) return decodeTree(range, this.low, posState << 3, 3);
		if (range.decodeBit(this.choice, 1) === 0) return 8 + decodeTree(range, this.mid, posState << 3, 3);
		return 16 + decodeTree(range, this.high, 0, 8);
	}
}

function decodeTree(range: RangeDecoder, probs: Uint16Array, offset: number, bits: number): number {
	let symbol = 1;
	for (let index = 0; index < bits; index++) symbol = (symbol << 1) | range.decodeBit(probs, offset + symbol);
	return symbol - (1 << bits);
}

function decodeReverseTree(range: RangeDecoder, probs: Uint16Array, offset: number, bits: number): number {
	let symbol = 1;
	let result = 0;
	for (let index = 0; index < bits; index++) {
		const bit = range.decodeBit(probs, offset + symbol);
		symbol = (symbol << 1) | bit;
		result |= bit << index;
	}
	return result >>> 0;
}

interface LzmaProperties {
	lc: number;
	lp: number;
	pb: number;
	dictionarySize: number;
}

function parseLzmaProperties(props: Uint8Array): LzmaProperties {
	if (props.byteLength !== 5) throw new ArchiveError("Invalid LZMA properties: expected 5 bytes");
	let packed = props[0]!;
	if (packed >= 9 * 5 * 5) throw new ArchiveError("Invalid LZMA properties");
	const lc = packed % 9;
	packed = Math.floor(packed / 9);
	const lp = packed % 5;
	const pb = Math.floor(packed / 5);
	const dictionarySize = (props[1]! | (props[2]! << 8) | (props[3]! << 16) | (props[4]! << 24)) >>> 0;
	return { lc, lp, pb, dictionarySize: Math.max(dictionarySize, 4096) };
}

class LzmaDecoder {
	readonly #output: Uint8Array;
	readonly #dictionarySize: number;
	#outputPos = 0;
	#dictionaryStart = 0;
	#processed = 0;
	#lc = 0;
	#lp = 0;
	#pb = 0;
	#state = 0;
	#rep0 = 1;
	#rep1 = 1;
	#rep2 = 1;
	#rep3 = 1;
	#literal = initializedProbabilities(LITERAL_SIZE);
	readonly #isMatch = initializedProbabilities(NUM_STATES * NUM_POS_STATES_MAX);
	readonly #isRep = initializedProbabilities(NUM_STATES);
	readonly #isRepG0 = initializedProbabilities(NUM_STATES);
	readonly #isRepG1 = initializedProbabilities(NUM_STATES);
	readonly #isRepG2 = initializedProbabilities(NUM_STATES);
	readonly #isRep0Long = initializedProbabilities(NUM_STATES * NUM_POS_STATES_MAX);
	readonly #posSlot = initializedProbabilities(4 << 6);
	readonly #posDecoders = initializedProbabilities(115);
	readonly #align = initializedProbabilities(16);
	readonly #len = new LengthDecoder();
	readonly #repLen = new LengthDecoder();

	constructor(output: Uint8Array, props: LzmaProperties) {
		this.#output = output;
		this.#dictionarySize = props.dictionarySize;
		this.setProperties(props.lc, props.lp, props.pb);
		this.resetDictionary();
	}

	get outputPos(): number {
		return this.#outputPos;
	}

	setProperties(lc: number, lp: number, pb: number): void {
		if (lc > 8 || lp > 4 || pb > 4 || lc + lp > 12) throw new ArchiveError("Invalid LZMA properties");
		this.#lc = lc;
		this.#lp = lp;
		this.#pb = pb;
		const literalCount = LITERAL_SIZE * 2 ** (lc + lp);
		if (this.#literal.length !== literalCount) this.#literal = initializedProbabilities(literalCount);
	}

	resetDictionary(): void {
		this.#dictionaryStart = this.#outputPos;
		this.#processed = 0;
		this.resetState();
	}

	resetState(): void {
		this.#state = 0;
		this.#rep0 = this.#rep1 = this.#rep2 = this.#rep3 = 1;
		this.#literal.fill(BIT_MODEL_TOTAL >>> 1);
		this.#isMatch.fill(BIT_MODEL_TOTAL >>> 1);
		this.#isRep.fill(BIT_MODEL_TOTAL >>> 1);
		this.#isRepG0.fill(BIT_MODEL_TOTAL >>> 1);
		this.#isRepG1.fill(BIT_MODEL_TOTAL >>> 1);
		this.#isRepG2.fill(BIT_MODEL_TOTAL >>> 1);
		this.#isRep0Long.fill(BIT_MODEL_TOTAL >>> 1);
		this.#posSlot.fill(BIT_MODEL_TOTAL >>> 1);
		this.#posDecoders.fill(BIT_MODEL_TOTAL >>> 1);
		this.#align.fill(BIT_MODEL_TOTAL >>> 1);
		this.#len.reset();
		this.#repLen.reset();
	}

	appendUncompressed(bytes: Uint8Array, resetDictionary: boolean): void {
		if (resetDictionary) this.resetDictionary();
		if (bytes.byteLength > this.#output.byteLength - this.#outputPos)
			throw new ArchiveError("LZMA2 output exceeds its limit");
		this.#output.set(bytes, this.#outputPos);
		this.#outputPos += bytes.byteLength;
		this.#processed += bytes.byteLength;
	}

	decodeChunk(bytes: Uint8Array, outputSize: number, allowEndMarker = false): boolean {
		if (
			!Number.isSafeInteger(outputSize) ||
			outputSize < 0 ||
			outputSize > this.#output.byteLength - this.#outputPos
		) {
			throw new ArchiveError("LZMA output exceeds its declared size");
		}
		const limit = this.#outputPos + outputSize;
		const range = new RangeDecoder(bytes);
		const posMask = (1 << this.#pb) - 1;
		const literalPosMask = (1 << this.#lp) - 1;

		while (this.#outputPos < limit || allowEndMarker) {
			const posState = this.#processed & posMask;
			if (range.decodeBit(this.#isMatch, (this.#state << 4) + posState) === 0) {
				const previous = this.#outputPos === this.#dictionaryStart ? 0 : this.#output[this.#outputPos - 1]!;
				const context =
					(((this.#processed & literalPosMask) << this.#lc) + (previous >>> (8 - this.#lc))) * LITERAL_SIZE;
				let symbol = 1;
				if (this.#state >= 7) {
					this.#assertDistance(this.#rep0);
					let matchByte = this.#output[this.#outputPos - this.#rep0]!;
					while (symbol < 0x100) {
						const matchBit = (matchByte >>> 7) & 1;
						matchByte = (matchByte << 1) & 0xff;
						const bit = range.decodeBit(this.#literal, context + ((1 + matchBit) << 8) + symbol);
						symbol = (symbol << 1) | bit;
						if (matchBit !== bit) break;
					}
				}
				while (symbol < 0x100) symbol = (symbol << 1) | range.decodeBit(this.#literal, context + symbol);
				if (this.#outputPos >= limit)
					throw new ArchiveError("LZMA output exceeds its size limit before the end marker");
				this.#output[this.#outputPos++] = symbol & 0xff;
				this.#processed++;
				this.#state = this.#state < 4 ? 0 : this.#state < 10 ? this.#state - 3 : this.#state - 6;
				continue;
			}

			let length: number;
			if (range.decodeBit(this.#isRep, this.#state) === 1) {
				if (range.decodeBit(this.#isRepG0, this.#state) === 0) {
					if (range.decodeBit(this.#isRep0Long, (this.#state << 4) + posState) === 0) {
						this.#state = this.#state < 7 ? 9 : 11;
						this.#copyMatch(this.#rep0, 1, limit);
						continue;
					}
				} else {
					let distance: number;
					if (range.decodeBit(this.#isRepG1, this.#state) === 0) distance = this.#rep1;
					else {
						if (range.decodeBit(this.#isRepG2, this.#state) === 0) distance = this.#rep2;
						else {
							distance = this.#rep3;
							this.#rep3 = this.#rep2;
						}
						this.#rep2 = this.#rep1;
					}
					this.#rep1 = this.#rep0;
					this.#rep0 = distance;
				}
				length = this.#repLen.decode(range, posState) + MATCH_MIN_LEN;
				this.#state = this.#state < 7 ? 8 : 11;
			} else {
				this.#rep3 = this.#rep2;
				this.#rep2 = this.#rep1;
				this.#rep1 = this.#rep0;
				length = this.#len.decode(range, posState) + MATCH_MIN_LEN;
				this.#state = this.#state < 7 ? 7 : 10;
				const lenState = Math.min(length - MATCH_MIN_LEN, 3);
				const slot = decodeTree(range, this.#posSlot, lenState << 6, 6);
				let distance: number;
				if (slot < 4) distance = slot;
				else {
					const directBits = (slot >>> 1) - 1;
					distance = ((2 | (slot & 1)) << directBits) >>> 0;
					if (slot < 14)
						distance =
							(distance + decodeReverseTree(range, this.#posDecoders, distance - slot, directBits)) >>> 0;
					else {
						distance = (distance + (range.decodeDirectBits(directBits - 4) << 4)) >>> 0;
						distance = (distance + decodeReverseTree(range, this.#align, 0, 4)) >>> 0;
						if (distance === 0xffffffff) {
							if (allowEndMarker) return true;
							throw new ArchiveError("LZMA stream ended before its declared output size");
						}
					}
				}
				this.#rep0 = (distance + 1) >>> 0;
			}
			this.#copyMatch(this.#rep0, length, limit);
		}
		return false;
	}

	#assertDistance(distance: number): void {
		const available = this.#outputPos - this.#dictionaryStart;
		if (distance < 1 || distance > available || distance > this.#dictionarySize) {
			throw new ArchiveError(`Invalid LZMA match distance ${distance} with ${available} bytes available`);
		}
	}

	#copyMatch(distance: number, length: number, limit: number): void {
		this.#assertDistance(distance);
		if (length > limit - this.#outputPos) throw new ArchiveError("LZMA match exceeds its declared output size");
		for (let index = 0; index < length; index++) {
			this.#output[this.#outputPos] = this.#output[this.#outputPos - distance]!;
			this.#outputPos++;
		}
		this.#processed += length;
	}
}

/** Decompress a raw LZMA1 stream using the standard five-byte properties. */
export async function lzmaDecompress(props: Uint8Array, bytes: Uint8Array, outSize: number): Promise<Uint8Array> {
	if (!Number.isSafeInteger(outSize) || outSize < 0) throw new ArchiveError("Invalid LZMA output size");
	try {
		const output = new Uint8Array(outSize);
		const decoder = new LzmaDecoder(output, parseLzmaProperties(props));
		decoder.decodeChunk(bytes, outSize);
		if (decoder.outputPos !== outSize) throw new ArchiveError("LZMA output size mismatch");
		return output;
	} catch (error) {
		if (error instanceof ArchiveError) throw error;
		throw new ArchiveError(`Invalid LZMA stream: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Decompress an LZMA-alone container, including unknown-size end-marked streams. */
export async function lzmaAloneDecompress(bytes: Uint8Array, maxOutput: number): Promise<Uint8Array> {
	if (bytes.byteLength < 13) throw new ArchiveError("Invalid LZMA-alone stream: truncated header");
	if (!Number.isSafeInteger(maxOutput) || maxOutput < 0) throw new ArchiveError("Invalid LZMA output limit");
	const props = bytes.subarray(0, 5);
	let unknownSize = true;
	let declaredSize = 0;
	for (let index = 0; index < 8; index++) {
		const value = bytes[5 + index]!;
		if (value !== 0xff) unknownSize = false;
		declaredSize += value * 2 ** (index * 8);
	}
	if (!unknownSize) {
		if (!Number.isSafeInteger(declaredSize) || declaredSize > maxOutput) {
			throw new ArchiveError("LZMA-alone output exceeds its size limit");
		}
		return lzmaDecompress(props, bytes.subarray(13), declaredSize);
	}
	try {
		const output = new Uint8Array(maxOutput);
		const decoder = new LzmaDecoder(output, parseLzmaProperties(props));
		if (!decoder.decodeChunk(bytes.subarray(13), maxOutput, true)) {
			throw new ArchiveError("LZMA-alone output exceeds its size limit before the end marker");
		}
		return output.subarray(0, decoder.outputPos);
	} catch (error) {
		if (error instanceof ArchiveError) throw error;
		throw new ArchiveError(`Invalid LZMA-alone stream: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Decompress an LZMA2 stream, enforcing its dictionary and output limits. */
export async function lzma2Decompress(dictSizeProp: number, bytes: Uint8Array, maxOutput: number): Promise<Uint8Array> {
	if (!Number.isInteger(dictSizeProp) || dictSizeProp < 0 || dictSizeProp > 40)
		throw new ArchiveError("Unsupported LZMA2 dictionary property");
	if (!Number.isSafeInteger(maxOutput) || maxOutput < 0) throw new ArchiveError("Invalid LZMA2 output limit");
	const dictionarySize =
		dictSizeProp === 40 ? 0xffffffff : (2 | (dictSizeProp & 1)) * 2 ** (Math.floor(dictSizeProp / 2) + 11);
	const output = new Uint8Array(maxOutput);
	const decoder = new LzmaDecoder(output, { lc: 3, lp: 0, pb: 2, dictionarySize });
	let pos = 0;
	let needDictionaryReset = true;
	let propertiesSet = false;

	const takeByte = (): number => {
		if (pos >= bytes.byteLength) throw new ArchiveError("Invalid LZMA2 stream: truncated chunk header");
		return bytes[pos++]!;
	};

	try {
		for (;;) {
			const control = takeByte();
			if (control === 0) break;
			if (control < 0x80) {
				if (control !== 1 && control !== 2)
					throw new ArchiveError(`Invalid LZMA2 control byte 0x${control.toString(16)}`);
				if (control === 2 && needDictionaryReset)
					throw new ArchiveError("Invalid LZMA2 stream: dictionary was not initialized");
				const unpackSize = (takeByte() << 8) + takeByte() + 1;
				if (unpackSize > maxOutput - decoder.outputPos || unpackSize > bytes.byteLength - pos) {
					throw new ArchiveError("Invalid LZMA2 uncompressed chunk size");
				}
				decoder.appendUncompressed(bytes.subarray(pos, pos + unpackSize), control === 1);
				pos += unpackSize;
				if (control === 1) {
					needDictionaryReset = false;
					propertiesSet = false;
				}
				continue;
			}

			const unpackSize = ((control & 0x1f) << 16) + (takeByte() << 8) + takeByte() + 1;
			const packSize = (takeByte() << 8) + takeByte() + 1;
			const resetsDictionary = control >= 0xe0;
			const resetsState = control >= 0xa0;
			const setsProperties = control >= 0xc0;
			if (needDictionaryReset && !resetsDictionary)
				throw new ArchiveError("Invalid LZMA2 stream: dictionary was not initialized");
			if (!propertiesSet && !setsProperties)
				throw new ArchiveError("Invalid LZMA2 stream: properties were not initialized");
			if (setsProperties) {
				let property = takeByte();
				if (property >= 9 * 5 * 5) throw new ArchiveError("Invalid LZMA2 properties");
				const lc = property % 9;
				property = Math.floor(property / 9);
				const lp = property % 5;
				const pb = Math.floor(property / 5);
				if (lc + lp > 4) throw new ArchiveError("Invalid LZMA2 literal properties");
				decoder.setProperties(lc, lp, pb);
				propertiesSet = true;
			}
			if (packSize > bytes.byteLength - pos || unpackSize > maxOutput - decoder.outputPos)
				throw new ArchiveError("Invalid LZMA2 chunk size");
			if (resetsDictionary) decoder.resetDictionary();
			else if (resetsState) decoder.resetState();
			decoder.decodeChunk(bytes.subarray(pos, pos + packSize), unpackSize);
			pos += packSize;
			needDictionaryReset = false;
		}
		if (pos !== bytes.byteLength) throw new ArchiveError("Invalid LZMA2 stream: trailing data");
		return output.subarray(0, decoder.outputPos);
	} catch (error) {
		if (error instanceof ArchiveError) throw error;
		throw new ArchiveError(`Invalid LZMA2 stream: ${error instanceof Error ? error.message : String(error)}`);
	}
}
