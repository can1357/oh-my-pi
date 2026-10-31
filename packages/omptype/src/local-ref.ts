/**
 * Shared parsing for local `$ref` URI fragments (RFC 6901 JSON Pointers).
 * omptype's JSON Schema importer and pi-ai's schema resolvers decode refs
 * through these helpers so percent-encoded, pointer-escaped, and empty tokens
 * resolve identically everywhere.
 */

/**
 * Parse a local `$ref` URI fragment into decoded JSON Pointer tokens:
 * percent-decode the fragment, split on `/`, then unescape `~1`/`~0` per
 * token. Returns `[]` for the root ref `#`, and `undefined` for non-local
 * refs or fragments that do not percent-decode.
 */
export function parseLocalRefPointer(ref: string): string[] | undefined {
	if (!ref.startsWith("#")) return undefined;
	let pointer: string;
	try {
		pointer = decodeURIComponent(ref.slice(1));
	} catch {
		return undefined;
	}
	if (pointer.length > 0 && !pointer.startsWith("/")) return undefined;
	return pointer
		.split("/")
		.slice(1)
		.map(token => token.replace(/~1/g, "/").replace(/~0/g, "~"));
}

/**
 * Encode JSON Pointer tokens back into a local `$ref` URI fragment — the
 * inverse of {@link parseLocalRefPointer}.
 */
export function formatLocalRefPointer(tokens: readonly string[]): string {
	if (tokens.length === 0) return "#";
	// `$` and the other URI sub-delims `encodeURIComponent` escapes are legal
	// in fragments, so keep `$defs` readable; `%` stays encoded to round-trip.
	const encoded = tokens
		.map(token => encodeURIComponent(token.replace(/~/g, "~0").replace(/\//g, "~1")))
		.map(token => token.replace(/%24/g, "$"));
	return `#/${encoded.join("/")}`;
}
