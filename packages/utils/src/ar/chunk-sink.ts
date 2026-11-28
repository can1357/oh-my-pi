/** Write chunks in order and end the sink, even if a read or write fails. */
export async function writeChunksToSink(
	sink: Pick<Bun.FileSink, "write" | "end">,
	chunks: AsyncIterable<Uint8Array>,
): Promise<void> {
	try {
		for await (const chunk of chunks) {
			const written = sink.write(chunk);
			if (typeof written !== "number") await written;
		}
	} catch (error) {
		try {
			await sink.end();
		} catch {
			// The read or write failure is the error worth reporting.
		}
		throw error;
	}
	await sink.end();
}
