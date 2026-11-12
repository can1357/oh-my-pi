import type { Tool } from "@oh-my-pi/pi-ai";

/**
 * Exact registry names shadow wire aliases; an alias must have exactly one claimant.
 * Availability is a caller concern: disabled entries still shadow names and count toward ambiguity.
 */
export function resolveToolWireName<T extends Pick<Tool, "name" | "customWireName">>(
	tools: ReadonlyMap<string, T>,
	name: string,
): T | undefined {
	const exact = tools.get(name);
	if (exact) return exact;
	let resolved: T | undefined;
	for (const tool of tools.values()) {
		if (tool.customWireName !== name) continue;
		if (resolved) return undefined;
		resolved = tool;
	}
	return resolved;
}
