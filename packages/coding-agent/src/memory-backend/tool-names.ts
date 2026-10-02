import { XD_URL_PREFIX } from "@oh-my-pi/pi-tui/tools/xd-url";

/** Built-in tools whose availability depends on the selected memory backend. */
export const MEMORY_BACKEND_TOOL_NAMES = ["retain", "recall", "reflect", "memory_edit", "learn"] as const;

/**
 * Prompt references for memory tools: `xd://<name>` when the tool is mounted
 * as an xd:// device (the only way to call it), else its bare name.
 */
export function memoryToolRefs(mountedDevices: readonly { name: string }[] = []): Record<string, string> {
	const mounted = new Set(mountedDevices.map(device => device.name));
	return Object.fromEntries(
		MEMORY_BACKEND_TOOL_NAMES.map(name => [name, mounted.has(name) ? `${XD_URL_PREFIX}${name}` : name]),
	);
}

/**
 * {@link memoryToolRefs} for a tool session. Reads mounted names only: xd://
 * device entries compute catalog summaries from tool descriptions, which would
 * recurse when called from a memory tool's own description getter.
 */
export function sessionMemoryToolRefs(session: {
	xdev?: { mountedNames: ReadonlySet<string> };
}): Record<string, string> {
	return memoryToolRefs([...(session.xdev?.mountedNames ?? [])].map(name => ({ name })));
}
