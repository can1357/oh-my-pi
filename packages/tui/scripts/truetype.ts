/**
 * Minimal TrueType reader for the glyph-bundle generator: enough of `head`,
 * `hhea`, `hmtx`, `maxp`, `cmap`, `loca`, `glyf` and `name` to pull one
 * outline per codepoint, flatten composites, and re-encode the result as the
 * simple-glyph record the Glyph Protocol accepts (§8.2: no composites, no
 * hinting). Build-time only; the TUI never parses fonts at runtime.
 */

/** One outline point in font design units. */
export interface GlyfPoint {
	x: number;
	y: number;
	onCurve: boolean;
}

/** A decoded outline: closed contours of quadratic-Bézier control points. */
export type GlyfOutline = GlyfPoint[][];

/** Vertical/horizontal design metrics the bundle needs for layout hints. */
export interface FontMetrics {
	unitsPerEm: number;
	ascender: number;
	descender: number;
}

const FLAG_ON_CURVE = 0x01;
const FLAG_X_SHORT = 0x02;
const FLAG_Y_SHORT = 0x04;
const FLAG_REPEAT = 0x08;
const FLAG_X_SAME_OR_POSITIVE = 0x10;
const FLAG_Y_SAME_OR_POSITIVE = 0x20;

const ARG_1_AND_2_ARE_WORDS = 0x0001;
const ARGS_ARE_XY_VALUES = 0x0002;
const WE_HAVE_A_SCALE = 0x0008;
const MORE_COMPONENTS = 0x0020;
const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
const WE_HAVE_A_TWO_BY_TWO = 0x0080;

/** Parsed TrueType font exposing codepoint → outline lookups. */
export class TrueTypeFont {
	readonly #view: DataView;
	readonly #tables = new Map<string, { offset: number; length: number }>();
	readonly #cmap = new Map<number, number>();
	readonly #loca: Uint32Array;
	readonly #glyf: { offset: number; length: number };
	readonly #hmtx: { offset: number; numberOfHMetrics: number };
	readonly metrics: FontMetrics;
	/** `name` table full font name + version string, for provenance headers. */
	readonly fullName: string;
	readonly version: string;

	constructor(bytes: Uint8Array) {
		this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
		this.#readTableDirectory();
		const head = this.#table("head");
		const unitsPerEm = this.#view.getUint16(head.offset + 18);
		const indexToLocFormat = this.#view.getInt16(head.offset + 50);
		const hhea = this.#table("hhea");
		this.metrics = {
			unitsPerEm,
			ascender: this.#view.getInt16(hhea.offset + 4),
			descender: this.#view.getInt16(hhea.offset + 6),
		};
		const numberOfHMetrics = this.#view.getUint16(hhea.offset + 34);
		this.#hmtx = { offset: this.#table("hmtx").offset, numberOfHMetrics };
		const numGlyphs = this.#view.getUint16(this.#table("maxp").offset + 4);
		this.#loca = this.#readLoca(numGlyphs, indexToLocFormat);
		this.#glyf = this.#table("glyf");
		this.#readCmap();
		const names = this.#readNames();
		this.fullName = names.get(4) ?? names.get(1) ?? "unknown";
		this.version = names.get(5) ?? "unknown";
	}

	/** Glyph index for a codepoint, or undefined when the font has no mapping. */
	glyphId(codepoint: number): number | undefined {
		return this.#cmap.get(codepoint);
	}

