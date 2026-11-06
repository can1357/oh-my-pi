import type { AgentSession } from "../session/agent-session";

/**
 * WebSocket upgrade headers from `collab_relay_connect` extension handlers, for
 * `CollabSocketOptions.connectHeaders`. Waits for startup-deferred
 * extensions first: `omp join <link>` connects before they bind. Returns
 * `undefined` (connect at once) when no extension can add headers.
 */
export function collabRelayHeaders(
	session: AgentSession,
	url: string,
	role: "host" | "guest",
): Promise<Record<string, string> | undefined> | undefined {
	if (!session.hasPendingDeferredExtensions && !session.extensionRunner?.hasHandlers("collab_relay_connect")) {
		return undefined;
	}
	return (async () => {
		await session.loadDeferredExtensions();
		return await session.extensionRunner?.emitCollabRelayConnect({ url, role });
	})();
}
