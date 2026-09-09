/** Default `x-cursor-client-version` for Cursor unary and Run requests. */
export const CURSOR_CLIENT_VERSION = "cli-2026.08.11-e8db854";

/**
 * Headers for the unary `GetUsableModels` / `GetServerConfig` RPCs.
 * No pseudo-headers and no Connect streaming fields — the unary path does
 * not send them and the server does not require them.
 */
export function buildCursorUnaryHeaders(apiKey: string, clientVersion?: string): Record<string, string> {
	return {
		"content-type": "application/proto",
		te: "trailers",
		authorization: `Bearer ${apiKey}`,
		"x-ghost-mode": "true",
		"x-cursor-client-version": clientVersion ?? CURSOR_CLIENT_VERSION,
		"x-cursor-client-type": "cli",
	};
}
