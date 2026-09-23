import { promisify } from "node:util";
import * as zlib from "node:zlib";
import { ArchiveError } from "../error";

const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);

/** gzip magic: 0x1f 0x8b. */
export function isGzip(bytes: Uint8Array): boolean {
	return bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** Decompress one gzip stream, bounded so a gzip bomb cannot inflate without limit. */
export async function gzipDecompress(bytes: Uint8Array, maxOutput: number): Promise<Uint8Array> {
	try {
		return await gunzipAsync(bytes, { maxOutputLength: Math.max(maxOutput, 1) });
	} catch (error) {
		throw new ArchiveError(error instanceof Error ? error.message : String(error));
	}
}

/** Compress bytes as one gzip stream (tar.gz writing). */
export function gzipCompress(bytes: Uint8Array): Promise<Uint8Array> {
	return gzipAsync(bytes);
}
