import type { ToolSession } from "./index";

/** Snapshot the calling session before awaiting work. Empty values replace inherited parent-session values. */
export function sessionIdentityEnv(session: ToolSession, toolCallId: string) {
	return {
		PI_SESSION_ID: session.sessionManager?.getSessionId?.() ?? session.getSessionId?.() ?? "",
		PI_SESSION_FILE: session.getSessionFile() ?? "",
		PI_TOOL_CALL_ID: toolCallId,
	};
}
