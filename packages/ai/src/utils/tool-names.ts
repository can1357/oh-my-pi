import type { Tool } from "../types";

/**
 * Wire name -> caller tool name for the declared tools, so a returned call
 * dispatches to the tool that was advertised. Two tools sharing one wire name
 * could not be told apart, so that request is rejected before it is sent.
 */
export function toolNamesByWire(
	tools: readonly Tool[] | undefined,
	encode: (name: string) => string,
): Map<string, string> {
	const names = new Map<string, string>();
	for (const tool of tools ?? []) {
		const wire = encode(tool.name);
		const existing = names.get(wire);
		if (existing !== undefined && existing !== tool.name) {
			throw new Error(`Tool names "${existing}" and "${tool.name}" both encode as "${wire}"`);
		}
		names.set(wire, tool.name);
	}
	return names;
}
