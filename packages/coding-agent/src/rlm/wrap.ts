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

export type RlmSpillOptions = {
	/** Runtime gate so `/rlm on` can arm spill without rebuilding every tool. Default: always on. */
	enabled?: () => boolean;
	/** Resolve spill threshold at execute time. Default: fixed `spillBytes` arg. */
	spillBytes?: () => number;
};

/** Spill oversized text results. Fail-open: original result if spill throws. */
export function wrapToolWithRlmSpill<T extends AgentTool<any, any, any>>(
	tool: T,
	store: RlmStore,
	spillBytes: number,
	options?: RlmSpillOptions,
): T {
	if (tool.name === RLM_TOOL_NAME) return tool;
	const original = tool.execute.bind(tool);
	const isEnabled = options?.enabled ?? (() => true);
	const resolveSpillBytes = options?.spillBytes ?? (() => spillBytes);
	tool.execute = (async (
		toolCallId: string,
		params: unknown,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<unknown>,
		context?: AgentToolContext,
	): Promise<AgentToolResult<unknown>> => {
		const result = await original(toolCallId, params, signal, onUpdate, context);
		if (!isEnabled()) return result;
		try {
			return {
				...result,
				content: spillContent(store, result.content, resolveSpillBytes(), tool.name),
			};
		} catch {
			return result;
		}
	}) as T["execute"];
	return tool;
}
