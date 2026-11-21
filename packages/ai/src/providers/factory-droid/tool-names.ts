/**
 * The CLI sanitizes tool names to `[a-zA-Z0-9_-]`; a name longer than
 * `maxLength` (64 by default) keeps its first `maxLength - 9` chars and ends
 * `_` + an 8-char sha256, `maxLength` in all, which stays inside the route's
 * tool-name bound. Applied to declarations and replayed call/result names on
 * every wire droid sanitizes.
 */
export function sanitizeFactoryDroidToolName(name: string, maxLength = 64): string {
	const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
	if (sanitized.length <= maxLength) return sanitized;
	return `${sanitized.slice(0, maxLength - 9)}_${Bun.SHA256.hash(sanitized, "hex").slice(0, 8)}`;
}

/**
 * Chat-completions names go out verbatim (the route accepts dots) unless they
 * exceed `maxLength`, the target's catalog `tool-call-name-max-length`; only
 * those take the capped, sanitized form.
 */
export function encodeFactoryDroidCompletionsToolName(name: string, maxLength: number): string {
	return name.length > maxLength ? sanitizeFactoryDroidToolName(name, maxLength) : name;
}
