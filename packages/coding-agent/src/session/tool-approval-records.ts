import type { ApprovalMode } from "../tools/approval";
import type { SessionManager } from "./session-manager";

export const TOOL_APPROVAL_REQUESTED_CUSTOM_TYPE = "tool_approval_requested";
export const TOOL_APPROVAL_RESOLVED_CUSTOM_TYPE = "tool_approval_resolved";

/** Persisted when a tool call starts waiting on the user's approval. */
export interface ToolApprovalRequestedData {
	toolCallId: string;
	toolName: string;
	approvalMode: ApprovalMode;
	reason?: string;
	requestedAt: string;
}

/** Persisted when that wait ends: approved, denied, aborted, or refused for lack of a UI. */
export interface ToolApprovalResolvedData {
	toolCallId: string;
	toolName: string;
	approved: boolean;
	reason?: string;
	resolvedAt: string;
}

type ApprovalRecordSink = Pick<SessionManager, "appendCustomEntry">;

/**
 * Approval prompts otherwise reach only extension hooks and the terminal, so a process reading the
 * session file (a multiplexer sidebar, a dashboard) cannot tell a session blocked on the user from
 * one still working. The pair brackets the wait; a request without a resolution is still pending.
 */
export function recordToolApprovalRequested(
	sink: ApprovalRecordSink,
	data: Omit<ToolApprovalRequestedData, "requestedAt">,
): void {
	sink.appendCustomEntry(TOOL_APPROVAL_REQUESTED_CUSTOM_TYPE, {
		...data,
		requestedAt: new Date().toISOString(),
	} satisfies ToolApprovalRequestedData);
}

export function recordToolApprovalResolved(
	sink: ApprovalRecordSink,
	data: Omit<ToolApprovalResolvedData, "resolvedAt">,
): void {
	sink.appendCustomEntry(TOOL_APPROVAL_RESOLVED_CUSTOM_TYPE, {
		...data,
		resolvedAt: new Date().toISOString(),
	} satisfies ToolApprovalResolvedData);
}
