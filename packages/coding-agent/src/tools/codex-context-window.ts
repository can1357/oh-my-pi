import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import resetResult from "../prompts/system/new-context-result.md" with { type: "text" };
import remainingDescription from "../prompts/tools/get-context-remaining.md" with { type: "text" };
import resetDescription from "../prompts/tools/new-context.md" with { type: "text" };
import { createPrivateToolRenderer } from "./codex-history-notes";

/** Built-in cards for the window-control tools, keyed by tool name. */
export const codexContextWindowToolRenderers = {
	new_context: createPrivateToolRenderer("New context window", undefined),
	get_context_remaining: createPrivateToolRenderer("Context remaining", undefined),
};

export function createNewContextTool(reset: () => Promise<void>): AgentTool {
	return {
		name: "new_context",
		label: "New context window",
		description: resetDescription,
		parameters: { type: "object", properties: {}, additionalProperties: false },
		hidden: true,
		modelOnly: true,
		strict: false,
		intent: "omit",
		concurrency: "exclusive",
		approval: "read",
		execute: async () => {
			await reset();
			return { content: [{ type: "text", text: resetResult }] };
		},
	};
}

export function createGetContextRemainingTool(remaining: () => string): AgentTool {
	return {
		name: "get_context_remaining",
		label: "Context remaining",
		description: remainingDescription,
		parameters: { type: "object", properties: {}, additionalProperties: false },
		hidden: true,
		modelOnly: true,
		strict: false,
		intent: "omit",
		concurrency: "shared",
		approval: "read",
		execute: async () => ({ content: [{ type: "text", text: remaining() }] }),
	};
}
