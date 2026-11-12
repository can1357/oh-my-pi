export type BoundedJsonReadErrorKind = "missing-body" | "empty-body" | "size" | "invalid-json";

export class BoundedJsonReadError extends Error {
	readonly kind: BoundedJsonReadErrorKind;

	constructor(kind: BoundedJsonReadErrorKind, options: ErrorOptions = {}) {
		super(`Bounded JSON read failed: ${kind}`, options);
		this.name = "BoundedJsonReadError";
		this.kind = kind;
	}
}

export interface ReadBoundedBytesOptions {
	/** Keep the prefix instead of failing when the response exceeds maxBytes. */
	truncate?: boolean;
	/**
	 * Cancel the read when this aborts. Error bodies can arrive with a short
	 * payload on a connection the peer never closes, so a caller with a
	 * deadline must be able to stop waiting for EOF.
	 */
	signal?: AbortSignal;
}

/** A response body read up to a byte cap. */
interface BoundedBody {
	/** At most `maxBytes` bytes: the whole body, or its head when {@link truncated}. */
	bytes: Uint8Array;
	/** The body continued past the cap and the read stopped there. */
	truncated: boolean;
}

/**
 * Read a response body up to `maxBytes`, stopping once the cap is crossed so an
 * oversized body cannot balloon memory. Returns `null` when the response has
 * no readable body.
 */
async function readBoundedBody(
	response: Response,
	maxBytes: number,
	options: { signal?: AbortSignal } = {},
): Promise<BoundedBody | null> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError("maxBytes must be a positive integer");
	const reader = response.body?.getReader();
	if (!reader) return null;

	// One buffer grown up to the cap: a body delivered as many tiny (or empty)
	// chunks must not retain one object per chunk.
	let buffer = new Uint8Array(Math.min(maxBytes, 64 * 1024));
	let size = 0;
	let truncated = false;
	const signal = options.signal;
	const aborted = signal ? Promise.withResolvers<never>() : undefined;
	const onAbort = (): void => {
		void reader.cancel().catch(() => {});
		aborted?.reject(signal?.reason);
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		while (true) {
			const read = reader.read();
			// Without a signal the read is the whole wait; with one, an abort must
			// win so a stalled peer cannot hold the caller past its deadline.
			const { done, value } = aborted ? await Promise.race([read, aborted.promise]) : await read;
			if (done) break;
			const accepted = Math.min(value.byteLength, maxBytes - size);
			if (size + accepted > buffer.byteLength) {
				const grown = new Uint8Array(Math.min(maxBytes, Math.max(size + accepted, buffer.byteLength * 2)));
				grown.set(buffer.subarray(0, size));
				buffer = grown;
			}
			buffer.set(value.subarray(0, accepted), size);
			size += accepted;
			if (accepted < value.byteLength) {
				truncated = true;
				await reader.cancel().catch(() => {});
				break;
			}
		}
	} finally {
		signal?.removeEventListener("abort", onAbort);
		reader.releaseLock();
	}

	// Cancelling the reader resolves the pending read as `done`, so the abort is
	// only visible on the signal afterwards. Without this the caller could not
	// tell a stalled peer from a body that genuinely ended.
	if (signal?.aborted) throw signal.reason;
	return { bytes: buffer.subarray(0, size), truncated };
}

/**
 * Read response bytes while bounding retained memory. A body over `maxBytes`
 * fails with a `size` {@link BoundedJsonReadError} unless `truncate` keeps its
 * head; a missing body reads as empty.
 */
export async function readBoundedBytes(
	response: Response,
	maxBytes: number,
	options: ReadBoundedBytesOptions = {},
): Promise<Uint8Array> {
	const truncate = options.truncate ?? false;
	const contentLength = response.headers.get("content-length");
	if (!truncate && contentLength && Number(contentLength) > maxBytes) {
		// Release the connection: the caller abandons the response on this throw.
		await response.body?.cancel().catch(() => {});
		throw new BoundedJsonReadError("size");
	}
	const body = await readBoundedBody(response, maxBytes, { signal: options.signal });
	if (!body) return new Uint8Array(0);
	if (body.truncated && !truncate) throw new BoundedJsonReadError("size");
	return body.bytes;
}

/** Read one strict UTF-8 JSON response while bounding retained bytes. */
export async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
	if (!response.body) throw new BoundedJsonReadError("missing-body");
	const bytes = await readBoundedBytes(response, maxBytes);
	if (bytes.byteLength === 0) throw new BoundedJsonReadError("empty-body");
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
	} catch (cause) {
		throw new BoundedJsonReadError("invalid-json", { cause });
	}
}
