/**
 * Session/agent identity exported into child processes the harness spawns.
 *
 * Everything else the harness hands a child (`PI_SESSION_FILE`,
 * `PI_TOOL_BRIDGE_*`, …) describes a transport. These two variables answer a
 * different question: *which agent turn am I running inside?* External CLIs use
 * them to correlate their own side effects (query logs, QA reports, caches)
 * with the session and subagent that invoked them, which is otherwise
 * unknowable from a child process.
 *
 * Exported by the bash tool (every bash child) and by the managed Python kernel
 * env (so `subprocess` children of an eval cell inherit it too).
 */

/** Session id of the turn that spawned the child. */
export const OMP_SESSION_ID_ENV = "OMP_SESSION_ID";
/**
 * Agent/task id of the spawning agent (registry id, e.g. `Main`, `Harness`).
 * Falls back to the session id so a child always has a usable correlation key.
 */
export const OMP_AGENT_ID_ENV = "OMP_AGENT_ID";

/**
 * Identity accessors a tool session may expose. Structural so advisor-local and
 * test sessions — which implement only part of `ToolSession` — still work.
 */
export interface AgentIdentitySource {
	sessionManager?: { getSessionId?: () => string | null };
	getSessionId?: () => string | null;
	getAgentId?: () => string | null;
}

export interface AgentIdentity {
	sessionId?: string;
	agentId?: string;
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | undefined {
	for (const value of values) {
		const trimmed = value?.trim();
		if (trimmed) return trimmed;
	}
	return undefined;
}

/**
 * Resolve the spawning session/agent identity. Prefers the owning journal's
 * registered id over the tool-state id (advisors carry a local id that is not
 * the session the user sees).
 */
export function resolveAgentIdentity(session: AgentIdentitySource | undefined): AgentIdentity {
	if (!session) return {};
	const sessionId = firstNonEmpty(session.sessionManager?.getSessionId?.(), session.getSessionId?.());
	return { sessionId, agentId: firstNonEmpty(session.getAgentId?.()) ?? sessionId };
}

/**
 * Env overlay carrying {@link resolveAgentIdentity} for a child process. Empty
 * when the session has no identity at all (detached tools, unit tests), so
 * callers can keep an "no env overlay" fast path.
 */
export function agentIdentityEnv(session: AgentIdentitySource | undefined): Record<string, string> {
	const { sessionId, agentId } = resolveAgentIdentity(session);
	const env: Record<string, string> = {};
	if (sessionId) env[OMP_SESSION_ID_ENV] = sessionId;
	if (agentId) env[OMP_AGENT_ID_ENV] = agentId;
	return env;
}
