import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";

export function toolResultHasError(result: AgentToolResult): boolean {
	return result.isError === true || (isRecord(result.details) && result.details.isError === true);
}

export function isBridgeImage(content: AgentToolResult["content"][number]): content is ImageContent {
	return content.type === "image" && typeof content.mimeType === "string" && typeof content.data === "string";
}

/** Bare bridge strings are returned to the cell, not printed by prelude facades. */
export function isBareBridgeResult(result: AgentToolResult): boolean {
	return result.details === undefined && !toolResultHasError(result) && !result.content.some(isBridgeImage);
}
