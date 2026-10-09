/**
 * Cursor wire constants shared by authenticated catalog discovery, the pi-ai
 * provider, and account usage. Keep the announced client build aligned with the
 * released Cursor agent CLI because the service gates protocol features on it.
 */

import { $env } from "@oh-my-pi/pi-utils/env";

/** Default host for Cursor's Connect RPCs and account API. */
export const CURSOR_DEFAULT_BASE_URL = "https://api2.cursor.sh";

/** Released Cursor agent CLI build whose protocol surface this client mirrors. */
export const CURSOR_CLIENT_VERSION = "cli-2026.09.02-c22c1a3";

/** Shared override so inference and discovery announce the same client version. */
export function resolveCursorClientVersion(): string {
	return $env.CURSOR_CLIENT_VERSION?.trim() || CURSOR_CLIENT_VERSION;
}

export const CURSOR_RUN_PATH = "/agent.v1.AgentService/Run";
export const CURSOR_RUN_SSE_PATH = "/agent.v1.AgentService/RunSSE";
export const CURSOR_BIDI_APPEND_PATH = "/aiserver.v1.BidiService/BidiAppend";
export const CURSOR_GET_USABLE_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";
export const CURSOR_GET_DEFAULT_MODEL_PATH = "/agent.v1.AgentService/GetDefaultModelForCli";
export const CURSOR_AVAILABLE_MODELS_PATH = "/aiserver.v1.AiService/AvailableModels";

/** Headers shared by Cursor's authenticated CLI RPCs. */
export function cursorClientHeaders(
	apiKey: string,
	options: { clientVersion?: string; contentType?: "application/proto" | "application/connect+proto" } = {},
): Record<string, string> {
	return {
		"content-type": options.contentType ?? "application/proto",
		authorization: `Bearer ${apiKey}`,
		"x-cursor-client-type": "cli",
		"x-cursor-client-version": options.clientVersion ?? resolveCursorClientVersion(),
		"x-ghost-mode": "true",
	};
}
