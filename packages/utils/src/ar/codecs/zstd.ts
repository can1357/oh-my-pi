import { promisify } from "node:util";
import * as zlib from "node:zlib";
import { ArchiveError } from "../error";

const zstdCompressAsync = promisify(zlib.zstdCompress);
const zstdDecompressAsync = promisify(zlib.zstdDecompress);

/** zstd frame magic: 28 b5 2f fd. */
export function isZstd(bytes: Uint8Array): boolean {
	return bytes.byteLength >= 4 && bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd;
}

/** Decompress one zstd frame, bounded to `maxOutput` bytes. */
export async function zstdDecompress(bytes: Uint8Array, maxOutput: number): Promise<Uint8Array> {
	try {
		return await zstdDecompressAsync(bytes, { maxOutputLength: Math.max(maxOutput, 1) });
	} catch (error) {
		throw new ArchiveError(error instanceof Error ? error.message : String(error));
	}
}

/** Compress bytes as one zstd frame (tar.zst writing). */
export function zstdCompress(bytes: Uint8Array): Promise<Uint8Array> {
	return zstdCompressAsync(bytes);
}
