import type { ToolSession } from ".";

/**
 * The id of the session `session` works for: its journal's registered id, else
 * its tool-state id (an advisor's tool state has an id of its own). Commands'
 * `PI_SESSION_ID`, internal URL contexts and the ovnfs checkouts of isolated
 * subagents name the session by it.
 *
 * Kept out of the `tools` barrel: low-level modules (internal URL contexts) need
 * it, and a value import of the barrel loads every tool, closing import cycles.
 */
export function owningSessionId(session: ToolSession): string | undefined {
	return session.sessionManager?.getSessionId?.() ?? session.getSessionId?.() ?? undefined;
}
