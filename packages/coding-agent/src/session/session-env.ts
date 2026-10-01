/**
 * Session identity in the environment.
 *
 * Two surfaces, deliberately separate:
 *
 * - The process-wide `OMP_SESSION_ID` (`publishProcessSessionId`), set at startup by
 *   the session that owns it, so every descendant process of the agent process —
 *   shells, hooks, MCP servers, workers — inherits a session id without any
 *   per-spawn plumbing. A child `omp` process runs its own startup, so it repoints
 *   the value it inherited with its own id.
 * - A per-session overlay (`sessionIdEnv`), merged into the env of every process a
 *   session spawns. Sessions sharing a process (subagents, extra ACP sessions) share
 *   `process.env`, so this overlay — never a mutation of it — is what gives each
 *   session's children its OWN id instead of the inherited one.
 */
import process from "node:process";

/** Name of the environment variable carrying the active session id. */
export const SESSION_ID_ENV = "OMP_SESSION_ID";

/** Publish `sessionId` as the process-wide {@link SESSION_ID_ENV}. */
export function publishProcessSessionId(sessionId: string): void {
	process.env[SESSION_ID_ENV] = sessionId;
}

/**
 * Env overlay carrying `sessionId` for a process spawned by that session. Returns
 * `undefined` when there is no id to pass (ephemeral caller), so callers hand it
 * straight through as an optional overlay.
 */
export function sessionIdEnv(sessionId: string | null | undefined): Record<string, string> | undefined {
	return sessionId ? { [SESSION_ID_ENV]: sessionId } : undefined;
}
