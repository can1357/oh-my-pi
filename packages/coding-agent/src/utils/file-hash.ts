/** Lowercase hex SHA-256 of a file's contents, streamed so large files are never buffered whole. */
export async function sha256File(filePath: string): Promise<string> {
	return (await digestStream(Bun.file(filePath).stream())).hash;
}

/** Lowercase hex SHA-256 of the bytes `stream` yields, and their count, hashed chunk by chunk. */
export async function digestStream(stream: AsyncIterable<Uint8Array>): Promise<{ hash: string; bytes: number }> {
	const hasher = new Bun.CryptoHasher("sha256");
	let bytes = 0;
	for await (const chunk of stream) {
		hasher.update(chunk);
		bytes += chunk.byteLength;
	}
	return { hash: hasher.digest("hex"), bytes };
}

/** {@link digestStream} of chunks read synchronously, for a caller that cannot wait. */
export function digestChunksSync(chunks: Iterable<Uint8Array>): { hash: string; bytes: number } {
	const hasher = new Bun.CryptoHasher("sha256");
	let bytes = 0;
	for (const chunk of chunks) {
		hasher.update(chunk);
		bytes += chunk.byteLength;
	}
	return { hash: hasher.digest("hex"), bytes };
}
