import * as fs from "node:fs/promises";
import * as path from "node:path";
import { writeChunksToSink } from "./chunk-sink";

/**
 * Write `chunks` to `destPath` in order, replacing the file: the helper
 * creates missing parent directories and truncates an existing file before
 * it requests the first chunk. A failure after that can leave an empty or
 * partial file. The helper waits for each write before requesting the next
 * chunk. It does not accumulate the input, but the sink may buffer bytes. It
 * closes the file even if a read or write fails, so the caller can remove the
 * partial file.
 */
export async function writeChunksToFile(destPath: string, chunks: AsyncIterable<Uint8Array>): Promise<void> {
	await fs.mkdir(path.dirname(destPath), { recursive: true });
	await using file = await fs.open(destPath, "w");
	await writeChunksToSink(Bun.file(file.fd).writer(), chunks);
}
