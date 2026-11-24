/**
 * QR Code symbols (ISO/IEC 18004) for short texts: byte mode, the smallest
 * version that holds the text at the requested error-correction level, and
 * the data mask with the lowest penalty score.
 */

/** Error-correction level: share of codewords that may be restored (~7/15/25/30 %). */
export type QrLevel = "L" | "M" | "Q" | "H";

/** A QR symbol: `size`×`size` modules, row-major, `true` dark. */
export interface QrSymbol {
	readonly version: number;
	readonly level: QrLevel;
	readonly mask: number;
	readonly size: number;
	readonly modules: readonly (readonly boolean[])[];
}

/** Two-bit format code and table row of each level. */
const LEVELS: Readonly<Record<QrLevel, { readonly format: number; readonly row: number }>> = {
	L: { format: 1, row: 0 },
	M: { format: 0, row: 1 },
	Q: { format: 3, row: 2 },
	H: { format: 2, row: 3 },
};

/** Error-correction codewords per block, by level row then version (index 0 unused). */
const ECC_PER_BLOCK: readonly (readonly number[])[] = [
	[
		0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30,
		30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
	],
	[
		0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28,
		28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
	],
	[
		0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30,
		30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
	],
	[
		0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30,
		30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30,
	],
];

/** Error-correction blocks, by level row then version (index 0 unused). */
const BLOCKS: readonly (readonly number[])[] = [
	[
		0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18,
		19, 19, 20, 21, 22, 24, 25,
	],
	[
		0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31,
		33, 35, 37, 38, 40, 43, 45, 47, 49,
	],
	[
		0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40,
		43, 45, 48, 51, 53, 56, 59, 62, 65, 68,
	],
	[
		0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48,
		51, 54, 57, 60, 63, 66, 70, 74, 77, 81,
	],
];

/** Modules of a version left for data and error correction (everything but function patterns). */
function rawDataModules(version: number): number {
	let modules = (16 * version + 128) * version + 64;
	if (version >= 2) {
		const aligns = Math.floor(version / 7) + 2;
		modules -= (25 * aligns - 10) * aligns - 55;
		if (version >= 7) modules -= 36;
	}
	return modules;
}

function dataCodewords(version: number, level: QrLevel): number {
	const row = LEVELS[level].row;
	return Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK[row]![version]! * BLOCKS[row]![version]!;
}

/** Product in GF(2⁸) modulo x⁸+x⁴+x³+x²+1. */
function gfMultiply(a: number, b: number): number {
	let product = 0;
	for (let bit = 7; bit >= 0; bit--) {
		product = (product << 1) ^ ((product >>> 7) * 0x11d);
		product ^= ((b >>> bit) & 1) * a;
	}
	return product;
}

/** Reed–Solomon generator polynomial of `degree` (leading 1 dropped). */
function rsDivisor(degree: number): number[] {
	const divisor: number[] = Array.from({ length: degree }, (_, i) => (i === degree - 1 ? 1 : 0));
	let root = 1;
	for (let i = 0; i < degree; i++) {
		for (let j = 0; j < degree; j++) {
			divisor[j] = gfMultiply(divisor[j]!, root);
			if (j + 1 < degree) divisor[j]! ^= divisor[j + 1]!;
		}
		root = gfMultiply(root, 0x02);
	}
	return divisor;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
	const remainder = divisor.map(() => 0);
	for (const byte of data) {
		const factor = byte ^ remainder.shift()!;
		remainder.push(0);
		for (let i = 0; i < divisor.length; i++) remainder[i]! ^= gfMultiply(divisor[i]!, factor);
	}
	return remainder;
}

/** The data codewords split into blocks, each with its error correction, interleaved. */
function interleave(data: readonly number[], version: number, level: QrLevel): number[] {
	const row = LEVELS[level].row;
	const blocks = BLOCKS[row]![version]!;
	const eccLength = ECC_PER_BLOCK[row]![version]!;
	const raw = Math.floor(rawDataModules(version) / 8);
	const shortBlocks = blocks - (raw % blocks);
	const shortLength = Math.floor(raw / blocks);
	const divisor = rsDivisor(eccLength);
	const dataBlocks: number[][] = [];
	const eccBlocks: number[][] = [];
	for (let i = 0, at = 0; i < blocks; i++) {
		const length = shortLength - eccLength + (i < shortBlocks ? 0 : 1);
		const block = data.slice(at, at + length);
		at += length;
		dataBlocks.push(block);
		eccBlocks.push(rsRemainder(block, divisor));
	}
	const out: number[] = [];
	for (let i = 0; i <= shortLength - eccLength; i++) {
		for (const block of dataBlocks) if (i < block.length) out.push(block[i]!);
	}
	for (let i = 0; i < eccLength; i++) for (const block of eccBlocks) out.push(block[i]!);
	return out;
}

