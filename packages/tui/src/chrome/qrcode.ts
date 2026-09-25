/**
 * Self-contained QR Code generator (byte mode, versions 1-40, EC levels
 * L/M/Q/H) with a half-block ANSI terminal renderer.
 *
 * Pure TypeScript, zero dependencies: the collab `/collab qrcode` command uses
 * it to print scannable browser-join codes without pulling a runtime QR
 * package into the bundle. The algorithm follows ISO/IEC 18004; the two
 * error-correction tables below are direct transcriptions of that spec.
 */

export type QrEcLevel = "L" | "M" | "Q" | "H";

/** Per-EC-level metadata: index into the spec tables and the 2-bit format code. */
const EC_LEVELS: Record<QrEcLevel, { table: number; formatBits: number }> = {
	L: { table: 0, formatBits: 1 },
	M: { table: 1, formatBits: 0 },
	Q: { table: 2, formatBits: 3 },
	H: { table: 3, formatBits: 2 },
};

const MIN_VERSION = 1;
const MAX_VERSION = 40;

// ISO/IEC 18004 Table 9 — error-correction codewords per block, indexed
// [ecTable][version]. Index 0 of each row pads the 1-based version axis.
// spec table, one row per EC level
// oxfmt-ignore
const ECC_CODEWORDS_PER_BLOCK: readonly (readonly number[])[] = [
	[-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
	[-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
	[-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
	[-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];

// ISO/IEC 18004 Table 9 — number of error-correction blocks, indexed
// [ecTable][version].
// spec table, one row per EC level
// oxfmt-ignore
const NUM_EC_BLOCKS: readonly (readonly number[])[] = [
	[-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
	[-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
	[-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
	[-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

const BYTE_MODE_INDICATOR = 0x4;
const PAD_BYTES = [0xec, 0x11] as const;

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

function getBit(value: number, index: number): boolean {
	return ((value >>> index) & 1) !== 0;
}

/** Whether mask `m` flips the module at (x, y); the 8 data-mask conditions from the spec. */
function maskBit(m: number, x: number, y: number): boolean {
	switch (m) {
		case 0:
			return (x + y) % 2 === 0;
		case 1:
			return y % 2 === 0;
		case 2:
			return x % 3 === 0;
		case 3:
			return (x + y) % 3 === 0;
		case 4:
			return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
		case 5:
			return ((x * y) % 2) + ((x * y) % 3) === 0;
		case 6:
			return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
		default:
			return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
	}
}

/** GF(256) multiply under the QR primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D). */
function gfMultiply(x: number, y: number): number {
	let z = 0;
	for (let i = 7; i >= 0; i--) {
		z = (z << 1) ^ ((z >>> 7) * 0x11d);
		z ^= ((y >>> i) & 1) * x;
	}
	return z & 0xff;
}

/** Reed-Solomon generator polynomial coefficients for `degree` EC codewords. */
function rsDivisor(degree: number): Uint8Array {
	const result = new Uint8Array(degree);
	result[degree - 1] = 1;
	let root = 1;
	for (let i = 0; i < degree; i++) {
		for (let j = 0; j < result.length; j++) {
			result[j] = gfMultiply(result[j]!, root);
			if (j + 1 < result.length) result[j] ^= result[j + 1]!;
		}
		root = gfMultiply(root, 0x02);
	}
	return result;
}

/** Reed-Solomon remainder (the EC codewords) of `data` divided by `divisor`. */
function rsRemainder(data: Uint8Array, divisor: Uint8Array): Uint8Array {
	const result = new Uint8Array(divisor.length);
	for (const b of data) {
		const factor = b ^ result[0]!;
		result.copyWithin(0, 1);
		result[result.length - 1] = 0;
		for (let i = 0; i < divisor.length; i++) result[i] ^= gfMultiply(divisor[i]!, factor);
	}
	return result;
}

/** Total data modules (bits available before EC) for a version. */
function rawDataModules(version: number): number {
	let result = (16 * version + 128) * version + 64;
	if (version >= 2) {
		const numAlign = Math.floor(version / 7) + 2;
		result -= (25 * numAlign - 10) * numAlign - 55;
		if (version >= 7) result -= 36;
	}
	return result;
}

/** Number of usable data codewords (8-bit) at a given version + EC level. */
function dataCodewords(version: number, ecTable: number): number {
	return (
		Math.floor(rawDataModules(version) / 8) -
		ECC_CODEWORDS_PER_BLOCK[ecTable]![version]! * NUM_EC_BLOCKS[ecTable]![version]!
	);
}

/** Byte-mode character-count indicator width in bits for a version. */
function charCountBits(version: number): number {
	return version <= 9 ? 8 : 16;
}

export interface QrEncodeOptions {
	/** Lowest version to consider (default 1). */
	minVersion?: number;
	/** Highest version to consider (default 40). */
	maxVersion?: number;
	/** Force a mask 0-7; -1 (default) auto-selects the lowest-penalty mask. */
	mask?: number;
}

/**
 * A finished QR symbol: a square grid of dark/light modules plus the chosen
 * version, EC level, and mask. `module(x, y)` is the only access path the
 * renderers need.
 */
export class QrCode {
	readonly size: number;
	/** Selected mask pattern (0-7). */
	readonly mask: number;
	readonly #modules: boolean[][];
	readonly #isFunction: boolean[][];

	private constructor(
		readonly version: number,
		readonly ecLevel: QrEcLevel,
		dataCodewordsInterleaved: Uint8Array,
		mask: number,
	) {
		this.size = version * 4 + 17;
		// oxlint-disable-next-line unicorn/no-new-array -- row preallocation
		this.#modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
		// oxlint-disable-next-line unicorn/no-new-array -- row preallocation
		this.#isFunction = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));

		this.#drawFunctionPatterns();
		this.#drawCodewords(dataCodewordsInterleaved);
		this.mask = this.#selectMask(mask);
	}

	module(x: number, y: number): boolean {
		return this.#modules[y]![x]!;
	}

	/** Encode a string in byte mode (UTF-8). Throws if it exceeds version 40. */
	static encodeText(text: string, ecLevel: QrEcLevel = "M", options?: QrEncodeOptions): QrCode {
		return QrCode.encodeBytes(new TextEncoder().encode(text), ecLevel, options);
	}

	/** Encode raw bytes in byte mode. Throws if they exceed version 40 at this EC level. */
	static encodeBytes(data: Uint8Array, ecLevel: QrEcLevel = "M", options?: QrEncodeOptions): QrCode {
		const ec = EC_LEVELS[ecLevel];
		const minVersion = Math.max(MIN_VERSION, options?.minVersion ?? MIN_VERSION);
		const maxVersion = Math.min(MAX_VERSION, options?.maxVersion ?? MAX_VERSION);

		let version = minVersion;
		for (; ; version++) {
			const capacityBits = dataCodewords(version, ec.table) * 8;
			const usedBits = 4 + charCountBits(version) + data.length * 8;
			if (usedBits <= capacityBits) break;
			if (version >= maxVersion) {
				throw new Error(`data too long for a QR code (${data.length} bytes, EC ${ecLevel})`);
			}
		}

		const bits = new BitBuffer();
		bits.append(BYTE_MODE_INDICATOR, 4);
		bits.append(data.length, charCountBits(version));
		for (const b of data) bits.append(b, 8);

		const capacityBits = dataCodewords(version, ec.table) * 8;
		bits.append(0, Math.min(4, capacityBits - bits.length)); // terminator
		bits.append(0, (8 - (bits.length % 8)) % 8); // byte-align
		for (let pad = 0; bits.length < capacityBits; pad ^= 1) bits.append(PAD_BYTES[pad]!, 8);

		const codewords = QrCode.#interleave(bits.toBytes(), version, ec.table);
		const mask = options?.mask ?? -1;
		if (mask < -1 || mask > 7) throw new Error(`invalid mask ${mask}`);
		return new QrCode(version, ecLevel, codewords, mask);
	}

	/** Split into blocks, append Reed-Solomon EC, and interleave per the spec. */
	static #interleave(data: Uint8Array, version: number, ecTable: number): Uint8Array {
		const numBlocks = NUM_EC_BLOCKS[ecTable]![version]!;
		const eccLen = ECC_CODEWORDS_PER_BLOCK[ecTable]![version]!;
		const rawCodewords = Math.floor(rawDataModules(version) / 8);
		const numShort = numBlocks - (rawCodewords % numBlocks);
		const shortLen = Math.floor(rawCodewords / numBlocks);
		const divisor = rsDivisor(eccLen);

		const blocks: Uint8Array[] = [];
		const blockLen = shortLen + 1;
		for (let i = 0, offset = 0; i < numBlocks; i++) {
			const datLen = shortLen - eccLen + (i < numShort ? 0 : 1);
			const dat = data.subarray(offset, offset + datLen);
			offset += datLen;
			// Every block is padded to the longest block's length so interleaving
			// stays column-aligned; short blocks leave a zero in the last data slot.
			const block = new Uint8Array(blockLen);
			block.set(dat, 0);
			block.set(rsRemainder(dat, divisor), blockLen - eccLen);
			blocks.push(block);
		}

		const result = new Uint8Array(rawCodewords);
		let w = 0;
		for (let i = 0; i < blockLen; i++) {
			for (let b = 0; b < numBlocks; b++) {
				// Skip the padding column at the data/EC boundary of short blocks.
				if (i === shortLen - eccLen && b < numShort) continue;
				result[w++] = blocks[b]![i]!;
			}
		}
		return result;
	}

	// ── Module placement ──────────────────────────────────────────────────

	#setFunction(x: number, y: number, dark: boolean): void {
		this.#modules[y]![x] = dark;
		this.#isFunction[y]![x] = true;
	}

	#drawFunctionPatterns(): void {
		for (let i = 0; i < this.size; i++) {
			this.#setFunction(6, i, i % 2 === 0);
			this.#setFunction(i, 6, i % 2 === 0);
		}
		this.#drawFinder(3, 3);
		this.#drawFinder(this.size - 4, 3);
		this.#drawFinder(3, this.size - 4);

		const align = this.#alignmentPositions();
		const last = align.length - 1;
		for (let i = 0; i <= last; i++) {
			for (let j = 0; j <= last; j++) {
				// Skip the three finder corners.
				if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
				this.#drawAlignment(align[i]!, align[j]!);
			}
		}

		this.#drawFormatBits(0); // placeholder until mask chosen
		this.#drawVersion();
	}

	#drawFinder(cx: number, cy: number): void {
		for (let dy = -4; dy <= 4; dy++) {
			for (let dx = -4; dx <= 4; dx++) {
				const dist = Math.max(Math.abs(dx), Math.abs(dy));
				const x = cx + dx;
				const y = cy + dy;
				if (x >= 0 && x < this.size && y >= 0 && y < this.size) {
					this.#setFunction(x, y, dist !== 2 && dist !== 4);
				}
			}
		}
	}

	#drawAlignment(cx: number, cy: number): void {
		for (let dy = -2; dy <= 2; dy++) {
			for (let dx = -2; dx <= 2; dx++) {
				this.#setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
			}
		}
	}

	#alignmentPositions(): number[] {
		if (this.version === 1) return [];
		const numAlign = Math.floor(this.version / 7) + 2;
		const step = this.version === 32 ? 26 : Math.ceil((this.size - 13) / (numAlign * 2 - 2)) * 2;
		const result = [6];
		for (let pos = this.size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
		return result;
	}

	#drawFormatBits(mask: number): void {
		const data = (EC_LEVELS[this.ecLevel].formatBits << 3) | mask;
		let rem = data;
		for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
		const bits = ((data << 10) | rem) ^ 0x5412;

		for (let i = 0; i <= 5; i++) this.#setFunction(8, i, getBit(bits, i));
		this.#setFunction(8, 7, getBit(bits, 6));
		this.#setFunction(8, 8, getBit(bits, 7));
		this.#setFunction(7, 8, getBit(bits, 8));
		for (let i = 9; i < 15; i++) this.#setFunction(14 - i, 8, getBit(bits, i));

		for (let i = 0; i < 8; i++) this.#setFunction(this.size - 1 - i, 8, getBit(bits, i));
		for (let i = 8; i < 15; i++) this.#setFunction(8, this.size - 15 + i, getBit(bits, i));
		this.#setFunction(8, this.size - 8, true); // always-dark module
	}

	#drawVersion(): void {
		if (this.version < 7) return;
		let rem = this.version;
		for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
		const bits = (this.version << 12) | rem;
		for (let i = 0; i < 18; i++) {
			const bit = getBit(bits, i);
			const a = this.size - 11 + (i % 3);
			const b = Math.floor(i / 3);
			this.#setFunction(a, b, bit);
			this.#setFunction(b, a, bit);
		}
	}

	#drawCodewords(data: Uint8Array): void {
		let i = 0;
		const totalBits = data.length * 8;
		for (let right = this.size - 1; right >= 1; right -= 2) {
			if (right === 6) right = 5;
			for (let vert = 0; vert < this.size; vert++) {
				for (let j = 0; j < 2; j++) {
					const x = right - j;
					const upward = ((right + 1) & 2) === 0;
					const y = upward ? this.size - 1 - vert : vert;
					if (!this.#isFunction[y]![x] && i < totalBits) {
						this.#modules[y]![x] = getBit(data[i >>> 3]!, 7 - (i & 7));
						i++;
					}
				}
			}
		}
	}

	// ── Masking ───────────────────────────────────────────────────────────

	#applyMask(mask: number): void {
		for (let y = 0; y < this.size; y++) {
			for (let x = 0; x < this.size; x++) {
				if (!this.#isFunction[y]![x] && maskBit(mask, x, y)) {
					this.#modules[y]![x] = !this.#modules[y]![x];
				}
			}
		}
	}

	#selectMask(forced: number): number {
		let mask = forced;
		if (mask === -1) {
			let minPenalty = Infinity;
			for (let m = 0; m < 8; m++) {
				this.#applyMask(m);
				this.#drawFormatBits(m);
				const penalty = this.#penaltyScore();
				if (penalty < minPenalty) {
					mask = m;
					minPenalty = penalty;
				}
				this.#applyMask(m); // undo (XOR mask is self-inverse)
			}
		}
		this.#applyMask(mask);
		this.#drawFormatBits(mask);
		return mask;
	}

	#penaltyScore(): number {
		let result = 0;
		const size = this.size;
		const mods = this.#modules;

		// Rule 1 + Rule 3 — adjacent same-color runs, finder-like patterns (rows).
		for (let y = 0; y < size; y++) {
			let runColor = false;
			let runLen = 0;
			const history = [0, 0, 0, 0, 0, 0, 0];
			for (let x = 0; x < size; x++) {
				if (mods[y]![x] === runColor) {
					runLen++;
					if (runLen === 5) result += PENALTY_N1;
					else if (runLen > 5) result++;
				} else {
					this.#finderAddHistory(runLen, history);
					if (!runColor) result += this.#finderCountPatterns(history) * PENALTY_N3;
					runColor = mods[y]![x]!;
					runLen = 1;
				}
			}
			result += this.#finderTerminate(runColor, runLen, history) * PENALTY_N3;
		}
		// Rule 1 + Rule 3 — columns.
		for (let x = 0; x < size; x++) {
			let runColor = false;
			let runLen = 0;
			const history = [0, 0, 0, 0, 0, 0, 0];
			for (let y = 0; y < size; y++) {
				if (mods[y]![x] === runColor) {
					runLen++;
					if (runLen === 5) result += PENALTY_N1;
					else if (runLen > 5) result++;
				} else {
					this.#finderAddHistory(runLen, history);
					if (!runColor) result += this.#finderCountPatterns(history) * PENALTY_N3;
					runColor = mods[y]![x]!;
					runLen = 1;
				}
			}
			result += this.#finderTerminate(runColor, runLen, history) * PENALTY_N3;
		}

		// Rule 2 — 2x2 blocks of one color.
		for (let y = 0; y < size - 1; y++) {
			for (let x = 0; x < size - 1; x++) {
				const c = mods[y]![x];
				if (c === mods[y]![x + 1] && c === mods[y + 1]![x] && c === mods[y + 1]![x + 1]) {
					result += PENALTY_N2;
				}
			}
		}

		// Rule 4 — dark/light balance.
		let dark = 0;
		for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (mods[y]![x]) dark++;
		const total = size * size;
		const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
		result += k * PENALTY_N4;
		return result;
	}

	#finderCountPatterns(history: readonly number[]): number {
		const n = history[1]!;
		const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n;
		return (
			(core && history[0]! >= n * 4 && history[6]! >= n ? 1 : 0) +
			(core && history[6]! >= n * 4 && history[0]! >= n ? 1 : 0)
		);
	}

	#finderAddHistory(runLen: number, history: number[]): void {
		if (history[0] === 0) runLen += this.size; // light border before the first run
		history.pop();
		history.unshift(runLen);
	}

	#finderTerminate(runColor: boolean, runLen: number, history: number[]): number {
		if (runColor) {
			this.#finderAddHistory(runLen, history);
			runLen = 0;
		}
		runLen += this.size; // light border after the final run
		this.#finderAddHistory(runLen, history);
		return this.#finderCountPatterns(history);
	}
}

