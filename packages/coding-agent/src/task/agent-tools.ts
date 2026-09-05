/**
 * Shared conversions for applying an agent definition's frontmatter to the
 * MAIN session (as opposed to a subagent spawn). `parseAgentFields` appends
 * `yield` to every explicit tool list because subagents need it to submit
 * results; the main session has no parent executor to consume a yield, so the
 * subagent-only tools are stripped before the persona's toolset is applied.
 */
export function spawnsDisabled(spawns: string[] | "*" | undefined): boolean {
	return spawns !== undefined && spawns !== "*" && spawns.length === 0;
}

export function mainSessionTools(tools: string[], spawns?: string[] | "*"): string[] {
	const filtered = tools.filter(name => name !== "yield" && name !== "goal");
	// A persona that declares `spawns` must be able to invoke them: auto-include
	// the task tool exactly like the subagent executor does, so e.g. the bundled
	// reviewer persona (`tools: [read, write]`, `spawns: [scout]`) can actually
	// spawn its configured scout from the main session.
	if (spawnsDisabled(spawns)) {
		// An explicit empty list is the DISABLED policy (`spawnsToString` maps
		// it to `""`, which `resolveSpawnPolicy` treats as spawning disabled) —
		// advertising a `task` tool whose every invocation fails preflight
		// would be a lie. Omitted or `"*"` keeps the auto-include.
		return filtered;
	}
	if (spawns !== undefined && !filtered.includes("task")) {
		filtered.push("task");
	}
	return filtered;
}

/**
 * Serialize an agent's `spawns` frontmatter to the session's spawn string.
 * An explicit empty list is the disabled policy (`""` — `resolveSpawnPolicy`
 * treats it as spawning disabled), distinct from an omitted field, which
 * keeps the session's default (`"*"`).
 */
export function spawnsToString(spawns: string[] | "*" | undefined): string {
	if (spawns === "*") return "*";
	if (spawns === undefined) return "*";
	return spawns.length === 0 ? "" : spawns.join(",");
}
