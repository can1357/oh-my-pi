import type { AssistantMessage } from "@oh-my-pi/pi-ai";

/**
 * One-line transcript label for the Anthropic advisor-tool block at `index`,
 * or undefined when the block renders nothing: other server tools, and an
 * advisor call whose result follows in the same message (the result line
 * stands for both). A call answered in a later request keeps its
 * "Consulting advisor…" line; the result shows on the next turn.
 */
export function advisorToolLabel(content: AssistantMessage["content"], index: number): string | undefined {
	const block = content[index];
	if (block?.type !== "anthropicServerTool") return undefined;
	const wire = block.block;
	if (wire.type === "server_tool_use") {
		if (wire.name !== "advisor") return undefined;
		const answered = content.some(
			other =>
				other.type === "anthropicServerTool" &&
				other.block.type === "advisor_tool_result" &&
				other.block.tool_use_id === wire.id,
		);
		return answered ? undefined : "Consulting advisor…";
	}
	if (wire.type !== "advisor_tool_result") return undefined;
	const result: Record<string, unknown> | undefined =
		typeof wire.content === "object" && wire.content !== null ? (wire.content as Record<string, unknown>) : undefined;
	if (result?.type === "advisor_tool_result_error") {
		return `Advisor unavailable (${typeof result.error_code === "string" ? result.error_code : "unknown"})`;
	}
	if (result?.type === "advisor_result" && typeof result.text === "string" && result.text.trim()) {
		return `Advisor: ${result.text.trim()}`;
	}
	// `advisor_redacted_result`: the advice is encrypted for the executor only.
	return "Advisor reviewed";
}