/** The data codewords of `bytes` in byte mode at a version, padded to capacity. */
function encodeData(bytes: Uint8Array, version: number, level: QrLevel): number[] | undefined {
	const capacity = dataCodewords(version, level) * 8;
	const countBits = version <= 9 ? 8 : 16;
	const bits: number[] = [];
	const put = (value: number, length: number): void => {
		for (let bit = length - 1; bit >= 0; bit--) bits.push((value >>> bit) & 1);
	};
	put(0b0100, 4);
	put(bytes.length, countBits);
	for (const byte of bytes) put(byte, 8);
	if (bits.length > capacity || bytes.length >= 1 << countBits) return undefined;
	put(0, Math.min(4, capacity - bits.length));
	put(0, (8 - (bits.length % 8)) % 8);
	for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
	const out: number[] = [];
	for (let i = 0; i < bits.length; i += 8) {
		let byte = 0;
		for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]!;
		out.push(byte);
	}
	return out;
}

/** Whether data mask `mask` flips the module at (x, y). */
function masked(mask: number, x: number, y: number): boolean {
	switch (mask) {
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

class Grid {
	readonly modules: boolean[][];
	readonly reserved: boolean[][];
	constructor(readonly size: number) {
		this.modules = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
		this.reserved = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
	}
	fixed(x: number, y: number, dark: boolean): void {
		this.modules[y]![x] = dark;
		this.reserved[y]![x] = true;
	}
}

function drawFunctionPatterns(grid: Grid, version: number): void {
	const size = grid.size;
	for (let i = 0; i < size; i++) {
		grid.fixed(6, i, i % 2 === 0);
		grid.fixed(i, 6, i % 2 === 0);
	}
	for (const [cx, cy] of [
		[3, 3],
		[size - 4, 3],
		[3, size - 4],
	] as const) {
		for (let dy = -4; dy <= 4; dy++) {
			for (let dx = -4; dx <= 4; dx++) {
				const x = cx + dx;
				const y = cy + dy;
				if (x < 0 || y < 0 || x >= size || y >= size) continue;
				const ring = Math.max(Math.abs(dx), Math.abs(dy));
				grid.fixed(x, y, ring !== 2 && ring !== 4);
			}
		}
	}
	const centers = alignmentCenters(version, size);
	for (const cy of centers) {
		for (const cx of centers) {
			const corner = (cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6);
			if (corner) continue;
			for (let dy = -2; dy <= 2; dy++) {
				for (let dx = -2; dx <= 2; dx++) grid.fixed(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
			}
		}
	}
	drawFormat(grid, 0, 0);
	if (version >= 7) {
		let remainder = version;
		for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
		const bits = (version << 12) | remainder;
		for (let i = 0; i < 18; i++) {
			const dark = ((bits >>> i) & 1) === 1;
			const a = size - 11 + (i % 3);
			const b = Math.floor(i / 3);
			grid.fixed(a, b, dark);
			grid.fixed(b, a, dark);
		}
	}
}

function alignmentCenters(version: number, size: number): number[] {
	if (version === 1) return [];
	const count = Math.floor(version / 7) + 2;
	const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
	const centers = [6];
	for (let at = size - 7; centers.length < count; at -= step) centers.splice(1, 0, at);
	return centers;
}

/** Both copies of the 15-bit format information (level and mask), plus the dark module. */
function drawFormat(grid: Grid, levelFormat: number, mask: number): void {
	const size = grid.size;
	const data = (levelFormat << 3) | mask;
	let remainder = data;
	for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
	const bits = ((data << 10) | remainder) ^ 0x5412;
	const bit = (i: number): boolean => ((bits >>> i) & 1) === 1;
	for (let i = 0; i <= 5; i++) grid.fixed(8, i, bit(i));
	grid.fixed(8, 7, bit(6));
	grid.fixed(8, 8, bit(7));
	grid.fixed(7, 8, bit(8));
	for (let i = 9; i < 15; i++) grid.fixed(14 - i, 8, bit(i));
	for (let i = 0; i < 8; i++) grid.fixed(size - 1 - i, 8, bit(i));
	for (let i = 8; i < 15; i++) grid.fixed(8, size - 15 + i, bit(i));
	grid.fixed(8, size - 8, true);
}

/** Codeword bits in the two-column zigzag from the bottom right, skipping function modules. */
function drawCodewords(grid: Grid, codewords: readonly number[]): void {
	const size = grid.size;
	let i = 0;
	for (let right = size - 1; right >= 1; right -= 2) {
		if (right === 6) right = 5;
		for (let vertical = 0; vertical < size; vertical++) {
			for (let j = 0; j < 2; j++) {
				const x = right - j;
				const upward = ((right + 1) & 2) === 0;
				const y = upward ? size - 1 - vertical : vertical;
				if (grid.reserved[y]![x] || i >= codewords.length * 8) continue;
				grid.modules[y]![x] = ((codewords[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1;
				i++;
			}
		}
	}
}

function applyMask(grid: Grid, mask: number): void {
	for (let y = 0; y < grid.size; y++) {
		for (let x = 0; x < grid.size; x++) {
			if (!grid.reserved[y]![x] && masked(mask, x, y)) grid.modules[y]![x] = !grid.modules[y]![x];
		}
	}
}

/** Finder-like 1:1:3:1:1 runs with 4 light modules on a side, in a history of the last 7 runs (newest first). */
function finderLike(runs: readonly number[]): number {
	const n = runs[1]!;
	const core = n > 0 && runs[2] === n && runs[3] === n * 3 && runs[4] === n && runs[5] === n;
	return (core && runs[0]! >= n * 4 && runs[6]! >= n ? 1 : 0) + (core && runs[6]! >= n * 4 && runs[0]! >= n ? 1 : 0);
}

/** Penalty of one row or column of modules: long runs (rule 1) and finder-like patterns (rule 3). */
function linePenalty(line: (i: number) => boolean, size: number): number {
	let penalty = 0;
	let color = false;
	let run = 0;
	const runs = [0, 0, 0, 0, 0, 0, 0];
	const push = (length: number): void => {
		// The light quiet zone extends the first run.
		runs.pop();
		runs.unshift(runs[0] === 0 ? length + size : length);
	};
	for (let i = 0; i < size; i++) {
		if (line(i) === color) {
			run++;
			if (run === 5) penalty += 3;
			else if (run > 5) penalty++;
			continue;
		}
		push(run);
		if (!color) penalty += finderLike(runs) * 40;
		color = line(i);
		run = 1;
	}
	if (color) {
		push(run);
		run = 0;
	}
	push(run + size);
	return penalty + finderLike(runs) * 40;
}

function penalty(grid: Grid): number {
	const { size, modules } = grid;
	let score = 0;
	for (let y = 0; y < size; y++) score += linePenalty(x => modules[y]![x]!, size);
	for (let x = 0; x < size; x++) score += linePenalty(y => modules[y]![x]!, size);
	for (let y = 0; y < size - 1; y++) {
		for (let x = 0; x < size - 1; x++) {
			const dark = modules[y]![x];
			if (dark === modules[y]![x + 1] && dark === modules[y + 1]![x] && dark === modules[y + 1]![x + 1]) score += 3;
		}
	}
	let dark = 0;
	for (const row of modules) for (const module of row) if (module) dark++;
	const total = size * size;
	return score + (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
}

/** The QR symbol of `text` (UTF-8, byte mode) at error-correction `level`. */
export function encodeQr(text: string, level: QrLevel = "M"): QrSymbol {
	const bytes = new TextEncoder().encode(text);
	for (let version = 1; version <= 40; version++) {
		const data = encodeData(bytes, version, level);
		if (!data) continue;
		const grid = new Grid(version * 4 + 17);
		drawFunctionPatterns(grid, version);
		drawCodewords(grid, interleave(data, version, level));
		let best = 0;
		let bestScore = Number.POSITIVE_INFINITY;
		for (let mask = 0; mask < 8; mask++) {
			applyMask(grid, mask);
			drawFormat(grid, LEVELS[level].format, mask);
			const score = penalty(grid);
			if (score < bestScore) {
				best = mask;
				bestScore = score;
			}
			applyMask(grid, mask);
		}
		applyMask(grid, best);
		drawFormat(grid, LEVELS[level].format, best);
		return { version, level, mask: best, size: grid.size, modules: grid.modules };
	}
	throw new Error(`text too long for a QR symbol (${bytes.length} bytes)`);
}

/** Quiet zone around a symbol, in modules. */
export const QR_QUIET_ZONE = 4;

/**
 * The symbol with its quiet zone as half-block rows (two modules per row):
 * `ink` says which modules draw as glyph ink, `"dark"` for text on a light
 * background, `"light"` for a light foreground on a dark one.
 */
export function qrHalfBlocks(symbol: QrSymbol, ink: "dark" | "light"): string[] {
	const span = symbol.size + QR_QUIET_ZONE * 2;
	const inked = (x: number, y: number): boolean => {
		const mx = x - QR_QUIET_ZONE;
		const my = y - QR_QUIET_ZONE;
		const dark = mx >= 0 && my >= 0 && mx < symbol.size && my < symbol.size && symbol.modules[my]![mx]!;
		return ink === "dark" ? dark : !dark;
	};
	const rows: string[] = [];
	for (let y = 0; y < span; y += 2) {
		let row = "";
		for (let x = 0; x < span; x++) {
			const top = inked(x, y);
			const bottom = y + 1 < span && inked(x, y + 1);
			row += top ? (bottom ? "█" : "▀") : bottom ? "▄" : " ";
		}
		rows.push(row);
	}
	return rows;
}
