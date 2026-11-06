import type { AgentTool, ToolLoadMode } from "@oh-my-pi/pi-agent-core";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { applyToolProxy } from "../extensibility/tool-proxy";
import discoverableTemplate from "../prompts/tools/discoverable.md" with { type: "text" };
import { BUILTIN_TOOL_NAMES, HIDDEN_TOOL_NAMES, isMCPToolName } from "./builtin-names";
import { defaultLoadModeForToolName } from "./essential-tools";
import { promptCatalogSummary, XDEV_KEEP_TOP_LEVEL, XDEV_TRANSPORT_TOOLS } from "./xdev";

export type ToolLoadModes = Readonly<Record<string, ToolLoadMode>>;

const KNOWN_BUILTINS: ReadonlySet<string> = new Set([...BUILTIN_TOOL_NAMES, ...HIDDEN_TOOL_NAMES]);
const SHORT_PARAMETERS = { type: "object", additionalProperties: true } as const;
const shortTools = new WeakMap<AgentTool, AgentTool>();
// Startup and live reconciliation share the same canonical registry.
const warnedModes = new WeakMap<ReadonlyMap<string, AgentTool>, Map<string, ToolLoadMode>>();

function isPinned(tool: AgentTool): boolean {
	return (
		tool.name in XDEV_KEEP_TOP_LEVEL ||
		tool.name in XDEV_TRANSPORT_TOOLS ||
		HIDDEN_TOOL_NAMES.some(name => name === tool.name) ||
		tool.customFormat !== undefined ||
		tool.native !== undefined
	);
}

/** Bootstrap/control tools retain their full definitions; overrides never grant tools. */
export function toolLoadMode(tool: AgentTool, modes: ToolLoadModes, readAvailable = true): ToolLoadMode | undefined {
	const mode = Object.hasOwn(modes, tool.name) ? modes[tool.name] : undefined;
	if (mode === defaultLoadModeForToolName(tool.name, tool.loadMode)) return undefined;
	if (mode === "discoverable" && (isPinned(tool) || !readAvailable)) return undefined;
	return mode;
}

/** Changes only model-facing presentation; execution still uses the original schema and methods. */
export function presentTool<T extends AgentTool>(tool: T, mode: ToolLoadMode | undefined): T {
	if (mode !== "discoverable") return tool;
	const cached = shortTools.get(tool);
	if (cached) return cached as T;
	const wrapper = {
		description: prompt.render(discoverableTemplate, { name: tool.name, summary: promptCatalogSummary(tool) }).trim(),
		wireParameters: SHORT_PARAMETERS,
		strict: false,
		examples: undefined,
	} as unknown as T;
	applyToolProxy(tool, wrapper);
	shortTools.set(tool, wrapper);
	return wrapper;
}

/** Warn once per ignored name/value; changing or removing the entry re-arms it. */
export function warnToolLoadModes(
	tools: ReadonlyMap<string, AgentTool>,
	modes: ToolLoadModes,
	readAvailable: boolean,
	onWarning?: (message: string) => void,
	mcpDiscoveryPending = false,
): void {
	let warned = warnedModes.get(tools);
	if (warned) {
		for (const [name, mode] of warned) {
			if (modes[name] !== mode) warned.delete(name);
		}
	}
	for (const [name, mode] of Object.entries(modes)) {
		const tool = tools.get(name);
		if (tool && mode === defaultLoadModeForToolName(tool.name, tool.loadMode)) continue;
		let reason: string | undefined;
		if (!tool && !KNOWN_BUILTINS.has(name)) {
			if (mcpDiscoveryPending && isMCPToolName(name)) continue;
			reason = "tool is not registered";
		} else if (mode === "discoverable" && tool && isPinned(tool)) {
			reason = "tool is pinned to its full definition";
		} else if (mode === "discoverable" && tool && !readAvailable) {
			reason = "read must be enabled to discover full documentation";
		}
		if (!reason || warned?.get(name) === mode) continue;
		if (!warned) {
			warned = new Map();
			warnedModes.set(tools, warned);
		}
		warned.set(name, mode);
		const message = `tools.loadMode.${name} ignored: ${reason}.`;
		logger.warn(message);
		onWarning?.(message);
	}
}