	/** Horizontal advance of a glyph in design units. */
	advanceWidth(glyphId: number): number {
		const index = Math.min(glyphId, this.#hmtx.numberOfHMetrics - 1);
		return this.#view.getUint16(this.#hmtx.offset + index * 4);
	}

	/**
	 * Decode a glyph to contours, recursively flattening composite references
	 * into their transformed component points. Empty glyphs yield `[]`.
	 */
	outline(glyphId: number, depth = 0): GlyfOutline {
		if (depth > 8) throw new Error(`composite glyph ${glyphId} nests too deeply`);
		const start = this.#loca[glyphId];
		const end = this.#loca[glyphId + 1];
		if (start === undefined || end === undefined || end <= start) return [];
		const base = this.#glyf.offset + start;
		const numberOfContours = this.#view.getInt16(base);
		if (numberOfContours >= 0) return this.#simpleOutline(base, numberOfContours);
		return this.#compositeOutline(base, depth);
	}

	#simpleOutline(base: number, numberOfContours: number): GlyfOutline {
		const view = this.#view;
		let p = base + 10;
		const endPts: number[] = [];
		for (let i = 0; i < numberOfContours; i++) {
			endPts.push(view.getUint16(p));
			p += 2;
		}
		const instructionLength = view.getUint16(p);
		p += 2 + instructionLength;
		const pointCount = numberOfContours === 0 ? 0 : endPts[numberOfContours - 1]! + 1;
		const flags = new Uint8Array(pointCount);
		for (let i = 0; i < pointCount;) {
			const flag = view.getUint8(p++);
			flags[i++] = flag;
			if (flag & FLAG_REPEAT) {
				let repeat = view.getUint8(p++);
				while (repeat-- > 0 && i < pointCount) flags[i++] = flag;
			}
		}
		const xs = new Int32Array(pointCount);
		let x = 0;
		for (let i = 0; i < pointCount; i++) {
			const flag = flags[i]!;
			if (flag & FLAG_X_SHORT) {
				const delta = view.getUint8(p++);
				x += flag & FLAG_X_SAME_OR_POSITIVE ? delta : -delta;
			} else if (!(flag & FLAG_X_SAME_OR_POSITIVE)) {
				x += view.getInt16(p);
				p += 2;
			}
			xs[i] = x;
		}
		const ys = new Int32Array(pointCount);
		let y = 0;
		for (let i = 0; i < pointCount; i++) {
			const flag = flags[i]!;
			if (flag & FLAG_Y_SHORT) {
				const delta = view.getUint8(p++);
				y += flag & FLAG_Y_SAME_OR_POSITIVE ? delta : -delta;
			} else if (!(flag & FLAG_Y_SAME_OR_POSITIVE)) {
				y += view.getInt16(p);
				p += 2;
			}
			ys[i] = y;
		}
		const contours: GlyfOutline = [];
		let first = 0;
		for (const last of endPts) {
			const contour: GlyfPoint[] = [];
			for (let i = first; i <= last; i++) {
				contour.push({ x: xs[i]!, y: ys[i]!, onCurve: (flags[i]! & FLAG_ON_CURVE) !== 0 });
			}
			contours.push(contour);
			first = last + 1;
		}
		return contours;
	}

