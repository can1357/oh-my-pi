/**
 * Embedded stats dashboard archive handling.
 *
 * `embedded-client.generated.txt` holds the base64 of a gzipped tar of the
 * built dashboard (`dist/client`). It is populated by
 * `gen:stats` for compiled binaries and the
 * prepacked npm bundle, and reset to an empty file afterwards so the dev tree
 * keeps building the dashboard from source.
 */

/**
 * Cheap check whether the generated text carries a gzip archive: sniffs the
 * base64 of the gzip magic (`1f 8b 08`) without decoding megabytes.
 */
export function hasEmbeddedClientArchive(txt: string): boolean {
	return /^\s*H4s/.test(txt);
}

/**
 * Decode the generated archive text.
 *
 * Returns `null` when the content is blank or not a raw gzip archive encoded as
 * base64 — notably the legacy placeholder that contained a TypeScript
 * `export const … = "";` stub, which must be treated as "no archive embedded"
 * rather than decoded into garbage bytes.
 */
export function decodeEmbeddedClientArchive(txt: string): Buffer | null {
	if (!hasEmbeddedClientArchive(txt)) return null;
	const normalized = txt.replaceAll(/\s+/g, "");
	if (!normalized) return null;
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return null;
	const archiveBytes = Buffer.from(normalized, "base64");
	if (archiveBytes[0] !== 0x1f || archiveBytes[1] !== 0x8b) return null;
	return archiveBytes;
}
