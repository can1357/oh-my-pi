import type { Tool } from "../../types";

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

/**
 * Wire name -> caller tool name for the declared tools, so returned calls
 * dispatch to the tool that was advertised. Two tools sharing one wire name
 * could not be told apart, so that request is rejected.
 */
export function factoryDroidToolNamesByWire(
	tools: Tool[] | undefined,
	encode: (name: string) => string = sanitizeFactoryDroidToolName,
): Map<string, string> {
	const names = new Map<string, string>();
	for (const tool of tools ?? []) {
		const wire = encode(tool.name);
		const existing = names.get(wire);
		if (existing !== undefined && existing !== tool.name) {
			throw new Error(`Factory tool names "${existing}" and "${tool.name}" both encode as "${wire}"`);
		}
		names.set(wire, tool.name);
	}
	return names;
}
