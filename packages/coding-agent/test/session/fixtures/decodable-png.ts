/**
 * Hand-built decodable PNGs for the image-budget suites.
 *
 * Built by hand rather than upscaled from a seed because `Bun.Image`
 * re-encodes, and a replicated or flat raster compresses to a few KB — far
 * under any byte budget. Deflate "stored" blocks (BTYPE=00) keep the IDAT
 * stream the size of the raw scanlines instead.
 */

/**
 * A decodable PNG whose encoded size tracks its raster size.
 *
 * Built by hand rather than upscaled from a seed: `Bun.Image` re-encodes, and a
 * replicated or flat raster compresses to a few KB, far under any byte budget.
 * Deflate "stored" blocks (BTYPE=00) keep the IDAT stream the size of the raw
 * scanlines, so a 1100px square lands near 4.8 MB of base64.
 *
 * Per-pixel noise, so it stays large through a re-encode as well.
 */
export function largeDecodablePng(edge: number): Uint8Array {
	return decodablePng(edge, (y, x) => (y * 7 + x * 13) % 256);
}

/**
 * As {@link largeDecodablePng}, but low-detail: still enormous stored
 * uncompressed, yet it collapses to tens of KB once resized and re-encoded.
 * That gap is what distinguishes a byte budget measured before the provider's
 * downscale from one measured after it.
 */
export function smoothDecodablePng(edge: number): Uint8Array {
	return decodablePng(edge, y => (y >> 4) & 0xf0);
}

/** Truecolour PNG with an uncompressed IDAT, each sample from `sample`. */
function decodablePng(edge: number, sample: (y: number, x: number) => number): Uint8Array {
	const raw = new Uint8Array(edge * (1 + edge * 3));
	for (let y = 0; y < edge; y++) {
		const row = y * (1 + edge * 3);
		raw[row] = 0; // filter: None
		for (let x = 0; x < edge * 3; x++) raw[row + 1 + x] = sample(y, x);
	}
	const chunk = (type: string, data: Uint8Array): Uint8Array => {
		const body = new Uint8Array(4 + data.length);
		body.set(new TextEncoder().encode(type), 0);
		body.set(data, 4);
		const out = new Uint8Array(4 + body.length + 4);
		new DataView(out.buffer).setUint32(0, data.length);
		out.set(body, 4);
		new DataView(out.buffer).setUint32(4 + body.length, crc32(body));
		return out;
	};
	const ihdr = new Uint8Array(13);
	const view = new DataView(ihdr.buffer);
	view.setUint32(0, edge);
	view.setUint32(4, edge);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // colour type: truecolour
	const parts = [
		new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", zlibStored(raw)),
		chunk("IEND", new Uint8Array(0)),
	];
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const png = new Uint8Array(total);
	let at = 0;
	for (const part of parts) {
		png.set(part, at);
		at += part.length;
	}
	return png;
}

/** zlib stream of `data` in uncompressed deflate blocks. */
function zlibStored(data: Uint8Array): Uint8Array {
	const MAX = 65535;
	const blocks = Math.ceil(data.length / MAX);
	const out = new Uint8Array(2 + blocks * 5 + data.length + 4);
	out[0] = 0x78;
	out[1] = 0x01;
	let at = 2;
	for (let start = 0; start < data.length; start += MAX) {
		const slice = data.subarray(start, Math.min(start + MAX, data.length));
		out[at++] = start + MAX >= data.length ? 1 : 0;
		out[at++] = slice.length & 0xff;
		out[at++] = (slice.length >> 8) & 0xff;
		out[at++] = ~slice.length & 0xff;
		out[at++] = (~slice.length >> 8) & 0xff;
		out.set(slice, at);
		at += slice.length;
	}
	new DataView(out.buffer).setUint32(at, adler32(data));
	return out.subarray(0, at + 4);
}

function adler32(data: Uint8Array): number {
	let a = 1;
	let b = 0;
	for (const byte of data) {
		a = (a + byte) % 65521;
		b = (b + a) % 65521;
	}
	return ((b << 16) | a) >>> 0;
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(data: Uint8Array): number {
	let c = 0xffffffff;
	for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
