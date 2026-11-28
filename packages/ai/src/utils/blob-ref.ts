/**
 * Canonical `blob:sha256:` image references, and detection of unresolved ones.
 *
 * When a session's image blobs cannot be dereferenced (missing file after
 * cross-machine sync, GC, or native history replay), the transcript still
 * carries a `blob:sha256:<hex>` reference. Those refs must never reach the
 * wire as a data URL: providers reject the poisoned base64 with HTTP 400 and
 * the ref persists in history, so every later turn in the session fails.
 * Instead, image blocks holding an unresolved ref degrade to a text
 * placeholder; valid inline bytes, `https://` URLs and `providerFile`
 * references are untouched.
 *
 * This is the single definition of the format. Session storage (`blob-store.ts`)
 * imports these helpers rather than keeping a second copy of the prefix and hash
 * grammar.
 */

/** Canonical blob hash shape: exactly 64 lowercase hex chars (a SHA-256 digest). */
export const BLOB_HASH_RE = /^[a-f0-9]{64}$/;

export const BLOB_PREFIX = "blob:sha256:";

const BLOB_WRAPPED_RE = /^data:[^;,]+;base64,(blob:sha256:[a-f0-9]{64})$/;

export const UNRESOLVED_BLOB_IMAGE_PLACEHOLDER = "[image omitted: unresolved blob reference]";

/** True when `data` starts with the `blob:sha256:` prefix. */
export function isBlobRef(data: string): boolean {
	return data.startsWith(BLOB_PREFIX);
}

/**
 * Extract the SHA-256 hash from a blob reference string.
 *
 * Returns null when the string is not a blob ref, or when the suffix is not a
 * canonical 64-char lowercase hex hash.
 */
export function parseBlobRef(data: string): string | null {
	if (!data.startsWith(BLOB_PREFIX)) return null;
	const hash = data.slice(BLOB_PREFIX.length);
	return BLOB_HASH_RE.test(hash) ? hash : null;
}

/** True when `value` is a bare `blob:sha256:` reference or a data URL wrapping one. */
export function isUnresolvedBlobRef(value: string | undefined | null): boolean {
	if (!value) return false;
	if (parseBlobRef(value)) return true;
	const wrapped = BLOB_WRAPPED_RE.exec(value);
	return wrapped ? parseBlobRef(wrapped[1]!) !== null : false;
}
