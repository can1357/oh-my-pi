/**
 * Root-agent completion gate helpers — evaluate contract satisfaction from the
 * session transcript when the main agent stops without a structured yield.
 */

import type { Message, ToolResultMessage } from "@pk-nerdsaver-ai/pi-ai";
import type { CompletionGateInput } from "./completion-gate";
import type { ActiveTaskContractSnapshot } from "./task-contract";

const VERIFICATION_TOOL_NAMES: ReadonlySet<string> = new Set(["bash", "read", "search", "grep", "eval", "find"]);
const DELIVERABLE_TOOL_NAMES: ReadonlySet<string> = new Set([
	"write",
	"edit",
	"bash",
	"apply_patch",
	"ast-edit",
	"ast_edit",
]);

export function collectRecentToolResults(
	messages: readonly Message[],
	sinceTimestamp?: number,
): readonly ToolResultMessage[] {
	return messages.filter((message): message is ToolResultMessage => {
		if (message.role !== "toolResult") return false;
		if (sinceTimestamp !== undefined && message.timestamp < sinceTimestamp) return false;
		return !message.isError && message.useless !== true;
	});
}

/**
 * Build gate input from transcript tool results since the active contract was set.
 * Uses concrete tool-use signals rather than the model's narrative alone.
 */
export function buildCompletionGateInputFromTranscript(
	contract: ActiveTaskContractSnapshot,
	messages: readonly Message[],
	sinceTimestamp?: number,
): CompletionGateInput {
	const toolResults = collectRecentToolResults(messages, sinceTimestamp);
	const toolNames = new Set(toolResults.map(result => result.toolName));
	const hasVerification = [...VERIFICATION_TOOL_NAMES].some(name => toolNames.has(name));
	const hasDeliverableWork = [...DELIVERABLE_TOOL_NAMES].some(name => toolNames.has(name));

	const criteriaEvidence: Record<string, boolean> = {};
	for (const criterion of contract.completionCriteria) {
		if (criterion.id === "targeted_verification") {
			criteriaEvidence[criterion.id] = hasVerification;
		} else if (criterion.id === "deliverables_present") {
			criteriaEvidence[criterion.id] = contract.deliverables.length === 0 || hasDeliverableWork;
		} else {
			criteriaEvidence[criterion.id] = false;
		}
	}

	const deliverablesPresent =
		contract.deliverables.length === 0 ? [] : hasDeliverableWork ? [...contract.deliverables] : [];

	return {
		contract,
		deliverablesPresent,
		criteriaEvidence,
		triggeredNonSolutions: [],
		requiredEvidencePresent: hasVerification,
		unresolvedBlockers: [],
		scopeValid: true,
	};
}
