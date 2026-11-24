import type { ToolSession } from ".";

/**
 * Session identity for a process the agent starts: `bash` commands and the
 * Git hooks of a selective `commit`. Read when the tool call starts, so
 * `/fork`, `/new`, and `/resume` take effect on the next call while a call
 * already under way keeps the session it began in. `PI_TOOL_CALL_ID` is the
 * id the call runs under: the agent's call in the transcript, or the eval
 * tool bridge's own id for a call made from an eval cell. Every key is always
 * set: an empty value replaces a stale one inherited from a parent omp
 * process, since an env overlay cannot unset.
 */
export function sessionIdentityEnv(session: ToolSession, toolCallId: string): Record<string, string> {
	return {
		PI_SESSION_ID: session.sessionManager?.getSessionId?.() ?? session.getSessionId?.() ?? "",
		PI_SESSION_FILE: session.getSessionFile() ?? "",
		PI_TOOL_CALL_ID: toolCallId,
	};
}
