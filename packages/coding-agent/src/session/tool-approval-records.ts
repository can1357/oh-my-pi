import { logger } from "@oh-my-pi/pi-utils";
import type { ApprovalMode } from "../tools/approval";
import type { SessionManager } from "./session-manager";

const TOOL_APPROVAL_REQUESTED_CUSTOM_TYPE = "tool_approval_requested";
const TOOL_APPROVAL_RESOLVED_CUSTOM_TYPE = "tool_approval_resolved";

/** Persisted when a tool call starts waiting on the user's approval. */
export interface ToolApprovalRequestedData {
	toolCallId: string;
	/** Eval or kernel-defined tool invocation that dispatched this call; absent for direct calls. */
	parentToolCallId?: string;
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

export type ApprovalRecordSink = Pick<SessionManager, "appendCustomEntry" | "ensureOnDisk" | "flush">;

/**
 * Approval prompts otherwise reach only extension hooks and the terminal, so a process reading the
 * session file (a multiplexer sidebar, a dashboard) cannot tell a session blocked on the user from
 * one still working. A request is pending until a resolution follows, or a tool result for its call or,
 * for a call dispatched from an eval, for its `parentToolCallId`: fork and resume repair close an
 * interrupted assistant call with a tool result, never with a resolution, and never close the nested
 * calls an eval made.
 *
 * The request is on disk before the prompt opens, even in a session that has no assistant message
 * yet and so no file (a first-turn Cursor exec frame, a direct tool call).
 */
export async function recordToolApprovalRequested(
	sink: ApprovalRecordSink,
	data: Omit<ToolApprovalRequestedData, "requestedAt">,
): Promise<void> {
	await persist(sink, async () => {
		await sink.ensureOnDisk();
		sink.appendCustomEntry(TOOL_APPROVAL_REQUESTED_CUSTOM_TYPE, {
			...data,
			requestedAt: new Date().toISOString(),
		} satisfies ToolApprovalRequestedData);
	});
}

export async function recordToolApprovalResolved(
	sink: ApprovalRecordSink,
	data: Omit<ToolApprovalResolvedData, "resolvedAt">,
): Promise<void> {
	await persist(sink, async () => {
		sink.appendCustomEntry(TOOL_APPROVAL_RESOLVED_CUSTOM_TYPE, {
			...data,
			resolvedAt: new Date().toISOString(),
		} satisfies ToolApprovalResolvedData);
	});
}

/** The records serve observers; a failed disk write must not decide the approval itself. */
async function persist(sink: ApprovalRecordSink, append: () => Promise<void>): Promise<void> {
	try {
		await append();
		await sink.flush();
	} catch (error) {
		logger.warn("Failed to persist a tool approval record", { error: String(error) });
	}
}
