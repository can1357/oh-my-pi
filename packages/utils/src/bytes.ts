/**
 * Narrow `bytes` to a view over its own whole `ArrayBuffer`, which is what
 * `crypto.subtle.{digest,sign,importKey,encrypt,decrypt}` require under the
 * strict TS DOM typings. Returns `bytes` itself when it already is one,
 * otherwise a copy.
 */
export function asStrictBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
	if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
		return bytes as Uint8Array<ArrayBuffer>;
	}
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy;
}
