import type { RepeatedToolCallDetection } from "@oh-my-pi/pi-ai/utils/tool-call-loop-guard";
import { prompt } from "@oh-my-pi/pi-utils";
import cyclicToolCallLoopRedirectTemplate from "../prompts/system/cyclic-tool-call-loop-redirect.md" with { type: "text" };
import toolCallLoopRedirectTemplate from "../prompts/system/tool-call-loop-redirect.md" with { type: "text" };
import unresolvedToolCallLoopRedirectTemplate from "../prompts/system/unresolved-tool-call-loop-redirect.md" with { type: "text" };

export const TOOL_CALL_LOOP_REDIRECT_TYPE = "tool-call-loop-redirect";

/** Structured record of the loop a redirect was issued for. */
export interface ToolCallLoopRedirectDetails {
	kind: RepeatedToolCallDetection["kind"];
	toolName: string;
	count: number;
	cycleLength?: number;
	cycleSummary?: string;
	argumentsSummary: string;
	resultSummary: string;
}

/**
 * Renders the corrective a repeated tool call earns. Shared by the primary
 * session's `LoopGuards` and the advisor's own loop guard: both bounds speak
 * with one wording, while each wraps it in the message shape its own agent
 * converts to LLM context (the primary maps custom messages, the advisor runs
 * the default converter that keeps only LLM-native roles).
 */
export function renderToolCallLoopRedirect(detection: RepeatedToolCallDetection): string {
	if (detection.kind === "unresolved_tool_call") {
		return prompt.render(unresolvedToolCallLoopRedirectTemplate, {
			tool_name: detection.toolName,
			count: detection.count,
			arguments_summary: detection.argumentsSummary,
			result_summary: detection.resultSummary || "(no text result)",
		});
	}
	if (detection.cycleLength !== undefined && detection.cycleLength > 1) {
		return prompt.render(cyclicToolCallLoopRedirectTemplate, {
			tool_name: detection.toolName,
			count: detection.count,
			cycle_length: detection.cycleLength,
			cycle_summary: detection.cycleSummary || `${detection.toolName}(${detection.argumentsSummary})`,
			arguments_summary: detection.argumentsSummary,
			result_summary: detection.resultSummary || "(no text result)",
		});
	}
	return prompt.render(toolCallLoopRedirectTemplate, {
		tool_name: detection.toolName,
		count: detection.count,
		arguments_summary: detection.argumentsSummary,
		result_summary: detection.resultSummary || "(no text result)",
	});
}

export function toolCallLoopRedirectDetails(detection: RepeatedToolCallDetection): ToolCallLoopRedirectDetails {
	return {
		kind: detection.kind,
		toolName: detection.toolName,
		count: detection.count,
		...(detection.cycleLength !== undefined ? { cycleLength: detection.cycleLength } : {}),
		...(detection.cycleSummary !== undefined ? { cycleSummary: detection.cycleSummary } : {}),
		argumentsSummary: detection.argumentsSummary,
		resultSummary: detection.resultSummary,
	};
}
