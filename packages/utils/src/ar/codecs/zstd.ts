import { promisify } from "node:util";
import type * as Zlib from "node:zlib";
import { ArchiveError } from "../error";
import { type ByteSource, decodeByteSource, STREAM_CHUNK_SIZE } from "../source";

let zlibCache: typeof Zlib | undefined;
let zstdCompressAsyncCache: ((buf: Zlib.InputType, options?: Zlib.ZstdOptions) => Promise<Buffer>) | undefined;
let zstdDecompressAsyncCache: ((buf: Zlib.InputType, options?: Zlib.ZstdOptions) => Promise<Buffer>) | undefined;
function getZlib(): typeof Zlib {
	if (!zlibCache) zlibCache = require("node:zlib") as typeof Zlib;
	return zlibCache;
}
function zstdCompressAsync(buf: Zlib.InputType, options?: Zlib.ZstdOptions): Promise<Buffer> {
	if (!zstdCompressAsyncCache) zstdCompressAsyncCache = promisify(getZlib().zstdCompress);
	return zstdCompressAsyncCache(buf, options);
}
function zstdDecompressAsync(buf: Zlib.InputType, options?: Zlib.ZstdOptions): Promise<Buffer> {
	if (!zstdDecompressAsyncCache) zstdDecompressAsyncCache = promisify(getZlib().zstdDecompress);
	return zstdDecompressAsyncCache(buf, options);
}

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

/** Decompress a zstd source as a stream of chunks, bounded to `maxOutput` bytes, for output too large to hold at once. */
export function zstdDecompressStream(source: ByteSource, maxOutput: number): AsyncGenerator<Uint8Array> {
	return decodeByteSource(source, getZlib().createZstdDecompress({ chunkSize: STREAM_CHUNK_SIZE }), maxOutput);
}

/** Compress bytes as one zstd frame (tar.zst writing). */
export function zstdCompress(bytes: Uint8Array): Promise<Uint8Array> {
	return zstdCompressAsync(bytes);
}
