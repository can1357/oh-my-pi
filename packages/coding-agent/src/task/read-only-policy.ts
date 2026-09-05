import type { EvalBackendsAllowance } from "../tools/eval-backends";
import { expandExecToolAlias, isToolDisallowed } from "../tools/builtin-names";
import type { AgentDefinition } from "./types";

// Built-in tools whose approval tier is "read" (see tool classes' `approval`).
// An agent is read-only iff its declared tools are a non-empty subset of this set.
// Fail-safe: any unknown tool makes the agent not read-only.
//
// `hub` is deliberately absent: it declares `approval = hubApproval`, a
// parameter-dependent function that returns "exec" for start/stop/restart,
// process-stdin `send`, unrecognized ops and malformed params. Do not re-add it.
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
	"read",
	"grep",
	"glob",
	"web_search",
	"ast_grep",
	"yield",
	"ask",
	"todo",
	"recall",
	"reflect",
	"retain",
	"memory_edit",
	"checkpoint",
	"rewind",
]);

export function isReadOnlyAgent(agent: AgentDefinition, evalBackends?: EvalBackendsAllowance): boolean {
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
	// Mirror the executor spawn path's auto-adds BEFORE classification, so the
	// grant the runtime actually creates is the set being classified:
	// - `spawns:` auto-adds `task` ONLY when the runtime would: a declared
	//   `disallowedTools` naming `task` suppresses the auto-add, and the
	//   executor drops `task` entirely at max recursion depth (the classifier
	//   has no depth input, so a parent spawning a spawns-scoped child at max
	//   depth reads one notch conservative — fail-safe toward writable).
	//   Delegation to a writable child breaks the read-only contract even when
	//   the agent's own allowlist is read-only.
	// - non-restricted spawn paths auto-add `hub` (`exec`-tier approval), so an
	//   effective set that is otherwise read-only still cannot be flagged
	//   read-only unless `READ_ONLY_TOOL_NAMES` already covers it.
	const effective = expandExecToolAlias(agent.tools, patterns, evalBackends ?? { python: true, js: true }).filter(
		tool => !isToolDisallowed(tool, patterns),
	);
	const taskAutoAdded =
		agent.spawns !== undefined && !effective.includes("task") && !isToolDisallowed("task", patterns);
	const withAutoAdds = taskAutoAdded ? [...effective, "task"] : effective;
	return withAutoAdds.every(tool => READ_ONLY_TOOL_NAMES.has(tool));
}
