/**
 * Decode a response body honoring the declared charset (Content-Type header,
 * then, for HTML or untyped bodies, a cheap <meta charset> sniff), falling
 * back to UTF-8.
 */
export function decodeBody(bytes: Buffer, contentTypeHeader: string): string {
	let label = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentTypeHeader)?.[1];
	// A JSON or text payload may quote a `<meta charset>` tag as data; only an
	// HTML document's own markup declares its encoding that way.
	if (!label && (contentTypeHeader.trim() === "" || /html/i.test(contentTypeHeader))) {
		// All charsets we can decode are ASCII-compatible in the prefix, so a
		// latin1 view of the first 2KB is enough to find a <meta charset>.
		label = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(bytes.subarray(0, 2048).toString("latin1"))?.[1];
	}
	if (label && !/^utf-?8$/i.test(label)) {
		try {
			// Bun.Encoding's union is narrower than the runtime, which accepts
			// WHATWG labels (shift_jis, euc-kr, gbk, big5, …); unknowns throw here.
			return new TextDecoder(label as Bun.Encoding).decode(bytes);
		} catch {
			// Unknown/unsupported label — fall back to UTF-8.
		}
	}
	// TextDecoder drops a leading BOM, which JSON.parse would otherwise reject.
	return new TextDecoder().decode(bytes);
}

/**
 * Read a response body up to `maxBytes`, stopping once the cap is crossed.
 * `bytes` never exceeds the cap; `truncated` reports whether the body was cut
 * mid-stream. Returns `null` when the response carries no readable body.
 */
export async function readBodyCapped(
	response: Response,
	maxBytes: number,
): Promise<{ bytes: Buffer; truncated: boolean } | null> {
	const reader = response.body?.getReader();
	if (!reader) return null;

	// One buffer grown up to the cap: a body delivered as many tiny (or empty)
	// chunks must not retain one object per chunk.
	let buffer = new Uint8Array(Math.min(maxBytes, 64 * 1024));
	let size = 0;
	let truncated = false;

	try {
		for (;;) {
			const { done, value } = await reader.read();
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
				// Crossing chunk: keep the head up to the cap, mark the body cut and
				// stop reading so an oversized response cannot balloon memory.
				truncated = true;
				await reader.cancel().catch(() => undefined);
				break;
			}
		}
	} finally {
		reader.releaseLock();
	}

	return { bytes: Buffer.from(buffer.buffer, buffer.byteOffset, size), truncated };
}
