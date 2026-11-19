import { ArchiveError } from "../error";

const CLEAR_CODE = 256;
const FIRST_BLOCK_CODE = 257;
const MIN_BITS = 9;
const MAX_BITS = 16;

class LsbCodeReader {
	readonly #bytes: Uint8Array;
	#bitPosition = 0;
	#groupStart = 0;

	constructor(bytes: Uint8Array) {
		this.#bytes = bytes;
	}

	get remainingBits(): number {
		return this.#bytes.byteLength * 8 - this.#bitPosition;
	}

	read(width: number): number | undefined {
		if (this.remainingBits < width) {
			return undefined;
		}
		let value = 0;
		for (let bit = 0; bit < width; bit++) {
			const position = this.#bitPosition + bit;
			value += ((this.#bytes[position >>> 3]! >>> (position & 7)) & 1) * 2 ** bit;
		}
		this.#bitPosition += width;
		return value;
	}

	alignCodeGroup(width: number): void {
		const groupBits = width * 8;
		const aligned = this.#groupStart + Math.ceil((this.#bitPosition - this.#groupStart) / groupBits) * groupBits;
		if (aligned > this.#bytes.byteLength * 8) {
			throw new ArchiveError("Truncated compress (.Z) code group");
		}
		this.#bitPosition = aligned;
		this.#groupStart = aligned;
	}

	assertFinalPadding(): void {
		this.#assertZeroBits(this.#bytes.byteLength * 8);
	}

	#assertZeroBits(end: number): void {
		for (let position = this.#bitPosition; position < end; position++) {
			if (((this.#bytes[position >>> 3]! >>> (position & 7)) & 1) !== 0) {
				throw new ArchiveError("Invalid non-zero compress (.Z) padding");
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

	appendReversed(stack: Uint8Array, length: number): void {
		this.#ensure(length);
		for (let index = length - 1; index >= 0; index--) {
			this.#bytes[this.#length++] = stack[index]!;
		}
	}

	finish(): Uint8Array {
		return this.#bytes.slice(0, this.#length);
	}

	#ensure(additional: number): void {
		const needed = this.#length + additional;
		if (!Number.isSafeInteger(needed) || needed > this.#limit) {
			throw new ArchiveError(`Compress (.Z) output exceeds the ${this.#limit}-byte limit`);
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

function decode(bytes: Uint8Array, maxOutput: number): Uint8Array {
	if (!Number.isSafeInteger(maxOutput) || maxOutput < 0) {
		throw new ArchiveError("Invalid compress (.Z) output limit");
	}
	if (bytes.byteLength < 3) {
		throw new ArchiveError("Truncated compress (.Z) header");
	}
	if (bytes[0] !== 0x1f || bytes[1] !== 0x9d) {
		throw new ArchiveError("Invalid compress (.Z) header");
	}

	const flags = bytes[2]!;
	if ((flags & 0x60) !== 0) {
		throw new ArchiveError("Unsupported compress (.Z) header flags");
	}
	const maxBits = flags & 0x1f;
	if (maxBits < MIN_BITS || maxBits > MAX_BITS) {
		throw new ArchiveError(`Invalid compress (.Z) maximum code width ${maxBits}`);
	}
	const blockMode = (flags & 0x80) !== 0;
	const dictionaryLimit = 2 ** maxBits;
	const parents = new Uint16Array(dictionaryLimit);
	const suffixes = new Uint8Array(dictionaryLimit);
	const stack = new Uint8Array(dictionaryLimit);
	const reader = new LsbCodeReader(bytes.subarray(3));
	const output = new BoundedOutput(maxOutput, bytes.byteLength);

	let width = MIN_BITS;
	let dictionaryHead = blockMode ? FIRST_BLOCK_CODE : 256;
	let needsPreviousSuffix = false;

	for (;;) {
		const code = reader.read(width);
		if (code === undefined) {
			reader.assertFinalPadding();
			return output.finish();
		}
		if (code >= dictionaryHead) {
			throw new ArchiveError(`Corrupt compress (.Z) dictionary code ${code}`);
		}
		if (blockMode && code === CLEAR_CODE) {
			reader.alignCodeGroup(width);
			width = MIN_BITS;
			dictionaryHead = FIRST_BLOCK_CODE;
			needsPreviousSuffix = false;
			continue;
		}

		let current = code;
		let stackLength = 0;
		while (current >= 256) {
			if (current >= dictionaryHead || stackLength >= stack.length - 1) {
				throw new ArchiveError("Corrupt compress (.Z) dictionary chain");
			}
			stack[stackLength++] = suffixes[current]!;
			current = parents[current]!;
		}
		stack[stackLength++] = current;

		if (needsPreviousSuffix) {
			suffixes[dictionaryHead - 1] = current;
			if (code === dictionaryHead - 1) {
				stack[0] = current;
			}
		}
		output.appendReversed(stack, stackLength);

		if (dictionaryHead < dictionaryLimit) {
			needsPreviousSuffix = true;
			parents[dictionaryHead++] = code;
			if (dictionaryHead > 2 ** width && width < maxBits) {
				reader.alignCodeGroup(width);
				width++;
			}
		} else {
			needsPreviousSuffix = false;
		}
	}
}

/** Return whether bytes begin with the ncompress `.Z` magic number. */
export function isCompressZ(bytes: Uint8Array): boolean {
	return bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x9d;
}

/** Decompress an ncompress `.Z` stream while enforcing a hard output bound. */
export async function lzwDecompress(bytes: Uint8Array, maxOutput: number): Promise<Uint8Array> {
	try {
		return decode(bytes, maxOutput);
	} catch (error) {
		if (error instanceof ArchiveError) {
			throw error;
		}
		throw new ArchiveError(error instanceof Error ? error.message : String(error));
	}
}
