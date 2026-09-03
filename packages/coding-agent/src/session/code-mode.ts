/**
 * Codex Code Mode: collapse the direct tool surface for code_mode_only models
 * to a small keep-set and expose every other session tool through the eval
 * bridge, mirroring codex-rs ToolMode::CodeModeOnly.
 */

import { logger } from "@oh-my-pi/pi-utils";

/**
 * Tool names that always stay directly model-visible under code mode. The
 * `__*__` names are the eval bridge's own internal operations (declared in
 * `eval/*-bridge.ts`, spelled out here to keep this module free of eval
 * imports): `callSessionTool` consumes them before the registry, so a
 * registered tool sharing one of those names is only reachable while it stays
 * on the direct surface.
 */
export const CODE_MODE_KEEP_TOOLS: Record<string, true> = {
	eval: true,
	ask: true,
	todo: true,
	yield: true,
	think: true,
	// checkpoint/rewind results drive session state machinery keyed on the
	// toolResult's toolName (see session/checkpoint-entries.ts); wrapped inside
	// an eval result they are invisible to it, so they must stay direct.
	checkpoint: true,
	rewind: true,
	__agent__: true,
	__budget__: true,
	__completion__: true,
	__concurrency__: true,
};

export interface CodeModeResolution {
	active: boolean;
	/** Names that remain directly model-visible. All enabled names when inactive. */
	directToolNames: Set<string>;
}

export function resolveCodeMode(args: {
	provider: string;
	toolMode?: string;
	setting: "off" | "on" | "auto";
	extraDirectTools?: readonly string[];
	enabledToolNames: readonly string[];
	evalTransportAvailable: boolean;
}): CodeModeResolution {
	const active =
		args.provider === "openai-codex" &&
		args.enabledToolNames.includes("eval") &&
		args.evalTransportAvailable &&
		(args.setting === "on" || (args.setting === "auto" && args.toolMode === "code_mode_only"));
	if (!active) return { active: false, directToolNames: new Set(args.enabledToolNames) };
	const direct = new Set<string>();
	for (const name of args.enabledToolNames) {
		if (CODE_MODE_KEEP_TOOLS[name] === true) direct.add(name);
	}
	for (const name of args.extraDirectTools ?? []) {
		if (args.enabledToolNames.includes(name)) direct.add(name);
	}
	return { active: true, directToolNames: direct };
}

/** codex-rs TurnToolFunctionInfo shape (snake_case on the wire). */
export interface ToolNamespaceFunctionInfo {
	name: string;
	direct: boolean;
	code_mode_name: string | null;
	deferred: boolean;
	source: { kind: "harness" } | { kind: "mcp"; server_name: string };
}

/** codex-rs TurnToolNamespacesInfo shape. */
export interface ToolNamespacesInfo {
	[namespace: string]: {
		name: string;
		functions: Record<string, ToolNamespaceFunctionInfo>;
	};
}

export function buildToolNamespacesInfo(args: {
	tools: ReadonlyArray<{ name: string; customWireName?: string; loadMode?: string; mcpServerName?: string }>;
	directToolNames: ReadonlySet<string>;
}): ToolNamespacesInfo {
	// Null prototype: a tool named `toString` or `__proto__` must land as an own
	// entry instead of reading or replacing an inherited member.
	const functions: Record<string, ToolNamespaceFunctionInfo> = Object.create(null);
	for (const tool of args.tools) {
		const direct = args.directToolNames.has(tool.name);
		const wireName = direct ? (tool.customWireName ?? tool.name) : tool.name;
		const existing = functions[wireName];
		// One wire name can only denote one callable. Direct exposure beats a
		// bridged entry; between two direct entries, the exact tool name beats an
		// alias, matching the agent-loop dispatcher's exact-name-first lookup.
		if (existing) {
			const existingExact = existing.code_mode_name === wireName;
			const candidateExact = tool.name === wireName;
			const replace = direct && (!existing.direct || (candidateExact && !existingExact));
			logger.warn("Code Mode wire name collision", {
				wireName,
				kept: replace ? tool.name : existing.code_mode_name,
				dropped: replace ? existing.code_mode_name : tool.name,
			});
			if (!replace) continue;
		}
		functions[wireName] = {
			name: wireName,
			direct,
			code_mode_name: tool.name,
			deferred: tool.loadMode === "discoverable",
			source: tool.mcpServerName ? { kind: "mcp", server_name: tool.mcpServerName } : { kind: "harness" },
		};
	}
	return { functions: { name: "functions", functions } };
}
