/** Canonical prefix for virtual tool-device URLs. */
export const XD_URL_PREFIX = "xd://";

/** Returns the canonical tool name from a bare or `xd://`-prefixed spelling. */
export function stripXdUrlPrefix(name: string): string {
	return name.toLowerCase().startsWith(XD_URL_PREFIX) ? name.slice(XD_URL_PREFIX.length) : name;
}

/**
 * Parse an `xd://` URL into its device target.
 * Returns `null` for other or malformed URLs and `name: null` for the root.
 */
export function parseXdUrl(input: string): { name: string | null } | null {
	const trimmed = input.trim();
	if (!trimmed.toLowerCase().startsWith(XD_URL_PREFIX)) return null;
	const name = trimmed.slice(XD_URL_PREFIX.length);
	if (name.length === 0) return { name: null };
	if (/[/?#]/.test(name)) return null;
	return { name };
}

/**
 * Parse a read-only `xd://<tool>/<topic>` documentation URL.
 * Returns `null` for anything else, including bare device URLs.
 */
export function parseXdTopicUrl(input: string): { name: string; topic: string } | null {
	const match = /^xd:\/\/([^/?#]+)\/([^/?#]+)$/i.exec(input.trim());
	return match ? { name: match[1]!, topic: match[2]! } : null;
}

/** Whether a streaming path prefix could still become an `xd://` URL. */
export function couldBecomeXdUrl(partialPath: string): boolean {
	if (partialPath.length <= XD_URL_PREFIX.length) {
		return XD_URL_PREFIX.startsWith(partialPath.toLowerCase());
	}
	return partialPath.toLowerCase().startsWith(XD_URL_PREFIX);
}
