/**
 * Session quiescence shared by every consumer that has to know when a session is truly done:
 * not just yielded, but with nothing live, admitted, queued, scheduled or running in the
 * background that could inject a message and wake it again.
 */
import type { AgentSession } from "./agent-session";

/** Session surface the settle predicate reads. */
export type SessionSettleState = Pick<
	AgentSession,
	"isStreaming" | "hasAdmittedSubmission" | "queuedMessageCount" | "hasPendingAsyncWork"
>;

/** {@link SessionSettleState} plus the owner-scoped background drain. */
export type SessionSettleHost = SessionSettleState & Pick<AgentSession, "settleAsyncWork">;

/**
 * True when no run is live, admitted or scheduled, no steer/follow-up is queued, and no
 * background job or delivery can re-wake the session. `scheduledTurn` reports a turn the host
 * has decided to start but not yet admitted (for example a scheduled goal continuation).
 */
export function isSessionSettled(session: SessionSettleState, scheduledTurn?: () => boolean): boolean {
	return (
		!session.isStreaming &&
		!session.hasAdmittedSubmission &&
		session.queuedMessageCount === 0 &&
		!session.hasPendingAsyncWork() &&
		scheduledTurn?.() !== true
	);
}

/**
 * Wait out owner-scoped background work that can still wake the session, then report whether
 * the session is settled. Only drains while no live or admitted run owns the session (that run's
 * own terminal `agent_end` is the next check). `isCurrent` is rechecked after every await: once
 * it turns false the caller has been superseded and the answer is false. True means the activity
 * is still current and {@link isSessionSettled} holds right now.
 */
export async function waitForSessionSettlement(
	session: SessionSettleHost,
	options: { isCurrent: () => boolean; scheduledTurn?: () => boolean },
): Promise<boolean> {
	const { isCurrent, scheduledTurn } = options;
	while (isCurrent() && !session.isStreaming && !session.hasAdmittedSubmission && session.hasPendingAsyncWork()) {
		await session.settleAsyncWork();
	}
	return isCurrent() && isSessionSettled(session, scheduledTurn);
}
