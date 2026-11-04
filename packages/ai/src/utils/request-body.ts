/**
 * Bytes of a request body as the server reads them: the `gzip`/`zstd`
 * `Content-Encoding` applied by request compression is undone, any other
 * encoding is returned untouched.
 */
export function decodeRequestBodyBytes(bytes: Uint8Array, contentEncoding: string | null): Uint8Array {
	switch (contentEncoding?.trim().toLowerCase()) {
		case "gzip":
			return Bun.gunzipSync(bytes as Uint8Array<ArrayBuffer>);
		case "zstd":
			return Bun.zstdDecompressSync(bytes);
		default:
			return bytes;
	}
}

/**
 * Text of a string or byte request body after undoing its content encoding;
 * `undefined` when the request has no such body (none, stream, form data).
 */
export function requestBodyText(init: RequestInit | undefined): string | undefined {
	const body = init?.body;
	if (typeof body === "string") return body;
	if (!(body instanceof Uint8Array)) return undefined;
	const encoding = new Headers(init?.headers).get("content-encoding");
	return new TextDecoder().decode(decodeRequestBodyBytes(body, encoding));
}
