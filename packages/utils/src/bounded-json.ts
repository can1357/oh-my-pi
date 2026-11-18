type BoundedJsonReadErrorKind = "missing-body" | "empty-body" | "size" | "invalid-json";

export class BoundedJsonReadError extends Error {
	readonly kind: BoundedJsonReadErrorKind;

	constructor(kind: BoundedJsonReadErrorKind, options: ErrorOptions = {}) {
		super(`Bounded JSON read failed: ${kind}`, options);
		this.name = "BoundedJsonReadError";
		this.kind = kind;
	}
}

/**
 * Read a response body up to `maxBytes`, stopping once the cap is crossed so an
 * oversized body cannot balloon memory. `bytes` never exceeds the cap;
 * `truncated` reports that the body continued past it. Returns `null` when the
 * response has no readable body. An abort of `signal` cancels the read and
 * rejects with its reason, so a peer that never closes cannot stall the caller.
 */
export async function readBoundedBody(
	response: Response,
	maxBytes: number,
	options: { signal?: AbortSignal } = {},
): Promise<{ bytes: Uint8Array; truncated: boolean } | null> {
	const reader = response.body?.getReader();
	if (!reader) return null;

	// One buffer grown up to the cap: a body delivered as many tiny (or empty)
	// chunks must not retain one object per chunk.
	let buffer = new Uint8Array(Math.min(maxBytes, 64 * 1024));
	let size = 0;
	let truncated = false;
	const { signal } = options;
	const aborted = signal ? Promise.withResolvers<never>() : undefined;
	const onAbort = (): void => {
		void reader.cancel().catch(() => {});
		aborted?.reject(signal?.reason);
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		while (true) {
			const read = reader.read();
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
	// Cancelling the reader resolves the pending read as `done`; only the signal
	// tells a stalled peer from a body that genuinely ended.
	if (signal?.aborted) throw signal.reason;
	return { bytes: buffer.subarray(0, size), truncated };
}

/** Read one strict UTF-8 JSON response body of at most `maxBytes`. */
export async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
	const contentLength = response.headers.get("content-length");
	if (contentLength && Number(contentLength) > maxBytes) {
		await response.body?.cancel().catch(() => {});
		throw new BoundedJsonReadError("size");
	}
	const body = await readBoundedBody(response, maxBytes);
	if (!body) throw new BoundedJsonReadError("missing-body");
	if (body.truncated) throw new BoundedJsonReadError("size");
	if (body.bytes.byteLength === 0) throw new BoundedJsonReadError("empty-body");
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.bytes)) as unknown;
	} catch (cause) {
		throw new BoundedJsonReadError("invalid-json", { cause });
	}
}
