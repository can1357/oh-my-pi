import { expandExecToolAlias, isToolDisallowed } from "../tools/builtin-names";
import type { AgentDefinition } from "./types";

// Built-in tools whose approval tier is "read" (see tool classes' `approval`).
// An agent is read-only iff its declared tools are a non-empty subset of this set.
// Fail-safe: any unknown tool makes the agent not read-only.
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
	"read",
	"grep",
	"glob",
	"web_search",
	"ast_grep",
	"yield",
	"hub",
	"ask",
	"todo",
	"recall",
	"reflect",
	"retain",
	"memory_edit",
	"inspect_image",
	"checkpoint",
	"rewind",
]);

export function isReadOnlyAgent(
	agent: AgentDefinition,
	evalBackends?: {
		python: boolean;
		js: boolean;
		ruby: boolean;
		julia: boolean;
	},
): boolean {
	// Classify from the EFFECTIVE tool set: `disallowedTools:` can remove a
	// mutating tool (e.g. `tools: [read, write]` + `disallowedTools: [write]`),
	// leaving a read-only scope that the declared list alone would mark
	// writable — and the parent uses this to decide whether it may assign
	// edits to the child.
	// Name-only matching (no `mcpServerName` metadata): `AgentDefinition` carries
	// declared tool names, not registry tool objects, so a capped-name MCP server
	// needs an exact-name disallow here or relies on the sdk-level metadata-aware
	// filters. A MCP tool surviving this check is at worst classified non-read-only
	// (fail-safe) — it can never turn a mutating MCP tool "read-only".
	const patterns = agent.disallowedTools ?? [];
	// A deny-all disallow (`disallowedTools: ["*"]`) without a `tools` list
	// removes every non-hidden tool at runtime, leaving a protocol-only scope —
	// the effective set is empty BECAUSE everything was stripped, so the agent
	// is read-only (it cannot mutate anything). The inherited-tools case (no
	// disallows, no allowlist) stays non-read-only: unknown inherited tools
	// keep the fail-safe false.
	if (patterns.some(pattern => pattern === "*")) return true;
	// No explicit allowlist means full inheritance: the child may inherit
	// mutating tools, so it is never read-only (fail-safe).
	if (agent.tools === undefined) return false;
	// An explicit allowlist whose post-disallow effective set is empty is a
	// protocol-only scope: the child can call no tool at all, so it cannot
	// mutate anything and classifies read-only. A non-empty effective set is
	// read-only iff every surviving tool is read-only.
	// `exec` is expanded to its concrete backends BEFORE classification:
	// `tools: [exec]` + `disallowedTools: [eval, bash]` leaves no execution
	// tool, so classifying on the unexpanded alias would misreport the agent
	// as writable. Without backend info, assume eval is available (fail-safe
	// toward writable, matching the runtime default allowance).
	const declared = expandExecToolAlias(
		agent.tools,
		patterns,
		evalBackends ?? { python: true, js: true, ruby: false, julia: false },
	);
	const effective = declared.filter(tool => !isToolDisallowed(tool, patterns));
	return effective.every(tool => READ_ONLY_TOOL_NAMES.has(tool));
}
