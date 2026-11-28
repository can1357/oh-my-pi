/**
 * `source.chunks(...args)`, or for a source without bounded reads the one
 * `source.read(...args)` as a single chunk (see `MemberSource.chunks`).
 */
export async function* chunksOrWhole<Args extends unknown[]>(
	source: {
		read(...args: Args): Promise<Uint8Array>;
		chunks?(...args: Args): AsyncIterable<Uint8Array>;
	},
	...args: Args
): AsyncGenerator<Uint8Array> {
	if (source.chunks) yield* source.chunks(...args);
	else yield await source.read(...args);
}
