/**
 * Decode a response body honoring the declared charset (Content-Type header,
 * then, for HTML or untyped bodies, a cheap <meta charset> sniff), falling
 * back to UTF-8.
 */
export function decodeBody(bytes: Uint8Array, contentTypeHeader: string): string {
	let label = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentTypeHeader)?.[1];
	// A JSON or text payload may quote a `<meta charset>` tag as data; only an
	// HTML document's own markup declares its encoding that way.
	if (!label && (contentTypeHeader.trim() === "" || /html/i.test(contentTypeHeader))) {
		// All charsets we can decode are ASCII-compatible in the prefix, so a
		// latin1 view of the first 2KB is enough to find a <meta charset>.
		label = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(
			new TextDecoder("latin1").decode(bytes.subarray(0, 2048)),
		)?.[1];
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