	#compositeOutline(base: number, depth: number): GlyfOutline {
		const view = this.#view;
		let p = base + 10;
		const contours: GlyfOutline = [];
		for (;;) {
			const flags = view.getUint16(p);
			const glyphIndex = view.getUint16(p + 2);
			p += 4;
			let dx: number;
			let dy: number;
			if (flags & ARG_1_AND_2_ARE_WORDS) {
				dx = view.getInt16(p);
				dy = view.getInt16(p + 2);
				p += 4;
			} else {
				dx = view.getInt8(p);
				dy = view.getInt8(p + 1);
				p += 2;
			}
			if (!(flags & ARGS_ARE_XY_VALUES)) {
				throw new Error("composite glyph uses point-matching arguments, which the flattener does not support");
			}
			let a = 1;
			let b = 0;
			let c = 0;
			let d = 1;
			if (flags & WE_HAVE_A_SCALE) {
				a = d = f2dot14(view, p);
				p += 2;
			} else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) {
				a = f2dot14(view, p);
				d = f2dot14(view, p + 2);
				p += 4;
			} else if (flags & WE_HAVE_A_TWO_BY_TWO) {
				a = f2dot14(view, p);
				b = f2dot14(view, p + 2);
				c = f2dot14(view, p + 4);
				d = f2dot14(view, p + 6);
				p += 8;
			}
			for (const contour of this.outline(glyphIndex, depth + 1)) {
				contours.push(
					contour.map(pt => ({
						x: Math.round(a * pt.x + c * pt.y + dx),
						y: Math.round(b * pt.x + d * pt.y + dy),
						onCurve: pt.onCurve,
					})),
				);
			}
			if (!(flags & MORE_COMPONENTS)) break;
		}
		return contours;
	}

	#table(tag: string): { offset: number; length: number } {
		const table = this.#tables.get(tag);
		if (!table) throw new Error(`font has no ${tag} table`);
		return table;
	}

	#readTableDirectory(): void {
		const view = this.#view;
		const numTables = view.getUint16(4);
		for (let i = 0; i < numTables; i++) {
			const record = 12 + i * 16;
			const tag = String.fromCharCode(
				view.getUint8(record),
				view.getUint8(record + 1),
				view.getUint8(record + 2),
				view.getUint8(record + 3),
			);
			this.#tables.set(tag, { offset: view.getUint32(record + 8), length: view.getUint32(record + 12) });
		}
	}

	#readLoca(numGlyphs: number, indexToLocFormat: number): Uint32Array {
		const loca = this.#table("loca");
		const offsets = new Uint32Array(numGlyphs + 1);
		for (let i = 0; i <= numGlyphs; i++) {
			offsets[i] =
				indexToLocFormat === 0
					? this.#view.getUint16(loca.offset + i * 2) * 2
					: this.#view.getUint32(loca.offset + i * 4);
		}
		return offsets;
	}

	#readCmap(): void {
		const view = this.#view;
		const cmap = this.#table("cmap");
		const numTables = view.getUint16(cmap.offset + 2);
		// Prefer a format-12 Unicode table (full plane coverage), else format 4.
		let format4: number | undefined;
		let format12: number | undefined;
		for (let i = 0; i < numTables; i++) {
			const record = cmap.offset + 4 + i * 8;
			const platformId = view.getUint16(record);
			const encodingId = view.getUint16(record + 2);
			const offset = cmap.offset + view.getUint32(record + 4);
			const isUnicode = platformId === 0 || (platformId === 3 && (encodingId === 1 || encodingId === 10));
			if (!isUnicode) continue;
			const format = view.getUint16(offset);
			if (format === 12) format12 = offset;
			else if (format === 4) format4 = offset;
		}
		if (format12 !== undefined) this.#readCmapFormat12(format12);
		if (format4 !== undefined) this.#readCmapFormat4(format4);
	}

	#readCmapFormat12(offset: number): void {
		const view = this.#view;
		const numGroups = view.getUint32(offset + 12);
		for (let g = 0; g < numGroups; g++) {
			const group = offset + 16 + g * 12;
			const startChar = view.getUint32(group);
			const endChar = view.getUint32(group + 4);
			const startGlyph = view.getUint32(group + 8);
			for (let cp = startChar; cp <= endChar; cp++) {
				if (!this.#cmap.has(cp)) this.#cmap.set(cp, startGlyph + (cp - startChar));
			}
		}
	}

	#readCmapFormat4(offset: number): void {
		const view = this.#view;
		const segCountX2 = view.getUint16(offset + 6);
		const segCount = segCountX2 / 2;
		const endCodes = offset + 14;
		const startCodes = endCodes + segCountX2 + 2;
		const idDeltas = startCodes + segCountX2;
		const idRangeOffsets = idDeltas + segCountX2;
		for (let s = 0; s < segCount; s++) {
			const endCode = view.getUint16(endCodes + s * 2);
			const startCode = view.getUint16(startCodes + s * 2);
			const idDelta = view.getInt16(idDeltas + s * 2);
			const idRangeOffset = view.getUint16(idRangeOffsets + s * 2);
			if (startCode === 0xffff) continue;
			for (let cp = startCode; cp <= endCode; cp++) {
				let glyph: number;
				if (idRangeOffset === 0) {
					glyph = (cp + idDelta) & 0xffff;
				} else {
					const address = idRangeOffsets + s * 2 + idRangeOffset + (cp - startCode) * 2;
					glyph = view.getUint16(address);
					if (glyph !== 0) glyph = (glyph + idDelta) & 0xffff;
				}
				if (glyph !== 0 && !this.#cmap.has(cp)) this.#cmap.set(cp, glyph);
			}
		}
	}

	#readNames(): Map<number, string> {
		const names = new Map<number, string>();
		const table = this.#tables.get("name");
		if (!table) return names;
		const view = this.#view;
		const count = view.getUint16(table.offset + 2);
		const stringOffset = table.offset + view.getUint16(table.offset + 4);
		for (let i = 0; i < count; i++) {
			const record = table.offset + 6 + i * 12;
			const platformId = view.getUint16(record);
			const nameId = view.getUint16(record + 6);
			const length = view.getUint16(record + 8);
			const offset = stringOffset + view.getUint16(record + 10);
			if (names.has(nameId)) continue;
			// Platform 3 (Windows) strings are UTF-16BE; platform 1 (Mac) is
			// single-byte Roman. Windows entries take precedence when present.
			if (platformId === 3) {
				let value = "";
				for (let j = 0; j + 1 < length; j += 2) value += String.fromCharCode(view.getUint16(offset + j));
				names.set(nameId, value);
			} else if (platformId === 1) {
				let value = "";
				for (let j = 0; j < length; j++) value += String.fromCharCode(view.getUint8(offset + j));
				names.set(nameId, value);
			}
		}
		return names;
	}
}

