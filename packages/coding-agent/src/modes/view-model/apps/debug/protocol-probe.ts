import * as zlib from "node:zlib";

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** Frame a PNG chunk: 4-byte big-endian length, type+data, then the CRC-32 of type+data. */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
	const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
	const out = Buffer.alloc(body.length + 8);
	out.writeUInt32BE(data.length, 0);
	body.copy(out, 4);
	out.writeUInt32BE(Bun.hash.crc32(body) >>> 0, out.length - 4);
	return out;
}

/**
 * Encode raw 8-bit RGB pixels (`width * height * 3` bytes, row-major) as a PNG
 * (color type 2, no interlacing). The IDAT payload is a real zlib stream from
 * {@link zlib.deflateSync}, so the output is a fully valid PNG that every image
 * protocol — including Sixel, which decodes the bytes natively — accepts.
 */
export function encodeRgbPng(width: number, height: number, rgb: Uint8Array): Uint8Array {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // color type: truecolor RGB
	// compression (0), filter (0), interlace (0) are already zeroed.

	const stride = width * 3;
	// Each scanline is prefixed with a filter-type byte (0 = None).
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		raw.set(rgb.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
	}
	const idat = zlib.deflateSync(raw);

	return Buffer.concat([
		PNG_SIGNATURE,
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", idat),
		pngChunk("IEND", new Uint8Array(0)),
	]);
}

/** Encoded image and geometry used by terminal protocol probes. */
export interface SampleImage {
	base64: string;
	mimeType: string;
	dimensions: { widthPx: number; heightPx: number };
}

/** Build a deterministic RGB gradient PNG (red across, green down, constant blue). */
export function buildSampleImage(width = 192, height = 128): SampleImage {
	const denomX = Math.max(1, width - 1);
	const denomY = Math.max(1, height - 1);
	const rgb = new Uint8Array(width * height * 3);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 3;
			rgb[i] = Math.round((x / denomX) * 255);
			rgb[i + 1] = Math.round((y / denomY) * 255);
			rgb[i + 2] = 128;
		}
	}
	const png = encodeRgbPng(width, height, rgb);
	return {
		base64: Buffer.from(png).toString("base64"),
		mimeType: "image/png",
		dimensions: { widthPx: width, heightPx: height },
	};
}
