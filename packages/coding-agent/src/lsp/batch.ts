import type { ToolCallContext } from "@oh-my-pi/pi-agent-core";

const LSP_BATCH_TOOLS = new Set(["edit", "write"]);

/** Identifies a shared edit/write batch and whether its diagnostics should flush. */
export interface LspBatchRequest {
	id: string;
	flush: boolean;
}

/** Resolve batching for edit/write calls sharing one model response. */
export function getLspBatchRequest(toolCall: ToolCallContext | undefined): LspBatchRequest | undefined {
	if (!toolCall) {
		return undefined;
	}
	const hasOtherWrites = toolCall.toolCalls.some(
		(call, index) => index !== toolCall.index && LSP_BATCH_TOOLS.has(call.name),
	);
	if (!hasOtherWrites) {
		return undefined;
	}
	const hasLaterWrites = toolCall.toolCalls.slice(toolCall.index + 1).some(call => LSP_BATCH_TOOLS.has(call.name));
	return { id: toolCall.batchId, flush: !hasLaterWrites };
}