function f2dot14(view: DataView, offset: number): number {
	return view.getInt16(offset) / 16384;
}

/**
 * Encode contours as a TrueType simple-glyph record: header with the point
 * bounding box, `endPtsOfContours`, `instructionLength = 0`, run-length
 * compressed flags and short/same-encoded deltas — exactly the §8.2 subset.
 * Empty contours are dropped; an outline with no points encodes as an empty
 * record (zero contours), which the protocol renders as a blank cell.
 */
export function encodeSimpleGlyph(outline: GlyfOutline): Uint8Array {
	const contours = outline.filter(contour => contour.length > 0);
	const points = contours.flat();
	let xMin = 0;
	let yMin = 0;
	let xMax = 0;
	let yMax = 0;
	if (points.length > 0) {
		xMin = xMax = points[0]!.x;
		yMin = yMax = points[0]!.y;
		for (const pt of points) {
			if (pt.x < xMin) xMin = pt.x;
			if (pt.x > xMax) xMax = pt.x;
			if (pt.y < yMin) yMin = pt.y;
			if (pt.y > yMax) yMax = pt.y;
		}
	}
	for (const pt of points) {
		if (!Number.isInteger(pt.x) || !Number.isInteger(pt.y)) throw new Error("outline coordinates must be integers");
		if (pt.x < -32768 || pt.x > 32767 || pt.y < -32768 || pt.y > 32767) {
			throw new Error("outline coordinate out of int16 range");
		}
	}

	const flags: number[] = [];
	const xBytes: number[] = [];
	const yBytes: number[] = [];
	let prevX = 0;
	let prevY = 0;
	for (const pt of points) {
		let flag = pt.onCurve ? FLAG_ON_CURVE : 0;
		const dx = pt.x - prevX;
		const dy = pt.y - prevY;
		prevX = pt.x;
		prevY = pt.y;
		if (dx === 0) {
			flag |= FLAG_X_SAME_OR_POSITIVE;
		} else if (dx >= -255 && dx <= 255) {
			flag |= FLAG_X_SHORT;
			if (dx > 0) flag |= FLAG_X_SAME_OR_POSITIVE;
			xBytes.push(Math.abs(dx));
		} else {
			xBytes.push((dx >> 8) & 0xff, dx & 0xff);
		}
		if (dy === 0) {
			flag |= FLAG_Y_SAME_OR_POSITIVE;
		} else if (dy >= -255 && dy <= 255) {
			flag |= FLAG_Y_SHORT;
			if (dy > 0) flag |= FLAG_Y_SAME_OR_POSITIVE;
			yBytes.push(Math.abs(dy));
		} else {
			yBytes.push((dy >> 8) & 0xff, dy & 0xff);
		}
		flags.push(flag);
	}

	// Run-length compress identical consecutive flags (repeat count ≤ 255).
	const flagBytes: number[] = [];
	for (let i = 0; i < flags.length;) {
		const flag = flags[i]!;
		let run = 1;
		while (i + run < flags.length && flags[i + run] === flag && run < 256) run++;
		if (run > 1) flagBytes.push(flag | FLAG_REPEAT, run - 1);
		else flagBytes.push(flag);
		i += run;
	}

	const out = new Uint8Array(10 + contours.length * 2 + 2 + flagBytes.length + xBytes.length + yBytes.length);
	const view = new DataView(out.buffer);
	view.setInt16(0, contours.length);
	view.setInt16(2, xMin);
	view.setInt16(4, yMin);
	view.setInt16(6, xMax);
	view.setInt16(8, yMax);
	let p = 10;
	let end = -1;
	for (const contour of contours) {
		end += contour.length;
		view.setUint16(p, end);
		p += 2;
	}
	view.setUint16(p, 0);
	p += 2;
	out.set(flagBytes, p);
	p += flagBytes.length;
	out.set(xBytes, p);
	p += xBytes.length;
	out.set(yBytes, p);
	return out;
}

