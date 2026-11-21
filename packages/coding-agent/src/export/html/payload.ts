/**
 * Streaming encoder for the `#session-data` payload of HTML exports.
 *
 * The viewer reads base64(UTF-8 JSON). Building that as one `JSON.stringify`
 * string, a `Buffer`, and a base64 string holds several payload-sized copies
 * at once and fails with `RangeError: Out of memory` once the base64 passes
 * JSC's 2^31-1 character string limit (#17741). {@link writeBase64Json}
 * produces the same bytes in bounded chunks instead.
 */

/** Write target for encoded chunks; Bun's `FileSink` in production. */
export interface ChunkSink {
	write(chunk: string): unknown;
}

/** Bytes encoded per flush; a multiple of 3 so intermediate chunks carry no `=` padding. */
const CHUNK_BYTES = 3 << 20;

/**
 * Container depth serialized piecewise. Four levels reach each transcript
 * entry: root → `subSessions` → sub-session → `entries` → entry.
 */
const STREAM_DEPTH = 4;

/**
 * Write `value` to `sink` as base64 of its UTF-8 JSON, byte-identical to
 * `Buffer.from(JSON.stringify(value)).toBase64()`, without materializing either
 * string. Only a single entry-sized JSON piece and one chunk are resident.
 *
 * Yields to the event loop after every chunk: the per-entry JSON and base64
 * strings are garbage the moment they are written, and a synchronous loop
 * starves JSC's GC timer until that garbage doubles the live heap. The yield
 * also keeps an interactive `/export` responsive.
 *
 * `chunkBytes` (≥ 6) bounds each write; tests shrink it to exercise boundaries.
 * Throws whatever `JSON.stringify` throws (e.g. on `bigint` or cycles).
 */
export async function writeBase64Json(value: unknown, sink: ChunkSink, chunkBytes = CHUNK_BYTES): Promise<void> {
	const encoder = new TextEncoder();
	const buffer = new Uint8Array(chunkBytes);
	let length = 0;
	const flush = async (final: boolean) => {
		// Keep the 1–2 trailing bytes of an unfinished 3-byte group for the next chunk.
		const count = final ? length : length - (length % 3);
		if (count === 0) return;
		sink.write(buffer.subarray(0, count).toBase64());
		buffer.copyWithin(0, count, length);
		length -= count;
		await Bun.sleep(0);
	};
	for (const piece of jsonPieces(value, STREAM_DEPTH)) {
		let rest = piece;
		while (rest.length > 0) {
			// encodeInto stops before a code point that does not fit; flushing frees room for it.
			const { read, written } = encoder.encodeInto(rest, buffer.subarray(length));
			length += written;
			rest = rest.slice(read);
			if (rest.length > 0) await flush(false);
		}
	}
	await flush(true);
}

/** Values `JSON.stringify` drops from objects and writes as `null` in arrays. */
function omittedByJson(value: unknown): boolean {
	return value === undefined || typeof value === "function" || typeof value === "symbol";
}

/** Object literal or `Object.create(null)` record: `for…in` sees exactly its own enumerable keys. */
function isPlainObject(value: object): value is Record<string, unknown> {
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * Yield the JSON text of `value` in pieces whose concatenation equals
 * `JSON.stringify(value)`, descending `depth` levels into arrays and plain
 * objects. Anything deeper, or with custom serialization, is stringified whole.
 */
function* jsonPieces(value: unknown, depth: number): Generator<string> {
	if (depth > 0 && typeof value === "object" && value !== null && !("toJSON" in value)) {
		if (Array.isArray(value)) {
			yield "[";
			for (let i = 0; i < value.length; i++) {
				if (i > 0) yield ",";
				const item: unknown = value[i];
				if (omittedByJson(item)) yield "null";
				else yield* jsonPieces(item, depth - 1);
			}
			yield "]";
			return;
		}
		if (isPlainObject(value)) {
			yield "{";
			let separator = "";
			for (const key in value) {
				const item = value[key];
				if (omittedByJson(item)) continue;
				yield `${separator}${JSON.stringify(key)}:`;
				separator = ",";
				yield* jsonPieces(item, depth - 1);
			}
			yield "}";
			return;
		}
	}
	yield JSON.stringify(value);
}
