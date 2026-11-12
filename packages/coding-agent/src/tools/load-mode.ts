import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import { BUILTIN_TOOL_NAMES, HIDDEN_TOOL_NAMES, isMCPToolName } from "./builtin-names";

export type ToolLoadModes = Readonly<Record<string, "essential">>;

const KNOWN_BUILTINS: ReadonlySet<string> = new Set([...BUILTIN_TOOL_NAMES, ...HIDDEN_TOOL_NAMES]);
// Startup and live reconciliation share the same canonical registry.
const warnedModes = new WeakMap<ReadonlyMap<string, AgentTool>, Map<string, "essential">>();

/** Overrides affect presentation only and never grant tools. */
export function hasEssentialOverride(tool: AgentTool, modes: ToolLoadModes): boolean {
	return Object.hasOwn(modes, tool.name) && modes[tool.name] === "essential";
}

/** Warn once per ignored name/value; changing or removing the entry re-arms it. */
export function warnToolLoadModes(
	tools: ReadonlyMap<string, AgentTool>,
	modes: ToolLoadModes,
	onWarning?: (message: string) => void,
	mcpDiscoveryPending = false,
	extensionDiscoveryPending = false,
): void {
	let warned = warnedModes.get(tools);
	if (warned) {
		for (const [name, mode] of warned) {
			if (modes[name] !== mode) warned.delete(name);
		}
	}
	for (const [name, mode] of Object.entries(modes)) {
		if (
			tools.has(name) ||
			KNOWN_BUILTINS.has(name) ||
			extensionDiscoveryPending ||
			(mcpDiscoveryPending && isMCPToolName(name)) ||
			warned?.get(name) === mode
		)
			continue;
		if (!warned) {
			warned = new Map();
			warnedModes.set(tools, warned);
		}
		warned.set(name, mode);
		const message = `tools.loadMode.${name} ignored: tool is not registered.`;
		logger.warn(message);
		onWarning?.(message);
	}
}
