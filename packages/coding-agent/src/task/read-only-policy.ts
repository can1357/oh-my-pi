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

export function isReadOnlyAgent(agent: AgentDefinition): boolean {
	return !!agent.tools?.length && agent.tools.every(tool => READ_ONLY_TOOL_NAMES.has(tool));
}
