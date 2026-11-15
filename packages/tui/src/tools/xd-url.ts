/** Canonical prefix for virtual tool-device URLs. */
export const XD_URL_PREFIX = "xd://";

/** Returns the canonical tool name from a bare or `xd://`-prefixed spelling. */
export function stripXdUrlPrefix(name: string): string {
	return name.toLowerCase().startsWith(XD_URL_PREFIX) ? name.slice(XD_URL_PREFIX.length) : name;
}

/**
 * `xd://` spelled in a tool-name charset without `:` or `/` (Anthropic allows
 * `[a-zA-Z0-9_-]`): models substitute underscores, so `xd://recall` arrives as
 * `xd_recall`, `xd__recall` or `xd___recall`.
 */
const XD_UNDERSCORE_PREFIX = /^xd_+/i;

/** Returns `name` without an underscore-spelled `xd://` prefix. */
export function stripXdUnderscorePrefix(name: string): string {
	return name.replace(XD_UNDERSCORE_PREFIX, "");
}

/**
 * Parse an `xd://` URL into its device target.
 * Returns `null` for other or malformed URLs and `name: null` for the root.
 *
 * Trailing `:raw` / `:conflicts` stay in the name. Device URLs advertise
 * `selectors: "none"`, and peeling them here would also widen write dispatch
 * (`write xd://ast_edit:raw` would run the device). Cursor skips appending
 * `:raw` for `xd://` instead.
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
