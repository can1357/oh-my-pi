import type { SessionManager } from "../../session/session-manager";

/** Where a conversation stood when input was submitted: its session and the branch leaf. */
export interface ConversationPosition {
	sessionId: string;
	leafId: string | null;
}

export function conversationPosition(
	sessionManager: Pick<SessionManager, "getSessionId" | "getLeafId">,
): ConversationPosition {
	return { sessionId: sessionManager.getSessionId(), leafId: sessionManager.getLeafId() };
}

/**
 * Whether the session still holds the conversation at `position`, continued from that point. A session
 * switch or tree navigation, both of which may reuse the same `AgentSession`, fails it.
 */
export function continuesConversation(
	sessionManager: Pick<SessionManager, "getSessionId" | "getBranch">,
	position: ConversationPosition,
): boolean {
	if (sessionManager.getSessionId() !== position.sessionId) return false;
	const { leafId } = position;
	return leafId === null || sessionManager.getBranch().some(entry => entry.id === leafId);
}
