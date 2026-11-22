/**
 * Session quiescence shared by every consumer that has to know when a session is truly done:
 * the run is over (its `agent_end` was published) and nothing is live, admitted, queued or
 * scheduled that would start another.
 */
import type { AgentSession } from "./agent-session";

/** Session surface the settle predicate reads. */
export type SessionSettleState = Pick<
	AgentSession,
	"isRunActive" | "isStreaming" | "hasAdmittedSubmission" | "queuedMessageCount"
>;

/**
 * True when no run is open, live or admitted, no steer/follow-up is queued, and the owner has no
 * turn scheduled. `scheduledTurn` reports a turn the session's owner has decided to start but not
 * yet admitted (for example a scheduled goal continuation).
 */
export function isSessionSettled(session: SessionSettleState, scheduledTurn?: () => boolean): boolean {
	return (
		!session.isRunActive &&
		!session.isStreaming &&
		!session.hasAdmittedSubmission &&
		session.queuedMessageCount === 0 &&
		scheduledTurn?.() !== true
	);
}
