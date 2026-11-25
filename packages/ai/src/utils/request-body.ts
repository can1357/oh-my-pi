import { readBoundedBody } from "@oh-my-pi/pi-utils/bounded-json";

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
 * Read a request body of at most `maxBytes`, rejecting on the declared
 * `Content-Length` before reading and cancelling the stream once the limit is
 * crossed. `tooLarge` builds the caller's own error.
 *
 * @internal Shared by the endpoint servers; not part of the SDK surface.
 */
export async function readBoundedRequestBody(
	req: Request,
	maxBytes: number,
	tooLarge: () => Error,
): Promise<Uint8Array> {
	const contentLength = req.headers.get("content-length");
	if (contentLength !== null) {
		const declared = Number(contentLength);
		if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
	}
	const body = await readBoundedBody(req, maxBytes);
	if (!body) return new Uint8Array();
	if (body.truncated) throw tooLarge();
	return body.bytes;
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