/** Append-only MSB-first bit buffer. */
class BitBuffer {
	#bits: number[] = [];

	get length(): number {
		return this.#bits.length;
	}

	append(value: number, count: number): void {
		for (let i = count - 1; i >= 0; i--) this.#bits.push((value >>> i) & 1);
	}

	toBytes(): Uint8Array {
		const out = new Uint8Array(this.#bits.length >>> 3);
		for (let i = 0; i < this.#bits.length; i++) out[i >>> 3] = (out[i >>> 3]! << 1) | this.#bits[i]!;
		return out;
	}
}

export interface QrRenderOptions {
	/** Quiet-zone width in modules on every side (default 4, per spec). */
	margin?: number;
}

const ANSI_RESET = "\x1b[0m";
const ANSI_QR_ROW_PREFIX = "\x1b[47m\x1b[30m"; // white background, black foreground

/**
 * Render a QR symbol as ANSI half-block rows: each text row packs two module
 * rows via `▀`/`▄`/`█`, drawn black-on-white so a phone camera reads dark
 * modules as data and the quiet zone as the light margin. The leading margin
 * makes the symbol scannable regardless of the terminal's own background.
 */
export function renderQrHalfBlocks(qr: QrCode, options?: QrRenderOptions): string[] {
	const margin = Math.max(0, options?.margin ?? 4);
	const dim = qr.size + margin * 2;
	const dark = (gx: number, gy: number): boolean => {
		const x = gx - margin;
		const y = gy - margin;
		return x >= 0 && x < qr.size && y >= 0 && y < qr.size && qr.module(x, y);
	};

	const lines: string[] = [];
	for (let gy = 0; gy < dim; gy += 2) {
		let row = ANSI_QR_ROW_PREFIX;
		for (let gx = 0; gx < dim; gx++) {
			const top = dark(gx, gy);
			const bottom = gy + 1 < dim && dark(gx, gy + 1);
			row += top ? (bottom ? "█" : "▀") : bottom ? "▄" : " ";
		}
		lines.push(row + ANSI_RESET);
	}
	return lines;
}
