import { $env, $flag } from "@oh-my-pi/pi-utils";
import type { Model } from "../types";

/** Read the optional process-wide Codex WebSocket override. */
export function getOpenAICodexWebSocketEnvValue(): boolean | undefined {
	return $env.PI_CODEX_WEBSOCKET === undefined ? undefined : $flag("PI_CODEX_WEBSOCKET");
}

/** Resolve the public WebSocket preference using env, caller, then model precedence. */
export function isOpenAICodexWebSocketPreferred(
	model: Model<"openai-codex-responses">,
	options?: { preferWebsockets?: boolean },
): boolean {
	const envValue = getOpenAICodexWebSocketEnvValue();
	if (envValue !== undefined) return envValue;
	if (options?.preferWebsockets === false) return false;
	return options?.preferWebsockets === true || model.preferWebsockets === true;
}
