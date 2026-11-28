/**
 * Detection of unresolved externalized image blob references.
 *
 * When a session's image blobs cannot be dereferenced (missing file after
 * cross-machine sync, GC, or native history replay), the transcript still
 * carries a `blob:sha256:<hex>` reference. Those refs must never reach the
 * wire as a data URL: providers reject the poisoned base64 with HTTP 400 and
 * the ref persists in history, so every later turn in the session fails.
 * Instead, image blocks holding an unresolved ref degrade to a text
 * placeholder; valid inline bytes, `https://` URLs and `providerFile`
 * references are untouched.
 */

const BLOB_SHA256_REF_RE = /^blob:sha256:[a-f0-9]{64}$/i;

const BLOB_WRAPPED_RE = /^data:[^;,]+;base64,blob:sha256:[a-f0-9]{64}$/i;

export const UNRESOLVED_BLOB_IMAGE_PLACEHOLDER = "[image omitted: unresolved blob reference]";

/** True when `value` is a bare `blob:sha256:` reference or a data URL wrapping one. */
export function isUnresolvedBlobRef(value: string | undefined | null): boolean {
	if (!value) return false;
	return BLOB_SHA256_REF_RE.test(value) || BLOB_WRAPPED_RE.test(value);
}

/**
 * True when an image block's inline payload is (or wraps) an unresolved blob
 * reference instead of actual image bytes — i.e. building
 * `data:<mime>;base64,<data>` would emit a poisoned URL.
 */
export function isUnresolvedBlobImage(data: string | undefined | null): boolean {
	return isUnresolvedBlobRef(data);
}
