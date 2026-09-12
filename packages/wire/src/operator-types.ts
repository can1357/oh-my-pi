/**
 * Operator-facing queue contracts shared between the coding-agent RPC layer
 * and cockpit consumers. Kept in `wire` so the RPC schema stays dependency-free.
 */

export interface OperatorQueuedMessage {
	id: string;
	kind: "steer" | "follow-up";
	text: string;
	imageCount: number;
	/** Some user-attributed command cards can be removed but not rewritten as plain text. */
	editable: boolean;
}

export interface OperatorMessageQueue {
	sessionId: string;
	revision: string;
	items: OperatorQueuedMessage[];
	/** Advisor/internal/next-turn work is not exposed as editable user messages. */
	otherPendingCount: number;
}

export type OperatorQueuedMessageAction = { action: "edit"; text: string } | { action: "delete" } | { action: "send-now" };
