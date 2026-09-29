import { deflateSync } from "node:zlib";

export const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** Encode 8-bit RGB (3 channels) or RGBA (4 channels) pixels as a non-interlaced PNG. */
export function encodeRawPng(pixels: Uint8Array, width: number, height: number, channels: 3 | 4): Buffer {
	const stride = width * channels;
	const scanlines = Buffer.allocUnsafe((stride + 1) * height);
	for (let row = 0; row < height; row++) {
		const outputOffset = row * (stride + 1);
		scanlines[outputOffset] = 0;
		scanlines.set(pixels.subarray(row * stride, (row + 1) * stride), outputOffset + 1);
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = channels === 3 ? 2 : 6;
	return Buffer.concat([
		PNG_SIGNATURE,
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(scanlines)),
		pngChunk("IEND", new Uint8Array()),
	]);
}

function pngChunk(type: string, data: Uint8Array): Buffer {
	const chunk = Buffer.allocUnsafe(12 + data.length);
	chunk.writeUInt32BE(data.length, 0);
	chunk.write(type, 4, 4, "ascii");
	chunk.set(data, 8);
	chunk.writeUInt32BE(Bun.hash.crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
	return chunk;
}
