import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { maybeSpill, type RlmStore } from "./store";

const RLM_TOOL_NAME = "rlm";

function spillContent(
	store: RlmStore,
	content: Array<TextContent | ImageContent>,
	spillBytes: number,
	source: string,
): Array<TextContent | ImageContent> {
	return content.map(part => {
		if (part.type !== "text") return part;
		try {
			const next = maybeSpill(store, part.text, spillBytes, source);
			return next === part.text ? part : { ...part, text: next };
		} catch {
			return part;
		}
	});
}

/** Spill oversized text results. Fail-open: original result if spill throws. */
export function wrapToolWithRlmSpill<T extends AgentTool<any, any, any>>(
	tool: T,
	store: RlmStore,
	spillBytes: number,
): T {
	if (tool.name === RLM_TOOL_NAME) return tool;
	const original = tool.execute.bind(tool);
	tool.execute = (async (
		toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<unknown>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<unknown>> => {
		const result = await original(toolCallId, params, signal, onUpdate, context);
		try {
			return {
				...result,
				content: spillContent(store, result.content, spillBytes, tool.name),
			};
		} catch {
			return result;
		}
	}) as T["execute"];
	return tool;
}
