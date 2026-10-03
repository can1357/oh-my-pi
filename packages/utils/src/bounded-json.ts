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

/** Read response bytes while bounding retained memory. */
export async function readBoundedBytes(
	response: Response,
	maxBytes: number,
	options: ReadBoundedBytesOptions = {},
): Promise<Uint8Array> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError("maxBytes must be a positive integer");
	const truncate = options.truncate ?? false;
	const contentLength = response.headers.get("content-length");
	if (!truncate && contentLength && Number(contentLength) > maxBytes) {
		throw new BoundedJsonReadError("size");
	}
	const reader = response.body?.getReader();
	if (!reader) return new Uint8Array(0);

	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
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
			if (value.byteLength === 0) continue;
			const remaining = maxBytes - totalBytes;
			if (value.byteLength > remaining) {
				if (remaining > 0) {
					chunks.push(value.subarray(0, remaining));
					totalBytes += remaining;
				}
				await reader.cancel().catch(() => {});
				if (!truncate) throw new BoundedJsonReadError("size");
				break;
			}
			chunks.push(value);
			totalBytes += value.byteLength;
		}
	} finally {
		signal?.removeEventListener("abort", onAbort);
		reader.releaseLock();
	}

	// Cancelling the reader resolves the pending read as `done`, so the abort is
	// only visible on the signal afterwards. Without this the caller could not
	// tell a stalled peer from a body that genuinely ended.
	if (signal?.aborted) throw signal.reason;

	const bytes = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
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