/**
 * Decode a simple-glyph record produced by {@link encodeSimpleGlyph} (or any
 * conforming §8.2 payload) back into contours. Throws on composite records
 * and on non-zero instruction lengths so a bundle can be validated against
 * the protocol subset before it ships.
 */
export function decodeSimpleGlyph(bytes: Uint8Array): GlyfOutline {
	if (bytes.length === 0) return [];
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const numberOfContours = view.getInt16(0);
	if (numberOfContours < 0) throw new Error("composite glyph records are not allowed");
	let p = 10;
	const endPts: number[] = [];
	for (let i = 0; i < numberOfContours; i++) {
		endPts.push(view.getUint16(p));
		p += 2;
	}
	const instructionLength = view.getUint16(p);
	if (instructionLength !== 0) throw new Error("hinting instructions are not allowed");
	p += 2;
	const pointCount = numberOfContours === 0 ? 0 : endPts[numberOfContours - 1]! + 1;
	const flags = new Uint8Array(pointCount);
	for (let i = 0; i < pointCount;) {
		const flag = view.getUint8(p++);
		flags[i++] = flag;
		if (flag & FLAG_REPEAT) {
			let repeat = view.getUint8(p++);
			while (repeat-- > 0 && i < pointCount) flags[i++] = flag;
		}
	}
	const xs = new Int32Array(pointCount);
	let x = 0;
	for (let i = 0; i < pointCount; i++) {
		const flag = flags[i]!;
		if (flag & FLAG_X_SHORT) {
			const delta = view.getUint8(p++);
			x += flag & FLAG_X_SAME_OR_POSITIVE ? delta : -delta;
		} else if (!(flag & FLAG_X_SAME_OR_POSITIVE)) {
			x += view.getInt16(p);
			p += 2;
		}
		xs[i] = x;
	}
	const ys = new Int32Array(pointCount);
	let y = 0;
	for (let i = 0; i < pointCount; i++) {
		const flag = flags[i]!;
		if (flag & FLAG_Y_SHORT) {
			const delta = view.getUint8(p++);
			y += flag & FLAG_Y_SAME_OR_POSITIVE ? delta : -delta;
		} else if (!(flag & FLAG_Y_SAME_OR_POSITIVE)) {
			y += view.getInt16(p);
			p += 2;
		}
		ys[i] = y;
	}
	if (p !== bytes.length) throw new Error(`trailing bytes after glyph record (${bytes.length - p})`);
	const contours: GlyfOutline = [];
	let first = 0;
	for (const last of endPts) {
		const contour: GlyfPoint[] = [];
		for (let i = first; i <= last; i++) {
			contour.push({ x: xs[i]!, y: ys[i]!, onCurve: (flags[i]! & FLAG_ON_CURVE) !== 0 });
		}
		contours.push(contour);
		first = last + 1;
	}
	return contours;
}
